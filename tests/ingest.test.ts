// =============================================================================
// HYDRA-UMC-SERVER - Unit tests for what the sibling services hand to the server
// Copyright (C) 2026 JuanenRac (Electro Hobby 3D) <electrohobby3d@gmail.com>
// GPL-3.0-or-later - see LICENSE
// =============================================================================
// The signed hash-chained record and its retention, the contracts it accepts (ScenarioOutcome, developer-node-status/1,
// fault-event/1), the token of each developer node and the routes, which are off until their switch is "1".
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { apiRateLimiter } from "../src/auth.ts";
import { ChainedLog } from "../src/ingestLog.ts";
import {
  FaultFeed, fingerprintKindOf, hashToken, makeIngest, nodeIdForToken, parseFaultEvent, scenarioOutcomeProblem, developerNodeStatusProblem, transportAcceptable,
} from "../src/ingestFeeds.ts";
import { registerIngestRoutes } from "../src/routes/ingestRoutes.ts";

const KEY = "k".repeat(40);
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "hydra-ingest-"));
const outcome = (over: any = {}) => ({
  schema_version: "1.0", scenario_id: "s1", run_id: "r1", base_fingerprint: "abc", phase: "before", repro_case: "c1",
  observed: { outcome: "reproduced", exit_code: 1 }, timestamp_utc: "2026-01-01T00:00:00Z", ...over,
});

test("the record chains and signs, finds a changed record, and refuses to write without a key", () => {
  const dir = tmp();
  const file = path.join(dir, "a.jsonl");
  const log = new ChainedLog(file, () => KEY);
  log.append("x", { n: 1 }); log.append("x", { n: 2 }); log.append("x", { n: 3 });
  assert.deepEqual(log.verify(), { ok: true, records: 3 });
  assert.equal(new ChainedLog(file, () => KEY).verify().ok, true, "it reads back from disk");
  const lines = fs.readFileSync(file, "utf8").trim().split("\n");
  lines[1] = lines[1].replace('"n":2', '"n":9');
  fs.writeFileSync(file, lines.join("\n") + "\n");
  const bad = new ChainedLog(file, () => KEY).verify();
  assert.equal(bad.ok, false);
  assert.equal(bad.brokenAt, 1);
  assert.throws(() => new ChainedLog(path.join(dir, "b.jsonl"), () => "").append("x", {}), /signing key/);
  const wrongKey = new ChainedLog(path.join(dir, "c.jsonl"), () => KEY);
  wrongKey.append("x", {});
  assert.equal(new ChainedLog(path.join(dir, "c.jsonl"), () => "z".repeat(40)).verify().reason, "signature");
});

test("retention drops the oldest by count and by age and the chain still verifies", () => {
  const dir = tmp();
  let now = 1_000_000_000_000;
  const log = new ChainedLog(path.join(dir, "r.jsonl"), () => KEY, () => ({ maxAgeDays: 2, maxRecords: 3 }), () => now);
  for (let i = 0; i < 5; i++) log.append("x", { i });
  assert.equal(log.count(), 3);
  assert.deepEqual(log.list(10).map((r) => (r.payload as any).i), [4, 3, 2]);
  assert.equal(log.verify().ok, true);
  now += 3 * 86_400_000;
  log.append("x", { i: 5 });
  assert.equal(log.count(), 1, "older than two days is gone");
  assert.equal(new ChainedLog(path.join(dir, "r.jsonl"), () => KEY).verify().ok, true);
});

test("a ScenarioOutcome is checked against the shared contract", () => {
  assert.equal(scenarioOutcomeProblem(outcome()), null);
  assert.match(scenarioOutcomeProblem(outcome({ phase: "during" }))!, /phase/);
  assert.match(scenarioOutcomeProblem(outcome({ observed: { outcome: "maybe" } }))!, /outcome/);
  assert.match(scenarioOutcomeProblem(outcome({ schema_version: "2.0" }))!, /schema_version/);
  assert.match(scenarioOutcomeProblem(outcome({ timestamp_utc: "never" }))!, /timestamp/);
  assert.match(scenarioOutcomeProblem([])!, /object/);
  assert.equal(scenarioOutcomeProblem(outcome({ extra: 1 })), null, "extra fields are allowed by the contract");
});

test("a developer-node-status/1 document is checked", () => {
  const ok = { contract: "developer-node-status/1", version: "0.0.1", generated_at: 1, switches: {}, queue: {}, journal: [], health: {} };
  assert.equal(developerNodeStatusProblem(ok), null);
  assert.match(developerNodeStatusProblem({ ...ok, contract: "x" })!, /contract/);
  assert.match(developerNodeStatusProblem({ ...ok, journal: {} })!, /journal/);
});

test("the token of a node is found by its hash, and an unknown or missing registry knows nobody", () => {
  const dir = tmp();
  const file = path.join(dir, "tokens.json");
  fs.writeFileSync(file, JSON.stringify({ nodes: { "dev-1": hashToken("secret-one-token"), "dev-2": hashToken("secret-two-token") } }));
  const env = { HYDRA_UMC_DEVELOPER_NODE_TOKENS_FILE: file };
  assert.equal(nodeIdForToken("secret-two-token", env), "dev-2");
  assert.equal(nodeIdForToken("secret-three", env), null);
  assert.equal(nodeIdForToken("", env), null);
  assert.equal(nodeIdForToken("secret-one-token", {}), null);
  assert.equal(nodeIdForToken("secret-one-token", { HYDRA_UMC_DEVELOPER_NODE_TOKENS_FILE: path.join(dir, "none.json") }), null);
});

test("HTTPS is required unless the request never left this machine or the bench switch is on", () => {
  assert.equal(transportAcceptable({ secure: true, socket: { remoteAddress: "10.0.0.5" } }, {}), true);
  assert.equal(transportAcceptable({ headers: {}, socket: { remoteAddress: "10.0.0.5" } }, {}), false);
  assert.equal(transportAcceptable({ headers: { "x-forwarded-proto": "https" }, socket: { remoteAddress: "10.0.0.5" } }, {}), true);
  assert.equal(transportAcceptable({ headers: {}, socket: { remoteAddress: "127.0.0.1" } }, {}), true);
  assert.equal(transportAcceptable({ headers: { "x-forwarded-proto": "http" }, socket: { remoteAddress: "127.0.0.1" } }, {}), false);
  assert.equal(transportAcceptable({ headers: {}, socket: { remoteAddress: "10.0.0.5" } }, { HYDRA_UMC_INGEST_ALLOW_HTTP: "1" }), true);
});

test("faults: only fault-event/1 is read; the active set follows raised and cleared and survives a restart", () => {
  assert.equal(parseFaultEvent("{not json"), null);
  assert.equal(parseFaultEvent({ schema: "other" }), null);
  assert.equal(parseFaultEvent({ schema: "fault-event/1", source: "mcu", code: "E1", state: "stuck" }), null);
  const dir = tmp();
  const file = path.join(dir, "f.jsonl");
  const feed = new FaultFeed(new ChainedLog(file, () => KEY));
  const raised = parseFaultEvent(JSON.stringify({ schema: "fault-event/1", source: "mcu", robot_id: 2, code: "E1", severity: "critical", text: "hot", state: "raised" }))!;
  feed.record(raised);
  feed.record({ ...raised, code: "E2" });
  assert.equal(feed.activeFaults().length, 2);
  feed.record({ ...raised, state: "cleared" });
  assert.deepEqual(feed.activeFaults().map((f) => f.code), ["E2"]);
  const again = new FaultFeed(new ChainedLog(file, () => KEY));
  assert.deepEqual(again.activeFaults().map((f) => f.code), ["E2"]);
  assert.equal(again.recent(10).length, 3);
});

type Handler = (req: any, res: any, next?: any) => unknown;
function setup(env: Record<string, string | undefined>) {
  const routes: Record<string, Handler[]> = {};
  const reg = (m: string) => (p: string, ...h: Handler[]) => { routes[`${m} ${p}`] = h.filter((fn) => fn !== apiRateLimiter); };
  const app: any = { get: reg("GET"), post: reg("POST"), put() {}, delete() {}, patch() {} };
  const dir = tmp();
  const full = { JWT_SECRET: "q7Hk2vXz9LmN4pRt8WsY1cBd6FgJ3aEu5oIx0TnV", ...env };
  const store = makeIngest(dir, full);
  const events: any[] = [];
  registerIngestRoutes(app, {
    authenticate: (req: any, _r: any, next: any) => { req.user = { username: "ana", role: req.role ?? "operator" }; return next(); },
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
    const request = { headers: {}, query: {}, socket: { remoteAddress: "127.0.0.1" }, ...req };
    const run = (i: number): unknown => (i >= chain.length ? undefined : chain[i](request, res, () => run(i + 1)));
    run(0);
    return res;
  };
  return { call, events, store, dir };
}

test("every route answers 404 while its switch is off", () => {
  const t = setup({});
  assert.equal(t.call("POST /api/ingest/scenario-outcome", { body: outcome() }).statusCode, 404);
  assert.equal(t.call("GET /api/ingest/scenario-outcomes").statusCode, 404);
  assert.equal(t.call("GET /api/faults").statusCode, 404);
  assert.equal(t.call("GET /api/developer-node/status").statusCode, 404);
});

test("scenario outcome: stored signed, audited, listed and verified; a bad one is refused and audited", () => {
  const t = setup({ HYDRA_UMC_INGEST_SCENARIO: "1" });
  const ok = t.call("POST /api/ingest/scenario-outcome", { body: outcome() });
  assert.equal(ok.statusCode, 201);
  assert.equal(ok.body.seq, 0);
  assert.equal(t.call("POST /api/ingest/scenario-outcome", { body: outcome({ phase: "x" }) }).statusCode, 400);
  assert.equal(t.call("POST /api/ingest/scenario-outcome", { body: outcome(), role: "viewer" }).statusCode, 403);
  const list = t.call("GET /api/ingest/scenario-outcomes", { query: { verify: "1", scenario_id: "s1" } });
  assert.equal(list.body.items.length, 1);
  assert.equal(list.body.chain.ok, true);
  assert.deepEqual(t.events.map((e) => e.outcome), ["ok", "refused"]);
});

test("scenario outcome: a live service check is told apart from a manifest one by its fingerprint kind", () => {
  const t = setup({ HYDRA_UMC_INGEST_SCENARIO: "1" });
  assert.equal(scenarioOutcomeProblem(outcome({ fingerprint_kind: "live-service" })), null);
  assert.equal(scenarioOutcomeProblem(outcome({ fingerprint_kind: "manifest" })), null);
  assert.match(scenarioOutcomeProblem(outcome({ fingerprint_kind: "guess" }))!, /fingerprint_kind/);
  assert.equal(fingerprintKindOf(outcome()), "manifest", "a document that does not say is a manifest one");
  assert.equal(fingerprintKindOf(outcome({ fingerprint_kind: "live-service" })), "live-service");
  assert.equal(t.call("POST /api/ingest/scenario-outcome", { body: outcome({ run_id: "m" }) }).statusCode, 201);
  assert.equal(t.call("POST /api/ingest/scenario-outcome", { body: outcome({ run_id: "l", fingerprint_kind: "live-service" }) }).statusCode, 201);
  assert.equal(t.call("POST /api/ingest/scenario-outcome", { body: outcome({ fingerprint_kind: "guess" }) }).statusCode, 400);
  const runs = (query: any) => t.call("GET /api/ingest/scenario-outcomes", { query }).body.items.map((r: any) => r.payload.run_id).sort();
  assert.deepEqual(runs({}), ["l", "m"]);
  assert.deepEqual(runs({ fingerprint_kind: "live-service" }), ["l"]);
  assert.deepEqual(runs({ fingerprint_kind: "manifest" }), ["m"]);
  assert.equal(t.call("GET /api/ingest/scenario-outcomes", { query: { fingerprint_kind: "guess" } }).statusCode, 400);
});

test("scenario outcome: no usable key of the server means a 503 and nothing unsigned is written", () => {
  const t = setup({ HYDRA_UMC_INGEST_SCENARIO: "1", JWT_SECRET: "short" });
  assert.equal(t.call("POST /api/ingest/scenario-outcome", { body: outcome() }).statusCode, 503);
  assert.equal(t.store.scenario.count(), 0);
});

test("developer node: needs its own token over HTTPS, and the latest status of each node is read back", () => {
  const dir = tmp();
  const tokens = path.join(dir, "t.json");
  fs.writeFileSync(tokens, JSON.stringify({ nodes: { "dev-1": hashToken("tok-dev-1-secret") } }));
  const t = setup({ HYDRA_UMC_INGEST_DEVELOPER_NODE: "1", HYDRA_UMC_DEVELOPER_NODE_TOKENS_FILE: tokens });
  const status = { contract: "developer-node-status/1", version: "0.0.1", generated_at: 1, switches: {}, queue: {}, journal: [], health: {} };
  const post = (headers: any, body: any = status, socket: any = { remoteAddress: "127.0.0.1" }) => t.call("POST /api/ingest/developer-node/status", { headers, body, socket });
  assert.equal(post({}).statusCode, 401);
  assert.equal(post({ authorization: "Bearer nope" }).statusCode, 401);
  assert.equal(post({ authorization: "Bearer tok-dev-1-secret", "x-node-id": "dev-9" }).statusCode, 401);
  assert.equal(post({ authorization: "Bearer tok-dev-1-secret" }, status, { remoteAddress: "10.0.0.7" }).statusCode, 403);
  assert.equal(post({ authorization: "Bearer tok-dev-1-secret" }, { ...status, contract: "x" }).statusCode, 400);
  assert.equal(post({ authorization: "Bearer tok-dev-1-secret" }).statusCode, 201);
  post({ authorization: "Bearer tok-dev-1-secret" }, { ...status, version: "0.0.2" });
  const read = t.call("GET /api/developer-node/status", { query: { verify: "1" } });
  assert.equal((read.body.nodes["dev-1"].status as any).version, "0.0.2");
  assert.equal(read.body.chain.ok, true);
});

test("developer node: while its switch is off even a good token gets 401", () => {
  const dir = tmp();
  const tokens = path.join(dir, "t.json");
  fs.writeFileSync(tokens, JSON.stringify({ nodes: { "dev-1": hashToken("tok-dev-1-secret") } }));
  const t = setup({ HYDRA_UMC_DEVELOPER_NODE_TOKENS_FILE: tokens });
  assert.equal(t.call("POST /api/ingest/developer-node/status", { headers: { authorization: "Bearer tok-dev-1-secret" }, body: {} }).statusCode, 401);
});

test("fault feed route lists the active faults and the recent ones", () => {
  const t = setup({ HYDRA_UMC_FAULT_FEED: "1" });
  t.store.faults.record(parseFaultEvent({ schema: "fault-event/1", source: "mcu", code: "E1", state: "raised" })!);
  const all = t.call("GET /api/faults");
  assert.equal(all.body.active.length, 1);
  assert.equal(all.body.recent.length, 1);
  assert.equal(t.call("GET /api/faults", { query: { active: "1" } }).body.recent, undefined);
});
