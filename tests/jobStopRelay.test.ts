import assert from "node:assert/strict";
import { test } from "node:test";
import { JobStopRelay, STOP_RELAY_DEFAULTS, resolveStopRelay, type StopRelayDeps } from "../src/jobStopRelay";

// The delivery of the stop that the job dispatcher asks for, with a simulated clock and a simulated dispatcher: nothing here waits or opens a socket.

const BASE = { HYDRA_UMC_JOB_DISPATCHER_URL: "http://127.0.0.1:8090/", HYDRA_UMC_JOB_STOP_RELAY: "1" };
const MAP = { "arm-1": 1, "arm-2": 2 };

function settingsOf(extra: Record<string, unknown> = {}, env: Record<string, string> = {}) {
  const resolution = resolveStopRelay({ ...BASE, ...env }, { robotMap: MAP, ...extra });
  assert.ok(resolution.ok, resolution.ok ? "" : resolution.error);
  return resolution.settings;
}

interface Call { method: string; url: string; body?: unknown; auth?: string }

function harness(options: { requests?: unknown; ackStatus?: number; ackThrows?: boolean; getStatus?: number; getThrows?: boolean; stopResult?: (id: number) => boolean; extra?: Record<string, unknown>; env?: Record<string, string> } = {}) {
  const clock = { ms: 1_760_000_000_000 };
  const calls: Call[] = [];
  const stopped: number[] = [];
  const audit: { type: string; outcome: string; detail: Record<string, unknown> }[] = [];
  const state = { ...options };
  const deps: StopRelayDeps = {
    settings: settingsOf(options.extra, options.env),
    now: () => clock.ms,
    log: () => undefined,
    audit: (event) => audit.push(event),
    stopRobot: (id) => {
      stopped.push(id);
      return state.stopResult ? state.stopResult(id) : true;
    },
    fetch: async (url, init) => {
      const body = init.body ? JSON.parse(init.body) : undefined;
      calls.push({ method: init.method, url, body, auth: init.headers.Authorization });
      if (init.method === "GET") {
        if (state.getThrows) throw new Error("connection refused");
        return { status: state.getStatus ?? 200, json: async () => state.requests ?? [] };
      }
      if (state.ackThrows) throw new Error("timeout");
      return { status: state.ackStatus ?? 200, json: async () => ({}) };
    },
  };
  return { relay: new JobStopRelay(deps), clock, calls, stopped, audit, state };
}

const request = (jobId: string, robotId: string, clock: { ms: number }, ageSeconds = 1, expired = false) => ({ jobId, robotId, requestedAtMs: clock.ms - ageSeconds * 1000, expired });

test("everything is off unless the switch says so, and the environment wins over the file", () => {
  const off = resolveStopRelay({}, { robotMap: MAP });
  assert.ok(off.ok && !off.settings.enabled);
  assert.equal(off.ok && off.settings.pollSeconds, STOP_RELAY_DEFAULTS.pollSeconds);
  const fileOn = resolveStopRelay({ HYDRA_UMC_JOB_DISPATCHER_URL: "http://x" }, { enabled: true });
  assert.ok(fileOn.ok && fileOn.settings.enabled);
  const envOff = resolveStopRelay({ HYDRA_UMC_JOB_DISPATCHER_URL: "http://x", HYDRA_UMC_JOB_STOP_RELAY: "0" }, { enabled: true });
  assert.ok(envOff.ok && !envOff.settings.enabled);
  const urlTrimmed = resolveStopRelay({ HYDRA_UMC_JOB_DISPATCHER_URL: "http://x:8090///", HYDRA_UMC_JOB_STOP_RELAY: "1" }, {});
  assert.ok(urlTrimmed.ok && urlTrimmed.settings.url === "http://x:8090");
});

test("a wrong setting stops the relay from starting instead of falling back to a default", () => {
  assert.ok(!resolveStopRelay({ HYDRA_UMC_JOB_STOP_RELAY: "1" }, {}).ok, "on with no address");
  for (const bad of [{ pollSeconds: 0 }, { pollSeconds: "2" }, { requestTimeoutMs: 5 }, { maxRequestAgeSeconds: -1 }, { maxFailureBackoffSeconds: 99999 }, { robotMap: [] }, { robotMap: { a: "1" } }, { robotMap: { a: -1 } }, { enabled: "yes" }]) {
    assert.ok(!resolveStopRelay(BASE, bad).ok, JSON.stringify(bad));
  }
});

test("a request is delivered: the robot is stopped first and the stop is acknowledged afterwards", async () => {
  const h = harness({ env: { HYDRA_UMC_JOB_DISPATCHER_TOKEN: "secret" } });
  h.state.requests = [request("weld-42", "arm-1", h.clock)];
  const report = await h.relay.pass();
  assert.deepEqual(h.stopped, [1]);
  assert.deepEqual(report.acknowledged, ["weld-42"]);
  assert.deepEqual(h.calls.map((c) => `${c.method} ${c.url}`), ["GET http://127.0.0.1:8090/jobs/stop-requests", "POST http://127.0.0.1:8090/jobs/stop-ack"]);
  assert.deepEqual(h.calls[1].body, { robotId: "arm-1", jobId: "weld-42" });
  assert.equal(h.calls[0].auth, "Bearer secret");
  assert.equal(h.audit.at(-1)?.outcome, "ok");
});

test("a stop that could not be applied is never acknowledged", async () => {
  const h = harness({ stopResult: () => false });
  h.state.requests = [request("weld-42", "arm-1", h.clock)];
  const report = await h.relay.pass();
  assert.deepEqual(report.acknowledged, []);
  assert.equal(h.calls.filter((c) => c.method === "POST").length, 0);
  assert.equal(report.skipped[0].reason, "the stop could not be applied");
  assert.equal(h.audit.at(-1)?.outcome, "failed");
});

test("a stop that throws is not acknowledged and does not stop the other requests", async () => {
  const h = harness({ stopResult: (id) => { if (id === 1) throw new Error("boom"); return true; } });
  h.state.requests = [request("a", "arm-1", h.clock), request("b", "arm-2", h.clock)];
  const report = await h.relay.pass();
  assert.deepEqual(report.acknowledged, ["b"]);
});

test("a robot that is not in the map is neither stopped nor acknowledged", async () => {
  const h = harness();
  h.state.requests = [request("weld-42", "arm-9", h.clock)];
  const report = await h.relay.pass();
  assert.deepEqual(h.stopped, []);
  assert.deepEqual(report.acknowledged, []);
  assert.equal(h.audit.at(-1)?.outcome, "refused");
});

test("an expired request, and one older than the configured age on the simulated clock, are not delivered", async () => {
  const h = harness({ extra: { maxRequestAgeSeconds: 30 } });
  h.state.requests = [request("old", "arm-1", h.clock, 31), request("fresh", "arm-2", h.clock, 29), request("late", "arm-1", h.clock, 1, true)];
  const report = await h.relay.pass();
  assert.deepEqual(h.stopped, [2]);
  assert.deepEqual(report.acknowledged, ["fresh"]);
  // time passes: the request that was fresh is now too old to deliver
  h.clock.ms += 120_000;
  const second = harness({ extra: { maxRequestAgeSeconds: 30 } });
  second.state.requests = [{ jobId: "fresh", robotId: "arm-2", requestedAtMs: second.clock.ms - 29_000 }];
  second.clock.ms += 5_000;
  assert.equal((await second.relay.pass()).skipped[0].reason, "too old");
});

test("an acknowledgement that the dispatcher does not accept is retried on the next pass; 409 counts as settled", async () => {
  const h = harness({ ackStatus: 500 });
  h.state.requests = [request("weld-42", "arm-1", h.clock)];
  assert.deepEqual((await h.relay.pass()).acknowledged, []);
  h.state.ackStatus = 200;
  assert.deepEqual((await h.relay.pass()).acknowledged, ["weld-42"]);
  assert.deepEqual(h.stopped, [1, 1], "the stop is repeated before the acknowledgement is retried (harmless)");
  const settled = harness({ ackStatus: 409 });
  settled.state.requests = [request("weld-42", "arm-1", settled.clock)];
  assert.deepEqual((await settled.relay.pass()).acknowledged, ["weld-42"]);
});

test("a lost acknowledgement is retried and a settled request is not stopped again while it stays listed", async () => {
  const h = harness({ ackThrows: true });
  h.state.requests = [request("weld-42", "arm-1", h.clock)];
  assert.equal((await h.relay.pass()).skipped[0].reason, "the acknowledgement was lost");
  h.state.ackThrows = false;
  assert.deepEqual((await h.relay.pass()).acknowledged, ["weld-42"]);
  const stopsBefore = h.stopped.length;
  const third = await h.relay.pass();
  assert.equal(h.stopped.length, stopsBefore);
  assert.equal(third.skipped[0].reason, "already acknowledged");
});

test("a dispatcher with replanning off (404) is not a failure; an unreadable one backs off with simulated time up to the limit and recovers", async () => {
  const off = harness({ getStatus: 404 });
  const report = await off.relay.pass();
  assert.ok(report.read && report.seen === 0);
  assert.equal(off.relay.nextDelaySeconds(), 2);

  const down = harness({ getThrows: true, extra: { pollSeconds: 2, maxFailureBackoffSeconds: 20 } });
  const delays: number[] = [];
  for (let i = 0; i < 6; i++) {
    assert.equal((await down.relay.pass()).read, false);
    delays.push(down.relay.nextDelaySeconds());
  }
  assert.deepEqual(delays, [4, 8, 16, 20, 20, 20]);
  down.state.getThrows = false;
  assert.ok((await down.relay.pass()).read);
  assert.equal(down.relay.nextDelaySeconds(), 2);
});

test("a malformed list is a failed read and nothing is stopped", async () => {
  const h = harness();
  h.state.requests = { not: "a list" };
  assert.equal((await h.relay.pass()).read, false);
  h.state.requests = [{ jobId: 7 }, null, "x", { jobId: "j", robotId: "arm-1" }];
  const report = await h.relay.pass();
  assert.equal(report.seen, 0);
  assert.deepEqual(h.stopped, []);
});

test("the loop runs on the timers it is given: first pass at once, then after the poll period, and stop() cancels the next one", async () => {
  const h = harness({ extra: { pollSeconds: 5 } });
  h.state.requests = [];
  const timers: { fn: () => void; ms: number; id: number; live: boolean }[] = [];
  let next = 1;
  h.relay.start({
    set: (fn, ms) => { const t = { fn, ms, id: next++, live: true }; timers.push(t); return t.id; },
    clear: (id) => { const t = timers.find((x) => x.id === id); if (t) t.live = false; },
  });
  assert.deepEqual(timers.map((t) => t.ms), [0]);
  timers[0].fn();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(timers.map((t) => t.ms), [0, 5000]);
  h.relay.stop();
  assert.equal(timers[1].live, false);
  timers[1].fn();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(timers.length, 2, "nothing is scheduled after stop()");
});
