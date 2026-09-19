// =============================================================================
// HYDRA-UMC-SERVER - Local negative authentication and authorization checks
// Copyright (C) 2026 JuanenRac (Electro Hobby 3D) <electrohobby3d@gmail.com>
// GPL-3.0 - see LICENSE
// =============================================================================
// Starts the real server in an isolated directory and proves that anonymous,
// invalid-token and operator-role requests cannot access administration or
// settings writes.  The one operator-allowed work-file request proves the
// role boundary is intentional rather than an accidental blanket denial.

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
const OPERATOR = { username: "contract-operator", password: "contract-operator-password" };

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
  assert.equal(typeof body.token, "string");
  return body.token;
}

async function main() {
  const temporaryDirectory = await mkdtemp(path.join(tmpdir(), "hydra-umc-server-auth-"));
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
        JWT_SECRET: "local-auth-contract-verification-only-not-for-deployment",
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

    for (const route of ["/api/settings", "/api/users", "/api/upload-work"]) {
      const { response, body } = await request(port, route, { method: "POST", body: "{}" });
      assert.equal(response.status, 401, `anonymous ${route} must be rejected`);
      assert.match(body.error, /No token provided/);
    }

    // GET /api/settings had NO auth middleware at all (confirmed live
    // returning 200 to an anonymous request) - the loop above only ever
    // exercised the POST (write) side of this route, so it never caught
    // that the GET (read) side leaked the full settings payload, including
    // every controller/robot/camera config, to any unauthenticated caller.
    const anonymousGetSettings = await request(port, "/api/settings", { method: "GET" });
    assert.equal(anonymousGetSettings.response.status, 401, "anonymous GET /api/settings must be rejected");
    assert.match(anonymousGetSettings.body.error, /No token provided/);

    const invalid = await request(port, "/api/settings", {
      method: "POST",
      headers: { authorization: "Bearer definitely-not-a-valid-token" },
      body: "{}",
    });
    assert.equal(invalid.response.status, 403);
    assert.equal(invalid.body.code, "TOKEN_INVALID");

    const adminToken = await login(port, ADMIN);
    const createOperator = await request(port, "/api/users", {
      method: "POST",
      headers: { authorization: `Bearer ${adminToken}` },
      body: JSON.stringify({ ...OPERATOR, role: "operator" }),
    });
    assert.equal(createOperator.response.status, 200, `operator creation failed: ${JSON.stringify(createOperator.body)}`);

    const operatorToken = await login(port, OPERATOR);
    for (const route of ["/api/users", "/api/settings", "/api/admin/server-config"]) {
      const method = route === "/api/users" ? "GET" : (route === "/api/admin/server-config" ? "PUT" : "POST");
      const { response, body } = await request(port, route, {
        method,
        headers: { authorization: `Bearer ${operatorToken}` },
        body: method === "GET" ? undefined : "{}",
      });
      assert.equal(response.status, 403, `operator ${route} must be denied`);
      assert.match(body.error, /admin privileges required/);
    }

    const workFile = await request(port, "/api/upload-work", {
      method: "POST",
      headers: { authorization: `Bearer ${operatorToken}` },
      body: JSON.stringify({ folderPath: "contract-check", fileName: "operator.json", content: { ok: true } }),
    });
    assert.equal(workFile.response.status, 200);
    assert.equal(workFile.body.success, true);

    // An exact-string check against req.path used to guard
    // settings.json/users.json/etc. under express.static(dataPath) - real,
    // unauthenticated bypasses confirmed live before the fix: a single
    // percent-encoded character, a doubled leading slash, a case
    // difference, and a literal or encoded "." segment all served the real
    // file despite failing that naive string comparison (send()/
    // express.static resolve paths differently than a plain req.path
    // string-equality check does). Every variant below must now be
    // refused (404), and the legitimate WORKS file just written above
    // (same static mount, same dataPath root) must still be served
    // normally - proving this is a targeted fix, not a blanket lockdown of
    // the whole static mount.
    for (const bypass of [
      "/settings.json",
      "/%73ettings.json",
      "//settings.json",
      "/Settings.json",
      "/./settings.json",
      "/%2e/settings.json",
    ]) {
      const { response } = await fetch(`http://127.0.0.1:${port}${bypass}`, { redirect: "manual" }).then((r) => ({ response: r }));
      assert.equal(response.status, 404, `static bypass ${bypass} must not serve settings.json`);
    }
    const legitimateWorkFile = await fetch(`http://127.0.0.1:${port}/contract-check/operator.json`);
    assert.equal(legitimateWorkFile.status, 200, "this fix must not block legitimate WORKS file access");
    const legitimateBody = await legitimateWorkFile.json();
    assert.equal(legitimateBody.ok, true);

    // Real "alg: none" / algorithm-confusion regression: authenticate()'s
    // own jwt.verify() now pins `algorithms: ["HS256"]` explicitly. A
    // hand-crafted token with a real, valid-looking payload (this same
    // admin's own username/role) but header.alg set to "none" and an
    // empty signature must never be accepted, regardless of whatever the
    // jsonwebtoken library's own current default happens to be - this
    // proves the explicit pin itself, against the real running server.
    const base64url = (obj) => Buffer.from(JSON.stringify(obj)).toString("base64url");
    const noneAlgToken = `${base64url({ alg: "none", typ: "JWT" })}.${base64url({ username: ADMIN.username, role: "admin", tokenVersion: 1 })}.`;
    const noneAlgAttempt = await request(port, "/api/settings", {
      method: "POST",
      headers: { authorization: `Bearer ${noneAlgToken}` },
      body: "{}",
    });
    assert.equal(noneAlgAttempt.response.status, 403, "an alg:none token must never be accepted as valid");

    console.log("SERVER_AUTH_NEGATIVE=PASS anonymous=4 invalid-token=1 operator-denials=3 operator-work-write=1 static-bypass-blocked=6 static-legitimate=1 alg-none-rejected=1");
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
  console.error("SERVER_AUTH_NEGATIVE=FAIL", error instanceof Error ? error.stack : error);
  process.exitCode = 1;
});
