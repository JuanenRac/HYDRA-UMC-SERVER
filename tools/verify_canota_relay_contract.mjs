// =============================================================================
// HYDRA-UMC-SERVER - GET/POST /api/hardware/canota/* real relay verification
// Copyright (C) 2026 JuanenRac (Electro Hobby 3D) <electrohobby3d@gmail.com>
// GPL-3.0 - see LICENSE
// =============================================================================
// Starts a real Server instance plus a real, minimal HTTP stub standing in
// for HYDRA-UMC/src/cm5_host/spi_bridge's own local service (same "real
// socket, no mocked client" standard as this project's other
// verify_*_contract.mjs scripts). Proves: the route is unavailable (503,
// not a crash) when HYDRA_UMC_SPI_BRIDGE_URL is unset; the version relay
// genuinely forwards tier/slot and the stub's real response; the flash
// relay is admin-only (unlike the read-only version query); a real
// firmware body is forwarded byte-for-byte to the stub; and real
// newline-delimited progress from the stub is broadcast to a real
// connected WebSocket client as `type: "canota_progress"` messages, not
// just returned in the HTTP response.

import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import WebSocket from "ws";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TSX_CLI = path.join(ROOT, "node_modules", "tsx", "dist", "cli.mjs");
const SERVER_SOURCE = path.join(ROOT, "src", "server.ts");
const ADMIN = { username: "canota-contract-admin", password: "canota-contract-admin-password" };
const OPERATOR = { username: "canota-contract-operator", password: "canota-contract-operator-password" };

async function reservePort() {
  const listener = createServer();
  listener.listen(0, "127.0.0.1");
  await once(listener, "listening");
  const { port } = listener.address();
  listener.close();
  await once(listener, "close");
  return port;
}

async function waitFor(url, startupError = () => undefined) {
  let lastError;
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const processError = startupError();
    if (processError) throw new Error(`service process could not start: ${processError.message}`);
    try {
      const response = await fetch(url);
      if (response.ok) return;
      lastError = new Error(`HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error(`service did not become ready: ${lastError}`);
}

// A real, tiny stand-in for spi_bridge's own /version and /flash - echoes
// back what it actually received (query params, real firmware bytes) so
// the test can prove the relay forwarded them, and streams real
// newline-delimited progress for /flash.
function startSpiBridgeStub() {
  const seenRequests = [];
  let lastFirmwareBytes = null;
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    seenRequests.push(`${url.pathname}${url.search}`);
    if (url.pathname === "/version") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ online: true, is_bootloader: false, hardware_id: 0x48374334, firmware_major: 0, firmware_minor: 1 }));
      return;
    }
    if (url.pathname === "/flash" && req.method === "POST") {
      const chunks = [];
      req.on("data", (chunk) => chunks.push(chunk));
      req.on("end", () => {
        lastFirmwareBytes = Buffer.concat(chunks);
        res.writeHead(200, { "content-type": "application/x-ndjson" });
        res.write(JSON.stringify({ phase: "entering_bootloader", pages_sent: 0, pages_total: 1, percent: 0, error: null }) + "\n");
        res.write(JSON.stringify({ phase: "transferring", pages_sent: 1, pages_total: 1, percent: 85, error: null }) + "\n");
        res.write(JSON.stringify({ phase: "done", pages_sent: 1, pages_total: 1, percent: 100, error: null }) + "\n");
        res.end();
      });
      return;
    }
    res.writeHead(404).end();
  });
  return { server, seenRequests, getLastFirmwareBytes: () => lastFirmwareBytes };
}

async function main() {
  const workspaceNoBridge = await mkdtemp(path.join(tmpdir(), "hydra-umc-server-canota-relay-nobridge-"));
  const workspaceWithBridge = await mkdtemp(path.join(tmpdir(), "hydra-umc-server-canota-relay-bridge-"));
  const stub = startSpiBridgeStub();
  stub.server.listen(0, "127.0.0.1");
  await once(stub.server, "listening");
  const stubPort = stub.server.address().port;

  const serverPortNoBridge = await reservePort();
  const serverPortWithBridge = await reservePort();
  let childNoBridge;
  let childWithBridge;
  let ws;
  let logs = "";

  try {
    // First instance: HYDRA_UMC_SPI_BRIDGE_URL deliberately unset - proves
    // the route degrades to a clean 503, not a crash or a hang.
    let startupErrorNoBridge;
    childNoBridge = spawn(process.execPath, [TSX_CLI, SERVER_SOURCE], {
      cwd: workspaceNoBridge,
      env: {
        ...process.env,
        PORT: String(serverPortNoBridge),
        NODE_ENV: "test",
        JWT_SECRET: "canota-contract-no-bridge-secret-not-for-deployment",
        HYDRA_UMC_BOOTSTRAP_ADMIN_USERNAME: ADMIN.username,
        HYDRA_UMC_BOOTSTRAP_ADMIN_PASSWORD: ADMIN.password,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    childNoBridge.once("error", (error) => { startupErrorNoBridge = error; });
    childNoBridge.stdout.on("data", (chunk) => { logs += chunk; });
    childNoBridge.stderr.on("data", (chunk) => { logs += chunk; });
    await waitFor(`http://127.0.0.1:${serverPortNoBridge}/api/hydra-info`, () => startupErrorNoBridge);

    const loginNoBridge = await fetch(`http://127.0.0.1:${serverPortNoBridge}/api/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(ADMIN),
    }).then((r) => r.json());
    const unconfigured = await fetch(`http://127.0.0.1:${serverPortNoBridge}/api/hardware/canota/version`, {
      headers: { authorization: `Bearer ${loginNoBridge.token}` },
    });
    assert.equal(unconfigured.status, 503);
    const unconfiguredBody = await unconfigured.json();
    assert.equal(unconfiguredBody.available, false);

    childNoBridge.kill("SIGTERM");
    await Promise.race([once(childNoBridge, "exit"), new Promise((resolve) => setTimeout(resolve, 3000))]);
    if (childNoBridge.exitCode === null) childNoBridge.kill("SIGKILL");

    // Second instance: HYDRA_UMC_SPI_BRIDGE_URL points at the real stub.
    let startupErrorWithBridge;
    childWithBridge = spawn(process.execPath, [TSX_CLI, SERVER_SOURCE], {
      cwd: workspaceWithBridge,
      env: {
        ...process.env,
        PORT: String(serverPortWithBridge),
        NODE_ENV: "test",
        JWT_SECRET: "canota-contract-with-bridge-secret-not-for-deployment",
        HYDRA_UMC_BOOTSTRAP_ADMIN_USERNAME: ADMIN.username,
        HYDRA_UMC_BOOTSTRAP_ADMIN_PASSWORD: ADMIN.password,
        HYDRA_UMC_SPI_BRIDGE_URL: `http://127.0.0.1:${stubPort}`,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    childWithBridge.once("error", (error) => { startupErrorWithBridge = error; });
    childWithBridge.stdout.on("data", (chunk) => { logs += chunk; });
    childWithBridge.stderr.on("data", (chunk) => { logs += chunk; });
    await waitFor(`http://127.0.0.1:${serverPortWithBridge}/api/hydra-info`, () => startupErrorWithBridge);

    // Anonymous request must be rejected before ever reaching the stub.
    const anonymous = await fetch(`http://127.0.0.1:${serverPortWithBridge}/api/hardware/canota/version`);
    assert.equal(anonymous.status, 401);

    const adminLogin = await fetch(`http://127.0.0.1:${serverPortWithBridge}/api/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(ADMIN),
    }).then((r) => r.json());
    const adminAuth = { authorization: `Bearer ${adminLogin.token}` };

    const versionResponse = await fetch(
      `http://127.0.0.1:${serverPortWithBridge}/api/hardware/canota/version?tier=2&slot=3`,
      { headers: adminAuth },
    );
    assert.equal(versionResponse.status, 200);
    const versionBody = await versionResponse.json();
    assert.equal(versionBody.hardware_id, 0x48374334);
    assert(stub.seenRequests.some((r) => r.startsWith("/version?") && r.includes("tier=2") && r.includes("slot=3")),
      `proxy did not forward the real tier/slot params, saw: ${JSON.stringify(stub.seenRequests)}`);

    // relay=1 (Tier 2, tunneled through Tier 1 - spi_bridge's own
    // relay_tunnel.py) must also be forwarded, not just tier/slot.
    const relayVersionResponse = await fetch(
      `http://127.0.0.1:${serverPortWithBridge}/api/hardware/canota/version?tier=2&slot=3&relay=1`,
      { headers: adminAuth },
    );
    assert.equal(relayVersionResponse.status, 200);
    assert(stub.seenRequests.some((r) => r.startsWith("/version?") && r.includes("relay=1")),
      `proxy did not forward the real relay param, saw: ${JSON.stringify(stub.seenRequests)}`);

    // A real non-admin user must be denied /flash - the same admin gate
    // every other real write route in this Server already enforces.
    const createOperator = await fetch(`http://127.0.0.1:${serverPortWithBridge}/api/users`, {
      method: "POST",
      headers: { "content-type": "application/json", ...adminAuth },
      body: JSON.stringify({ ...OPERATOR, role: "operator" }),
    });
    assert.equal(createOperator.status, 200, `operator creation failed: ${JSON.stringify(await createOperator.json())}`);
    const operatorLogin = await fetch(`http://127.0.0.1:${serverPortWithBridge}/api/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(OPERATOR),
    }).then((r) => r.json());
    const deniedFlash = await fetch(`http://127.0.0.1:${serverPortWithBridge}/api/hardware/canota/flash`, {
      method: "POST",
      headers: { "content-type": "application/octet-stream", authorization: `Bearer ${operatorLogin.token}` },
      body: Buffer.from([1, 2, 3, 4]),
    });
    assert.equal(deniedFlash.status, 403);
    assert.match((await deniedFlash.json()).error, /admin privileges required/);

    // A real connected WS client must receive the real streamed progress
    // as it happens - not just whatever the final HTTP response says.
    ws = new WebSocket(`ws://127.0.0.1:${serverPortWithBridge}/ws?token=${adminLogin.token}`);
    await once(ws, "open");
    const canotaMessages = [];
    ws.on("message", (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.type === "canota_progress") canotaMessages.push(msg.payload);
    });

    const realFirmwareBytes = Buffer.from("hydra-umc-real-firmware-fixture-bytes");
    const flashResponse = await fetch(
      `http://127.0.0.1:${serverPortWithBridge}/api/hardware/canota/flash?tier=2&slot=3&hardware_id=0x48374334&version_major=0&version_minor=1`,
      {
        method: "POST",
        headers: { "content-type": "application/octet-stream", ...adminAuth },
        body: realFirmwareBytes,
      },
    );
    assert.equal(flashResponse.status, 200);
    const flashBody = await flashResponse.json();
    assert.equal(flashBody.success, true);
    assert.equal(flashBody.finalPhase, "done");
    assert.deepEqual(stub.getLastFirmwareBytes(), realFirmwareBytes,
      "the real firmware bytes were not forwarded byte-for-byte to spi_bridge");

    // Give the WS message loop a moment to drain (broadcast happens
    // synchronously per line, but the client-side message handler is
    // still async).
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(canotaMessages.length, 3, `expected 3 real progress messages over WS, got: ${JSON.stringify(canotaMessages)}`);
    assert.equal(canotaMessages[canotaMessages.length - 1].phase, "done");

    console.log("SERVER_CANOTA_RELAY_CONTRACT=PASS unconfigured=1 auth=1 admin_gate=1 version=1 flash=1 ws_progress=1");
  } catch (error) {
    throw new Error(`${error instanceof Error ? error.message : error}\nServer startup output:\n${logs || "<no output>"}`);
  } finally {
    if (ws) ws.close();
    stub.server.close();
    for (const child of [childNoBridge, childWithBridge]) {
      if (child && child.exitCode === null) {
        child.kill("SIGTERM");
        await Promise.race([once(child, "exit"), new Promise((resolve) => setTimeout(resolve, 3000))]);
        if (child.exitCode === null) child.kill("SIGKILL");
      }
    }
    await Promise.all([workspaceNoBridge, workspaceWithBridge].map((dir) =>
      rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })));
  }
}

main().catch((error) => {
  console.error("SERVER_CANOTA_RELAY_CONTRACT=FAIL", error instanceof Error ? error.stack : error);
  process.exitCode = 1;
});
