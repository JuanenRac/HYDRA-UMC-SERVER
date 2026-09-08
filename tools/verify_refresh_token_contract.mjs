// =============================================================================
// HYDRA-UMC-SERVER - C08 real refresh-token contract checks
// Copyright (C) 2026 JuanenRac (Electro Hobby 3D) <electrohobby3d@gmail.com>
// GPL-3.0 - see LICENSE
// =============================================================================
// Real gap this closes: a client whose WebSocket got closed 1008 had no
// way to recover a fresh access token short of a full manual re-login,
// even when the account itself was never actually revoked (see
// src/refresh_tokens.ts's own header comment). Proves the real
// login->refresh->logout lifecycle against an actual running server, same
// real-server, no-browser-client pattern every other
// tools/verify_*_contract.mjs in this repo already uses.

import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TSX_CLI = path.join(ROOT, "node_modules", "tsx", "dist", "cli.mjs");
const SERVER_SOURCE = path.join(ROOT, "src", "server.ts");
const ADMIN = { username: "refresh-contract-admin", password: "refresh-contract-admin-password" };

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

async function request(port, route, options = {}) {
  const response = await fetch(`http://127.0.0.1:${port}${route}`, {
    ...options,
    headers: { "content-type": "application/json", ...(options.headers ?? {}) },
  });
  return { response, body: await response.json() };
}

async function main() {
  const temporaryDirectory = await mkdtemp(path.join(tmpdir(), "hydra-umc-server-refresh-"));
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
        JWT_SECRET: "local-refresh-contract-verification-only-not-for-deployment",
        HYDRA_UMC_BOOTSTRAP_ADMIN_USERNAME: ADMIN.username,
        HYDRA_UMC_BOOTSTRAP_ADMIN_PASSWORD: ADMIN.password,
        // This script exercises real login/refresh/logout several times
        // in a row on purpose (the real lifecycle, not the rate limiter
        // itself - verify_auth_negative.mjs's own concern) - loginRateLimiter's
        // real default (5 per 15 minutes) would otherwise 429 partway
        // through a single run of this script.
        LOGIN_RATE_LIMIT_MAX: "50",
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

    // Real login returns a real refresh token alongside the access token.
    const loginResult = await request(port, "/api/login", { method: "POST", body: JSON.stringify(ADMIN) });
    assert.equal(loginResult.response.status, 200);
    assert.equal(typeof loginResult.body.token, "string");
    assert.match(loginResult.body.refreshToken, /^[0-9a-f]{64}$/, "login must return a real opaque refresh token");
    const firstRefreshToken = loginResult.body.refreshToken;

    // A real refresh exchanges it for a fresh access token, no password
    // involved - the whole point of this feature.
    const refreshed = await request(port, "/api/refresh", {
      method: "POST", body: JSON.stringify({ refreshToken: firstRefreshToken }),
    });
    assert.equal(refreshed.response.status, 200, `refresh failed: ${JSON.stringify(refreshed.body)}`);
    assert.equal(typeof refreshed.body.token, "string");
    // Not asserting refreshed.body.token !== loginResult.body.token here:
    // a JWT is a deterministic function of its claims + iat (whole
    // seconds) - minting one immediately after the other, same account,
    // same second, legitimately produces byte-identical tokens. What
    // actually matters (that the new token really authenticates) is
    // checked below via usingNewToken.
    const rotatedRefreshToken = refreshed.body.refreshToken;
    assert.match(rotatedRefreshToken, /^[0-9a-f]{64}$/);
    assert.notEqual(rotatedRefreshToken, firstRefreshToken, "a refresh token must rotate on use");

    // The NEW access token actually authenticates against a real gated route.
    const usingNewToken = await request(port, "/api/users", {
      headers: { authorization: `Bearer ${refreshed.body.token}` },
    });
    assert.equal(usingNewToken.response.status, 200, "the freshly refreshed access token must actually work");

    // The OLD (pre-rotation) refresh token is now dead - a single real use.
    const replayOldRefreshToken = await request(port, "/api/refresh", {
      method: "POST", body: JSON.stringify({ refreshToken: firstRefreshToken }),
    });
    assert.equal(replayOldRefreshToken.response.status, 401, "a rotated-away refresh token must never work again");

    // An unknown/garbage refresh token is refused, not a 500.
    const garbageRefresh = await request(port, "/api/refresh", {
      method: "POST", body: JSON.stringify({ refreshToken: "not-a-real-token" }),
    });
    assert.equal(garbageRefresh.response.status, 401);

    // A missing refreshToken body field is a real 400, not a crash.
    const missingBody = await request(port, "/api/refresh", { method: "POST", body: JSON.stringify({}) });
    assert.equal(missingBody.response.status, 400);

    // A password change revokes the account's outstanding refresh token -
    // mint a fresh one first (the one from above is already dead).
    const secondLogin = await request(port, "/api/login", { method: "POST", body: JSON.stringify(ADMIN) });
    assert.equal(secondLogin.response.status, 200);
    const tokenBeforePasswordChange = secondLogin.body.refreshToken;
    const changePassword = await request(port, `/api/users/${ADMIN.username}`, {
      method: "PUT",
      headers: { authorization: `Bearer ${secondLogin.body.token}` },
      body: JSON.stringify({ password: "a-brand-new-admin-password" }),
    });
    assert.equal(changePassword.response.status, 200);
    const refreshAfterPasswordChange = await request(port, "/api/refresh", {
      method: "POST", body: JSON.stringify({ refreshToken: tokenBeforePasswordChange }),
    });
    assert.equal(refreshAfterPasswordChange.response.status, 401, "a password change must revoke outstanding refresh tokens too, exactly like it already does for access tokens");

    // Real explicit logout revokes the refresh token server-side.
    const thirdLogin = await request(port, "/api/login", {
      method: "POST", body: JSON.stringify({ username: ADMIN.username, password: "a-brand-new-admin-password" }),
    });
    assert.equal(thirdLogin.response.status, 200);
    const logoutResult = await request(port, "/api/logout", {
      method: "POST", body: JSON.stringify({ refreshToken: thirdLogin.body.refreshToken }),
    });
    assert.equal(logoutResult.response.status, 200);
    const refreshAfterLogout = await request(port, "/api/refresh", {
      method: "POST", body: JSON.stringify({ refreshToken: thirdLogin.body.refreshToken }),
    });
    assert.equal(refreshAfterLogout.response.status, 401, "a logged-out refresh token must be dead, not just discarded client-side");

    // Logout with no/garbage refreshToken is still a harmless success -
    // never an error surface for the client's own logout button.
    const logoutNoop = await request(port, "/api/logout", { method: "POST", body: JSON.stringify({}) });
    assert.equal(logoutNoop.response.status, 200);

    console.log("SERVER_REFRESH_TOKEN_CONTRACT=PASS login_issues_refresh_token=1 refresh_mints_new_access_token=1 refresh_rotates=1 rotated_away_token_dead=1 garbage_refused=1 missing_body_400=1 password_change_revokes=1 logout_revokes=1 logout_noop=1");
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
