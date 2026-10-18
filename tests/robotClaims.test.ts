import assert from "node:assert/strict";
import { test } from "node:test";
import { registerRobotRoutes } from "../src/routes/robotRoutes.ts";

type Handler = (req: any, res: any) => Promise<unknown>;

const DEFAULT_TTL = 60_000;
const MAX_TTL = 600_000;
const alice = { id: "alice-id", username: "alice", role: "operator" };
const bob = { id: "bob-id", username: "bob", role: "operator" };
const root = { id: "root-id", username: "root", role: "admin" };

function setup(initial: any = { id: 1 }) {
  const robot: any = { ...initial };
  const handlers: Record<string, Handler> = {};
  const app: any = { post(route: string, ...chain: unknown[]) { handlers[route] = chain[chain.length - 1] as Handler; } };
  const history: Array<{ action: string; by: unknown; reason?: string }> = [];
  const deltas: any[] = [];
  let writes = 0;
  registerRobotRoutes(app, {
    authenticate: () => undefined,
    getSettings: () => ({}),
    findRobotById: (id: number) => (id === robot.id ? robot : null),
    findControllerIdForRobot: (id: number) => (id === robot.id ? "c1" : null),
    isReservationActive: (r: any) => !!r && r.expiresAt > Date.now(),
    appendReservationHistory: (_r: any, action: string, by: unknown, _name: unknown, reason?: string) => { history.push({ action, by, reason }); },
    queueSettingsWrite: async () => { writes++; },
    broadcastRobotDelta: (batch: any[]) => { deltas.push(...batch); },
    DEFAULT_RESERVATION_TTL_MS: DEFAULT_TTL,
    MAX_RESERVATION_TTL_MS: MAX_TTL,
  } as any);
  const call = async (route: "claim" | "release", id: string, user: any, body: any = {}) => {
    let status = 200;
    let json: any;
    const res: any = { status(code: number) { status = code; return res; }, json(value: any) { json = value; return res; } };
    await handlers[`/api/robot/:id/${route}`]({ params: { id }, body, user }, res);
    return { status, json };
  };
  return { robot, call, history, deltas, writes: () => writes };
}

test("claiming an unknown robot is a 404", async () => {
  const t = setup();
  assert.equal((await t.call("claim", "9", alice)).status, 404);
  assert.equal((await t.call("release", "x", alice)).status, 404);
  assert.equal(t.writes(), 0);
});

test("a free robot is claimed with the default TTL, persisted and broadcast", async () => {
  const t = setup();
  const before = Date.now();
  const r = await t.call("claim", "1", alice);
  assert.equal(r.status, 200);
  assert.equal(t.robot.reservation.ownerId, "alice-id");
  const ttl = t.robot.reservation.expiresAt - t.robot.reservation.claimedAt;
  assert.equal(ttl, DEFAULT_TTL);
  assert.ok(t.robot.reservation.claimedAt >= before);
  assert.deepEqual(t.history.map((h) => h.action), ["claimed"]);
  assert.equal(t.writes(), 1);
  assert.equal(t.deltas[0].controllerId, "c1");
});

test("the TTL is clamped to 1 second at the bottom and the maximum at the top; non-numbers use the default", async () => {
  const t = setup();
  await t.call("claim", "1", alice, { ttlMs: 5 });
  assert.equal(t.robot.reservation.expiresAt - t.robot.reservation.claimedAt, 1000);
  await t.call("claim", "1", alice, { ttlMs: 1e12 });
  assert.equal(t.robot.reservation.expiresAt - t.robot.reservation.claimedAt, MAX_TTL);
  await t.call("claim", "1", alice, { ttlMs: "5000" });
  assert.equal(t.robot.reservation.expiresAt - t.robot.reservation.claimedAt, DEFAULT_TTL);
  await t.call("claim", "1", alice, { ttlMs: -Infinity });
  assert.equal(t.robot.reservation.expiresAt - t.robot.reservation.claimedAt, 1000);
});

test("the owner renewing is recorded as renewed", async () => {
  const t = setup();
  await t.call("claim", "1", alice);
  await t.call("claim", "1", alice);
  assert.deepEqual(t.history.map((h) => h.action), ["claimed", "renewed"]);
});

test("a second user is refused with 409, even when it asks for force without being an admin", async () => {
  const t = setup();
  await t.call("claim", "1", alice);
  const plain = await t.call("claim", "1", bob);
  const forced = await t.call("claim", "1", bob, { force: true });
  assert.equal(plain.status, 409);
  assert.equal(forced.status, 409);
  assert.match(forced.json.error, /already claimed by alice/);
  assert.equal(t.robot.reservation.ownerId, "alice-id");
  assert.equal(t.writes(), 1);
});

test("only an admin with force:true takes over a live claim; without force the admin is refused too", async () => {
  const t = setup();
  await t.call("claim", "1", alice);
  assert.equal((await t.call("claim", "1", root)).status, 409);
  const r = await t.call("claim", "1", root, { force: true, reason: "  line is stuck  " });
  assert.equal(r.status, 200);
  assert.equal(t.robot.reservation.ownerId, "root-id");
  assert.deepEqual(t.history.at(-1), { action: "force-claimed", by: "root-id", reason: "line is stuck" });
});

test("claiming over an expired claim records the expiry and the reason is capped at 200 characters", async () => {
  const t = setup({ id: 1, reservation: { ownerId: "alice-id", ownerUsername: "alice", expiresAt: Date.now() - 5 } });
  await t.call("claim", "1", bob, { reason: "x".repeat(500) });
  assert.deepEqual(t.history.map((h) => h.action), ["expired", "claimed"]);
  assert.equal(t.history[1].reason?.length, 200);
  assert.equal(t.robot.reservation.ownerId, "bob-id");
});

test("a blank or non-string reason is dropped", async () => {
  const t = setup();
  await t.call("claim", "1", alice, { reason: "   " });
  await t.call("claim", "1", alice, { reason: 42 });
  assert.equal(t.history[0].reason, undefined);
  assert.equal(t.history[1].reason, undefined);
});

test("release: the owner releases, another operator gets 409, an admin force-releases", async () => {
  const t = setup();
  await t.call("claim", "1", alice);
  const refused = await t.call("release", "1", bob);
  assert.equal(refused.status, 409);
  assert.equal(t.robot.reservation.ownerId, "alice-id");
  const forced = await t.call("release", "1", root, { reason: "maintenance" });
  assert.equal(forced.status, 200);
  assert.equal(t.robot.reservation, null);
  assert.equal(t.history.at(-1)?.action, "force-released");
  await t.call("claim", "1", alice);
  await t.call("release", "1", alice);
  assert.equal(t.history.at(-1)?.action, "released");
});

test("releasing an expired claim is open to anyone and records the expiry; releasing a free robot is a harmless no-op", async () => {
  const t = setup({ id: 1, reservation: { ownerId: "alice-id", ownerUsername: "alice", expiresAt: Date.now() - 5 } });
  assert.equal((await t.call("release", "1", bob)).status, 200);
  assert.deepEqual(t.history.map((h) => h.action), ["expired"]);
  assert.equal((await t.call("release", "1", bob)).status, 200);
  assert.equal(t.history.length, 1);
  assert.equal(t.robot.reservation, null);
});
