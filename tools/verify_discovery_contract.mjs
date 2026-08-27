// =============================================================================
// HYDRA-UMC-SERVER - Local ServerDiscovery SDK contract verification
// Copyright (C) 2026 JuanenRac (Electro Hobby 3D) <electrohobby3d@gmail.com>
// GPL-3.0 - see LICENSE
// =============================================================================
// Starts Server in an isolated temporary working directory, reads its real
// discovery endpoint, then validates the payload with the sibling SDK client.

import assert from "node:assert/strict";
import { once } from "node:events";
import { copyFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// A developer checkout normally keeps the SDK beside this repository. CI
// checks out the pinned contract client within this repository's workspace and
// supplies its location explicitly, so the integration check never assumes
// that a sibling repository happens to exist on a clean runner.
const SDK_ROOT = process.env.HYDRA_UMC_SDK_ROOT
  ? path.resolve(process.env.HYDRA_UMC_SDK_ROOT)
  : path.resolve(ROOT, "..", "HYDRA-UMC-SDK");
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

async function fetchDiscovery(port) {
  let lastError;
  // Server loads its real state, authentication and mDNS modules.  On a cold
  // Windows dependency tree that can take longer than the previous six-second
  // window, even though the process is healthy.  Keep this bounded and local.
  for (let attempt = 0; attempt < 120; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/hydra-info`);
      if (response.ok) return response.json();
      lastError = new Error(`HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`discovery endpoint did not become ready: ${lastError}`);
}

async function validateWithSdk(payload, temporaryDirectory) {
  const sdkSource = path.join(SDK_ROOT, "clients", "python", "src");
  const payloadPath = path.join(temporaryDirectory, "server-discovery.json");
  await writeFile(payloadPath, `${JSON.stringify(payload)}\n`, "utf8");
  const command = [
    "from hydra_umc_sdk.validation import validate; import json, pathlib; ",
    `validate('ServerDiscovery', json.loads(pathlib.Path(r'${payloadPath}').read_text(encoding='utf-8'))); `,
    "print('SDK_SERVER_CONTRACT=PASS')",
  ].join("");
  const child = spawn(process.platform === "win32" ? "python" : "python3", ["-c", command], {
    env: { ...process.env, PYTHONPATH: sdkSource },
    stdio: "inherit",
  });
  const [code] = await once(child, "exit");
  assert.equal(code, 0, "SDK rejected the real ServerDiscovery response");
}

async function main() {
  const temporaryDirectory = await mkdtemp(path.join(tmpdir(), "hydra-umc-server-discovery-"));
  const port = await reservePort();
  let child;
  let logs = "";
  try {
    await copyFile(path.join(ROOT, "package.json"), path.join(temporaryDirectory, "package.json"));
    child = spawn(process.execPath, [TSX_CLI, SERVER_SOURCE], {
      cwd: temporaryDirectory,
      env: {
        ...process.env,
        PORT: String(port),
        NODE_ENV: "test",
        JWT_SECRET: "local-contract-verification-only-not-for-deployment",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.on("data", (chunk) => { logs += chunk; });
    child.stderr.on("data", (chunk) => { logs += chunk; });
    let payload;
    try {
      payload = await fetchDiscovery(port);
    } catch (error) {
      throw new Error(`${error instanceof Error ? error.message : error}\nServer startup output:\n${logs || "<no output>"}`);
    }
    assert.equal(payload.schema_version, "1.0");
    assert.equal(typeof payload.product, "string");
    assert.equal(typeof payload.remoteApiVersion, "number");
    assert.equal(typeof payload.appVersion, "string");
    assert.equal(typeof payload.hostname, "string");
    for (const field of ["controllerCount", "robotCount", "uptimeSeconds"]) {
      assert(Number.isInteger(payload[field]) && payload[field] >= 0, `${field} must be a non-negative integer`);
    }
    await validateWithSdk(payload, temporaryDirectory);
    console.log(`SERVER_DISCOVERY_CONTRACT=PASS schema=${payload.schema_version} remoteApiVersion=${payload.remoteApiVersion}`);
  } finally {
    if (child && child.exitCode === null) {
      child.kill("SIGTERM");
      await Promise.race([once(child, "exit"), new Promise((resolve) => setTimeout(resolve, 3000))]);
      if (child.exitCode === null) child.kill("SIGKILL");
    }
    // Windows can keep a handle briefly after tsx/server exits.  Retrying
    // cleanup prevents a correct contract run from being reported as failed.
    await rm(temporaryDirectory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
}

main().catch((error) => {
  console.error("SERVER_DISCOVERY_CONTRACT=FAIL", error instanceof Error ? error.stack : error);
  process.exitCode = 1;
});
