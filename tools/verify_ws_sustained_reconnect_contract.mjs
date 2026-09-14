// =============================================================================
// HYDRA-UMC-SERVER - Sustained WebSocket reconnect coverage (T04/A.5)
// Copyright (C) 2026 JuanenRac (Electro Hobby 3D) <electrohobby3d@gmail.com>
// GPL-3.0 - see LICENSE
// =============================================================================
// Real long-session coverage this repo never had: every other WS-related
// test here (verify_canota_relay_contract.mjs, verify_refresh_token_contract.mjs)
// opens at most one or two real connections. This opens and cleanly closes
// 50 real WebSocket connections in a row against one real, running server
// and, after every single cycle, scrapes the real GET /metrics gauge
// (hydra_ws_clients_connected, backed by wsClients.size - see server.ts's
// own on("close")/on("error") handlers) to prove it returns to exactly 0
// each time. A leak in any of the 4 real wsClients.delete() call sites
// would show up here as a gauge that never comes back down, not just once
// but growing across the whole run - the exact "long session, not just
// one connect/disconnect" gap T04/A.5 asked for.

import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import WebSocket from "ws";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TSX_CLI = path.join(ROOT, "node_modules", "tsx", "dist", "cli.mjs");
const SERVER_SOURCE = path.join(ROOT, "src", "server.ts");
const ADMIN = { username: "ws-reconnect-contract-admin", password: "ws-reconnect-contract-admin-password" };
const CYCLES = 50;

async function waitUntil(fn, { timeoutMs = 15000, intervalMs = 100, message = "condition" } = {}) {
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

async function readConnectedGauge(port) {
  const text = await fetch(`http://127.0.0.1:${port}/metrics`).then((r) => r.text());
  const line = text.split("\n").find((l) => l.startsWith("hydra_ws_clients_connected "));
  assert.ok(line, "hydra_ws_clients_connected gauge missing from /metrics output");
  return Number(line.split(" ")[1]);
}

async function main() {
  const temporaryDirectory = await mkdtemp(path.join(tmpdir(), "hydra-umc-server-ws-reconnect-"));
  const port = await reservePort();
  let child;
  let logs = "";
  try {
    await mkdir(path.join(temporaryDirectory, "data"), { recursive: true });
    child = spawn(process.execPath, [TSX_CLI, SERVER_SOURCE], {
      cwd: temporaryDirectory,
      env: {
        ...process.env,
        PORT: String(port),
        NODE_ENV: "test",
        JWT_SECRET: "local-ws-reconnect-contract-verification-only-not-for-deployment",
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

    const login = await fetch(`http://127.0.0.1:${port}/api/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(ADMIN),
    }).then((r) => r.json());
    assert.equal(typeof login.token, "string", "login must succeed before this can open any real WS connection");

    // Baseline: no client connected yet.
    assert.equal(await readConnectedGauge(port), 0, "gauge must start at 0 before any real connection");

    const peakDuringCycles = [];
    for (let cycle = 0; cycle < CYCLES; cycle++) {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${login.token}`);
      await once(ws, "open");
      peakDuringCycles.push(await readConnectedGauge(port));
      ws.close();
      await once(ws, "close");
      // The close handshake and this process's own wsClients.delete()
      // both run on the same event loop tick the "close" event fires on,
      // but the /metrics scrape is a separate real HTTP round trip - a
      // short, bounded wait tolerates ordinary scheduling jitter without
      // ever masking a real, sustained leak (which would show up as a
      // number that keeps climbing across cycles, not one that's merely
      // slow to reach 0 once).
      await waitUntil(async () => (await readConnectedGauge(port)) === 0, {
        timeoutMs: 2000,
        message: `hydra_ws_clients_connected to return to 0 after cycle ${cycle}`,
      });
    }

    assert.ok(
      peakDuringCycles.every((value) => value === 1),
      `every cycle's own connected client must be the ONLY one the gauge ever counted at once: ${JSON.stringify(peakDuringCycles)}`,
    );

    // The server itself must still be genuinely healthy after 50 real
    // connect/disconnect cycles - proves this exercise didn't destabilize
    // the process, not just the one metric under direct test.
    const stillHealthy = await fetch(`http://127.0.0.1:${port}/api/hydra-info`);
    assert.equal(stillHealthy.status, 200, "the server must still be healthy after sustained WS churn");

    console.log(
      `SERVER_WS_SUSTAINED_RECONNECT_CONTRACT=PASS cycles=${CYCLES} gauge_returned_to_zero_every_cycle=1 never_double_counted=1 server_still_healthy=1`,
    );
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
