// =============================================================================
// HYDRA-UMC-SERVER - POST /api/integrations/test-connection contract check
// Copyright (C) 2026 JuanenRac (Electro Hobby 3D) <electrohobby3d@gmail.com>
// GPL-3.0 - see LICENSE
// =============================================================================
// Starts the real server in an isolated directory and proves the real
// "Test Connection" probe STUDIO's Config > Integrations panel uses: a real
// listening TCP fixture reports reachable:true, a closed port reports
// reachable:false, malformed input is rejected with 400, and an
// unauthenticated request is rejected with 401 (this route accepts
// client-supplied host/port, unlike GET /api/ecosystem/status).

import assert from "node:assert/strict";
import { once } from "node:events";
import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TSX_CLI = path.join(ROOT, "node_modules", "tsx", "dist", "cli.mjs");
const SERVER_SOURCE = path.join(ROOT, "src", "server.ts");
const ADMIN = { username: "contract-admin", password: "contract-admin-password" };

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

async function login(port, credentials) {
  const { response, body } = await request(port, "/api/login", {
    method: "POST",
    body: JSON.stringify(credentials),
  });
  assert.equal(response.status, 200, `login for ${credentials.username} failed`);
  return body.token;
}

async function main() {
  const temporaryDirectory = await mkdtemp(path.join(tmpdir(), "hydra-umc-server-test-connection-"));
  const serverPort = await reservePort();
  let child;
  let logs = "";

  // A real listener this probe should find genuinely reachable.
  const upPort = await reservePort();
  const upListener = createServer((socket) => socket.end());
  upListener.listen(upPort, "127.0.0.1");
  await once(upListener, "listening");

  // Reserved then released - nothing listens here.
  const downPort = await reservePort();

  try {
    await copyFile(path.join(ROOT, "package.json"), path.join(temporaryDirectory, "package.json"));
    child = spawn(process.execPath, [TSX_CLI, SERVER_SOURCE], {
      cwd: temporaryDirectory,
      env: {
        ...process.env,
        PORT: String(serverPort),
        NODE_ENV: "test",
        JWT_SECRET: "local-contract-verification-only-not-for-deployment",
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

    const anonymous = await request(serverPort, "/api/integrations/test-connection", {
      method: "POST",
      body: JSON.stringify({ host: "127.0.0.1", port: upPort }),
    });
    assert.equal(anonymous.response.status, 401, "anonymous test-connection must be rejected");

    const token = await login(serverPort, ADMIN);
    const authHeaders = { authorization: `Bearer ${token}` };

    const up = await request(serverPort, "/api/integrations/test-connection", {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({ host: "127.0.0.1", port: upPort }),
    });
    assert.equal(up.response.status, 200);
    assert.equal(up.body.reachable, true, "a real listener must report reachable: true");

    const down = await request(serverPort, "/api/integrations/test-connection", {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({ host: "127.0.0.1", port: downPort }),
    });
    assert.equal(down.response.status, 200);
    assert.equal(down.body.reachable, false, "a closed port must report reachable: false");

    const badHost = await request(serverPort, "/api/integrations/test-connection", {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({ host: "not a host; rm -rf /", port: upPort }),
    });
    assert.equal(badHost.response.status, 400, "a malformed host must be rejected before ever probing it");

    const badPort = await request(serverPort, "/api/integrations/test-connection", {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({ host: "127.0.0.1", port: 70000 }),
    });
    assert.equal(badPort.response.status, 400, "an out-of-range port must be rejected");

    console.log(`SERVER_TEST_CONNECTION_CONTRACT=PASS up=${up.body.reachable} down=${down.body.reachable}`);
  } finally {
    upListener.close();
    if (child && child.exitCode === null) {
      child.kill("SIGTERM");
      await Promise.race([once(child, "exit"), new Promise((resolve) => setTimeout(resolve, 3000))]);
      if (child.exitCode === null) child.kill("SIGKILL");
    }
    await rm(temporaryDirectory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
}

main().catch((error) => {
  console.error("SERVER_TEST_CONNECTION_CONTRACT=FAIL", error instanceof Error ? error.stack : error);
  process.exitCode = 1;
});
