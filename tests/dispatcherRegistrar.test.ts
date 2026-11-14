import assert from "node:assert/strict";
import { test } from "node:test";
import { DispatcherRegistrar, REGISTRAR_DEFAULTS, desiredRobots, knownRobotIds, resolveRegistrar, type RegistrarDeps } from "../src/dispatcherRegistrar";

// The registration of the robots of the roster in the job dispatcher, with a simulated dispatcher and simulated timers: nothing waits or opens a socket.

const BASE = { HYDRA_UMC_JOB_DISPATCHER_URL: "http://127.0.0.1:8090/", HYDRA_UMC_JOB_ROBOT_REGISTRAR: "1" };
const MAP = { "arm-1": 1, "arm-2": 2 };
const roster = (...ids: number[]) => ({ controllers: [{ id: "c1", robots: ids.map((id) => ({ id })) }] });

function settingsOf(extra: Record<string, unknown> = {}, env: Record<string, string> = {}) {
  const resolution = resolveRegistrar({ ...BASE, ...env }, extra);
  assert.ok(resolution.ok, resolution.ok ? "" : resolution.error);
  return resolution.settings;
}

interface Call { method: string; url: string; body?: unknown; auth?: string }

function harness(options: { known?: unknown; getStatus?: number; getThrows?: boolean; postStatus?: number; postThrows?: boolean; settings?: unknown; map?: Record<string, number>; extra?: Record<string, unknown>; env?: Record<string, string> } = {}) {
  const calls: Call[] = [];
  const audit: { type: string; outcome: string; detail: Record<string, unknown> }[] = [];
  const deps: RegistrarDeps = {
    settings: settingsOf(options.extra, options.env),
    getSettings: () => options.settings ?? roster(1, 2),
    robotMap: () => options.map ?? MAP,
    log: () => undefined,
    audit: (event) => audit.push(event),
    fetch: async (url, init) => {
      calls.push({ method: init.method, url, body: init.body ? JSON.parse(init.body) : undefined, auth: init.headers.Authorization });
      if (init.method === "GET") {
        if (options.getThrows) throw new Error("connection refused");
        return { status: options.getStatus ?? 200, json: async () => options.known ?? [] };
      }
      if (options.postThrows) throw new Error("timeout");
      return { status: options.postStatus ?? 200, json: async () => ({}) };
    },
  };
  return { registrar: new DispatcherRegistrar(deps), calls, audit };
}

test("everything is off unless the switch says so, the environment wins over the file, and a wrong value is an error", () => {
  const off = resolveRegistrar({}, {});
  assert.ok(off.ok && !off.settings.enabled);
  assert.equal(off.ok && off.settings.pollSeconds, REGISTRAR_DEFAULTS.pollSeconds);
  const fileOn = resolveRegistrar({ HYDRA_UMC_JOB_DISPATCHER_URL: "http://x" }, { enabled: true });
  assert.ok(fileOn.ok && fileOn.settings.enabled);
  const envOff = resolveRegistrar({ HYDRA_UMC_JOB_DISPATCHER_URL: "http://x", HYDRA_UMC_JOB_ROBOT_REGISTRAR: "0" }, { enabled: true });
  assert.ok(envOff.ok && !envOff.settings.enabled);
  const trimmed = resolveRegistrar({ HYDRA_UMC_JOB_DISPATCHER_URL: "http://x:8090///", HYDRA_UMC_JOB_ROBOT_REGISTRAR: "1" }, {});
  assert.ok(trimmed.ok && trimmed.settings.url === "http://x:8090");
  const fromFile = resolveRegistrar({ HYDRA_UMC_JOB_ROBOT_REGISTRAR: "1" }, { url: "http://y:1" });
  assert.ok(fromFile.ok && fromFile.settings.url === "http://y:1");
  const fromStopRelay = resolveRegistrar({ HYDRA_UMC_JOB_ROBOT_REGISTRAR: "1" }, {}, "http://z:2/");
  assert.ok(fromStopRelay.ok && fromStopRelay.settings.url === "http://z:2");
  for (const bad of [{ enabled: "yes" }, { pollSeconds: 0 }, { requestTimeoutMs: 5 }, { maxFailureBackoffSeconds: "a" }, { registerUnmapped: 1 }]) {
    assert.ok(!resolveRegistrar({ HYDRA_UMC_JOB_DISPATCHER_URL: "http://x" }, bad).ok, JSON.stringify(bad));
  }
  const noAddress = resolveRegistrar({ HYDRA_UMC_JOB_ROBOT_REGISTRAR: "1" }, {});
  assert.ok(!noAddress.ok && /no dispatcher address/.test(noAddress.error));
});

test("the robots to register are those of the roster that have an id in the robot map", () => {
  assert.deepEqual(desiredRobots(roster(1, 2, 3), MAP, false), [{ dispatcherId: "arm-1", robotId: 1 }, { dispatcherId: "arm-2", robotId: 2 }]);
  assert.deepEqual(desiredRobots(roster(1), MAP, false), [{ dispatcherId: "arm-1", robotId: 1 }]);
  // an entry of the map whose robot is not in the roster is not registered
  assert.deepEqual(desiredRobots(roster(), MAP, false), []);
  assert.deepEqual(desiredRobots({}, MAP, true), []);
  assert.deepEqual(desiredRobots(null, MAP, true), []);
});

test("a robot without an entry in the map is registered only when asked, with its id as text", () => {
  assert.deepEqual(desiredRobots(roster(1, 3), MAP, true), [{ dispatcherId: "arm-1", robotId: 1 }, { dispatcherId: "3", robotId: 3 }]);
});

test("a robot id used by more than one robot is never registered", () => {
  const twice = { controllers: [{ id: "c1", robots: [{ id: 1 }, { id: 2 }] }, { id: "c2", robots: [{ id: 1 }] }] };
  assert.deepEqual(desiredRobots(twice, MAP, true), [{ dispatcherId: "arm-2", robotId: 2 }]);
  // a dispatcher id is not asked for twice
  assert.deepEqual(desiredRobots(roster(1, 2), { "same": 1, "same2": 2 }, false).length, 2);
  assert.equal(desiredRobots(roster(1, 1), MAP, false).length, 0);
});

test("the ids of the list of the dispatcher are read from the structure field or from the alias", () => {
  assert.deepEqual([...knownRobotIds([{ ID: "a" }, { id: "b" }, { id: 7 }, null, "x", {}])].sort(), ["a", "b"]);
  assert.equal(knownRobotIds({ ID: "a" }).size, 0);
});

test("a pass registers what the dispatcher does not know and leaves the rest alone", async () => {
  const { registrar, calls, audit } = harness({ known: [{ ID: "arm-1", Tool: "PnP", Available: false }] });
  const report = await registrar.pass();
  assert.deepEqual(report.registered, ["arm-2"]);
  assert.deepEqual(report.known, ["arm-1"]);
  assert.equal(report.read, true);
  const posts = calls.filter((c) => c.method === "POST");
  assert.equal(posts.length, 1);
  assert.deepEqual(posts[0].body, { id: "arm-2", available: true });
  assert.equal(posts[0].url, "http://127.0.0.1:8090/robots");
  assert.equal(audit.length, 1);
  assert.equal(audit[0].outcome, "ok");
});

test("the second pass registers nothing when the dispatcher knows every robot, also under the alias names", async () => {
  const { registrar, calls } = harness({ known: [{ id: "arm-1" }, { id: "arm-2" }] });
  const report = await registrar.pass();
  assert.deepEqual(report.registered, []);
  assert.deepEqual(report.known, ["arm-1", "arm-2"]);
  assert.equal(calls.filter((c) => c.method === "POST").length, 0);
});

test("the token is sent as a bearer when there is one, and the identity of the server otherwise", async () => {
  const withToken = harness({ env: { HYDRA_UMC_JOB_DISPATCHER_TOKEN: "secret-value" } });
  await withToken.registrar.pass();
  assert.ok(withToken.calls.every((c) => c.auth === "Bearer secret-value"));
  const without = harness();
  await without.registrar.pass();
  assert.ok(without.calls.every((c) => c.auth === undefined));
});

test("a robot added to the roster is registered at the next pass, without a restart", async () => {
  let current: unknown = roster(1);
  const known: { ID: string }[] = [];
  const posted: unknown[] = [];
  const registrar = new DispatcherRegistrar({
    settings: settingsOf(),
    getSettings: () => current,
    robotMap: () => MAP,
    log: () => undefined,
    fetch: async (_url, init) => {
      if (init.method === "GET") return { status: 200, json: async () => known };
      const body = JSON.parse(init.body as string) as { id: string };
      posted.push(body);
      known.push({ ID: body.id });
      return { status: 200, json: async () => ({}) };
    },
  });
  assert.deepEqual((await registrar.pass()).registered, ["arm-1"]);
  current = roster(1, 2);
  assert.deepEqual((await registrar.pass()).registered, ["arm-2"]);
  assert.deepEqual((await registrar.pass()).registered, []);
  assert.equal(posted.length, 2);
});

test("a dispatcher that cannot be read or refuses is reported, never thrown, and the pause grows", async () => {
  const unreadable = harness({ getThrows: true });
  assert.equal((await unreadable.registrar.pass()).read, false);
  assert.equal(unreadable.registrar.nextDelaySeconds(), REGISTRAR_DEFAULTS.pollSeconds * 2);
  await unreadable.registrar.pass();
  assert.equal(unreadable.registrar.nextDelaySeconds(), REGISTRAR_DEFAULTS.pollSeconds * 4);
  const wrongStatus = harness({ getStatus: 500 });
  assert.equal((await wrongStatus.registrar.pass()).read, false);
  const notAList = harness({ known: { ID: "a" } });
  assert.equal((await notAList.registrar.pass()).read, false);
  const refused = harness({ postStatus: 422 });
  const report = await refused.registrar.pass();
  assert.deepEqual(report.registered, []);
  assert.equal(report.failed.length, 2);
  assert.equal(refused.audit[0].outcome, "refused");
  const lost = harness({ postThrows: true });
  const lostReport = await lost.registrar.pass();
  assert.equal(lostReport.failed.length, 1, "after a lost request the pass stops");
  assert.ok(lost.registrar.nextDelaySeconds() > REGISTRAR_DEFAULTS.pollSeconds);
});

test("the pause never passes the configured limit and a good pass brings it back", async () => {
  const h = harness({ getThrows: true, extra: { pollSeconds: 10, maxFailureBackoffSeconds: 50 } });
  for (let i = 0; i < 8; i += 1) await h.registrar.pass();
  assert.equal(h.registrar.nextDelaySeconds(), 50);
  const ok = harness({ extra: { pollSeconds: 10 } });
  await ok.registrar.pass();
  assert.equal(ok.registrar.nextDelaySeconds(), 10);
});

test("the loop runs a pass at once, then waits the poll period, and stops when told", async () => {
  const { registrar, calls } = harness({ known: [{ ID: "arm-1" }, { ID: "arm-2" }] });
  const scheduled: { fn: () => void; ms: number }[] = [];
  const cleared: unknown[] = [];
  registrar.start({ set: (fn, ms) => { scheduled.push({ fn, ms }); return scheduled.length; }, clear: (h) => cleared.push(h) });
  registrar.start({ set: () => { throw new Error("started twice"); }, clear: () => undefined });
  assert.equal(scheduled[0].ms, 0);
  scheduled[0].fn();
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls.filter((c) => c.method === "GET").length, 1);
  assert.equal(scheduled[1].ms, REGISTRAR_DEFAULTS.pollSeconds * 1000);
  registrar.stop();
  assert.deepEqual(cleared, [2]);
});
