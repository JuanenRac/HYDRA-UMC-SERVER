// =============================================================================
// HYDRA-UMC-SERVER - GET /api/system/supervisor real live-probe verification
// Copyright (C) 2026 JuanenRac (Electro Hobby 3D) <electrohobby3d@gmail.com>
// GPL-3.0 - see LICENSE
// =============================================================================
// Found while auditing the code: this endpoint (powers STUDIO/SUITE's own
// Supervisor panel) had zero test coverage of any kind before this file -
// not even a smoke test that it returns 200. Starts a real Server instance
// and hits the real endpoint over real HTTP, checking the full response
// shape survives on any host (this dev machine included, which has none of
// the Linux-only sysfs paths this endpoint reads) without ever crashing or
// silently dropping a field. Also covers the per-interface traffic counters
// added alongside the STUDIO/SUITE data-flow supervisor feature: wifi/
// ethernet/bluetooth must each be null or a real {rxBytes, txBytes} pair,
// never a fabricated number and never a missing key.

import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdir, mkdtemp, copyFile, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TSX_CLI = path.join(ROOT, "node_modules", "tsx", "dist", "cli.mjs");
const SERVER_SOURCE = path.join(ROOT, "src", "server.ts");

async function reservePort() {
  const listener = createServer();
  listener.listen(0, "127.0.0.1");
  await once(listener, "listening");
  const address = listener.address();
  assert(address && typeof address === "object");
  const { port } = address;
  listener.close();
  await once(listener, "close");
  return port;
}

async function fetchSupervisor(port) {
  let lastError;
  for (let attempt = 0; attempt < 120; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/system/supervisor`);
      if (response.ok) return response.json();
      lastError = new Error(`HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`supervisor endpoint did not become ready: ${lastError}`);
}

function assertRealOrNullTraffic(value, label) {
  if (value === null) return; // honest absence - this host has no such interface
  assert.equal(typeof value, "object", `${label} must be null or an object, got ${typeof value}`);
  assert.ok(Number.isFinite(value.rxBytes) && value.rxBytes >= 0, `${label}.rxBytes must be a real non-negative number`);
  assert.ok(Number.isFinite(value.txBytes) && value.txBytes >= 0, `${label}.txBytes must be a real non-negative number`);
}

async function main() {
  const temporaryDirectory = await mkdtemp(path.join(tmpdir(), "hydra-umc-server-supervisor-"));
  const port = await reservePort();
  let child;
  let logs = "";
  try {
    await mkdir(temporaryDirectory, { recursive: true });
    await copyFile(path.join(ROOT, "package.json"), path.join(temporaryDirectory, "package.json"));
    child = spawn(process.execPath, [TSX_CLI, SERVER_SOURCE], {
      cwd: temporaryDirectory,
      env: { ...process.env, PORT: String(port), NODE_ENV: "test", JWT_SECRET: "local-supervisor-contract-verification-only-not-for-deployment" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.on("data", (chunk) => { logs += chunk; });
    child.stderr.on("data", (chunk) => { logs += chunk; });

    let payload;
    try {
      payload = await fetchSupervisor(port);
    } catch (error) {
      throw new Error(`${error instanceof Error ? error.message : error}\nServer startup output:\n${logs || "<no output>"}`);
    }

    assert.ok(Number.isFinite(payload.timestamp), "timestamp must be a real number");
    assert.ok(Number.isFinite(payload.cpu?.coreCount) && payload.cpu.coreCount > 0, "cpu.coreCount must be real and positive on any host");
    assert.ok(Array.isArray(payload.cpu?.perCorePercent), "perCorePercent must always be an array, even when values inside are 0");
    assert.ok(Number.isFinite(payload.uptimeSeconds) && payload.uptimeSeconds >= 0, "uptimeSeconds must be real and non-negative");

    const network = payload.network;
    assert.ok(network && typeof network === "object", "network must always be present");
    assert.ok("wifi" in network && "ethernet" in network && "bluetooth" in network, "wifi/ethernet/bluetooth presence keys must always be present");
    assert.ok(network.traffic && typeof network.traffic === "object", "network.traffic must always be present");
    assert.ok(
      "wifi" in network.traffic && "ethernet" in network.traffic && "bluetooth" in network.traffic,
      "network.traffic must always carry all 3 interface keys, real or null",
    );
    assertRealOrNullTraffic(network.traffic.wifi, "network.traffic.wifi");
    assertRealOrNullTraffic(network.traffic.ethernet, "network.traffic.ethernet");
    // Bluetooth has no standard sysfs byte-counter equivalent (see
    // readNetworkTraffic()'s own comment) - always null today, on every
    // host, real Linux CM5 included. Asserted as an explicit fact (not
    // merely "null or object" like the other two) so a future real
    // implementation updates this test deliberately instead of it staying
    // silently stale.
    assert.equal(network.traffic.bluetooth, null, "bluetooth traffic has no real source yet and must stay honestly null, never fabricated");

    console.log(`SERVER_SUPERVISOR_CONTRACT=PASS cores=${payload.cpu.coreCount} wifi_traffic=${network.traffic.wifi === null ? "absent" : "present"} ethernet_traffic=${network.traffic.ethernet === null ? "absent" : "present"}`);
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
  console.error("SERVER_SUPERVISOR_CONTRACT=FAIL", error instanceof Error ? error.stack : error);
  process.exitCode = 1;
});
