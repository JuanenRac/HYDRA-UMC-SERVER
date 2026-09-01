// =============================================================================
// HYDRA-UMC-SERVER - Atomic robot-command synchronization contract checks
// Copyright (C) 2026 JuanenRac (Electro Hobby 3D) <electrohobby3d@gmail.com>
// GPL-3.0 - see LICENSE
// =============================================================================
// Runs the real API in an isolated temporary data directory. It proves that
// combined robots receive one explicit pause state and that a vision command
// keeps robot.visionEnabled, robot.camera.connected and controller camera
// state aligned. No hardware, project data or live server is touched.

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
const ADMIN = { username: "robot-contract-admin", password: "robot-contract-admin-password" };

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

function findRobot(settings, id) {
  for (const controller of settings.controllers ?? []) {
    const robot = controller.robots?.find((candidate) => candidate.id === id);
    if (robot) return robot;
  }
  throw new Error(`robot ${id} not found in returned settings`);
}

async function writeFixture(directory) {
  await mkdir(path.join(directory, "data"), { recursive: true });
  const settings = {
    settings: { serverName: "HYDRA-UMC command contract" },
    controllers: [{
      id: "contract-controller",
      name: "Contract Controller",
      cameras: [{ id: 101, assignedRobotId: 1, connected: true }],
      robots: [
        {
          id: 1,
          name: "Robot A1",
          combinedWith: [2],
          visionEnabled: false,
          camera: { connected: true },
          playbackState: { isPlaying: true, playing: true, isPaused: false, paused: false },
        },
        {
          id: 2,
          name: "Robot A2",
          visionEnabled: false,
          camera: { connected: true },
          playbackState: { isPlaying: true, playing: true, isPaused: true, paused: true },
        },
      ],
    }],
  };
  await writeFile(path.join(directory, "data", "settings.json"), `${JSON.stringify(settings)}\n`, "utf8");
}

async function main() {
  const temporaryDirectory = await mkdtemp(path.join(tmpdir(), "hydra-umc-server-robot-command-"));
  const port = await reservePort();
  let child;
  let logs = "";
  try {
    await writeFixture(temporaryDirectory);
    child = spawn(process.execPath, [TSX_CLI, SERVER_SOURCE], {
      cwd: temporaryDirectory,
      env: {
        ...process.env,
        PORT: String(port),
        NODE_ENV: "test",
        JWT_SECRET: "local-robot-command-contract-verification-only-not-for-deployment",
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

    const login = await request(port, "/api/login", {
      method: "POST",
      body: JSON.stringify(ADMIN),
    });
    assert.equal(login.response.status, 200);
    const authorization = { authorization: `Bearer ${login.body.token}` };

    const pause = await request(port, "/api/robot/1/command", {
      method: "POST",
      headers: authorization,
      body: JSON.stringify({ command: "pause", params: { paused: true } }),
    });
    assert.equal(pause.response.status, 200);
    assert.equal(pause.body.affectedCount, 2);

    let settings = await request(port, "/api/settings");
    assert.equal(settings.response.status, 200);
    for (const id of [1, 2]) {
      const playback = findRobot(settings.body, id).playbackState;
      assert.equal(playback.isPaused, true, `robot ${id} must receive the group pause state`);
      assert.equal(playback.paused, true, `robot ${id} paused alias must be synchronized`);
      assert.equal(playback.requestPause, true, `robot ${id} browser pause request must be synchronized`);
    }

    const vision = await request(port, "/api/robot/1/command", {
      method: "POST",
      headers: authorization,
      body: JSON.stringify({ command: "vision", params: { enabled: false } }),
    });
    assert.equal(vision.response.status, 200);

    settings = await request(port, "/api/settings");
    const a1 = findRobot(settings.body, 1);
    assert.equal(a1.visionEnabled, false);
    assert.equal(a1.camera.connected, false, "embedded robot camera must not retain a stale enabled state");
    assert.equal(settings.body.controllers[0].cameras[0].connected, false, "controller camera must match its robot command");

    const points = [
      { motionType: "model-joints", j1: -10, j2: -25, j3: 20, j4: 0, j5: 0, j6: 0, x: 190, y: -30, z: 10 },
      { motionType: "model-joints", j1: 10, j2: -20, j3: 25, j4: 0, j5: 0, j6: 0, x: 190, y: 30, z: 10 },
    ];
    const trajectory = await request(port, "/api/robot/1/command", {
      method: "POST",
      headers: authorization,
      body: JSON.stringify({ command: "trajectory", params: { points, selectedWorkFile: "a1-circle.json", selectedExample: "example-2-circle" } }),
    });
    assert.equal(trajectory.response.status, 200);
    assert.equal(trajectory.body.affectedCount, 1, "a loaded Work must not overwrite a combined sibling");

    settings = await request(port, "/api/settings");
    const trajectoryA1 = findRobot(settings.body, 1);
    const trajectoryA2 = findRobot(settings.body, 2);
    assert.deepEqual(trajectoryA1.recordedPoints, points, "Server must persist the selected Work before Play");
    assert.equal(trajectoryA1.selectedWorkFile, "a1-circle.json");
    assert.equal(trajectoryA1.selectedExample, "example-2-circle", "Server must persist the selected example with its atomic trajectory");
    assert.equal(trajectoryA1.playbackState.activeStep, -1, "loading a Work must reset its playback cursor");
    assert.deepEqual(trajectoryA2.recordedPoints ?? [], [], "combined sibling must retain its own trajectory");
    console.log("SERVER_ROBOT_COMMAND_CONTRACT=PASS combined-pause=2 camera-state=3 trajectory-sync=5");
  } finally {
    if (child && child.exitCode === null) {
      child.kill("SIGTERM");
      await Promise.race([once(child, "exit"), new Promise((resolve) => setTimeout(resolve, 3000))]);
      if (child.exitCode === null) child.kill("SIGKILL");
    }
    await rm(temporaryDirectory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
}

main().catch((error) => {
  console.error("SERVER_ROBOT_COMMAND_CONTRACT=FAIL", error instanceof Error ? error.stack : error);
  process.exitCode = 1;
});
