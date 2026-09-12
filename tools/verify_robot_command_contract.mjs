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
          hasXYTable: true,
          xyTable: { pos: { x: 0, y: 0 }, tableSize: { width: 500, length: 500 } },
          pos: { x: 0, y: 0, z: 0, a: 0, b: 0, c: 0, tx: 0, ty: 0 },
        },
        {
          id: 2,
          name: "Robot A2",
          visionEnabled: false,
          camera: { connected: true },
          playbackState: { isPlaying: true, playing: true, isPaused: true, paused: true },
          // Real regression fixture: "turning the table off" in the UI
          // only ever flips hasXYTable, the config object is never
          // cleared (XYTableConfig.tsx) - this stale-but-present
          // xyTable is exactly what let the server misapply robot 1's
          // table jog to this table-less combined sibling.
          hasXYTable: false,
          xyTable: { pos: { x: 0, y: 0 }, tableSize: { width: 500, length: 500 } },
          pos: { x: 0, y: 0, z: 0, a: 0, b: 0, c: 0, tx: 77, ty: 88 },
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

    // Real regression found live on STUDIO/CM5: jogging robot 1's own
    // real XY table used to also relocate robot 2 (a combined sibling
    // with NO real table, hasXYTable: false) because the server only
    // checked "does a config object exist" (robot.xyTable, always
    // present) instead of "does THIS robot actually have a table"
    // (robot.hasXYTable). robot 2's own pos.tx/ty doubles as its
    // general world-placement in the 3D scene for a table-less combined
    // robot - so this bug directly, visibly moved robot 2's whole model
    // whenever anyone jogged robot 1's table.
    const jogTable = await request(port, "/api/robot/1/command", {
      method: "POST",
      headers: authorization,
      body: JSON.stringify({ command: "jog", params: { axis: "x", amount: 250, target: "xytable", absolute: true } }),
    });
    assert.equal(jogTable.response.status, 200);

    settings = await request(port, "/api/settings");
    const jogA1 = findRobot(settings.body, 1);
    const jogA2 = findRobot(settings.body, 2);
    assert.equal(jogA1.xyTable.pos.x, 250, "the robot that actually has a table must move it");
    assert.equal(jogA1.pos.tx, 250);
    assert.equal(jogA2.xyTable.pos.x, 0, "a table-less combined sibling's stale xyTable config must never be touched");
    assert.equal(jogA2.pos.tx, 77, "a table-less combined sibling's own world-placement pos.tx must never be stomped by another robot's table jog");
    assert.equal(jogA2.pos.ty, 88);

    // Same real regression, via 'reset' target:"xytable" - must be
    // equally gated on hasXYTable, not just "jog".
    const resetTable = await request(port, "/api/robot/1/command", {
      method: "POST",
      headers: authorization,
      body: JSON.stringify({ command: "reset", params: { target: "xytable" } }),
    });
    assert.equal(resetTable.response.status, 200);
    settings = await request(port, "/api/settings");
    const resetA2 = findRobot(settings.body, 2);
    assert.equal(resetA2.pos.tx, 77, "resetting robot 1's table must never touch robot 2's own world-placement pos.tx");
    assert.equal(resetA2.pos.ty, 88);

    // Custom vacuum footprints use ordinary settings, not a physical command.
    settings = await request(port, "/api/settings");
    const otherRobot = structuredClone(findRobot(settings.body, 2));
    for (const width of [80, 165, 237, 500]) {
      const vacuumTable = { enabled: true, modelId: "232x217x15", customSize: true,
        size: { width, length: 150 }, pumpActive: false, valveActive: false,
        worldPos: { x: 12, y: 34 }, worldRot: 0.25, renderScale: 1 };
      findRobot(settings.body, 1).vacuumTable = vacuumTable;
      const saved = await request(port, "/api/settings", { method: "POST", headers: authorization,
        body: JSON.stringify(settings.body) });
      assert.equal(saved.response.status, 200);
      settings = await request(port, "/api/settings");
      assert.deepEqual(findRobot(settings.body, 1).vacuumTable, vacuumTable);
      assert.deepEqual(findRobot(settings.body, 2), otherRobot, "custom size must not affect another robot");
    }
    for (const [modelId, width, length] of [["100x100x5",100,100], ["200x100x5",200,100], ["200x200x5",200,200], ["255x255x5",255,255], ["255x255x5",260,150]]) {
      const heatedBed = { enabled: true, modelId, size: { width, length }, targetTemp: 80,
        ssrActive: false, currentTemp1: 25, currentTemp2: 25,
        worldPos: { x: 12, y: 34 }, worldRot: 0.25, renderScale: 1 };
      findRobot(settings.body, 1).heatedBed = heatedBed;
      const saved = await request(port, "/api/settings", { method: "POST", headers: authorization,
        body: JSON.stringify(settings.body) });
      assert.equal(saved.response.status, 200);
      settings = await request(port, "/api/settings");
      assert.deepEqual(findRobot(settings.body, 1).heatedBed, heatedBed);
      assert.deepEqual(findRobot(settings.body, 2), otherRobot);
    }
    for (const capacity of [1,6,24]) {
      const rack2 = {type:"Output",width:200,depth:100,color:"#10b981",capacity:24,usableSlots:Array(24).fill(true),basePickupPos:{j1:42}};
      const rackSystem = {enabled:true, rack1:{type:"Input",width:161,depth:201,color:"#123abc",capacity,
        usableSlots:Array.from({length:24},(_,i)=>i%2===0),basePickupPos:{j1:12,tx:34},
        renderPos:{x:300,y:150},renderRot:0.2,renderScale:1},rack2};
      findRobot(settings.body,1).rackSystem = rackSystem;
      const saved = await request(port,"/api/settings",{method:"POST",headers:authorization,body:JSON.stringify(settings.body)});
      assert.equal(saved.response.status,200);
      settings=await request(port,"/api/settings");
      assert.deepEqual(findRobot(settings.body,1).rackSystem,rackSystem);
      assert.deepEqual(findRobot(settings.body,2),otherRobot);
    }
    console.log("SERVER_ROBOT_COMMAND_CONTRACT=PASS combined-pause=2 camera-state=3 trajectory-sync=5 xytable-ownership=2 vacuum-custom-size=4 heated-bed=5 rack=3");
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
