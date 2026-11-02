// =============================================================================
// HYDRA-UMC-SERVER - Presence of the operator (dead-man): contract check
// Copyright (C) 2026 JuanenRac (Electro Hobby 3D) <electrohobby3d@gmail.com>
// GPL-3.0-or-later - see LICENSE
// =============================================================================
// Against a real running server and a simulated robot (nothing here moves hardware): POST /api/operator/presence looks as if it did not exist until an
// administrator turns presence.enabled on (the environment wins and locks it). Then a numbered heartbeat is accepted, a repeat is a duplicate and a
// malformed one is refused. When the heartbeats stop, the robot the operator holds is slowed down (the default action) and a warning goes to the log;
// the global stop still works at that moment; heartbeats in a row bring the speed back. Another action can be chosen in Server Admin.

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
const ADMIN = { username: "presence-admin", password: "presence-admin-password" };
const OPERATOR = { username: "presence-operator", password: "presence-operator-password" };
const VIEWER = { username: "presence-viewer", password: "presence-viewer-password" };

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitUntil(fn, message, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
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
  const text = await response.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = null; }
  return { response, body };
}

async function withServer(env, run) {
  const directory = await mkdtemp(path.join(tmpdir(), "hydra-umc-server-presence-"));
  const port = await reservePort();
  let child;
  let logs = "";
  try {
    await mkdir(path.join(directory, "data"), { recursive: true });
    const robot = (id) => ({ id, name: `Simulated ${id}`, playbackState: { isPlaying: true, playing: true, isPaused: false, paused: false, activeStep: 1, speed: 100 }, recordedPoints: [] });
    await writeFile(path.join(directory, "data", "settings.json"), JSON.stringify({ settings: { serverName: "HYDRA-UMC presence contract" }, controllers: [{ id: "presence-cell", name: "Cell", robots: [robot(1), robot(2)] }] }));
    await writeFile(path.join(directory, "data", "server-config.json"), JSON.stringify({ presence: { timeoutSeconds: 3, recoverBeats: 2, rampSeconds: 0 } }));
    child = spawn(process.execPath, [TSX_CLI, SERVER_SOURCE], {
      cwd: directory,
      env: {
        ...process.env, PORT: String(port), NODE_ENV: "test", JWT_SECRET: "local-presence-contract-verification-only-not-for-deployment",
        HYDRA_UMC_BOOTSTRAP_ADMIN_USERNAME: ADMIN.username, HYDRA_UMC_BOOTSTRAP_ADMIN_PASSWORD: ADMIN.password, LOGIN_RATE_LIMIT_MAX: "100",
        HYDRA_UMC_PORTS_REGISTRY: "off", ...env,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.on("data", (chunk) => { logs += chunk; });
    child.stderr.on("data", (chunk) => { logs += chunk; });
    await waitUntil(async () => { try { return (await fetch(`http://127.0.0.1:${port}/api/hydra-info`)).ok; } catch { return false; } }, "server to accept connections");
    await run(port, () => logs);
  } finally {
    if (child && child.exitCode === null) { child.kill(); await new Promise((resolve) => child.once("exit", resolve)); }
    await rm(directory, { recursive: true, force: true, maxRetries: 15, retryDelay: 200 }).catch(() => undefined);
  }
}

async function accounts(port) {
  const login = async (credentials) => (await request(port, "/api/login", { method: "POST", body: JSON.stringify(credentials) })).body.token;
  const admin = { authorization: `Bearer ${await login(ADMIN)}` };
  for (const [account, role] of [[OPERATOR, "operator"], [VIEWER, "viewer"]]) {
    const created = await request(port, "/api/users", { method: "POST", headers: admin, body: JSON.stringify({ ...account, role }) });
    assert.equal(created.response.status, 200, `${role} created`);
  }
  return { admin, operator: { authorization: `Bearer ${await login(OPERATOR)}` }, viewer: { authorization: `Bearer ${await login(VIEWER)}` } };
}

const put = (port, headers, patch) => request(port, "/api/admin/server-config", { method: "PUT", headers, body: JSON.stringify(patch) });
const beat = (port, headers, sequence, state = "PRESENT") => request(port, "/api/operator/presence", { method: "POST", headers, body: JSON.stringify({ type: "presence_heartbeat", protocolVersion: 1, sequence, intervalSeconds: 1, state }) });
const speedOf = async (port, headers, id) => (await request(port, `/api/robot/${id}`, { headers })).body.robot.playbackState.speed;

async function main() {
  await withServer({}, async (port, logs) => {
    const who = await accounts(port);

    // --- off by default: the routes do not exist
    assert.equal((await request(port, "/api/operator/presence", { method: "POST", body: "{}" })).response.status, 401);
    assert.equal((await beat(port, who.operator, 1)).response.status, 404);
    assert.equal((await request(port, "/api/operator/presence", { headers: who.operator })).response.status, 404);
    const config = (await request(port, "/api/admin/server-config", { headers: who.admin })).body;
    assert.deepEqual(config.presence.enabled, { value: false, source: "default" });
    assert.deepEqual(config.presence.action, { value: "slow", source: "default" });

    // --- an administrator turns it on; an operator cannot
    assert.equal((await put(port, who.operator, { presence: { enabled: true } })).response.status, 403);
    assert.equal((await put(port, who.admin, { presence: { enabled: "yes" } })).response.status, 400);
    assert.equal((await put(port, who.admin, { presence: { action: "explode" } })).response.status, 400);
    const on = await put(port, who.admin, { presence: { enabled: true } });
    assert.equal(on.response.status, 200, JSON.stringify(on.body));
    assert.deepEqual(on.body.presence.enabled, { value: true, source: "config" });

    // --- the operator holds a simulated robot
    const claim = await request(port, "/api/robot/1/claim", { method: "POST", headers: who.operator, body: JSON.stringify({ ttlMs: 600000 }) });
    assert.equal(claim.response.status, 200, JSON.stringify(claim.body));

    // --- heartbeats: numbered, idempotent, checked; a viewer has no robots to hold
    const first = await beat(port, who.operator, 1);
    assert.equal(first.response.status, 200, JSON.stringify(first.body));
    assert.equal(first.body.accepted, true);
    assert.equal(first.body.state, "present");
    assert.equal(first.body.action, "slow");
    assert.equal((await beat(port, who.operator, 1)).body.duplicate, true);
    assert.equal((await beat(port, who.operator, 0)).body.stale, true);
    assert.equal((await request(port, "/api/operator/presence", { method: "POST", headers: who.operator, body: JSON.stringify({ sequence: -1, intervalSeconds: 5, state: "PRESENT" }) })).response.status, 400);
    assert.equal((await beat(port, who.viewer, 1)).response.status, 403);
    assert.equal(await speedOf(port, who.admin, 1), 100);
    const own = (await request(port, "/api/operator/presence", { headers: who.operator })).body;
    assert.equal(own.state, "present");
    assert.equal(own.lastSequence, 1);

    // --- the heartbeat is lost: the robot of that operator slows down, the other one does not; the log says so
    await waitUntil(async () => (await speedOf(port, who.admin, 1)) === 30, "the speed to go down after the heartbeat was lost");
    assert.equal(await speedOf(port, who.admin, 2), 100, "a robot nobody holds is not touched");
    assert.match(logs(), /\[PRESENCE\].*lost the heartbeat/);
    assert.equal((await request(port, "/api/operator/presence", { headers: who.operator })).body.state, "lost");

    // --- the global stop still works at that moment
    const stop = await request(port, "/api/stop-all", { method: "POST", headers: who.operator, body: "{}" });
    assert.equal(stop.response.status, 200);
    assert.equal(stop.body.success, true);

    // --- the operator is back: two heartbeats in a row, then the speed returns (the ramp of this check is zero)
    assert.equal((await beat(port, who.operator, 2)).body.state, "recovering");
    assert.equal((await beat(port, who.operator, 3)).body.state, "present");
    await waitUntil(async () => (await speedOf(port, who.admin, 1)) === 100, "the speed to return");
    const robot = (await request(port, "/api/robot/1", { headers: who.admin })).body.robot;
    assert.equal(robot.playbackState.isPlaying, false, "the presence never starts a robot the stop had stopped");

    // --- another action is chosen in Server Admin
    const picked = await put(port, who.admin, { presence: { action: "notify" } });
    assert.equal(picked.response.status, 200);
    assert.deepEqual(picked.body.presence.action, { value: "notify", source: "config" });
    assert.ok(picked.body.warnings.includes("presence_action_notify"));
    const audit = await request(port, "/api/audit?type=operator-presence-lost", { headers: who.admin });
    if (audit.response.status === 200) assert.ok(JSON.stringify(audit.body).includes("operator-presence-lost"));
  });

  // --- the environment wins and locks the switch and the action
  await withServer({ HYDRA_UMC_PRESENCE: "1", HYDRA_UMC_PRESENCE_ACTION: "stop" }, async (port) => {
    const who = await accounts(port);
    assert.equal((await beat(port, who.operator, 1)).response.status, 200);
    const locked = await put(port, who.admin, { presence: { enabled: false } });
    assert.equal(locked.response.status, 409);
    assert.match(locked.body.error, /HYDRA_UMC_PRESENCE/);
    const lockedAction = await put(port, who.admin, { presence: { action: "slow" } });
    assert.equal(lockedAction.response.status, 409);
    assert.match(lockedAction.body.error, /HYDRA_UMC_PRESENCE_ACTION/);
  });
  console.log("SERVER_PRESENCE_CONTRACT=PASS");
}

main().catch((error) => {
  console.error("SERVER_PRESENCE_CONTRACT=FAIL", error instanceof Error ? error.stack : error);
  process.exitCode = 1;
});
