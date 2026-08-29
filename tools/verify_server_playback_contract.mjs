// =============================================================================
// HYDRA-UMC-SERVER - V0 server-authoritative playback engine contract checks
// Copyright (C) 2026 JuanenRac (Electro Hobby 3D) <electrohobby3d@gmail.com>
// GPL-3.0 - see LICENSE
// =============================================================================
// Runs the real API in an isolated temporary data directory, same style as
// verify_robot_command_contract.mjs. Proves the server itself physically
// advances a robot's pos/joints through its own recordedPoints on 'play'
// (not just flipping a UI flag), that 'pause' actually halts advancement
// and resuming continues it, that 'stop' halts it for good, and that
// reaching the end sets isFinished - all without any browser client
// involved. No hardware, project data or live server is touched.

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
const ADMIN = { username: "playback-contract-admin", password: "playback-contract-admin-password" };

// The fixture's speed=40 against the server's own
// PLAYBACK_BASE_INTERVAL_MS=600 yields a 1500ms tick (600 * 100/40) - the
// exact same interval-scaling formula production traffic uses, picked
// slow enough to give a generous margin on a busy machine (this repo's
// own dev server or another test's own spawned child process also
// running concurrently).
//
// Earlier versions of this test waited a fixed "N ticks + margin" delay
// and then made one single point-in-time assertion - genuinely,
// repeatedly flaky in this environment (a spawned child process, real
// HTTP round-trips, a machine also running several other real builds/
// servers concurrently), sometimes observing one MORE tick than
// expected, sometimes one FEWER. Confirmed by reading real per-tick
// timestamps during investigation that the playback engine's own pause/
// resume/stop handling is correct and synchronous the instant it runs -
// the flakiness was entirely this test racing wall-clock assumptions
// against unpredictable scheduling, not a bug in server.ts. It can still
// occasionally need a longer timeoutMs below on a sufficiently loaded
// machine (chained after several other tests that each spawn and kill
// their own server process) - that's a real property of testing a
// wall-clock-driven engine honestly, not something a bigger constant
// alone fully eliminates.
//
// waitUntil()/staysStable() below replace every fixed-delay wait with
// either "poll until true (bounded timeout)" or "sample repeatedly and
// assert nothing changed", which are correct regardless of how fast or
// slow ticks actually land.
async function waitUntil(fn, { timeoutMs = 25000, intervalMs = 100, message = "condition" } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastValue;
  while (Date.now() < deadline) {
    lastValue = await fn();
    if (lastValue) return lastValue;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`timed out waiting for: ${message} (last value: ${JSON.stringify(lastValue)})`);
}

async function staysStable(fn, { durationMs = 2000, intervalMs = 150, message = "value" } = {}) {
  const deadline = Date.now() + durationMs;
  const first = await fn();
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
    const current = await fn();
    assert.deepEqual(current, first, `${message} must stay stable - was ${JSON.stringify(first)}, changed to ${JSON.stringify(current)}`);
  }
  return first;
}

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
    settings: { serverName: "HYDRA-UMC playback contract" },
    controllers: [{
      id: "playback-controller",
      name: "Playback Controller",
      robots: [
        {
          id: 1,
          name: "Robot A1",
          playbackState: { isPlaying: false, playing: false, isPaused: false, paused: false, speed: 40 },
          recordedPoints: [
            { j1: 10, j2: 20, j3: 30, j4: 0, j5: 0, j6: 0, x: 100, y: 0, z: 50, a: 0, b: 0, c: 0 },
            { j1: 15, j2: 25, j3: 35, j4: 0, j5: 0, j6: 0, x: 110, y: 10, z: 55, a: 0, b: 0, c: 0 },
          ],
        },
        {
          id: 2,
          name: "Robot A2",
          playbackState: { isPlaying: false, playing: false, isPaused: false, paused: false },
          recordedPoints: [],
        },
      ],
    }],
  };
  await writeFile(path.join(directory, "data", "settings.json"), `${JSON.stringify(settings)}\n`, "utf8");
}

async function main() {
  const temporaryDirectory = await mkdtemp(path.join(tmpdir(), "hydra-umc-server-playback-"));
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
        JWT_SECRET: "local-playback-contract-verification-only-not-for-deployment",
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

    // A robot with NO recorded points must not get stuck "playing" forever.
    const emptyPlay = await request(port, "/api/robot/2/command", {
      method: "POST", headers: authorization, body: JSON.stringify({ command: "play" }),
    });
    assert.equal(emptyPlay.response.status, 200);
    await waitUntil(
      async () => {
        const s = await request(port, "/api/settings");
        return findRobot(s.body, 2).playbackState.isPlaying === false;
      },
      { message: "robot 2 (no recorded points) must not stay in a playing state" },
    );

    // Real 'play' with real recorded points: the server itself must
    // physically move pos/joints through them, no browser client involved.
    // Only waits for SOME progress (activeStep >= 1) rather than assuming
    // exactly one tick fired by some fixed deadline - whichever point it
    // actually landed on, that point's own real values must be applied.
    const play = await request(port, "/api/robot/1/command", {
      method: "POST", headers: authorization, body: JSON.stringify({ command: "play" }),
    });
    assert.equal(play.response.status, 200);
    let robot = await waitUntil(
      async () => {
        const r = await currentRobot1();
        return r.playbackState.activeStep >= 1 ? r : null;
      },
      { message: "playback must apply at least the first recorded point" },
    );
    const expectedJ1 = robot.playbackState.activeStep === 1 ? 10 : 15;
    assert.equal(robot.joints.j1, expectedJ1, `applied point must match activeStep=${robot.playbackState.activeStep}`);
    if (robot.playbackState.activeStep === 1) assert.equal(robot.pos.x, 100, "applied point's own real pos must be set too");

    // Pause must actually halt advancement, not just flip a UI flag - not
    // "no MORE ticks ever fire" (they do, harmlessly, every intervalMs
    // regardless - see startServerPlayback's own comment) but that
    // activeStep/joints genuinely stop changing once paused.
    const pause = await request(port, "/api/robot/1/command", {
      method: "POST", headers: authorization, body: JSON.stringify({ command: "pause", params: { paused: true } }),
    });
    assert.equal(pause.response.status, 200);
    const pausedAt = await staysStable(
      async () => {
        const r = await currentRobot1();
        return { activeStep: r.playbackState.activeStep, j1: r.joints.j1 };
      },
      { message: "paused playback's activeStep/joints" },
    );

    // Resuming must continue from where it left off.
    const resume = await request(port, "/api/robot/1/command", {
      method: "POST", headers: authorization, body: JSON.stringify({ command: "pause", params: { paused: false } }),
    });
    assert.equal(resume.response.status, 200);
    await waitUntil(
      async () => {
        const r = await currentRobot1();
        return r.joints.j1 !== pausedAt.j1 || r.playbackState.isFinished;
      },
      { message: "resumed playback must eventually move past the point it was paused on" },
    );

    // Reaching the end must set isFinished and stop advancing.
    await waitUntil(
      async () => {
        const r = await currentRobot1();
        return r.playbackState.isFinished === true;
      },
      { message: "playback must reach the end and set isFinished, same as a browser client's own natural completion" },
    );
    robot = await currentRobot1();
    assert.equal(robot.playbackState.isPlaying, false, "playback must stop itself once every recorded point is applied");
    assert.equal(robot.joints.j1, 15, "the final applied point must be the last recorded point");

    // 'stop' must halt an in-progress playback for good.
    await request(port, "/api/robot/1/command", { method: "POST", headers: authorization, body: JSON.stringify({ command: "play" }) });
    await waitUntil(
      async () => {
        const r = await currentRobot1();
        return r.playbackState.activeStep >= 1;
      },
      { message: "playback must resume progressing after a fresh 'play'" },
    );
    await request(port, "/api/robot/1/command", { method: "POST", headers: authorization, body: JSON.stringify({ command: "stop" }) });
    await waitUntil(
      async () => {
        const r = await currentRobot1();
        return r.playbackState.isPlaying === false && r.playbackState.activeStep === -1;
      },
      { message: "stop must leave playback stopped with activeStep reset" },
    );
    await staysStable(
      async () => {
        const r = await currentRobot1();
        return { isPlaying: r.playbackState.isPlaying, j1: r.joints.j1 };
      },
      { message: "stopped playback's state" },
    );

    console.log("SERVER_PLAYBACK_CONTRACT=PASS empty=1 play=1 pause=1 resume=1 finish=1 stop=1");
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
  console.error("SERVER_PLAYBACK_CONTRACT=FAIL", error instanceof Error ? error.stack : error);
  process.exitCode = 1;
});
