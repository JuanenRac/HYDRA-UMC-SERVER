import assert from "node:assert/strict";
import { test } from "node:test";
import { registerCommandRoutes } from "../src/routes/commandRoutes.ts";

type Handler = (req: any, res: any) => Promise<void>;

function setup(options: { settings: any; stopThrows?: number[]; saveRejects?: boolean; broadcastThrows?: boolean; withLimiter?: boolean }) {
  let handler: Handler | undefined;
  let chain: unknown[] = [];
  const app: any = { post(route: string, ...handlers: unknown[]) { if (route === "/api/stop-all") { chain = handlers; handler = handlers[handlers.length - 1] as Handler; } } };
  const logs: string[] = [];
  const stopped: number[] = [];
  const deltas: any[] = [];
  const authenticate = () => undefined;
  const limiter = () => undefined;
  registerCommandRoutes(app, {
    authenticate,
    getSettings: () => options.settings,
    industrialLog: (message: string) => { logs.push(message); },
    isReservationActive: (reservation: any) => !!reservation && reservation.expiresAt > Date.now(),
    queueSettingsWrite: async () => { if (options.saveRejects) throw new Error("disk full"); },
    broadcastRobotDelta: (batch: any[]) => { if (options.broadcastThrows) throw new Error("socket gone"); deltas.push(...batch); },
    startServerPlayback: () => undefined,
    stopServerPlayback: (id: number) => { if (options.stopThrows?.includes(id)) throw new Error("timer broken"); stopped.push(id); },
    ...(options.withLimiter ? { stopAllRateLimiter: limiter } : {}),
  } as any);
  const call = async (user: any = { id: "u1", username: "alice", role: "operator" }) => {
    let body: any;
    const res: any = { json: (value: any) => { body = value; return res; } };
    await handler!({ user, ip: "10.0.0.7" }, res);
    return body;
  };
  return { call, logs, stopped, deltas, chain: () => chain, authenticate, limiter };
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

test("global stop is signed-in only and runs the bounded limiter after the sign-in check", () => {
  const withLimiter = setup({ settings: fixture(), withLimiter: true });
  const chain = withLimiter.chain();
  assert.equal(chain.length, 3);
  assert.equal(chain[0], withLimiter.authenticate);
  assert.equal(chain[1], withLimiter.limiter);
  assert.equal(setup({ settings: fixture() }).chain().length, 3, "without a limiter a pass-through keeps the chain the same");
});
