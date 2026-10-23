import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { registerCommandRoutes } from "../src/routes/commandRoutes.ts";
import { registerRobotRoutes } from "../src/routes/robotRoutes.ts";
import { registerSafetyRoutes } from "../src/routes/safetyRoutes.ts";
import { SafetyLimits, JogArming } from "../src/safetyLimits.ts";
import { AuditLog } from "../src/auditLog.ts";
import { robotRevision } from "../src/serverPolicy.ts";
import { planTableMove } from "../src/tableCommand.ts";
import { listClaims } from "../src/claimPolicy.ts";

const alice = { id: "alice-id", username: "alice", role: "operator" };
const bob = { id: "bob-id", username: "bob", role: "operator" };
const root = { id: "root-id", username: "root", role: "admin" };
const active = (r: any) => !!r && r.expiresAt > Date.now();
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "hydra-v2-"));

function world() {
  const settings: any = { controllers: [{ id: "c1", robots: [
    {
      id: 1, name: "A", model: "Parol6 (6-DOF)", pos: { x: 0, y: 0, z: 0, a: 0, b: 0, c: 0 }, joints: {}, playbackState: { activeStep: 0 },
      hasXYTable: true, xyTable: { pos: { x: 10, y: 20 }, tableSize: { width: 300 } },
    },
    { id: 2, name: "B", model: "Parol6 (6-DOF)", pos: { x: 0, y: 0, z: 0, a: 0, b: 0, c: 0 }, joints: {}, playbackState: {} },
  ] }] };
  const dir = tmp();
  const safety = new SafetyLimits(dir);
  const arming = new JogArming();
  const audit = new AuditLog(dir);
  const claimMessages: unknown[][] = [];
  const onClaimsChanged = () => claimMessages.push(listClaims(settings, active, (id) => arming.expiresAt(id)));
  const posts: Record<string, any> = {};
  const gets: Record<string, any> = {};
  const app: any = {
    post(route: string, ...h: unknown[]) { posts[route] = h[h.length - 1]; },
    get(route: string, ...h: unknown[]) { gets[route] = h[h.length - 1]; },
    put(route: string, ...h: unknown[]) { posts["PUT " + route] = h[h.length - 1]; },
  };
  const find = (id: number) => settings.controllers[0].robots.find((r: any) => r.id === id) ?? null;
  const common = { authenticate: () => undefined, getSettings: () => settings, isReservationActive: active };
  registerCommandRoutes(app, { ...common, industrialLog: () => undefined, queueSettingsWrite: async () => undefined, broadcastRobotDelta: () => undefined, startServerPlayback: () => undefined, stopServerPlayback: () => undefined, safety, arming, audit, onClaimsChanged } as any);
  registerRobotRoutes(app, {
    ...common, findRobotById: find, findControllerIdForRobot: () => "c1",
    appendReservationHistory: () => undefined, queueSettingsWrite: async () => undefined, broadcastRobotDelta: () => undefined,
    DEFAULT_RESERVATION_TTL_MS: 60_000, MAX_RESERVATION_TTL_MS: 600_000, safety, arming, audit, onClaimsChanged,
  } as any);
  registerSafetyRoutes(app, { ...common, requireAdmin: () => undefined, findRobotById: find, safety, arming, audit, onClaimsChanged });
  const call = async (handler: any, req: any) => {
    let status = 200;
    let json: any;
    let sent: any;
    const res: any = {
      headers: {} as Record<string, string>,
      setHeader(k: string, v: string) { res.headers[k] = v; },
      status(c: number) { status = c; return res; },
      json(v: any) { json = v; return res; },
      send(v: any) { sent = v; return res; },
    };
    await handler({ headers: {}, body: {}, query: {}, ip: "10.0.0.9", ...req }, res);
    return { status, json, sent, headers: res.headers };
  };
  const command = (user: any, body: any, headers: any = {}, id = "1") => call(posts["/api/robot/:id/command"], { params: { id }, body, user, headers });
  const claim = (user: any, body: any = {}, headers: any = {}) => call(posts["/api/robot/:id/claim"], { params: { id: "1" }, body, user, headers });
  const release = (user: any, body: any = {}, headers: any = {}) => call(posts["/api/robot/:id/release"], { params: { id: "1" }, body, user, headers });
  const getRobot = (user: any, id = "1") => call(gets["/api/robot/:id"], { params: { id }, user });
  const getAudit = (query: any = {}) => call(gets["/api/audit"], { user: root, query });
  return { settings, robot: find(1), safety, arming, audit, claimMessages, command, claim, release, getRobot, getAudit, call, posts, dir };
}

// ---- block 2: conditional writes ------------------------------------------------------------------------------------------------------------

test("GET /api/robot/:id answers one robot with its revision as ETag", async () => {
  const w = world();
  const r = await w.getRobot(alice);
  assert.equal(r.status, 200);
  assert.equal(r.json.robot.id, 1);
  assert.equal(r.headers.ETag, `"${r.json.revision}"`);
  assert.equal(r.json.cellId, "c1");
  assert.equal((await w.getRobot(alice, "9")).status, 404);
});

test("the revision ignores the claim history, the claim times and the playback step, and follows everything else", () => {
  const robot: any = { id: 1, pos: { x: 1 }, reservation: { ownerId: "a", expiresAt: 1, claimedAt: 1 }, reservationHistory: [], playbackState: { activeStep: 1, speed: 5 } };
  const before = robotRevision(robot);
  robot.reservation = { ownerId: "a", expiresAt: 99, claimedAt: 50 };
  robot.reservationHistory.push({ action: "renewed" });
  robot.playbackState.activeStep = 7;
  assert.equal(robotRevision(robot), before);
  robot.pos.x = 2;
  assert.notEqual(robotRevision(robot), before);
  robot.pos.x = 1;
  robot.reservation = { ownerId: "b" };
  assert.notEqual(robotRevision(robot), before);
});

test("a command with a stale If-Match is refused with 412 and the current revision; the right one, * and none go through", async () => {
  const w = world();
  const rev = (await w.getRobot(alice)).json.revision;
  const stale = await w.command(alice, { command: "jog", params: { axis: "x", amount: 5 } }, { "if-match": '"0000"' });
  assert.equal(stale.status, 412);
  assert.equal(stale.json.code, "revision-mismatch");
  assert.equal(stale.json.revision, rev);
  assert.equal(w.robot.pos.x, 0);
  const ok = await w.command(alice, { command: "jog", params: { axis: "x", amount: 5 } }, { "if-match": `"${rev}"` });
  assert.equal(ok.status, 200);
  assert.equal(w.robot.pos.x, 5);
  assert.notEqual(ok.json.revision, rev);
  assert.equal(ok.headers.ETag, `"${ok.json.revision}"`);
  assert.equal((await w.command(alice, { command: "jog", params: { axis: "x", amount: 1 } }, { "if-match": "*" })).status, 200);
  assert.equal((await w.command(alice, { command: "jog", params: { axis: "x", amount: 1 } })).status, 200);
});

test("a stop is never conditional", async () => {
  const w = world();
  const r = await w.command(alice, { command: "stop" }, { "if-match": '"0000"' });
  assert.equal(r.status, 200);
});

test("claim and release honour If-Match and answer with the new revision", async () => {
  const w = world();
  assert.equal((await w.claim(alice, {}, { "if-match": '"0000"' })).status, 412);
  assert.equal(w.robot.reservation, undefined);
  const rev = (await w.getRobot(alice)).json.revision;
  const claimed = await w.claim(alice, {}, { "if-match": rev });
  assert.equal(claimed.status, 200);
  assert.ok(claimed.json.revision);
  assert.equal((await w.release(alice, {}, { "if-match": '"0000"' })).status, 412);
  assert.ok(w.robot.reservation);
  assert.equal((await w.release(alice, {}, { "if-match": claimed.json.revision })).status, 200);
});

// ---- block 3: the table command ----------------------------------------------------------------------------------------------------------

test("a table move in one request: absolute, then relative, answered with the applied position", async () => {
  const w = world();
  const abs = await w.command(alice, { command: "table", params: { x: 50, y: 60, rz: 15, mode: "absolute" } });
  assert.equal(abs.status, 200);
  assert.deepEqual(abs.json.applied, { robotId: 1, x: 50, y: 60, rz: 15 });
  assert.deepEqual(w.robot.xyTable.pos, { x: 50, y: 60 });
  assert.equal(w.robot.xyTable.tableSize.width, 300);
  assert.equal(w.robot.pos.tx, 50);
  assert.equal(w.robot.pos.trz, 15);
  const rel = await w.command(alice, { command: "table", params: { x: -10, y: 5, mode: "relative" } });
  assert.deepEqual(rel.json.applied, { robotId: 1, x: 40, y: 65 });
  assert.equal(w.robot.pos.trz, 15);
});

test("a table move that is invalid or beyond the limits changes nothing", async () => {
  const w = world();
  const before = JSON.stringify(w.robot);
  for (const params of [
    { x: 1 }, { x: "1", y: 2 }, { x: 1, y: NaN }, { x: 1, y: 2, mode: "diagonal" }, { x: 1, y: 2, rz: "9" },
  ]) {
    const r = await w.command(alice, { command: "table", params });
    assert.equal(r.status, 400, JSON.stringify(params));
    assert.equal(r.json.code, "table-invalid");
  }
  const tooBigRelative = await w.command(alice, { command: "table", params: { x: 101, y: 0, mode: "relative" } });
  assert.equal(tooBigRelative.json.code, "table-out-of-limit");
  const tooFar = await w.command(alice, { command: "table", params: { x: 1001, y: 0, mode: "absolute" } });
  assert.equal(tooFar.json.code, "table-out-of-limit");
  assert.equal(JSON.stringify(w.robot), before);
  const noTable = await w.command(alice, { command: "table", params: { x: 1, y: 1 } }, {}, "2");
  assert.equal(noTable.json.code, "table-missing");
});

test("a relative table move that would end outside the absolute range is refused as a whole", () => {
  const robot = { hasXYTable: true, xyTable: { pos: { x: 990, y: 0 } } };
  const plan = planTableMove(robot, { x: 50, y: 5, mode: "relative" }, { maxAmount: 100, maxAbsolute: 1000 });
  assert.equal(plan.ok, false);
  assert.deepEqual(robot.xyTable.pos, { x: 990, y: 0 });
});

test("a table move needs the claim and the arming like a jog", async () => {
  const w = world();
  await w.claim(bob);
  const refused = await w.command(alice, { command: "table", params: { x: 1, y: 1 } });
  assert.equal(refused.status, 409);
  const w2 = world();
  await w2.safety.update({ jog: { armRequired: true } }, "root");
  const notArmed = await w2.command(alice, { command: "table", params: { x: 1, y: 1 } });
  assert.equal(notArmed.status, 403);
  assert.equal(notArmed.json.code, "jog-not-armed");
});

// ---- block 4: the audit record ------------------------------------------------------------------------------------------------------------

test("claims, forced releases, limits, arming and global stops are recorded with who and from where", async () => {
  const w = world();
  await w.claim(alice, { controllerId: "pc-1" });
  await w.claim(bob);
  await w.release(root, { reason: "walked away" });
  await w.call(w.posts["PUT /api/admin/safety-limits"], { user: root, body: { jog: { armRequired: true } } });
  await w.call(w.posts["/api/robot/:id/jog-arm"], { params: { id: "1" }, user: alice, body: { armed: true } });
  await w.call(w.posts["/api/stop-all"], { user: alice, body: {} });
  const r = await w.getAudit();
  const types = r.json.entries.map((e: any) => `${e.type}:${e.outcome}`);
  assert.deepEqual(types, ["claim:ok", "claim:refused", "force-release:ok", "safety-limits:ok", "jog-arm:ok", "stop-all:ok"]);
  const first = r.json.entries[0];
  assert.equal(first.username, "alice");
  assert.equal(first.controllerId, "pc-1");
  assert.equal(first.ip, "10.0.0.9");
  assert.equal(first.robotId, 1);
  assert.deepEqual(r.json.entries.map((e: any) => e.seq), [1, 2, 3, 4, 5, 6]);
});

test("GET /api/audit filters, exports and verifies the chain", async () => {
  const w = world();
  await w.claim(alice);
  await w.release(alice);
  assert.equal((await w.getAudit({ type: "release" })).json.entries.length, 1);
  assert.equal((await w.getAudit({ afterSeq: 1 })).json.entries.length, 1);
  assert.equal((await w.getAudit({ limit: "1" })).json.entries[0].type, "release");
  assert.equal((await w.getAudit({ verify: "1" })).json.verification.ok, true);
  const file = await w.getAudit({ format: "jsonl" });
  assert.equal(file.sent.trim().split("\n").length, 2);
});

test("a changed or removed line breaks the chain", () => {
  const dir = tmp();
  const log = new AuditLog(dir);
  for (let i = 0; i < 4; i++) log.record({ type: "claim", outcome: "ok", robotId: i });
  assert.deepEqual(log.verify(), { ok: true, entries: 4 });
  const file = path.join(dir, "audit.jsonl");
  const lines = fs.readFileSync(file, "utf-8").trim().split("\n");
  fs.writeFileSync(file, [lines[0], lines[1].replace('"robotId":1', '"robotId":9'), lines[2], lines[3]].join("\n") + "\n");
  const edited = new AuditLog(dir).verify();
  assert.equal(edited.ok, false);
  assert.equal(edited.brokenAtSeq, 2);
  fs.writeFileSync(file, [lines[0], lines[2], lines[3]].join("\n") + "\n");
  const removed = new AuditLog(dir).verify();
  assert.equal(removed.ok, false);
  assert.equal(removed.brokenAtSeq, 3);
});

test("the record continues after a restart, rotates by size and keeps the chain across files", () => {
  const dir = tmp();
  const first = new AuditLog(dir, { maxBytes: 600, keep: 2 });
  for (let i = 0; i < 6; i++) first.record({ type: "claim", outcome: "ok", robotId: i });
  const second = new AuditLog(dir, { maxBytes: 600, keep: 2 });
  second.record({ type: "release", outcome: "ok" });
  assert.ok(fs.readdirSync(dir).some((n) => n.startsWith("audit-") && n.endsWith(".jsonl")));
  assert.equal(second.verify().ok, true);
  assert.equal(second.read({ limit: 1 })[0].seq, 7);
});

test("secrets in an event are redacted; a disabled record writes nothing and never throws", () => {
  const dir = tmp();
  const log = new AuditLog(dir);
  log.record({ type: "safety-limits", outcome: "ok", detail: { password: "hunter2", note: "Bearer abc.def.ghi" } });
  const text = fs.readFileSync(path.join(dir, "audit.jsonl"), "utf-8");
  assert.equal(text.includes("hunter2"), false);
  assert.equal(text.includes("abc.def.ghi"), false);
  const off = new AuditLog(tmp(), { enabled: false });
  assert.equal(off.record({ type: "claim", outcome: "ok" }), null);
  assert.equal(off.lockedOff, true);
  const broken = new AuditLog(path.join(dir, "audit.jsonl", "nope"));
  assert.equal(broken.record({ type: "claim", outcome: "ok" }), null);
});

test("the administrator can switch the record off and on from the safety limits; the environment lock wins", async () => {
  const w = world();
  await w.call(w.posts["PUT /api/admin/safety-limits"], { user: root, body: { audit: { enabled: false } } });
  assert.equal(w.audit.enabled, false);
  await w.claim(alice);
  assert.equal(w.audit.read().filter((e) => e.type === "claim").length, 0);
  await w.call(w.posts["PUT /api/admin/safety-limits"], { user: root, body: { audit: { enabled: true } } });
  assert.equal(w.audit.enabled, true);
  const locked = new AuditLog(tmp(), { enabled: false });
  locked.setEnabled(true);
  assert.equal(locked.enabled, false);
});

test("copies of the record travel with the settings backups and only the newest are kept", () => {
  const dir = tmp();
  const log = new AuditLog(dir);
  log.record({ type: "claim", outcome: "ok" });
  const backups = path.join(dir, "backups");
  for (const stamp of ["20260101T000000Z", "20260101T000100Z", "20260101T000200Z"]) log.backupTo(backups, stamp, 2);
  assert.deepEqual(fs.readdirSync(backups).sort(), ["audit-backup-20260101T000100Z.jsonl", "audit-backup-20260101T000200Z.jsonl"]);
});

// ---- block 5: events of the claims ------------------------------------------------------------------------------------------------------

test("a claim, a release, an arming and a stop each push the list of claims", async () => {
  const w = world();
  await w.claim(alice, { controllerId: "pc-1" });
  assert.equal(w.claimMessages.length, 1);
  assert.equal((w.claimMessages[0][0] as any).controllerId, "pc-1");
  await w.call(w.posts["/api/robot/:id/jog-arm"], { params: { id: "1" }, user: alice, body: { armed: true }, headers: { "x-controller-id": "pc-1" } });
  assert.equal(w.claimMessages.length, 2);
  assert.ok((w.claimMessages[1][0] as any).jogArmedUntil > Date.now());
  await w.command(alice, { command: "stop" }, { "x-controller-id": "pc-1" });
  assert.equal(w.claimMessages.length, 3);
  assert.equal((w.claimMessages[2][0] as any).jogArmedUntil, null);
  await w.release(alice, { controllerId: "pc-1" });
  assert.equal(w.claimMessages.length, 4);
  assert.deepEqual(w.claimMessages[3], []);
});
