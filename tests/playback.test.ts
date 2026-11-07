// =============================================================================
// HYDRA-UMC-SERVER - Unit tests for the playback engine of the server
// Copyright (C) 2026 JuanenRac (Electro Hobby 3D) <electrohobby3d@gmail.com>
// GPL-3.0-or-later - see LICENSE
// =============================================================================
// The engine that replays the recorded points of a robot with a timer (src/playback.ts): one point per tick, the speed that sets the interval, pause, stop, repeat,
// the natural end that tells the phones a job finished, the table axes that are only moved by a robot that has a table, an id used by two robots that names none,
// and the helpers of the reservation (when it is active, the bounded history). The clock is a stand-in.
import test, { mock } from "node:test";
import assert from "node:assert/strict";
import { createPlayback } from "../src/playback.ts";
import { pushBus } from "../src/pushNotifications.ts";

function build(robots: any[], extra: { controllers?: any[] } = {}) {
  const settings: any = { controllers: extra.controllers ?? [{ id: "c1", robots }] };
  const deltas: any[] = [];
  let writes = 0;
  const playback = createPlayback({
    getSettings: () => settings,
    queueSettingsWrite: async () => { writes++; },
    broadcastRobotDelta: (d) => { deltas.push(...d); },
  });
  return { settings, playback, deltas, writes: () => writes };
}

const robot = (over: Record<string, unknown> = {}) => ({
  id: 1, name: "arm-3", joints: { j1: 0, j2: 0, j3: 0, j4: 7, j5: 8, j6: 9 }, pos: { x: 0, y: 0, z: 0 },
  playbackState: { isPlaying: true, playing: true, activeStep: 0, speed: 100 },
  recordedPoints: [{ j1: 10, j2: 20, j3: 30 }, { j1: 11, j2: 21, j3: 31, j4: 4 }, { x: 1, y: 2, z: 3, a: 4 }],
  ...over,
});

test("a robot that does not exist, or has no controller, starts nothing", () => {
  const { playback } = build([]);
  playback.startServerPlayback(99);
  playback.stopServerPlayback(99); // stopping what was never started is not an error
});

test("a robot with nothing recorded is shown as not playing at once", () => {
  const r = robot({ recordedPoints: [] });
  const { playback } = build([r]);
  playback.startServerPlayback(1);
  assert.equal(r.playbackState.isPlaying, false);
  assert.equal(r.playbackState.playing, false);
  assert.equal(r.playbackState.activeStep, -1);
});

test("each tick plays one point, with the wrist values it already had when the point does not carry them", () => {
  mock.timers.enable({ apis: ["setInterval"] });
  try {
    const r = robot();
    const { playback, deltas } = build([r]);
    playback.startServerPlayback(1);
    mock.timers.tick(600);
    assert.deepEqual(r.joints, { j1: 10, j2: 20, j3: 30, j4: 7, j5: 8, j6: 9 });
    assert.equal(r.playbackState.activeStep, 1);
    assert.equal(r.playbackState.trajectoryMode, "legacy-generic");
    mock.timers.tick(600);
    assert.equal(r.joints.j4, 4, "a point that carries a wrist value sets it");
    assert.equal(deltas.length, 2);
    assert.equal(deltas[0].controllerId, "c1");
    assert.deepEqual(Object.keys(deltas[0].patch).sort(), ["joints", "playbackState"]);
    playback.stopServerPlayback(1);
  } finally {
    mock.timers.reset();
  }
});

test("a cartesian point moves the position and says so, a compact triplet is a model-joints point", () => {
  mock.timers.enable({ apis: ["setInterval"] });
  try {
    const r = robot({ recordedPoints: [{ x: 1, y: 2, z: 3, a: 4 }, [5, 6, 7]] });
    const { playback } = build([r]);
    playback.startServerPlayback(1);
    mock.timers.tick(600);
    assert.deepEqual(r.pos, { x: 1, y: 2, z: 3, a: 4, b: undefined, c: undefined });
    assert.equal(r.playbackState.trajectoryMode, "cartesian");
    mock.timers.tick(600);
    assert.deepEqual([r.joints.j1, r.joints.j2, r.joints.j3], [5, 6, 7]);
    assert.equal(r.playbackState.trajectoryMode, "model-joints");
    playback.stopServerPlayback(1);
  } finally {
    mock.timers.reset();
  }
});

test("the table axes move only for a robot that really has a table", () => {
  mock.timers.enable({ apis: ["setInterval"] });
  try {
    const withTable = robot({ hasXYTable: true, xyTable: { pos: { x: 0, y: 0 }, tableSize: 300 }, recordedPoints: [{ tx: 5, ty: 6, trz: 7 }] });
    const without = robot({ id: 2, hasXYTable: false, xyTable: { pos: { x: 0, y: 0 } }, recordedPoints: [{ tx: 5, ty: 6 }] });
    const { playback } = build([withTable, without]);
    playback.startServerPlayback(1);
    playback.startServerPlayback(2);
    mock.timers.tick(600);
    assert.deepEqual(withTable.xyTable.pos, { x: 5, y: 6 });
    assert.equal(withTable.xyTable.tableSize, 300, "the rest of the table configuration is kept");
    assert.deepEqual([withTable.pos.tx, withTable.pos.ty, withTable.pos.trz], [5, 6, 7]);
    assert.deepEqual(without.xyTable.pos, { x: 0, y: 0 }, "a stale table configuration is not moved");
    assert.equal(without.pos.tx, undefined);
    playback.stopServerPlayback(1);
    playback.stopServerPlayback(2);
  } finally {
    mock.timers.reset();
  }
});

test("the speed sets the interval: faster is shorter, and never below 50 ms", () => {
  mock.timers.enable({ apis: ["setInterval"] });
  try {
    const fast = robot({ playbackState: { isPlaying: true, activeStep: 0, speed: 1200 } });
    const slow = robot({ id: 2, playbackState: { isPlaying: true, activeStep: 0, speed: 50 } });
    const { playback } = build([fast, slow]);
    playback.startServerPlayback(1);
    playback.startServerPlayback(2);
    mock.timers.tick(50);
    assert.equal(fast.playbackState.activeStep, 1, "1200 % plays a point every 50 ms");
    assert.equal(slow.playbackState.activeStep, 0);
    mock.timers.tick(1150);
    assert.equal(slow.playbackState.activeStep, 1, "50 % plays a point every 1200 ms");
    playback.stopServerPlayback(1);
    playback.stopServerPlayback(2);
  } finally {
    mock.timers.reset();
  }
});

test("a speed that is not a number is the normal speed", () => {
  mock.timers.enable({ apis: ["setInterval"] });
  try {
    const r = robot({ playbackState: { isPlaying: true, activeStep: 0, speed: "fast" } });
    const { playback } = build([r]);
    playback.startServerPlayback(1);
    mock.timers.tick(599);
    assert.equal(r.playbackState.activeStep, 0);
    mock.timers.tick(1);
    assert.equal(r.playbackState.activeStep, 1);
    playback.stopServerPlayback(1);
  } finally {
    mock.timers.reset();
  }
});

test("a paused robot keeps its timer but does not advance, and a stop request ends it", () => {
  mock.timers.enable({ apis: ["setInterval"] });
  try {
    const r = robot();
    const { playback, deltas } = build([r]);
    playback.startServerPlayback(1);
    r.playbackState = { ...r.playbackState, isPaused: true };
    mock.timers.tick(1800);
    assert.equal(r.playbackState.activeStep, 0);
    assert.equal(deltas.length, 0);
    r.playbackState = { ...r.playbackState, isPaused: false };
    mock.timers.tick(600);
    assert.equal(r.playbackState.activeStep, 1, "it goes on from where it was");
    r.playbackState = { ...r.playbackState, requestStop: true };
    mock.timers.tick(600);
    const after = deltas.length;
    mock.timers.tick(1800);
    assert.equal(deltas.length, after, "nothing is played after a stop request");
  } finally {
    mock.timers.reset();
  }
});

test("the natural end marks the robot finished and tells the phones once", () => {
  mock.timers.enable({ apis: ["setInterval"] });
  const events: any[] = [];
  const listener = (event: string, detail: any) => events.push([event, detail]);
  pushBus.on("event", listener);
  try {
    const r = robot({ recordedPoints: [{ j1: 1, j2: 2, j3: 3 }] });
    const { playback, deltas } = build([r]);
    playback.startServerPlayback(1);
    mock.timers.tick(600);
    mock.timers.tick(600);
    assert.equal(r.playbackState.isFinished, true);
    assert.equal(r.playbackState.isPlaying, false);
    assert.equal(r.playbackState.activeStep, -1);
    assert.deepEqual(events, [["job-finished", { robotName: "arm-3" }]]);
    mock.timers.tick(3000);
    assert.equal(events.length, 1, "the timer is gone, so it is not told again");
    assert.ok(deltas.length >= 2);
  } finally {
    pushBus.off("event", listener);
    mock.timers.reset();
  }
});

test("repeat goes round again without telling the phones", () => {
  mock.timers.enable({ apis: ["setInterval"] });
  const events: string[] = [];
  const listener = (event: string) => events.push(event);
  pushBus.on("event", listener);
  try {
    const r = robot({ recordedPoints: [{ j1: 1, j2: 2, j3: 3 }], playbackState: { isPlaying: true, activeStep: 0, speed: 100, isLooping: true } });
    const { playback } = build([r]);
    playback.startServerPlayback(1);
    for (let i = 0; i < 6; i++) mock.timers.tick(600);
    assert.equal(r.playbackState.isPlaying, true);
    assert.deepEqual(events, []);
    playback.stopServerPlayback(1);
  } finally {
    pushBus.off("event", listener);
    mock.timers.reset();
  }
});

test("starting again restarts cleanly with one timer, and a robot that disappears stops its timer", () => {
  mock.timers.enable({ apis: ["setInterval"] });
  try {
    const r = robot();
    const { playback, settings, deltas } = build([r]);
    playback.startServerPlayback(1);
    playback.startServerPlayback(1);
    mock.timers.tick(600);
    assert.equal(deltas.length, 1, "a second start does not leave a second timer running");
    settings.controllers[0].robots = [];
    mock.timers.tick(600);
    mock.timers.tick(1200);
    assert.equal(deltas.length, 1, "nothing is played for a robot that is gone");
  } finally {
    mock.timers.reset();
  }
});

test("an id used by two robots names none of them", () => {
  const a = robot();
  const b = robot({ name: "twin" });
  const { playback } = build([], { controllers: [{ id: "c1", robots: [a] }, { id: "c2", robots: [b] }] });
  assert.equal(playback.findRobotById(1), null);
  assert.equal(playback.findControllerIdForRobot(1), null);
  const solo = build([robot({ id: 5 })]);
  assert.equal(solo.playback.findRobotById(5).id, 5);
  assert.equal(solo.playback.findControllerIdForRobot(5), "c1");
  assert.equal(solo.playback.findRobotById(6), null);
});

test("a reservation is active until it expires", () => {
  const { playback } = build([]);
  assert.equal(playback.isReservationActive(undefined), false);
  assert.equal(playback.isReservationActive(null), false);
  assert.equal(playback.isReservationActive({}), false);
  assert.equal(playback.isReservationActive({ expiresAt: "soon" }), false);
  assert.equal(playback.isReservationActive({ expiresAt: Date.now() - 1 }), false);
  assert.equal(playback.isReservationActive({ expiresAt: Date.now() + 60_000 }), true);
  assert.ok(playback.MAX_RESERVATION_TTL_MS > playback.DEFAULT_RESERVATION_TTL_MS);
});

test("the history of a reservation keeps the last twenty entries, newest last, with the reason when there is one", () => {
  const { playback } = build([]);
  const r: any = {};
  for (let i = 0; i < 25; i++) playback.appendReservationHistory(r, i % 2 ? "released" : "claimed", `u${i}`, `name${i}`, i === 24 ? "forced" : undefined);
  assert.equal(r.reservationHistory.length, 20);
  assert.equal(r.reservationHistory[0].byUserId, "u5");
  assert.equal(r.reservationHistory[19].byUserId, "u24");
  assert.equal(r.reservationHistory[19].reason, "forced");
  assert.equal("reason" in r.reservationHistory[0], false);
  const own: any = { reservationHistory: "damaged" };
  playback.appendReservationHistory(own, "expired", "u", "n");
  assert.equal(own.reservationHistory.length, 1, "a damaged history starts again");
});
