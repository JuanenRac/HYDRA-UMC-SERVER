import assert from "node:assert/strict";
import { test } from "node:test";
import { DispatcherExecutor, EXECUTOR_DEFAULTS, assignedJobs, resolveExecutor, type ExecutorDeps, type RobotRunState } from "../src/dispatcherExecutor";

// The execution of the jobs of the dispatcher on the robots of the server, with a simulated dispatcher, simulated robots and a simulated clock: nothing waits,
// opens a socket or moves anything.

const BASE = { HYDRA_UMC_JOB_DISPATCHER_URL: "http://127.0.0.1:8090/", HYDRA_UMC_JOB_EXECUTOR: "1" };
const MAP = { "arm-1": 1, "arm-2": 2 };
const roster = (...ids: number[]) => ({ controllers: [{ id: "c1", robots: ids.map((id) => ({ id })) }] });
const READY: RobotRunState = { enabled: true, reserved: false, hasTrajectory: true, playing: false, finished: false };
const job = (id: string, robot: string, extra: Record<string, unknown> = {}) => ({ ID: id, AssignedRobot: robot, Attempt: 1, RequiredTool: "PnP", Status: "assigned", ...extra });

function settingsOf(extra: Record<string, unknown> = {}, env: Record<string, string> = {}) {
  const resolution = resolveExecutor({ ...BASE, ...env }, extra);
  assert.ok(resolution.ok, resolution.ok ? "" : resolution.error);
  return resolution.settings;
}

interface Call { method: string; url: string; body?: unknown }

function harness(options: {
  jobs?: unknown;
  getStatus?: number;
  getThrows?: boolean;
  completeStatus?: number;
  completeThrows?: boolean;
  extra?: Record<string, unknown>;
  env?: Record<string, string>;
  settings?: unknown;
  gate?: string | null;
  robots?: Record<number, RobotRunState | null>;
  startOk?: boolean;
} = {}) {
  const calls: Call[] = [];
  const audit: { type: string; outcome: string; detail: Record<string, unknown> }[] = [];
  const started: number[] = [];
  const stopped: number[] = [];
  const state = { now: 1_000_000, jobs: options.jobs ?? [], gate: options.gate ?? null, robots: { 1: { ...READY }, 2: { ...READY }, ...(options.robots ?? {}) } as Record<number, RobotRunState | null> };
  const deps: ExecutorDeps = {
    settings: settingsOf({ dryRun: false, ...options.extra }, options.env),
    getSettings: () => options.settings ?? roster(1, 2),
    robotMap: () => MAP,
    now: () => state.now,
    gate: () => state.gate,
    robotState: (id) => state.robots[id] ?? null,
    startRobot: (id) => {
      started.push(id);
      if (options.startOk === false) return false;
      const robot = state.robots[id];
      if (robot) robot.playing = true;
      return true;
    },
    stopRobot: (id) => {
      stopped.push(id);
      const robot = state.robots[id];
      if (robot) robot.playing = false;
      return true;
    },
    log: () => undefined,
    audit: (event) => audit.push(event),
    fetch: async (url, init) => {
      calls.push({ method: init.method, url, body: init.body ? JSON.parse(init.body) : undefined });
      if (init.method === "GET") {
        if (options.getThrows) throw new Error("connection refused");
        return { status: options.getStatus ?? 200, json: async () => state.jobs };
      }
      if (options.completeThrows) throw new Error("timeout");
      return { status: options.completeStatus ?? 200, json: async () => ({}) };
    },
  };
  return { executor: new DispatcherExecutor(deps), calls, audit, started, stopped, state };
}

const posts = (calls: Call[]) => calls.filter((c) => c.method === "POST");

test("everything is off unless the switch says so, a start is a dry run unless it is said otherwise, the environment wins, and a wrong value is an error", () => {
  const off = resolveExecutor({}, {});
  assert.ok(off.ok && !off.settings.enabled && off.settings.dryRun);
  assert.equal(off.ok && off.settings.pollSeconds, EXECUTOR_DEFAULTS.pollSeconds);
  assert.equal(off.ok && off.settings.maxRunSeconds, EXECUTOR_DEFAULTS.maxRunSeconds);
  const fileOn = resolveExecutor({ HYDRA_UMC_JOB_DISPATCHER_URL: "http://x" }, { enabled: true });
  assert.ok(fileOn.ok && fileOn.settings.enabled && fileOn.settings.dryRun, "enabled alone is a dry run");
  const live = resolveExecutor({ HYDRA_UMC_JOB_DISPATCHER_URL: "http://x" }, { enabled: true, dryRun: false });
  assert.ok(live.ok && !live.settings.dryRun);
  const envLive = resolveExecutor({ HYDRA_UMC_JOB_DISPATCHER_URL: "http://x", HYDRA_UMC_JOB_EXECUTOR_LIVE: "1" }, { enabled: true });
  assert.ok(envLive.ok && !envLive.settings.dryRun);
  const envDry = resolveExecutor({ HYDRA_UMC_JOB_DISPATCHER_URL: "http://x", HYDRA_UMC_JOB_EXECUTOR_LIVE: "0" }, { enabled: true, dryRun: false });
  assert.ok(envDry.ok && envDry.settings.dryRun, "the environment can put a live file back to a dry run");
  const envOff = resolveExecutor({ HYDRA_UMC_JOB_DISPATCHER_URL: "http://x", HYDRA_UMC_JOB_EXECUTOR: "0" }, { enabled: true });
  assert.ok(envOff.ok && !envOff.settings.enabled);
  const fromStopRelay = resolveExecutor({ HYDRA_UMC_JOB_EXECUTOR: "1" }, {}, "http://z:2/");
  assert.ok(fromStopRelay.ok && fromStopRelay.settings.url === "http://z:2");
  const tools = resolveExecutor({ HYDRA_UMC_JOB_DISPATCHER_URL: "http://x" }, { tools: ["PnP"] });
  assert.ok(tools.ok && tools.settings.tools?.[0] === "PnP");
  for (const bad of [{ enabled: "yes" }, { dryRun: 0 }, { pollSeconds: 0 }, { requestTimeoutMs: 5 }, { maxFailureBackoffSeconds: "a" }, { maxRunSeconds: 0 }, { tools: "PnP" }, { tools: [1] }]) {
    assert.ok(!resolveExecutor({ HYDRA_UMC_JOB_DISPATCHER_URL: "http://x" }, bad).ok, JSON.stringify(bad));
  }
  const noAddress = resolveExecutor({ HYDRA_UMC_JOB_EXECUTOR: "1" }, {});
  assert.ok(!noAddress.ok && /no dispatcher address/.test(noAddress.error));
});

test("the list of the dispatcher is read with the Go names or the camelCase ones, and only assigned jobs with a robot count", () => {
  const list = assignedJobs([
    job("a", "arm-1"),
    { id: "b", assignedRobot: "arm-2", attempt: 3, requiredTool: "Laser", status: "assigned" },
    { ID: "c", AssignedRobot: "", Status: "assigned" },
    { ID: "d", AssignedRobot: "arm-1", Status: "pending" },
    { ID: "", AssignedRobot: "arm-1" },
    "text",
    null,
    { ID: "e", AssignedRobot: "arm-1", Attempt: -2 },
  ]);
  assert.deepEqual(list, [
    { id: "a", robot: "arm-1", attempt: 1, tool: "PnP" },
    { id: "b", robot: "arm-2", attempt: 3, tool: "Laser" },
    { id: "e", robot: "arm-1", attempt: 0, tool: "" },
  ]);
  assert.deepEqual(assignedJobs({ not: "a list" }), []);
});

test("a dry run decides and audits once, and moves and completes nothing", async () => {
  const { executor, calls, started, audit } = harness({ extra: { dryRun: true }, jobs: [job("J1", "arm-1")] });
  const first = await executor.pass();
  const second = await executor.pass();
  assert.deepEqual(first.would, ["J1"]);
  assert.deepEqual(second.would, ["J1"]);
  assert.deepEqual(started, []);
  assert.deepEqual(posts(calls), []);
  assert.equal(audit.filter((e) => e.detail.action === "would-start").length, 1, "one audit line, not one per pass");
});

test("a live pass starts the trajectory of the mapped robot, follows it, and reports the end once it finishes by itself", async () => {
  const { executor, calls, started, state, audit } = harness({ jobs: [job("J1", "arm-1", { Attempt: 2 })] });
  const first = await executor.pass();
  assert.deepEqual(first.started, ["J1"]);
  assert.deepEqual(started, [1]);
  assert.deepEqual(posts(calls), []);
  assert.equal(calls[0].url, "http://127.0.0.1:8090/jobs?status=assigned");
  const running = await executor.pass();
  assert.deepEqual([running.started, running.completed], [[], []], "while it plays, nothing is started again and nothing is reported");
  assert.deepEqual(started, [1]);
  state.robots[1] = { ...READY, playing: false, finished: true };
  const done = await executor.pass();
  assert.deepEqual(done.completed, ["J1"]);
  assert.deepEqual(posts(calls).map((c) => c.body), [{ id: "J1", success: true, robotId: "arm-1", attempt: 2 }]);
  assert.equal(posts(calls)[0].url, "http://127.0.0.1:8090/jobs/complete");
  const again = await executor.pass();
  assert.deepEqual([again.started, started], [[], [1]], "the dispatcher may still list the attempt for a moment: it is not started again");
  state.jobs = [];
  await executor.pass();
  assert.deepEqual(audit.map((e) => e.detail.action), ["start", "complete"]);
});

test("nothing is started when something holds it back, and the reason is told", async () => {
  const cases: { name: string; options: Parameters<typeof harness>[0]; reason: RegExp }[] = [
    { name: "unmapped", options: { jobs: [job("J", "arm-9")] }, reason: /not in the robot map/ },
    { name: "tool", options: { jobs: [job("J", "arm-1", { RequiredTool: "Laser" })], extra: { tools: ["PnP"] } }, reason: /tool of the job/ },
    { name: "ambiguous", options: { jobs: [job("J", "arm-1")], settings: { controllers: [{ id: "a", robots: [{ id: 1 }] }, { id: "b", robots: [{ id: 1 }] }] } }, reason: /shared with another robot/ },
    { name: "stopped", options: { jobs: [job("J", "arm-1")], gate: "the server is stopped" }, reason: /stopped/ },
    { name: "missing", options: { jobs: [job("J", "arm-1")], robots: { 1: null } }, reason: /not in this server/ },
    { name: "disabled", options: { jobs: [job("J", "arm-1")], robots: { 1: { ...READY, enabled: false } } }, reason: /disabled/ },
    { name: "reserved", options: { jobs: [job("J", "arm-1")], robots: { 1: { ...READY, reserved: true } } }, reason: /reserved/ },
    { name: "no trajectory", options: { jobs: [job("J", "arm-1")], robots: { 1: { ...READY, hasTrajectory: false } } }, reason: /no recorded trajectory/ },
    { name: "playing", options: { jobs: [job("J", "arm-1")], robots: { 1: { ...READY, playing: true } } }, reason: /already playing/ },
    { name: "start failed", options: { jobs: [job("J", "arm-1")], startOk: false }, reason: /could not be started/ },
  ];
  for (const c of cases) {
    const { executor, started, calls } = harness(c.options);
    const report = await executor.pass();
    assert.equal(report.skipped.length, 1, c.name);
    assert.match(report.skipped[0].reason, c.reason, c.name);
    assert.deepEqual(report.started, [], c.name);
    assert.deepEqual(posts(calls), [], c.name);
    if (c.name !== "start failed") assert.deepEqual(started, [], c.name);
  }
});

test("a robot runs one job of the executor at a time", async () => {
  const { executor, started } = harness({ jobs: [job("J1", "arm-1"), job("J2", "arm-1")] });
  const report = await executor.pass();
  assert.deepEqual(started, [1]);
  assert.deepEqual(report.started, ["J1"]);
  assert.equal(report.skipped[0].jobId, "J2");
});

test("a playback stopped by a person is not reported as done and is not started again", async () => {
  const { executor, calls, started, state, audit } = harness({ jobs: [job("J1", "arm-1")] });
  await executor.pass();
  state.robots[1] = { ...READY, playing: false, finished: false };
  await executor.pass();
  await executor.pass();
  assert.deepEqual(posts(calls), []);
  assert.deepEqual(started, [1], "the same attempt is never started twice");
  assert.ok(audit.some((e) => e.detail.action === "interrupted"));
});

test("a job that left the assigned list stops a robot that still moves for it, but never in a dry run", async () => {
  const { executor, stopped, state } = harness({ jobs: [job("J1", "arm-1")] });
  await executor.pass();
  state.jobs = [];
  const report = await executor.pass();
  assert.deepEqual(stopped, [1]);
  assert.deepEqual(report.stopped, ["J1"]);
  const dry = harness({ extra: { dryRun: true }, jobs: [job("J1", "arm-1")] });
  await dry.executor.pass();
  dry.state.jobs = [];
  await dry.executor.pass();
  assert.deepEqual(dry.stopped, []);
});

test("a run that lasts longer than the limit is stopped and left to the dispatcher, not reported", async () => {
  const { executor, calls, stopped, state } = harness({ jobs: [job("J1", "arm-1")], extra: { maxRunSeconds: 60 } });
  await executor.pass();
  state.now += 30_000;
  await executor.pass();
  assert.deepEqual(stopped, []);
  state.now += 40_000;
  const report = await executor.pass();
  assert.deepEqual(stopped, [1]);
  assert.deepEqual(report.stopped, ["J1"]);
  assert.deepEqual(posts(calls), []);
  await executor.pass();
  assert.deepEqual(stopped, [1], "once");
});

test("a report the dispatcher refuses is not asked again, and one that is lost is tried again", async () => {
  const refused = harness({ jobs: [job("J1", "arm-1")], completeStatus: 409 });
  await refused.executor.pass();
  refused.state.robots[1] = { ...READY, finished: true };
  const answer = await refused.executor.pass();
  assert.match(answer.skipped[0].reason, /answered 409/);
  await refused.executor.pass();
  assert.equal(posts(refused.calls).length, 1);
  const lost = harness({ jobs: [job("J1", "arm-1")], completeThrows: true });
  await lost.executor.pass();
  lost.state.robots[1] = { ...READY, finished: true };
  await lost.executor.pass();
  await lost.executor.pass();
  assert.equal(posts(lost.calls).length, 2, "tried on both passes");
});

test("when the dispatcher cannot be read nothing happens and the pause doubles up to the limit", async () => {
  const { executor, started } = harness({ getThrows: true, jobs: [job("J1", "arm-1")], extra: { pollSeconds: 10, maxFailureBackoffSeconds: 60 } });
  assert.equal(executor.nextDelaySeconds(), 10);
  const report = await executor.pass();
  assert.equal(report.read, false);
  assert.equal(executor.nextDelaySeconds(), 20);
  await executor.pass();
  await executor.pass();
  await executor.pass();
  assert.equal(executor.nextDelaySeconds(), 60);
  assert.deepEqual(started, []);
  const bad = harness({ getStatus: 500 });
  assert.equal((await bad.executor.pass()).read, false);
});

test("the timers start and stop the loop", async () => {
  const { executor, calls } = harness({ jobs: [] });
  const pending: { fn: () => void; ms: number }[] = [];
  const cleared: unknown[] = [];
  executor.start({ set: (fn, ms) => { const handle = { fn, ms }; pending.push(handle); return handle; }, clear: (handle) => cleared.push(handle) });
  assert.equal(pending.length, 1);
  assert.equal(pending[0].ms, 0);
  pending[0].fn();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls.length, 1);
  assert.equal(pending.length, 2);
  assert.equal(pending[1].ms, EXECUTOR_DEFAULTS.pollSeconds * 1000);
  executor.stop();
  assert.equal(cleared.length, 1);
});
