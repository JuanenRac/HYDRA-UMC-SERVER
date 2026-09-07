// =============================================================================
// HYDRA-UMC-SERVER - GET /api/adapters and /api/adapters/:adapterId real relay
// Copyright (C) 2026 JuanenRac (Electro Hobby 3D) <electrohobby3d@gmail.com>
// GPL-3.0 - see LICENSE
// =============================================================================
// Starts HYDRA-UMC-CONNECTOR-HUB's own real `serve-catalog` (Python,
// http.server, GET-only) against its own real fixtures/ directory, plus a
// real Server instance proxying to it - proves Server is a genuine E2E
// consumer of the catalog (not just a CLI/fixture calling the gate, see that
// project's own README "No real client integration yet"). Also proves the
// route degrades to a clean 503 when unconfigured, requires the same
// authenticated Server session as every other real client route, and never
// forwards a malformed adapterId to the upstream as a raw path segment.

import assert from "node:assert/strict";
import { once } from "node:events";
import { access, mkdtemp, rm } from "node:fs/promises";
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
const ADMIN = { username: "connector-hub-contract-admin", password: "connector-hub-contract-admin-password" };

async function reservePort() {
  const listener = createServer();
  listener.listen(0, "127.0.0.1");
  await once(listener, "listening");
  const address = listener.address();
  assert(address && typeof address === "object");
  const { port } = address;
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

function resolvePythonCommand() {
  if (process.env.PYTHON) return process.env.PYTHON;

  // Same PATH contract every other verify_*_contract.mjs script in this
  // project already relies on - see verify_voice_relay_contract.mjs's own
  // comment on this exact line.
  return "python";
}

async function spawnServer(port, workspace, env, logsRef) {
  let startupError;
  const child = spawn(process.execPath, [TSX_CLI, SERVER_SOURCE], {
    cwd: workspace,
    env: {
      ...process.env,
      PORT: String(port),
      NODE_ENV: "test",
      JWT_SECRET: `connector-hub-contract-secret-${port}-not-for-deployment`,
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
    throw new Error(
      `HYDRA-UMC-CONNECTOR-HUB source is unavailable at ${HUB_ROOT}; `
      + "set HYDRA_UMC_CONNECTOR_HUB_ROOT to a checkout before running this contract.",
    );
  }

  const hubPort = await reservePort();
  const serverPortNoHub = await reservePort();
  const serverPortWithHub = await reservePort();
  const python = resolvePythonCommand();
  const pathSeparator = process.platform === "win32" ? ";" : ":";
  const workspaceNoHub = await mkdtemp(path.join(tmpdir(), "hydra-umc-server-connector-hub-relay-nohub-"));
  const workspaceWithHub = await mkdtemp(path.join(tmpdir(), "hydra-umc-server-connector-hub-relay-hub-"));

  let hub;
  let hubStartupError;
  let childNoHub;
  let childWithHub;
  const logs = { text: "" };

  try {
    hub = spawn(
      python,
      ["-m", "hydra_umc_connector_hub.cli", "serve-catalog", "--registry-dir", HUB_FIXTURES, "--host", "127.0.0.1", "--port", String(hubPort)],
      {
        cwd: HUB_ROOT,
        env: {
          ...process.env,
          PYTHONPATH: `${path.join(HUB_ROOT, "src")}${pathSeparator}${process.env.PYTHONPATH || ""}`,
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    hub.once("error", (error) => { hubStartupError = error; });
    hub.stdout.on("data", (chunk) => { logs.text += chunk; });
    hub.stderr.on("data", (chunk) => { logs.text += chunk; });
    await waitFor(`http://127.0.0.1:${hubPort}/health`, () => hubStartupError);

    // First Server instance: HYDRA_UMC_CONNECTOR_HUB_URL deliberately unset -
    // proves the route degrades to a clean 503, not a crash or a hang.
    childNoHub = await spawnServer(serverPortNoHub, workspaceNoHub, {}, logs);
    const authNoHub = await loginAs(serverPortNoHub);
    const unconfigured = await fetch(`http://127.0.0.1:${serverPortNoHub}/api/adapters`, { headers: authNoHub });
    assert.equal(unconfigured.status, 503);
    const unconfiguredBody = await unconfigured.json();
    assert.equal(unconfiguredBody.available, false);
    await stopChild(childNoHub);
    childNoHub = null;

    // Second Server instance: pointed at the real serve-catalog above.
    childWithHub = await spawnServer(serverPortWithHub, workspaceWithHub, { HYDRA_UMC_CONNECTOR_HUB_URL: `http://127.0.0.1:${hubPort}` }, logs);

    // Anonymous request must be rejected before ever reaching the hub - this
    // is not a public passthrough to CONNECTOR-HUB.
    const anonymous = await fetch(`http://127.0.0.1:${serverPortWithHub}/api/adapters`);
    assert.equal(anonymous.status, 401);

    const auth = await loginAs(serverPortWithHub);

    // Real catalog: 10 real, valid fixtures/*.json manifests. registry.py's
    // own build_catalog() scans registry_dir non-recursively BY DESIGN (its
    // own doc-comment: "a nested invalid/ fixtures directory is exactly the
    // kind of thing that must NOT silently join a real catalog") - so the 5
    // real deliberately-invalid manifests under fixtures/invalid/ never
    // reach this registry-dir at all, and invalidFiles (a real
    // {fileName: errors[]} map, not an array) comes back empty here.
    const catalog = await fetch(`http://127.0.0.1:${serverPortWithHub}/api/adapters`, { headers: auth });
    assert.equal(catalog.status, 200);
    const catalogBody = await catalog.json();
    assert.equal(catalogBody.adapters.length, 10, `expected 10 real fixtures, saw: ${JSON.stringify(catalogBody.adapters.map((a) => a.adapterId))}`);
    assert.equal(Object.keys(catalogBody.invalidFiles).length, 0, `expected no invalid files in the top-level registry dir, saw: ${JSON.stringify(catalogBody.invalidFiles)}`);
    const cncSummary = catalogBody.adapters.find((entry) => entry.adapterId === "cnc-grbl");
    assert(cncSummary, "catalog is missing the real cnc-grbl fixture");
    assert.equal(cncSummary.ownerProject, "HYDRA-UMC-BRIDGE-CNC");
    // The catalog is a summary (registry.py's own CatalogEntry.to_dict) -
    // no endpointSchema/evidenceSchema body, unlike the single-adapter route
    // below. Proves Server is forwarding the real /catalog shape, not
    // fabricating its own.
    assert.equal(cncSummary.endpointSchema, undefined);

    // Real single-adapter full manifest.
    const single = await fetch(`http://127.0.0.1:${serverPortWithHub}/api/adapters/cnc-grbl`, { headers: auth });
    assert.equal(single.status, 200);
    const singleBody = await single.json();
    assert.equal(singleBody.adapterId, "cnc-grbl");
    assert.equal(singleBody.protocol, "grbl-serial");
    assert.equal(singleBody.endpointSchema.required[0], "serialPort");
    const writeCapability = singleBody.capabilities.find((capability) => capability.name === "sendControlByte");
    assert.equal(writeCapability.requiredPermission, "cnc.control.send");

    // Real upstream 404 passthrough for an unknown adapterId - CONNECTOR-HUB's
    // own catalog_server.py rejects it, Server forwards that verbatim rather
    // than inventing its own error shape.
    const unknown = await fetch(`http://127.0.0.1:${serverPortWithHub}/api/adapters/does-not-exist`, { headers: auth });
    assert.equal(unknown.status, 404);
    const unknownBody = await unknown.json();
    assert.match(unknownBody.error, /does-not-exist/);

    // A malformed adapterId must be rejected by Server's own safe-segment
    // check (mirrors CONNECTOR-HUB's own schema.py _SAFE_ADAPTER_ID_RE)
    // before it ever becomes a path segment of the outbound URL.
    const malformed = await fetch(`http://127.0.0.1:${serverPortWithHub}/api/adapters/${encodeURIComponent("bad id!")}`, { headers: auth });
    assert.equal(malformed.status, 400);

    console.log("SERVER_CONNECTOR_HUB_RELAY_CONTRACT=PASS unconfigured=1 auth=1 catalog=1 single_adapter=1 unknown_404=1 malformed_400=1");
  } catch (error) {
    throw new Error(`${error instanceof Error ? error.message : error}\nProcess output:\n${logs.text || "<no output>"}`);
  } finally {
    await stopChild(childWithHub);
    await stopChild(childNoHub);
    await stopChild(hub);
    await Promise.all([workspaceNoHub, workspaceWithHub].map((dir) =>
      rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })));
  }
}

main().catch((error) => {
  console.error("SERVER_CONNECTOR_HUB_RELAY_CONTRACT=FAIL", error instanceof Error ? error.stack : error);
  process.exitCode = 1;
});
