// =============================================================================
// HYDRA-UMC-SERVER - Real contract checks of the history of connections
// Copyright (C) 2026 JuanenRac (Electro Hobby 3D) <electrohobby3d@gmail.com>
// GPL-3.0-or-later - see LICENSE
// =============================================================================
// Proves against a real running server that the list of clients and the history of sign-ins
// (GET /api/connections/clients and /api/connections/events) follow the closed shape of the
// ConnectionClient and ConnectionEvent contracts, hold no secret, count the open sessions, and
// keep the address and user agent out unless an administrator turned that option on and then show
// them to an administrator only. Same real-server pattern as the other tools/verify_*_contract.mjs.

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
const ADMIN = { username: "connections-admin", password: "connections-admin-password" };
const OPERATOR = { username: "connections-operator", password: "connections-operator-password" };
const WRONG = "this-is-not-the-password-at-all";

const KINDS = ["studio", "suite", "android", "ios", "dsi", "watch", "voice", "other"];
const EVENT_KEYS = new Set(["schema_version", "id", "at_utc", "action", "client_kind", "client_id", "user", "origin", "two_factor", "app_version", "ip", "agent"]);
const CLIENT_KEYS = new Set(["schema_version", "id", "kind", "user", "app_version", "origin", "two_factor", "first_seen_utc", "last_seen_utc", "last_failure_utc", "active_sessions", "logins_ok", "logins_failed", "ip", "agent"]);

async function waitUntil(fn, { timeoutMs = 20000, intervalMs = 100, message = "condition" } = {}) {
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

async function request(port, route, options = {}) {
  const response = await fetch(`http://127.0.0.1:${port}${route}`, {
    ...options,
    headers: { "content-type": "application/json", ...(options.headers ?? {}) },
  });
  return { response, body: await response.json() };
}

function assertClosedShapes(events, clients) {
  for (const event of events) {
    assert.equal(event.schema_version, "1.0");
    assert.ok(Number.isInteger(event.id) && event.id >= 1);
    assert.ok(KINDS.includes(event.client_kind));
    assert.match(event.client_id, /^[0-9a-f]{16}$/);
    for (const key of Object.keys(event)) assert.ok(EVENT_KEYS.has(key), `event key ${key} is not in the contract`);
  }
  for (const client of clients) {
    assert.equal(client.schema_version, "1.0");
    assert.ok(KINDS.includes(client.kind));
    assert.match(client.id, /^[0-9a-f]{16}$/);
    for (const key of Object.keys(client)) assert.ok(CLIENT_KEYS.has(key), `client key ${key} is not in the contract`);
  }
}

async function main() {
  const temporaryDirectory = await mkdtemp(path.join(tmpdir(), "hydra-umc-server-connections-"));
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
        JWT_SECRET: "local-connections-contract-verification-only-not-for-deployment",
        HYDRA_UMC_BOOTSTRAP_ADMIN_USERNAME: ADMIN.username,
        HYDRA_UMC_BOOTSTRAP_ADMIN_PASSWORD: ADMIN.password,
        LOGIN_RATE_LIMIT_MAX: "100",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.on("data", (chunk) => { logs += chunk; });
    child.stderr.on("data", (chunk) => { logs += chunk; });
    try {
      await waitUntil(async () => { try { return (await fetch(`http://127.0.0.1:${port}/api/hydra-info`)).ok; } catch { return false; } }, { message: "server to accept connections" });
    } catch (error) {
      throw new Error(`${error instanceof Error ? error.message : error}\nServer startup output:\n${logs || "<no output>"}`);
    }

    const post = (route, body, headers = {}) => request(port, route, { method: "POST", headers, body: JSON.stringify(body) });
    const login = async (account, headers = {}) => {
      const result = await post("/api/login", account, headers);
      assert.equal(result.response.status, 200, `login of ${account.username}`);
      return result.body;
    };

    // 1. The list needs a sign-in.
    assert.equal((await request(port, "/api/connections/clients")).response.status, 401);
    assert.equal((await request(port, "/api/connections/events")).response.status, 401);

    // 2. Two administrator sessions of an Android app, one refused sign-in of a stranger and one of a real account.
    const adminSession = await login(ADMIN, { "x-hydra-client": "android/0.7.4" });
    const adminAuth = { authorization: `Bearer ${adminSession.token}` };
    const secondSession = await login(ADMIN, { "x-hydra-client": "android/0.7.4" });
    assert.equal((await post("/api/login", { username: "stranger-with-a-guess", password: WRONG }, { "x-hydra-client": "android/0.7.4" })).response.status, 401);
    assert.equal((await post("/api/login", { username: ADMIN.username, password: WRONG }, { "x-hydra-client": "android/0.7.4" })).response.status, 401);
    assert.equal((await post("/api/users", { ...OPERATOR, role: "operator" }, adminAuth)).response.status, 200);

    const listed = await request(port, "/api/connections/clients", { headers: adminAuth });
    assert.equal(listed.response.status, 200);
    const android = listed.body.clients.find((c) => c.kind === "android" && c.user === ADMIN.username);
    assert.ok(android, "the Android client of the administrator is listed");
    assert.equal(android.app_version, "0.7.4");
    assert.equal(android.active_sessions, 2, "two open sessions");
    assert.equal(android.logins_ok, 2);
    assert.equal(android.logins_failed, 1);
    assert.equal(android.origin, "local");
    assert.ok(android.last_failure_utc);
    assert.equal(android.ip, undefined, "the address is not kept by default");
    assert.equal(android.agent, undefined);

    const history = await request(port, "/api/connections/events", { headers: adminAuth });
    assert.equal(history.response.status, 200);
    const events = history.body.events;
    assert.deepEqual(events.filter((e) => e.action === "login").length, 2);
    assert.equal(events.filter((e) => e.action === "login_failed").length, 2);
    assert.ok(events.some((e) => e.action === "first_seen"));
    assert.ok(!events.some((e) => e.user === "stranger-with-a-guess"), "the name of a stranger is not kept");
    assert.ok(events.every((e, i) => i === 0 || e.id < events[i - 1].id), "newest first");
    assertClosedShapes(events, listed.body.clients);

    // 3. Nothing secret anywhere in either answer.
    const everything = JSON.stringify([listed.body, history.body]);
    for (const secret of [ADMIN.password, WRONG, adminSession.token, adminSession.refreshToken, secondSession.refreshToken]) {
      assert.ok(!everything.includes(secret), "no password, token or refresh token in the history");
    }

    // 4. Filters and bad values.
    assert.equal((await request(port, "/api/connections/events?action=nonsense", { headers: adminAuth })).response.status, 400);
    assert.equal((await request(port, "/api/connections/events?kind=nonsense", { headers: adminAuth })).response.status, 400);
    assert.equal((await request(port, "/api/connections/events?limit=abc", { headers: adminAuth })).response.status, 400);
    assert.equal((await request(port, "/api/connections/clients?kind=nonsense", { headers: adminAuth })).response.status, 400);
    const failedOnly = await request(port, "/api/connections/events?action=login_failed&limit=1", { headers: adminAuth });
    assert.equal(failedOnly.body.events.length, 1);
    assert.equal(failedOnly.body.events[0].action, "login_failed");
    const paged = await request(port, `/api/connections/events?before=${events[0].id}`, { headers: adminAuth });
    assert.ok(paged.body.events.every((e) => e.id < events[0].id));

    // 5. A logout ends one of the two sessions.
    assert.equal((await post("/api/logout", { refreshToken: secondSession.refreshToken })).response.status, 200);
    const afterLogout = await request(port, "/api/connections/clients?active=1", { headers: adminAuth });
    assert.equal(afterLogout.body.clients.find((c) => c.kind === "android" && c.user === ADMIN.username).active_sessions, 1);
    const logoutEvents = await request(port, "/api/connections/events?action=logout", { headers: adminAuth });
    assert.equal(logoutEvents.body.events.length, 1);
    assert.equal(logoutEvents.body.events[0].client_kind, "android");

    // 6. An operator sees only its own entries, never the administrator's.
    const operatorSession = await login(OPERATOR, { "x-hydra-client": "watch/0.2.7" });
    const operatorAuth = { authorization: `Bearer ${operatorSession.token}` };
    const own = await request(port, "/api/connections/clients", { headers: operatorAuth });
    assert.equal(own.response.status, 200);
    assert.ok(own.body.clients.length >= 1 && own.body.clients.every((c) => c.user === OPERATOR.username && c.kind === "watch"));
    const ownEvents = await request(port, `/api/connections/events?user=${ADMIN.username}`, { headers: operatorAuth });
    assert.ok(ownEvents.body.events.length >= 1 && ownEvents.body.events.every((e) => e.user === OPERATOR.username), "the user filter cannot reach another account");

    // 7. The option that keeps the address: off by default, an administrator turns it on, then only an administrator sees it.
    const config = await request(port, "/api/admin/server-config", { headers: adminAuth });
    assert.equal(config.body.connections.recordAddress.value, false);
    assert.equal(config.body.connections.recordAddress.source, "default");
    const operatorConfig = await request(port, "/api/admin/server-config", { method: "PUT", headers: operatorAuth, body: JSON.stringify({ connections: { recordAddress: true } }) });
    assert.equal(operatorConfig.response.status, 403, "only an administrator may change the option");
    const bad = await request(port, "/api/admin/server-config", { method: "PUT", headers: adminAuth, body: JSON.stringify({ connections: { recordAddress: "yes" } }) });
    assert.equal(bad.response.status, 400);
    const turnedOn = await request(port, "/api/admin/server-config", { method: "PUT", headers: adminAuth, body: JSON.stringify({ connections: { recordAddress: true } }) });
    assert.equal(turnedOn.response.status, 200);
    assert.ok(turnedOn.body.warnings.includes("connection_address_recorded"));
    await login(ADMIN, { "x-hydra-client": "suite/0.7.3", "user-agent": "HYDRA-UMC-SUITE-Test/0.7.3" });
    const withAddress = await request(port, "/api/connections/clients?kind=suite", { headers: adminAuth });
    assert.equal(withAddress.body.clients.length, 1);
    assert.match(withAddress.body.clients[0].ip, /127\.0\.0\.1|::1/);
    assert.ok(withAddress.body.clients[0].agent);
    const operatorView = await request(port, "/api/connections/events", { headers: operatorAuth });
    assert.ok(operatorView.body.events.every((e) => e.ip === undefined && e.agent === undefined), "an operator never sees an address");
    assertClosedShapes([], withAddress.body.clients);

    console.log("SERVER_CONNECTION_HISTORY_CONTRACT=PASS closed_shape=1 no_secret=1 sessions_counted=1 stranger_unnamed=1 own_entries_only=1 address_off_by_default=1 address_admin_only=1");
  } finally {
    if (child) {
      child.kill();
      await new Promise((resolve) => child.once("exit", resolve));
    }
    await rm(temporaryDirectory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
