// =============================================================================
// HYDRA-UMC-SERVER - GET /api/ecosystem/status real live-probe verification
// Copyright (C) 2026 JuanenRac (Electro Hobby 3D) <electrohobby3d@gmail.com>
// GPL-3.0 - see LICENSE
// =============================================================================
// Builds a real, isolated fake workspace (3 sibling "repos" - one with a
// real listener, one with a reserved-then-closed port, one that never
// declares a service at all), starts a real Server instance whose own cwd
// sits inside that workspace, and hits the real endpoint over real HTTP -
// proving the live TCP/HTTP probe genuinely distinguishes up/down/not-a-
// service rather than just echoing static manifest fields.

import assert from "node:assert/strict";
import { once } from "node:events";
import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
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

function baseManifest(name, overrides = {}) {
  return {
    schema_version: "1.0",
    ecosystem: "HYDRA-UMC",
    name,
    version: "0.0.1",
    role: "service",
    stack: "node",
    technologies: ["Node.js"],
    deployment_target: "cm5",
    maturity: "functional",
    family: "Contract Test Fixtures",
    parent: null,
    native_version: { file: "package.json", pattern: "\"version\":\\s*\"(\\d+)\\.(\\d+)\\.(\\d+)\"" },
    build: "n/a - test fixture only",
    notes: "A real, disposable fixture manifest used only by verify_ecosystem_status_contract.mjs.",
    ...overrides,
  };
}

async function writeManifest(dir, manifest) {
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "hydra-umc.project.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
}

async function fetchEcosystemStatus(port) {
  let lastError;
  for (let attempt = 0; attempt < 120; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/ecosystem/status`);
      if (response.ok) return response.json();
      lastError = new Error(`HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`ecosystem status endpoint did not become ready: ${lastError}`);
}

async function main() {
  const workspace = await mktemp();
  const serverCwd = path.join(workspace, "HYDRA-UMC-SERVER-under-test");
  const upDir = path.join(workspace, "hydra-umc-fixture-up-service");
  const downDir = path.join(workspace, "hydra-umc-fixture-down-service");
  const libraryDir = path.join(workspace, "hydra-umc-fixture-library");

  const upPort = await reservePort();
  // A real listener the probe should find genuinely up - deliberately no
  // health_path in its manifest, so this also exercises the bare-TCP-
  // connect path (not every real service in the ecosystem speaks HTTP -
  // MQTT/OPC-UA don't).
  const upListener = createServer((socket) => socket.end());
  upListener.listen(upPort, "127.0.0.1");
  await once(upListener, "listening");

  // A port reserved then immediately released - nothing is listening on it,
  // so the probe must report it down, not silently treat "closed" as "up"
  // or "unknown".
  const downPort = await reservePort();

  await writeManifest(upDir, baseManifest("HYDRA-UMC-FIXTURE-UP-SERVICE", { service: { port: upPort } }));
  await writeManifest(downDir, baseManifest("HYDRA-UMC-FIXTURE-DOWN-SERVICE", { service: { port: downPort } }));
  await writeManifest(libraryDir, baseManifest("HYDRA-UMC-FIXTURE-LIBRARY", { role: "library" }));

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
        JWT_SECRET: "local-contract-verification-only-not-for-deployment",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.on("data", (chunk) => { logs += chunk; });
    child.stderr.on("data", (chunk) => { logs += chunk; });

    let payload;
    try {
      payload = await fetchEcosystemStatus(serverPort);
    } catch (error) {
      throw new Error(`${error instanceof Error ? error.message : error}\nServer startup output:\n${logs || "<no output>"}`);
    }

    assert.equal(payload.available, true, "the fixture workspace has real sibling manifests - available must be true");
    const byName = Object.fromEntries(payload.projects.map((p) => [p.name, p]));

    const up = byName["HYDRA-UMC-FIXTURE-UP-SERVICE"];
    assert(up, "up-service fixture missing from response");
    assert.equal(up.servicePort, upPort);
    assert.equal(up.serviceHealthPath, null);
    assert.equal(up.live, true, "a real listener on the declared port must probe as live: true");

    const down = byName["HYDRA-UMC-FIXTURE-DOWN-SERVICE"];
    assert(down, "down-service fixture missing from response");
    assert.equal(down.servicePort, downPort);
    assert.equal(down.live, false, "a closed port must probe as live: false, never true or null");

    const library = byName["HYDRA-UMC-FIXTURE-LIBRARY"];
    assert(library, "library fixture missing from response");
    assert.equal(library.servicePort, null, "a manifest with no service field must report servicePort: null");
    assert.equal(library.live, null, "a project that never declares a service must report live: null, not false");

    // Real bug this covers, live-reproduced on the CM5: a production
    // deployment's own cwd (/opt/hydra-umc/server) has no manifests under
    // its parent at all - the real checkouts with manifests live
    // elsewhere (~/hydra-umc/HYDRA-UMC-*). A second server instance,
    // spawned with its cwd deliberately OUTSIDE `workspace` (so the
    // default `../` scan finds nothing) but HYDRA_UMC_ECOSYSTEM_ROOT
    // pointed AT `workspace`, must still find the same 3 fixtures -
    // proving the override, not an accidental path match, is what makes
    // this work.
    const outsideRoot = await mktemp();
    const outsideCwd = path.join(outsideRoot, "server-cwd-outside-any-manifest-tree");
    let overrideChild;
    let overrideLogs = "";
    const overridePort = await reservePort();
    try {
      await mkdir(outsideCwd, { recursive: true });
      await copyFile(path.join(ROOT, "package.json"), path.join(outsideCwd, "package.json"));
      overrideChild = spawn(process.execPath, [TSX_CLI, SERVER_SOURCE], {
        cwd: outsideCwd,
        env: {
          ...process.env,
          PORT: String(overridePort),
          NODE_ENV: "test",
          JWT_SECRET: "local-contract-verification-only-not-for-deployment",
          HYDRA_UMC_ECOSYSTEM_ROOT: workspace,
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
      overrideChild.stdout.on("data", (chunk) => { overrideLogs += chunk; });
      overrideChild.stderr.on("data", (chunk) => { overrideLogs += chunk; });

      let overridePayload;
      try {
        overridePayload = await fetchEcosystemStatus(overridePort);
      } catch (error) {
        throw new Error(`${error instanceof Error ? error.message : error}\nServer startup output:\n${overrideLogs || "<no output>"}`);
      }
      assert.equal(overridePayload.available, true, "HYDRA_UMC_ECOSYSTEM_ROOT must redirect the scan to a real manifest tree");
      const overrideNames = overridePayload.projects.map((p) => p.name).sort();
      assert.deepEqual(
        overrideNames,
        ["HYDRA-UMC-FIXTURE-DOWN-SERVICE", "HYDRA-UMC-FIXTURE-LIBRARY", "HYDRA-UMC-FIXTURE-UP-SERVICE"],
        "HYDRA_UMC_ECOSYSTEM_ROOT must find the exact same fixtures as the default-cwd scan above, from a cwd with no manifests anywhere near it",
      );
    } finally {
      if (overrideChild && overrideChild.exitCode === null) {
        overrideChild.kill("SIGTERM");
        await Promise.race([once(overrideChild, "exit"), new Promise((resolve) => setTimeout(resolve, 3000))]);
        if (overrideChild.exitCode === null) overrideChild.kill("SIGKILL");
      }
      await rm(outsideRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    }

    console.log(`SERVER_ECOSYSTEM_STATUS_CONTRACT=PASS up=${up.live} down=${down.live} library=${library.live} root_override=1`);
  } finally {
    upListener.close();
    if (child && child.exitCode === null) {
      child.kill("SIGTERM");
      await Promise.race([once(child, "exit"), new Promise((resolve) => setTimeout(resolve, 3000))]);
      if (child.exitCode === null) child.kill("SIGKILL");
    }
    await rm(workspace, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
}

async function mktemp() {
  return mkdtemp(path.join(tmpdir(), "hydra-umc-server-ecosystem-status-"));
}

main().catch((error) => {
  console.error("SERVER_ECOSYSTEM_STATUS_CONTRACT=FAIL", error instanceof Error ? error.stack : error);
  process.exitCode = 1;
});
