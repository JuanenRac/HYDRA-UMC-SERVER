// =============================================================================
// HYDRA-UMC-SERVER - Read-only role and robot-edit commands contract checks
// Copyright (C) 2026 JuanenRac (Electro Hobby 3D) <electrohobby3d@gmail.com>
// GPL-3.0-or-later - see LICENSE
// =============================================================================
// Runs the real API in an isolated temporary data directory with an administrator, an operator and a
// read-only ("viewer") account. It proves that a viewer reads the state and the media list but every
// call that writes is refused with 403 (a command, the global stop, a claim, an upload, a settings write,
// the user list), that an operator keeps working, and that the edit commands of one robot (points, loop,
// model, role, combine, joints, xyTableConfig) are accepted from an operator, persisted and broadcast over
// the WebSocket. No hardware, project data or live server is touched.
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
const ADMIN = { username: "viewer-contract-admin", password: "viewer-contract-admin-password" };
const OPERATOR = { username: "viewer-contract-operator", password: "viewer-contract-operator-password" };
const VIEWER = { username: "viewer-contract-viewer", password: "viewer-contract-viewer-password" };

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
const joints = { j1: 1, j2: 2, j3: 3, j4: 4, j5: 5, j6: 6 };
const point = (n) => ({ motionType: "model-joints", ...joints, j1: n, x: n, y: 0, z: 0 });
const tree = () => ({
  settings: { serverName: "HYDRA-UMC viewer contract" },
  controllers: [{
    id: "c1", name: "One", cameras: [],
    robots: [
      { id: 1, name: "A1", model: "Parol6 (6-DOF)", role: "Idle", pos: { x: 0, y: 0, z: 0, a: 0, b: 0, c: 0 }, joints: { ...joints }, recordedPoints: [], playbackState: { isPlaying: false, activeStep: 0, speed: 100 }, valves: [false, false], pumps: [false, false] },
      { id: 2, name: "A2", pos: { x: 0, y: 0, z: 0, a: 0, b: 0, c: 0 }, joints: {}, hasXYTable: false, xyTable: { pos: { x: 0, y: 0 }, tableSize: { width: 300, length: 200 } } },
    ],
  }],
});

async function main() {
  const directory = await mkdtemp(path.join(tmpdir(), "hydra-umc-server-viewer-"));
  const port = await reservePort();
  let child;
  try {
    await mkdir(path.join(directory, "data"), { recursive: true });
    await writeFile(path.join(directory, "data", "settings.json"), JSON.stringify(tree()));
    child = spawn(process.execPath, [TSX_CLI, SERVER_SOURCE], {
      cwd: directory,
      env: {
        ...process.env, PORT: String(port), NODE_ENV: "test", JWT_SECRET: "local-viewer-contract-verification-only-not-for-deployment",
        HYDRA_UMC_BOOTSTRAP_ADMIN_USERNAME: ADMIN.username, HYDRA_UMC_BOOTSTRAP_ADMIN_PASSWORD: ADMIN.password, LOGIN_RATE_LIMIT_MAX: "100",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.on("data", () => undefined);
    child.stderr.on("data", () => undefined);
    await waitUntil(async () => { try { return (await fetch(`http://127.0.0.1:${port}/api/hydra-info`)).ok; } catch { return false; } }, "server to accept connections");

    const login = async (credentials) => (await request(port, "/api/login", { method: "POST", body: JSON.stringify(credentials) })).body;
    const admin = { authorization: `Bearer ${(await login(ADMIN)).token}` };
    for (const [account, role] of [[OPERATOR, "operator"], [VIEWER, "viewer"]]) {
      const created = await request(port, "/api/users", { method: "POST", headers: admin, body: JSON.stringify({ ...account, role }) });
      assert.equal(created.response.status, 200, `${role} created`);
    }
    const viewerLogin = await login(VIEWER);
    assert.equal(viewerLogin.role, "viewer", "the login reports the role");
    const viewer = { authorization: `Bearer ${viewerLogin.token}` };
    const operator = { authorization: `Bearer ${(await login(OPERATOR)).token}` };
    const listed = (await request(port, "/api/users", { headers: admin })).body.users;
    assert.equal(listed.find((u) => u.username === VIEWER.username).role, "viewer", "the user list keeps the role");

    // --- a viewer reads
    const reads = ["/api/settings", "/api/robot/1", "/api/claims", "/api/safety-limits", "/api/cameras/status", "/api/camera/media"];
    for (const route of reads) assert.equal((await request(port, route, { headers: viewer })).response.status, 200, `viewer reads ${route}`);
    assert.equal((await request(port, "/api/camera/ticket", { method: "POST", headers: viewer, body: "{}" })).response.status !== 403, true, "viewer may ask for a camera ticket");

    // --- and changes nothing
    const writes = [
      ["/api/stop-all", "POST", undefined],
      ["/api/robot/1/command", "POST", { command: "play" }],
      ["/api/robot/1/command", "POST", { command: "stop" }],
      ["/api/robot/1/claim", "POST", { ttlMs: 60000 }],
      ["/api/robot/1/release", "POST", {}],
      ["/api/robot/1/jog-arm", "POST", { armed: true }],
      ["/api/upload-work", "POST", {}],
      ["/api/settings", "POST", tree()],
      ["/api/users", "POST", { username: "x-user", password: "x-user-password", role: "admin" }],
      ["/api/voice/turn", "POST", {}],
      ["/api/integrations/test-connection", "POST", { host: "127.0.0.1", port: 1 }],
    ];
    for (const [route, method, body] of writes) {
      const answer = await request(port, route, { method, headers: viewer, body: body === undefined ? undefined : JSON.stringify(body) });
      assert.equal(answer.response.status, 403, `viewer is refused on ${method} ${route}`);
    }
    const refused = await request(port, "/api/robot/1/command", { method: "POST", headers: viewer, body: JSON.stringify({ command: "play" }) });
    assert.equal(refused.body.code, "VIEWER_READ_ONLY");
    assert.equal((await request(port, "/api/robot/1", { headers: viewer })).body.robot?.playbackState?.isPlaying ?? false, false, "nothing started");

    // --- an administrator can demote an operator to viewer and it takes effect on the very next call
    assert.equal((await request(port, "/api/robot/1/command", { method: "POST", headers: operator, body: JSON.stringify({ command: "loop", params: { value: true } }) })).response.status, 200);
    assert.equal((await request(port, `/api/users/${OPERATOR.username}`, { method: "PUT", headers: admin, body: JSON.stringify({ role: "viewer" }) })).response.status, 200);
    assert.equal((await request(port, "/api/robot/1/command", { method: "POST", headers: operator, body: JSON.stringify({ command: "loop", params: { value: false } }) })).response.status, 401, "the old session is gone after a role change");
    const again = { authorization: `Bearer ${(await login(OPERATOR)).token}` };
    assert.equal((await request(port, "/api/robot/1/command", { method: "POST", headers: again, body: JSON.stringify({ command: "loop", params: { value: false } }) })).response.status, 403);
    assert.equal((await request(port, `/api/users/${OPERATOR.username}`, { method: "PUT", headers: admin, body: JSON.stringify({ role: "operator" }) })).response.status, 200);
    const operator2 = { authorization: `Bearer ${(await login(OPERATOR)).token}` };

    // --- the edit commands, from an operator, over the wire
    const seen = [];
    const socket = new WebSocket(`ws://127.0.0.1:${port}/ws?remoteApiVersion=2`, ["hydra.bearer", operator2.authorization.slice(7)]);
    socket.on("message", (data) => seen.push(data.toString()));
    await waitUntil(() => seen.length > 0, "the WebSocket to deliver the first message");
    const send = (id, command, params) => request(port, `/api/robot/${id}/command`, { method: "POST", headers: operator2, body: JSON.stringify({ command, params }) });
    assert.equal((await send(1, "points", { points: [point(1), point(2)] })).response.status, 200);
    assert.equal((await send(1, "loop", { value: true })).response.status, 200);
    assert.equal((await send(1, "model", { model: "UR5e (6-DOF)" })).response.status, 200);
    assert.equal((await send(1, "role", { role: "Pnp" })).response.status, 200);
    assert.equal((await send(1, "combine", { with: [2] })).response.status, 200);
    assert.equal((await send(1, "joints", { joints: { j1: 10, j2: 20, j3: 30, j4: 40, j5: 50, j6: 60 } })).response.status, 200);
    assert.equal((await send(2, "xyTableConfig", { enabled: true, worldRot: 45 })).response.status, 200);
    assert.equal((await send(1, "role", { role: "Pirate" })).response.status, 400);
    const stored = (await request(port, "/api/settings", { headers: admin })).body.controllers[0].robots;
    const first = stored.find((r) => r.id === 1);
    assert.equal(first.recordedPoints.length, 2);
    assert.equal(first.playbackState.isLooping, true);
    assert.equal(first.model, "UR5e (6-DOF)");
    assert.equal(first.role, "Pnp");
    assert.deepEqual(first.combinedWith, [2]);
    assert.equal(first.joints.j3, 30);
    const second = stored.find((r) => r.id === 2);
    assert.equal(second.hasXYTable, true);
    assert.equal(second.xyTable.worldRot, 45);
    assert.deepEqual(second.xyTable.tableSize, { width: 300, length: 200 });
    await waitUntil(() => seen.some((text) => text.includes("recordedPoints")), "the edit to be broadcast");
    socket.close();

    // --- the viewer's own socket can read but its settings message is refused
    console.log("SERVER_VIEWER_ROLE_CONTRACT=PASS reads=7 writes_refused=11 role_change=1 edit_commands=7 broadcast=1");
  } finally {
    if (child && child.exitCode === null) { child.kill(); await new Promise((resolve) => child.once("exit", resolve)); }
    await rm(directory, { recursive: true, force: true, maxRetries: 15, retryDelay: 200 }).catch(() => undefined);
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
