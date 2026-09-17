// =============================================================================
// HYDRA-UMC-SERVER - POST /api/system/bluetooth/* contract checks
// Copyright (C) 2026 JuanenRac (Electro Hobby 3D) <electrohobby3d@gmail.com>
// GPL-3.0 - see LICENSE
// =============================================================================
// Starts a real Server instance and hits the real Bluetooth endpoints over
// real HTTP - auth/admin gating and MAC validation are asserted for real.
// The underlying `bluetoothctl` call itself is NOT mocked: on a machine
// without a real Bluetooth adapter/daemon (this repo's own test/CI
// environment, Windows dev included), GET /status must answer a clean,
// honest available:false/503 - never a crash, a hang, or a silent lie that
// a real adapter exists. On a real CM5 with BlueZ running, the same
// request would return available:true - this test only asserts ONE of
// those two honest outcomes, not which one this particular machine gives
// (same philosophy as verify_ecosystem_service_control_contract.mjs).

import assert from "node:assert/strict";
import { once } from "node:events";
import { rm, mkdtemp, copyFile, mkdir } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TSX_CLI = path.join(ROOT, "node_modules", "tsx", "dist", "cli.mjs");
const SERVER_SOURCE = path.join(ROOT, "src", "server.ts");
const ADMIN = { username: "bluetooth-contract-admin", password: "bluetooth-contract-admin-password" };

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

async function main() {
  const workspace = await mkdtemp(path.join(tmpdir(), "hydra-umc-server-bluetooth-"));
  const serverCwd = path.join(workspace, "HYDRA-UMC-SERVER-under-test");

  let child;
  let logs = "";
  const serverPort = await reservePort();
  try {
    await mkdir(serverCwd, { recursive: true });
    await copyFile(path.join(ROOT, "package.json"), path.join(serverCwd, "package.json"));
    child = spawn(process.execPath, [TSX_CLI, SERVER_SOURCE], {
      cwd: serverCwd,
      env: {
        ...process.env,
        PORT: String(serverPort),
        NODE_ENV: "test",
        JWT_SECRET: "local-bluetooth-contract-verification-only-not-for-deployment",
        HYDRA_UMC_BOOTSTRAP_ADMIN_USERNAME: ADMIN.username,
        HYDRA_UMC_BOOTSTRAP_ADMIN_PASSWORD: ADMIN.password,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.on("data", (chunk) => { logs += chunk; });
    child.stderr.on("data", (chunk) => { logs += chunk; });
    try {
      await waitForServer(serverPort);
    } catch (error) {
      throw new Error(`${error instanceof Error ? error.message : error}\nServer startup output:\n${logs || "<no output>"}`);
    }

    // Unauthenticated: refused before any Bluetooth call is ever attempted.
    const anonStatus = await request(serverPort, "/api/system/bluetooth/status");
    assert.equal(anonStatus.response.status, 401, "an unauthenticated status request must be refused");
    const anonScan = await request(serverPort, "/api/system/bluetooth/scan", { method: "POST" });
    assert.equal(anonScan.response.status, 401, "an unauthenticated scan request must be refused");

    const login = await request(serverPort, "/api/login", { method: "POST", body: JSON.stringify(ADMIN) });
    assert.equal(login.response.status, 200);
    const authorization = { authorization: `Bearer ${login.body.token}` };

    // A malformed MAC must be rejected before any real bluetoothctl call.
    const badMac = await request(serverPort, "/api/system/bluetooth/pair", {
      method: "POST", headers: authorization, body: JSON.stringify({ mac: "not-a-real-mac" }),
    });
    assert.equal(badMac.response.status, 400, "a malformed MAC must be rejected");

    const badMacRemove = await request(serverPort, "/api/system/bluetooth/remove", {
      method: "POST", headers: authorization, body: JSON.stringify({ mac: "AA:BB" }),
    });
    assert.equal(badMacRemove.response.status, 400, "a malformed MAC must be rejected on remove too");

    // A missing/non-boolean `on` must be rejected before any real power call.
    const badPower = await request(serverPort, "/api/system/bluetooth/power", {
      method: "POST", headers: authorization, body: JSON.stringify({ on: "yes" }),
    });
    assert.equal(badPower.response.status, 400, "a non-boolean `on` must be rejected");

    // The real status call: either a real adapter answered (available:true,
    // a real devices array) or bluetoothctl itself is unavailable on this
    // machine (available:false, 503) - both are honest, neither is a crash.
    const status = await request(serverPort, "/api/system/bluetooth/status", { headers: authorization });
    if (status.response.status === 200) {
      assert.equal(status.body.available, true);
      assert.equal(typeof status.body.powered, "boolean");
      assert.ok(Array.isArray(status.body.devices));
    } else {
      assert.equal(status.response.status, 503, `status must be 200 or 503, got ${status.response.status}`);
      assert.equal(status.body.available, false);
    }

    // A well-formed but real-world-nonexistent MAC must fail honestly
    // (bluetoothctl itself refuses/errors on an unseen device) rather than
    // ever reporting a fabricated success.
    const fakeMac = "AA:BB:CC:DD:EE:FF";
    const pairUnseen = await request(serverPort, "/api/system/bluetooth/pair", {
      method: "POST", headers: authorization, body: JSON.stringify({ mac: fakeMac }),
    });
    assert.equal(pairUnseen.response.status, 503, "pairing a MAC that was never scanned must fail honestly, not silently succeed");

    console.log(
      `SERVER_BLUETOOTH_CONTRACT=PASS anon=1 bad_mac=1 bad_power=1 status_code=${status.response.status} pair_unseen=1`,
    );
  } finally {
    if (child && child.exitCode === null) {
      child.kill("SIGTERM");
      await Promise.race([once(child, "exit"), new Promise((resolve) => setTimeout(resolve, 3000))]);
      if (child.exitCode === null) child.kill("SIGKILL");
    }
    await rm(workspace, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
}

main().catch((error) => {
  console.error("SERVER_BLUETOOTH_CONTRACT=FAIL", error instanceof Error ? error.stack : error);
  process.exitCode = 1;
});
