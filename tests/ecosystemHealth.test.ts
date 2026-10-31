import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { EcosystemProjectStatus } from "../src/ecosystemStatus.ts";
import {
  DEFAULT_CERT_WARN_DAYS, DEFAULT_PROBE_TIMEOUT_MS, LastSeenMemory, buildEcosystemHealth, certWarnDaysFrom, certificateHealth, collectEcosystemHealth,
  fetchHealthDetail, probeTimeoutFrom, readCertificateNotAfter, type ProbeDetail,
} from "../src/ecosystemHealth.ts";
import { makeEcosystemHealthGate, registerEcosystemHealthRoutes } from "../src/routes/ecosystemHealthRoutes.ts";
import { SecurityConfig, SecurityConfigError, resolveEcosystemHealth, type SecurityFile } from "../src/securityConfig.ts";

const DAY = 86_400_000;
const T0 = Date.parse("2030-01-01T00:00:00.000Z"); // a simulated clock: nothing here reads the real time

function project(name: string, extra: Partial<EcosystemProjectStatus> = {}): EcosystemProjectStatus {
  return {
    name, role: "service", stack: null, maturity: null, family: "hydra", version: "1.0.0.0", deploymentTarget: null,
    servicePort: null, serviceHealthPath: null, serviceHost: null, systemdUnit: null, pid: null, activeState: null, subState: null, live: null, ...extra,
  };
}

function build(projects: EcosystemProjectStatus[], details: Record<string, ProbeDetail | "error">, over: Partial<Parameters<typeof buildEcosystemHealth>[0]> = {}) {
  return buildEcosystemHealth({
    available: true, projects, details: new Map(Object.entries(details)), now: T0, memory: new LastSeenMemory(),
    certificateNotAfterMs: undefined, certWarnDays: 30, admin: true, ...over,
  });
}

// ---- the states ------------------------------------------------------------------------------------------------------------------------------

test("a service that answers its health path with a ready report is ok; a degraded report is degraded; a failed one or a non-2xx answer is down", () => {
  const projects = [
    project("A", { servicePort: 1, serviceHealthPath: "/h" }), project("B", { servicePort: 2, serviceHealthPath: "/h" }),
    project("C", { servicePort: 3, serviceHealthPath: "/h" }), project("D", { servicePort: 4, serviceHealthPath: "/h" }),
  ];
  const report = build(projects, {
    A: { reachable: true, httpStatus: 200, reportedState: "READY", latencyMs: 4 }, B: { reachable: true, httpStatus: 200, reportedState: "DEGRADED" },
    C: { reachable: true, httpStatus: 200, reportedState: "FAILED" }, D: { reachable: true, httpStatus: 503 },
  });
  assert.deepEqual(report.services.map((s) => [s.name, s.state, s.reason]), [
    ["A", "ok", "health_ok"], ["B", "degraded", "health_degraded"], ["C", "down", "health_failed"], ["D", "down", "http_error"],
  ]);
  assert.equal(report.services[0].latency_ms, 4);
  assert.deepEqual(report.summary, { total: 4, ok: 1, degraded: 1, down: 2, unknown: 0, drift: 0 });
});

test("a port nobody answers on is down, unless its unit is active (then degraded); a service with only a unit follows the unit", () => {
  const report = build([
    project("P", { servicePort: 9 }), project("Q", { servicePort: 9, systemdUnit: "q.service", activeState: "active" }),
    project("U1", { systemdUnit: "a.service", activeState: "active" }), project("U2", { systemdUnit: "b.service", activeState: "failed" }),
    project("U3", { systemdUnit: "c.service", activeState: "inactive" }), project("U4", { systemdUnit: "d.service", activeState: "activating" }),
    project("U5", { systemdUnit: "e.service", activeState: null }),
  ], { P: { reachable: false }, Q: { reachable: false } });
  const by = Object.fromEntries(report.services.map((s) => [s.name, [s.state, s.reason]]));
  assert.deepEqual(by, {
    P: ["down", "unreachable"], Q: ["degraded", "unreachable_unit_active"], U1: ["ok", "unit_active"], U2: ["down", "unit_failed"],
    U3: ["down", "unit_inactive"], U4: ["degraded", "unit_starting"], U5: ["unknown", "no_signal"],
  });
});

test("a probe that threw makes that service unknown and the others are reported as usual; a project with no service is not listed", () => {
  const report = build([project("Lib"), project("Bad", { servicePort: 5 }), project("Fine", { servicePort: 6 })], { Bad: "error", Fine: { reachable: true } });
  assert.deepEqual(report.services.map((s) => [s.name, s.state, s.reason]), [["Bad", "unknown", "probe_error"], ["Fine", "ok", "health_ok"]]);
});

// ---- versions, last heard from, warnings ---------------------------------------------------------------------------------------------------

test("the reported version is compared with the one of the manifest and a difference is drift; an unknown side is never drift", () => {
  const report = build(
    [project("Same", { servicePort: 1, version: "1.2.3.4" }), project("Old", { servicePort: 2, version: "1.2.3.4" }), project("Mute", { servicePort: 3, version: "1.2.3.4" }), project("NoManifest", { servicePort: 4, version: null })],
    {
      Same: { reachable: true, reportedVersion: "1.2.3.4" }, Old: { reachable: true, reportedVersion: "1.2.2.0" },
      Mute: { reachable: true }, NoManifest: { reachable: true, reportedVersion: "9.9.9.9" },
    },
  );
  assert.deepEqual(report.services.map((s) => [s.name, s.drift]), [["Mute", false], ["NoManifest", false], ["Old", true], ["Same", false]]);
  assert.equal(report.summary.drift, 1);
  assert.deepEqual(report.warnings, [{ code: "version_drift", service: "Old" }]);
});

test("the time of the last answer is kept between reports and does not move while the service is down", () => {
  const memory = new LastSeenMemory();
  const svc = [project("S", { servicePort: 7 })];
  const first = build(svc, { S: { reachable: true } }, { memory, now: T0 });
  assert.equal(first.services[0].last_seen_utc, new Date(T0).toISOString());
  const later = build(svc, { S: { reachable: false } }, { memory, now: T0 + 90_000 });
  assert.equal(later.services[0].state, "down");
  assert.equal(later.services[0].last_seen_utc, new Date(T0).toISOString());
  assert.equal(build(svc, { S: { reachable: false } }, { now: T0 }).services[0].last_seen_utc, null);
});

test("an operator does not get the port, path, unit or active state of a service; an administrator does", () => {
  const svc = [project("S", { servicePort: 7, serviceHealthPath: "/h", systemdUnit: "s.service", activeState: "active" })];
  const asAdmin = build(svc, { S: { reachable: true } }, { admin: true }).services[0];
  assert.deepEqual([asAdmin.port, asAdmin.health_path, asAdmin.systemd_unit, asAdmin.active_state], [7, "/h", "s.service", "active"]);
  const asOperator = build(svc, { S: { reachable: true } }, { admin: false });
  const text = JSON.stringify(asOperator);
  for (const key of ["\"port\"", "health_path", "systemd_unit", "active_state", "127.0.0.1", "s.service"]) assert.ok(!text.includes(key), key);
});

// ---- the certificate, with a simulated clock ----------------------------------------------------------------------------------------------

test("the certificate is ok far from its end, expiring inside the warning window and expired after it, by whole days", () => {
  const end = T0 + 100 * DAY;
  assert.deepEqual(certificateHealth(end, T0, 30), { state: "ok", not_after_utc: new Date(end).toISOString(), days_left: 100, warn_days: 30 });
  assert.equal(certificateHealth(end, end - 31 * DAY, 30).state, "ok");
  assert.equal(certificateHealth(end, end - 29 * DAY - 1, 30).state, "expiring");
  assert.equal(certificateHealth(end, end - 29 * DAY - 1, 30).days_left, 29);
  assert.equal(certificateHealth(end, end - 1, 30).state, "expiring");
  assert.equal(certificateHealth(end, end, 30).state, "expired");
  assert.equal(certificateHealth(end, end + 3 * DAY, 30).days_left, -3);
  assert.deepEqual(certificateHealth(null, T0, 30), { state: "unreadable", not_after_utc: null, days_left: null, warn_days: 30 });
});

test("the report warns of an expiring, expired or unreadable certificate and says nothing when the server has none", () => {
  const code = (notAfter: number | null | undefined, now = T0) => build([], {}, { certificateNotAfterMs: notAfter, now }).warnings.map((w) => w.code);
  assert.deepEqual(code(undefined), []);
  assert.equal(build([], {}, { certificateNotAfterMs: undefined }).certificate, null);
  assert.deepEqual(code(T0 + 200 * DAY), []);
  assert.deepEqual(code(T0 + 10 * DAY), ["certificate_expiring"]);
  assert.deepEqual(code(T0 - DAY), ["certificate_expired"]);
  assert.deepEqual(code(null), ["certificate_unreadable"]);
});

test("a real certificate file is read for its end date, and a file that is not a certificate is unreadable", () => {
  const fixture = path.join(import.meta.dirname, "fixtures", "test_certificate.pem");
  const notAfter = readCertificateNotAfter(fixture);
  assert.ok(notAfter !== null && notAfter > Date.parse("2100-01-01"));
  const junk = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "hydra-cert-")), "junk.pem");
  fs.writeFileSync(junk, "not a certificate");
  assert.equal(readCertificateNotAfter(junk), null);
  assert.equal(readCertificateNotAfter(path.join(os.tmpdir(), "hydra-no-such-certificate.pem")), null);
});

test("the configured limits fall back to the defaults when they are not whole numbers in range", () => {
  assert.equal(certWarnDaysFrom(14), 14);
  assert.equal(probeTimeoutFrom(500), 500);
  for (const bad of [0, 366, 1.5, "30", null, undefined]) assert.equal(certWarnDaysFrom(bad), DEFAULT_CERT_WARN_DAYS, String(bad));
  for (const bad of [99, 10_001, 2.5, "500", null, undefined]) assert.equal(probeTimeoutFrom(bad), DEFAULT_PROBE_TIMEOUT_MS, String(bad));
});

// ---- simulated services (local servers) ---------------------------------------------------------------------------------------------------

function listen(handler: http.RequestListener): Promise<{ server: http.Server; port: number }> {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, "127.0.0.1", () => resolve({ server, port: (server.address() as net.AddressInfo).port }));
  });
}

test("the health detail reads state and version from the body, ignores a body that is not JSON, a huge one or a version with odd characters, and times out", async () => {
  const served = await listen((req, res) => {
    if (req.url === "/ready") { res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ state: "ready", version: "2.0.0.1", secret: "x" })); return; }
    if (req.url === "/text") { res.end("hello"); return; }
    if (req.url === "/huge") { res.end(JSON.stringify({ state: "READY", pad: "x".repeat(40_000) })); return; }
    if (req.url === "/odd") { res.end(JSON.stringify({ version: "1.0 <script>" })); return; }
    if (req.url === "/error") { res.statusCode = 500; res.end(JSON.stringify({ state: "FAILED" })); return; }
    // /hang never answers
  });
  try {
    const ready = await fetchHealthDetail(served.port, "/ready", 1000);
    assert.equal(ready.reachable, true);
    assert.equal(ready.httpStatus, 200);
    assert.equal(ready.reportedState, "READY");
    assert.equal(ready.reportedVersion, "2.0.0.1");
    assert.ok(!("secret" in ready));
    assert.deepEqual({ ...(await fetchHealthDetail(served.port, "/text", 1000)), latencyMs: 0 }, { reachable: true, httpStatus: 200, latencyMs: 0 });
    const huge = await fetchHealthDetail(served.port, "/huge", 1000);
    assert.equal(huge.reportedState, undefined);
    assert.equal((await fetchHealthDetail(served.port, "/odd", 1000)).reportedVersion, undefined);
    assert.equal((await fetchHealthDetail(served.port, "/error", 1000)).httpStatus, 500);
    const started = Date.now();
    assert.deepEqual(await fetchHealthDetail(served.port, "/hang", 150), { reachable: false });
    assert.ok(Date.now() - started < 1500, "the timeout ended the wait");
  } finally {
    served.server.closeAllConnections();
    served.server.close();
  }
  assert.deepEqual(await fetchHealthDetail(served.port, "/ready", 300), { reachable: false });
});

test("collecting asks every declared service once, keeps going when one is dead or hangs, and never touches a project without a service", async () => {
  const good = await listen((_req, res) => { res.end(JSON.stringify({ state: "READY", version: "1.0.0.0" })); });
  const old = await listen((_req, res) => { res.end(JSON.stringify({ state: "READY", version: "0.9.0.0" })); });
  const hung = await listen(() => { /* never answers */ });
  const raw = net.createServer((socket) => socket.end());
  await new Promise<void>((resolve) => raw.listen(0, "127.0.0.1", resolve));
  const rawPort = (raw.address() as net.AddressInfo).port;
  const dead = await listen(() => undefined);
  const deadPort = dead.port;
  dead.server.close();
  const projects = [
    project("Good", { servicePort: good.port, serviceHealthPath: "/h", version: "1.0.0.0" }),
    project("Old", { servicePort: old.port, serviceHealthPath: "/h", version: "1.0.0.0" }),
    project("Hung", { servicePort: hung.port, serviceHealthPath: "/h" }),
    project("Raw", { servicePort: rawPort }),
    project("Dead", { servicePort: deadPort, serviceHealthPath: "/h" }),
    project("Library"),
  ];
  let clock = T0;
  try {
    const started = Date.now();
    const report = await collectEcosystemHealth({
      getStatus: async () => ({ available: true, projects }), now: () => clock, memory: new LastSeenMemory(),
      certificatePath: () => null, certWarnDays: () => undefined, probeTimeoutMs: () => 250,
    }, false);
    assert.ok(Date.now() - started < 3000, "one timeout window in all, not one per service");
    const by = Object.fromEntries(report.services.map((s) => [s.name, [s.state, s.reason, s.drift]]));
    assert.deepEqual(by, {
      Dead: ["down", "unreachable", false], Good: ["ok", "health_ok", false], Hung: ["down", "unreachable", false],
      Old: ["ok", "health_ok", true], Raw: ["ok", "health_ok", false],
    });
    assert.equal(report.generated_at_utc, new Date(T0).toISOString());
    assert.deepEqual(report.warnings.map((w) => `${w.code}:${w.service}`).sort(), ["service_down:Dead", "service_down:Hung", "version_drift:Old"]);
  } finally {
    for (const s of [good.server, old.server, hung.server]) { s.closeAllConnections(); s.close(); }
    raw.close();
  }
});

test("when the scan of the ecosystem itself fails the answer is available false with no services, and a certificate that cannot be read is reported, not thrown", async () => {
  const memory = new LastSeenMemory();
  const failed = await collectEcosystemHealth({ getStatus: async () => { throw new Error("boom"); }, memory, certificatePath: () => null, certWarnDays: () => 30, probeTimeoutMs: () => 200 }, true);
  assert.equal(failed.available, false);
  assert.deepEqual(failed.services, []);
  const bad = await collectEcosystemHealth({
    getStatus: async () => ({ available: true, projects: [] }), memory, certificatePath: () => "/x", readCertificate: () => { throw new Error("no"); }, certWarnDays: () => 30, probeTimeoutMs: () => 200,
  }, true);
  assert.equal(bad.certificate?.state, "unreadable");
  const sim = await collectEcosystemHealth({
    getStatus: async () => ({ available: true, projects: [] }), memory, now: () => T0, certificatePath: () => "/x", readCertificate: () => T0 + 5 * DAY, certWarnDays: () => 30, probeTimeoutMs: () => 200,
  }, true);
  assert.equal(sim.certificate?.state, "expiring");
  assert.equal(sim.certificate?.days_left, 5);
});

// ---- the route and the switch -------------------------------------------------------------------------------------------------------------------

function routeApp(enabled: () => boolean, collected: boolean[] = []) {
  const routes = new Map<string, any[]>();
  const app: any = { get(route: string, ...handlers: any[]) { routes.set(`GET ${route}`, handlers); } };
  const authenticate = () => undefined;
  const requireOperator = () => undefined;
  registerEcosystemHealthRoutes(app, {
    authenticate, requireOperator, ecosystemHealthGate: makeEcosystemHealthGate(enabled),
    collect: async (admin) => { collected.push(admin); return build([project("S", { servicePort: 1 })], { S: { reachable: true } }, { admin }); },
  });
  const handlers = routes.get("GET /api/ecosystem/health")!;
  const run = async (role: string) => {
    const out: { status: number; body?: any; ended?: boolean } = { status: 200 };
    const res: any = { status(code: number) { out.status = code; return res; }, json(value: any) { out.body = value; return res; }, end() { out.ended = true; return res; } };
    const req: any = { user: { role } };
    // the guards in order: authenticate, the gate, requireOperator, the handler
    let reachedHandler = false;
    await new Promise<void>((resolve) => {
      handlers[1](req, res, () => { reachedHandler = true; resolve(); });
      if (!reachedHandler) resolve();
    });
    if (reachedHandler) await handlers[3](req, res);
    return out;
  };
  return { run, handlers };
}

test("the route needs the sign-in, the gate and an operator, in that order, and answers 404 while the switch is off", async () => {
  let on = false;
  const collected: boolean[] = [];
  const t = routeApp(() => on, collected);
  assert.equal(t.handlers.length, 4);
  assert.deepEqual(await t.run("admin"), { status: 404, ended: true });
  assert.deepEqual(collected, []);
  on = true;
  const asOperator = await t.run("operator");
  assert.equal(asOperator.status, 200);
  assert.equal(asOperator.body.schema_version, "1.0");
  assert.equal(asOperator.body.services[0].port, undefined);
  const asAdmin = await t.run("admin");
  assert.equal(asAdmin.body.services[0].port, 1);
  assert.deepEqual(collected, [false, true]);
});

test("a scan that throws is a 503 and concurrent requests share one scan", async () => {
  const app: any = { get(_r: string, ...h: any[]) { (app as any).h = h; } };
  let calls = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  registerEcosystemHealthRoutes(app, { authenticate: () => undefined, requireOperator: () => undefined, ecosystemHealthGate: () => undefined, collect: async () => { calls += 1; await gate; return build([], {}); } });
  const reply = () => { const out: any = {}; const res: any = { json(v: any) { out.body = v; return res; }, status(c: number) { out.status = c; return res; } }; return { out, res }; };
  const a = reply(), b = reply();
  const pa = app.h[3]({ user: { role: "admin" } }, a.res), pb = app.h[3]({ user: { role: "admin" } }, b.res);
  release();
  await Promise.all([pa, pb]);
  assert.equal(calls, 1);
  assert.equal(a.out.body.schema_version, "1.0");

  const failing: any = { get(_r: string, ...h: any[]) { failing.h = h; } };
  registerEcosystemHealthRoutes(failing, { authenticate: () => undefined, requireOperator: () => undefined, ecosystemHealthGate: () => undefined, collect: async () => { throw new Error("x"); } });
  const f = reply();
  await failing.h[3]({ user: { role: "operator" } }, f.res);
  assert.equal(f.out.status, 503);
});

function makeConfig(env: any = {}, initial: SecurityFile = {}) {
  let stored: SecurityFile = { ...initial };
  const logs: string[] = [];
  const config = new SecurityConfig({ env, load: () => ({ ...stored }), save: (file) => { stored = { ...file }; }, tlsActive: false, log: (m) => logs.push(m) });
  return { config, logs, stored: () => stored };
}

test("the switch is off by default, only the exact word 1 turns it on from the environment, and the environment wins", () => {
  const { config } = makeConfig();
  assert.equal(config.ecosystemHealthEnabled(), false);
  assert.deepEqual(config.snapshot().ecosystemHealth.enabled, { value: false, source: "default" });
  assert.equal(makeConfig({ ecosystemHealth: "1" }).config.ecosystemHealthEnabled(), true);
  for (const word of ["true", "yes", "on", "0", ""]) assert.equal(makeConfig({ ecosystemHealth: word }).config.ecosystemHealthEnabled(), false, word);
  assert.deepEqual(resolveEcosystemHealth(undefined, { ecosystemHealth: { enabled: true } }), { value: true, source: "config" });
  assert.equal(resolveEcosystemHealth("0", { ecosystemHealth: { enabled: true } }).value, false);
});

test("an administrator can turn the health route on and off from the saved options; it is logged, keeps the other saved values and is locked by the environment", () => {
  const { config, logs, stored } = makeConfig({}, { ecosystemHealth: { certWarnDays: 14, probeTimeoutMs: 900 } });
  const on = config.update({ ecosystemHealth: { enabled: true } }, "root");
  assert.deepEqual(on.warnings, []);
  assert.equal(config.ecosystemHealthEnabled(), true);
  assert.deepEqual(stored().ecosystemHealth, { enabled: true, certWarnDays: 14, probeTimeoutMs: 900 });
  assert.match(logs.at(-1)!, /health of the ecosystem.*on/);
  config.update({ ecosystemHealth: { enabled: false } }, "root");
  assert.equal(config.ecosystemHealthEnabled(), false);
  const bad400 = (e: unknown) => e instanceof SecurityConfigError && e.status === 400;
  for (const value of ["yes", 1, null]) assert.throws(() => config.update({ ecosystemHealth: { enabled: value } }, "root"), bad400);
  assert.throws(() => config.update({ ecosystemHealth: [] }, "root"), bad400);
  assert.throws(() => makeConfig({ ecosystemHealth: "1" }).config.update({ ecosystemHealth: { enabled: false } }, "root"), (e: unknown) => e instanceof SecurityConfigError && e.status === 409 && /ECOSYSTEM_HEALTH/.test(e.message));
});
