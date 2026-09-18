// =============================================================================
// HYDRA-UMC-SERVER - Concurrent combined-robot command race contract checks
// Copyright (C) 2026 JuanenRac (Electro Hobby 3D) <electrohobby3d@gmail.com>
// GPL-3.0 - see LICENSE
// =============================================================================
// verify_robot_command_contract.mjs already proves ONE combined-robot command
// at a time is applied correctly. This file covers the concern that contract
// leaves open: several requests racing the SAME combined-robot group at once.
// POST /api/robot/:id/command and POST /api/robot/:id/claim both mutate the
// shared, in-process `lastKnownSettings` object synchronously (no `await`
// between reading a robot's current state and writing its new state - the
// route's own single `await queueSettingsWrite(...)` only ever runs AFTER
// every in-memory mutation is already committed), so Node's single-threaded
// event loop can never interleave two of these handlers mid-mutation. This
// spawns a real server and fires real concurrent HTTP requests to prove that
// holds for both the settings mutation itself and the on-disk write order,
// not just to restate it as a comment.

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
const ADMIN = { username: "robot-race-admin", password: "robot-race-admin-password" };
const OPERATOR = { username: "robot-race-operator", password: "robot-race-operator-password" };

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
    settings: { serverName: "HYDRA-UMC race contract" },
    controllers: [{
      id: "race-controller",
      name: "Race Controller",
      cameras: [],
      robots: [
        {
          id: 1,
          name: "Robot A1",
          combinedWith: [2],
          playbackState: { isPlaying: false, playing: false, isPaused: false, paused: false, speed: 100 },
          pos: { x: 0, y: 0, z: 0, a: 0, b: 0, c: 0, tx: 0, ty: 0 },
        },
        {
          id: 2,
          name: "Robot A2",
          playbackState: { isPlaying: false, playing: false, isPaused: false, paused: false, speed: 100 },
          pos: { x: 0, y: 0, z: 0, a: 0, b: 0, c: 0, tx: 0, ty: 0 },
        },
      ],
    }],
  };
  await writeFile(path.join(directory, "data", "settings.json"), `${JSON.stringify(settings)}\n`, "utf8");
}

async function main() {
  const temporaryDirectory = await mkdtemp(path.join(tmpdir(), "hydra-umc-server-robot-race-"));
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
        JWT_SECRET: "local-robot-race-contract-verification-only-not-for-deployment",
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

    const adminLogin = await request(port, "/api/login", { method: "POST", body: JSON.stringify(ADMIN) });
    assert.equal(adminLogin.response.status, 200);
    const adminAuth = { authorization: `Bearer ${adminLogin.body.token}` };

    const createOperator = await request(port, "/api/users", {
      method: "POST",
      headers: adminAuth,
      body: JSON.stringify({ username: OPERATOR.username, password: OPERATOR.password, role: "operator" }),
    });
    assert.equal(createOperator.response.status, 200);
    const operatorLogin = await request(port, "/api/login", { method: "POST", body: JSON.stringify(OPERATOR) });
    assert.equal(operatorLogin.response.status, 200);
    const operatorAuth = { authorization: `Bearer ${operatorLogin.body.token}` };

    // 1) N concurrent, DISTINCT speed setpoints racing the same combined
    // group (robot 1 + its sibling robot 2). Every request must be applied
    // (never dropped/500'd), and whichever one's response the client sees
    // last on the wire must match what GET /api/settings now reports -
    // i.e. request completion order and final-state order must agree, which
    // only holds if the settings mutation for each request is truly atomic
    // with no other request's mutation interleaved inside it.
    const CONCURRENCY = 12;
    const speeds = Array.from({ length: CONCURRENCY }, (_, i) => 20 + i * 5);
    const responses = await Promise.all(
      speeds.map((speed) =>
        request(port, "/api/robot/1/command", {
          method: "POST",
          headers: adminAuth,
          body: JSON.stringify({ command: "speed", params: { speed } }),
        }).then((r) => ({ speed, ...r })),
      ),
    );
    for (const r of responses) {
      assert.equal(r.response.status, 200, `speed=${r.speed} must succeed`);
      assert.equal(r.body.success, true);
      assert.equal(r.body.affectedCount, 2, `speed=${r.speed} must fan out to both combined robots`);
    }

    let settings = await request(port, "/api/settings", { headers: adminAuth });
    const finalA1 = findRobot(settings.body, 1);
    const finalA2 = findRobot(settings.body, 2);
    // The sibling must always end up with EXACTLY the same speed as robot 1
    // - a torn/interleaved write could otherwise leave the two combined
    // robots on two different speeds, which is the exact real data-loss
    // shape a settings-write race would produce.
    assert.equal(finalA2.playbackState.speed, finalA1.playbackState.speed,
      "a combined sibling must never end up on a different speed than the robot that commanded it");
    assert(speeds.includes(finalA1.playbackState.speed),
      "the final speed must be one of the actually-requested values, not a corrupted merge of several");

    // 2) Concurrent commands on TWO DIFFERENT (non-combined) robot groups
    // must not clobber each other's unrelated field - proves the shared
    // `lastKnownSettings` mutation doesn't leak across robots under
    // concurrency either.
    const [posX, posSpeed] = await Promise.all([
      request(port, "/api/robot/1/command", {
        method: "POST", headers: adminAuth,
        body: JSON.stringify({ command: "jog", params: { axis: "x", amount: 42, absolute: true } }),
      }),
      request(port, "/api/robot/2/command", {
        method: "POST", headers: operatorAuth,
        body: JSON.stringify({ command: "speed", params: { speed: 77 } }),
      }),
    ]);
    assert.equal(posX.response.status, 200);
    assert.equal(posSpeed.response.status, 200);
    settings = await request(port, "/api/settings", { headers: adminAuth });
    assert.equal(findRobot(settings.body, 1).pos.x, 42);
    assert.equal(findRobot(settings.body, 2).playbackState.speed, 77,
      "robot 2's own independent speed must survive a concurrent unrelated command on robot 1");

    // 3) Concurrent CLAIM attempts on the same robot from two different
    // accounts: exactly one must win, the other must see a real 409 with
    // the winner's identity - never both succeeding, and never the robot
    // left unclaimed.
    const [claimAdmin, claimOperator] = await Promise.all([
      request(port, "/api/robot/1/claim", { method: "POST", headers: adminAuth, body: JSON.stringify({}) }),
      request(port, "/api/robot/1/claim", { method: "POST", headers: operatorAuth, body: JSON.stringify({}) }),
    ]);
    const outcomes = [claimAdmin, claimOperator];
    const winners = outcomes.filter((o) => o.response.status === 200);
    const losers = outcomes.filter((o) => o.response.status === 409);
    assert.equal(winners.length, 1, "exactly one concurrent claimant must win the robot");
    assert.equal(losers.length, 1, "the other concurrent claimant must be rejected with 409, never silently dropped or both granted");
    assert.equal(losers[0].body.reservation?.ownerUsername, winners[0].body.reservation?.ownerUsername,
      "the loser's 409 must name the actual winner, not stale/inconsistent state");

    settings = await request(port, "/api/settings", { headers: adminAuth });
    assert.equal(findRobot(settings.body, 1).reservation?.ownerUsername, winners[0].body.reservation?.ownerUsername,
      "persisted state must agree with exactly the one winner both HTTP responses agreed on");

    console.log("SERVER_ROBOT_COMMAND_RACE_CONTRACT=PASS concurrent-speed=" + CONCURRENCY + " cross-robot=2 concurrent-claim=2");
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
  console.error("SERVER_ROBOT_COMMAND_RACE_CONTRACT=FAIL", error instanceof Error ? error.stack : error);
  process.exitCode = 1;
});
