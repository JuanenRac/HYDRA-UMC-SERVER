import assert from "node:assert/strict";
import { test } from "node:test";
import { registerCommandRoutes } from "../src/routes/commandRoutes.ts";
import { MAX_RECORDED_POINTS, planRobotEdit } from "../src/robotEdit.ts";

type Handler = (req: any, res: any) => Promise<unknown>;

const joints = { j1: 1, j2: 2, j3: 3, j4: 4, j5: 5, j6: 6 };
const point = (n: number) => ({ motionType: "model-joints", ...joints, j1: n, x: n, y: 0, z: 0 });

function makeSettings() {
  return {
    controllers: [
      {
        id: "c1",
        robots: [
          { id: 1, name: "A1", model: "Parol6 (6-DOF)", role: "Idle", pos: { x: 0, y: 0, z: 0, a: 0, b: 0, c: 0 }, joints: { ...joints }, recordedPoints: [point(1)], playbackState: { isPlaying: false, activeStep: 0, speed: 100 } },
          { id: 2, name: "A2", pos: { x: 0, y: 0, z: 0, a: 0, b: 0, c: 0 }, joints: {}, reservation: { ownerId: "bob-id", ownerUsername: "bob", expiresAt: Date.now() + 60_000 } },
          { id: 3, name: "A3", pos: { x: 0, y: 0, z: 0, a: 0, b: 0, c: 0 }, joints: {}, hasXYTable: false, xyTable: { pos: { x: 5, y: 6 }, tableSize: { width: 300, length: 200 } } },
        ],
      },
    ],
  };
}

function setup(armRequired = false) {
  let handler: Handler | undefined;
  const settings: any = makeSettings();
  const app: any = { post(route: string, ...handlers: unknown[]) { if (route === "/api/robot/:id/command") handler = handlers[handlers.length - 1] as Handler; } };
  const deltas: any[] = [];
  const writes: any[] = [];
  registerCommandRoutes(app, {
    authenticate: () => undefined,
    getSettings: () => settings,
    industrialLog: () => undefined,
    isReservationActive: (r: any) => !!r && r.expiresAt > Date.now(),
    queueSettingsWrite: async (payload: any) => { writes.push(payload); },
    broadcastRobotDelta: (batch: any[]) => { deltas.push(...batch); },
    startServerPlayback: () => undefined,
    stopServerPlayback: () => undefined,
    safety: { get: () => ({ jog: { armRequired } }), jogFor: () => ({ maxAmount: 100, maxAbsolute: 1000 }) },
    arming: { isArmed: () => false, disarm: () => undefined },
  } as any);
  const call = async (id: string, body: any) => {
    let status = 200;
    let json: any;
    const res: any = { setHeader() {}, status(code: number) { status = code; return res; }, json(value: any) { json = value; return res; } };
    await handler!({ params: { id }, body, headers: {}, user: { id: "alice-id", username: "alice", role: "operator" } }, res);
    return { status, json };
  };
  return { call, settings, deltas, writes };
}

const robot = (s: any, id: number) => s.controllers[0].robots.find((r: any) => r.id === id);

test("points replaces the list as one command and broadcasts the whole list", async () => {
  const t = setup();
  const r = await t.call("1", { command: "points", params: { points: [point(1), point(2), point(3)] } });
  assert.equal(r.status, 200);
  assert.equal(robot(t.settings, 1).recordedPoints.length, 3);
  assert.equal(t.deltas.length, 1);
  assert.equal(t.deltas[0].patch.recordedPoints.length, 3);
  assert.equal(t.writes.length, 1);
});

test("points may empty the list, and refuses a bad point without changing anything", async () => {
  const t = setup();
  assert.equal((await t.call("1", { command: "points", params: { points: [] } })).status, 200);
  assert.deepEqual(robot(t.settings, 1).recordedPoints, []);
  const t2 = setup();
  const bad = await t2.call("1", { command: "points", params: { points: [point(1), { j1: "x" }] } });
  assert.equal(bad.status, 400);
  assert.equal(bad.json.code, "invalid-points");
  assert.equal(robot(t2.settings, 1).recordedPoints.length, 1);
  assert.equal(t2.writes.length, 0);
  assert.equal((await t2.call("1", { command: "points", params: { points: new Array(MAX_RECORDED_POINTS + 1).fill(point(1)) } })).status, 400);
  assert.equal((await t2.call("1", { command: "points", params: {} })).status, 400);
});

test("the points of a robot that is playing are not touched", async () => {
  const t = setup();
  robot(t.settings, 1).playbackState.isPlaying = true;
  const r = await t.call("1", { command: "points", params: { points: [] } });
  assert.equal(r.status, 409);
  assert.equal(r.json.code, "robot-running");
  assert.equal(robot(t.settings, 1).recordedPoints.length, 1);
});

test("loop, model and role are checked and applied", async () => {
  const t = setup();
  assert.equal((await t.call("1", { command: "loop", params: { value: true } })).status, 200);
  assert.equal(robot(t.settings, 1).playbackState.isLooping, true);
  assert.equal(robot(t.settings, 1).playbackState.speed, 100);
  assert.equal((await t.call("1", { command: "loop", params: { value: "yes" } })).status, 400);
  assert.equal((await t.call("1", { command: "model", params: { model: "UR5e (6-DOF)" } })).status, 200);
  assert.equal(robot(t.settings, 1).model, "UR5e (6-DOF)");
  for (const model of ["", "x".repeat(65), "<script>", 7, "a\nb"]) {
    assert.equal((await t.call("1", { command: "model", params: { model } })).status, 400, JSON.stringify(model));
  }
  assert.equal((await t.call("1", { command: "role", params: { role: "CNC" } })).status, 200);
  assert.equal(robot(t.settings, 1).role, "CNC");
  assert.equal((await t.call("1", { command: "role", params: { role: "Pirate" } })).status, 400);
});

test("combine sets the list for the target only, and refuses itself, a missing robot and a robot claimed by someone else", async () => {
  const t = setup();
  assert.equal((await t.call("1", { command: "combine", params: { with: [1] } })).status, 400);
  assert.equal((await t.call("1", { command: "combine", params: { with: [9] } })).status, 400);
  assert.equal((await t.call("1", { command: "combine", params: { with: [2] } })).status, 409, "robot 2 is reserved by bob");
  const ok = await t.call("1", { command: "combine", params: { with: [3, 3] } });
  assert.equal(ok.status, 200);
  assert.deepEqual(robot(t.settings, 1).combinedWith, [3]);
  assert.equal(robot(t.settings, 3).combinedWith, undefined, "the other side is not edited");
  assert.equal(t.deltas.length, 1);
  const leave = await t.call("1", { command: "combine", params: { with: [] } });
  assert.equal(leave.status, 200);
  assert.deepEqual(robot(t.settings, 1).combinedWith, []);
});

test("joints needs six finite values in range and, when the jog must be armed, the arming", async () => {
  const t = setup();
  const ok = await t.call("1", { command: "joints", params: { joints: { j1: 10, j2: 20, j3: 30, j4: 40, j5: 50, j6: 60 } } });
  assert.equal(ok.status, 200);
  assert.equal(robot(t.settings, 1).joints.j3, 30);
  assert.equal((await t.call("1", { command: "joints", params: { joints: { j1: 1 } } })).status, 400);
  assert.equal((await t.call("1", { command: "joints", params: { joints: { ...joints, j6: 5000 } } })).status, 400);
  assert.equal((await t.call("1", { command: "joints", params: { joints: { ...joints, j6: Number.NaN } } })).status, 400);
  const armed = setup(true);
  const refused = await armed.call("1", { command: "joints", params: { joints } });
  assert.equal(refused.status, 403);
  assert.equal(refused.json.code, "jog-not-armed");
});

test("xyTableConfig keeps the rest of the table and sends the whole object", async () => {
  const t = setup();
  const r = await t.call("3", { command: "xyTableConfig", params: { enabled: true, worldPos: { x: 100, y: -50 }, worldRot: 90 } });
  assert.equal(r.status, 200);
  const table = robot(t.settings, 3);
  assert.equal(table.hasXYTable, true);
  assert.deepEqual(table.xyTable.tableSize, { width: 300, length: 200 });
  assert.deepEqual(table.xyTable.pos, { x: 5, y: 6 });
  assert.deepEqual(table.xyTable.worldPos, { x: 100, y: -50 });
  assert.equal(t.deltas[0].patch.xyTable.worldRot, 90);
  for (const params of [{}, { tableSize: { width: 0, length: 5 } }, { worldRot: "x" }, { renderScale: 0 }, { enabled: "yes" }]) {
    assert.equal((await t.call("3", { command: "xyTableConfig", params })).status, 400, JSON.stringify(params));
  }
});

test("a command of the edit group on a robot reserved by someone else is a 409 and changes nothing", async () => {
  const t = setup();
  for (const [command, params] of [["points", { points: [] }], ["role", { role: "CNC" }], ["loop", { value: true }]] as const) {
    assert.equal((await t.call("2", { command, params })).status, 409, command);
  }
  assert.equal(t.writes.length, 0);
});

test("planRobotEdit never changes the robot it plans for", () => {
  const r: any = { id: 1, recordedPoints: [], playbackState: { isPlaying: false } };
  const before = JSON.stringify(r);
  const plan = planRobotEdit("points", { points: [point(1)] }, { robot: r, siblingIds: [1] });
  assert.equal(plan.ok, true);
  assert.equal(JSON.stringify(r), before);
});

test("the Bluetooth service never gets the edit commands", async () => {
  const { ROBOT_COMMANDS } = await import("../src/routes/commandRoutes.ts");
  for (const command of ["points", "loop", "model", "role", "combine", "joints", "xyTableConfig"]) assert.equal(ROBOT_COMMANDS.has(command), false, command);
  for (const command of ["stop", "play", "jog", "table", "trajectory"]) assert.equal(ROBOT_COMMANDS.has(command), true, command);
});
