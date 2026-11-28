import assert from "node:assert/strict";
import { test } from "node:test";
import { DispatcherRegistrar, resolveRegistrar } from "../src/dispatcherRegistrar";
import { JobStopRelay, resolveStopRelay } from "../src/jobStopRelay";
import { resolveRobotTokens, robotTokenOf } from "../src/robotTokens";

// The tokens of the robots towards the job dispatcher, with a simulated dispatcher: nothing here opens a socket.

const ENV = { ARM1: "token-of-arm-1", ARM2: "token-of-arm-2", EMPTY: "  " };
const URL_ENV = { HYDRA_UMC_JOB_DISPATCHER_URL: "http://127.0.0.1:8090", HYDRA_UMC_JOB_DISPATCHER_TOKEN: "general" };

test("no section means no robot tokens, and a wrong one is an error", () => {
  assert.deepEqual(resolveRobotTokens(undefined, ENV, "general"), { ok: true, tokens: {} });
  assert.deepEqual(resolveRobotTokens({ "arm-1": "ARM1", "arm-2": "ARM2" }, ENV, "general"), { ok: true, tokens: { "arm-1": ENV.ARM1, "arm-2": ENV.ARM2 } });
  for (const wrong of [[], "x", { "arm-1": 3 }, { "arm-1": "has space" }, { "arm-1": "EMPTY" }, { "arm-1": "MISSING" }, { "arm-1": "ARM1", "arm-2": "ARM1" }]) {
    assert.equal(resolveRobotTokens(wrong, ENV, "general").ok, false, JSON.stringify(wrong));
  }
  assert.equal(resolveRobotTokens({ "arm-1": "ARM1" }, ENV, ENV.ARM1).ok, false);
  assert.equal(robotTokenOf({ "arm-1": "t" }, "constructor"), undefined);
});

function dispatcher(answers: Record<string, unknown>) {
  const calls: { method: string; path: string; auth?: string }[] = [];
  return {
    calls,
    fetch: async (url: string, init: { method: string; headers: Record<string, string> }) => {
      const path = new URL(url).pathname;
      calls.push({ method: init.method, path, auth: init.headers.Authorization });
      return { status: 200, json: async () => answers[`${init.method} ${path}`] ?? {} };
    },
  };
}

test("the stop of a robot with a token of its own is acknowledged with it; the others with the general token", async () => {
  const resolution = resolveStopRelay({ ...URL_ENV, HYDRA_UMC_JOB_STOP_RELAY: "1" }, { robotMap: { "arm-1": 1, "arm-2": 2 } });
  assert.ok(resolution.ok);
  const now = 1_760_000_000_000;
  const fake = dispatcher({ "GET /jobs/stop-requests": [{ jobId: "a", robotId: "arm-1", requestedAtMs: now }, { jobId: "b", robotId: "arm-2", requestedAtMs: now }] });
  const relay = new JobStopRelay({ settings: resolution.settings, fetch: fake.fetch, now: () => now, log: () => undefined, stopRobot: () => true, robotTokens: { "arm-1": ENV.ARM1 } });
  const report = await relay.pass();
  assert.deepEqual(report.acknowledged, ["a", "b"]);
  assert.deepEqual(fake.calls.map((c) => c.auth), ["Bearer general", `Bearer ${ENV.ARM1}`, "Bearer general"]);
});

test("a robot with a token of its own is registered with it", async () => {
  const resolution = resolveRegistrar({ ...URL_ENV, HYDRA_UMC_JOB_ROBOT_REGISTRAR: "1" }, undefined);
  assert.ok(resolution.ok);
  const fake = dispatcher({ "GET /robots": [] });
  const registrar = new DispatcherRegistrar({
    settings: resolution.settings, fetch: fake.fetch, log: () => undefined, robotTokens: { "arm-1": ENV.ARM1 },
    getSettings: () => ({ controllers: [{ id: "c", robots: [{ id: 1 }, { id: 2 }] }] }), robotMap: () => ({ "arm-1": 1, "arm-2": 2 }),
  });
  const report = await registrar.pass();
  assert.deepEqual(report.registered, ["arm-1", "arm-2"]);
  assert.deepEqual(fake.calls.map((c) => c.auth), ["Bearer general", `Bearer ${ENV.ARM1}`, "Bearer general"]);
});
