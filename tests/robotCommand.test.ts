import assert from "node:assert/strict";
import { test } from "node:test";
import { registerCommandRoutes } from "../src/routes/commandRoutes.ts";

type Handler = (req: any, res: any) => Promise<unknown>;

function makeSettings() {
  return {
    controllers: [
      {
        id: "c1",
        cameras: [{ id: 1, assignedRobotId: 1, connected: false }],
        robots: [
          { id: 1, name: "A1", pos: { x: 0, y: 0, z: 0, a: 0, b: 0, c: 0 }, joints: {}, combinedWith: [2], valves: [false, false], pumps: [false, false], playbackState: { speed: 100 } },
          { id: 2, name: "A2", pos: { x: 0, y: 0, z: 0, a: 0, b: 0, c: 0 }, joints: {}, reservation: { ownerId: "bob-id", ownerUsername: "bob", expiresAt: Date.now() + 60_000 } },
          { id: 3, name: "B", pos: { x: 1, y: 2, z: 3, a: 0, b: 0, c: 0 }, joints: {}, hasXYTable: true, xyTable: { pos: { x: 0, y: 0 } } },
        ],
      },
    ],
  };
}

function setup(settings: any = makeSettings()) {
  let handler: Handler | undefined;
  const app: any = { post(route: string, ...handlers: unknown[]) { if (route === "/api/robot/:id/command") handler = handlers[handlers.length - 1] as Handler; } };
  const writes: any[] = [];
  const deltas: any[] = [];
  const started: number[] = [];
  const stopped: number[] = [];
  registerCommandRoutes(app, {
    authenticate: () => undefined,
    getSettings: () => settings,
    industrialLog: () => undefined,
    isReservationActive: (r: any) => !!r && r.expiresAt > Date.now(),
    queueSettingsWrite: async (payload: any) => { writes.push(payload); },
    broadcastRobotDelta: (batch: any[]) => { deltas.push(...batch); },
    startServerPlayback: (id: number) => { started.push(id); },
    stopServerPlayback: (id: number) => { stopped.push(id); },
  } as any);
  const call = async (id: string, body: any, user: any = { id: "alice-id", username: "alice", role: "operator" }) => {
    let status = 200;
    let json: any;
    const res: any = { headers: {} as Record<string, string>, setHeader(k: string, v: string) { res.headers[k] = v; }, status(code: number) { status = code; return res; }, json(value: any) { json = value; return res; } };
    await handler!({ params: { id }, body, user }, res);
    return { status, json };
  };
  return { call, settings, writes, deltas, started, stopped };
}

const robot = (s: any, id: number) => s.controllers[0].robots.find((r: any) => r.id === id);

test("an unknown, missing or non-string command is refused with 400 before any state is touched", async () => {
  const t = setup();
  for (const command of ["rm -rf", "__proto__", "", 7, null, undefined, ["stop"]]) {
    const r = await t.call("1", { command });
    assert.equal(r.status, 400, JSON.stringify(command));
  }
  assert.equal(t.writes.length, 0);
});

test("a robot that does not exist, or an id that is not a number, is a 404", async () => {
  const t = setup();
  assert.equal((await t.call("99", { command: "play" })).status, 404);
  assert.equal((await t.call("abc", { command: "play" })).status, 404);
  assert.equal(t.writes.length, 0);
});

test("a settings tree with no controllers is a 400, not a crash", async () => {
  const t = setup({});
  assert.equal((await t.call("1", { command: "play" })).status, 400);
});

test("a command on a robot claimed by someone else is a 409 that names the owner, and changes nothing", async () => {
  const t = setup();
  const r = await t.call("2", { command: "play" });
  assert.equal(r.status, 409);
  assert.match(r.json.error, /claimed by bob/);
  assert.equal(r.json.reservation.ownerId, "bob-id");
  assert.equal(robot(t.settings, 2).playbackState, undefined);
  assert.equal(t.started.length, 0);
  assert.equal(t.writes.length, 0);
});

test("the claim check covers combined siblings: moving the group through a free robot is refused when a sibling is claimed", async () => {
  const t = setup();
  const r = await t.call("1", { command: "play" });
  assert.equal(r.status, 409);
  assert.equal(robot(t.settings, 1).playbackState.isPlaying, undefined);
});

test("stop is never blocked by someone else's claim and stops the whole group", async () => {
  const t = setup();
  const r = await t.call("1", { command: "stop" });
  assert.equal(r.status, 200);
  assert.equal(r.json.success, true);
  assert.equal(r.json.affectedCount, 2);
  assert.deepEqual(t.stopped.sort(), [1, 2]);
  assert.equal(robot(t.settings, 2).playbackState.requestStop, true);
  assert.equal(t.writes.length, 1);
});

test("the owner of a claim, and an expired claim, are not blocked", async () => {
  const t = setup();
  assert.equal((await t.call("2", { command: "reset3D" }, { id: "bob-id", username: "bob", role: "operator" })).status, 200);
  robot(t.settings, 2).reservation.expiresAt = Date.now() - 1;
  assert.equal((await t.call("2", { command: "reset3D" })).status, 200);
});

test("jog rejects NaN, infinite, oversized amounts and unknown axes without moving the robot", async () => {
  const t = setup();
  const before = JSON.stringify(robot(t.settings, 3).pos);
  const bad = [
    { axis: "x", amount: NaN }, { axis: "x", amount: Infinity }, { axis: "x", amount: 1001 }, { axis: "x", amount: "5" },
    { axis: "__proto__", amount: 1 }, { axis: "constructor", amount: 1 }, { axis: "w", amount: 1 }, { amount: 1 },
  ];
  for (const params of bad) {
    const r = await t.call("3", { command: "jog", params });
    assert.equal(r.status, 200);
    assert.equal(r.json.warnings?.[0]?.field, "jog", JSON.stringify(params));
  }
  assert.equal(JSON.stringify(robot(t.settings, 3).pos), before);
  assert.equal(t.deltas.length, 0, "a rejected jog broadcasts nothing");
});

test("jog adds a relative amount, sets an absolute one, and drives the XY table without touching the arm", async () => {
  const t = setup();
  await t.call("3", { command: "jog", params: { axis: "x", amount: 10 } });
  assert.equal(robot(t.settings, 3).pos.x, 11);
  await t.call("3", { command: "jog", params: { axis: "x", amount: 5, absolute: true } });
  assert.equal(robot(t.settings, 3).pos.x, 5);
  await t.call("3", { command: "jog", params: { axis: "y", amount: 4, target: "xytable" } });
  assert.equal(robot(t.settings, 3).xyTable.pos.y, 4);
  assert.equal(robot(t.settings, 3).pos.y, 2);
  const last = t.deltas[t.deltas.length - 1];
  assert.ok(last.patch.xyTable.pos, "the full xyTable object is sent, not just a pos fragment");
});

test("a client-supplied joints override must be six finite numbers or it is ignored", async () => {
  const t = setup();
  await t.call("3", { command: "jog", params: { axis: "x", amount: 1, joints: { j1: 1, j2: 2, j3: 3, j4: 4, j5: 5, j6: NaN } } });
  assert.notEqual(robot(t.settings, 3).joints.j1, 1);
  await t.call("3", { command: "jog", params: { axis: "x", amount: 1, joints: { j1: 1, j2: 2, j3: 3, j4: 4, j5: 5, j6: 6 } } });
  assert.deepEqual(robot(t.settings, 3).joints, { j1: 1, j2: 2, j3: 3, j4: 4, j5: 5, j6: 6 });
});

test("valve and pump indexes are bounded to 0-7 integers with a boolean state", async () => {
  const t = setup();
  for (const params of [{ index: -1, state: true }, { index: 8, state: true }, { index: 1.5, state: true }, { index: "1", state: true }, { index: 1, state: "on" }, { index: 1 }]) {
    const v = await t.call("1", { command: "valve", params }, { id: "bob-id", username: "bob", role: "operator" });
    assert.equal(v.json.warnings?.[0]?.field, "valve", JSON.stringify(params));
    const p = await t.call("1", { command: "pump", params }, { id: "bob-id", username: "bob", role: "operator" });
    assert.equal(p.json.warnings?.[0]?.field, "pump", JSON.stringify(params));
  }
  assert.equal(robot(t.settings, 1).valves.length, 2, "the array is never grown by a bad index");
  await t.call("1", { command: "valve", params: { index: 7, state: true } }, { id: "bob-id", username: "bob", role: "operator" });
  assert.equal(robot(t.settings, 1).valves[7], true);
});

test("speed and acceleration outside 10-500 are refused per field, and a valid one is applied", async () => {
  const t = setup();
  const bob = { id: "bob-id", username: "bob", role: "operator" };
  const r = await t.call("1", { command: "speed", params: { speed: 9, acceleration: 501 } }, bob);
  assert.equal(r.json.warnings.length, 2 * 2, "one warning per field per affected robot");
  assert.equal(robot(t.settings, 1).playbackState.speed, 100);
  await t.call("1", { command: "speed", params: { speed: 250, acceleration: NaN } }, bob);
  assert.equal(robot(t.settings, 1).playbackState.speed, 250);
  assert.equal(robot(t.settings, 1).playbackState.acceleration, undefined);
});

test("jogStep only accepts a finite value in (0, 1000]", async () => {
  const t = setup();
  for (const value of [0, -1, 1001, NaN, "5"]) await t.call("3", { command: "jogStep", params: { value } });
  assert.equal(robot(t.settings, 3).jogStep, undefined);
  await t.call("3", { command: "jogStep", params: { value: 25 } });
  assert.equal(robot(t.settings, 3).jogStep, 25);
});

test("trajectory validation: point count, finite fields, motion type, required pose, file names", async () => {
  const t = setup();
  const pt = { x: 1, y: 2, z: 3 };
  const reject = async (params: any, why: string) => {
    const r = await t.call("3", { command: "trajectory", params });
    assert.equal(r.status, 400, why);
    assert.equal(robot(t.settings, 3).recordedPoints, undefined, why);
  };
  await reject({ points: [] }, "empty");
  await reject({ points: "x" }, "not an array");
  await reject({ points: new Array(10001).fill(pt) }, "too many");
  await reject({ points: [null] }, "null point");
  await reject({ points: [[1, 2, 3]] }, "array point");
  await reject({ points: [{ x: 1, y: 2 }] }, "incomplete pose");
  await reject({ points: [{ x: 1, y: 2, z: Infinity }] }, "non-finite");
  await reject({ points: [{ ...pt, motionType: "teleport" }] }, "bad motion type");
});

test("trajectory table axes need a configured XY table, and work files and example ids must be safe names", async () => {
  const t = setup();
  const bob = { id: "bob-id", username: "bob", role: "operator" };
  const withTable = { x: 1, y: 2, z: 3, tx: 1, ty: 2 };
  assert.equal((await t.call("1", { command: "trajectory", params: { points: [withTable] } }, bob)).status, 400);
  assert.equal(robot(t.settings, 1).recordedPoints, undefined);
  for (const selectedWorkFile of ["../x.json", "a/b.json", "x.txt", ".hidden.json", 5]) {
    assert.equal((await t.call("3", { command: "trajectory", params: { points: [{ x: 1, y: 2, z: 3 }], selectedWorkFile } })).status, 400, String(selectedWorkFile));
  }
  for (const selectedExample of ["../x", "a b", "", 5]) {
    assert.equal((await t.call("3", { command: "trajectory", params: { points: [{ x: 1, y: 2, z: 3 }], selectedExample } })).status, 400, String(selectedExample));
  }
  assert.equal(robot(t.settings, 3).recordedPoints, undefined);
});

test("a valid trajectory is stored only on the target robot, strips unknown fields and resets playback", async () => {
  const t = setup();
  const bob = { id: "bob-id", username: "bob", role: "operator" };
  const r = await t.call("1", { command: "trajectory", params: { points: [{ j1: 1, j2: 2, j3: 3, j4: 4, j5: 5, j6: 6, evil: "x", motionType: "model-joints" }], selectedWorkFile: "job_1.json", selectedExample: "demo-1" } }, bob);
  assert.equal(r.status, 200);
  assert.equal(r.json.affectedCount, 1, "a trajectory never reaches combined siblings");
  assert.deepEqual(robot(t.settings, 1).recordedPoints, [{ j1: 1, j2: 2, j3: 3, j4: 4, j5: 5, j6: 6, motionType: "model-joints" }]);
  assert.equal(robot(t.settings, 1).selectedWorkFile, "job_1.json");
  assert.equal(robot(t.settings, 1).playbackState.isPlaying, false);
  assert.equal(robot(t.settings, 2).recordedPoints, undefined);
});

test("vision toggles the robot and its assigned camera together; play starts the server timer", async () => {
  const t = setup();
  await t.call("3", { command: "vision", params: { enabled: "yes" } });
  assert.equal(robot(t.settings, 3).visionEnabled, undefined);
  const bob = { id: "bob-id", username: "bob", role: "operator" };
  await t.call("1", { command: "vision", params: { enabled: true } }, bob);
  assert.equal(t.settings.controllers[0].cameras[0].connected, true);
  const last = t.deltas.find((d: any) => d.robotId === 1);
  assert.deepEqual(last.cameraPatch, { connected: true });
  await t.call("3", { command: "play" });
  assert.deepEqual(t.started, [3]);
});

test("the Prometheus command label comes from a closed list and never from client text", async () => {
  const { commandMetricLabel } = await import("../src/routes/commandRoutes.ts");
  const { registry } = await import("../src/metrics.ts");
  for (const known of ["stop", "play", "jog", "speed", "trajectory", "vision"]) {
    assert.equal(commandMetricLabel(known), known);
  }
  for (const hostile of ["rm -rf", "__proto__", "x".repeat(500), "stop ", "STOP", "", 7, null, undefined, ["stop"], { command: "stop" }]) {
    assert.equal(commandMetricLabel(hostile), "unknown", JSON.stringify(hostile));
  }
  // Valid requests add series only for the closed list, however many distinct hostile names were tried before.
  const t = setup();
  for (let i = 0; i < 50; i++) await t.call("1", { command: `made-up-${i}` });
  await t.call("3", { command: "reset3D" });
  const text = await registry.getSingleMetricAsString("hydra_robot_commands_total");
  assert.ok(!text.includes("made-up"), text);
  const labels = [...text.matchAll(/command="([^"]*)"/g)].map((m) => m[1]);
  for (const label of labels) {
    assert.ok(["stop-all", "unknown", "stop", "play", "pause", "jog", "reset", "jogStep", "reset3D", "tool", "valve", "pump", "speed", "trajectory", "vision"].includes(label), label);
  }
  assert.ok(labels.includes("reset3D"));
});
