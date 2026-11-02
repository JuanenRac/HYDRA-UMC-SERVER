import assert from "node:assert/strict";
import { test } from "node:test";
import { registerCommandRoutes } from "../src/routes/commandRoutes.ts";
import { defaultSafetyConfig, mergeSafetyConfig, SafetyLimitsError } from "../src/safetyLimits.ts";

type Handler = (req: any, res: any) => Promise<unknown>;

function setup(intervalSeconds: number) {
  const settings: any = {
    controllers: [{ id: "c1", cameras: [], robots: [{ id: 1, name: "A1", pos: { x: 0, y: 0, z: 0, a: 0, b: 0, c: 0 }, joints: {}, valves: [false], pumps: [false], playbackState: { speed: 100 } }] }],
  };
  let handler: Handler | undefined;
  const app: any = { post(route: string, ...handlers: unknown[]) { if (route === "/api/robot/:id/command") handler = handlers[handlers.length - 1] as Handler; } };
  const events: any[] = [];
  const config = { ...defaultSafetyConfig(), audit: { enabled: true, motionIntervalSeconds: intervalSeconds } };
  registerCommandRoutes(app, {
    authenticate: () => undefined,
    getSettings: () => settings,
    industrialLog: () => undefined,
    isReservationActive: () => false,
    queueSettingsWrite: async () => undefined,
    broadcastRobotDelta: () => undefined,
    startServerPlayback: () => undefined,
    stopServerPlayback: () => undefined,
    safety: { get: () => config, jogFor: () => ({ maxAmount: 100, maxAbsolute: 1000 }) },
    audit: { record: (e: any) => { events.push(e); return null; } },
  } as any);
  const call = async (body: any) => {
    let status = 200;
    const res: any = { setHeader() {}, status(c: number) { status = c; return res; }, json() { return res; } };
    await handler!({ params: { id: "1" }, body, user: { id: "u1", username: "alice", role: "operator" }, ip: "127.0.0.1" }, res);
    return status;
  };
  return { call, events };
}

test("play, pause, speed and a trajectory are recorded as robot-motion with the account and the robot", async () => {
  const t = setup(10);
  assert.equal(await t.call({ command: "play" }), 200);
  assert.equal(await t.call({ command: "pause" }), 200);
  assert.equal(await t.call({ command: "trajectory", params: { points: [{ x: 1, y: 2, z: 3 }, { x: 2, y: 2, z: 3 }] } }), 200);
  const motions = t.events.filter((e) => e.type === "robot-motion");
  assert.deepEqual(motions.map((e) => e.detail.command), ["play", "pause", "trajectory"]);
  assert.equal(motions[2].detail.points, 2);
  assert.equal(motions[0].username, "alice");
  assert.equal(motions[0].robotId, 1);
});

test("a stream of jogs is recorded once per interval, and not at all when the interval is 0", async () => {
  const t = setup(3600);
  for (let i = 0; i < 5; i++) await t.call({ command: "jog", params: { axis: "x", amount: 1 } });
  assert.equal(t.events.filter((e) => e.detail?.command === "jog").length, 1);
  const off = setup(0);
  for (let i = 0; i < 3; i++) await off.call({ command: "jog", params: { axis: "x", amount: 1 } });
  assert.equal(off.events.filter((e) => e.type === "robot-motion").length, 0);
});

test("audit.motionIntervalSeconds is a whole number from 0 to 3600 and keeps audit.enabled", () => {
  const base = defaultSafetyConfig();
  assert.equal(base.audit.motionIntervalSeconds, 10);
  const next = mergeSafetyConfig(base, { audit: { motionIntervalSeconds: 0 } });
  assert.equal(next.audit.motionIntervalSeconds, 0);
  assert.equal(next.audit.enabled, true);
  for (const bad of [-1, 3601, 1.5, "5", null]) {
    assert.throws(() => mergeSafetyConfig(base, { audit: { motionIntervalSeconds: bad } }), SafetyLimitsError);
  }
});
