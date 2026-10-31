import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_STALE_AFTER_S, RobotLivenessTracker, staleAfterFrom } from "../src/robotLiveness.ts";
import { registerLivenessRoutes } from "../src/routes/livenessRoutes.ts";

const roster = () => ({
  controllers: [
    { id: "c1", robots: [{ id: 1, online: true }, { id: 2, online: true }] },
    { id: "c2", robots: [{ id: 3 }, { name: "no id" }] },
  ],
});

test("a robot with no news since the server started is unknown, even when its interface flag says online", () => {
  const tracker = new RobotLivenessTracker(() => 1_000_000);
  const report = tracker.report(roster(), 30);
  assert.deepEqual(report.robots.map((r) => [r.robot_id, r.state]), [[1, "unknown"], [2, "unknown"], [3, "unknown"]]);
  assert.equal(report.robots[0].last_update_utc, undefined);
  assert.equal(report.schema_version, "1.0");
  assert.equal(report.stale_after_s, 30);
});

test("news makes a robot live, and it goes stale once the news is older than the limit", () => {
  let now = 1_000_000;
  const tracker = new RobotLivenessTracker(() => now);
  tracker.touch(1, "state");
  tracker.touch(2, "heartbeat");
  now += 10_000;
  let report = tracker.report(roster(), 30);
  assert.deepEqual(report.robots.map((r) => [r.robot_id, r.state, r.age_s, r.source]), [[1, "live", 10, "state"], [2, "live", 10, "heartbeat"], [3, "unknown", undefined, undefined]]);
  now += 25_000;
  tracker.touch(2, "heartbeat");
  report = tracker.report(roster(), 30);
  assert.deepEqual(report.robots.map((r) => [r.robot_id, r.state]), [[1, "stale"], [2, "live"], [3, "unknown"]]);
  assert.equal(report.robots[0].last_update_utc, new Date(1_000_000).toISOString());
});

test("news about a robot that is not in the roster is not reported, and a bad id is ignored", () => {
  const tracker = new RobotLivenessTracker(() => 5);
  tracker.touch(99, "state");
  tracker.touch(Number.NaN, "state");
  assert.equal(tracker.report(roster(), 30).robots.length, 3);
  assert.deepEqual(tracker.report({}, 30).robots, []);
  assert.deepEqual(tracker.report({ controllers: "x" }, 30).robots, []);
});

test("the stale limit is a whole number of seconds in range; anything else gives the default", () => {
  assert.equal(staleAfterFrom(5), 5);
  assert.equal(staleAfterFrom(3600), 3600);
  for (const bad of [0, -1, 3601, 1.5, "30", null, undefined, Number.NaN]) assert.equal(staleAfterFrom(bad), DEFAULT_STALE_AFTER_S, String(bad));
});

function liveApp(limit: unknown) {
  const routes = new Map<string, any[]>();
  const app: any = {
    get(route: string, ...handlers: any[]) { routes.set(`GET ${route}`, handlers); },
    post(route: string, ...handlers: any[]) { routes.set(`POST ${route}`, handlers); },
  };
  const tracker = new RobotLivenessTracker();
  registerLivenessRoutes(app, { authenticate: () => undefined, requireOperator: () => undefined, getSettings: roster, tracker, staleAfterS: () => limit });
  const run = (key: string, req: any = {}) => {
    const out: { status: number; body?: any } = { status: 200 };
    const res: any = { status(code: number) { out.status = code; return res; }, json(value: any) { out.body = value; return res; } };
    const handlers = routes.get(key)!;
    handlers[handlers.length - 1]({ params: {}, ...req }, res);
    return out;
  };
  return { run, routes, tracker };
}

test("the heartbeat marks a known robot live and the list reports it with the configured limit", () => {
  const t = liveApp(12);
  assert.deepEqual(t.run("POST /api/robot/:id/heartbeat", { params: { id: "2" } }), { status: 200, body: { success: true } });
  const list = t.run("GET /api/robots/liveness").body;
  assert.equal(list.stale_after_s, 12);
  assert.deepEqual(list.robots.map((r: any) => [r.robot_id, r.state]), [[1, "unknown"], [2, "live"], [3, "unknown"]]);
});

test("the heartbeat of a robot that does not exist, or with a bad id, is a 404", () => {
  const t = liveApp(undefined);
  for (const id of ["99", "abc", "1.5", ""]) assert.equal(t.run("POST /api/robot/:id/heartbeat", { params: { id } }).status, 404, id);
  assert.equal(t.run("GET /api/robots/liveness").body.stale_after_s, DEFAULT_STALE_AFTER_S);
});

test("the heartbeat needs the sign-in and an operator, the list only the sign-in", () => {
  const t = liveApp(undefined);
  assert.equal(t.routes.get("POST /api/robot/:id/heartbeat")!.length, 3);
  assert.equal(t.routes.get("GET /api/robots/liveness")!.length, 2);
});
