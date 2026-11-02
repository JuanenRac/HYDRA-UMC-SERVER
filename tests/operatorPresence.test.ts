import assert from "node:assert/strict";
import { test } from "node:test";
import { OperatorPresence, parsePresenceBeat, presenceSettings, type PresenceDeps } from "../src/operatorPresence.ts";
import { SecurityConfig, SecurityConfigError, resolvePresence, resolvePresenceAction, type SecurityFile } from "../src/securityConfig.ts";
import { stoppedPlaybackState } from "../src/routes/commandRoutes.ts";

// Simulated robots and a simulated clock: nothing here talks to a real robot.

const alice = { id: 1, username: "alice" };
const bob = { id: 2, username: "bob" };

function robot(id: number, owner: number | null, speed = 100, playing = true) {
  return {
    id,
    name: `R${id}`,
    reservation: owner === null ? null : { ownerId: owner, ownerUsername: owner === 1 ? "alice" : "bob", active: true },
    playbackState: { isPlaying: playing, playing, isPaused: false, paused: false, requestStop: false, activeStep: 3, speed },
  };
}

function rig(file: Record<string, unknown> = {}, action: "slow" | "pause" | "notify" | "stop" = "slow", robots = [robot(10, 1), robot(11, 1, 200), robot(12, 2)]) {
  const clock = { now: 1_000_000 };
  const state = { enabled: true, action, file };
  const settings = { controllers: [{ id: "cell-a", robots }] };
  const deltas: { robotId: number; patch: any }[][] = [];
  const logs: string[] = [];
  const audits: any[] = [];
  const warned: string[][] = [];
  const stops: number[] = [];
  let persisted = 0;
  const deps: PresenceDeps = {
    enabled: () => state.enabled,
    settings: () => presenceSettings(state.file as any, state.action),
    now: () => clock.now,
    getSettings: () => settings,
    isReservationActive: (r) => r !== null && r !== undefined && r.active === true,
    stoppedPlaybackState,
    stopServerPlayback: (id) => { stops.push(id); },
    broadcastRobotDelta: (d) => { deltas.push(d.map((x) => ({ robotId: x.robotId, patch: x.patch }))); },
    persist: async () => { persisted++; },
    log: (l) => logs.push(l),
    audit: (e) => { audits.push(e); },
    warn: (names) => { warned.push(names); },
  };
  const presence = new OperatorPresence(deps);
  const beat = (user = alice, sequence = 0, stateWord: "PRESENT" | "LEFT" = "PRESENT") => presence.beat(user, { sequence, intervalSeconds: 5, state: stateWord });
  const advance = (ms: number, step = 1000) => { for (let t = 0; t < ms; t += step) { clock.now += Math.min(step, ms - t); presence.tick(); } };
  return { presence, robots, clock, state, deltas, logs, audits, warned, stops, beat, advance, persisted: () => persisted };
}

test("a heartbeat body is checked: the numbered message of the watch, nothing else", () => {
  assert.deepEqual(parsePresenceBeat({ type: "presence_heartbeat", protocolVersion: 1, sequence: 4, intervalSeconds: 5, state: "PRESENT" }), { ok: true, beat: { sequence: 4, intervalSeconds: 5, state: "PRESENT" } });
  assert.equal(parsePresenceBeat({ sequence: 0, intervalSeconds: 60, state: "LEFT" }).ok, true);
  for (const bad of [null, [], "x", {}, { sequence: -1, intervalSeconds: 5, state: "PRESENT" }, { sequence: 1.5, intervalSeconds: 5, state: "PRESENT" }, { sequence: 1, intervalSeconds: 0, state: "PRESENT" },
    { sequence: 1, intervalSeconds: 61, state: "PRESENT" }, { sequence: 1, intervalSeconds: 5, state: "HERE" }, { type: "other", sequence: 1, intervalSeconds: 5, state: "PRESENT" }, { protocolVersion: 2, sequence: 1, intervalSeconds: 5, state: "PRESENT" }]) {
    assert.equal(parsePresenceBeat(bad).ok, false, JSON.stringify(bad));
  }
});

test("a heartbeat is idempotent by its number: a repeat changes nothing, an old one is stale, a restarted sender counts after a silence", () => {
  const r = rig();
  assert.equal(r.beat(alice, 5).result, "accepted");
  assert.equal(r.beat(alice, 5).result, "duplicate");
  assert.equal(r.beat(alice, 3).result, "stale");
  assert.equal(r.beat(alice, 6).result, "accepted");
  r.advance(60_000);
  assert.equal(r.presence.status(1).state, "lost");
  assert.equal(r.beat(alice, 0).result, "accepted", "after a long silence a lower number is a restart of the sender");
});

test("with the heartbeat lost the speed of the robots of that operator goes down, and nobody else's is touched", () => {
  const r = rig();
  r.beat(alice, 1);
  r.advance(10_000);
  assert.equal(r.presence.status(1).state, "present");
  assert.equal(r.robots[0].playbackState.speed, 100);
  r.advance(10_000);
  assert.equal(r.presence.status(1).state, "lost");
  assert.equal(r.robots[0].playbackState.speed, 30);
  assert.equal(r.robots[1].playbackState.speed, 60);
  assert.equal(r.robots[2].playbackState.speed, 100, "a robot of another account is not touched");
  assert.equal(r.robots[0].playbackState.isPlaying, true, "slowing never stops the robot");
  assert.deepEqual(r.warned, [["R10", "R11"]]);
  assert.equal(r.audits.filter((a) => a.type === "operator-presence-lost").length, 1);
  assert.ok(r.persisted() >= 1);
  assert.deepEqual(r.presence.status(1).degradedRobots.sort(), [10, 11]);
});

test("while it is lost a speed raised again is brought back to the cap, and a robot taken meanwhile is held", () => {
  const r = rig();
  r.beat(alice, 1);
  r.advance(20_000);
  r.robots[0].playbackState.speed = 150;
  r.advance(1000);
  assert.equal(r.robots[0].playbackState.speed, 30);
  r.robots[2].reservation = { ownerId: 1, ownerUsername: "alice", active: true };
  r.advance(1000);
  assert.equal(r.robots[2].playbackState.speed, 30);
});

test("the speed never goes under the lowest speed a robot accepts", () => {
  const r = rig({ slowFactor: 0.05 }, "slow", [robot(10, 1, 100)]);
  r.beat(alice, 1);
  r.advance(20_000);
  assert.equal(r.robots[0].playbackState.speed, 10);
  const slow = rig({}, "slow", [robot(10, 1, 10)]);
  slow.beat(alice, 1);
  slow.advance(20_000);
  assert.equal(slow.robots[0].playbackState.speed, 10, "a robot already at the minimum is not made slower");
});

test("back needs several heartbeats in a row, and then the speed returns along the ramp without a jump", () => {
  const r = rig({ recoverBeats: 3, rampSeconds: 5 });
  r.beat(alice, 1);
  r.advance(20_000);
  assert.equal(r.robots[0].playbackState.speed, 30);
  r.beat(alice, 2);
  r.advance(1000);
  assert.equal(r.presence.status(1).state, "recovering");
  assert.equal(r.robots[0].playbackState.speed, 30, "one heartbeat is not enough");
  r.advance(30_000);
  assert.equal(r.presence.status(1).state, "lost", "the heartbeats stopped again before the third one: lost again, the count starts over");
  r.beat(alice, 3); r.beat(alice, 4);
  assert.equal(r.presence.status(1).state, "recovering");
  r.beat(alice, 5);
  assert.equal(r.presence.status(1).state, "present");
  assert.equal(r.robots[0].playbackState.speed, 30, "the speed has not jumped back");
  const seen: number[] = [];
  for (let i = 0; i < 8; i++) { r.advance(1000); r.beat(alice, 6 + i); seen.push(r.robots[0].playbackState.speed); }
  assert.ok(seen.every((v, i) => i === 0 || v >= seen[i - 1]), "never down while returning");
  assert.ok(seen[0] - 30 <= 14 + 1, `the first step is small, was ${seen[0]}`);
  assert.equal(r.robots[0].playbackState.speed, 100);
  assert.equal(r.robots[1].playbackState.speed, 200);
  assert.equal(r.presence.status(1).degradedRobots.length, 0);
  assert.equal(r.audits.filter((a) => a.type === "operator-presence-restored").length, 1);
});

test("a speed the operator sets while it returns is kept as they set it", () => {
  const r = rig({ recoverBeats: 1, rampSeconds: 10 });
  r.beat(alice, 1);
  r.advance(20_000);
  r.beat(alice, 2);
  r.advance(2000);
  r.beat(alice, 3);
  r.robots[0].playbackState.speed = 45;
  r.advance(5000);
  assert.equal(r.robots[0].playbackState.speed, 45);
});

test("pause pauses what is running and does not resume it when the operator is back", () => {
  const r = rig({ recoverBeats: 1 }, "pause", [robot(10, 1, 100, true), robot(11, 1, 100, false)]);
  r.beat(alice, 1);
  r.advance(20_000);
  assert.equal(r.robots[0].playbackState.isPaused, true);
  assert.equal(r.robots[1].playbackState.isPaused, false, "an idle robot is not made to look paused");
  assert.equal(r.robots[0].playbackState.speed, 100, "pause does not change the speed");
  r.beat(alice, 2);
  r.advance(20_000);
  assert.equal(r.robots[0].playbackState.isPaused, true, "still paused: only the operator resumes it");
});

test("stop stops the playback of the robots of that operator and does not start them again", () => {
  const r = rig({ recoverBeats: 1 }, "stop");
  r.beat(alice, 1);
  r.advance(20_000);
  assert.deepEqual(r.stops.sort(), [10, 11]);
  assert.equal(r.robots[0].playbackState.isPlaying, false);
  assert.equal(r.robots[0].playbackState.requestStop, true);
  assert.equal(r.robots[2].playbackState.isPlaying, true);
  r.beat(alice, 2);
  r.advance(10_000);
  assert.equal(r.robots[0].playbackState.isPlaying, false);
});

test("notify only warns: no robot is touched", () => {
  const r = rig({}, "notify");
  const before = JSON.stringify(r.robots);
  r.beat(alice, 1);
  r.advance(20_000);
  assert.equal(JSON.stringify(r.robots), before);
  assert.equal(r.warned.length, 1);
  assert.equal(r.audits[0].detail.action, "notify");
  assert.equal(r.deltas.length, 0);
});

test("a heartbeat that says LEFT acts at once, or after the timeout when the file says so", () => {
  const now = rig();
  now.beat(alice, 1);
  now.beat(alice, 2, "LEFT");
  assert.equal(now.robots[0].playbackState.speed, 30);
  assert.equal(now.audits[0].detail.reason, "left");
  const later = rig({ leftImmediate: false });
  later.beat(alice, 1);
  later.beat(alice, 2, "LEFT");
  assert.equal(later.robots[0].playbackState.speed, 100);
  later.advance(20_000);
  assert.equal(later.robots[0].playbackState.speed, 30);
});

test("the global stop is never undone by the presence: a stopped robot stays stopped when the speed returns", () => {
  const r = rig({ recoverBeats: 1, rampSeconds: 0 });
  r.beat(alice, 1);
  r.advance(20_000);
  for (const x of r.robots) x.playbackState = { ...stoppedPlaybackState(x.playbackState), speed: (x.playbackState as any).speed } as any;
  r.beat(alice, 2);
  r.advance(5000);
  for (const x of r.robots) { assert.equal(x.playbackState.isPlaying, false); assert.equal(x.playbackState.requestStop, true); }
  assert.equal(r.robots[0].playbackState.speed, 100, "only the speed came back");
});

test("a robot that changed hands while held back keeps the speed it has", () => {
  const r = rig({ recoverBeats: 1 });
  r.beat(alice, 1);
  r.advance(20_000);
  r.robots[0].reservation = { ownerId: 2, ownerUsername: "bob", active: true };
  r.beat(alice, 2);
  r.advance(20_000);
  assert.equal(r.robots[0].playbackState.speed, 30);
});

test("switching the function off lets the lowered speeds return and forgets the operators", () => {
  const r = rig({ rampSeconds: 0 });
  r.beat(alice, 1);
  r.advance(20_000);
  r.state.enabled = false;
  r.advance(2000);
  assert.equal(r.robots[0].playbackState.speed, 100);
  assert.equal(r.presence.status(1).state, "unknown");
});

test("two operators are followed separately", () => {
  const r = rig();
  r.beat(alice, 1);
  r.beat(bob, 1);
  r.advance(8000);
  r.beat(bob, 2);
  r.advance(8000);
  assert.equal(r.presence.status(1).state, "lost");
  assert.equal(r.presence.status(2).state, "present");
  assert.equal(r.robots[0].playbackState.speed, 30);
  assert.equal(r.robots[2].playbackState.speed, 100);
});

test("the times in the file are limited to sane values", () => {
  const s = presenceSettings({ timeoutSeconds: 1, slowFactor: 5, recoverBeats: 99, rampSeconds: 9999, leftImmediate: false }, "slow");
  assert.deepEqual([s.timeoutMs, s.slowFactor, s.recoverBeats, s.rampMs, s.leftImmediate], [3000, 0.9, 20, 120_000, false]);
  const d = presenceSettings(undefined, "slow");
  assert.deepEqual([d.timeoutMs, d.slowFactor, d.recoverBeats, d.rampMs, d.leftImmediate], [15_000, 0.3, 3, 5000, true]);
});

// ---- the switch and the action in the security configuration

function makeConfig(env: any = {}, initial: SecurityFile = {}) {
  let stored: SecurityFile = { ...initial };
  const logs: string[] = [];
  const config = new SecurityConfig({ env, load: () => ({ ...stored }), save: (file) => { stored = { ...file }; }, tlsActive: false, log: (m) => logs.push(m) });
  return { config, logs, stored: () => stored };
}
const bad400 = (e: unknown) => e instanceof SecurityConfigError && e.status === 400;

test("the function is off by default and the default action, when it is turned on, is to slow down", () => {
  const { config } = makeConfig({});
  assert.equal(config.presenceEnabled(), false);
  assert.equal(config.presenceAction(), "slow");
  assert.deepEqual(config.snapshot().presence.enabled, { value: false, source: "default" });
  assert.deepEqual(config.snapshot().presence.action, { value: "slow", source: "default" });
  assert.equal(makeConfig({ presence: "1" }).config.presenceEnabled(), true);
  for (const word of ["true", "yes", "on", "0", ""]) assert.equal(makeConfig({ presence: word }).config.presenceEnabled(), false, word);
  assert.deepEqual(resolvePresence(undefined, { presence: { enabled: true } }), { value: true, source: "config" });
  assert.deepEqual(resolvePresenceAction("STOP", {}), { value: "stop", source: "env" });
  assert.equal(resolvePresenceAction("explode", { presence: { action: "pause" } }).value, "pause", "a word that is not an action is ignored");
});

test("an administrator turns it on and picks the action; the environment locks each", () => {
  const { config, logs, stored } = makeConfig({});
  const on = config.update({ presence: { enabled: true, action: "pause" } }, "root");
  assert.equal(config.presenceEnabled(), true);
  assert.equal(config.presenceAction(), "pause");
  assert.ok(on.warnings.includes("presence_on"));
  assert.equal(stored().presence?.action, "pause");
  assert.ok(logs.some((l) => l.includes("dead-man")));
  assert.ok(config.update({ presence: { action: "notify" } }, "root").warnings.includes("presence_action_notify"));
  for (const value of ["slowly", 1, null]) assert.throws(() => config.update({ presence: { action: value } }, "root"), bad400);
  for (const value of ["yes", 1, null]) assert.throws(() => config.update({ presence: { enabled: value } }, "root"), bad400);
  assert.throws(() => config.update({ presence: [] }, "root"), bad400);
  assert.throws(() => makeConfig({ presence: "1" }).config.update({ presence: { enabled: false } }, "root"), (e: unknown) => e instanceof SecurityConfigError && e.status === 409);
  assert.throws(() => makeConfig({ presenceAction: "stop" }).config.update({ presence: { action: "slow" } }, "root"), (e: unknown) => e instanceof SecurityConfigError && e.status === 409);
});

test("the times kept in the file survive a change of the switch and are shown read only", () => {
  const { config, stored } = makeConfig({}, { presence: { timeoutSeconds: 40, slowFactor: 0.5 } });
  config.update({ presence: { enabled: true } }, "root");
  assert.equal(stored().presence?.timeoutSeconds, 40);
  const snap = config.snapshot().presence;
  assert.equal(snap.timeoutSeconds, 40);
  assert.equal(snap.slowFactor, 0.5);
  assert.equal(snap.recoverBeats, 3);
});
