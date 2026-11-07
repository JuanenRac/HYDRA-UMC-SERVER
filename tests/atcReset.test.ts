// =============================================================================
// HYDRA-UMC-SERVER - Unit tests for the reset of the arm state of a tool changer
// Copyright (C) 2026 JuanenRac (Electro Hobby 3D) <electrohobby3d@gmail.com>
// GPL-3.0-or-later - see LICENSE
// =============================================================================
// POST /api/tool-arms/reset: off by default (404), an administrator only, a request that names the robot and the tool and repeats the robot id,
// and a reset that goes ahead only while the robot is stopped and every tool of it is reported disarmed and fresh. The safety zones service and the
// tool changer service are stand-ins here. Also the pure checks and the securityConfig switch.
import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import http from "node:http";
import { registerUpstreamRoutes } from "../src/routes/upstreamRoutes.ts";
import { armEntriesFrom, decideReset, parseResetRequest, resetRefusalText, robotMotionOf, type RobotMotion } from "../src/atcReset.ts";
import { resolveAtcReset } from "../src/securityConfig.ts";

type Handler = (req: any, res: any, next?: any) => Promise<unknown> | unknown;

const arm = (over: Record<string, unknown> = {}) => ({ robot: "arm-3", toolId: 4, armed: false, by: "token", seq: 1, ageSeconds: 2, stale: false, ...over });
const report = (arms: unknown[]) => ({ schema_version: "1.0", ttlSeconds: 30, arms, armedCount: 0, staleCount: 0 });

// ---- the pure checks

test("the request has exactly the robot, the tool and the robot id typed again", () => {
  assert.deepEqual(parseResetRequest({ robot: "arm-3", toolId: 4, confirm: "arm-3" }), { ok: true, request: { robot: "arm-3", toolId: 4 } });
  for (const body of [null, undefined, 3, "x", [], {}, { robot: "arm-3", toolId: 4 }, { robot: "arm-3", toolId: 4, confirm: "arm-3", extra: 1 }]) {
    assert.equal(parseResetRequest(body).ok, false, JSON.stringify(body));
  }
});

test("the request refuses a robot id or a tool that is out of range", () => {
  for (const robot of ["", " arm", "arm 3", ".arm", "a".repeat(65), 3, null]) assert.equal(parseResetRequest({ robot, toolId: 1, confirm: robot }).ok, false, String(robot));
  for (const toolId of [-1, 25, 1.5, "3", null, Number.NaN]) assert.equal(parseResetRequest({ robot: "a", toolId, confirm: "a" }).ok, false, String(toolId));
  assert.equal(parseResetRequest({ robot: "a".repeat(64), toolId: 24, confirm: "a".repeat(64) }).ok, true);
  assert.equal(parseResetRequest({ robot: "a", toolId: 0, confirm: "a" }).ok, true);
});

test("a confirmation that is not the robot id is a mismatch, even by case or a space", () => {
  for (const confirm of ["ARM-3", "arm-3 ", " arm-3", "", "arm", true, 3]) {
    const result = parseResetRequest({ robot: "arm-3", toolId: 4, confirm });
    assert.equal(result.ok, false);
    assert.equal((result as any).code, "CONFIRMATION_MISMATCH");
  }
});

test("the reset goes ahead only for a fresh, disarmed tool of a stopped robot", () => {
  const request = { robot: "arm-3", toolId: 4 };
  const entries = armEntriesFrom(report([arm(), arm({ toolId: 5 })]))!;
  assert.deepEqual(decideReset(entries, request, "stopped"), { ok: true });
  assert.deepEqual(decideReset(entries, request, "moving"), { ok: false, reason: "moving" });
  assert.deepEqual(decideReset(entries, request, "unknown"), { ok: false, reason: "motion_unknown" });
  assert.deepEqual(decideReset(null, request, "stopped"), { ok: false, reason: "no_report" });
  assert.deepEqual(decideReset([], request, "stopped"), { ok: false, reason: "tool_not_reported" });
  assert.deepEqual(decideReset(entries, { robot: "arm-9", toolId: 4 }, "stopped"), { ok: false, reason: "tool_not_reported" });
});

test("an armed tool of the robot refuses the reset, whichever tool is named", () => {
  const request = { robot: "arm-3", toolId: 4 };
  assert.deepEqual(decideReset(armEntriesFrom(report([arm(), arm({ toolId: 5, armed: true })]))!, request, "stopped"), { ok: false, reason: "armed" });
  assert.deepEqual(decideReset(armEntriesFrom(report([arm({ armed: true })]))!, request, "stopped"), { ok: false, reason: "armed" });
  // the armed tool of ANOTHER robot does not matter
  assert.deepEqual(decideReset(armEntriesFrom(report([arm(), arm({ robot: "arm-7", armed: true })]))!, request, "stopped"), { ok: true });
});

test("an old report is never taken as safe", () => {
  const request = { robot: "arm-3", toolId: 4 };
  assert.deepEqual(decideReset(armEntriesFrom(report([arm({ stale: true })]))!, request, "stopped"), { ok: false, reason: "report_stale" });
  assert.deepEqual(decideReset(armEntriesFrom(report([arm(), arm({ toolId: 5, stale: true })]))!, request, "stopped"), { ok: false, reason: "report_stale" });
  assert.deepEqual(decideReset(armEntriesFrom(report([arm(), arm({ toolId: 5, stale: true, armed: true })]))!, request, "stopped"), { ok: false, reason: "armed" });
});

test("every refusal has its own sentence", () => {
  const reasons = ["no_report", "tool_not_reported", "report_stale", "armed", "moving", "motion_unknown"] as const;
  assert.equal(new Set(reasons.map(resetRefusalText)).size, reasons.length);
});

test("the arm state in an answer is read defensively", () => {
  assert.equal(armEntriesFrom(null), null);
  assert.equal(armEntriesFrom({}), null);
  assert.equal(armEntriesFrom({ arms: "x" }), null);
  assert.equal(armEntriesFrom({ arms: [null] }), null);
  assert.equal(armEntriesFrom({ arms: [{ robot: "a", toolId: "1", armed: false, stale: false }] }), null);
  assert.equal(armEntriesFrom({ arms: [{ robot: "a", toolId: 1, armed: "no", stale: false }] }), null);
  assert.deepEqual(armEntriesFrom({ arms: [] }), []);
});

test("the motion of a robot is looked up by id or name, and a robot that cannot be matched is unknown", () => {
  const settings = {
    controllers: [
      { id: "c1", robots: [{ id: 1, name: "arm-3", playbackState: { isPlaying: false } }, { id: 2, name: "lathe", playbackState: { isPlaying: true } }, { id: 3, name: "twin", playbackState: { isPaused: true } }, { id: 4, name: "dup" }] },
      { id: "c2", robots: [{ id: 5, name: "dup", playbackState: {} }] },
    ],
  };
  const motion = robotMotionOf(() => settings);
  assert.equal(motion("arm-3"), "stopped");
  assert.equal(motion("1"), "stopped");
  assert.equal(motion("lathe"), "moving");
  assert.equal(motion("twin"), "moving");
  assert.equal(motion("dup"), "unknown");
  assert.equal(motion("nobody"), "unknown");
  assert.equal(robotMotionOf(() => undefined)("arm-3"), "unknown");
});

test("the switch is off by default, the environment wins, and only the exact word 1 turns it on", () => {
  assert.deepEqual(resolveAtcReset(undefined, {}), { value: false, source: "default" });
  assert.deepEqual(resolveAtcReset("", { atc: { resetEnabled: true } }), { value: true, source: "config" });
  assert.deepEqual(resolveAtcReset("1", {}), { value: true, source: "env" });
  assert.deepEqual(resolveAtcReset(" 1 ", {}), { value: true, source: "env" });
  for (const word of ["0", "true", "yes", "on", "2"]) assert.deepEqual(resolveAtcReset(word, { atc: { resetEnabled: true } }), { value: false, source: "env" }, word);
});

// ---- the route, with stand-ins for the two services

interface Setup { enabled?: boolean; zones?: { status: number; body: unknown } | "down"; atc?: { status: number; body: unknown } | "down"; motion?: RobotMotion; addressed?: boolean; role?: "admin" | "viewer" }

async function setup(options: Setup = {}) {
  const routes: Record<string, Handler[]> = {};
  const app: any = { get() {}, put() {}, delete() {}, patch() {}, post(path: string, ...handlers: Handler[]) { routes[`POST ${path}`] = handlers; } };
  const seen: { service: string; method?: string; url?: string; authorization?: string; body?: string }[] = [];
  const serve = async (service: string, reply: { status: number; body: unknown } | "down" | undefined) => {
    const server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => { body += chunk; });
      req.on("end", () => {
        seen.push({ service, method: req.method, url: req.url, authorization: req.headers.authorization, body });
        res.writeHead(reply && reply !== "down" ? reply.status : 200, { "content-type": "application/json" });
        res.end(JSON.stringify(reply && reply !== "down" ? reply.body : {}));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as any).port;
    if (reply === "down") await new Promise<void>((resolve) => server.close(() => resolve()));
    return { port, server, down: reply === "down" };
  };
  const zones = await serve("zones", options.zones ?? { status: 200, body: report([arm()]) });
  const atc = await serve("atc", options.atc ?? { status: 200, body: { success: true } });
  const audit: any[] = [];
  const admin = (options.role ?? "admin") === "admin";
  registerUpstreamRoutes(app, {
    authenticate: ((req: any, _res: any, next: any) => { req.user = { id: "u1", username: "root", role: admin ? "admin" : "viewer" }; return next(); }) as any,
    requireAdmin: ((_req: any, res: any, next: any) => (admin ? next() : res.status(403).json({ error: "administrator required" }))) as any,
    industrialLog: () => {},
    wsClients: [],
    DATALAKE_URL: "", DATALAKE_TIMEOUT_MS: 1000, CONNECTOR_HUB_URL: "", CONNECTOR_HUB_TIMEOUT_MS: 1000,
    SPI_BRIDGE_URL: "", SPI_BRIDGE_VERSION_TIMEOUT_MS: 1000, SPI_BRIDGE_FLASH_TIMEOUT_MS: 1000,
    SAFETY_ZONES_URL: options.addressed === false ? "" : `http://127.0.0.1:${zones.port}`,
    ATC_URL: options.addressed === false ? "" : `http://127.0.0.1:${atc.port}`,
    atcResetEnabled: () => options.enabled === true,
    robotMotion: () => options.motion ?? "stopped",
    audit: { record: (event: any) => { audit.push(event); } },
  } as any);
  const call = async (body: unknown, headers: Record<string, string> = { authorization: "Bearer admin-token-value" }) => {
    const res: any = new EventEmitter();
    res.statusCode = 200;
    res.body = undefined;
    const done = new Promise<void>((resolve) => { res.once("finish", resolve); });
    res.status = (code: number) => { res.statusCode = code; return res; };
    res.json = (payload: unknown) => { res.body = payload; queueMicrotask(() => res.emit("finish")); return res; };
    const chain = routes["POST /api/tool-arms/reset"];
    assert.ok(chain, "the route is registered");
    const req: any = { headers, body, ip: "127.0.0.1" };
    const run = async (index: number): Promise<unknown> => (index >= chain.length ? undefined : chain[index](req, res, () => run(index + 1)));
    await run(0);
    await done;
    return res;
  };
  const stop = async () => { for (const s of [zones, atc]) if (!s.down) await new Promise<void>((resolve) => s.server.close(() => resolve())); };
  return { call, seen, audit, stop };
}

const GOOD = { robot: "arm-3", toolId: 4, confirm: "arm-3" };

test("while the switch is off the route answers 404 and nothing leaves the server", async () => {
  const t = await setup({ enabled: false });
  const res = await t.call(GOOD);
  assert.equal(res.statusCode, 404);
  assert.deepEqual(t.seen, []);
  assert.deepEqual(t.audit, []);
  await t.stop();
});

test("an account that is not an administrator is refused before anything else", async () => {
  const t = await setup({ enabled: true, role: "viewer" });
  const res = await t.call(GOOD);
  assert.equal(res.statusCode, 403);
  assert.deepEqual(t.seen, []);
  await t.stop();
});

test("a stopped, disarmed robot is reset with the administrator's own token, and the attempt is audited", async () => {
  const t = await setup({ enabled: true });
  const res = await t.call(GOOD);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { success: true, robot: "arm-3", toolId: 4 });
  assert.equal(t.seen.length, 2);
  assert.deepEqual([t.seen[0].service, t.seen[0].method, t.seen[0].url], ["zones", "GET", "/tool-arms"]);
  assert.deepEqual([t.seen[1].service, t.seen[1].method, t.seen[1].url], ["atc", "POST", "/atc/reset"]);
  assert.equal(t.seen[1].authorization, "Bearer admin-token-value");
  assert.deepEqual(JSON.parse(t.seen[1].body!), { robot: "arm-3", toolId: 4 });
  assert.equal(t.audit.length, 1);
  assert.deepEqual([t.audit[0].type, t.audit[0].outcome, t.audit[0].username], ["atc-reset", "ok", "root"]);
  await t.stop();
});

test("a request that does not repeat the robot id is refused before the services are asked", async () => {
  const t = await setup({ enabled: true });
  const res = await t.call({ robot: "arm-3", toolId: 4, confirm: "ARM-3" });
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.code, "CONFIRMATION_MISMATCH");
  assert.deepEqual(t.seen, []);
  assert.equal(t.audit[0].outcome, "refused");
  await t.stop();
});

test("an armed tool, a moving robot, an old report and an unknown motion are each refused with 409 and nothing is forwarded", async () => {
  const cases: [Setup, string][] = [
    [{ zones: { status: 200, body: report([arm({ armed: true })]) } }, "armed"],
    [{ motion: "moving" }, "moving"],
    [{ zones: { status: 200, body: report([arm({ stale: true })]) } }, "report_stale"],
    [{ motion: "unknown" }, "motion_unknown"],
    [{ zones: { status: 200, body: report([]) } }, "tool_not_reported"],
    [{ zones: { status: 404, body: { error: "no tool arms" } } }, "no_report"],
    [{ zones: { status: 200, body: { nonsense: true } } }, "no_report"],
  ];
  for (const [options, reason] of cases) {
    const t = await setup({ enabled: true, ...options });
    const res = await t.call(GOOD);
    assert.equal(res.statusCode, 409, reason);
    assert.equal(res.body.reason, reason);
    assert.deepEqual(t.seen.filter((s) => s.service === "atc"), [], `${reason}: the tool changer was not asked`);
    assert.deepEqual([t.audit[0].type, t.audit[0].outcome, t.audit[0].detail.reason], ["atc-reset", "refused", reason]);
    await t.stop();
  }
});

test("the safety zones service being down refuses the reset (409), never lets it through", async () => {
  const t = await setup({ enabled: true, zones: "down" });
  const res = await t.call(GOOD);
  assert.equal(res.statusCode, 409);
  assert.equal(res.body.reason, "no_report");
  assert.deepEqual(t.seen.filter((s) => s.service === "atc"), []);
  await t.stop();
});

test("a tool changer service that rejects the reset is a 502, and one that is down is a 503", async () => {
  let t = await setup({ enabled: true, atc: { status: 500, body: { error: "motor fault" } } });
  let res = await t.call(GOOD);
  assert.equal(res.statusCode, 502);
  assert.equal(res.body.error, "motor fault");
  assert.equal(t.audit[0].outcome, "failed");
  await t.stop();
  t = await setup({ enabled: true, atc: "down" });
  res = await t.call(GOOD);
  assert.equal(res.statusCode, 503);
  assert.equal(t.audit[0].outcome, "failed");
  await t.stop();
});

test("without the two addresses the route answers 503 and asks nobody", async () => {
  const t = await setup({ enabled: true, addressed: false });
  const res = await t.call(GOOD);
  assert.equal(res.statusCode, 503);
  assert.deepEqual(t.seen, []);
  await t.stop();
});

test("a request without a bearer token is refused with 401 after it has been checked", async () => {
  const t = await setup({ enabled: true });
  const res = await t.call(GOOD, {});
  assert.equal(res.statusCode, 401);
  assert.deepEqual(t.seen, []);
  await t.stop();
});
