// =============================================================================
// HYDRA-UMC-SERVER - Telemetry producer contract checks
// Copyright (C) 2026 JuanenRac (Electro Hobby 3D) <electrohobby3d@gmail.com>
// GPL-3.0 - see LICENSE
// =============================================================================
// Starts the real Server with HYDRA_UMC_TELEMETRY_COLLECTOR_URL pointing at a small HTTP stand-in for the telemetry collector, sends a
// real jog command and proves that the numbers of the delta reach the collector as one `robot_state` sample with the bearer token the
// collector asks for - and that a Server with no collector configured sends nothing and behaves as before. No hardware is touched.

import assert from "node:assert/strict";
import { once } from "node:events";
import http from "node:http";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TSX_CLI = path.join(ROOT, "node_modules", "tsx", "dist", "cli.mjs");
const SERVER_SOURCE = path.join(ROOT, "src", "server.ts");
const ADMIN = { username: "telemetry-contract-admin", password: "telemetry-contract-admin-password" };
const COLLECTOR_TOKEN = "telemetry-collector-token-for-the-contract";

async function reservePort() {
  const listener = createServer();
  listener.listen(0, "127.0.0.1");
  await once(listener, "listening");
  const { port } = listener.address();
  listener.close();
  await once(listener, "close");
  return port;
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
    settings: { serverName: "HYDRA-UMC telemetry contract" },
    controllers: [{
      id: "contract-controller",
      name: "Contract Controller",
      cameras: [],
      robots: [{
        id: 1,
        name: "Robot A1",
        model: "Parol6 (6-DOF)",
        playbackState: { isPlaying: false, playing: false, isPaused: false, paused: false },
        pos: { x: 0, y: 0, z: 0, a: 0, b: 0, c: 0 },
        joints: { j1: 0, j2: 0, j3: 0, j4: 0, j5: 0, j6: 0 },
      }],
    }],
  };
  await writeFile(path.join(directory, "data", "settings.json"), `${JSON.stringify(settings)}\n`, "utf8");
}

function startCollector() {
  const received = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const authorized = req.headers.authorization === `Bearer ${COLLECTOR_TOKEN}`;
      if (req.url !== "/ingest/ws" || req.method !== "POST" || !authorized) {
        res.writeHead(authorized ? 404 : 401, { "content-type": "application/json" });
        res.end("{}");
        return;
      }
      received.push(JSON.parse(Buffer.concat(chunks).toString("utf-8")));
      res.writeHead(202, { "content-type": "application/json" });
      res.end('{"status":"buffered"}');
    });
  });
  return { server, received };
}

async function startHydra(directory, port, extraEnv) {
  const child = spawn(process.execPath, [TSX_CLI, SERVER_SOURCE], {
    cwd: directory,
    env: {
      ...process.env,
      PORT: String(port),
      NODE_ENV: "test",
      JWT_SECRET: "telemetry-producer-contract-secret-not-for-deployment",
      HYDRA_UMC_BOOTSTRAP_ADMIN_USERNAME: ADMIN.username,
      HYDRA_UMC_BOOTSTRAP_ADMIN_PASSWORD: ADMIN.password,
      ...extraEnv,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let logs = "";
  child.stdout.on("data", (chunk) => { logs += chunk; });
  child.stderr.on("data", (chunk) => { logs += chunk; });
  try {
    await waitForServer(port);
  } catch (error) {
    throw new Error(`${error instanceof Error ? error.message : error}\nServer startup output:\n${logs || "<no output>"}`);
  }
  return child;
}

async function stop(child) {
  if (!child || child.exitCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([once(child, "exit"), new Promise((resolve) => setTimeout(resolve, 3000))]);
  if (child.exitCode === null) child.kill("SIGKILL");
}

async function jog(port, authorization, amount) {
  const answer = await request(port, "/api/robot/1/command", {
    method: "POST",
    headers: authorization,
    body: JSON.stringify({ command: "jog", params: { axis: "x", amount } }),
  });
  assert.equal(answer.response.status, 200, JSON.stringify(answer.body));
}

async function waitUntil(condition, what) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`timed out waiting for ${what}`);
}

async function main() {
  const directory = await mkdtemp(path.join(tmpdir(), "hydra-umc-server-telemetry-producer-"));
  const collector = startCollector();
  collector.server.listen(0, "127.0.0.1");
  await once(collector.server, "listening");
  const collectorPort = collector.server.address().port;
  let withProducer;
  let without;
  try {
    await writeFixture(directory);
    const port = await reservePort();
    withProducer = await startHydra(directory, port, {
      HYDRA_UMC_TELEMETRY_COLLECTOR_URL: `http://127.0.0.1:${collectorPort}`,
      HYDRA_UMC_TELEMETRY_COLLECTOR_TOKEN: COLLECTOR_TOKEN,
      HYDRA_UMC_TELEMETRY_INTERVAL_MS: "100",
    });
    const login = await request(port, "/api/login", { method: "POST", body: JSON.stringify(ADMIN) });
    assert.equal(login.response.status, 200);
    const authorization = { authorization: `Bearer ${login.body.token}` };

    await jog(port, authorization, 5);
    await waitUntil(() => collector.received.length >= 1, "the first sample");
    const first = collector.received[0];
    assert.equal(first.sourceId, "robot-contract-controller-1");
    assert.equal(first.kind, "robot_state");
    assert.equal(first.fields.pos_x, 5);
    assert.ok("joints_j1" in first.fields, "the joints of the delta are in the sample");
    assert.ok(Number.isSafeInteger(first.timestamp) && first.timestamp > 100_000_000_000);
    assert.equal(first.sequence, 1);

    await jog(port, authorization, 3);
    await waitUntil(() => collector.received.length >= 2, "the second sample");
    assert.equal(collector.received[1].fields.pos_x, 8);
    assert.equal(collector.received[1].sequence, 2);
    await stop(withProducer);
    withProducer = undefined;

    // no collector configured: the same server sends nothing and the command still works
    const before = collector.received.length;
    const portTwo = await reservePort();
    without = await startHydra(directory, portTwo, {});
    const loginTwo = await request(portTwo, "/api/login", { method: "POST", body: JSON.stringify(ADMIN) });
    await jog(portTwo, { authorization: `Bearer ${loginTwo.body.token}` }, 1);
    await new Promise((resolve) => setTimeout(resolve, 1500));
    assert.equal(collector.received.length, before, "without HYDRA_UMC_TELEMETRY_COLLECTOR_URL nothing is sent");

    console.log("SERVER_TELEMETRY_PRODUCER_CONTRACT=PASS samples=2 token=1 sequence=1 off_by_default=1");
  } finally {
    await stop(withProducer);
    await stop(without);
    collector.server.close();
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
}

main().catch((error) => {
  console.error("SERVER_TELEMETRY_PRODUCER_CONTRACT=FAIL", error instanceof Error ? error.stack : error);
  process.exitCode = 1;
});
