// =============================================================================
// HYDRA-UMC-SERVER - GET /api/telemetry/query and /aggregate real relay verification
// Copyright (C) 2026 JuanenRac (Electro Hobby 3D) <electrohobby3d@gmail.com>
// GPL-3.0 - see LICENSE
// =============================================================================
// Starts a real Server instance plus a real, minimal HTTP stub standing in
// for HYDRA-UMC-DATALAKE (same "real socket, no mocked client" standard as
// this project's other verify_*_contract.mjs scripts) - proves the proxy
// genuinely forwards query params and an upstream response/failure, not
// just that a route exists. Also proves the route is unavailable (503,
// not a crash) when HYDRA_UMC_DATALAKE_URL is unset, and requires the same
// authenticated Server session as every other real client route.

import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TSX_CLI = path.join(ROOT, "node_modules", "tsx", "dist", "cli.mjs");
const SERVER_SOURCE = path.join(ROOT, "src", "server.ts");
const ADMIN = { username: "telemetry-contract-admin", password: "telemetry-contract-admin-password" };

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

async function waitFor(url, startupError = () => undefined, headers = {}) {
  let lastError;
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const processError = startupError();
    if (processError) throw new Error(`service process could not start: ${processError.message}`);
    try {
      const response = await fetch(url, { headers });
      if (response.ok) return;
      lastError = new Error(`HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error(`service did not become ready: ${lastError}`);
}

// A real, tiny stand-in for HYDRA-UMC-DATALAKE's own /query and /aggregate -
// echoes back the query string it actually received, so the test can prove
// the proxy forwarded the real params, and can force a 500 on request to
// prove an upstream failure surfaces as a clean error, not a crash.
function startDatalakeStub() {
  const seenQueries = [];
  let forceFailure = false;
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    seenQueries.push(`${url.pathname}${url.search}`);
    if (forceFailure) {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "stub datalake failure" }));
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    if (url.pathname === "/query") {
      res.end(JSON.stringify([{ sourceId: url.searchParams.get("sourceId"), kind: "motor_temp", field: "value", timestamp: 1000, value: 42.5 }]));
    } else if (url.pathname === "/aggregate") {
      res.end(JSON.stringify([{ bucketStart: 0, value: 15.0, count: 2 }]));
    } else {
      res.writeHead(404).end();
    }
  });
  return { server, seenQueries, setForceFailure: (v) => { forceFailure = v; } };
}

async function main() {
  // Two separate temp workspaces, one per Server instance below - they run
  // sequentially but each gets its own settings.json/users.json rather than
  // sharing a directory, the same isolation every other verify_*_contract.mjs
  // script in this project already uses.
  const workspaceNoDatalake = await mkdtemp(path.join(tmpdir(), "hydra-umc-server-telemetry-relay-nodl-"));
  const workspaceWithDatalake = await mkdtemp(path.join(tmpdir(), "hydra-umc-server-telemetry-relay-dl-"));
  const stub = startDatalakeStub();
  stub.server.listen(0, "127.0.0.1");
  await once(stub.server, "listening");
  const stubPort = stub.server.address().port;

  const serverPortNoDatalake = await reservePort();
  const serverPortWithDatalake = await reservePort();
  let childNoDatalake;
  let childWithDatalake;
  let logs = "";

  try {
    // First instance: HYDRA_UMC_DATALAKE_URL deliberately unset - proves
    // the route degrades to a clean 503, not a crash or a hang.
    let startupErrorNoDatalake;
    childNoDatalake = spawn(process.execPath, [TSX_CLI, SERVER_SOURCE], {
      cwd: workspaceNoDatalake,
      env: {
        ...process.env,
        PORT: String(serverPortNoDatalake),
        NODE_ENV: "test",
        JWT_SECRET: "telemetry-contract-no-datalake-secret-not-for-deployment",
        HYDRA_UMC_BOOTSTRAP_ADMIN_USERNAME: ADMIN.username,
        HYDRA_UMC_BOOTSTRAP_ADMIN_PASSWORD: ADMIN.password,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    childNoDatalake.once("error", (error) => { startupErrorNoDatalake = error; });
    childNoDatalake.stdout.on("data", (chunk) => { logs += chunk; });
    childNoDatalake.stderr.on("data", (chunk) => { logs += chunk; });
    await waitFor(`http://127.0.0.1:${serverPortNoDatalake}/api/hydra-info`, () => startupErrorNoDatalake);

    const loginNoDatalake = await fetch(`http://127.0.0.1:${serverPortNoDatalake}/api/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(ADMIN),
    }).then((r) => r.json());
    const unconfigured = await fetch(
      `http://127.0.0.1:${serverPortNoDatalake}/api/telemetry/query?sourceId=robot-1`,
      { headers: { authorization: `Bearer ${loginNoDatalake.token}` } },
    );
    assert.equal(unconfigured.status, 503);
    const unconfiguredBody = await unconfigured.json();
    assert.equal(unconfiguredBody.available, false);

    // Done with this instance before starting the next - no need to keep 2
    // real Server processes alive at once.
    childNoDatalake.kill("SIGTERM");
    await Promise.race([once(childNoDatalake, "exit"), new Promise((resolve) => setTimeout(resolve, 3000))]);
    if (childNoDatalake.exitCode === null) childNoDatalake.kill("SIGKILL");

    // Second instance: HYDRA_UMC_DATALAKE_URL points at the real stub above.
    let startupErrorWithDatalake;
    childWithDatalake = spawn(process.execPath, [TSX_CLI, SERVER_SOURCE], {
      cwd: workspaceWithDatalake,
      env: {
        ...process.env,
        PORT: String(serverPortWithDatalake),
        NODE_ENV: "test",
        JWT_SECRET: "telemetry-contract-with-datalake-secret-not-for-deployment",
        HYDRA_UMC_BOOTSTRAP_ADMIN_USERNAME: ADMIN.username,
        HYDRA_UMC_BOOTSTRAP_ADMIN_PASSWORD: ADMIN.password,
        HYDRA_UMC_DATALAKE_URL: `http://127.0.0.1:${stubPort}`,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    childWithDatalake.once("error", (error) => { startupErrorWithDatalake = error; });
    childWithDatalake.stdout.on("data", (chunk) => { logs += chunk; });
    childWithDatalake.stderr.on("data", (chunk) => { logs += chunk; });
    await waitFor(`http://127.0.0.1:${serverPortWithDatalake}/api/hydra-info`, () => startupErrorWithDatalake);

    // Anonymous request must be rejected before ever reaching the stub -
    // same authenticated-Server-session requirement as every other real
    // client route (this is not a public passthrough to Datalake).
    const anonymous = await fetch(`http://127.0.0.1:${serverPortWithDatalake}/api/telemetry/query?sourceId=robot-1`);
    assert.equal(anonymous.status, 401);

    const login = await fetch(`http://127.0.0.1:${serverPortWithDatalake}/api/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(ADMIN),
    }).then((r) => r.json());
    const authorization = { authorization: `Bearer ${login.token}` };

    const queryResponse = await fetch(
      `http://127.0.0.1:${serverPortWithDatalake}/api/telemetry/query?sourceId=robot-1&kind=motor_temp&field=value&limit=50`,
      { headers: authorization },
    );
    assert.equal(queryResponse.status, 200);
    const queryBody = await queryResponse.json();
    assert.equal(queryBody[0].sourceId, "robot-1");
    assert.equal(queryBody[0].value, 42.5);
    assert(stub.seenQueries.some((q) => q.startsWith("/query?") && q.includes("sourceId=robot-1") && q.includes("limit=50")),
      `proxy did not forward the real query params to Datalake, saw: ${JSON.stringify(stub.seenQueries)}`);

    const aggregateResponse = await fetch(
      `http://127.0.0.1:${serverPortWithDatalake}/api/telemetry/aggregate?kind=temp&field=v&bucketMs=1000&start=0&end=1999`,
      { headers: authorization },
    );
    assert.equal(aggregateResponse.status, 200);
    const aggregateBody = await aggregateResponse.json();
    assert.equal(aggregateBody[0].value, 15.0);
    assert(stub.seenQueries.some((q) => q.startsWith("/aggregate?") && q.includes("bucketMs=1000")),
      `proxy did not forward the real aggregate params to Datalake, saw: ${JSON.stringify(stub.seenQueries)}`);

    // A real upstream failure must surface as a clean, forwarded error, not
    // a 500 that hides what actually went wrong.
    stub.setForceFailure(true);
    const failedResponse = await fetch(
      `http://127.0.0.1:${serverPortWithDatalake}/api/telemetry/query?sourceId=robot-1`,
      { headers: authorization },
    );
    assert.equal(failedResponse.status, 500);
    const failedBody = await failedResponse.json();
    assert.equal(failedBody.error, "stub datalake failure");

    console.log("SERVER_TELEMETRY_RELAY_CONTRACT=PASS unconfigured=1 auth=1 query=1 aggregate=1 upstream_failure=1");
  } catch (error) {
    throw new Error(`${error instanceof Error ? error.message : error}\nServer startup output:\n${logs || "<no output>"}`);
  } finally {
    stub.server.close();
    for (const child of [childNoDatalake, childWithDatalake]) {
      if (child && child.exitCode === null) {
        child.kill("SIGTERM");
        await Promise.race([once(child, "exit"), new Promise((resolve) => setTimeout(resolve, 3000))]);
        if (child.exitCode === null) child.kill("SIGKILL");
      }
    }
    await Promise.all([workspaceNoDatalake, workspaceWithDatalake].map((dir) =>
      rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })));
  }
}

main().catch((error) => {
  console.error("SERVER_TELEMETRY_RELAY_CONTRACT=FAIL", error instanceof Error ? error.stack : error);
  process.exitCode = 1;
});
