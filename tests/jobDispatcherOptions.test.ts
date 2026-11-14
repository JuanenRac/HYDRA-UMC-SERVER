import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { SecurityConfig, SecurityConfigError, type SecurityFile } from "../src/securityConfig.ts";
import { DispatcherConfigError, readReplanOptions, writeReplanOptions } from "../src/dispatcherConfigFile.ts";

// The options of the job dispatcher in Server Admin: the switch and the robot map of the delivery of its stop requests, and the two options of its replanning,
// which this server writes into the configuration file that the dispatcher reads when it starts.

function temp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "jd-options-"));
}

function makeConfig(env: any = {}, initial: SecurityFile = {}, extra: { jobStopRelayActive?: boolean; jobExecutorActive?: boolean; jobExecutorLiveActive?: boolean } = {}) {
  let stored: SecurityFile = { ...initial };
  const logs: string[] = [];
  const config = new SecurityConfig({ env, load: () => ({ ...stored }), save: (file) => { stored = { ...file }; }, tlsActive: false, log: (m) => logs.push(m), ...extra });
  return { config, logs, stored: () => stored };
}

const refused = (action: () => unknown, status: number, text?: RegExp) =>
  assert.throws(action, (error: unknown) => error instanceof SecurityConfigError && error.status === status && (text ? text.test(error.message) : true));

test("the delivery of the stop requests is off by default, and only the exact word 1 in the environment switches it on and locks it", () => {
  const off = makeConfig().config.snapshot().jobDispatcher;
  assert.deepEqual(off.stopRelay.enabled, { value: false, source: "default" });
  assert.deepEqual(off.stopRelay.robotMap, {});
  for (const word of ["true", "yes", "0", ""]) assert.equal(makeConfig({ jobStopRelay: word }).config.snapshot().jobDispatcher.stopRelay.enabled.value, false, word);
  const locked = makeConfig({ jobStopRelay: "1" });
  assert.deepEqual(locked.config.snapshot().jobDispatcher.stopRelay.enabled, { value: true, source: "env" });
  refused(() => locked.config.update({ jobDispatcher: { stopRelay: { enabled: false } } }, "root"), 409, /HYDRA_UMC_JOB_STOP_RELAY/);
});

test("an administrator switches the delivery on and edits the robot map; it is saved, logged, warned about and applies on the next start", () => {
  const { config, logs, stored } = makeConfig({}, { jobDispatcher: { stopRelay: { pollSeconds: 5, url: "http://127.0.0.1:8090" } as any } }, { jobStopRelayActive: false });
  const result = config.update({ jobDispatcher: { stopRelay: { enabled: true, robotMap: { "arm-1": 1, "arm-2": 2 } } } }, "root");
  assert.deepEqual(result.snapshot.jobDispatcher.stopRelay.enabled, { value: true, source: "config" });
  assert.deepEqual(result.snapshot.jobDispatcher.stopRelay.robotMap, { "arm-1": 1, "arm-2": 2 });
  assert.equal(result.snapshot.jobDispatcher.stopRelay.appliesOnRestart, true);
  assert.equal(result.appliesOnRestart, true);
  assert.ok(result.warnings.includes("job_stop_relay_on"));
  // the keys of the section that this screen does not edit are kept
  assert.equal((stored().jobDispatcher?.stopRelay as any).pollSeconds, 5);
  assert.equal((stored().jobDispatcher?.stopRelay as any).url, "http://127.0.0.1:8090");
  assert.ok(logs.some((line) => line.includes("root") && line.includes("2 robot(s) mapped")));
  // the map alone changes without touching the switch, and is read live by the relay
  config.update({ jobDispatcher: { stopRelay: { robotMap: { "arm-3": 3 } } } }, "root");
  assert.deepEqual(config.jobStopRobotMap(), { "arm-3": 3 });
  assert.equal(stored().jobDispatcher?.stopRelay?.enabled, true);
});

test("the switch is not pending a restart when the relay already runs as asked", () => {
  const { config } = makeConfig({}, { jobDispatcher: { stopRelay: { enabled: true } } }, { jobStopRelayActive: true });
  assert.equal(config.snapshot().jobDispatcher.stopRelay.appliesOnRestart, false);
});

test("a robot map with a wrong id, a wrong target or too many entries is refused and nothing is saved", () => {
  const { config, stored } = makeConfig();
  for (const bad of [
    { "": 1 }, { "bad id": 1 }, { ["x".repeat(65)]: 1 }, { "arm-1": -1 }, { "arm-1": 1.5 }, { "arm-1": "1" }, { "arm-1": null },
  ]) refused(() => config.update({ jobDispatcher: { stopRelay: { robotMap: bad } } }, "root"), 400);
  refused(() => config.update({ jobDispatcher: { stopRelay: { robotMap: [] } } }, "root"), 400, /object/);
  refused(() => config.update({ jobDispatcher: { stopRelay: { robotMap: Object.fromEntries(Array.from({ length: 1001 }, (_, i) => [`r${i}`, i])) } } }, "root"), 400, /at most 1000/);
  refused(() => config.update({ jobDispatcher: { stopRelay: { enabled: "yes" } } }, "root"), 400);
  refused(() => config.update({ jobDispatcher: { stopRelay: { url: "http://evil" } } }, "root"), 400, /cannot be changed here/);
  refused(() => config.update({ jobDispatcher: { configFile: "/etc/passwd" } }, "root"), 400, /cannot be changed here/);
  assert.equal(stored().jobDispatcher, undefined);
});

test("the replanning options cannot be changed when the deployment did not name the file of the dispatcher", () => {
  const { config, stored } = makeConfig();
  assert.equal(config.snapshot().jobDispatcher.replan.editable, false);
  refused(() => config.update({ jobDispatcher: { replan: { allowUnconfirmed: true } } }, "root"), 409, /not set on this server/);
  assert.equal(stored().jobDispatcher, undefined);
});

test("the replanning options are written into the file of the dispatcher, atomically, keeping every other key", () => {
  const dir = temp();
  const file = path.join(dir, "dispatcher.json");
  fs.writeFileSync(file, JSON.stringify({ location_costs: { enabled: true }, replan: { enabled: true, on_stale: true, stop_ack_timeout_seconds: 45 } }));
  const { config, logs, stored } = makeConfig({ jobDispatcherConfig: file });
  const before = config.snapshot().jobDispatcher.replan;
  assert.deepEqual([before.allowUnconfirmed.value, before.stopAckTimeoutSeconds.value, before.editable], [false, 45, true]);
  const result = config.update({ jobDispatcher: { replan: { allowUnconfirmed: true } } }, "root");
  const written = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.deepEqual(written.replan, { enabled: true, on_stale: true, stop_ack_timeout_seconds: 45, allow_unconfirmed: true });
  assert.deepEqual(written.location_costs, { enabled: true });
  assert.deepEqual(fs.readdirSync(dir), ["dispatcher.json"], "no temporary file is left behind");
  assert.deepEqual([result.snapshot.jobDispatcher.replan.allowUnconfirmed.value, result.snapshot.jobDispatcher.replan.appliesOnDispatcherRestart], [true, true]);
  assert.ok(result.warnings.includes("replan_unconfirmed_allowed"));
  assert.deepEqual(stored().jobDispatcher?.replan, { allowUnconfirmed: true, stopAckTimeoutSeconds: 45 });
  assert.ok(logs.some((line) => line.includes("ALLOWED")));
  config.update({ jobDispatcher: { replan: { stopAckTimeoutSeconds: 90, allowUnconfirmed: false } } }, "root");
  assert.deepEqual(readReplanOptions(file), { allowUnconfirmed: false, stopAckTimeoutSeconds: 90 });
});

test("a file that does not exist is created with only the replan section; a file that is not valid JSON is never overwritten", () => {
  const dir = temp();
  const fresh = path.join(dir, "new", "dispatcher.json");
  writeReplanOptions(fresh, { allowUnconfirmed: false, stopAckTimeoutSeconds: 30 });
  assert.deepEqual(JSON.parse(fs.readFileSync(fresh, "utf8")), { replan: { allow_unconfirmed: false, stop_ack_timeout_seconds: 30 } });
  const broken = path.join(dir, "broken.json");
  fs.writeFileSync(broken, "{ not json");
  const { config, stored } = makeConfig({ jobDispatcherConfig: broken });
  refused(() => config.update({ jobDispatcher: { replan: { allowUnconfirmed: true } } }, "root"), 409, /not valid JSON/);
  assert.equal(fs.readFileSync(broken, "utf8"), "{ not json");
  assert.equal(stored().jobDispatcher, undefined);
  const list = path.join(dir, "list.json");
  fs.writeFileSync(list, "[1]");
  assert.throws(() => writeReplanOptions(list, { allowUnconfirmed: true, stopAckTimeoutSeconds: 30 }), DispatcherConfigError);
  assert.equal(fs.readFileSync(list, "utf8"), "[1]");
});

test("the timeout is validated with the range of the dispatcher and a refusal changes neither the file nor the settings", () => {
  const dir = temp();
  const file = path.join(dir, "dispatcher.json");
  fs.writeFileSync(file, "{}");
  const { config, stored } = makeConfig({ jobDispatcherConfig: file });
  for (const bad of [0, -1, 86401, "30", NaN, null]) refused(() => config.update({ jobDispatcher: { replan: { stopAckTimeoutSeconds: bad } } }, "root"), 400, /greater than 0/);
  refused(() => config.update({ jobDispatcher: { replan: { allowUnconfirmed: "yes" } } }, "root"), 400);
  refused(() => config.update({ jobDispatcher: { replan: { enabled: true } } }, "root"), 400, /cannot be changed here/);
  assert.equal(fs.readFileSync(file, "utf8"), "{}");
  assert.equal(stored().jobDispatcher, undefined);
  config.update({ jobDispatcher: { replan: { stopAckTimeoutSeconds: 86400 } } }, "root");
  config.update({ jobDispatcher: { replan: { stopAckTimeoutSeconds: 0.5 } } }, "root");
  assert.equal(readReplanOptions(file).stopAckTimeoutSeconds, 0.5);
});

test("a write that fails (the directory is a file) is refused with nothing saved", () => {
  const dir = temp();
  const blocker = path.join(dir, "blocker");
  fs.writeFileSync(blocker, "x");
  const { config, stored } = makeConfig({ jobDispatcherConfig: path.join(blocker, "dispatcher.json") });
  refused(() => config.update({ jobDispatcher: { replan: { allowUnconfirmed: true } } }, "root"), 409);
  assert.equal(stored().jobDispatcher, undefined);
});

test("the admin route carries the options, writes the file, answers the warnings and records every change in the audit record", async () => {
  const { registerAdminRoutes } = await import("../src/routes/adminRoutes.ts");
  const handlers: Record<string, any> = {};
  const app: any = {};
  for (const method of ["get", "put", "post", "delete"]) app[method] = (route: string, ...chain: any[]) => { handlers[`${method.toUpperCase()} ${route}`] = chain[chain.length - 1]; };
  const dir = temp();
  const file = path.join(dir, "dispatcher.json");
  let saved: any = {};
  const security = new SecurityConfig({ env: { jobDispatcherConfig: file }, load: () => ({ ...saved }), save: (f) => { saved = { ...saved, ...f }; }, tlsActive: false });
  const events: any[] = [];
  registerAdminRoutes(app, {
    authenticate: () => undefined, requireAdmin: () => undefined, asyncHandler: (h: any) => h, industrialLog: () => undefined,
    wsClients: new Set(), logFile: "x.log", getCurrentPort: () => 3000, loadServerConfig: () => ({ ...saved }), saveServerConfig: (c: any) => { saved = c; }, security,
    audit: { record: (event: any) => { events.push(event); return null; } },
  } as any);
  const call = (key: string, body: any) => {
    let status = 200; let payload: any;
    const res: any = { status(code: number) { status = code; return res; }, json(value: any) { payload = value; return res; } };
    handlers[key]({ body, user: { id: "u1", username: "root" }, ip: "127.0.0.1" }, res);
    return { status, payload };
  };
  const ok = call("PUT /api/admin/server-config", { jobDispatcher: { stopRelay: { enabled: true, robotMap: { "arm-1": 1 } }, replan: { allowUnconfirmed: true, stopAckTimeoutSeconds: 60 } } });
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.payload.warnings.sort(), ["job_stop_relay_on", "replan_unconfirmed_allowed"]);
  assert.deepEqual(ok.payload.jobDispatcher.stopRelay.robotMap, { "arm-1": 1 });
  assert.deepEqual(readReplanOptions(file), { allowUnconfirmed: true, stopAckTimeoutSeconds: 60 });
  assert.equal(call("GET /api/admin/server-config", undefined).payload.jobDispatcher.replan.stopAckTimeoutSeconds.value, 60);
  assert.deepEqual(events.map((e) => [e.type, e.outcome, e.username]), [["job-dispatcher-options", "ok", "root"]]);
  assert.deepEqual(events[0].detail, { stopRelayEnabled: true, robotsMapped: 1, allowUnconfirmed: true, stopAckTimeoutSeconds: 60 });
  const bad = call("PUT /api/admin/server-config", { jobDispatcher: { replan: { stopAckTimeoutSeconds: 0 } } });
  assert.equal(bad.status, 400);
  assert.deepEqual(events.map((e) => e.outcome), ["ok", "refused"]);
  assert.deepEqual(readReplanOptions(file), { allowUnconfirmed: true, stopAckTimeoutSeconds: 60 });
});

test("the execution of the assigned jobs is off and a dry run by default, and only the exact word 1 in the environment switches either on and locks it", () => {
  const off = makeConfig().config.snapshot().jobDispatcher.executor;
  assert.deepEqual(off.enabled, { value: false, source: "default" });
  assert.deepEqual(off.live, { value: false, source: "default" });
  assert.equal(off.appliesOnRestart, false);
  for (const word of ["true", "yes", "0", ""]) {
    const view = makeConfig({ jobExecutor: word, jobExecutorLive: word }).config.snapshot().jobDispatcher.executor;
    assert.equal(view.enabled.value, false, word);
    assert.equal(view.live.value, false, word);
  }
  const locked = makeConfig({ jobExecutor: "1", jobExecutorLive: "1" });
  assert.deepEqual(locked.config.snapshot().jobDispatcher.executor.enabled, { value: true, source: "env" });
  assert.deepEqual(locked.config.snapshot().jobDispatcher.executor.live, { value: true, source: "env" });
  refused(() => locked.config.update({ jobDispatcher: { executor: { enabled: false } } }, "root"), 409, /HYDRA_UMC_JOB_EXECUTOR/);
  refused(() => locked.config.update({ jobDispatcher: { executor: { live: false } } }, "root"), 409, /HYDRA_UMC_JOB_EXECUTOR_LIVE/);
});

test("an administrator switches the executor on as a dry run, then live, and the other keys of its section are kept", () => {
  const { config, logs, stored } = makeConfig({}, { jobDispatcher: { executor: { pollSeconds: 7, tools: ["PnP"] } as any } }, { jobExecutorActive: false });
  const on = config.update({ jobDispatcher: { executor: { enabled: true } } }, "root");
  assert.deepEqual(on.snapshot.jobDispatcher.executor.enabled, { value: true, source: "config" });
  assert.deepEqual(on.snapshot.jobDispatcher.executor.live, { value: false, source: "default" }, "on is a dry run");
  assert.equal(on.snapshot.jobDispatcher.executor.appliesOnRestart, true);
  assert.ok(on.warnings.includes("job_executor_on"));
  assert.ok(!on.warnings.includes("job_executor_live"));
  assert.equal(stored().jobDispatcher?.executor?.enabled, true);
  assert.equal(stored().jobDispatcher?.executor?.dryRun, undefined);
  assert.equal((stored().jobDispatcher?.executor as any).pollSeconds, 7);
  assert.deepEqual((stored().jobDispatcher?.executor as any).tools, ["PnP"]);
  const live = config.update({ jobDispatcher: { executor: { live: true } } }, "root");
  assert.deepEqual(live.snapshot.jobDispatcher.executor.live, { value: true, source: "config" });
  assert.ok(live.warnings.includes("job_executor_live"));
  assert.equal(stored().jobDispatcher?.executor?.dryRun, false);
  assert.ok(logs.some((line) => /ON and LIVE/.test(line)));
  const back = config.update({ jobDispatcher: { executor: { live: false } } }, "root");
  assert.deepEqual(back.snapshot.jobDispatcher.executor.live, { value: false, source: "config" });
  assert.equal(stored().jobDispatcher?.executor?.dryRun, true);
  assert.ok(logs.some((line) => /on as a dry run/.test(line)));
});

test("the executor applies on the next start: nothing to restart once it runs the way the switches say", () => {
  const same = makeConfig({}, { jobDispatcher: { executor: { enabled: true, dryRun: false } } }, { jobExecutorActive: true, jobExecutorLiveActive: true });
  assert.equal(same.config.snapshot().jobDispatcher.executor.appliesOnRestart, false);
  const liveChanged = makeConfig({}, { jobDispatcher: { executor: { enabled: true, dryRun: false } } }, { jobExecutorActive: true, jobExecutorLiveActive: false });
  assert.equal(liveChanged.config.snapshot().jobDispatcher.executor.appliesOnRestart, true);
  const offAndLiveDiffers = makeConfig({}, { jobDispatcher: { executor: { dryRun: false } } }, { jobExecutorActive: false, jobExecutorLiveActive: false });
  assert.equal(offAndLiveDiffers.config.snapshot().jobDispatcher.executor.appliesOnRestart, false, "while it is off the live switch changes nothing");
});

test("the executor options are checked: a wrong type or an unknown key is refused", () => {
  const { config } = makeConfig();
  refused(() => config.update({ jobDispatcher: { executor: { enabled: "yes" } } } as any, "root"), 400);
  refused(() => config.update({ jobDispatcher: { executor: { live: 1 } } } as any, "root"), 400);
  refused(() => config.update({ jobDispatcher: { executor: { pollSeconds: 1 } } } as any, "root"), 400, /cannot be changed here/);
  refused(() => config.update({ jobDispatcher: { executor: [] } } as any, "root"), 400, /object/);
});
