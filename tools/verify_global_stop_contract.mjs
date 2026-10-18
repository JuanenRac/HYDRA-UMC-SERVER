// =============================================================================
// HYDRA-UMC-SERVER - Global stop contract checks
// Copyright (C) 2026 JuanenRac (Electro Hobby 3D) <electrohobby3d@gmail.com>
// GPL-3.0 - see LICENSE
// =============================================================================
// Against a real running server: POST /api/stop-all needs a signed-in account (401 otherwise), any signed-in operator may call it, it stops every robot of every
// controller whoever reserved it (the reservation is reported, never obeyed), switches every valve and pump off, answers one result per robot, is broadcast over the
// WebSocket, is bounded by its own rate limit (429) without touching the login or the per-robot stop, and an empty installation answers an empty list.

import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { WebSocket } from "ws";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TSX_CLI = path.join(ROOT, "node_modules", "tsx", "dist", "cli.mjs");
const SERVER_SOURCE = path.join(ROOT, "src", "server.ts");
const ADMIN = { username: "stop-contract-admin", password: "stop-contract-admin-password" };
const OPERATOR = { username: "stop-contract-operator", password: "stop-contract-operator-password" };
const OTHER = { username: "stop-contract-other", password: "stop-contract-other-password" };

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
const find = (settings, id) => settings.controllers.flatMap((c) => c.robots ?? []).find((r) => r.id === id);

async function withServer(settingsTree, env, run) {
  const directory = await mkdtemp(path.join(tmpdir(), "hydra-umc-server-stopall-"));
  const port = await reservePort();
  let child;
  let logs = "";
  try {
    await mkdir(path.join(directory, "data"), { recursive: true });
    await writeFile(path.join(directory, "data", "settings.json"), JSON.stringify(settingsTree));
    child = spawn(process.execPath, [TSX_CLI, SERVER_SOURCE], {
      cwd: directory,
      env: {
        ...process.env, PORT: String(port), NODE_ENV: "test", JWT_SECRET: "local-stop-all-contract-verification-only-not-for-deployment",
        HYDRA_UMC_BOOTSTRAP_ADMIN_USERNAME: ADMIN.username, HYDRA_UMC_BOOTSTRAP_ADMIN_PASSWORD: ADMIN.password, LOGIN_RATE_LIMIT_MAX: "100", ...env,
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
  const admin = await login(ADMIN);
  const adminHeaders = { authorization: `Bearer ${admin}` };
  for (const account of [OPERATOR, OTHER]) {
    const created = await request(port, "/api/users", { method: "POST", headers: adminHeaders, body: JSON.stringify({ ...account, role: "operator" }) });
    assert.equal(created.response.status, 200, "operator created");
  }
  return { admin: adminHeaders, operator: { authorization: `Bearer ${await login(OPERATOR)}` }, other: { authorization: `Bearer ${await login(OTHER)}` } };
}

const playing = () => ({ isPlaying: true, playing: true, activeStep: 2, isPaused: false, paused: false });
const tree = () => ({
  settings: { serverName: "HYDRA-UMC stop contract" },
  controllers: [
    { id: "c1", name: "One", robots: [
      { id: 1, name: "A1", playbackState: playing(), valves: [true, true], pumps: [true], pos: { x: 0, y: 0, z: 0, a: 0, b: 0, c: 0 }, recordedPoints: [] },
      { id: 2, name: "A2", playbackState: playing(), valves: [false, false], pumps: [false] },
    ] },
    { id: "c2", name: "Two", robots: [{ id: 3, name: "B1", playbackState: playing(), valves: [true], pumps: [true, true] }] },
  ],
});

async function main() {
  // --- the contract on a populated installation
  await withServer(tree(), {}, async (port, logs) => {
    const who = await accounts(port);
    assert.equal((await request(port, "/api/stop-all", { method: "POST" })).response.status, 401, "no token: refused");
    assert.equal((await request(port, "/api/stop-all", { method: "POST", headers: { authorization: "Bearer forged" } })).response.status, 403, "a forged token: refused");

    // another account reserves robot 1: a normal command from the stopper is blocked, the global stop is not
    assert.equal((await request(port, "/api/robot/1/claim", { method: "POST", headers: who.other, body: JSON.stringify({ ttlMs: 60000 }) })).response.status, 200);
    assert.equal((await request(port, "/api/robot/1/command", { method: "POST", headers: who.operator, body: JSON.stringify({ command: "pause" }) })).response.status, 409, "the reservation does block a normal command");

    // a second WebSocket client must see the stop
    const seen = [];
    const socket = new WebSocket(`ws://127.0.0.1:${port}/ws?remoteApiVersion=2`, ["hydra.bearer", who.admin.authorization.slice(7)]);
    socket.on("message", (data) => seen.push(data.toString()));
    await waitUntil(() => seen.length > 0, "the WebSocket to deliver the first message");

    const stopped = await request(port, "/api/stop-all", { method: "POST", headers: who.operator });
    assert.equal(stopped.response.status, 200, JSON.stringify(stopped.body));
    assert.equal(stopped.body.success, true);
    assert.equal(stopped.body.stoppedCount, 3);
    assert.equal(stopped.body.failedCount, 0);
    assert.equal(stopped.body.persisted, true);
    assert.deepEqual(stopped.body.robots.map((r) => [r.robotId, r.controllerId, r.stopped, r.valvesOff, r.pumpsOff]), [[1, "c1", true, 2, 1], [2, "c1", true, 0, 0], [3, "c2", true, 1, 2]]);
    assert.equal(stopped.body.robots[0].reservedBy, OTHER.username, "a foreign reservation is reported");
    assert.equal(stopped.body.robots[1].reservedBy, undefined);

    const after = (await request(port, "/api/settings", { headers: who.admin })).body;
    for (const id of [1, 2, 3]) {
      const robot = find(after, id);
      assert.equal(robot.playbackState.isPlaying, false, `robot ${id} is stopped`);
      assert.equal(robot.playbackState.requestStop, true);
      assert.equal([...(robot.valves ?? []), ...(robot.pumps ?? [])].some(Boolean), false, `robot ${id} has every valve and pump off`);
    }
    assert.equal(find(after, 1).reservation.ownerUsername, OTHER.username, "the reservation itself is left as it was");
    await waitUntil(() => seen.some((text) => text.includes("requestStop")), "the stop to be broadcast over the WebSocket");

    // idempotent: a second call is just as successful
    const again = await request(port, "/api/stop-all", { method: "POST", headers: who.admin });
    assert.equal(again.body.stoppedCount, 3);
    assert.equal(again.body.robots.every((r) => r.valvesOff === 0 && r.pumpsOff === 0), true);
    socket.close();

    const text = logs();
    assert.match(text, new RegExp(`GLOBAL STOP by ${OPERATOR.username} \\(operator\\)`), "the stop is in the audit log with who asked");
    assert.match(text, new RegExp(`GLOBAL STOP by ${ADMIN.username} \\(admin\\)`));
    const metrics = await fetch(`http://127.0.0.1:${port}/metrics`).then((r) => r.text());
    assert.match(metrics, /hydra_robot_commands_total\{command="stop-all"\} 2/, "the stop is counted");
  });

  // --- the bounded limiter: its own budget, the login and the per-robot stop keep working
  await withServer(tree(), { STOP_ALL_RATE_LIMIT_MAX: "3" }, async (port) => {
    const who = await accounts(port);
    for (let i = 0; i < 3; i++) assert.equal((await request(port, "/api/stop-all", { method: "POST", headers: who.operator })).response.status, 200, `call ${i + 1} is inside the budget`);
    const limited = await request(port, "/api/stop-all", { method: "POST", headers: who.operator });
    assert.equal(limited.response.status, 429, "the fourth call is over the budget");
    assert.match(limited.body.error, /per-robot stop/);
    assert.equal((await request(port, "/api/robot/1/command", { method: "POST", headers: who.operator, body: JSON.stringify({ command: "stop" }) })).response.status, 200, "the per-robot stop still works");
    assert.equal((await request(port, "/api/login", { method: "POST", body: JSON.stringify(OPERATOR) })).response.status, 200, "the login is not starved");
    assert.equal((await request(port, "/api/stop-all", { method: "POST" })).response.status, 401, "unsigned calls are refused before they spend the budget");
  });

  // --- an installation without robots
  await withServer({ settings: { serverName: "empty" }, controllers: [] }, {}, async (port) => {
    const who = await accounts(port);
    const empty = await request(port, "/api/stop-all", { method: "POST", headers: who.operator });
    assert.equal(empty.response.status, 200);
    assert.deepEqual([empty.body.success, empty.body.stoppedCount, empty.body.robots.length], [true, 0, 0]);
  });

  console.log("SERVER_GLOBAL_STOP_CONTRACT=PASS auth=2 reservation_ignored=1 valves_pumps_off=1 results=3 broadcast=1 audit=2 metric=1 idempotent=1 rate_limit=3 empty=1");
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
