// =============================================================================
// HYDRA-UMC-SERVER - Unit tests for the verdicts of the anomaly detector, the signed record of the voice commands and the check of
// a trajectory proposal signed with Ed25519
// Copyright (C) 2026 JuanenRac (Electro Hobby 3D) <electrohobby3d@gmail.com>
// GPL-3.0-or-later - see LICENSE
// =============================================================================
import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { apiRateLimiter } from "../src/auth.ts";
import { ChainedLog } from "../src/ingestLog.ts";
import { makeIngest } from "../src/ingestFeeds.ts";
import { AnomalyFeed, parseAnomalyVerdict, voiceAlertBody } from "../src/anomalyFeed.ts";
import { relayToVoice, startAnomalyFeed } from "../src/anomalyFeedBroker.ts";
import { recordVoiceEvent, voiceRecordPayload } from "../src/voiceChain.ts";
import { keyIdOf, loadOperatorKeys, proposalMessage, verifyProposal } from "../src/proposalVerify.ts";
import { registerTrustRoutes } from "../src/routes/trustRoutes.ts";
import { nodeStateText } from "../src/voiceText.ts";

const KEY = "k".repeat(40);
const SECRET = "q7Hk2vXz9LmN4pRt8WsY1cBd6FgJ3aEu5oIx0TnV";
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "hydra-trust-"));
const verdict = (over: any = {}) => ({ schema: "anomaly-verdict/1", source_id: "motor3", kind: "vibration", field: "x", verdict: "normal", score: 0.4, threshold: 1, model_version: 2, timestamp: 1000, ...over });

test("an anomaly-verdict/1 is read, and anything else is ignored", () => {
  assert.equal(parseAnomalyVerdict(verdict())?.sourceId, "motor3");
  assert.equal(parseAnomalyVerdict(JSON.stringify(verdict({ verdict: "suspect" })))?.verdict, "suspect");
  assert.equal(parseAnomalyVerdict(verdict({ schema: "other" })), null);
  assert.equal(parseAnomalyVerdict(verdict({ verdict: "maybe" })), null);
  assert.equal(parseAnomalyVerdict(verdict({ score: "high" })), null);
  assert.equal(parseAnomalyVerdict(verdict({ source_id: "../x" })), null);
  assert.equal(parseAnomalyVerdict("not json"), null);
});

test("the feed keeps the latest verdict of each series, writes only a change, and is rebuilt from the record", () => {
  const dir = tmp();
  const file = path.join(dir, "a.jsonl");
  const feed = new AnomalyFeed(new ChainedLog(file, () => KEY));
  const normal = parseAnomalyVerdict(verdict())!;
  assert.deepEqual(feed.record(normal), { changed: true, previous: null });
  assert.deepEqual(feed.record({ ...normal, score: 0.5 }), { changed: false, previous: "normal" });
  assert.deepEqual(feed.record({ ...normal, verdict: "anomalous", score: 3 }), { changed: true, previous: "normal" });
  feed.record({ ...normal, field: "y" });
  assert.equal(feed.log.count(), 3, "two changes and one new series, the repeat was not written");
  assert.equal(feed.verdicts().length, 2);
  assert.equal(feed.verdicts("anomalous").length, 1);
  assert.equal(feed.log.verify().ok, true);
  const again = new AnomalyFeed(new ChainedLog(file, () => KEY));
  assert.deepEqual(again.verdicts("anomalous").map((v) => v.field), ["x"]);
});

test("only a verdict that is not normal becomes an alert for the voice interface", () => {
  const normal = parseAnomalyVerdict(verdict())!;
  assert.equal(voiceAlertBody(normal, "en"), null);
  const body = voiceAlertBody({ ...normal, verdict: "anomalous" }, "es")!;
  assert.equal(body.source, "anomaly");
  assert.equal(body.severity, "critical");
  assert.equal(body.verdict, "anomalous");
  assert.equal(body.node, "motor3");
  assert.equal(body.locale, "es");
  assert.match(String(body.alertId), /^[A-Za-z0-9_-]{1,64}$/);
  assert.equal(voiceAlertBody({ ...normal, verdict: "suspect" }, "en")!.severity, "warning");
});

test("the relay tells the voice interface and keeps its answer; a failure is logged and never thrown", async () => {
  const feed = new AnomalyFeed(new ChainedLog(path.join(tmp(), "r.jsonl"), () => KEY));
  const bad = { ...parseAnomalyVerdict(verdict())!, verdict: "suspect" as const };
  feed.record(bad);
  const sent: any[] = [];
  await relayToVoice(feed, bad, { locale: "de", send: async (b) => { sent.push(b); return { speak: true, messageCode: "alert_anomaly_suspect" }; } }, () => undefined);
  assert.equal(sent.length, 1);
  assert.equal((feed.verdicts("suspect")[0] as any).alert.messageCode, "alert_anomaly_suspect");
  const logged: string[] = [];
  await relayToVoice(feed, bad, { locale: "en", send: async () => { throw new Error("down"); } }, (m) => logged.push(m));
  assert.match(logged[0], /could not be told/);
});

test("the broker client records verdicts, relays a change and ignores what is not a verdict", async () => {
  const feed = new AnomalyFeed(new ChainedLog(path.join(tmp(), "b.jsonl"), () => KEY));
  const handlers: Record<string, (...a: any[]) => void> = {};
  const fake: any = { on: (n: string, h: any) => { handlers[n] = h; return fake; }, subscribe: (_t: string, _o: any, cb: any) => cb(null), end: (_f: any, _o: any, cb: any) => cb() };
  const sent: any[] = [];
  const client = startAnomalyFeed(feed, { url: "mqtt://x", topic: "hydra/anomaly/verdict/#", log: () => undefined, connect: (() => fake) as any, relay: { locale: "en", send: async (b) => { sent.push(b); return {}; } } });
  handlers.connect();
  handlers.message("t", Buffer.from("garbage"));
  handlers.message("t", Buffer.from(JSON.stringify(verdict())));
  handlers.message("t", Buffer.from(JSON.stringify(verdict({ verdict: "anomalous" }))));
  handlers.message("t", Buffer.from(JSON.stringify(verdict({ verdict: "anomalous", score: 9 }))));
  await new Promise((r) => setImmediate(r));
  assert.equal(feed.verdicts().length, 1);
  assert.equal(sent.length, 1, "only the change to anomalous is told, not the normal one and not the repeat");
  await client.stop();
});

test("a voice entry holds codes and a hash of the person, never text, and is written only when the switch is on", () => {
  const env = { JWT_SECRET: SECRET };
  const payload = voiceRecordPayload({ event: "turn", requestId: "r-1", intent: "stop", level: "WARNING", requiresConfirmation: true, subject: "ana", ...({ text: "open the door", transcript: "x" } as any) }, env);
  assert.deepEqual(Object.keys(payload).sort(), ["event", "intent", "level", "request_id", "requires_confirmation", "status", "subject"]);
  assert.match(String(payload.subject), /^[0-9a-f]{16}$/);
  assert.notEqual(payload.subject, "ana");
  assert.equal(JSON.stringify(payload).includes("door"), false);
  const log = makeIngest(tmp(), env).voice;
  assert.equal(recordVoiceEvent(log, { event: "turn", requestId: "r-1" }, env), false, "off");
  const on = { ...env, HYDRA_UMC_VOICE_CHAIN: "1" };
  assert.equal(recordVoiceEvent(log, { event: "turn", requestId: "r-1", subject: "ana" }, on), true);
  assert.equal(recordVoiceEvent(log, { event: "confirm", requestId: "r-1", status: "confirmed", subject: "ana" }, on), true);
  assert.deepEqual(log.verify(), { ok: true, records: 2 });
  const warnings: string[] = [];
  const noKey = makeIngest(tmp(), { JWT_SECRET: "short" }).voice;
  assert.equal(recordVoiceEvent(noKey, { event: "turn", requestId: "r-2" }, { ...on, JWT_SECRET: "short" }, (m) => warnings.push(m)), false, "no usable key: nothing unsigned is written");
  assert.equal(warnings.length, 1);
});

// --- the proposal -----------------------------------------------------------------------------------------------------------------------
const pair = () => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  const raw = publicKey.export({ format: "der", type: "spki" }).subarray(-32);
  return { raw: Buffer.from(raw), privateKey, id: keyIdOf(Buffer.from(raw)) };
};
const NOW = 1_800_000_000_000;
function signed(k: ReturnType<typeof pair>, over: any = {}) {
  const fields = { fingerprint: "ab".repeat(16), robot_id: "r1", issued_at_ms: NOW, expires_at_ms: NOW + 60_000, model_version: "m1", instruction_sha256: "c".repeat(64), key_id: k.id, ...over };
  const signature = crypto.sign(null, proposalMessage(fields), k.privateKey).toString("hex");
  return { ...fields, signature_alg: "ed25519", signature };
}

test("a proposal signed by a listed key is valid; a changed, expired, other-robot or unlisted one is refused", () => {
  const k = pair();
  const keys = new Map([[k.id, k.raw]]);
  const ok = (p: any, extra: any = {}) => verifyProposal(keys, p, { robotId: "r1", nowMs: NOW + 1000, ...extra });
  assert.deepEqual(ok(signed(k)), { valid: true, reason: "", keyId: k.id });
  assert.equal(ok(signed(k), { modelVersion: "m1", instructionSha256: "c".repeat(64) }).valid, true);
  assert.match(ok({ ...signed(k), fingerprint: "ff".repeat(16) }).reason, /does not match/);
  assert.match(ok({ ...signed(k), expires_at_ms: NOW + 120_000 }).reason, /does not match/);
  assert.match(verifyProposal(keys, signed(k), { robotId: "r1", nowMs: NOW + 61_000 }).reason, /expired/);
  assert.match(verifyProposal(keys, signed(k), { robotId: "r1", nowMs: NOW - 60_000 }).reason, /future/);
  assert.match(ok(signed(k), { robotId: "r2" }).reason, /different robot/);
  assert.match(ok(signed(k), { modelVersion: "m2" }).reason, /different model/);
  assert.match(ok(signed(k), { instructionSha256: "d".repeat(64) }).reason, /different instruction/);
  assert.match(ok({ ...signed(k), signature_alg: "hmac" }).reason, /not signed with ed25519/);
  assert.match(ok({ ...signed(k), signature: "00".repeat(64) }).reason, /does not match/);
  assert.match(verifyProposal(new Map(), signed(k), { robotId: "r1", nowMs: NOW }).reason, /not listed/);
  const other = pair();
  assert.match(ok(signed(other)).reason, /not listed/);
  assert.match(ok(null).reason, /not signed/);
  assert.match(ok(signed(k, { expires_at_ms: NOW + 700_000 })).reason, /window/);
});

test("a proposal signed by the engine (a fixed vector of its tests) is valid here: both sides write the signed bytes the same way", () => {
  const ENGINE_NOW = 1_700_000_000_000;
  const pub = Buffer.from("03a107bff3ce10be1d70dd18e74bc09967e4d6309ba50d5f1ddc8664125531b8", "hex");
  assert.equal(keyIdOf(pub), "ed4242ead4ac6948");
  const proposal = {
    fingerprint: "ab".repeat(16), robot_id: "r1", issued_at_ms: ENGINE_NOW, expires_at_ms: ENGINE_NOW + 60_000, model_version: "m1", instruction_sha256: "c".repeat(64),
    signature_alg: "ed25519", key_id: "ed4242ead4ac6948",
    signature: "99c2e2f969adddd97ae560d15d4e45327e42b91987ceac7253d3cc45a0acfad4a8cfe4d76fe18cf7c695bcb72afa207a121fbb44ee79f526cf27261c76f7bf02",
  };
  const keys = new Map([["ed4242ead4ac6948", pub]]);
  assert.equal(verifyProposal(keys, proposal, { robotId: "r1", nowMs: ENGINE_NOW + 1000 }).valid, true);
  assert.equal(verifyProposal(keys, { ...proposal, model_version: "m2" }, { robotId: "r1", nowMs: ENGINE_NOW + 1000 }).valid, false);
});

test("the keys file lists public keys by id and drops an entry whose id is not the id of its key", () => {
  const k = pair();
  const file = path.join(tmp(), "keys.json");
  fs.writeFileSync(file, JSON.stringify({ keys: { [k.id]: k.raw.toString("hex"), "0000000000000000": k.raw.toString("hex"), short: "00" } }));
  assert.deepEqual([...loadOperatorKeys({ HYDRA_UMC_PROPOSAL_KEYS_FILE: file }).keys()], [k.id]);
  assert.equal(loadOperatorKeys({}).size, 0);
  assert.equal(loadOperatorKeys({ HYDRA_UMC_PROPOSAL_KEYS_FILE: path.join(tmp(), "none.json") }).size, 0);
});

// --- the routes --------------------------------------------------------------------------------------------------------------------------
type Handler = (req: any, res: any, next?: any) => unknown;
function setup(env: Record<string, string | undefined>) {
  const routes: Record<string, Handler[]> = {};
  const reg = (m: string) => (p: string, ...h: Handler[]) => { routes[`${m} ${p}`] = h.filter((fn) => fn !== apiRateLimiter); };
  const app: any = { get: reg("GET"), post: reg("POST"), put() {}, delete() {}, patch() {} };
  const full = { JWT_SECRET: SECRET, ...env };
  const store = makeIngest(tmp(), full);
  const events: any[] = [];
  registerTrustRoutes(app, {
    authenticate: (req: any, _r: any, next: any) => { req.user = { username: "ana", role: req.role ?? "admin" }; return next(); },
    requireAdmin: (req: any, res: any, next: any) => (req.user.role === "admin" ? next() : res.status(403).json({ error: "admin" })),
    requireOperator: (req: any, res: any, next: any) => (req.user.role === "viewer" ? res.status(403).json({ error: "operator" }) : next()),
    ingest: () => store, audit: { record: (e: any) => { events.push(e); return null as any; } }, env: full,
  });
  const call = (key: string, req: any = {}) => {
    const res: any = new EventEmitter();
    res.statusCode = 200;
    res.status = (c: number) => { res.statusCode = c; return res; };
    res.json = (b: unknown) => { res.body = b; return res; };
    const chain = routes[key];
    assert.ok(chain, key);
    const request = { headers: {}, query: {}, ...req };
    const run = (i: number): unknown => (i >= chain.length ? undefined : chain[i](request, res, () => run(i + 1)));
    run(0);
    return res;
  };
  return { call, store, events };
}

test("every route answers 404 while its switch is off", () => {
  const t = setup({});
  assert.equal(t.call("GET /api/anomaly/verdicts").statusCode, 404);
  assert.equal(t.call("GET /api/voice/chain").statusCode, 404);
  assert.equal(t.call("POST /api/trajectory/proposals/verify", { body: {} }).statusCode, 404);
});

test("GET /api/anomaly/verdicts lists the latest verdicts, narrows by verdict and checks the chain", () => {
  const t = setup({ HYDRA_UMC_ANOMALY_FEED: "1" });
  t.store.anomaly.record(parseAnomalyVerdict(verdict({ verdict: "suspect" }))!);
  t.store.anomaly.record(parseAnomalyVerdict(verdict({ field: "y" }))!);
  const all = t.call("GET /api/anomaly/verdicts", { query: { verify: "1" } });
  assert.equal(all.body.verdicts.length, 2);
  assert.equal(all.body.chain.ok, true);
  assert.equal(t.call("GET /api/anomaly/verdicts", { query: { verdict: "suspect" } }).body.verdicts.length, 1);
  assert.equal(t.call("GET /api/anomaly/verdicts", { query: { verdict: "bogus" } }).statusCode, 400);
});

test("GET /api/voice/chain is for the administrator and can verify the chain", () => {
  const t = setup({ HYDRA_UMC_VOICE_CHAIN: "1" });
  recordVoiceEvent(t.store.voice, { event: "turn", requestId: "r1", subject: "ana" }, { JWT_SECRET: SECRET, HYDRA_UMC_VOICE_CHAIN: "1" });
  assert.equal(t.call("GET /api/voice/chain", { role: "operator" }).statusCode, 403);
  const res = t.call("GET /api/voice/chain", { query: { verify: "1" } });
  assert.equal(res.body.items.length, 1);
  assert.equal(res.body.chain.ok, true);
});

test("POST /api/trajectory/proposals/verify answers a fact, audits it, and refuses a bad request", () => {
  const k = pair();
  const file = path.join(tmp(), "keys.json");
  fs.writeFileSync(file, JSON.stringify({ keys: { [k.id]: k.raw.toString("hex") } }));
  const t = setup({ HYDRA_UMC_PROPOSAL_VERIFY: "1", HYDRA_UMC_PROPOSAL_KEYS_FILE: file });
  const now = Date.now();
  const proposal = signed(k, { issued_at_ms: now, expires_at_ms: now + 60_000 });
  const good = t.call("POST /api/trajectory/proposals/verify", { body: { proposal, expected_robot_id: "r1" } });
  assert.deepEqual(good.body, { valid: true, reason: "", key_id: k.id });
  const other = t.call("POST /api/trajectory/proposals/verify", { body: { proposal, expected_robot_id: "r9" } });
  assert.equal(other.body.valid, false);
  assert.equal(t.call("POST /api/trajectory/proposals/verify", { body: { proposal } }).statusCode, 400);
  assert.equal(t.call("POST /api/trajectory/proposals/verify", { body: { proposal, expected_robot_id: "r1" }, role: "viewer" }).statusCode, 403);
  assert.deepEqual(t.events.map((e) => e.outcome), ["ok", "refused"]);
  const empty = setup({ HYDRA_UMC_PROPOSAL_VERIFY: "1" });
  assert.equal(empty.call("POST /api/trajectory/proposals/verify", { body: { proposal, expected_robot_id: "r1" } }).statusCode, 503);
});

test("how a node is doing is the worst latest verdict among its series, compared without spaces, dashes or capitals", () => {
  const feed = new AnomalyFeed(new ChainedLog(path.join(tmp(), "n.jsonl"), () => KEY));
  assert.equal(feed.stateOfNode("motor3"), "unknown");
  feed.record(parseAnomalyVerdict(verdict({ source_id: "Motor-3", field: "x" }))!);
  assert.equal(feed.stateOfNode("motor3"), "normal");
  feed.record(parseAnomalyVerdict(verdict({ source_id: "motor-3", field: "y", verdict: "suspect" }))!);
  feed.record(parseAnomalyVerdict(verdict({ source_id: "motor-4", verdict: "anomalous" }))!);
  assert.equal(feed.stateOfNode("MOTOR 3"), "suspect");
  assert.equal(feed.stateOfNode("motor4"), "anomalous");
  assert.equal(feed.stateOfNode("motor"), "unknown", "a name is not a prefix");
  assert.equal(feed.stateOfNode("---"), "unknown");
});

test("the sentence about a node exists in the eight languages for every state and names the node", () => {
  for (const language of ["en", "es", "de", "fr", "it", "ja", "zh", "pt"]) {
    for (const state of ["normal", "suspect", "anomalous", "unknown"] as const) {
      assert.ok(nodeStateText("motor3", state, language).includes("motor3"), `${language} ${state}`);
    }
    assert.ok(nodeStateText("motor3", "off", language).length > 10, `${language} off`);
  }
  assert.equal(nodeStateText("m", "normal", "xx"), "m is behaving normally.", "another language gets English");
});
