import assert from "node:assert/strict";
import { test } from "node:test";
import { IDLE_FORGET_MS, JogSequence, MAX_ENTRIES, parseSequence } from "../src/jogSequence.ts";
import { registerCommandRoutes } from "../src/routes/commandRoutes.ts";

test("only an integer from 1 up is a sequence number", () => {
  for (const good of [1, 2, 9007199254740991]) assert.equal(parseSequence(good), good);
  for (const bad of [0, -1, 1.5, NaN, Infinity, "3", null, undefined, true, 9007199254740992, {}]) assert.equal(parseSequence(bad), null, String(bad));
});

test("a number must be above the highest one seen from the same account, controller and robot", () => {
  const seq = new JogSequence();
  assert.deepEqual(seq.accept(1, "u", "c", 5), { ok: true });
  assert.deepEqual(seq.accept(1, "u", "c", 5), { ok: false, last: 5 });
  assert.deepEqual(seq.accept(1, "u", "c", 3), { ok: false, last: 5 });
  assert.deepEqual(seq.accept(1, "u", "c", 6), { ok: true });
  // another robot, another account and another controller each have their own mark
  assert.deepEqual(seq.accept(2, "u", "c", 1), { ok: true });
  assert.deepEqual(seq.accept(1, "v", "c", 1), { ok: true });
  assert.deepEqual(seq.accept(1, "u", "d", 1), { ok: true });
  assert.deepEqual(seq.accept(1, "u", undefined, 1), { ok: true });
});

test("a stop with a number refuses every older motion command from then on, and never lowers the mark", () => {
  const seq = new JogSequence();
  seq.accept(1, "u", "c", 4);
  seq.noteStop(1, "u", "c", 9);
  assert.equal(seq.accept(1, "u", "c", 8).ok, false);
  assert.equal(seq.accept(1, "u", "c", 10).ok, true);
  seq.noteStop(1, "u", "c", 2);
  assert.equal(seq.accept(1, "u", "c", 10).ok, false, "a stop with a lower number must not lower the mark");
});

test("a mark is forgotten after an hour without a command and the table is bounded", () => {
  let now = 1_000;
  const seq = new JogSequence(() => now);
  seq.accept(1, "u", "c", 7);
  now += IDLE_FORGET_MS + 1;
  assert.equal(seq.accept(1, "u", "c", 1).ok, true);
  for (let robot = 100; robot < 100 + MAX_ENTRIES + 50; robot++) seq.accept(robot, "u", "c", 1);
  assert.ok(seq.size() <= MAX_ENTRIES);
});

// ---- through the route -------------------------------------------------------------------------------------------------------------------

function routes() {
  const settings: any = { controllers: [{ id: "c1", robots: [{ id: 1, name: "A", model: "Parol6 (6-DOF)", pos: { x: 0, y: 0, z: 0, a: 0, b: 0, c: 0 }, joints: {}, playbackState: {} }] }] };
  const posts: Record<string, any> = {};
  const app: any = { post(route: string, ...h: unknown[]) { posts[route] = h[h.length - 1]; }, get() {}, put() {} };
  registerCommandRoutes(app, {
    authenticate: () => undefined, getSettings: () => settings, isReservationActive: () => false, industrialLog: () => undefined,
    queueSettingsWrite: async () => undefined, broadcastRobotDelta: () => undefined, startServerPlayback: () => undefined, stopServerPlayback: () => undefined,
  } as any);
  const user = { id: "u1", username: "alice", role: "operator" };
  const send = async (body: any) => {
    let status = 200; let json: any;
    const res: any = { setHeader() {}, status(c: number) { status = c; return res; }, json(v: any) { json = v; return res; }, send() { return res; } };
    await posts["/api/robot/:id/command"]({ headers: {}, params: { id: "1" }, body, user, query: {}, ip: "10.0.0.9" }, res);
    return { status, json };
  };
  return { settings, send };
}

test("a numbered jog that arrives after a numbered stop sent later is refused and does not move the robot", async () => {
  const r = routes();
  assert.equal((await r.send({ command: "jog", seq: 1, params: { axis: "x", amount: 2 } })).status, 200);
  assert.equal((await r.send({ command: "stop", seq: 3 })).status, 200);
  const late = await r.send({ command: "jog", seq: 2, params: { axis: "x", amount: 2 } });
  assert.equal(late.status, 409);
  assert.equal(late.json.code, "stale-sequence");
  assert.equal(late.json.lastSeq, 3);
  assert.equal(r.settings.controllers[0].robots[0].pos.x, 2);
  assert.equal((await r.send({ command: "jog", seq: 4, params: { axis: "x", amount: 2 } })).status, 200);
  assert.equal(r.settings.controllers[0].robots[0].pos.x, 4);
});

test("a repeated number is refused, a number that is not valid is 400, and a command without one works as before", async () => {
  const r = routes();
  assert.equal((await r.send({ command: "jog", seq: 5, params: { axis: "x", amount: 1 } })).status, 200);
  assert.equal((await r.send({ command: "jog", seq: 5, params: { axis: "x", amount: 1 } })).status, 409);
  const bad = await r.send({ command: "jog", seq: "7", params: { axis: "x", amount: 1 } });
  assert.equal(bad.status, 400);
  assert.equal(bad.json.code, "invalid-sequence");
  assert.equal((await r.send({ command: "jog", params: { axis: "x", amount: 1 } })).status, 200);
  assert.equal(r.settings.controllers[0].robots[0].pos.x, 2);
});

test("a stop is never refused for its number, valid or not", async () => {
  const r = routes();
  await r.send({ command: "stop", seq: 10 });
  assert.equal((await r.send({ command: "stop", seq: 1 })).status, 200);
  assert.equal((await r.send({ command: "stop", seq: "nonsense" })).status, 200);
  assert.equal((await r.send({ command: "stop" })).status, 200);
});
