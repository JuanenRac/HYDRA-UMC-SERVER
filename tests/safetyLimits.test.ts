import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { JogArming, SafetyLimits, SafetyLimitsError, defaultSafetyConfig, mergeSafetyConfig, modelKey } from "../src/safetyLimits.ts";
import { registerCommandRoutes } from "../src/routes/commandRoutes.ts";
import { registerRobotRoutes } from "../src/routes/robotRoutes.ts";
import { registerSafetyRoutes } from "../src/routes/safetyRoutes.ts";
import { claimConflict, readControllerId } from "../src/claimPolicy.ts";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "safety-"));
const alice = { id: "alice-id", username: "alice", role: "operator" };
const bob = { id: "bob-id", username: "bob", role: "operator" };
const root = { id: "root-id", username: "root", role: "admin" };
const active = (r: any) => !!r && r.expiresAt > Date.now();

test("the defaults are prudent and the arming is off", () => {
  const d = defaultSafetyConfig();
  assert.equal(d.jog.armRequired, false);
  assert.equal(d.jog.default.maxAmount, 100);
  assert.equal(d.temperature.default.bedMaxC, 110);
  assert.equal(d.claims.requireControllerId, false);
});

test("model names match without the parenthesis and case", () => {
  assert.equal(modelKey("Parol6 (6-DOF)"), "parol6");
  assert.equal(modelKey(" PAROL6 "), "parol6");
});

test("a change is validated: unknown keys, wrong types and values beyond the hard ceilings are refused", () => {
  const d = defaultSafetyConfig();
  for (const bad of [
    { nope: 1 }, { jog: { nope: 1 } }, { jog: { armRequired: "yes" } }, { jog: { default: { maxAmount: 0 } } },
    { jog: { default: { maxAmount: 1001 } } }, { jog: { default: { maxAbsolute: 10001 } } }, { jog: { armTtlMs: 10 } },
    { temperature: { default: { bedMaxC: 301 } } }, { temperature: { models: { x: { bedMaxC: -5 } } } },
    { claims: { requireControllerId: 1 } }, [], null, { jog: { models: [] } },
  ]) {
    assert.throws(() => mergeSafetyConfig(d, bad), SafetyLimitsError, JSON.stringify(bad));
  }
  const ok = mergeSafetyConfig(d, { jog: { models: { "Parol6 (6-DOF)": { maxAmount: 20 } }, armRequired: true }, temperature: { models: { faze4: { bedMaxC: 90 } } } });
  assert.equal(ok.jog.models["parol6"].maxAmount, 20);
  assert.equal(ok.jog.armRequired, true);
  assert.equal(ok.jog.default.maxAmount, 100);
});

test("the limits are saved through the store and survive a restart; the defaults come back for a damaged file", async () => {
  const dir = tmp();
  const a = new SafetyLimits(dir);
  await a.update({ jog: { models: { parol6: { maxAmount: 25 } } }, temperature: { default: { bedMaxC: 80 } } }, "root");
  const b = new SafetyLimits(dir);
  assert.equal(b.jogFor("Parol6 (6-DOF)").maxAmount, 25);
  assert.equal(b.jogFor("Faze4 (6-DOF)").maxAmount, 100);
  assert.equal(b.temperatureFor("anything").bedMaxC, 80);
  await assert.rejects(a.update({ jog: { default: { maxAmount: 5000 } } }, "root"), SafetyLimitsError);
  assert.equal(a.jogFor("x").maxAmount, 100);
  fs.writeFileSync(path.join(dir, "safety-limits.json"), "{ not json");
  const logs: string[] = [];
  assert.equal(new SafetyLimits(dir, (m) => logs.push(m)).jogFor("x").maxAmount, 100);
  assert.equal(logs.length, 1);
});

test("a heated-bed target above the limit of its model is lowered", async () => {
  const s = new SafetyLimits(tmp());
  await s.update({ temperature: { models: { parol6: { bedMaxC: 70 } } } }, "root");
  const tree = { controllers: [{ robots: [
    { id: 1, model: "Parol6 (6-DOF)", heatedBed: { targetTemp: 95 } },
    { id: 2, model: "Faze4 (6-DOF)", heatedBed: { targetTemp: 95 } },
    { id: 3, model: "Faze4 (6-DOF)", heatedBed: { targetTemp: 200 } },
    { id: 4, model: "Faze4 (6-DOF)" },
  ] }] };
  const changes = s.clampTemperatures(tree);
  assert.deepEqual(changes.map((c) => [c.robotId, c.applied]), [[1, 70], [3, 110]]);
  assert.equal(tree.controllers[0].robots[1].heatedBed!.targetTemp, 95);
});

test("the arming is bound to the account and the controller and expires", async () => {
  const a = new JogArming();
  a.arm(1, "u1", "tab-1", 1000);
  assert.equal(a.isArmed(1, "u1", "tab-1"), true);
  assert.equal(a.isArmed(1, "u2", "tab-1"), false);
  assert.equal(a.isArmed(1, "u1", "tab-2"), false);
  assert.equal(a.isArmed(1, "u1", undefined), false);
  a.disarm(1);
  assert.equal(a.isArmed(1, "u1", "tab-1"), false);
  a.arm(2, "u1", undefined, 1);
  await new Promise((r) => setTimeout(r, 15));
  assert.equal(a.isArmed(2, "u1", undefined), false);
});

test("claim policy: same account on another controller is refused, a claim without controller behaves as before", () => {
  const r = { ownerId: "a", ownerUsername: "alice", expiresAt: Date.now() + 1000, controllerId: "pc-1" };
  assert.equal(claimConflict(r, { id: "a" }, "pc-1", active), null);
  assert.equal(claimConflict(r, { id: "a" }, "pc-2", active)?.reason, "other-controller");
  assert.equal(claimConflict(r, { id: "a" }, undefined, active)?.reason, "controller-id-required");
  assert.equal(claimConflict(r, { id: "b" }, "pc-1", active)?.reason, "other-account");
  assert.equal(claimConflict({ ...r, controllerId: undefined }, { id: "a" }, undefined, active), null);
  assert.equal(claimConflict({ ...r, expiresAt: 1 }, { id: "b" }, undefined, active), null);
  assert.equal(readControllerId(undefined, undefined), undefined);
  assert.equal(readControllerId("tab 1", undefined), null);
  assert.equal(readControllerId("  pc-1 ", undefined), "pc-1");
  assert.equal(readControllerId(undefined, "x".repeat(65)), null);
});

function world(armRequired = false) {
  const settings: any = { controllers: [{ id: "c1", robots: [
    { id: 1, name: "A", model: "Parol6 (6-DOF)", pos: { x: 0, y: 0, z: 0, a: 0, b: 0, c: 0 }, joints: {}, playbackState: {} },
  ] }] };
  const robot = settings.controllers[0].robots[0];
  const safety = new SafetyLimits(tmp());
  const arming = new JogArming();
  const posts: Record<string, any> = {};
  const gets: Record<string, any> = {};
  const app: any = {
    post(route: string, ...h: unknown[]) { posts[route] = h[h.length - 1]; },
    get(route: string, ...h: unknown[]) { gets[route] = h[h.length - 1]; },
    put(route: string, ...h: unknown[]) { posts["PUT " + route] = h[h.length - 1]; },
  };
  const common = { authenticate: () => undefined, getSettings: () => settings, isReservationActive: active };
  registerCommandRoutes(app, { ...common, industrialLog: () => undefined, queueSettingsWrite: async () => undefined, broadcastRobotDelta: () => undefined, startServerPlayback: () => undefined, stopServerPlayback: () => undefined, safety, arming } as any);
  registerRobotRoutes(app, {
    ...common, findRobotById: (id: number) => (id === 1 ? robot : null), findControllerIdForRobot: () => "c1",
    appendReservationHistory: () => undefined, queueSettingsWrite: async () => undefined, broadcastRobotDelta: () => undefined,
    DEFAULT_RESERVATION_TTL_MS: 60_000, MAX_RESERVATION_TTL_MS: 600_000, safety, arming,
  } as any);
  registerSafetyRoutes(app, { ...common, requireAdmin: () => undefined, findRobotById: (id: number) => (id === 1 ? robot : null), safety, arming });
  const call = async (handler: any, req: any) => {
    let status = 200;
    let json: any;
    const res: any = { headers: {} as Record<string, string>, setHeader(k: string, v: string) { res.headers[k] = v; }, status(c: number) { status = c; return res; }, json(v: any) { json = v; return res; } };
    await handler({ headers: {}, body: {}, query: {}, ...req }, res);
    return { status, json };
  };
  const command = (user: any, body: any, headers: any = {}) => call(posts["/api/robot/:id/command"], { params: { id: "1" }, body, user, headers });
  const claim = (user: any, body: any = {}, headers: any = {}) => call(posts["/api/robot/:id/claim"], { params: { id: "1" }, body, user, headers });
  const release = (user: any, body: any = {}, headers: any = {}) => call(posts["/api/robot/:id/release"], { params: { id: "1" }, body, user, headers });
  const arm = (user: any, body: any, headers: any = {}) => call(posts["/api/robot/:id/jog-arm"], { params: { id: "1" }, body, user, headers });
  const claims = () => call(gets["/api/claims"], { user: alice });
  const limits = (robotId?: string) => call(gets["/api/safety-limits"], { user: alice, query: robotId ? { robotId } : {} });
  const putLimits = (body: any) => call(posts["PUT /api/admin/safety-limits"], { user: root, body });
  return { robot, settings, safety, command, claim, release, arm, claims, limits, putLimits };
}

test("a jog larger than the model limit is not applied and says so; an absolute jog has its own range", async () => {
  const w = world();
  const big = await w.command(alice, { command: "jog", params: { axis: "x", amount: 150 } });
  assert.equal(big.status, 200);
  assert.equal(big.json.warnings[0].field, "jog");
  assert.equal(w.robot.pos.x, 0);
  assert.equal((await w.command(alice, { command: "jog", params: { axis: "x", amount: 100 } })).json.warnings, undefined);
  assert.equal(w.robot.pos.x, 100);
  assert.equal((await w.command(alice, { command: "jog", params: { axis: "y", amount: 900, absolute: true } })).json.warnings, undefined);
  assert.equal(w.robot.pos.y, 900);
  assert.ok((await w.command(alice, { command: "jog", params: { axis: "y", amount: 1100, absolute: true } })).json.warnings);
  const put = await w.putLimits({ jog: { models: { parol6: { maxAmount: 10 } } } });
  assert.equal(put.status, 200);
  assert.ok((await w.command(alice, { command: "jog", params: { axis: "x", amount: 11 } })).json.warnings);
  assert.equal((await w.limits("1")).json.robot.jog.maxAmount, 10);
  assert.equal((await w.putLimits({ jog: { default: { maxAmount: 99999 } } })).status, 400);
});

test("with the arming required, a jog needs it; stop and release disarm", async () => {
  const w = world();
  await w.putLimits({ jog: { armRequired: true } });
  const refused = await w.command(alice, { command: "jog", params: { axis: "x", amount: 5 } });
  assert.equal(refused.status, 403);
  assert.equal(refused.json.code, "jog-not-armed");
  assert.equal((await w.arm(alice, { armed: true })).json.armed, true);
  assert.equal((await w.command(alice, { command: "jog", params: { axis: "x", amount: 5 } })).status, 200);
  assert.equal((await w.command(bob, { command: "jog", params: { axis: "x", amount: 5 } })).status, 403);
  await w.command(alice, { command: "stop" });
  assert.equal((await w.command(alice, { command: "jog", params: { axis: "x", amount: 5 } })).status, 403);
  await w.arm(alice, { armed: true });
  await w.release(alice);
  assert.equal((await w.command(alice, { command: "jog", params: { axis: "x", amount: 5 } })).status, 403);
  assert.equal((await w.arm(alice, { armed: "yes" })).status, 400);
  await w.putLimits({ jog: { armRequired: false } });
  assert.equal((await w.command(alice, { command: "jog", params: { axis: "x", amount: 5 } })).status, 200);
});

test("a claim names its controller: another controller of the same account and another account are refused", async () => {
  const w = world();
  assert.equal((await w.claim(alice, { controllerId: "pc 1" })).status, 400);
  const c = await w.claim(alice, { controllerId: "pc-1" });
  assert.equal(c.json.reservation.controllerId, "pc-1");
  assert.equal((await w.command(alice, { command: "speed", params: { value: 100 } }, { "x-controller-id": "pc-1" })).status, 200);
  const other = await w.command(alice, { command: "speed", params: { value: 100 }, controllerId: "phone" });
  assert.equal(other.status, 409);
  assert.equal(other.json.code, "other-controller");
  assert.equal((await w.command(alice, { command: "speed", params: { value: 100 } })).json.code, "controller-id-required");
  assert.equal((await w.command(bob, { command: "speed", params: { value: 100 } })).json.code, "other-account");
  assert.equal((await w.command(alice, { command: "stop" })).status, 200);
  assert.equal((await w.claim(alice, { controllerId: "phone" })).json.code, "other-controller");
  assert.equal((await w.release(alice, { controllerId: "phone" })).status, 409);
  const listed = (await w.claims()).json.claims;
  assert.equal(listed.length, 1);
  assert.deepEqual([listed[0].robotId, listed[0].cellId, listed[0].controllerId, listed[0].ownerUsername], [1, "c1", "pc-1", "alice"]);
  assert.equal((await w.claim(root, { force: true, controllerId: "console" })).json.reservation.controllerId, "console");
  assert.equal((await w.release(root)).status, 200);
  assert.equal((await w.claims()).json.claims.length, 0);
});

test("a claim without a controller works as before unless the server requires one", async () => {
  const w = world();
  assert.equal((await w.claim(alice)).status, 200);
  assert.equal((await w.command(alice, { command: "speed", params: { value: 100 } })).status, 200);
  assert.equal((await w.claim(alice, { controllerId: "pc-1" })).json.reservation.controllerId, "pc-1");
  await w.release(alice, { controllerId: "pc-1" });
  await w.putLimits({ claims: { requireControllerId: true } });
  const refused = await w.claim(alice);
  assert.equal(refused.status, 400);
  assert.equal(refused.json.code, "controller-id-required");
  assert.equal((await w.claim(alice, { controllerId: "pc-1" })).status, 200);
});
