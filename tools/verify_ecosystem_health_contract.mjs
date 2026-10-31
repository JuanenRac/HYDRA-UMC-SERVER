// =============================================================================
// HYDRA-UMC-SERVER - Health of the ecosystem: contract check
// Copyright (C) 2026 JuanenRac (Electro Hobby 3D) <electrohobby3d@gmail.com>
// GPL-3.0-or-later - see LICENSE
// =============================================================================
// Against a real running server and simulated services (local HTTP servers named by manifests in a temporary ecosystem root):
// GET /api/ecosystem/health looks as if it did not exist (404 for a signed-in client, 401 for the rest) until an administrator
// turns ecosystemHealth.enabled on (the environment wins and locks it); then an operator or an administrator reads every service as
// ok, degraded, down or unknown with its reported version and drift; a dead or hanging service never hides the others; an operator
// never sees a port, health path or unit; a viewer is refused; and nothing but the closed fields of a health body reaches the answer.

import assert from "node:assert/strict";
import http from "node:http";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TSX_CLI = path.join(ROOT, "node_modules", "tsx", "dist", "cli.mjs");
const SERVER_SOURCE = path.join(ROOT, "src", "server.ts");
const ADMIN = { username: "eco-health-admin", password: "eco-health-admin-password" };
const OPERATOR = { username: "eco-health-operator", password: "eco-health-operator-password" };
const VIEWER = { username: "eco-health-viewer", password: "eco-health-viewer-password" };

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

function simulatedService(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port }));
  });
}

async function withServer(env, run) {
  const directory = await mkdtemp(path.join(tmpdir(), "hydra-umc-server-ecohealth-"));
  const ecosystem = await mkdtemp(path.join(tmpdir(), "hydra-umc-ecosystem-"));
  const port = await reservePort();
  const sims = [];
  let child;
  try {
    await mkdir(path.join(directory, "data"), { recursive: true });
    await writeFile(path.join(directory, "data", "settings.json"), JSON.stringify({ settings: { serverName: "HYDRA-UMC ecosystem health contract" }, controllers: [] }));
    const healthy = await simulatedService((_req, res) => { res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ state: "READY", version: "1.0.0.0", password: "leak-me", token: "leak-me" })); });
    const degraded = await simulatedService((_req, res) => { res.end(JSON.stringify({ state: "DEGRADED", version: "2.0.0.0" })); });
    const drifted = await simulatedService((_req, res) => { res.end(JSON.stringify({ state: "READY", version: "3.0.0.0" })); });
    const hung = await simulatedService(() => { /* never answers */ });
    const dead = await simulatedService(() => undefined);
    const deadPort = dead.port;
    dead.server.close();
    sims.push(healthy.server, degraded.server, drifted.server, hung.server);
    const services = [
      ["HYDRA-UMC-ALPHA", healthy.port, "1.0.0.0"], ["HYDRA-UMC-BETA", degraded.port, "2.0.0.0"], ["HYDRA-UMC-GAMMA", drifted.port, "3.0.1.0"],
      ["HYDRA-UMC-HUNG", hung.port, "1.0.0.0"], ["HYDRA-UMC-DEAD", deadPort, "1.0.0.0"],
    ];
    for (const [name, servicePort, version] of services) {
      await mkdir(path.join(ecosystem, name), { recursive: true });
      await writeFile(path.join(ecosystem, name, "hydra-umc.project.json"), JSON.stringify({ name, family: "hydra", role: "service", version, service: { port: servicePort, health_path: "/health" } }));
    }
    await mkdir(path.join(ecosystem, "HYDRA-UMC-LIBRARY"), { recursive: true });
    await writeFile(path.join(ecosystem, "HYDRA-UMC-LIBRARY", "hydra-umc.project.json"), JSON.stringify({ name: "HYDRA-UMC-LIBRARY", family: "hydra", version: "0.1.0.0" }));
    child = spawn(process.execPath, [TSX_CLI, SERVER_SOURCE], {
      cwd: directory,
      env: {
        ...process.env, PORT: String(port), NODE_ENV: "test", JWT_SECRET: "local-eco-health-contract-verification-only-not-for-deployment",
        HYDRA_UMC_BOOTSTRAP_ADMIN_USERNAME: ADMIN.username, HYDRA_UMC_BOOTSTRAP_ADMIN_PASSWORD: ADMIN.password, LOGIN_RATE_LIMIT_MAX: "100",
        HYDRA_UMC_ECOSYSTEM_ROOT: ecosystem, HYDRA_UMC_PORTS_REGISTRY: "off", ...env,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.on("data", () => undefined);
    child.stderr.on("data", () => undefined);
    await waitUntil(async () => { try { return (await fetch(`http://127.0.0.1:${port}/api/hydra-info`)).ok; } catch { return false; } }, "server to accept connections");
    await run(port);
  } finally {
    if (child && child.exitCode === null) { child.kill(); await new Promise((resolve) => child.once("exit", resolve)); }
    for (const server of sims) { server.closeAllConnections(); server.close(); }
    await rm(directory, { recursive: true, force: true, maxRetries: 15, retryDelay: 200 }).catch(() => undefined);
    await rm(ecosystem, { recursive: true, force: true, maxRetries: 15, retryDelay: 200 }).catch(() => undefined);
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

async function main() {
  await withServer({}, async (port) => {
    const who = await accounts(port);

    // --- closed by default: 401 without a sign-in, 404 for everybody who is signed in
    assert.equal((await request(port, "/api/ecosystem/health")).response.status, 401);
    for (const headers of [who.admin, who.operator, who.viewer]) assert.equal((await request(port, "/api/ecosystem/health", { headers })).response.status, 404, "closed by default");
    const config = (await request(port, "/api/admin/server-config", { headers: who.admin })).body;
    assert.deepEqual(config.ecosystemHealth.enabled, { value: false, source: "default" });

    // --- an administrator turns it on; an operator cannot
    assert.equal((await put(port, who.operator, { ecosystemHealth: { enabled: true } })).response.status, 403);
    assert.equal((await put(port, who.admin, { ecosystemHealth: { enabled: "yes" } })).response.status, 400);
    const on = await put(port, who.admin, { ecosystemHealth: { enabled: true } });
    assert.equal(on.response.status, 200, JSON.stringify(on.body));
    assert.deepEqual(on.body.ecosystemHealth.enabled, { value: true, source: "config" });

    // --- the roles
    assert.equal((await request(port, "/api/ecosystem/health")).response.status, 401);
    assert.equal((await request(port, "/api/ecosystem/health", { headers: who.viewer })).response.status, 403, "a viewer is refused");

    // --- the report for an administrator
    const asAdmin = await request(port, "/api/ecosystem/health", { headers: who.admin });
    assert.equal(asAdmin.response.status, 200, JSON.stringify(asAdmin.body));
    const report = asAdmin.body;
    assert.equal(report.schema_version, "1.0");
    assert.equal(report.available, true);
    assert.equal(report.certificate, null, "this server runs without TLS");
    const by = Object.fromEntries(report.services.map((s) => [s.name, s]));
    assert.deepEqual(Object.keys(by).sort(), ["HYDRA-UMC-ALPHA", "HYDRA-UMC-BETA", "HYDRA-UMC-DEAD", "HYDRA-UMC-GAMMA", "HYDRA-UMC-HUNG"], "the library has no service and is not listed");
    assert.deepEqual([by["HYDRA-UMC-ALPHA"].state, by["HYDRA-UMC-ALPHA"].reason, by["HYDRA-UMC-ALPHA"].drift], ["ok", "health_ok", false]);
    assert.equal(by["HYDRA-UMC-ALPHA"].version_reported, "1.0.0.0");
    assert.ok(by["HYDRA-UMC-ALPHA"].last_seen_utc && by["HYDRA-UMC-ALPHA"].latency_ms >= 0);
    assert.deepEqual([by["HYDRA-UMC-BETA"].state, by["HYDRA-UMC-BETA"].reason], ["degraded", "health_degraded"]);
    assert.deepEqual([by["HYDRA-UMC-GAMMA"].state, by["HYDRA-UMC-GAMMA"].drift, by["HYDRA-UMC-GAMMA"].version_expected, by["HYDRA-UMC-GAMMA"].version_reported], ["ok", true, "3.0.1.0", "3.0.0.0"]);
    for (const name of ["HYDRA-UMC-HUNG", "HYDRA-UMC-DEAD"]) assert.deepEqual([by[name].state, by[name].reason, by[name].last_seen_utc], ["down", "unreachable", null], name);
    assert.deepEqual(report.summary, { total: 5, ok: 2, degraded: 1, down: 2, unknown: 0, drift: 1 });
    assert.deepEqual(report.warnings.map((w) => `${w.code}:${w.service ?? ""}`).sort(), ["service_degraded:HYDRA-UMC-BETA", "service_down:HYDRA-UMC-DEAD", "service_down:HYDRA-UMC-HUNG", "version_drift:HYDRA-UMC-GAMMA"]);
    assert.equal(typeof by["HYDRA-UMC-ALPHA"].port, "number", "an administrator sees the port");
    assert.equal(by["HYDRA-UMC-ALPHA"].health_path, "/health");
    assert.ok(!JSON.stringify(report).includes("leak-me"), "nothing from the body of a service but its state and version");

    // --- the report for an operator: the same states, no port, path or unit
    const asOperator = await request(port, "/api/ecosystem/health", { headers: who.operator });
    assert.equal(asOperator.response.status, 200);
    assert.deepEqual(asOperator.body.services.map((s) => [s.name, s.state]), report.services.map((s) => [s.name, s.state]));
    const text = JSON.stringify(asOperator.body);
    for (const word of ['"port"', "health_path", "systemd_unit", "active_state", "127.0.0.1"]) assert.ok(!text.includes(word), `an operator does not see ${word}`);

    // --- closed again
    assert.equal((await put(port, who.admin, { ecosystemHealth: { enabled: false } })).response.status, 200);
    assert.equal((await request(port, "/api/ecosystem/health", { headers: who.admin })).response.status, 404);
  });

  // --- the environment wins and locks the option
  await withServer({ HYDRA_UMC_ECOSYSTEM_HEALTH: "1" }, async (port) => {
    const who = await accounts(port);
    assert.equal((await request(port, "/api/ecosystem/health", { headers: who.operator })).response.status, 200);
    const locked = await put(port, who.admin, { ecosystemHealth: { enabled: false } });
    assert.equal(locked.response.status, 409);
    assert.match(locked.body.error, /HYDRA_UMC_ECOSYSTEM_HEALTH/);
  });
  console.log("SERVER_ECOSYSTEM_HEALTH_CONTRACT=PASS");
}

main().catch((error) => {
  console.error("SERVER_ECOSYSTEM_HEALTH_CONTRACT=FAIL", error instanceof Error ? error.stack : error);
  process.exitCode = 1;
});
