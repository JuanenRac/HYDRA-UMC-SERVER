// =============================================================================
// HYDRA-UMC-SERVER - POST /api/ecosystem/service/:unit/:action contract checks
// Copyright (C) 2026 JuanenRac (Electro Hobby 3D) <electrohobby3d@gmail.com>
// GPL-3.0 - see LICENSE
// =============================================================================
// Builds a real, isolated fake workspace (one sibling "repo" with a real
// service.systemd_unit), starts a real Server instance whose own cwd sits
// inside that workspace, and hits the real endpoint over real HTTP. Proves
// the auth/admin gate, the action-name validation, the "never this
// server's own unit" refusal, and the "must be a currently known project
// unit" refusal - all real, without needing actual systemd privilege
// (this machine may not even have systemctl at all - see the final
// scenario's own comment for why that's still a meaningful pass, not a
// skipped assertion).

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
const ADMIN = { username: "service-control-contract-admin", password: "service-control-contract-admin-password" };
const KNOWN_UNIT = "hydra-umc-fixture-controllable.service";

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
  const workspace = await mkdtemp(path.join(tmpdir(), "hydra-umc-server-service-control-"));
  const serverCwd = path.join(workspace, "HYDRA-UMC-SERVER-under-test");
  const fixtureDir = path.join(workspace, "hydra-umc-fixture-controllable");

  await mkdir(fixtureDir, { recursive: true });
  await writeFile(
    path.join(fixtureDir, "hydra-umc.project.json"),
    `${JSON.stringify({
      schema_version: "1.0",
      ecosystem: "HYDRA-UMC",
      name: "HYDRA-UMC-FIXTURE-CONTROLLABLE",
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
      notes: "A real, disposable fixture manifest used only by verify_ecosystem_service_control_contract.mjs.",
      service: { systemd_unit: KNOWN_UNIT },
    }, null, 2)}\n`,
    "utf8"
  );

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
        JWT_SECRET: "local-service-control-contract-verification-only-not-for-deployment",
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

    // Unauthenticated: refused before any of the validation below even runs.
    const anon = await request(serverPort, `/api/ecosystem/service/${KNOWN_UNIT}/restart`, { method: "POST" });
    assert.equal(anon.response.status, 401, "an unauthenticated request must be refused");

    const login = await request(serverPort, "/api/login", { method: "POST", body: JSON.stringify(ADMIN) });
    assert.equal(login.response.status, 200);
    const authorization = { authorization: `Bearer ${login.body.token}` };

    // Invalid action name.
    const badAction = await request(serverPort, `/api/ecosystem/service/${KNOWN_UNIT}/launch-nukes`, {
      method: "POST", headers: authorization,
    });
    assert.equal(badAction.response.status, 400, "an action outside start/stop/restart must be rejected");

    // This server's own unit must never be reachable through this route,
    // even though nothing else about the request looks wrong.
    const ownUnit = await request(serverPort, "/api/ecosystem/service/hydra-umc-server.service/restart", {
      method: "POST", headers: authorization,
    });
    assert.equal(ownUnit.response.status, 403, "this server's own unit must be explicitly refused");

    // A unit name that merely LOOKS like a real one (matches the naming
    // convention) but was never declared in any real manifest must be
    // refused - the allowlist is "what a live scan actually finds", not
    // "anything matching a regex".
    const unknownUnit = await request(serverPort, "/api/ecosystem/service/hydra-umc-totally-made-up.service/restart", {
      method: "POST", headers: authorization,
    });
    assert.equal(unknownUnit.response.status, 404, "a unit not found by a live ecosystem scan must be refused");

    // The KNOWN, real fixture unit: validation passes (unit IS a real,
    // currently-scanned project's own declared systemd_unit) and the
    // route actually calls systemctl. On a machine WITHOUT systemctl at
    // all (this repo's own test/CI environment, Windows dev included) or
    // without the real polkit grant, that call fails and the route must
    // answer a clean 503 - never a crash, a hang, or a silent 200 that
    // lied about actually controlling anything. On a real CM5 with the
    // polkit rule installed, the same request would return 200 - this
    // test only asserts the request completes with ONE of those two
    // honest outcomes, not which one this particular machine gives.
    const known = await request(serverPort, `/api/ecosystem/service/${KNOWN_UNIT}/restart`, {
      method: "POST", headers: authorization,
    });
    assert.ok(
      [200, 503].includes(known.response.status),
      `a known unit's restart must resolve to a real success or a real, honest failure, got ${known.response.status}: ${JSON.stringify(known.body)}`
    );

    console.log(`SERVER_ECOSYSTEM_SERVICE_CONTROL_CONTRACT=PASS anon=1 bad_action=1 own_unit=1 unknown_unit=1 known_unit_status=${known.response.status}`);
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
  console.error("SERVER_ECOSYSTEM_SERVICE_CONTROL_CONTRACT=FAIL", error instanceof Error ? error.stack : error);
  process.exitCode = 1;
});
