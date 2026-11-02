// =============================================================================
// HYDRA-UMC-SERVER - Signed tickets of the information routes: contract check
// Copyright (C) 2026 JuanenRac (Electro Hobby 3D) <electrohobby3d@gmail.com>
// GPL-3.0-or-later - see LICENSE
// =============================================================================
// Against a real running server: with the information routes closed to clients without a token (infoAuth) a ticket opens /metrics, the
// system metrics, the supervisor and the ecosystem status only once an administrator turned infoTickets.enabled on (the environment wins
// and locks it); until then POST /api/info/ticket looks as if it did not exist and a ticket in an address is ignored. A ticket opens
// nothing else, a ticket of the camera pictures opens nothing here, a tampered ticket is refused, and only an administrator can ask for
// a life longer than the default.

import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TSX_CLI = path.join(ROOT, "node_modules", "tsx", "dist", "cli.mjs");
const SERVER_SOURCE = path.join(ROOT, "src", "server.ts");
const ADMIN = { username: "info-tickets-admin", password: "info-tickets-admin-password" };
const OPERATOR = { username: "info-tickets-operator", password: "info-tickets-operator-password" };
const VIEWER = { username: "info-tickets-viewer", password: "info-tickets-viewer-password" };

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitUntil(fn, message) {
  const deadline = Date.now() + 15000;
  for (;;) {
    if (await fn()) return;
    if (Date.now() > deadline) throw new Error(`timed out waiting for: ${message}`);
    await wait(100);
  }
}
const reservePort = () => new Promise((resolve, reject) => {
  const server = createServer();
  server.once("error", reject);
  server.listen(0, "127.0.0.1", () => { const { port } = server.address(); server.close(() => resolve(port)); });
});
async function request(port, route, options = {}) {
  const response = await fetch(`http://127.0.0.1:${port}${route}`, { ...options, headers: { "content-type": "application/json", ...(options.headers ?? {}) } });
  return { response, body: await response.json().catch(() => null) };
}

async function withServer(env, run) {
  const directory = await mkdtemp(path.join(tmpdir(), "hydra-umc-server-infotickets-"));
  const port = await reservePort();
  let child;
  try {
    await mkdir(path.join(directory, "data"), { recursive: true });
    await writeFile(path.join(directory, "data", "settings.json"), JSON.stringify({ settings: { serverName: "HYDRA-UMC info tickets contract" }, controllers: [] }));
    await writeFile(path.join(directory, "data", "server-config.json"), JSON.stringify({ infoTickets: { maxTtlSeconds: 3600 } }));
    child = spawn(process.execPath, [TSX_CLI, SERVER_SOURCE], {
      cwd: directory,
      env: {
        ...process.env, PORT: String(port), NODE_ENV: "test", JWT_SECRET: "local-info-tickets-contract-verification-only-not-for-deployment",
        HYDRA_UMC_BOOTSTRAP_ADMIN_USERNAME: ADMIN.username, HYDRA_UMC_BOOTSTRAP_ADMIN_PASSWORD: ADMIN.password, LOGIN_RATE_LIMIT_MAX: "100",
        HYDRA_UMC_PORTS_REGISTRY: "off", ...env,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.on("data", () => undefined);
    child.stderr.on("data", () => undefined);
    await waitUntil(async () => { try { return (await fetch(`http://127.0.0.1:${port}/api/hydra-info`)).ok; } catch { return false; } }, "server to accept connections");
    await run(port);
  } finally {
    if (child && child.exitCode === null) { child.kill(); await new Promise((resolve) => child.once("exit", resolve)); }
    await rm(directory, { recursive: true, force: true, maxRetries: 15, retryDelay: 200 }).catch(() => undefined);
  }
}

async function accounts(port) {
  const login = async (credentials) => (await request(port, "/api/login", { method: "POST", body: JSON.stringify(credentials) })).body.token;
  const admin = { authorization: `Bearer ${await login(ADMIN)}` };
  for (const [account, role] of [[OPERATOR, "operator"], [VIEWER, "viewer"]]) {
    const created = await request(port, "/api/users", { method: "POST", headers: admin, body: JSON.stringify({ ...account, role }) });
    assert.equal(created.response.status, 200, `${role} created`);
  }
  return { admin, operator: { authorization: `Bearer ${await login(OPERATOR)}` }, viewer: { authorization: `Bearer ${await login(VIEWER)}` } };
}

const put = (port, headers, patch) => request(port, "/api/admin/server-config", { method: "PUT", headers, body: JSON.stringify(patch) });
const ROUTES = ["/metrics", "/api/system/metrics", "/api/system/supervisor", "/api/ecosystem/status"];
const status = async (port, route) => (await fetch(`http://127.0.0.1:${port}${route}`)).status;
const ticketLife = (ticket) => Number(ticket.split(".")[1]) - Math.floor(Date.now() / 1000);

async function main() {
  await withServer({}, async (port) => {
    const who = await accounts(port);

    // --- closed by default: the route does not exist
    assert.equal((await request(port, "/api/info/ticket", { method: "POST" })).response.status, 401);
    assert.equal((await request(port, "/api/info/ticket", { method: "POST", headers: who.admin, body: "{}" })).response.status, 404);
    const config = (await request(port, "/api/admin/server-config", { headers: who.admin })).body;
    assert.deepEqual(config.infoTickets.enabled, { value: false, source: "default" });

    // --- close the information routes to clients without a token: the tickets are still off, so a ticket-looking address opens nothing
    assert.equal((await put(port, who.admin, { infoAuth: true })).response.status, 200);
    for (const route of ROUTES) assert.equal(await status(port, route), 401, `${route} closed`);
    assert.equal(await status(port, "/metrics?ticket=anything.1.sig"), 401);

    // --- an administrator turns the tickets on; an operator cannot
    assert.equal((await put(port, who.operator, { infoTickets: { enabled: true } })).response.status, 403);
    assert.equal((await put(port, who.admin, { infoTickets: { enabled: "yes" } })).response.status, 400);
    const on = await put(port, who.admin, { infoTickets: { enabled: true } });
    assert.equal(on.response.status, 200, JSON.stringify(on.body));
    assert.deepEqual(on.body.infoTickets.enabled, { value: true, source: "config" });

    // --- issuing: a signed-in account only; only an administrator gets more than the default life
    assert.equal((await request(port, "/api/info/ticket", { method: "POST" })).response.status, 401);
    const viewerTicket = await request(port, "/api/info/ticket", { method: "POST", headers: who.viewer, body: JSON.stringify({ ttlSeconds: 3000 }) });
    assert.equal(viewerTicket.response.status, 200);
    assert.equal(viewerTicket.body.expiresInSeconds, 300, "a non-administrator never gets more than the default life");
    const adminTicket = await request(port, "/api/info/ticket", { method: "POST", headers: who.admin, body: JSON.stringify({ ttlSeconds: 3000 }) });
    assert.equal(adminTicket.body.expiresInSeconds, 3000);
    assert.ok(Math.abs(ticketLife(adminTicket.body.ticket) - 3000) <= 2);
    const tooLong = await request(port, "/api/info/ticket", { method: "POST", headers: who.admin, body: JSON.stringify({ ttlSeconds: 999999 }) });
    assert.equal(tooLong.body.expiresInSeconds, 3600, "the configured maximum caps the life");

    // --- the ticket opens the information routes and nothing else
    const ticket = encodeURIComponent(viewerTicket.body.ticket);
    for (const route of ROUTES) assert.equal(await status(port, `${route}?ticket=${ticket}`), 200, `${route} with a ticket`);
    assert.equal(await status(port, `/api/robots/liveness?ticket=${ticket}`), 401, "a ticket opens no other route");

    // --- a camera ticket opens nothing here; a tampered ticket is refused
    const camera = await request(port, "/api/camera/ticket", { method: "POST", headers: who.operator, body: "{}" });
    assert.equal(camera.response.status, 200);
    assert.equal(await status(port, `/metrics?ticket=${encodeURIComponent(camera.body.ticket)}`), 401, "a camera ticket is not an info ticket");
    const [user, expiry, signature] = viewerTicket.body.ticket.split(".");
    assert.equal(await status(port, `/metrics?ticket=${user}.${Number(expiry) + 3000}.${signature}`), 401, "a longer life is refused");
    assert.equal(await status(port, `/metrics?ticket=${user}.${expiry}.${signature.slice(0, -2)}xx`), 401);

    // --- closed again
    assert.equal((await put(port, who.admin, { infoTickets: { enabled: false } })).response.status, 200);
    assert.equal(await status(port, `/metrics?ticket=${ticket}`), 401, "a ticket stops working when the option is turned off");
    assert.equal((await request(port, "/api/info/ticket", { method: "POST", headers: who.admin, body: "{}" })).response.status, 404);
  });

  // --- the environment wins and locks the option
  await withServer({ HYDRA_UMC_INFO_TICKETS: "1" }, async (port) => {
    const who = await accounts(port);
    assert.equal((await request(port, "/api/info/ticket", { method: "POST", headers: who.operator, body: "{}" })).response.status, 200);
    const locked = await put(port, who.admin, { infoTickets: { enabled: false } });
    assert.equal(locked.response.status, 409);
    assert.match(locked.body.error, /HYDRA_UMC_INFO_TICKETS/);
  });
  console.log("SERVER_INFO_TICKETS_CONTRACT=PASS");
}

main().catch((error) => {
  console.error("SERVER_INFO_TICKETS_CONTRACT=FAIL", error instanceof Error ? error.stack : error);
  process.exitCode = 1;
});
