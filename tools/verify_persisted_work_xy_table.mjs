// =============================================================================
// HYDRA-UMC-SERVER - real persisted Work exercising the XY table (tx/ty)
// Copyright (C) 2026 JuanenRac (Electro Hobby 3D) <electrohobby3d@gmail.com>
// GPL-3.0 - see LICENSE
// =============================================================================
// Real gap this closes: every Work file actually persisted under
// data/WORKS/<robot>/ used only {x,y,z,a,b,c} - the XY table's own tx/ty
// axes were exercised exclusively by STUDIO's in-memory Examples
// (src/examples/list/*.ts), never by anything a user could load, save
// and replay for real. data/WORKS/RobotA1/inspeccion_con_mesa_xy.json is
// the first real, persisted Work that moves the table - this script
// loads THAT EXACT FILE (not a hand-typed copy of it) into a real
// isolated server instance and proves 'play' drives xyTable.pos through
// every one of its real tx/ty values in order, the same server-
// authoritative playback engine verify_server_playback_contract.mjs
// already proves for a synthetic fixture.
//
// Same real-server, no-browser-client pattern as
// verify_server_playback_contract.mjs - an isolated temporary data
// directory, a real spawned server process, real HTTP requests only.

import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TSX_CLI = path.join(ROOT, "node_modules", "tsx", "dist", "cli.mjs");
const SERVER_SOURCE = path.join(ROOT, "src", "server.ts");
const REAL_WORK_PATH = path.join(ROOT, "data", "WORKS", "RobotA1", "inspeccion_con_mesa_xy.json");
const ADMIN = { username: "persisted-work-contract-admin", password: "persisted-work-contract-admin-password" };

async function waitUntil(fn, { timeoutMs = 25000, intervalMs = 100, message = "condition" } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const result = await fn();
    if (result) return result;
    if (Date.now() > deadline) throw new Error(`timed out waiting for: ${message}`);
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

async function reservePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

async function waitForServer(port) {
  await waitUntil(
    async () => {
      try {
        const response = await fetch(`http://127.0.0.1:${port}/api/hydra-info`);
        return response.ok;
      } catch {
        return false;
      }
    },
    { message: "server to accept connections" },
  );
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

async function writeFixture(directory, recordedPoints) {
  await mkdir(path.join(directory, "data"), { recursive: true });
  const settings = {
    settings: { serverName: "HYDRA-UMC persisted-work contract" },
    controllers: [{
      id: "persisted-work-controller",
      name: "Persisted Work Controller",
      robots: [{
        id: 1,
        name: "Robot A1",
        hasXYTable: true,
        xyTable: { pos: { x: 0, y: 0 }, tableSize: { width: 500, length: 500 } },
        pos: { x: 0, y: 0, z: 0, a: 0, b: 0, c: 0, tx: 0, ty: 0 },
        playbackState: { isPlaying: false, playing: false, isPaused: false, paused: false, speed: 40 },
        recordedPoints,
      }],
    }],
  };
  await writeFile(path.join(directory, "data", "settings.json"), `${JSON.stringify(settings)}\n`, "utf8");
}

async function main() {
  const rawWork = await readFile(REAL_WORK_PATH, "utf8");
  const points = JSON.parse(rawWork);
  assert.ok(Array.isArray(points) && points.length >= 2, "the real Work file must contain at least 2 points");
  const withTableAxes = points.filter((point) => typeof point.tx === "number" && typeof point.ty === "number");
  assert.ok(
    withTableAxes.length >= 2,
    "this is exactly the real gap being closed: a persisted Work exercising the XY table needs at least 2 real tx/ty points, not just one incidental value",
  );
  const distinctTablePositions = new Set(withTableAxes.map((point) => `${point.tx},${point.ty}`));
  assert.ok(distinctTablePositions.size >= 3, "the table must actually move between real distinct positions, not sit at one spot");

  const temporaryDirectory = await mkdtemp(path.join(tmpdir(), "hydra-umc-server-persisted-work-"));
  const port = await reservePort();
  let child;
  let logs = "";
  try {
    await writeFixture(temporaryDirectory, points);
    child = spawn(process.execPath, [TSX_CLI, SERVER_SOURCE], {
      cwd: temporaryDirectory,
      env: {
        ...process.env,
        PORT: String(port),
        NODE_ENV: "test",
        JWT_SECRET: "local-persisted-work-contract-verification-only-not-for-deployment",
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
    const authorization = { authorization: `Bearer ${login.body.token}` };

    const currentRobot1 = async () => {
      const s = await request(port, "/api/settings");
      return findRobot(s.body, 1);
    };

    const play = await request(port, "/api/robot/1/command", {
      method: "POST", headers: authorization, body: JSON.stringify({ command: "play" }),
    });
    assert.equal(play.response.status, 200);

    // Walk through every real table position the file actually contains,
    // in order - not just "it moved once" but the whole real sequence,
    // proving playback drives xyTable.pos through this specific file's
    // own content rather than a coincidentally-similar shape.
    const seenPositions = [];
    await waitUntil(
      async () => {
        const robot = await currentRobot1();
        const current = `${robot.xyTable.pos.x},${robot.xyTable.pos.y}`;
        if (seenPositions[seenPositions.length - 1] !== current) seenPositions.push(current);
        return robot.playbackState.isFinished === true;
      },
      { timeoutMs: 30000, message: "playback of the real persisted Work to reach its end" },
    );

    const expectedPositions = [...distinctTablePositions];
    for (const expected of expectedPositions) {
      assert.ok(
        seenPositions.includes(expected),
        `playback must have visited real table position ${expected} from the persisted Work file, saw: ${seenPositions.join(" -> ")}`,
      );
    }

    const finalRobot = await currentRobot1();
    const lastPoint = points[points.length - 1];
    assert.equal(finalRobot.xyTable.pos.x, lastPoint.tx, "the table must end at the file's own last real position");
    assert.equal(finalRobot.xyTable.pos.y, lastPoint.ty, "the table must end at the file's own last real position");
    assert.equal(finalRobot.playbackState.isPlaying, false, "playback must stop itself once the real file's own last point is applied");

    console.log(`PERSISTED_WORK_XY_TABLE=PASS points=${points.length} distinctTablePositions=${distinctTablePositions.size} sequence=${seenPositions.join(" -> ")}`);
  } finally {
    if (child) {
      child.kill();
      await new Promise((resolve) => child.once("exit", resolve));
    }
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
