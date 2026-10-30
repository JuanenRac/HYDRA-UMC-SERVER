// =============================================================================
// HYDRA-UMC-SERVER - Robot enable/disable (safe mode) contract checks
// Copyright (C) 2026 JuanenRac (Electro Hobby 3D) <electrohobby3d@gmail.com>
// GPL-3.0-or-later - see LICENSE
// =============================================================================
// Runs the real API in an isolated temporary data directory. It proves that
// `disable` stops a robot and puts it in safe mode (its motion commands are
// refused, a stop still works), that `enable` is refused while the option is
// off (the default) and for an operator, and that it brings the robot back
// once an administrator turned the option on. No hardware, project data or
// live server is touched.

import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TSX_CLI = path.join(ROOT, "node_modules", "tsx", "dist", "cli.mjs");
const SERVER_SOURCE = path.join(ROOT, "src", "server.ts");
const ADMIN = { username: "robot-enable-admin", password: "robot-enable-admin-password" };
const OPERATOR = { username: "robot-enable-operator", password: "robot-enable-operator-password" };

async function reservePort() {
  const listener = createServer();
  listener.listen(0, "127.0.0.1");
  await once(listener, "listening");
  const address = listener.address();
  assert(address && typeof address === "object");
  listener.close();
  await once(listener, "close");
  return address.port;
}

async function waitForServer(port) {
  let lastError;
  for (let attempt = 0; attempt < 120; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/hydra-info`);
      if (response.ok) return;
      lastError = new Error(`HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`server did not become ready: ${lastError}`);
}

async function request(port, route, options = {}) {
  const response = await fetch(`http://127.0.0.1:${port}${route}`, {
    ...options,
    headers: { "content-type": "application/json", ...(options.headers ?? {}) },
  });
  return { response, body: await response.json() };
}

async function writeFixture(directory) {
  await mkdir(path.join(directory, "data"), { recursive: true });
  const settings = {
    settings: { serverName: "HYDRA-UMC enable contract" },
    controllers: [{
      id: "contract-controller",
      name: "Contract Controller",
      cameras: [],
      robots: [{
        id: 1,
        name: "Robot A1",
        playbackState: { isPlaying: true, playing: true, isPaused: false, paused: false },
        valves: [true, false],
        pumps: [true],
        pos: { x: 0, y: 0, z: 0, a: 0, b: 0, c: 0 },
      }],
    }],
  };
  await writeFile(path.join(directory, "data", "settings.json"), `${JSON.stringify(settings)}\n`, "utf8");
}

async function main() {
  const temporaryDirectory = await mkdtemp(path.join(tmpdir(), "hydra-umc-server-robot-enable-"));
  const port = await reservePort();
  let child;
  let logs = "";
  try {
    await writeFixture(temporaryDirectory);
    child = spawn(process.execPath, [TSX_CLI, SERVER_SOURCE], {
      cwd: temporaryDirectory,
      env: {
        ...process.env,
        HYDRA_UMC_SERVER_PORT: String(port),
        NODE_ENV: "test",
        JWT_SECRET: "local-robot-enable-contract-verification-only-not-for-deployment",
        HYDRA_UMC_BOOTSTRAP_ADMIN_USERNAME: ADMIN.username,
        HYDRA_UMC_BOOTSTRAP_ADMIN_PASSWORD: ADMIN.password,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.on("data", (chunk) => { logs += chunk; });
    child.stderr.on("data", (chunk) => { logs += chunk; });
    try {
      await waitForServer(port);
    } catch (error) {
      throw new Error(`${error instanceof Error ? error.message : error}\nServer startup output:\n${logs || "<no output>"}`);
    }

    const login = await request(port, "/api/login", { method: "POST", body: JSON.stringify(ADMIN) });
    assert.equal(login.response.status, 200);
    const admin = { authorization: `Bearer ${login.body.token}` };

    const created = await request(port, "/api/users", { method: "POST", headers: admin, body: JSON.stringify({ ...OPERATOR, role: "operator" }) });
    assert.equal(created.response.status, 200);
    const operatorLogin = await request(port, "/api/login", { method: "POST", body: JSON.stringify(OPERATOR) });
    assert.equal(operatorLogin.response.status, 200);
    const operator = { authorization: `Bearer ${operatorLogin.body.token}` };

    const command = (headers, name, params) =>
      request(port, "/api/robot/1/command", { method: "POST", headers, body: JSON.stringify({ command: name, ...(params ? { params } : {}) }) });
    const robot = async () => {
      const settings = await request(port, "/api/settings", { headers: admin });
      return settings.body.controllers[0].robots[0];
    };

    // 1. The option is off by default.
    const config = await request(port, "/api/admin/server-config", { headers: admin });
    assert.equal(config.body.robots.allowEnable.value, false);
    assert.equal(config.body.robots.allowEnable.source, "default");

    // 2. An operator can disable: the robot stops, its outputs go off, and it says so.
    const disabled = await command(operator, "disable");
    assert.equal(disabled.response.status, 200);
    assert.equal(disabled.body.success, true);
    let state = await robot();
    assert.equal(state.enabled, false);
    assert.equal(state.playbackState.isPlaying, false);
    assert.deepEqual(state.valves, [false, false]);
    assert.deepEqual(state.pumps, [false]);

    // 3. A disabled robot refuses its motion commands (423) but still takes a stop, and disabling again changes nothing.
    for (const [name, params] of [["play"], ["jog", { axis: "x", amount: 1 }], ["speed", { speed: 100 }]]) {
      const refused = await command(admin, name, params);
      assert.equal(refused.response.status, 423, `${name} on a disabled robot`);
      assert.equal(refused.body.code, "robot-disabled");
    }
    assert.equal((await command(operator, "stop")).response.status, 200);
    assert.equal((await command(operator, "disable")).response.status, 200);
    const arm = await request(port, "/api/robot/1/jog-arm", { method: "POST", headers: admin, body: JSON.stringify({ armed: true }) });
    assert.equal(arm.response.status, 423, "a disabled robot cannot be armed for a jog");

    // 4. Enabling is refused while the option is off, even for an administrator.
    const offByDefault = await command(admin, "enable");
    assert.equal(offByDefault.response.status, 403);
    assert.equal(offByDefault.body.code, "enable-not-allowed");
    assert.equal((await robot()).enabled, false);

    // 5. With the option on, an operator is still refused and an administrator brings the robot back.
    const turnedOn = await request(port, "/api/admin/server-config", { method: "PUT", headers: admin, body: JSON.stringify({ robots: { allowEnable: true } }) });
    assert.equal(turnedOn.response.status, 200);
    assert.equal(turnedOn.body.robots.allowEnable.value, true);
    assert.ok(turnedOn.body.warnings.includes("robot_enable_allowed"));
    const operatorEnable = await command(operator, "enable");
    assert.equal(operatorEnable.response.status, 403);
    assert.equal(operatorEnable.body.code, "admin-required");
    const enabled = await command(admin, "enable");
    assert.equal(enabled.response.status, 200);
    state = await robot();
    assert.equal(state.enabled, true);
    assert.equal(state.playbackState.isPlaying, false, "enabling restarts nothing");

    // 6. The robot takes commands again.
    assert.equal((await command(admin, "speed", { speed: 100 })).response.status, 200);

    // 7. Enabling and disabling are in the audit record.
    const audit = await request(port, "/api/audit?limit=200", { headers: admin });
    const types = audit.body.entries.map((entry) => `${entry.type}:${entry.outcome}`);
    for (const wanted of ["robot-disable:ok", "robot-enable:refused", "robot-enable:ok"]) {
      assert.ok(types.includes(wanted), `the audit record has ${wanted}`);
    }

    // 8. A value that is not true or false is refused.
    const bad = await request(port, "/api/admin/server-config", { method: "PUT", headers: admin, body: JSON.stringify({ robots: { allowEnable: "yes" } }) });
    assert.equal(bad.response.status, 400);

    console.log("SERVER_ROBOT_ENABLE_CONTRACT=PASS default_off=1 disable=1 safe_mode=1 enable_gated=1 admin_only=1 audit=1");
  } finally {
    if (child && child.exitCode === null) {
      child.kill();
      await once(child, "exit").catch(() => undefined);
    }
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
