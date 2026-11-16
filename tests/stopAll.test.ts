import assert from "node:assert/strict";
import { test } from "node:test";
import { registerCommandRoutes } from "../src/routes/commandRoutes.ts";

type Handler = (req: any, res: any) => Promise<void>;

function setup(options: { settings: any; stopThrows?: number[]; saveRejects?: boolean; broadcastThrows?: boolean; deps?: Record<string, unknown> }) {
  let handler: Handler | undefined;
  let releaseHandler: ((req: any, res: any) => unknown) | undefined;
  let chain: unknown[] = [];
  const app: any = { post(route: string, ...handlers: unknown[]) {
    if (route === "/api/stop-all") { chain = handlers; handler = handlers[handlers.length - 1] as Handler; }
    if (route === "/api/stop-all/release") releaseHandler = handlers[handlers.length - 1] as (req: any, res: any) => unknown;
  } };
  const logs: string[] = [];
  const audits: any[] = [];
  const stopped: number[] = [];
  const deltas: any[] = [];
  const authenticate = () => undefined;
  registerCommandRoutes(app, {
    authenticate,
    getSettings: () => options.settings,
    industrialLog: (message: string) => { logs.push(message); },
    isReservationActive: (reservation: any) => !!reservation && reservation.expiresAt > Date.now(),
    queueSettingsWrite: async () => { if (options.saveRejects) throw new Error("disk full"); },
    broadcastRobotDelta: (batch: any[]) => { if (options.broadcastThrows) throw new Error("socket gone"); deltas.push(...batch); },
    startServerPlayback: () => undefined,
    stopServerPlayback: (id: number) => { if (options.stopThrows?.includes(id)) throw new Error("timer broken"); stopped.push(id); },
    audit: { record: (event: any) => { audits.push(event); } },
    ...(options.deps ?? {}),
  } as any);
  const call = async (user: any = { id: "u1", username: "alice", role: "operator" }) => {
    let body: any;
    const res: any = { json: (value: any) => { body = value; return res; } };
    await handler!({ user, ip: "10.0.0.7" }, res);
    return body;
  };
  const release = async (user: any = { id: "a1", username: "root", role: "admin" }) => {
    let status = 200;
    let body: any;
    const res: any = { status(code: number) { status = code; return res; }, json(value: any) { body = value; return res; } };
    await releaseHandler!({ user, ip: "10.0.0.8" }, res);
    return { status, body };
  };
  return { call, release, logs, audits, stopped, deltas, chain: () => chain, authenticate };
}

const fixture = () => ({
  controllers: [
    { id: "c1", robots: [
      { id: 1, name: "A", playbackState: { isPlaying: true, speed: 120 }, valves: [true, false, true], pumps: [true], reservation: { ownerId: "u2", ownerUsername: "bob", expiresAt: Date.now() + 60000 } },
      { id: 2, name: "B", playbackState: { isPlaying: true } },
    ] },
    { id: "c2", robots: [{ id: 3, name: "C", valves: [false], pumps: [false, false], reservation: { ownerId: "u1", ownerUsername: "alice", expiresAt: Date.now() + 60000 } }] },
  ],
});

test("global stop stops every robot, ignores another account's reservation and switches valves and pumps off", async () => {
  const settings = fixture();
  const t = setup({ settings });
  const body = await t.call();
  assert.equal(body.success, true);
  assert.equal(body.stoppedCount, 3);
  assert.equal(body.failedCount, 0);
  assert.equal(body.persisted, true);
  assert.deepEqual(t.stopped, [1, 2, 3]);
  const [a, b, c] = body.robots;
  assert.deepEqual([a.robotId, a.controllerId, a.stopped, a.valvesOff, a.pumpsOff, a.reservedBy], [1, "c1", true, 2, 1, "bob"]);
  assert.equal(b.reservedBy, undefined);
  assert.equal(c.reservedBy, undefined, "the caller's own reservation is not reported as foreign");
  assert.deepEqual([b.valvesOff, b.pumpsOff, c.valvesOff, c.pumpsOff], [0, 0, 0, 0]);
  const robotA = settings.controllers[0].robots[0] as any;
  assert.equal(robotA.playbackState.isPlaying, false);
  assert.equal(robotA.playbackState.requestStop, true);
  assert.equal(robotA.playbackState.speed, 120, "the rest of the playback state is kept");
  assert.deepEqual(robotA.valves, [false, false, false]);
  assert.deepEqual(robotA.pumps, [false]);
  assert.equal((settings.controllers[0].robots[1] as any).valves, undefined, "a robot without valves does not get an array invented");
  assert.equal(t.deltas.length, 3);
  assert.deepEqual(t.deltas[0].patch.valves, [false, false, false]);
  assert.equal(t.deltas[1].patch.valves, undefined);
  assert.equal(t.logs.length, 1);
  assert.match(t.logs[0], /GLOBAL STOP by alice \(operator\) from 10\.0\.0\.7: 3\/3 robot\(s\) stopped, 2 valve\(s\) and 1 pump\(s\) switched off, 1 reserved by another account/);
});

test("global stop with no settings or no robots answers success with an empty list", async () => {
  for (const settings of [{}, { controllers: [] }, { controllers: [{ id: "c", robots: [] }, { id: "d" }] }, null]) {
    const t = setup({ settings });
    const body = await t.call();
    assert.deepEqual([body.success, body.stoppedCount, body.failedCount, body.robots.length], [true, 0, 0, 0]);
  }
});

test("global stop keeps going when one robot fails and says which", async () => {
  const settings = fixture();
  const t = setup({ settings, stopThrows: [2] });
  const body = await t.call({ id: "u9", username: "root", role: "admin" });
  assert.equal(body.success, false);
  assert.deepEqual([body.stoppedCount, body.failedCount], [2, 1]);
  assert.equal(body.robots[1].stopped, false);
  assert.equal(body.robots[1].error, "timer broken");
  assert.equal(body.robots[2].stopped, true, "the robots after the failing one are still stopped");
  assert.match(t.logs[0], /1 FAILED/);
  assert.equal(t.deltas.length, 2, "only the stopped robots are broadcast");
});

test("global stop reports a settings write that failed and still answers", async () => {
  const t = setup({ settings: fixture(), saveRejects: true });
  const body = await t.call();
  assert.equal(body.success, true);
  assert.equal(body.persisted, false);
  assert.equal(t.deltas.length, 3, "the stop is still broadcast");
  assert.match(t.logs[1], /could not be saved \(disk full\)/);
});

test("global stop survives a broadcast that fails", async () => {
  const t = setup({ settings: fixture(), broadcastThrows: true });
  const body = await t.call();
  assert.equal(body.success, true);
  assert.match(t.logs[1], /broadcast failed \(socket gone\)/);
});

test("global stop is signed-in only and has no rate limiter in front of it", () => {
  const t = setup({ settings: fixture() });
  const chain = t.chain();
  assert.equal(chain.length, 2, "the sign-in check and the handler: nothing between them can answer 429");
  assert.equal(chain[0], t.authenticate);
});

test("a thousand global stops in a row never answer 429 and every one applies the stop", async () => {
  // the response object has no status(): a 429 (or any error status) would throw here instead of passing
  const t = setup({ settings: fixture() });
  for (let i = 0; i < 1000; i++) {
    const body = await t.call();
    assert.equal(body.success, true, `call ${i + 1}`);
    assert.equal(body.stoppedCount, 3);
  }
  assert.equal(t.stopped.length, 3000, "every call stopped every robot");
  assert.equal(t.deltas.length, 3000, "every call was broadcast");
});

test("repeated global stops of one account write one audit record and one log line per pause, another account is always recorded", async () => {
  let now = 1_000_000;
  const t = setup({ settings: fixture(), deps: { now: () => now, secondaryWorkGapMs: 1000 } });
  await t.call();
  await t.call();
  await t.call();
  assert.equal(t.audits.length, 1);
  assert.equal(t.logs.filter((line) => line.startsWith("GLOBAL STOP by")).length, 1);
  await t.call({ id: "u9", username: "bob", role: "operator" });
  assert.equal(t.audits.length, 2, "a stop from another account is never folded into the first one");
  now += 1500;
  await t.call();
  assert.equal(t.audits.length, 3);
  assert.deepEqual(t.audits[2].detail.repeatedCalls, 2, "the record says how many calls it stands for");
});

test("the stop is written to disk once and before the answer; a write that fails is audited and tried again", async () => {
  const written: string[] = [];
  let ok = false;
  let answered = false;
  const t = setup({ settings: fixture(), deps: { persistGlobalStop: (by: string) => { written.push(`${by}:${answered ? "after" : "before"}`); return ok; } } });
  const first = await t.call();
  answered = true;
  assert.equal(first.success, true, "a stop that could not be written is still applied");
  assert.deepEqual(written, ["alice:before"]);
  assert.equal(t.audits[0].outcome, "failed");
  assert.equal(t.audits[0].detail.statePersisted, false);
  assert.ok(t.logs.some((line) => /could not be written to disk/.test(line)));
  ok = true;
  await t.call();
  await t.call();
  assert.equal(written.length, 2, "once the stop is written the next calls do not write it again");
});

test("the release removes the written stop first and is refused, leaving the server stopped, when it can not", async () => {
  const changes: boolean[] = [];
  let cleared = false;
  const t = setup({ settings: fixture(), deps: { clearGlobalStop: () => cleared, onGlobalStopChanged: (stopped: boolean) => { changes.push(stopped); } } });
  const refused = await t.release();
  assert.equal(refused.status, 500);
  assert.equal(refused.body.code, "release-failed");
  assert.deepEqual(changes, [], "the state of the apps is not touched by a refused release");
  assert.equal(t.audits.at(-1).outcome, "failed");
  cleared = true;
  const done = await t.release();
  assert.equal(done.status, 200);
  assert.equal(done.body.success, true);
  assert.deepEqual(changes, [false]);
});
