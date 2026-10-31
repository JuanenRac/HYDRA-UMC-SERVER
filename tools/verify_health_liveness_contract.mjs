// =============================================================================
// HYDRA-UMC-SERVER - Open health route, signal of life and release of the global stop: contract checks
// Copyright (C) 2026 JuanenRac (Electro Hobby 3D) <electrohobby3d@gmail.com>
// GPL-3.0-or-later - see LICENSE
// =============================================================================
// Against a real running server: GET /health looks as if it did not exist until an administrator opens it (Server Admin or the environment, and the environment
// wins), then answers a bare health report without a sign-in; GET /api/robots/liveness says unknown for a robot with no news, live after a command or a heartbeat,
// and needs a sign-in; the heartbeat needs an operator and a robot of the roster; the release of the global stop is for administrators only; and the option that
// announces a global stop is off by default, is saved by an administrator and leaves the answer of the stop as it was while no bridge is on.

import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TSX_CLI = path.join(ROOT, "node_modules", "tsx", "dist", "cli.mjs");
const SERVER_SOURCE = path.join(ROOT, "src", "server.ts");
const ADMIN = { username: "health-contract-admin", password: "health-contract-admin-password" };
const OPERATOR = { username: "health-contract-operator", password: "health-contract-operator-password" };

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitUntil(fn, message) {
  const deadline = Date.now() + 15000;
  for (;;) {
    if (await fn()) return;
    if (Date.now() > deadline) throw new Error(`timed out waiting for: ${message}`);
    await wait(100);
  }
}
const reservePort = () => new Promise((resolve, reject) => {
  const server = createServer();
  server.once("error", reject);
  server.listen(0, "127.0.0.1", () => { const { port } = server.address(); server.close(() => resolve(port)); });
});
async function request(port, route, options = {}) {
  const response = await fetch(`http://127.0.0.1:${port}${route}`, { ...options, headers: { "content-type": "application/json", ...(options.headers ?? {}) } });
  return { response, body: await response.json().catch(() => null) };
}

async function withServer(env, run) {
  const directory = await mkdtemp(path.join(tmpdir(), "hydra-umc-server-health-"));
  const port = await reservePort();
  let child;
  try {
    await mkdir(path.join(directory, "data"), { recursive: true });
    await writeFile(path.join(directory, "data", "settings.json"), JSON.stringify({
      settings: { serverName: "HYDRA-UMC health contract" },
      controllers: [{ id: "c1", name: "One", robots: [{ id: 1, name: "A1", online: true }, { id: 2, name: "A2", online: true }, { id: 3, name: "A3" }] }],
    }));
    child = spawn(process.execPath, [TSX_CLI, SERVER_SOURCE], {
      cwd: directory,
      env: {
        ...process.env, PORT: String(port), NODE_ENV: "test", JWT_SECRET: "local-health-contract-verification-only-not-for-deployment",
        HYDRA_UMC_BOOTSTRAP_ADMIN_USERNAME: ADMIN.username, HYDRA_UMC_BOOTSTRAP_ADMIN_PASSWORD: ADMIN.password, LOGIN_RATE_LIMIT_MAX: "100", ...env,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.on("data", () => undefined);
    child.stderr.on("data", () => undefined);
    await waitUntil(async () => { try { return (await fetch(`http://127.0.0.1:${port}/api/hydra-info`)).ok; } catch { return false; } }, "server to accept connections");
    await run(port);
  } finally {
    if (child && child.exitCode === null) { child.kill(); await new Promise((resolve) => child.once("exit", resolve)); }
    await rm(directory, { recursive: true, force: true, maxRetries: 15, retryDelay: 200 }).catch(() => undefined);
  }
}

async function accounts(port) {
  const login = async (credentials) => (await request(port, "/api/login", { method: "POST", body: JSON.stringify(credentials) })).body.token;
  const admin = { authorization: `Bearer ${await login(ADMIN)}` };
  const created = await request(port, "/api/users", { method: "POST", headers: admin, body: JSON.stringify({ ...OPERATOR, role: "operator" }) });
  assert.equal(created.response.status, 200, "operator created");
  return { admin, operator: { authorization: `Bearer ${await login(OPERATOR)}` } };
}

const put = (port, headers, patch) => request(port, "/api/admin/server-config", { method: "PUT", headers, body: JSON.stringify(patch) });
const state = (list, id) => list.robots.find((r) => r.robot_id === id).state;

async function main() {
  await withServer({}, async (port) => {
    const who = await accounts(port);

    // --- GET /health: closed by default, opened by an administrator, and only a bare report
    assert.equal((await request(port, "/health")).response.status, 404, "closed by default");
    const opened = await put(port, who.admin, { health: { open: true } });
    assert.equal(opened.response.status, 200, JSON.stringify(opened.body));
    assert.ok(opened.body.warnings.includes("health_open"));
    assert.deepEqual(opened.body.health.open, { value: true, source: "config" });
    const health = await request(port, "/health");
    assert.equal(health.response.status, 200);
    assert.deepEqual(Object.keys(health.body).sort(), ["checks", "schema_version", "service", "state", "timestamp_utc"], "nothing but the report");
    assert.equal(health.body.state, "READY");
    assert.equal((await put(port, who.operator, { health: { open: false } })).response.status, 403, "an operator cannot close or open it");
    assert.equal((await put(port, who.admin, { health: { open: "yes" } })).response.status, 400);
    assert.equal((await put(port, who.admin, { health: { open: false } })).response.status, 200);
    assert.equal((await request(port, "/health")).response.status, 404, "closed again");

    // --- the signal of life
    assert.equal((await request(port, "/api/robots/liveness")).response.status, 401, "a sign-in is needed");
    let list = (await request(port, "/api/robots/liveness", { headers: who.operator })).body;
    assert.equal(list.schema_version, "1.0");
    assert.equal(list.stale_after_s, 30);
    assert.deepEqual(list.robots.map((r) => [r.robot_id, r.state]), [[1, "unknown"], [2, "unknown"], [3, "unknown"]], "the online flag of the roster is not read");
    assert.equal(list.robots[0].last_update_utc, undefined);
    assert.equal((await request(port, "/api/robot/1/command", { method: "POST", headers: who.operator, body: JSON.stringify({ command: "stop" }) })).response.status, 200);
    assert.equal((await request(port, "/api/robot/2/heartbeat", { method: "POST" })).response.status, 401);
    assert.equal((await request(port, "/api/robot/99/heartbeat", { method: "POST", headers: who.operator })).response.status, 404, "a robot that is not in the roster");
    assert.equal((await request(port, "/api/robot/2/heartbeat", { method: "POST", headers: who.operator })).response.status, 200);
    list = (await request(port, "/api/robots/liveness", { headers: who.operator })).body;
    assert.deepEqual(list.robots.map((r) => [r.robot_id, r.state, r.source]), [[1, "live", "state"], [2, "live", "heartbeat"], [3, "unknown", undefined]]);
    assert.ok(Number.isInteger(list.robots[0].age_s) && !Number.isNaN(Date.parse(list.robots[0].last_update_utc)));

    // --- the release of the global stop and the option that announces it
    assert.equal((await request(port, "/api/stop-all/release", { method: "POST" })).response.status, 401);
    assert.equal((await request(port, "/api/stop-all/release", { method: "POST", headers: who.operator })).response.status, 403, "administrators only");
    const plain = await request(port, "/api/stop-all", { method: "POST", headers: who.operator });
    assert.equal(plain.response.status, 200);
    assert.equal("announced" in plain.body, false, "no announcement configured: the answer is as it always was");
    const released = await request(port, "/api/stop-all/release", { method: "POST", headers: who.admin });
    assert.deepEqual([released.response.status, released.body], [200, { success: true, announced: false }]);
    const security = (await request(port, "/api/admin/server-config", { headers: who.admin })).body;
    assert.deepEqual(security.safety.publishGlobalStop, { value: false, source: "default" }, "off by default");
    const on = await put(port, who.admin, { safety: { publishGlobalStop: true } });
    assert.equal(on.response.status, 200, JSON.stringify(on.body));
    assert.ok(on.body.warnings.includes("global_stop_published"));
    const withOption = await request(port, "/api/stop-all", { method: "POST", headers: who.operator });
    assert.equal(withOption.body.success, true);
    assert.equal(withOption.body.announced, false, "no bridge is on: the stop is done and says the announcement did not go out");
    assert.equal((await put(port, who.admin, { safety: { publishGlobalStop: 1 } })).response.status, 400);
  });

  // --- the environment wins
  await withServer({ HYDRA_UMC_HEALTH_OPEN: "1", HYDRA_UMC_SAFETY_PUBLISH_STOP: "1" }, async (port) => {
    const who = await accounts(port);
    assert.equal((await request(port, "/health")).response.status, 200, "opened by the environment");
    const refused = await put(port, who.admin, { health: { open: false } });
    assert.equal(refused.response.status, 409);
    assert.match(refused.body.error, /HYDRA_UMC_HEALTH_OPEN/);
    assert.equal((await put(port, who.admin, { safety: { publishGlobalStop: false } })).response.status, 409);
  });

  console.log("SERVER_HEALTH_LIVENESS_CONTRACT=PASS health_closed=1 health_open=1 bare_report=1 env_wins=2 liveness_unknown=1 liveness_live=2 heartbeat=3 release_admin_only=2 announce_option=3");
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
