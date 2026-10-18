// =============================================================================
// HYDRA-UMC-SERVER - Hardening contract checks
// Copyright (C) 2026 JuanenRac (Electro Hobby 3D) <electrohobby3d@gmail.com>
// GPL-3.0 - see LICENSE
// =============================================================================
// Against a real running server (the same real-server, no-browser pattern as every tools/verify_*_contract.mjs): an operator never receives the credentials of the IP cameras
// (REST and WebSocket), a save with a stale If-Match is refused with 409, the pictures of the cameras and the read-only host information demand a ticket or a token when the
// installation says so, a power request that a proxy or another origin made is refused (never an actual reboot: only refusals are sent), and a WebSocket token in the
// subprotocol opens the connection.

import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { WebSocket } from "ws";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TSX_CLI = path.join(ROOT, "node_modules", "tsx", "dist", "cli.mjs");
const SERVER_SOURCE = path.join(ROOT, "src", "server.ts");
const ADMIN = { username: "hardening-admin", password: "hardening-admin-password-1" };
const OPERATOR = { username: "hardening-operator", password: "hardening-operator-password-1" };

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitUntil(fn, { timeoutMs = 20000, intervalMs = 100, message = "condition" } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const result = await fn();
    if (result) return result;
    if (Date.now() > deadline) throw new Error(`timed out waiting for: ${message}`);
    await sleep(intervalMs);
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
  const response = await fetch(`http://127.0.0.1:${port}${route}`, { ...options, headers: { "content-type": "application/json", ...(options.headers ?? {}) } });
  const text = await response.text();
  let body = null;
  try { body = JSON.parse(text); } catch { body = text; }
  return { response, body };
}

async function main() {
  const temporaryDirectory = await mkdtemp(path.join(tmpdir(), "hydra-umc-server-hardening-"));
  const port = await reservePort();
  let child;
  let logs = "";
  try {
    await mkdir(path.join(temporaryDirectory, "data"), { recursive: true });
    await writeFile(path.join(temporaryDirectory, "data", "settings.json"), JSON.stringify({
      settings: { serverName: "HYDRA-UMC hardening contract" },
      controllers: [{ id: "hardening-controller", name: "Hardening Controller", cameras: [{ id: 1, name: "cam", ipHost: "10.0.0.5", ipUsername: "cam-user", ipPassword: "cam-secret-123" }], robots: [] }],
    }));
    child = spawn(process.execPath, [TSX_CLI, SERVER_SOURCE], {
      cwd: temporaryDirectory,
      env: {
        ...process.env, PORT: String(port), NODE_ENV: "test", JWT_SECRET: "local-hardening-contract-verification-only-not-for-deployment",
        HYDRA_UMC_BOOTSTRAP_ADMIN_USERNAME: ADMIN.username, HYDRA_UMC_BOOTSTRAP_ADMIN_PASSWORD: ADMIN.password,
        HYDRA_UMC_INFO_AUTH: "required", LOGIN_RATE_LIMIT_MAX: "100",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.on("data", (chunk) => { logs += chunk; });
    child.stderr.on("data", (chunk) => { logs += chunk; });
    await waitUntil(async () => { try { return (await fetch(`http://127.0.0.1:${port}/api/hydra-info`)).ok; } catch { return false; } }, { message: "server to accept connections" })
      .catch((error) => { throw new Error(`${error.message}\nServer startup output:\n${logs || "<no output>"}`); });

    const admin = (await request(port, "/api/login", { method: "POST", body: JSON.stringify(ADMIN) })).body.token;
    assert.equal(typeof admin, "string");
    const adminHeaders = { authorization: `Bearer ${admin}` };
    assert.equal((await request(port, "/api/users", { method: "POST", headers: adminHeaders, body: JSON.stringify({ ...OPERATOR, role: "operator" }) })).response.status, 200, "operator created");
    const operator = (await request(port, "/api/login", { method: "POST", body: JSON.stringify(OPERATOR) })).body.token;
    const operatorHeaders = { authorization: `Bearer ${operator}` };

    // --- the credentials of the cameras: the administrator reads them, an operator does not (REST)
    const tree = (await request(port, "/api/settings", { headers: adminHeaders })).body;
    const saved = await request(port, "/api/settings", { method: "POST", headers: adminHeaders, body: JSON.stringify(tree) });
    assert.equal(saved.response.status, 200, `save failed: ${JSON.stringify(saved.body)}`);
    assert.match(saved.body.revision, /^[0-9a-f]{16}$/, "a save answers the new revision");

    const asAdmin = await request(port, "/api/settings", { headers: adminHeaders });
    assert.equal(JSON.stringify(asAdmin.body).includes("cam-secret-123"), true, "the administrator reads the camera password");
    const etag = asAdmin.response.headers.get("etag");
    assert.match(etag ?? "", /^"[0-9a-f]{16}"$/, "GET /api/settings carries the revision as an ETag");
    const asOperator = await request(port, "/api/settings", { headers: operatorHeaders });
    assert.equal(asOperator.response.status, 200);
    assert.equal(JSON.stringify(asOperator.body).includes("cam-secret-123"), false, "an operator never receives a camera password (REST)");
    assert.equal(JSON.stringify(asOperator.body).includes("cam-user"), false, "nor the camera user name");

    // --- the same over the WebSocket (the token as a subprotocol, which is also the way that keeps it out of the address)
    const received = await new Promise((resolve, reject) => {
      const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`, ["hydra.bearer", operator]);
      const timer = setTimeout(() => { socket.terminate(); reject(new Error("no WebSocket message")); }, 8000);
      socket.on("message", (data) => { clearTimeout(timer); const accepted = socket.protocol; socket.close(); resolve({ text: data.toString(), accepted }); });
      socket.on("error", (error) => { clearTimeout(timer); reject(error); });
    });
    assert.equal(received.accepted, "hydra.bearer", "the server answers the hydra.bearer subprotocol");
    assert.equal(received.text.includes("cam-secret-123"), false, "an operator never receives a camera password (WebSocket)");
    assert.equal(received.text.includes('"type":"settings"'), true, "the connection opened with the subprotocol token");

    // --- a token in the address of the WebSocket is refused by default (the opt-out is checked in verify_legacy_opt_out_contract.mjs)
    const refusedQuery = await new Promise((resolve, reject) => {
      const socket = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${encodeURIComponent(operator)}`);
      const messages = [];
      const timer = setTimeout(() => { socket.terminate(); reject(new Error("the query token connection was neither answered nor closed")); }, 8000);
      socket.on("message", (data) => messages.push(data.toString()));
      socket.on("close", (code) => { clearTimeout(timer); resolve({ code, messages }); });
      socket.on("error", (error) => { clearTimeout(timer); reject(error); });
    });
    assert.equal(refusedQuery.code, 1008, "/ws?token= is closed with 1008 by default");
    assert.equal(refusedQuery.messages.some((text) => text.includes('"type":"settings"')), false, "a query token never receives the settings");
    assert.match(refusedQuery.messages.join(" "), /hydra\.bearer/, "the refusal says which way to send the token");

    // --- a stale save is refused, a fresh one is accepted
    const stale = await request(port, "/api/settings", { method: "POST", headers: { ...adminHeaders, "if-match": '"0000000000000000"' }, body: JSON.stringify(tree) });
    assert.equal(stale.response.status, 409, "a save with a stale If-Match is refused");
    assert.match(stale.body.revision, /^[0-9a-f]{16}$/);
    const fresh = await request(port, "/api/settings", { method: "POST", headers: { ...adminHeaders, "if-match": etag }, body: JSON.stringify(tree) });
    assert.equal(fresh.response.status, 200, "a save with the current If-Match is accepted");

    // --- the pictures of the cameras and the read-only host information demand a ticket or a token
    assert.equal((await request(port, "/api/camera/1/stream")).response.status, 401, "a live picture without a ticket is refused");
    assert.equal((await request(port, "/api/camera/media/1/snapshots/none.jpg")).response.status, 401, "a saved photo without a ticket is refused");
    assert.equal((await request(port, "/api/camera/ticket", { method: "POST" })).response.status, 401, "a ticket is only issued to a signed-in client");
    const ticket = (await request(port, "/api/camera/ticket", { method: "POST", headers: operatorHeaders })).body;
    assert.equal(typeof ticket.ticket, "string");
    const withTicket = await request(port, `/api/camera/media/1/snapshots/none.jpg?ticket=${encodeURIComponent(ticket.ticket)}`);
    assert.equal(withTicket.response.status, 404, "with a ticket the request gets through to the file lookup (not found, not refused)");
    assert.equal((await request(port, "/api/camera/media/1/snapshots/none.jpg?ticket=forged.1.sig")).response.status, 401, "a forged ticket is refused");
    for (const route of ["/api/system/metrics", "/api/system/supervisor", "/api/ecosystem/status", "/api/models"]) {
      assert.equal((await request(port, route)).response.status, 401, `${route} asks for a token`);
      assert.notEqual((await request(port, route, { headers: operatorHeaders })).response.status, 401, `${route} answers a signed-in client`);
    }

    // --- a power request that a proxy or another origin made is refused (only refusals are sent: a plain request would reboot the machine)
    for (const headers of [{ "x-forwarded-for": "203.0.113.9" }, { origin: "https://evil.example" }, { "sec-fetch-site": "cross-site" }]) {
      for (const route of ["/api/system/reboot", "/api/system/shutdown"]) {
        assert.equal((await request(port, route, { method: "POST", headers })).response.status, 403, `${route} refuses ${Object.keys(headers)[0]}`);
      }
    }

    console.log("SERVER_HARDENING_CONTRACT=PASS camera_secrets_rest=1 camera_secrets_ws=1 ws_subprotocol=1 ws_query_token_refused=1 if_match=2 camera_tickets=5 info_auth=8 power_refusals=6");
  } finally {
    if (child && child.exitCode === null) {
      child.kill();
      await waitUntil(() => child.exitCode !== null, { timeoutMs: 5000, message: "server to stop" }).catch(() => {});
    }
    await rm(temporaryDirectory, { recursive: true, force: true }).catch(() => {});
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
