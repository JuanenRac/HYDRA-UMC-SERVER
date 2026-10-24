// =============================================================================
// HYDRA-UMC-SERVER - Bluetooth LE service contract checks
// Copyright (C) 2026 JuanenRac (Electro Hobby 3D) <electrohobby3d@gmail.com>
// GPL-3.0 - see LICENSE
// =============================================================================
// Runs the real server in an isolated temporary data directory with the Bluetooth service in "commands"
// mode and a stand-in for the radio helper (tests/fixtures/fake_ble_helper.mjs): a "phone" writes frames
// of the framing in docs/BLE_GATT.md and reads what the server notified. It proves that:
//   - the state arrives after the subscription, cut for the MTU, and follows a change
//   - a command from the phone is judged by the same route as a command from the network: the token is
//     checked, a reservation held by someone else refuses it, STOP is not blocked by a reservation
//   - every command is acknowledged, with the status of the route, and a refused one never as success
//   - with the service in "state" mode a command is refused and changes nothing
// No hardware, project data or live server is touched. The framing is written out again here on purpose:
// it is the second implementation that checks the one in src/ble/framing.ts.

import assert from "node:assert/strict";
import { once } from "node:events";
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TSX_CLI = path.join(ROOT, "node_modules", "tsx", "dist", "cli.mjs");
const SERVER_SOURCE = path.join(ROOT, "src", "server.ts");
const FAKE_HELPER = path.join(ROOT, "tests", "fixtures", "fake_ble_helper.mjs");
const ADMIN = { username: "ble-contract-admin", password: "ble-contract-admin-password" };
const OPERATOR = { username: "ble-contract-operator", password: "ble-contract-operator-password" };
const STATE_UUID = "48594452-0002-4000-8000-554d43000001";
const ACK_UUID = "48594452-0004-4000-8000-554d43000001";

async function reservePort() {
  const listener = createServer();
  listener.listen(0, "127.0.0.1");
  await once(listener, "listening");
  const address = listener.address();
  listener.close();
  await once(listener, "close");
  return address.port;
}

async function waitFor(condition, what, ms = 15000) {
  const until = Date.now() + ms;
  let last;
  while (Date.now() < until) {
    try {
      const value = await condition();
      if (value) return value;
    } catch (error) {
      last = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`timed out waiting for ${what}${last ? `: ${last}` : ""}`);
}

async function request(port, route, options = {}) {
  const response = await fetch(`http://127.0.0.1:${port}${route}`, {
    ...options,
    headers: { "content-type": "application/json", ...(options.headers ?? {}) },
  });
  return { response, body: await response.json().catch(() => null) };
}

// ---- the framing of docs/BLE_GATT.md, written again ------------------------------------------------
function frames(message, mtu) {
  const size = mtu - 3 - 1;
  const out = [];
  for (let offset = 0, index = 0; ; index += 1) {
    const slice = message.subarray(offset, offset + size);
    offset += slice.length;
    const last = offset >= message.length;
    out.push(Buffer.concat([Buffer.from([((index & 15) << 4) | (index === 0 ? 1 : 0) | (last ? 2 : 0)]), slice]));
    if (last) return out;
  }
}

function messagesOf(lines, uuid) {
  const out = [];
  let parts = null;
  let next = 0;
  for (const line of lines) {
    if (line.uuid !== uuid) continue;
    const frame = Buffer.from(line.frame, "base64");
    const header = frame[0];
    if (header & 1) {
      parts = [];
      next = 0;
    }
    if (parts === null || ((header >> 4) & 15) !== next) {
      parts = null;
      continue;
    }
    parts.push(frame.subarray(1));
    next = (next + 1) & 15;
    if (header & 2) {
      out.push(JSON.parse(Buffer.concat(parts).toString("utf8")));
      parts = null;
    }
  }
  return out;
}

class Phone {
  constructor(directory) {
    this.input = path.join(directory, "data", "ble-in.jsonl");
    this.output = path.join(directory, "data", "ble-out.jsonl");
  }
  async emit(event) {
    await appendFile(this.input, JSON.stringify(event) + "\n");
  }
  async subscribe(uuid) {
    await this.emit({ event: "subscribe", link: "notify", uuid, on: true });
  }
  async mtu(value) {
    await this.emit({ event: "mtu", mtu: value });
  }
  async write(message, mtu = 247) {
    for (const frame of frames(Buffer.from(JSON.stringify(message)), mtu)) {
      await this.emit({ event: "write", link: "phone-1", frame: frame.toString("base64") });
    }
  }
  async lines() {
    const text = await readFile(this.output, "utf8");
    return text.split("\n").filter(Boolean).map((line) => JSON.parse(line));
  }
  async states() {
    return messagesOf(await this.lines(), STATE_UUID);
  }
  async acks() {
    return messagesOf(await this.lines(), ACK_UUID);
  }
  async ackFor(id) {
    return waitFor(async () => (await this.acks()).find((ack) => ack.id === id), `the acknowledgement ${id}`);
  }
}

function fixture() {
  return {
    settings: { serverName: "HYDRA-UMC ble contract" },
    controllers: [{
      id: "ble-controller",
      name: "Ble Controller",
      robots: [
        { id: 1, name: "Robot B1", playbackState: { isPlaying: true, playing: true, isPaused: false, paused: false }, pos: { x: 0, y: 0, z: 0, a: 0, b: 0, c: 0 } },
        { id: 2, name: "Robot B2", playbackState: { isPlaying: false, playing: false, isPaused: false, paused: false }, pos: { x: 0, y: 0, z: 0, a: 0, b: 0, c: 0 } },
      ],
    }],
  };
}

async function runServer(mode) {
  const directory = await mkdtemp(path.join(tmpdir(), "hydra-umc-server-ble-"));
  const port = await reservePort();
  await mkdir(path.join(directory, "data"), { recursive: true });
  await writeFile(path.join(directory, "data", "settings.json"), `${JSON.stringify(fixture())}\n`, "utf8");
  await writeFile(path.join(directory, "data", "server-config.json"), JSON.stringify({ ble: { mode, helperCommand: process.execPath, frameDelayMs: 0, minStateIntervalMs: 50 } }), "utf8");
  let logs = "";
  const child = spawn(process.execPath, [TSX_CLI, SERVER_SOURCE], {
    cwd: directory,
    env: {
      ...process.env,
      PORT: String(port),
      NODE_ENV: "test",
      JWT_SECRET: "local-ble-contract-verification-only-not-for-deployment",
      HYDRA_UMC_BOOTSTRAP_ADMIN_USERNAME: ADMIN.username,
      HYDRA_UMC_BOOTSTRAP_ADMIN_PASSWORD: ADMIN.password,
      HYDRA_UMC_BLE_HELPER: FAKE_HELPER,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (chunk) => { logs += chunk; });
  child.stderr.on("data", (chunk) => { logs += chunk; });
  try {
    await waitFor(async () => (await fetch(`http://127.0.0.1:${port}/api/hydra-info`)).ok, "the server");
    await waitFor(() => /Bluetooth LE service started/.test(logs), "the Bluetooth service");
  } catch (error) {
    child.kill();
    throw new Error(`${error.message}\nServer output:\n${logs}`);
  }
  return { directory, port, child, logs: () => logs };
}

async function stop(run) {
  run.child.kill();
  await once(run.child, "exit").catch(() => undefined);
  await rm(run.directory, { recursive: true, force: true, maxRetries: 5 }).catch(() => undefined);
}

async function login(port, who) {
  const result = await request(port, "/api/login", { method: "POST", body: JSON.stringify(who) });
  assert.equal(result.response.status, 200, `login of ${who.username}`);
  return result.body.token;
}

async function commandsMode() {
  const run = await runServer("commands");
  try {
    const { port } = run;
    const phone = new Phone(run.directory);
    const adminToken = await login(port, ADMIN);
    const adminAuth = { authorization: `Bearer ${adminToken}` };
    const created = await request(port, "/api/users", { method: "POST", headers: adminAuth, body: JSON.stringify({ ...OPERATOR, role: "operator" }) });
    assert.equal(created.response.status, 200);
    const operatorToken = await login(port, OPERATOR);

    // the state arrives after the subscription, cut for the MTU the phone negotiated
    await phone.mtu(185);
    await phone.subscribe(ACK_UUID);
    await phone.subscribe(STATE_UUID);
    const first = await waitFor(async () => (await phone.states())[0], "the first state");
    assert.equal(first.controllers[0].robots.length, 2);
    for (const line of await phone.lines()) assert.ok(Buffer.from(line.frame, "base64").length <= 185 - 3, "no frame past MTU - 3");
    assert.equal(JSON.stringify(first).includes("rtsp"), false, "no camera credentials over the radio");

    // a command with the token of an account is applied, and acknowledged
    await phone.write({ id: "p1", robotId: 1, command: "pause", params: { paused: true }, controllerId: "phone-1", token: operatorToken });
    const applied = await phone.ackFor("p1");
    assert.deepEqual([applied.ok, applied.status, applied.code], [true, 200, "ok"]);
    const settings = await request(port, "/api/settings", { headers: adminAuth });
    assert.equal(settings.body.controllers[0].robots[0].playbackState.isPaused, true, "the command changed the robot");
    await waitFor(async () => (await phone.states()).some((s) => s.controllers?.[0]?.robots?.[0]?.playbackState?.isPaused === true), "the state after the change");

    // a bad token is refused by the route, never acknowledged as applied
    await phone.write({ id: "p2", robotId: 1, command: "pause", params: { paused: false }, controllerId: "phone-1", token: "not-a-token" });
    const badToken = await phone.ackFor("p2");
    assert.equal(badToken.ok, false);
    assert.ok([401, 403].includes(badToken.status), `status ${badToken.status}`);
    const unchanged = await request(port, "/api/settings", { headers: adminAuth });
    assert.equal(unchanged.body.controllers[0].robots[0].playbackState.isPaused, true, "a refused command changed nothing");

    // a reservation held by someone else on the network refuses the phone; STOP is not blocked by it
    const claim = await request(port, "/api/robot/2/claim", { method: "POST", headers: adminAuth, body: JSON.stringify({ controllerId: "studio-1" }) });
    assert.equal(claim.response.status, 200, JSON.stringify(claim.body));
    await phone.write({ id: "p3", robotId: 2, command: "speed", params: { speed: 200 }, controllerId: "phone-1", token: operatorToken });
    const reserved = await phone.ackFor("p3");
    assert.equal(reserved.ok, false);
    assert.equal(reserved.status, 409);
    await phone.write({ id: "p4", robotId: 2, command: "stop", params: {}, controllerId: "phone-1", token: operatorToken });
    const stopped = await phone.ackFor("p4");
    assert.deepEqual([stopped.ok, stopped.status], [true, 200], "a STOP is never blocked by someone else's reservation");

    // what the phone sends is checked before it reaches the route
    await phone.write({ id: "p5", robotId: 1, command: "launch-missiles", params: {}, token: operatorToken });
    assert.equal((await phone.ackFor("p5")).code, "unknown-command");
    await phone.write({ id: "p6", robotId: 1, command: "pause", params: {} });
    assert.equal((await phone.ackFor("p6")).code, "token-required");

    // a small MTU still carries a command: it is cut into many frames and put back together
    await phone.write({ id: "p7", robotId: 1, command: "speed", params: { speed: 120 }, controllerId: "phone-1", token: operatorToken }, 23);
    assert.equal((await phone.ackFor("p7")).ok, true);
    console.log("SERVER_BLE_GATT_CONTRACT=PASS mode=commands state=1 command_applied=1 bad_token=1 reservation=1 stop_exception=1 validation=2 small_mtu=1");
  } finally {
    await stop(run);
  }
}

async function stateMode() {
  const run = await runServer("state");
  try {
    const phone = new Phone(run.directory);
    const adminToken = await login(run.port, ADMIN);
    await phone.subscribe(ACK_UUID);
    await phone.subscribe(STATE_UUID);
    await waitFor(async () => (await phone.states())[0], "the state");
    await phone.write({ id: "s1", robotId: 1, command: "pause", params: { paused: true }, token: adminToken });
    const refused = await phone.ackFor("s1");
    assert.deepEqual([refused.ok, refused.code], [false, "commands-disabled"]);
    const settings = await request(run.port, "/api/settings", { headers: { authorization: `Bearer ${adminToken}` } });
    assert.equal(settings.body.controllers[0].robots[0].playbackState.isPaused, false, "nothing changed");
    console.log("SERVER_BLE_GATT_CONTRACT=PASS mode=state commands_disabled=1");
  } finally {
    await stop(run);
  }
}

await commandsMode();
await stateMode();
