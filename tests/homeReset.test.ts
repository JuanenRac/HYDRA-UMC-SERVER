import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs";
import { registerCommandRoutes } from "../src/routes/commandRoutes.ts";
import { JogArming, defaultSafetyConfig } from "../src/safetyLimits.ts";
import { GENERIC_HOME, homeFor, jointOutOfRange, resolveHome } from "../src/modelHome.ts";

type Handler = (req: any, res: any) => Promise<unknown>;
const ALICE = { id: "alice-id", username: "alice", role: "operator" };
const PRIOR = { j1: 10, j2: 10, j3: 10, j4: 10, j5: 10, j6: 10 };

function makeSettings() {
  return {
    controllers: [{
      id: "c1",
      robots: [
        { id: 1, name: "Parol", model: "Parol6 (6-DOF)", enabled: true, pos: { x: 5, y: 6, z: 7, a: 1, b: 2, c: 3 }, joints: { ...PRIOR }, playbackState: { speed: 100 } },
        { id: 2, name: "Generic", model: "Generic (6-DOF)", enabled: true, pos: { x: 5, y: 6, z: 7, a: 1, b: 2, c: 3 }, joints: { ...PRIOR }, playbackState: { speed: 100 } },
        { id: 3, name: "Unknown", model: "Made Up Arm", enabled: true, pos: { x: 5, y: 6, z: 7, a: 1, b: 2, c: 3 }, joints: { ...PRIOR }, playbackState: { speed: 100 } },
        { id: 4, name: "Table", model: "Parol6 (6-DOF)", enabled: true, hasXYTable: true, xyTable: { pos: { x: 9, y: 9 } }, pos: { x: 1, y: 1, z: 1, a: 0, b: 0, c: 0, tx: 9, ty: 9 }, joints: {}, playbackState: { speed: 100 } },
      ],
    }],
  };
}

function setup(armRequired = false) {
  let handler: Handler | undefined;
  const app: any = { post(route: string, ...handlers: unknown[]) { if (route === "/api/robot/:id/command") handler = handlers[handlers.length - 1] as Handler; } };
  const settings: any = makeSettings();
  const arming = new JogArming();
  const config = defaultSafetyConfig();
  config.jog.armRequired = armRequired;
  const safety: any = { get: () => config, jogFor: () => config.jog.default, temperatureFor: () => config };
  const writes: any[] = [];
  registerCommandRoutes(app, {
    authenticate: () => undefined,
    getSettings: () => settings,
    industrialLog: () => undefined,
    isReservationActive: () => false,
    queueSettingsWrite: async (payload: any) => { writes.push(payload); },
    broadcastRobotDelta: () => undefined,
    startServerPlayback: () => undefined,
    stopServerPlayback: () => undefined,
    safety,
    arming,
  } as any);
  const call = async (id: string, body: any) => {
    let status = 200;
    let json: any;
    const res: any = { headers: {} as Record<string, string>, setHeader(k: string, v: string) { res.headers[k] = v; }, status(code: number) { status = code; return res; }, json(value: any) { json = value; return res; } };
    await handler!({ params: { id }, body, user: ALICE, headers: {} }, res);
    return { status, json };
  };
  const robot = (id: number) => settings.controllers[0].robots.find((r: any) => r.id === id);
  return { call, arming, robot, writes };
}

test("the shared table gives each listed model its own home pose and the generic pose to the rest", () => {
  assert.deepEqual(homeFor("Parol6 (6-DOF)").joints, { j1: 0, j2: -25, j3: 20, j4: 0, j5: 0, j6: 0 });
  assert.deepEqual(homeFor("parol6 (6-dof)").joints, homeFor("Parol6 (6-DOF)").joints);
  assert.equal(homeFor("Made Up Arm").listed, false);
  assert.deepEqual(homeFor("Made Up Arm").joints, GENERIC_HOME);
});

test("the home pose of every listed model lies inside the range of its joints", () => {
  const table = JSON.parse(fs.readFileSync(new URL("../src/data/kinematicData.json", import.meta.url), "utf-8")).models;
  for (const model of Object.keys(table)) {
    const home = homeFor(model);
    assert.equal(home.listed, true, model);
    assert.equal(jointOutOfRange(home.joints, home.limits), null, model);
  }
});

test("the table is the one the STUDIO and SUITE repositories keep, when they sit beside this one", () => {
  const mine = fs.readFileSync(new URL("../src/data/kinematicData.json", import.meta.url), "utf-8");
  for (const other of ["../../HYDRA-UMC-STUDIO/src/data/kinematicData.json", "../../HYDRA-UMC-SUITE/assets/kinematic_data.json"]) {
    const url = new URL(other, import.meta.url);
    if (!fs.existsSync(url)) continue;
    assert.deepEqual(JSON.parse(fs.readFileSync(url, "utf-8")), JSON.parse(mine), other);
  }
});

test("resolveHome refuses a pose that is not the home of the model or lies outside its joints", () => {
  const home = homeFor("Parol6 (6-DOF)").joints;
  assert.deepEqual(resolveHome("Parol6 (6-DOF)", undefined), { ok: true, joints: home });
  assert.deepEqual(resolveHome("Parol6 (6-DOF)", home), { ok: true, joints: home });
  const other = resolveHome("Parol6 (6-DOF)", { ...home, j2: -30 });
  assert.equal(other.ok, false);
  assert.equal(!other.ok && other.code, "home-pose-mismatch");
  const outside = resolveHome("Parol6 (6-DOF)", { ...home, j1: 500 });
  assert.equal(!outside.ok && outside.code, "home-out-of-limits");
  for (const bad of ["x", [], { j1: 0 }, { ...home, j3: NaN }, { ...home, j3: "0" }]) assert.equal(resolveHome("Parol6 (6-DOF)", bad).ok, false, JSON.stringify(bad));
});

test("a reset goes to the home pose of the model of the robot, not to the generic formula", async () => {
  const t = setup();
  assert.equal((await t.call("1", { command: "reset" })).status, 200);
  assert.deepEqual(t.robot(1).joints, { j1: 0, j2: -25, j3: 20, j4: 0, j5: 0, j6: 0 });
  assert.equal(t.robot(1).pos.x, 0);
  assert.equal((await t.call("2", { command: "reset", params: { target: "robot" } })).status, 200);
  assert.deepEqual(t.robot(2).joints, GENERIC_HOME);
  assert.equal((await t.call("3", { command: "reset" })).status, 200);
  assert.deepEqual(t.robot(3).joints, GENERIC_HOME);
});

test("a client that sends the home pose of the model is accepted; one that sends another pose moves nothing", async () => {
  const t = setup();
  const home = homeFor("Parol6 (6-DOF)").joints;
  assert.equal((await t.call("1", { command: "reset", params: { joints: home } })).status, 200);
  const before = JSON.stringify(t.robot(1));
  const writes = t.writes.length;
  const mismatch = await t.call("1", { command: "reset", params: { joints: { ...home, j2: 10 } } });
  assert.equal(mismatch.status, 400);
  assert.equal(mismatch.json.code, "home-pose-mismatch");
  const outside = await t.call("1", { command: "reset", params: { joints: { ...home, j1: 999 } } });
  assert.equal(outside.status, 422);
  assert.equal(outside.json.code, "home-out-of-limits");
  assert.equal(JSON.stringify(t.robot(1)), before);
  assert.equal(t.writes.length, writes);
});

test("a reset needs the jog armed where the administrator requires it for the jog", async () => {
  const t = setup(true);
  const refused = await t.call("1", { command: "reset" });
  assert.equal(refused.status, 403);
  assert.equal(refused.json.code, "jog-not-armed");
  assert.deepEqual(t.robot(1).joints, PRIOR);
  const table = await t.call("4", { command: "reset", params: { target: "xytable" } });
  assert.equal(table.json.code, "jog-not-armed");
  assert.equal(t.robot(4).xyTable.pos.x, 9);
  t.arming.arm(1, ALICE.id, undefined, 60_000);
  assert.equal((await t.call("1", { command: "reset" })).status, 200);
  assert.equal(t.robot(1).joints.j2, -25);
});

test("a reset without the arming requirement still works as before, and the table reset keeps the pose of the arm", async () => {
  const t = setup(false);
  assert.equal((await t.call("4", { command: "reset", params: { target: "xytable" } })).status, 200);
  assert.deepEqual(t.robot(4).xyTable.pos, { x: 0, y: 0 });
  assert.equal(t.robot(4).pos.x, 1);
});

test("a numbered reset is ordered with the jog: an older number is refused, a newer one is accepted", async () => {
  const t = setup();
  assert.equal((await t.call("1", { command: "reset", seq: 5 })).status, 200);
  const stale = await t.call("1", { command: "reset", seq: 4 });
  assert.equal(stale.status, 409);
  assert.equal(stale.json.code, "stale-sequence");
  assert.equal((await t.call("1", { command: "reset", seq: 6 })).status, 200);
  assert.equal((await t.call("1", { command: "reset", seq: 0 })).json.code, "invalid-sequence");
  // a stop sent later than the reset makes an older reset stale
  assert.equal((await t.call("1", { command: "stop", seq: 9 })).status, 200);
  assert.equal((await t.call("1", { command: "reset", seq: 8 })).status, 409);
});
