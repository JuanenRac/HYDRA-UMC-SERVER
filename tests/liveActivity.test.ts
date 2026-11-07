// =============================================================================
// HYDRA-UMC-SERVER - Unit tests for the Live Activity on the lock screen
// Copyright (C) 2026 JuanenRac (Electro Hobby 3D) <electrohobby3d@gmail.com>
// GPL-3.0-or-later - see LICENSE
// =============================================================================
// The card of a robot on the lock screen: three levels (state only, the default; state and progress; the whole panel), applied on the server before anything
// leaves it; a switch that is off by default; a confirmation to turn it on or to raise the level; a registry with limits; the Apple push service as a stand-in.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import {
  DEFAULT_LIVE_ACTIVITY_LEVEL, LIVE_ACTIVITY_LEVELS, LiveActivities, LiveActivityError, LiveActivityService, MAX_ACTIVITIES_PER_ACCOUNT, MAX_LIVE_ACTIVITY_LEVEL, MAX_PANEL_FIELDS,
  MAX_PAYLOAD_BYTES, contentStateFor, isLevel, levelOrDefault, livePayload, raisesExposure, snapshotFromRobot, validActivityToken, validRobotId, type RobotSnapshot,
} from "../src/liveActivity.ts";
import { resolveLiveActivity } from "../src/securityConfig.ts";
import { registerPushRoutes } from "../src/routes/pushRoutes.ts";
import type { ApnsSender } from "../src/pushNotifications.ts";

const TOKEN = "ab".repeat(40);
const FULL: RobotSnapshot = {
  robotId: "c1:1", state: "running", progressPercent: 41.6, step: 5, totalSteps: 12,
  panel: { name: "arm-3", model: "parol6", j1: 10.123456, j2: -20, gripper: true, "bad key": 1, "9x": 2, long: "x".repeat(200) },
};

function tempFile(): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "live-")), "data", "live.json");
}

// ---- the levels

test("there are three levels, the conservative one is the default and full is the most", () => {
  assert.deepEqual([...LIVE_ACTIVITY_LEVELS], ["status", "progress", "full"]);
  assert.equal(DEFAULT_LIVE_ACTIVITY_LEVEL, "status");
  assert.equal(MAX_LIVE_ACTIVITY_LEVEL, "full");
  assert.equal(isLevel("full") && isLevel("status") && isLevel("progress"), true);
  for (const bad of ["", "all", "FULL", null, undefined, 3, {}]) assert.equal(isLevel(bad), false, String(bad));
  for (const bad of ["", "all", "FULL", null, undefined, 3]) assert.equal(levelOrDefault(bad), "status", String(bad));
});

test("raising the level or turning the card on is what needs the confirmation, lowering never", () => {
  assert.equal(raisesExposure("status", "progress"), true);
  assert.equal(raisesExposure("status", "full"), true);
  assert.equal(raisesExposure("progress", "full"), true);
  assert.equal(raisesExposure("full", "progress"), false);
  assert.equal(raisesExposure("full", "status"), false);
  assert.equal(raisesExposure("progress", "progress"), false);
});

test("the state level puts only the state on the lock screen, whatever the snapshot holds", () => {
  assert.deepEqual(contentStateFor("status", FULL), { state: "running" });
});

test("the progress level adds the progress and nothing of the panel", () => {
  assert.deepEqual(contentStateFor("progress", FULL), { state: "running", progressPercent: 42, step: 5, totalSteps: 12 });
});

test("the full level adds the panel, cut to plain values with clean names", () => {
  const state = contentStateFor("full", FULL) as any;
  assert.equal(state.state, "running");
  assert.equal(state.progressPercent, 42);
  assert.deepEqual(Object.keys(state.panel).sort(), ["gripper", "j1", "j2", "long", "model", "name"]);
  assert.equal(state.panel.j1, 10.123);
  assert.equal(state.panel.long.length, 64);
  assert.equal("bad key" in state.panel, false);
});

test("a level never shows more than it says (for every snapshot field, at every level)", () => {
  for (const level of LIVE_ACTIVITY_LEVELS) {
    const state = contentStateFor(level, FULL) as any;
    assert.equal("panel" in state, level === "full", level);
    assert.equal("progressPercent" in state, level !== "status", level);
  }
});

test("a state that is not known is an error, a progress out of range is cut, a missing field is left out", () => {
  assert.equal((contentStateFor("status", { robotId: "r", state: "weird" as any }) as any).state, "error");
  assert.equal((contentStateFor("progress", { robotId: "r", state: "running", progressPercent: 250 }) as any).progressPercent, 100);
  assert.equal((contentStateFor("progress", { robotId: "r", state: "running", progressPercent: -5 }) as any).progressPercent, 0);
  assert.deepEqual(contentStateFor("full", { robotId: "r", state: "idle" }), { state: "idle" });
  assert.deepEqual(contentStateFor("progress", { robotId: "r", state: "idle", progressPercent: Number.NaN, step: -1 }), { state: "idle" });
});

test("the panel holds at most the allowed number of fields", () => {
  const panel: Record<string, number> = {};
  for (let i = 0; i < 100; i++) panel[`f${i}`] = i;
  assert.equal(Object.keys((contentStateFor("full", { robotId: "r", state: "idle", panel }) as any).panel).length, MAX_PANEL_FIELDS);
});

test("the payload is what the Apple push service wants for a Live Activity, and an end dismisses the card", () => {
  const update = livePayload("progress", "update", FULL, 1000.9) as any;
  assert.deepEqual(Object.keys(update), ["aps"]);
  assert.equal(update.aps.event, "update");
  assert.equal(update.aps.timestamp, 1000);
  assert.equal("dismissal-date" in update.aps, false);
  const end = livePayload("progress", "end", FULL, 1000) as any;
  assert.equal(end.aps.event, "end");
  assert.equal(end.aps["dismissal-date"], 1300);
});

test("a payload larger than the limit of the push service is not sent", () => {
  const panel: Record<string, string> = {};
  for (let i = 0; i < MAX_PANEL_FIELDS; i++) panel[`f${i}`] = "y".repeat(64);
  const payload = livePayload("full", "update", { robotId: "r", state: "idle", panel }, 1);
  assert.ok(payload === null || Buffer.byteLength(JSON.stringify(payload)) <= MAX_PAYLOAD_BYTES);
  assert.ok(payload !== null, "24 fields of 64 characters fit in 4 KB");
});

// ---- the switch

test("the card is off by default with the conservative level, and only a file value changes either", () => {
  assert.deepEqual(resolveLiveActivity({}), { enabled: { value: false, source: "default" }, level: { value: "status", source: "default" } });
  assert.deepEqual(resolveLiveActivity({ push: { liveActivity: { enabled: true, level: "full" } } }), { enabled: { value: true, source: "config" }, level: { value: "full", source: "config" } });
  // a typing mistake in the file is never a higher level
  assert.equal(resolveLiveActivity({ push: { liveActivity: { level: "everything" } } }).level.value, "status");
  assert.equal(resolveLiveActivity({ push: { liveActivity: { enabled: "yes" as any } } }).enabled.value, false);
});

// ---- the registry

test("the registry keeps a token per activity, with limits, in a file only its owner reads", () => {
  const file = tempFile();
  const registry = new LiveActivities(file);
  registry.register(TOKEN, "ana", "c1:1");
  assert.equal(registry.count(), 1);
  assert.equal(registry.forRobot("c1:1").length, 1);
  assert.equal(registry.forRobot("c1:2").length, 0);
  assert.equal(new LiveActivities(file).count(), 1, "kept on disk");
  if (process.platform !== "win32") assert.equal(fs.statSync(file).mode & 0o077, 0);
  registry.register(TOKEN.toUpperCase(), "bea", "c1:2");
  assert.equal(registry.count(), 1, "the same token moves to the account and robot that registered it last");
  assert.equal(registry.list()[0].username, "bea");
});

test("an account cannot hold more activities than the limit", () => {
  const registry = new LiveActivities(tempFile());
  for (let i = 0; i < MAX_ACTIVITIES_PER_ACCOUNT; i++) registry.register(`${i}`.padStart(2, "0").repeat(20), "ana", "c1:1");
  assert.throws(() => registry.register("ff".repeat(20), "ana", "c1:1"), (error: any) => error instanceof LiveActivityError && error.status === 409);
  registry.register("ff".repeat(20), "bea", "c1:1");
  assert.equal(registry.count(), MAX_ACTIVITIES_PER_ACCOUNT + 1);
});

test("an account removes its own and an administrator any; an account's activities go with the account", () => {
  const registry = new LiveActivities(tempFile());
  registry.register(TOKEN, "ana", "c1:1");
  assert.equal(registry.remove(TOKEN, "bea"), false);
  assert.equal(registry.remove(TOKEN, "ana"), true);
  registry.register(TOKEN, "ana", "c1:1");
  assert.equal(registry.remove(TOKEN, null), true);
  registry.register(TOKEN, "ana", "c1:1");
  assert.equal(registry.removeAccount("ana"), 1);
  assert.equal(registry.count(), 0);
});

test("a damaged registry file is an empty registry, not a crash", () => {
  const file = tempFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  for (const content of ["not json", "[]", '{"activities":"x"}', '{"activities":[{"token":"zz","username":"a","robotId":"r"}]}']) {
    fs.writeFileSync(file, content);
    assert.equal(new LiveActivities(file).count(), 0, content);
  }
});

test("tokens and robot ids are checked", () => {
  assert.equal(validActivityToken(TOKEN), true);
  for (const bad of ["", "zz".repeat(20), "ab", "ab".repeat(300), 5, null]) assert.equal(validActivityToken(bad), false, String(bad));
  assert.equal(validRobotId("c1:1") && validRobotId("arm-3"), true);
  for (const bad of ["", " a", "a b", ".a", "a".repeat(65), 3, null]) assert.equal(validRobotId(bad), false, String(bad));
});

// ---- the service

function fakeSender() {
  const sent: { token: string; payload: any; options: any }[] = [];
  let reply: { status: number; reason?: string } = { status: 200 };
  const sender: ApnsSender = { send: async (token, payload, options) => { sent.push({ token, payload, options }); return reply; }, close() {} };
  return { sender, sent, setReply: (r: { status: number; reason?: string }) => { reply = r; } };
}

function service(over: { enabled?: boolean; level?: any; sender?: ApnsSender | null } = {}) {
  const fake = fakeSender();
  const activities = new LiveActivities(tempFile());
  const logs: string[] = [];
  const live = new LiveActivityService({
    enabled: () => over.enabled !== false, level: () => over.level ?? "status", activities,
    sender: () => (over.sender === undefined ? fake.sender : over.sender), now: () => 2_000_000, log: (l) => logs.push(l),
  });
  return { fake, activities, live, logs };
}

test("while the switch is off nothing is sent", async () => {
  const { fake, activities, live } = service({ enabled: false });
  activities.register(TOKEN, "ana", "c1:1");
  assert.equal(await live.push("update", FULL), 0);
  assert.equal(fake.sent.length, 0);
});

test("without a sender (push off or no credentials) nothing is sent and nothing throws", async () => {
  const { activities, live } = service({ sender: null });
  activities.register(TOKEN, "ana", "c1:1");
  assert.equal(await live.push("update", FULL), 0);
});

test("a card goes to the activities of that robot only, with the push type of a Live Activity, and carries only what the level says", async () => {
  const { fake, activities, live } = service({ level: "status" });
  activities.register(TOKEN, "ana", "c1:1");
  activities.register("cd".repeat(40), "bea", "c1:2");
  assert.equal(await live.push("update", FULL), 1);
  assert.equal(fake.sent.length, 1);
  assert.equal(fake.sent[0].token, TOKEN);
  assert.equal(fake.sent[0].options.pushType, "liveactivity");
  assert.deepEqual(fake.sent[0].payload.aps["content-state"], { state: "running" });
  assert.equal(JSON.stringify(fake.sent[0].payload).includes("arm-3"), false, "nothing of the panel at the state level");
});

test("each level puts on the wire what it says and no more", async () => {
  for (const level of LIVE_ACTIVITY_LEVELS) {
    const { fake, activities, live } = service({ level });
    activities.register(TOKEN, "ana", "c1:1");
    await live.push("update", FULL);
    const state = fake.sent[0].payload.aps["content-state"];
    assert.equal("panel" in state, level === "full", level);
    assert.equal("progressPercent" in state, level !== "status", level);
  }
});

test("a level that is not valid is the conservative one on the wire", async () => {
  const { fake, activities, live } = service({ level: "everything" });
  activities.register(TOKEN, "ana", "c1:1");
  await live.push("update", FULL);
  assert.deepEqual(fake.sent[0].payload.aps["content-state"], { state: "running" });
});

test("a token the push service no longer knows is forgotten, any other refusal is only logged", async () => {
  let { fake, activities, live, logs } = service();
  activities.register(TOKEN, "ana", "c1:1");
  fake.setReply({ status: 410 });
  assert.equal(await live.push("update", FULL), 0);
  assert.equal(activities.count(), 0);
  ({ fake, activities, live, logs } = service());
  activities.register(TOKEN, "ana", "c1:1");
  fake.setReply({ status: 400, reason: "BadDeviceToken" });
  await live.push("update", FULL);
  assert.equal(activities.count(), 0);
  ({ fake, activities, live, logs } = service());
  activities.register(TOKEN, "ana", "c1:1");
  fake.setReply({ status: 429, reason: "TooManyRequests" });
  await live.push("update", FULL);
  assert.equal(activities.count(), 1);
  assert.ok(logs.some((l) => l.includes("429")));
  assert.equal(logs.join("").includes(TOKEN), false, "a token is never logged");
});

test("a sender that throws never reaches the caller", async () => {
  const activities = new LiveActivities(tempFile());
  activities.register(TOKEN, "ana", "c1:1");
  const logs: string[] = [];
  const live = new LiveActivityService({ enabled: () => true, level: () => "full", activities, sender: () => ({ send: async () => { throw new Error("boom"); }, close() {} }), log: (l) => logs.push(l) });
  assert.equal(await live.push("update", FULL), 0);
  assert.equal(logs.length, 1);
});

// ---- the snapshot of a robot

test("the snapshot of a robot follows its playback and its panel", () => {
  const settings = { controllers: [{ id: "c1", robots: [{ id: 1, name: "arm-3", model: "parol6", j1: 5, secret: "no", recordedPoints: [1, 2, 3, 4], playbackState: { isPlaying: true, activeStep: 2 } }] }] };
  const snapshot = snapshotFromRobot(settings, { controllerId: "c1", robotId: 1 })!;
  assert.deepEqual([snapshot.robotId, snapshot.state, snapshot.step, snapshot.totalSteps, snapshot.progressPercent], ["c1:1", "running", 2, 4, 50]);
  assert.deepEqual(snapshot.panel, { name: "arm-3", model: "parol6", j1: 5 });
  assert.equal(snapshotFromRobot(settings, { controllerId: "c1", robotId: 9 }), null);
  assert.equal(snapshotFromRobot(settings, { controllerId: "c9", robotId: 1 }), null);
  assert.equal(snapshotFromRobot(undefined, { controllerId: "c1", robotId: 1 }), null);
});

test("finished, stopped and idle robots", () => {
  const make = (playbackState: any) => snapshotFromRobot({ controllers: [{ id: "c1", robots: [{ id: 1, playbackState }] }] }, { controllerId: "c1", robotId: 1 })!;
  assert.equal(make({ isFinished: true, activeStep: -1 }).state, "finished");
  assert.equal(make({ isFinished: true }).progressPercent, 100);
  assert.equal(make({ requestStop: true }).state, "stopped");
  assert.equal(make({}).state, "idle");
  assert.equal(make({ isPlaying: true, requestStop: true }).state, "running", "a robot still playing is running");
});

// ---- the routes

type Handler = (req: any, res: any, next?: any) => unknown;

function routes(enabled: boolean) {
  const table: Record<string, Handler[]> = {};
  const app: any = {
    get() {}, put() {},
    post(p: string, ...h: Handler[]) { table[`POST ${p}`] = h; },
    delete(p: string, ...h: Handler[]) { table[`DELETE ${p}`] = h; },
  };
  const live = new LiveActivities(tempFile());
  const audit: any[] = [];
  registerPushRoutes(app, {
    authenticate: ((req: any, _r: any, next: any) => { req.user = req.asUser ?? { id: "u1", username: "ana", role: "viewer" }; next(); }) as any,
    requireAdmin: ((_q: any, _r: any, next: any) => next()) as any,
    pushGate: ((_q: any, _r: any, next: any) => next()) as any,
    devices: {} as any, status: () => ({}) as any, audit: { record: (e: any) => { audit.push(e); } },
    liveActivities: live,
    liveActivityGate: ((_q: any, res: any, next: any) => (enabled ? next() : res.status(404).end())) as any,
  });
  const call = async (key: string, req: any) => {
    const res: any = new EventEmitter();
    res.statusCode = 200;
    res.status = (c: number) => { res.statusCode = c; return res; };
    res.json = (b: unknown) => { res.body = b; return res; };
    res.end = () => res;
    const chain = table[key];
    assert.ok(chain, `${key} is registered`);
    const run = (i: number): unknown => (i >= chain.length ? undefined : chain[i](req, res, () => run(i + 1)));
    await run(0);
    return res;
  };
  return { call, live, audit };
}

test("the routes answer 404 while the switch is off and register nothing", async () => {
  const { call, live } = routes(false);
  const res = await call("POST /api/push/live-activities", { body: { activityToken: TOKEN, robotId: "c1:1" } });
  assert.equal(res.statusCode, 404);
  assert.equal(live.count(), 0);
});

test("a signed-in account registers the token of its activity, and it is audited without the token", async () => {
  const { call, live, audit } = routes(true);
  const res = await call("POST /api/push/live-activities", { body: { activityToken: TOKEN, robotId: "c1:1" }, ip: "127.0.0.1" });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { registered: true });
  assert.equal(live.count(), 1);
  assert.equal(JSON.stringify(audit).includes(TOKEN), false);
  assert.equal(audit[0].type, "live-activity-registered");
});

test("a request with a bad token or robot id is refused with 400", async () => {
  const { call, live } = routes(true);
  for (const body of [{}, { activityToken: "zz", robotId: "c1:1" }, { activityToken: TOKEN }, { activityToken: TOKEN, robotId: "a b" }, { activityToken: TOKEN, robotId: 5 }]) {
    const res = await call("POST /api/push/live-activities", { body });
    assert.equal(res.statusCode, 400, JSON.stringify(body));
  }
  assert.equal(live.count(), 0);
});

test("the limit of an account is a 409", async () => {
  const { call } = routes(true);
  for (let i = 0; i < MAX_ACTIVITIES_PER_ACCOUNT; i++) await call("POST /api/push/live-activities", { body: { activityToken: `${i}`.padStart(2, "0").repeat(20), robotId: "r" } });
  const res = await call("POST /api/push/live-activities", { body: { activityToken: "ee".repeat(20), robotId: "r" } });
  assert.equal(res.statusCode, 409);
});

test("an account removes its own activity and not another's; an administrator any", async () => {
  const { call, live } = routes(true);
  live.register(TOKEN, "bea", "c1:1");
  let res = await call(`DELETE /api/push/live-activities/:token`, { params: { token: TOKEN } });
  assert.deepEqual(res.body, { removed: false });
  res = await call(`DELETE /api/push/live-activities/:token`, { params: { token: TOKEN }, asUser: { id: "a", username: "root", role: "admin" } });
  assert.deepEqual(res.body, { removed: true });
  res = await call(`DELETE /api/push/live-activities/:token`, { params: { token: "zz" } });
  assert.equal(res.statusCode, 400);
});
