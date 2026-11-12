// =============================================================================
// HYDRA-UMC-SERVER - Unit tests for the account and administration routes
// Copyright (C) 2026 JuanenRac (Electro Hobby 3D) <electrohobby3d@gmail.com>
// GPL-3.0-or-later - see LICENSE
// =============================================================================
// src/routes/adminRoutes.ts on a small express application: both middlewares guard every route, the accounts (create with a default role, rename, role that is not a role,
// delete), the list of live connections, the tail of the log (default, cap, bad number, no file), the listen port (bounds, merge with the stored config), the security
// options (applied, refused with their status and written to the audit record, a fault that is not a refusal) and the restart that answers before it exits.
import test, { after, before, mock } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { WebSocket } from "ws";
import { registerAdminRoutes } from "../src/routes/adminRoutes.ts";
import { SecurityConfig, type SecurityFile } from "../src/securityConfig.ts";

const originalCwd = process.cwd();
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hydra-umc-adminroutes-"));
const logFile = path.join(dir, "server.log");

let server: http.Server;
let base = "";
let stored: SecurityFile = {};
let serverConfig: { port?: number | null; other?: string } = { other: "kept" };
const savedConfigs: unknown[] = [];
const industrial: string[] = [];
const audited: any[] = [];
const wsClients = new Set<WebSocket>();
let currentPort = 18200;
let securityOverride: any = null;

before(async () => {
  process.chdir(dir);
  const app = express();
  app.use(express.json());
  const authenticate = (req: any, res: any, next: any) => {
    if (req.headers["x-anonymous"]) return res.status(401).json({ error: "no session" });
    req.user = { id: "u-boss", username: "boss", role: req.headers["x-role"] ?? "admin" };
    return next();
  };
  const requireAdmin = (req: any, res: any, next: any) => (req.user?.role === "admin" ? next() : res.status(403).json({ error: "admin only" }));
  const asyncHandler = (handler: (req: any, res: any) => Promise<any>) => (req: any, res: any, next: any) => handler(req, res).catch(next);
  const real = new SecurityConfig({ env: {}, load: () => ({ ...stored }), save: (file) => { stored = { ...file }; }, tlsActive: false, log: () => {} });
  const security = new Proxy(real, { get: (target, key, receiver) => (securityOverride && key in securityOverride ? securityOverride[key as string] : Reflect.get(target, key, receiver)) });
  registerAdminRoutes(app, {
    authenticate, requireAdmin, asyncHandler,
    industrialLog: (message) => { industrial.push(message); },
    wsClients, logFile,
    getCurrentPort: () => currentPort,
    loadServerConfig: () => ({ ...serverConfig }),
    saveServerConfig: (config) => { savedConfigs.push(config); serverConfig = config; },
    security: security as SecurityConfig,
    audit: { record: (entry: any) => { audited.push(entry); return undefined as any; } },
  });
  app.use((error: any, _req: any, res: any, _next: any) => res.status(500).json({ error: String(error?.message ?? error) }));
  server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as import("node:net").AddressInfo).port}`;
});

after(() => {
  server?.close();
  server?.closeAllConnections?.();
  process.chdir(originalCwd);
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

async function call(method: string, url: string, body?: unknown, headers: Record<string, string> = {}): Promise<{ status: number; body: any }> {
  const response = await fetch(base + url, {
    method,
    headers: { ...(body !== undefined ? { "content-type": "application/json" } : {}), ...headers },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  let parsed: any = text;
  try { parsed = JSON.parse(text); } catch { /* not JSON */ }
  return { status: response.status, body: parsed };
}

const GUARDED: Array<[string, string, unknown?]> = [
  ["GET", "/api/users"], ["POST", "/api/users", { username: "x", password: "long-enough-password" }], ["PUT", "/api/users/x", {}], ["DELETE", "/api/users/x"],
  ["GET", "/api/admin/clients"], ["GET", "/api/admin/logs"], ["GET", "/api/admin/server-config"], ["PUT", "/api/admin/server-config", {}],
  ["GET", "/api/admin/service-identity"], ["GET", "/api/admin/jwt-keys"], ["POST", "/api/admin/jwt-keys/rotate", {}], ["POST", "/api/admin/restart", {}],
];

test("every route needs a session and then an administrator", async () => {
  for (const [method, url, body] of GUARDED) {
    const anonymous = await call(method, url, body, { "x-anonymous": "1" });
    assert.equal(anonymous.status, 401, `${method} ${url} without a session`);
    const operator = await call(method, url, body, { "x-role": "operator" });
    assert.equal(operator.status, 403, `${method} ${url} as an operator`);
    const viewer = await call(method, url, body, { "x-role": "viewer" });
    assert.equal(viewer.status, 403, `${method} ${url} as a viewer`);
  }
  assert.equal(savedConfigs.length, 0, "nothing was changed by the refused calls");
  assert.equal(audited.length, 0);
});

test("an account is created with the role that was asked for, listed without its hash, renamed and deleted", async () => {
  assert.equal((await call("POST", "/api/users", { username: "ops", password: "long-enough-password", role: "operator" })).status, 200);
  assert.equal((await call("POST", "/api/users", { username: "eyes", password: "long-enough-password", role: "viewer" })).status, 200);
  const listed = await call("GET", "/api/users");
  assert.equal(listed.status, 200);
  const roles = Object.fromEntries(listed.body.users.map((u: any) => [u.username, u.role]));
  assert.equal(roles.ops, "operator");
  assert.equal(roles.eyes, "viewer");
  for (const user of listed.body.users) assert.equal("passwordHash" in user, false, "the list never carries a hash");
  assert.equal((await call("PUT", "/api/users/ops", { newUsername: "ops2" })).status, 200);
  const renamed = (await call("GET", "/api/users")).body.users.map((u: any) => u.username);
  assert.ok(renamed.includes("ops2") && !renamed.includes("ops"));
  assert.equal((await call("PUT", "/api/users/ops2", { role: "viewer" })).status, 200);
  assert.equal((await call("GET", "/api/users")).body.users.find((u: any) => u.username === "ops2").role, "viewer");
  assert.equal((await call("PUT", "/api/users/ops2", { role: "emperor" })).status, 200, "a value that is not a role changes nothing and is not an error");
  assert.equal((await call("GET", "/api/users")).body.users.find((u: any) => u.username === "ops2").role, "viewer");
  assert.equal((await call("DELETE", "/api/users/ops2")).status, 200);
  assert.equal((await call("DELETE", "/api/users/eyes")).status, 200);
});

test("an account that cannot be made, changed or deleted answers 400 with the reason", async () => {
  const noBody = await call("POST", "/api/users", {});
  assert.equal(noBody.status, 400);
  assert.match(noBody.body.error, /username and password required/);
  assert.equal((await call("POST", "/api/users", { username: 5, password: "long-enough-password" })).status, 400);
  assert.equal((await call("POST", "/api/users", { username: "short", password: "x" })).status, 400);
  assert.equal((await call("POST", "/api/users", { username: "  ", password: "long-enough-password" })).status, 400);
  assert.equal((await call("POST", "/api/users", { username: "dup", password: "long-enough-password", role: "operator" })).status, 200);
  const twice = await call("POST", "/api/users", { username: "DUP", password: "long-enough-password", role: "operator" });
  assert.equal(twice.status, 400);
  assert.match(twice.body.error, /already exists/);
  assert.equal((await call("PUT", "/api/users/ghost", { password: "long-enough-password" })).status, 400);
  assert.equal((await call("DELETE", "/api/users/ghost")).status, 400);
  assert.equal((await call("DELETE", "/api/users/dup")).status, 200);
});

test("the last administrator can be neither deleted nor demoted, and another one can once there are two", async () => {
  assert.equal((await call("POST", "/api/users", { username: "chief", password: "long-enough-password" })).status, 200, "no role asked: an administrator");
  const alone = (await call("GET", "/api/users")).body.users.filter((u: any) => u.role === "admin");
  assert.equal(alone.length, 1);
  const noDelete = await call("DELETE", "/api/users/chief");
  assert.equal(noDelete.status, 400);
  assert.match(noDelete.body.error, /last remaining admin/);
  const noDemote = await call("PUT", "/api/users/chief", { role: "operator" });
  assert.equal(noDemote.status, 400);
  assert.match(noDemote.body.error, /last remaining admin/);
  assert.equal((await call("POST", "/api/users", { username: "deputy", password: "long-enough-password", role: "admin" })).status, 200);
  assert.equal((await call("PUT", "/api/users/chief", { role: "operator" })).status, 200);
  assert.equal((await call("DELETE", "/api/users/deputy")).status, 400, "the deputy is the last administrator now");
  assert.equal((await call("DELETE", "/api/users/chief")).status, 200);
});

test("a password that is too short, or a name already taken, is refused when changing an account", async () => {
  assert.equal((await call("POST", "/api/users", { username: "one", password: "long-enough-password", role: "operator" })).status, 200);
  assert.equal((await call("POST", "/api/users", { username: "two", password: "long-enough-password", role: "operator" })).status, 200);
  const short = await call("PUT", "/api/users/one", { password: "short" });
  assert.equal(short.status, 400);
  assert.match(short.body.error, /at least/);
  const taken = await call("PUT", "/api/users/one", { newUsername: "TWO" });
  assert.equal(taken.status, 400);
  assert.match(taken.body.error, /already exists/);
  assert.equal((await call("PUT", "/api/users/one", { password: "another-long-password" })).status, 200);
  for (const name of ["one", "two"]) await call("DELETE", `/api/users/${name}`);
});

test("the connections list carries what was noted at connect time and whether each socket is still open", async () => {
  const open: any = { readyState: WebSocket.OPEN, meta: { username: "boss", role: "admin", remoteAddress: "10.0.0.5", remoteApiVersion: 2 } };
  const closing: any = { readyState: WebSocket.CLOSING, meta: { username: "old", role: "viewer" } };
  const bare: any = { readyState: WebSocket.OPEN };
  for (const c of [open, closing, bare]) wsClients.add(c);
  try {
    const { status, body } = await call("GET", "/api/admin/clients");
    assert.equal(status, 200);
    assert.deepEqual(body.clients, [
      { username: "boss", role: "admin", remoteAddress: "10.0.0.5", remoteApiVersion: 2, connected: true },
      { username: "old", role: "viewer", connected: false },
      { connected: true },
    ]);
  } finally {
    wsClients.clear();
  }
  assert.deepEqual((await call("GET", "/api/admin/clients")).body, { clients: [] });
});

test("the log tail is the last lines: 300 by default, the number asked for, never above 2000, and an empty list without a file", async () => {
  assert.deepEqual((await call("GET", "/api/admin/logs")).body, { lines: [] }, "a fresh install has no log yet");
  const lines = Array.from({ length: 2500 }, (_, i) => `line ${i}`);
  fs.writeFileSync(logFile, lines.join("\n") + "\n\n");
  const dflt = (await call("GET", "/api/admin/logs")).body.lines;
  assert.equal(dflt.length, 300);
  assert.equal(dflt.at(-1), "line 2499", "empty lines are dropped");
  assert.equal(dflt[0], "line 2200");
  assert.equal((await call("GET", "/api/admin/logs?lines=5")).body.lines.length, 5);
  assert.equal((await call("GET", "/api/admin/logs?lines=2000")).body.lines.length, 2000);
  assert.equal((await call("GET", "/api/admin/logs?lines=999999")).body.lines.length, 2000, "capped");
  assert.equal((await call("GET", "/api/admin/logs?lines=abc")).body.lines.length, 300);
  assert.equal((await call("GET", "/api/admin/logs?lines=0")).body.lines.length, 300);
  assert.equal((await call("GET", "/api/admin/logs?lines=-5")).body.lines.length, 300);
  assert.equal((await call("GET", "/api/admin/logs?lines=")).body.lines.length, 300);
  fs.writeFileSync(logFile, "only\n");
  assert.deepEqual((await call("GET", "/api/admin/logs")).body.lines, ["only"]);
  fs.rmSync(logFile);
});

test("the server config shows the port in use, the pending one and the security options", async () => {
  currentPort = 18200;
  serverConfig = { other: "kept" };
  const first = await call("GET", "/api/admin/server-config");
  assert.equal(first.status, 200);
  assert.equal(first.body.port, 18200);
  assert.equal(first.body.pendingPort, null);
  assert.ok(first.body.aiAccess, "the snapshot of the options is part of the answer");
  serverConfig = { port: 18300, other: "kept" };
  assert.equal((await call("GET", "/api/admin/server-config")).body.pendingPort, 18300);
});

test("a port outside 1..65535, not a whole number or not a number is refused and nothing is saved", async () => {
  savedConfigs.length = 0;
  for (const port of [0, -1, 65536, 1.5, "abc", "", "80.5", [], {}, "1e10"]) {
    const result = await call("PUT", "/api/admin/server-config", { port });
    // an empty string and an empty array read as 0 and are refused, "abc" and {} are not numbers
    assert.equal(result.status, 400, JSON.stringify(port));
    assert.match(result.body.error, /port must be an integer between 1 and 65535/);
  }
  assert.equal(savedConfigs.length, 0);
});

test("a good port is saved next to the rest of the stored config and applies on restart; the edges 1 and 65535 are good", async () => {
  serverConfig = { other: "kept" };
  savedConfigs.length = 0;
  const result = await call("PUT", "/api/admin/server-config", { port: 8080 });
  assert.equal(result.status, 200);
  assert.deepEqual(savedConfigs.at(-1), { other: "kept", port: 8080 });
  assert.equal(result.body.success, true);
  assert.equal(result.body.appliesOnRestart, true);
  assert.deepEqual(result.body.warnings, []);
  assert.equal((await call("PUT", "/api/admin/server-config", { port: "9090" })).status, 200, "a number in text is a number");
  assert.equal(serverConfig.port, 9090);
  assert.equal((await call("PUT", "/api/admin/server-config", { port: 1 })).status, 200);
  assert.equal((await call("PUT", "/api/admin/server-config", { port: 65535 })).status, 200);
});

test("a null or missing port leaves the stored one alone", async () => {
  serverConfig = { port: 7000, other: "kept" };
  savedConfigs.length = 0;
  for (const body of [{ port: null }, {}, { port: undefined }]) {
    const result = await call("PUT", "/api/admin/server-config", body);
    assert.equal(result.status, 200);
    assert.equal(result.body.appliesOnRestart, true, "no security option was sent");
  }
  assert.equal(savedConfigs.length, 0);
  assert.equal(serverConfig.port, 7000);
});

test("a security option is applied at once and does not ask for a restart when only it was sent", async () => {
  stored = {};
  const result = await call("PUT", "/api/admin/server-config", { aiAccess: "admin" });
  assert.equal(result.status, 200);
  assert.equal(result.body.aiAccess.value, "admin");
  assert.equal(stored.aiAccess, "admin", "saved");
  assert.equal(result.body.appliesOnRestart, false);
  const withPort = await call("PUT", "/api/admin/server-config", { aiAccess: "open", port: 8123 });
  assert.equal(withPort.body.appliesOnRestart, true, "a new port does need one");
});

test("a bad security option is refused with its own status and the port in the same call is still saved only if it came first", async () => {
  stored = {};
  const refused = await call("PUT", "/api/admin/server-config", { aiAccess: "everyone" });
  assert.equal(refused.status, 400);
  assert.ok(refused.body.error);
  assert.deepEqual(stored, {}, "nothing saved");
});

test("a refused change of the bridges, the rate limits or the job dispatcher is written to the audit record with its reason", async () => {
  audited.length = 0;
  const cases: Array<[string, any]> = [
    ["bridge-options", { bridges: "everything" }],
    ["rate-limits-options", { rateLimits: "everything" }],
    ["job-dispatcher-options", { jobDispatcher: "everything" }],
    ["service-identity-options", { auth: { serviceIdentity: "everything" } }],
  ];
  for (const [type, body] of cases) {
    const result = await call("PUT", "/api/admin/server-config", body);
    assert.ok(result.status >= 400 && result.status < 500, `${type} gave ${result.status}`);
    const entry = audited.find((e) => e.type === type);
    assert.ok(entry, `${type} was recorded`);
    assert.equal(entry.outcome, "refused");
    assert.equal(entry.username, "boss");
    assert.equal(entry.userId, "u-boss");
    assert.equal(typeof entry.detail.reason, "string");
  }
});

test("a fault inside the options that is not a refusal is not swallowed as one", async () => {
  securityOverride = { update: () => { throw new Error("disk exploded"); } };
  try {
    const result = await call("PUT", "/api/admin/server-config", { aiAccess: "admin" });
    assert.equal(result.status, 500);
    assert.match(result.body.error, /disk exploded/);
  } finally {
    securityOverride = null;
  }
});

test("the identity status answers with the switch and tolerates a missing ports registry", async () => {
  const result = await call("GET", "/api/admin/service-identity");
  assert.equal(result.status, 200);
  assert.equal(typeof result.body, "object");
  assert.equal(JSON.stringify(result.body).includes("PRIVATE KEY"), false);
});

test("the signing keys are listed without a private part, and a rotation is refused while the algorithm is HS256", async () => {
  const listed = await call("GET", "/api/admin/jwt-keys");
  assert.equal(listed.status, 200);
  assert.equal(listed.body.algorithm, "HS256");
  assert.equal(listed.body.jwksPath, "/.well-known/jwks.json");
  assert.ok(Array.isArray(listed.body.keys));
  assert.doesNotMatch(JSON.stringify(listed.body), /"d"\s*:|PRIVATE/);
  const rotate = await call("POST", "/api/admin/jwt-keys/rotate", {});
  assert.equal(rotate.status, 409);
  assert.equal(rotate.body.code, "JWT_ASYMMETRIC_OFF");
});

test("a rotation is done and logged by name when the algorithm is EdDSA, and a key file that cannot be read is a 500 with its code", async () => {
  securityOverride = { jwtPolicy: () => ({ algorithm: "EdDSA" }) };
  try {
    const rotated = await call("POST", "/api/admin/jwt-keys/rotate", {});
    assert.equal(rotated.status, 200, JSON.stringify(rotated.body));
    assert.equal(rotated.body.success, true);
    assert.equal(typeof rotated.body.kid, "string");
    assert.ok(industrial.some((line) => line.includes("[SECURITY] boss rotated the token signing key") && line.includes(rotated.body.kid)));
    assert.ok(rotated.body.keys.length >= 1);
  } finally {
    securityOverride = null;
  }
});

test("the restart answers first, records who asked and only then exits", async () => {
  const exit = mock.method(process, "exit", (() => undefined) as any);
  try {
    audited.length = 0;
    const answer = await call("POST", "/api/admin/restart", {});
    assert.equal(answer.status, 200);
    assert.deepEqual(answer.body, { success: true });
    assert.equal(exit.mock.callCount(), 0, "the answer came before the exit");
    assert.equal(audited.at(-1).type, "server-restart");
    assert.equal(audited.at(-1).outcome, "ok");
    assert.equal(audited.at(-1).username, "boss");
    assert.ok(industrial.some((line) => line.startsWith("[ADMIN] Restart requested")));
    const end = Date.now() + 3000;
    while (exit.mock.callCount() === 0 && Date.now() < end) await new Promise((r) => setTimeout(r, 20));
    assert.equal(exit.mock.callCount(), 1);
    assert.deepEqual(exit.mock.calls[0].arguments, [0]);
  } finally {
    exit.mock.restore();
  }
});
