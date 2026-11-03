import assert from "node:assert/strict";
import { test } from "node:test";
import { registerRobotRoutes } from "../src/routes/robotRoutes.ts";
import { registerSettingsRoutes } from "../src/routes/settings.ts";
import { registerLivenessRoutes } from "../src/routes/livenessRoutes.ts";
import { RobotLivenessTracker } from "../src/robotLiveness.ts";
import { createPlayback } from "../src/playback.ts";
import {
  RobotIdDuplicatedError, ambiguousRobotBody, ambiguousRobotLogLines, duplicatedRobotBody, newRobotIdConflicts, robotIdConflicts,
} from "../src/robotIds.ts";

const clean = { controllers: [{ id: "c1", robots: [{ id: 1 }, { id: 2 }] }, { id: "c2", robots: [{ id: 3 }] }] };
const dirty = { controllers: [{ id: "c1", robots: [{ id: 1 }, { id: 2 }] }, { id: "c2", robots: [{ id: 2 }, { id: 3 }] }] };

test("a roster without repeated ids has no conflicts", () => {
  assert.deepEqual(robotIdConflicts(clean), []);
  assert.deepEqual(robotIdConflicts({}), []);
  assert.deepEqual(ambiguousRobotLogLines(clean), []);
});

test("a repeated id lists the controllers that hold it, ids only", () => {
  const withSecrets = { controllers: [{ id: "c1", name: "Lab", ip: "10.0.0.5", password: "x", robots: [{ id: 7 }] }, { id: "c2", robots: [{ id: 7 }, { id: 7 }] }] };
  assert.deepEqual(robotIdConflicts(withSecrets), [{ robotId: 7, controllers: ["c1", "c2", "c2"] }]);
  assert.equal(JSON.stringify(ambiguousRobotBody(withSecrets, 7)).includes("10.0.0.5"), false);
  assert.equal(ambiguousRobotBody(withSecrets, 7)?.code, "robot_id_ambiguous");
  assert.equal(ambiguousRobotBody(withSecrets, 8), null);
  assert.equal(ambiguousRobotLogLines(withSecrets).length, 1);
});

test("only a duplicate the tree did not have already is a registration conflict", () => {
  assert.deepEqual(newRobotIdConflicts(clean, clean), []);
  assert.deepEqual(newRobotIdConflicts(dirty, dirty), []); // saving an old tree untouched is still possible
  assert.deepEqual(newRobotIdConflicts(dirty, clean), []); // repairing it too
  assert.deepEqual(newRobotIdConflicts(clean, dirty), [{ robotId: 2, controllers: ["c1", "c2"] }]);
  const another = { controllers: [...dirty.controllers, { id: "c3", robots: [{ id: 3 }] }] };
  assert.deepEqual(newRobotIdConflicts(dirty, another), [{ robotId: 3, controllers: ["c2", "c3"] }]);
  assert.equal(duplicatedRobotBody([{ robotId: 2, controllers: ["c1", "c2"] }]).code, "robot_id_duplicated");
});

function settingsApp(initial: any) {
  const handlers: Record<string, (req: any, res: any) => Promise<unknown> | unknown> = {};
  const app: any = {
    get(route: string, ...chain: unknown[]) { handlers[`GET ${route}`] = chain[chain.length - 1] as any; },
    post(route: string, ...chain: unknown[]) { handlers[`POST ${route}`] = chain[chain.length - 1] as any; },
  };
  let current = initial;
  registerSettingsRoutes(app, {
    authenticate: () => undefined,
    requireAdmin: () => undefined,
    loadFullSettingsFromDisk: () => current,
    getSettings: () => current,
    applySettingsUpdate: async (payload: any) => {
      const added = newRobotIdConflicts(current, payload);
      if (added.length > 0) throw new RobotIdDuplicatedError(added);
      current = payload;
    },
  });
  const call = async (key: string, req: any = {}) => {
    let status = 200;
    let json: any;
    const res: any = { setHeader() {}, status(code: number) { status = code; return res; }, json(value: any) { json = value; return res; } };
    await handlers[key]({ headers: {}, body: {}, ...req }, res);
    return { status, json };
  };
  return { call, current: () => current };
}

test("POST /api/settings refuses a robot id used in another controller with 409 robot_id_duplicated", async () => {
  const t = settingsApp(clean);
  const r = await t.call("POST /api/settings", { body: dirty });
  assert.equal(r.status, 409);
  assert.equal(r.json.code, "robot_id_duplicated");
  assert.deepEqual(r.json.conflicts, [{ robotId: 2, controllers: ["c1", "c2"] }]);
  assert.match(r.json.error, /unique/);
  assert.equal(t.current(), clean);
});

test("an old tree with repeated ids can still be saved and repaired", async () => {
  const t = settingsApp(dirty);
  assert.equal((await t.call("POST /api/settings", { body: dirty })).status, 200);
  assert.equal((await t.call("POST /api/settings", { body: clean })).status, 200);
});

test("GET /api/admin/robot-ids reports the ambiguous ids", async () => {
  const bad = await settingsApp(dirty).call("GET /api/admin/robot-ids");
  assert.deepEqual(bad.json, { ok: false, ambiguousCount: 1, ambiguous: [{ robotId: 2, controllers: ["c1", "c2"] }] });
  const good = await settingsApp(clean).call("GET /api/admin/robot-ids");
  assert.deepEqual(good.json, { ok: true, ambiguousCount: 0, ambiguous: [] });
});

function robotApp(settings: any) {
  const playback = createPlayback({ getSettings: () => settings, queueSettingsWrite: async () => undefined, broadcastRobotDelta: () => undefined } as any);
  const handlers: Record<string, (req: any, res: any) => Promise<unknown> | unknown> = {};
  const app: any = {
    get(route: string, ...chain: unknown[]) { handlers[`GET ${route}`] = chain[chain.length - 1] as any; },
    post(route: string, ...chain: unknown[]) { handlers[`POST ${route}`] = chain[chain.length - 1] as any; },
  };
  registerRobotRoutes(app, {
    authenticate: () => undefined,
    getSettings: () => settings,
    findRobotById: playback.findRobotById,
    findControllerIdForRobot: playback.findControllerIdForRobot,
    isReservationActive: playback.isReservationActive,
    appendReservationHistory: playback.appendReservationHistory,
    queueSettingsWrite: async () => undefined,
    broadcastRobotDelta: () => undefined,
    DEFAULT_RESERVATION_TTL_MS: 60_000,
    MAX_RESERVATION_TTL_MS: 600_000,
  } as any);
  const tracker = new RobotLivenessTracker();
  registerLivenessRoutes(app, { authenticate: () => undefined, requireOperator: () => undefined, getSettings: () => settings, tracker, staleAfterS: () => 30 } as any);
  const call = async (key: string, id: string) => {
    let status = 200;
    let json: any;
    const res: any = { setHeader() {}, status(code: number) { status = code; return res; }, json(value: any) { json = value; return res; } };
    await handlers[key]({ params: { id }, headers: {}, body: {}, user: { id: "u", username: "u", role: "operator" } }, res);
    return { status, json };
  };
  return { call, playback };
}

test("the routes by an ambiguous id answer 409 robot_id_ambiguous and never pick one", async () => {
  const t = robotApp(dirty);
  for (const key of ["GET /api/robot/:id", "POST /api/robot/:id/claim", "POST /api/robot/:id/release", "POST /api/robot/:id/heartbeat"]) {
    const r = await t.call(key, "2");
    assert.equal(r.status, 409, key);
    assert.equal(r.json.code, "robot_id_ambiguous", key);
    assert.deepEqual(r.json.controllers, ["c1", "c2"], key);
  }
  assert.equal(t.playback.findRobotById(2), null);
  assert.equal(t.playback.findControllerIdForRobot(2), null);
});

test("the other robots of a roster with an ambiguous id keep working", async () => {
  const t = robotApp(dirty);
  assert.equal((await t.call("GET /api/robot/:id", "1")).status, 200);
  assert.equal((await t.call("GET /api/robot/:id", "3")).status, 200);
  assert.equal((await t.call("GET /api/robot/:id", "99")).status, 404);
  assert.equal((await t.call("POST /api/robot/:id/heartbeat", "3")).status, 200);
});
