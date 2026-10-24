import assert from "node:assert/strict";
import { test } from "node:test";
import {
  FAILURE_PAUSE_MS,
  MAX_FIELDS,
  MAX_SOURCES,
  TelemetryProducer,
  createTelemetryProducer,
  flattenPatch,
  ingestUrlFrom,
  intervalFrom,
  sourceIdOf,
} from "../src/telemetryProducer.ts";

type Call = { url: string; headers: Record<string, string>; body: any };

function producer(answers: Array<{ ok: boolean; status: number } | "throw">, extra: { token?: string } = {}) {
  const calls: Call[] = [];
  let clock = 1_800_000_000_000;
  const instance = new TelemetryProducer({
    url: "http://127.0.0.1:8092/ingest/ws",
    token: extra.token,
    now: () => clock,
    post: async (url, init) => {
      calls.push({ url, headers: init.headers, body: JSON.parse(init.body) });
      const next = answers.shift() ?? { ok: true, status: 202 };
      if (next === "throw") throw new Error("connection refused");
      return next;
    },
  });
  return { instance, calls, advance: (ms: number) => { clock += ms; } };
}

test("the numbers of a patch become flat fields, booleans become 0 or 1, the rest is left out", () => {
  assert.deepEqual(
    flattenPatch({ pos: { x: 1.5, y: -2, z: 0 }, joints: { j1: 10, j2: 20 }, playbackState: { isPlaying: true, isPaused: false, activeStep: 3, note: "text" }, valves: [true, false], name: "robot", bad: NaN }),
    { pos_x: 1.5, pos_y: -2, pos_z: 0, joints_j1: 10, joints_j2: 20, playbackState_isPlaying: 1, playbackState_isPaused: 0, playbackState_activeStep: 3 },
  );
  assert.deepEqual(flattenPatch({ a: { b: { c: 1 } } }), {}, "deeper than two levels is left out");
  assert.deepEqual(flattenPatch({ "bad key": 1, ok_key: 2 }), { ok_key: 2 });
  assert.deepEqual(flattenPatch(null), {});
  assert.deepEqual(flattenPatch([1, 2]), {});
  const many = Object.fromEntries(Array.from({ length: 100 }, (_, i) => [`f${i}`, i]));
  assert.equal(Object.keys(flattenPatch(many)).length, MAX_FIELDS);
});

test("the source of a sample names the controller and the robot with safe characters only", () => {
  assert.equal(sourceIdOf({ controllerId: "ctrl-1", robotId: 3, patch: {} }), "robot-ctrl-1-3");
  assert.equal(sourceIdOf({ controllerId: "a b/c\n", robotId: 2, patch: {} }), "robot-a_b_c_-2");
});

test("one sample per robot is sent with the latest value of each field, and nothing is sent without numbers", async () => {
  const { instance, calls } = producer([]);
  instance.record([{ controllerId: "c1", robotId: 1, patch: { joints: { j1: 1, j2: 2 } } }]);
  instance.record([{ controllerId: "c1", robotId: 1, patch: { joints: { j1: 5 } } }, { controllerId: "c1", robotId: 2, patch: { pos: { x: 9 } } }, { controllerId: "c1", robotId: 3, patch: { name: "no numbers" } }]);
  await instance.flush();
  assert.equal(calls.length, 2);
  const first = calls.find((c) => c.body.sourceId === "robot-c1-1")!;
  assert.deepEqual(first.body.fields, { joints_j1: 5, joints_j2: 2 });
  assert.equal(first.body.kind, "robot_state");
  assert.equal(first.body.sequence, 1);
  assert.equal(typeof first.body.timestamp, "number");
  assert.equal(calls.some((c) => c.body.sourceId === "robot-c1-3"), false);
  assert.equal(instance.stats.sent, 2);
  // nothing pending: nothing sent
  await instance.flush();
  assert.equal(calls.length, 2);
});

test("the sequence of a robot grows by one at every sample, so the collector can drop a resend", async () => {
  const { instance, calls } = producer([]);
  for (let i = 0; i < 3; i += 1) {
    instance.record([{ controllerId: "c1", robotId: 1, patch: { pos: { x: i } } }]);
    await instance.flush();
  }
  assert.deepEqual(calls.map((c) => c.body.sequence), [1, 2, 3]);
});

test("the token goes in the Authorization header when there is one", async () => {
  const { instance, calls } = producer([], { token: "collector-token-123" });
  instance.record([{ controllerId: "c1", robotId: 1, patch: { pos: { x: 1 } } }]);
  await instance.flush();
  assert.equal(calls[0].headers.authorization, "Bearer collector-token-123");
  const without = producer([]);
  without.instance.record([{ controllerId: "c1", robotId: 1, patch: { pos: { x: 1 } } }]);
  await without.instance.flush();
  assert.equal(without.calls[0].headers.authorization, undefined);
});

test("an unreachable collector pauses the producer instead of retrying at once", async () => {
  const { instance, calls, advance } = producer(["throw"]);
  instance.record([{ controllerId: "c1", robotId: 1, patch: { pos: { x: 1 } } }, { controllerId: "c1", robotId: 2, patch: { pos: { x: 2 } } }]);
  await instance.flush();
  assert.equal(calls.length, 1, "after the first failure the rest of this round is not tried");
  assert.equal(instance.stats.failed, 1);
  instance.record([{ controllerId: "c1", robotId: 1, patch: { pos: { x: 3 } } }]);
  await instance.flush();
  assert.equal(calls.length, 1, "paused");
  advance(FAILURE_PAUSE_MS + 1);
  await instance.flush();
  assert.equal(calls.length, 2, "tried again after the pause");
});

test("an answer of server error or of refused token pauses, a refusal of one sample does not", async () => {
  const bad = producer([{ ok: false, status: 400 }]);
  bad.instance.record([{ controllerId: "c1", robotId: 1, patch: { pos: { x: 1 } } }, { controllerId: "c1", robotId: 2, patch: { pos: { x: 2 } } }]);
  await bad.instance.flush();
  assert.equal(bad.calls.length, 2);
  assert.equal(bad.instance.stats.failed, 1);
  for (const status of [401, 403, 503]) {
    const down = producer([{ ok: false, status }]);
    down.instance.record([{ controllerId: "c1", robotId: 1, patch: { pos: { x: 1 } } }, { controllerId: "c1", robotId: 2, patch: { pos: { x: 2 } } }]);
    await down.instance.flush();
    assert.equal(down.calls.length, 1, String(status));
  }
});

test("the number of robots it keeps is bounded", () => {
  const { instance } = producer([]);
  for (let i = 0; i < MAX_SOURCES + 10; i += 1) instance.record([{ controllerId: "c", robotId: i, patch: { pos: { x: 1 } } }]);
  assert.equal(instance.stats.dropped, 10);
});

test("the producer is off without an address and the address is checked", () => {
  assert.equal(createTelemetryProducer({}), undefined);
  assert.equal(createTelemetryProducer({ HYDRA_UMC_TELEMETRY_COLLECTOR_URL: "ftp://x" }), undefined);
  assert.equal(createTelemetryProducer({ HYDRA_UMC_TELEMETRY_COLLECTOR_URL: "http://user:pw@127.0.0.1:8092" }), undefined);
  assert.equal(ingestUrlFrom({ HYDRA_UMC_TELEMETRY_COLLECTOR_URL: "http://127.0.0.1:8092/" }), "http://127.0.0.1:8092/ingest/ws");
  assert.equal(ingestUrlFrom({ HYDRA_UMC_TELEMETRY_COLLECTOR_URL: "https://cm5.local/collector" }), "https://cm5.local/collector/ingest/ws");
  assert.ok(createTelemetryProducer({ HYDRA_UMC_TELEMETRY_COLLECTOR_URL: "http://127.0.0.1:8092" }));
});

test("the interval is clamped and falls back to the default", () => {
  assert.equal(intervalFrom({}), 1000);
  assert.equal(intervalFrom({ HYDRA_UMC_TELEMETRY_INTERVAL_MS: "250" }), 250);
  assert.equal(intervalFrom({ HYDRA_UMC_TELEMETRY_INTERVAL_MS: "5" }), 100);
  assert.equal(intervalFrom({ HYDRA_UMC_TELEMETRY_INTERVAL_MS: "999999" }), 60000);
  assert.equal(intervalFrom({ HYDRA_UMC_TELEMETRY_INTERVAL_MS: "abc" }), 1000);
  assert.equal(intervalFrom({ HYDRA_UMC_TELEMETRY_INTERVAL_MS: "-4" }), 1000);
});
