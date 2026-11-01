import assert from "node:assert/strict";
import { test } from "node:test";
import { OrchestratorTakeover, ORCHESTRATOR_MAX_ITEMS, inFlight, resolveTakeover, type ReplicaRecord, type TakeoverDeps } from "../src/orchestratorTakeover.ts";

// The hand-over of the missions to a standby orchestrator, with a simulated clock and simulated orchestrators: nothing waits or opens a socket.

const ENV = { HYDRA_UMC_ORCH_TAKEOVER: "1", HYDRA_UMC_ORCHESTRATOR_URL: "http://primary:8114/", HYDRA_UMC_ORCHESTRATOR_STANDBY_URL: "http://standby:8114", HYDRA_UMC_ORCHESTRATOR_TOKEN: "ptok" };

function record(id: string, status: string, owner: string, attempt = 0): ReplicaRecord {
  return { key: `mission/${id}`, value: JSON.stringify({ mission_id: id, status, owner, attempt }), generation: attempt + 1 };
}

function settingsOf(extra: Record<string, unknown> = {}, env: Record<string, string> = {}) {
  const resolved = resolveTakeover({ ...ENV, ...env }, extra);
  assert.ok(resolved.ok, resolved.ok ? "" : resolved.error);
  return resolved.settings;
}

function harness(extra: Record<string, unknown> = {}) {
  const clock = { ms: 1_760_000_000_000 };
  const state = {
    primaryUp: true,
    replica: [record("m1", "running", "arm-1"), record("m2", "assigned", "arm-2", 3), record("m3", "queued", "orchestrator"), record("m4", "completed", "arm-1")] as unknown,
    replicaStatus: 200,
    standbyStatus: 200,
    standbyBody: { adopted: ["m1", "m2", "m3", "m4"], requeued: ["m1"], unconfirmed: ["m2"] } as unknown,
    standbyThrows: false,
  };
  const calls: { method: string; url: string; auth?: string; body?: any }[] = [];
  const audit: any[] = [];
  const logs: string[] = [];
  const deps: TakeoverDeps = {
    settings: settingsOf(extra),
    now: () => clock.ms,
    log: (line) => logs.push(line),
    audit: (event) => audit.push(event),
    fetch: async (url, init) => {
      calls.push({ method: init.method, url, auth: init.headers.Authorization, body: init.body ? JSON.parse(init.body) : undefined });
      if (url.startsWith("http://primary:8114")) {
        if (!state.primaryUp) throw new Error("down");
        if (url.endsWith("/health")) return { status: 200, json: async () => ({ status: "ok" }) };
        return { status: state.replicaStatus, json: async () => ({ records: state.replica }) };
      }
      if (state.standbyThrows) throw new Error("down");
      return { status: state.standbyStatus, json: async () => state.standbyBody };
    },
  };
  return { t: new OrchestratorTakeover(deps), clock, state, calls, audit, logs };
}

const posts = (calls: { method: string }[]) => calls.filter((c) => c.method === "POST");

test("it is off unless the switch says so, needs two different addresses and refuses wrong values", () => {
  assert.ok(resolveTakeover({}, {}).ok && !(resolveTakeover({}, {}) as any).settings.enabled);
  assert.ok(!resolveTakeover({ HYDRA_UMC_ORCH_TAKEOVER: "1" }, {}).ok, "on with no addresses");
  assert.ok(!resolveTakeover({ ...ENV, HYDRA_UMC_ORCHESTRATOR_STANDBY_URL: "http://primary:8114" }, {}).ok, "the same orchestrator twice");
  assert.ok(!resolveTakeover({ ...ENV, HYDRA_UMC_ORCH_TAKEOVER: "0" }, { enabled: true }).ok === false);
  const standbyToken = resolveTakeover({ ...ENV, HYDRA_UMC_ORCHESTRATOR_STANDBY_TOKEN: "stok" }, {});
  assert.ok(standbyToken.ok && standbyToken.settings.standbyToken === "stok" && standbyToken.settings.primaryToken === "ptok");
  const fallback = resolveTakeover(ENV, {});
  assert.ok(fallback.ok && fallback.settings.standbyToken === "ptok");
  for (const bad of [{ pollSeconds: 0 }, { failuresBeforeTakeover: 0 }, { failuresBeforeTakeover: 1.5 }, { maxProofs: 6000 }, { requestTimeoutMs: 5 }, { enabled: "yes" }, { retrySeconds: "10" }]) {
    assert.ok(!resolveTakeover(ENV, bad).ok, JSON.stringify(bad));
  }
});

test("a mission is in flight only when assigned or running, with a holder and a whole attempt", () => {
  assert.deepEqual(inFlight(record("a", "running", "arm-1", 2)), { missionId: "a", owner: "arm-1", attempt: 2 });
  assert.deepEqual(inFlight(record("a", "assigned", "arm-1")), { missionId: "a", owner: "arm-1", attempt: 0 });
  for (const r of [record("a", "queued", "o"), record("a", "completed", "o"), { key: "k", value: "{", generation: 1 }, { key: "k", value: JSON.stringify({ mission_id: "a", status: "running", owner: "o", attempt: -1 }), generation: 1 }]) {
    assert.equal(inFlight(r), null);
  }
});

test("nothing is delivered while the primary answers, and the proofs are only the ones that apply", async () => {
  const h = harness();
  h.t.recordProof("m1", "arm-1");   // the robot that holds m1 acknowledged
  h.t.recordProof("m2", "arm-9");   // another robot than the holder of m2
  h.t.recordProof("m3", "arm-1");   // m3 is not in flight
  for (let i = 0; i < 4; i++) await h.t.tick();
  assert.equal(posts(h.calls).length, 0);
  assert.equal(h.t.state, "watching");
  h.state.primaryUp = false;
  for (let i = 0; i < 3; i++) await h.t.tick();
  const sent = posts(h.calls);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].url, "http://standby:8114/replica/takeover");
  assert.equal(sent[0].auth, "Bearer ptok");
  assert.deepEqual(sent[0].body.confirmed_stopped, [{ owner: "arm-1", mission_id: "m1", attempt: 0 }]);
  assert.equal(sent[0].body.records.length, 4);
  assert.equal(h.t.state, "delivered");
  assert.equal(h.audit.at(-1).outcome, "ok");
});

test("it waits for the configured number of silent checks in a row and a primary that comes back clears the count", async () => {
  const h = harness({ failuresBeforeTakeover: 3 });
  await h.t.tick();
  h.state.primaryUp = false;
  await h.t.tick();
  await h.t.tick();
  assert.equal(posts(h.calls).length, 0);
  h.state.primaryUp = true;
  await h.t.tick();
  h.state.primaryUp = false;
  await h.t.tick();
  await h.t.tick();
  assert.equal(posts(h.calls).length, 0, "the count started again");
  await h.t.tick();
  assert.equal(posts(h.calls).length, 1);
});

test("a proof older than its limit on the simulated clock is not sent; a replica that is too old is never delivered", async () => {
  const h = harness({ proofMaxAgeSeconds: 100, maxSnapshotAgeSeconds: 30, failuresBeforeTakeover: 1 });
  h.t.recordProof("m1", "arm-1");
  await h.t.tick();                       // replica read
  h.clock.ms += 200_000;                   // the primary then goes silent much later: the replica is old
  h.state.primaryUp = false;
  await h.t.tick();
  assert.equal(posts(h.calls).length, 0);
  assert.equal(h.t.state, "refused");
  assert.match(h.audit.at(-1).detail.reason, /older than 30 s/);

  const fresh = harness({ proofMaxAgeSeconds: 100, maxSnapshotAgeSeconds: 1000, failuresBeforeTakeover: 1 });
  fresh.t.recordProof("m1", "arm-1");
  await fresh.t.tick();
  fresh.clock.ms += 5_000;
  fresh.t.recordProof("m2", "arm-2");
  fresh.clock.ms += 150_000;               // the proof of m1 is now older than 100 s, the one of m2 too
  fresh.state.primaryUp = false;
  await fresh.t.tick();
  assert.deepEqual(posts(fresh.calls)[0].body.confirmed_stopped, []);
});

test("with no replica ever read nothing is delivered", async () => {
  const h = harness({ failuresBeforeTakeover: 1 });
  h.state.primaryUp = false;
  await h.t.tick();
  assert.equal(h.t.state, "refused");
  assert.equal(posts(h.calls).length, 0);
});

test("a standby that refuses is not tried again, one that does not answer is retried on the simulated clock up to the limit", async () => {
  const refused = harness({ failuresBeforeTakeover: 1 });
  await refused.t.tick();
  refused.state.primaryUp = false;
  refused.state.standbyStatus = 404;
  await refused.t.tick();
  await refused.t.tick();
  assert.equal(posts(refused.calls).length, 1);
  assert.equal(refused.t.state, "refused");

  const h = harness({ failuresBeforeTakeover: 1, maxDeliveryAttempts: 3, retrySeconds: 10 });
  await h.t.tick();
  h.state.primaryUp = false;
  h.state.standbyThrows = true;
  await h.t.tick();
  assert.equal(posts(h.calls).length, 1);
  await h.t.tick();                          // too soon: the retry is not due
  assert.equal(posts(h.calls).length, 1);
  h.clock.ms += 10_000;
  await h.t.tick();
  h.clock.ms += 10_000;
  await h.t.tick();
  assert.equal(posts(h.calls).length, 3);
  assert.equal(h.t.state, "gave-up");
  h.clock.ms += 60_000;
  await h.t.tick();
  assert.equal(posts(h.calls).length, 3, "no more attempts after giving up");
  // the standby comes back after the primary does: the hand-over is armed again
  h.state.primaryUp = true;
  await h.t.tick();
  assert.equal(h.t.state, "watching");
});

test("a delivered hand-over is not repeated during the same outage and is armed again when the primary returns", async () => {
  const h = harness({ failuresBeforeTakeover: 1 });
  await h.t.tick();
  h.state.primaryUp = false;
  await h.t.tick();
  await h.t.tick();
  await h.t.tick();
  assert.equal(posts(h.calls).length, 1);
  h.state.primaryUp = true;
  await h.t.tick();
  assert.equal(h.t.state, "watching");
  h.state.primaryUp = false;
  await h.t.tick();
  assert.equal(posts(h.calls).length, 2);
});

test("the proofs are bounded and the oldest are forgotten first", () => {
  const h = harness({ maxProofs: 3 });
  for (let i = 0; i < 5; i++) {
    h.clock.ms += 1000;
    h.t.recordProof(`m${i}`, "arm-1");
  }
  assert.equal(h.t.proofCount(), 3);
  assert.deepEqual(h.t.evidenceFor([record("m0", "running", "arm-1"), record("m4", "running", "arm-1")], h.clock.ms).map((e) => e.mission_id), ["m4"]);
});

test("more records than the orchestrator takes: only what is still open is sent, and nothing is cut silently", async () => {
  const many: ReplicaRecord[] = Array.from({ length: ORCHESTRATOR_MAX_ITEMS + 10 }, (_, i) => record(`d${i}`, "completed", "arm-1"));
  many.push(record("open1", "running", "arm-1"));
  const h = harness({ failuresBeforeTakeover: 1 });
  h.state.replica = many;
  await h.t.tick();
  h.state.primaryUp = false;
  await h.t.tick();
  assert.deepEqual(posts(h.calls)[0].body.records.map((r: ReplicaRecord) => r.key), ["mission/open1"]);
  const tooOpen = harness({ failuresBeforeTakeover: 1 });
  tooOpen.state.replica = Array.from({ length: ORCHESTRATOR_MAX_ITEMS + 1 }, (_, i) => record(`q${i}`, "queued", "orchestrator"));
  await tooOpen.t.tick();
  tooOpen.state.primaryUp = false;
  await tooOpen.t.tick();
  assert.equal(posts(tooOpen.calls).length, 0);
  assert.equal(tooOpen.t.state, "refused");
});

test("a replica that is not in the expected shape does not replace the one already kept", async () => {
  const h = harness({ failuresBeforeTakeover: 1 });
  await h.t.tick();
  h.state.replica = [{ nope: 1 }];
  await h.t.tick();
  h.state.primaryUp = false;
  await h.t.tick();
  assert.equal(posts(h.calls)[0].body.records.length, 4);
});

test("the loop runs on the timers it is given", async () => {
  const h = harness();
  const timers: { fn: () => void; ms: number; live: boolean }[] = [];
  h.t.start({ set: (fn, ms) => { const t = { fn, ms, live: true }; timers.push(t); return t; }, clear: (handle) => { (handle as { live: boolean }).live = false; } });
  assert.equal(timers[0].ms, 0);
  timers[0].fn();
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(timers[1]?.ms, 5000);
  h.t.stop();
  assert.equal(timers[1].live, false);
});
