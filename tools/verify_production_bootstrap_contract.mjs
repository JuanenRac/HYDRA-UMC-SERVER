// =============================================================================
// HYDRA-UMC-SERVER - Production bootstrap security contract verification
// Copyright (C) 2026 JuanenRac (Electro Hobby 3D) <electrohobby3d@gmail.com>
// GPL-3.0 - see LICENSE
// =============================================================================
// Proves a first production start fails closed without a signing key or without
// locally supplied bootstrap credentials. The real server runs in a temporary
// directory, so no developer data/users.json is read or created.

import assert from "node:assert/strict";
import { once } from "node:events";
import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TSX_CLI = path.join(ROOT, "node_modules", "tsx", "dist", "cli.mjs");
const SERVER_SOURCE = path.join(ROOT, "src", "server.ts");

async function expectFailure(label, environment, expectedMessage) {
  const temporaryDirectory = await mkdtemp(path.join(tmpdir(), "hydra-umc-server-production-"));
  let child;
  let logs = "";
  try {
    await copyFile(path.join(ROOT, "package.json"), path.join(temporaryDirectory, "package.json"));
    child = spawn(process.execPath, [TSX_CLI, SERVER_SOURCE], {
      cwd: temporaryDirectory,
      env: { ...process.env, NODE_ENV: "production", PORT: "0", ...environment },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.on("data", (chunk) => { logs += chunk; });
    child.stderr.on("data", (chunk) => { logs += chunk; });
    await Promise.race([
      once(child, "exit"),
      new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} did not fail promptly`)), 5000)),
    ]);
    assert.notEqual(child.exitCode, 0, `${label} must fail closed`);
    assert.match(logs, expectedMessage, `${label} emitted an unexpected error: ${logs}`);
  } finally {
    if (child && child.exitCode === null) child.kill("SIGKILL");
    await rm(temporaryDirectory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
}

await expectFailure(
  "missing JWT_SECRET",
  {
    HYDRA_UMC_BOOTSTRAP_ADMIN_USERNAME: "bootstrap-admin",
    HYDRA_UMC_BOOTSTRAP_ADMIN_PASSWORD: "bootstrap-password-not-for-deployment",
  },
  /Production startup requires a non-empty JWT_SECRET/,
);
await expectFailure(
  "missing bootstrap credentials",
  { JWT_SECRET: "test-only-production-secret-not-for-deployment" },
  /Production first start requires HYDRA_UMC_BOOTSTRAP_ADMIN_USERNAME/,
);
console.log("SERVER_PRODUCTION_BOOTSTRAP_CONTRACT=PASS jwt=required bootstrap=required");
