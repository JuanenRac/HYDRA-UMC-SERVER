// =============================================================================
// HYDRA-UMC-SERVER - POST /api/connector-hub/gate/evaluate and GET /api/connector-hub/gate/audit
// Copyright (C) 2026 JuanenRac (Electro Hobby 3D) <electrohobby3d@gmail.com>
// GPL-3.0-or-later - see LICENSE
// =============================================================================
// Starts a real Server and the real `serve-gate` of HYDRA-UMC-CONNECTOR-HUB (Python) and proves that the relay carries the
// identity of the signed-in person: the hub verifies the token this server issued, answers, and records who asked. Also proves
// that an anonymous call never reaches the hub, that the relay answers 503 while its address is not set, and that the hub
// itself refuses a token it does not know (401).
import assert from "node:assert/strict";
import { once } from "node:events";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const WORKSPACE = path.resolve(ROOT, "..");
const HUB_ROOT = process.env.HYDRA_UMC_CONNECTOR_HUB_ROOT
  ? path.resolve(process.env.HYDRA_UMC_CONNECTOR_HUB_ROOT)
  : path.join(WORKSPACE, "HYDRA-UMC-CONNECTOR-HUB");
const HUB_FIXTURES = path.join(HUB_ROOT, "fixtures");
const TSX_CLI = path.join(ROOT, "node_modules", "tsx", "dist", "cli.mjs");
const SERVER_SOURCE = path.join(ROOT, "src", "server.ts");
const ADMIN = { username: "gate-relay-contract-admin", password: "gate-relay-contract-admin-password" };
const JWT_SECRET = "gate-relay-contract-secret-0123456789-not-for-deployment";

async function reservePort() {
  const listener = createServer();
  listener.listen(0, "127.0.0.1");
  await once(listener, "listening");
  const { port } = listener.address();
  listener.close();
  await once(listener, "close");
  return port;
}

async function waitFor(url, startupError = () => undefined) {
  let lastError;
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const processError = startupError();
    if (processError) throw new Error(`service process could not start: ${processError.message}`);
    try {
      const response = await fetch(url);
      if (response.ok) return;
      lastError = new Error(`HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error(`service did not become ready: ${lastError}`);
}

async function stopChild(child) {
  if (!child || !child.pid || child.exitCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([once(child, "exit"), new Promise((resolve) => setTimeout(resolve, 3000))]);
  if (child.exitCode === null) child.kill("SIGKILL");
}

async function spawnServer(port, workspace, env, logsRef) {
  let startupError;
  const child = spawn(process.execPath, [TSX_CLI, SERVER_SOURCE], {
    cwd: workspace,
    env: {
      ...process.env,
      PORT: String(port),
      NODE_ENV: "test",
      JWT_SECRET,
      HYDRA_UMC_BOOTSTRAP_ADMIN_USERNAME: ADMIN.username,
      HYDRA_UMC_BOOTSTRAP_ADMIN_PASSWORD: ADMIN.password,
      ...env,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.once("error", (error) => { startupError = error; });
  child.stdout.on("data", (chunk) => { logsRef.text += chunk; });
  child.stderr.on("data", (chunk) => { logsRef.text += chunk; });
  await waitFor(`http://127.0.0.1:${port}/api/hydra-info`, () => startupError);
  return child;
}

async function loginAs(port) {
  const response = await fetch(`http://127.0.0.1:${port}/api/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(ADMIN),
  });
  const body = await response.json();
  assert.equal(response.status, 200, `login failed: ${JSON.stringify(body)}`);
  return { authorization: `Bearer ${body.token}` };
}

async function main() {
  try {
    await access(path.join(HUB_ROOT, "src", "hydra_umc_connector_hub", "cli.py"));
  } catch {
    throw new Error(`HYDRA-UMC-CONNECTOR-HUB source is unavailable at ${HUB_ROOT}; set HYDRA_UMC_CONNECTOR_HUB_ROOT to a checkout.`);
  }
  const python = process.env.PYTHON || "python";
  const separator = process.platform === "win32" ? ";" : ":";
  const hubPort = await reservePort();
  const serverPortNoGate = await reservePort();
  const serverPort = await reservePort();
  const work = await mkdtemp(path.join(tmpdir(), "hydra-umc-server-gate-relay-"));
  const workNoGate = await mkdtemp(path.join(tmpdir(), "hydra-umc-server-gate-relay-off-"));
  const keyFile = path.join(work, "identity.key");
  const auditFile = path.join(work, "gate-audit.jsonl");
  const settingsFile = path.join(work, "gate-settings.json");
  await writeFile(settingsFile, JSON.stringify({ allowLoopbackNoIdentity: false }), { mode: 0o600 });
  await writeFile(keyFile, `${JWT_SECRET}\n`, { mode: 0o600 });
  const logs = { text: "" };
  let hub;
  let hubStartupError;
  let childNoGate;
  let child;
  try {
    hub = spawn(
      python,
      ["-m", "hydra_umc_connector_hub.cli", "serve-gate", "--registry-dir", HUB_FIXTURES, "--identity-key-file", keyFile,
        "--audit-file", auditFile, "--config-file", settingsFile, "--host", "127.0.0.1", "--port", String(hubPort)],
      {
        cwd: HUB_ROOT,
        env: { ...process.env, PYTHONPATH: `${path.join(HUB_ROOT, "src")}${separator}${process.env.PYTHONPATH || ""}` },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    hub.once("error", (error) => { hubStartupError = error; });
    hub.stdout.on("data", (chunk) => { logs.text += chunk; });
    hub.stderr.on("data", (chunk) => { logs.text += chunk; });
    await waitFor(`http://127.0.0.1:${hubPort}/health`, () => hubStartupError);

    // The address is not set: a clean 503, nothing reaches any hub.
    childNoGate = await spawnServer(serverPortNoGate, workNoGate, {}, logs);
    const authNoGate = await loginAs(serverPortNoGate);
    const off = await fetch(`http://127.0.0.1:${serverPortNoGate}/api/connector-hub/gate/audit`, { headers: authNoGate });
    assert.equal(off.status, 503);
    assert.equal((await off.json()).available, false);
    await stopChild(childNoGate);
    childNoGate = null;

    child = await spawnServer(serverPort, work, { HYDRA_UMC_CONNECTOR_HUB_GATE_URL: `http://127.0.0.1:${hubPort}` }, logs);
    const base = `http://127.0.0.1:${serverPort}`;

    // Anonymous: refused by this server before the hub is asked.
    assert.equal((await fetch(`${base}/api/connector-hub/gate/audit`)).status, 401);
    assert.equal((await fetch(`${base}/api/connector-hub/gate/evaluate`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).status, 401);

    const auth = await loginAs(serverPort);

    // A body that is not a JSON object never leaves this server.
    const notObject = await fetch(`${base}/api/connector-hub/gate/evaluate`, { method: "POST", headers: { ...auth, "content-type": "application/json" }, body: "[]" });
    assert.equal(notObject.status, 400);

    // The decision: the hub verified the token of this server and answered (a denial is a 200 too), and recorded who asked.
    const evaluated = await fetch(`${base}/api/connector-hub/gate/evaluate`, {
      method: "POST",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({ adapterId: "cnc-grbl", capability: "sendControlByte", jobId: "job-gate-relay", source: "gate-relay-contract" }),
    });
    const decision = await evaluated.json();
    assert.equal(evaluated.status, 200, JSON.stringify(decision));
    assert.equal(typeof decision.allowed, "boolean");
    assert.equal(decision.allowed, false, "nothing was granted, so the hub denies");
    assert.equal(typeof decision.auditSeq, "number");

    const audit = await fetch(`${base}/api/connector-hub/gate/audit`, { headers: auth });
    assert.equal(audit.status, 200);
    const record = JSON.stringify(await audit.json());
    assert(record.includes(ADMIN.username), "the record of the hub names the person who asked");
    const onDisk = await readFile(auditFile, "utf-8");
    assert(onDisk.includes(ADMIN.username), "the caller is in the audit file of the hub");

    // The hub refuses a token it does not know: the identity is the hub's to check, not this relay's.
    const foreign = await fetch(`http://127.0.0.1:${hubPort}/gate/audit`, { headers: { authorization: `${auth.authorization}x` } });
    assert.equal(foreign.status, 401);

    // The settings channel: STUDIO reads and edits the no-identity switch of the hub through this server, with the administrator's own token.
    const settingsUrl = `${base}/api/connector-hub/gate/settings`;
    assert.equal((await fetch(settingsUrl)).status, 401);
    const before = await (await fetch(settingsUrl, { headers: auth })).json();
    assert.equal(before.allowLoopbackNoIdentity, false, "the switch is off by default");
    assert.equal(before.persisted, true);
    const post = (body) => fetch(settingsUrl, { method: "POST", headers: { ...auth, "content-type": "application/json" }, body: JSON.stringify(body) });
    assert.equal((await post({ allowLoopbackNoIdentity: "yes" })).status, 400);
    const unconfirmed = await post({ allowLoopbackNoIdentity: true });
    assert.equal(unconfirmed.status, 400);
    assert.equal((await unconfirmed.json()).code, "CONFIRMATION_REQUIRED");
    assert.equal(JSON.parse(await readFile(settingsFile, "utf-8")).allowLoopbackNoIdentity, false, "nothing changed without the confirmation");
    const turnedOn = await post({ allowLoopbackNoIdentity: true, confirm: true });
    const turnedOnBody = await turnedOn.json();
    assert.equal(turnedOn.status, 200, JSON.stringify(turnedOnBody));
    assert.equal(turnedOnBody.allowLoopbackNoIdentity, true);
    assert.equal(turnedOnBody.changed, true);
    assert.equal(JSON.parse(await readFile(settingsFile, "utf-8")).allowLoopbackNoIdentity, true, "the hub wrote the change to its settings file");
    // The hub itself, asked with no token from this machine, now answers (that is what the switch does) ...
    assert.equal((await fetch(`http://127.0.0.1:${hubPort}/gate/audit`)).status, 200);
    // ... and the caller with no identity can not change the switch back by itself.
    const selfOff = await fetch(`http://127.0.0.1:${hubPort}/gate/settings`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ allowLoopbackNoIdentity: false }) });
    assert.equal(selfOff.status, 403);
    const turnedOff = await post({ allowLoopbackNoIdentity: false });
    assert.equal(turnedOff.status, 200);
    assert.equal((await fetch(`http://127.0.0.1:${hubPort}/gate/audit`)).status, 401, "off again: the same caller is refused");
    const hubAudit = await readFile(auditFile, "utf-8");
    assert(hubAudit.includes("settings_change") && hubAudit.includes(ADMIN.username), "the hub recorded both changes with the person who made them");
    // This server recorded the attempts too (data/audit.jsonl of its own working folder).
    const ownAudit = await readFile(path.join(work, "data", "audit.jsonl"), "utf-8");
    assert((ownAudit.match(/connector-hub-gate-settings/g) ?? []).length >= 4, "this server's audit record has the refused and the accepted attempts");

    console.log("SERVER_CONNECTOR_HUB_GATE_RELAY_CONTRACT=PASS unconfigured=1 anonymous=1 body=1 decision=1 caller_recorded=1 foreign_token=1 settings=1");
  } catch (error) {
    throw new Error(`${error instanceof Error ? error.message : error}\nProcess output:\n${logs.text || "<no output>"}`);
  } finally {
    await stopChild(child);
    await stopChild(childNoGate);
    await stopChild(hub);
    // Removing the temporary folders is a courtesy: on Windows a stopped child can still hold its working folder for a moment.
    await Promise.all([work, workNoGate].map((dir) => rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => undefined)));
  }
}

main().catch((error) => {
  console.error("SERVER_CONNECTOR_HUB_GATE_RELAY_CONTRACT=FAIL", error instanceof Error ? error.stack : error);
  process.exitCode = 1;
});
