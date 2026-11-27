// =============================================================================
// HYDRA-UMC-SERVER - Unit tests for the update of every installed program from Studio (src/fleetUpdate.ts and its routes)
// Copyright (C) 2026 JuanenRac (Electro Hobby 3D) <electrohobby3d@gmail.com>
// GPL-3.0-or-later - see LICENSE
// =============================================================================
// The tool of HYDRA-UMC-OS that does the work is replaced by a double that writes the progress file the way the real one does (and the real one is proved on a simulated
// device in its own repository): evidence is `simulator`. Not proved here: a real run on the CM5 with the real installers and the restart of this server at the end.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { FLEET_SCHEMA, FleetUpdate, FleetUpdateError, fleetSettings, parseFleetReport, withInterruption, type FleetDeps, type ToolRunner } from "../src/fleetUpdate.ts";
import { registerFleetUpdateRoutes } from "../src/routes/fleetUpdateRoutes.ts";

function scratch() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hydra-fleet-"));
  return { dir, done: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

const row = (name: string, patch: Record<string, unknown> = {}) => ({
  name, kind: "svc", repo: `HYDRA-UMC-${name.toUpperCase()}`, installed: "0.1.0", latest: "v0.2.0", action: "update", reason: "", state: "waiting", step: "", substep: "", substeps: 0, detail: "", error: "", order: 0, log: [], ...patch,
});
const file = (state: string, rows: unknown[], extra: Record<string, unknown> = {}) => ({
  schema: FLEET_SCHEMA, id: "1", mode: "plan", state, startedAt: "2030-01-01T00:00:00Z", updatedAt: "2030-01-01T00:00:00Z", error: "", stoppedAt: "", requireSignedTags: false,
  disk: { rootFreeMb: 5000, workspaceFreeMb: 5000 }, services: rows, ...extra,
});

/** A machine: the tool is a double that writes the file for `plan`, and the launcher a double that records what it was asked to start. */
function machine(dir: string, plan = file("planned", [row("datalake"), row("server", { latest: "v1.0.0" }), row("twin", { action: "current" })]), clock = { now: Date.parse("2030-01-01T00:01:00Z") }) {
  const settings = fleetSettings({ tool: "/home/x/fleet_update.py", python: "python3" }, dir);
  const launches: Array<{ file: string; args: string[] }> = [];
  const tool: ToolRunner = async (_file, args) => {
    if (args[1] === "plan") { fs.mkdirSync(path.dirname(settings.stateFile), { recursive: true }); fs.writeFileSync(settings.stateFile, JSON.stringify(plan)); return { exitCode: 0, stdout: "FLEET=PLANNED", stderr: "", timedOut: false }; }
    return { exitCode: 1, stdout: "", stderr: "unexpected", timedOut: false };
  };
  const deps: FleetDeps = {
    settings: () => settings, runnerPrefix: () => [], dataPath: dir, runTool: tool, now: () => clock.now, newId: () => "run1",
    launch: () => ({ file, args }) => { launches.push({ file, args }); },
  };
  return { fleet: new FleetUpdate(deps), settings, launches, clock, write: (value: unknown) => fs.writeFileSync(settings.stateFile, JSON.stringify(value)), beat: (ageSeconds: number) => { const t = (clock.now - ageSeconds * 1000) / 1000; fs.writeFileSync(`${settings.stateFile}.hb`, "x"); fs.utimesSync(`${settings.stateFile}.hb`, t, t); } };
}

test("the settings come from the file with defaults for the rest", () => {
  const s = fleetSettings(undefined, "/data", "/home/u");
  assert.equal(s.tool, path.join("/home/u", "hydra-umc", "HYDRA-UMC-OS", "tools", "fleet_update.py"));
  assert.equal(s.python, "python3");
  assert.equal(s.stateFile, path.resolve("/data", "fleet-update", "state.json"));
  assert.equal(fleetSettings({ tool: "/t.py", python: "py", stateFile: "x/s.json" }, "/data").stateFile, path.resolve("/data", "x/s.json"));
  assert.equal(fleetSettings({ tool: "bad\0" as any }, "/data", "/h").tool, path.join("/h", "hydra-umc", "HYDRA-UMC-OS", "tools", "fleet_update.py"));
});

test("the file is cut down to what Studio shows and anything else is dropped", () => {
  const report = parseFleetReport(file("planned", [row("datalake", { secret: "x", log: [{ at: "t", text: "hello", extra: 1 }] }), { name: "../bad", action: "update", state: "waiting" }, { name: "x", action: "nope", state: "waiting" }, "junk"]));
  assert.ok(report);
  assert.deepEqual(report.services.map((r) => r.name), ["datalake"]);
  assert.equal((report.services[0] as any).secret, undefined);
  assert.deepEqual(report.services[0].log, [{ at: "t", text: "hello" }]);
  assert.equal(parseFleetReport(null), null);
  assert.equal(parseFleetReport({ ...file("planned", []), schema: "other" }), null);
  assert.equal(parseFleetReport({ ...file("exploded", []) }), null);
  assert.equal(parseFleetReport({ ...file("planned", []), services: "no" }), null);
});

test("a run that stopped writing is interrupted, one that is alive is not", () => {
  const running = parseFleetReport(file("running", [row("datalake", { state: "running", step: "installing" }), row("twin", { state: "waiting" })]))!;
  assert.equal(withInterruption(running, 3), running);
  const cut = withInterruption(running, 600);
  assert.equal(cut.state, "interrupted");
  assert.deepEqual(cut.services.map((r) => r.state), ["interrupted", "waiting"]);
  assert.match(cut.services[0].detail, /installing/);
  assert.equal(withInterruption(running, null).state, "interrupted");
  const done = parseFleetReport(file("done", []))!;
  assert.equal(withInterruption(done, 600), done);
});

test("a look runs the tool, returns the plan and refuses while another run goes on", async () => {
  const { dir, done } = scratch();
  try {
    const m = machine(dir);
    assert.equal(m.fleet.read(), null);
    const report = await m.fleet.plan();
    assert.equal(report.state, "planned");
    assert.deepEqual(report.services.map((r) => r.name), ["datalake", "server", "twin"]);
    m.write(file("running", [row("datalake", { state: "running" })], { mode: "run" }));
    m.beat(2);
    await assert.rejects(m.fleet.plan(), (e: unknown) => e instanceof FleetUpdateError && e.status === 409);
    const failing = new FleetUpdate({ ...(m as any).fleet.deps, runTool: async () => ({ exitCode: 1, stdout: "", stderr: "boom\n", timedOut: false }) });
    fs.rmSync(m.settings.stateFile);
    await assert.rejects(failing.plan(), (e: unknown) => e instanceof FleetUpdateError && e.status === 502 && /boom/.test(e.message));
    const slow = new FleetUpdate({ ...(m as any).fleet.deps, runTool: async () => ({ exitCode: 1, stdout: "", stderr: "", timedOut: true }) });
    await assert.rejects(slow.plan(), /too long/);
  } finally { done(); }
});

test("applying starts the tool detached for the programs asked, in the order of the plan, and only those that have an update", async () => {
  const { dir, done } = scratch();
  try {
    const m = machine(dir);
    await assert.rejects(m.fleet.apply(undefined), (e: unknown) => e instanceof FleetUpdateError && e.status === 409);
    await m.fleet.plan();
    const started = await m.fleet.apply(["datalake", "server"]);
    assert.equal(started.state, "running");
    assert.equal(m.launches.length, 1);
    assert.deepEqual(m.launches[0].args, ["/home/x/fleet_update.py", "run", "--state", m.settings.stateFile, "--yes", "--only", "datalake,server"]);
    assert.ok(fs.existsSync(`${m.settings.stateFile}.hb`));
    await assert.rejects(m.fleet.apply(["datalake"]), (e: unknown) => e instanceof FleetUpdateError && e.status === 409);
    m.clock.now += 20_000;
    m.write(file("done", [row("datalake", { state: "done" }), row("twin", { action: "current" })], { mode: "run" }));
    for (const bad of [[], ["../x"], ["datalake;rm"], "datalake", [5], ["unknown"], Array.from({ length: 61 }, (_, i) => `a${i}`)]) {
      await assert.rejects(m.fleet.apply(bad as any), (e: unknown) => e instanceof FleetUpdateError && e.status === 400, JSON.stringify(bad).slice(0, 40));
    }
    await assert.rejects(m.fleet.apply(["twin"]), (e: unknown) => e instanceof FleetUpdateError && e.status === 409);
    m.write(file("planned", [row("datalake"), row("twin", { action: "current" })]));
    const all = await m.fleet.apply(undefined);
    assert.ok(all);
    assert.equal(m.launches.at(-1)!.args.at(-1), "datalake");
  } finally { done(); }
});

test("an old plan is not applied", async () => {
  const { dir, done } = scratch();
  try {
    const m = machine(dir);
    await m.fleet.plan();
    m.clock.now += 31 * 60_000;
    await assert.rejects(m.fleet.apply(undefined), /old/);
  } finally { done(); }
});

test("a program that was cut or failed is taken up alone, from the start", async () => {
  const { dir, done } = scratch();
  try {
    const m = machine(dir);
    await m.fleet.plan();
    await assert.rejects(m.fleet.resume("datalake"), (e: unknown) => e instanceof FleetUpdateError && e.status === 409);
    m.write(file("running", [row("datalake", { state: "running", step: "building" }), row("server")], { mode: "run" }));
    m.beat(300);
    assert.equal(m.fleet.read()!.state, "interrupted");
    assert.equal(m.fleet.busy, false);
    await m.fleet.resume("datalake");
    assert.deepEqual(m.launches[0].args.slice(1, 2), ["resume"]);
    assert.deepEqual(m.launches[0].args.slice(-3), ["--yes", "--only", "datalake"]);
    for (const bad of [undefined, "", "a b", 7, "nothere"]) {
      m.clock.now += 20_000;
      await assert.rejects(m.fleet.resume(bad as any), (e: unknown) => e instanceof FleetUpdateError && (e.status === 400 || e.status === 409), String(bad));
    }
  } finally { done(); }
});

test("the server restarting in the middle of its own update: a new object over the same files reads the run, tells it is going on, then interrupted if it stops, and takes the program up", async () => {
  const { dir, done } = scratch();
  try {
    const m = machine(dir);
    await m.fleet.plan();
    await m.fleet.apply(["datalake", "server"]);
    // the tool writes its progress while it works: datalake done, the server in its installer, a heartbeat that is fresh
    m.write(file("running", [row("datalake", { state: "done", step: "done" }), row("server", { state: "running", step: "installing", detail: "compiling", elapsedS: 120 })], { mode: "run" }));
    m.beat(1);
    assert.equal(m.fleet.read()!.state, "running");
    // the unit of the server is restarted by the installer: the process that asked is gone, a new one starts over the same files and the same clock
    const restarted = new FleetUpdate({ ...(m as any).fleet.deps });
    const seen = restarted.read()!;
    assert.equal(seen.state, "running");
    assert.deepEqual(seen.services.map((r) => [r.name, r.state]), [["datalake", "done"], ["server", "running"]]);
    assert.equal(restarted.busy, true);
    await assert.rejects(restarted.apply(["datalake"]), (e: unknown) => e instanceof FleetUpdateError && e.status === 409);
    // the tool ends well and the new server answers with the final file
    m.write(file("done", [row("datalake", { state: "done", step: "done" }), row("server", { state: "done", step: "done" })], { mode: "run" }));
    assert.equal(restarted.read()!.state, "done");
    assert.equal(restarted.busy, false);
    // another run is cut: the tool died with the unit, the heartbeat stops, and the new server reports it interrupted and lets the program be taken up
    m.write(file("running", [row("server", { state: "running", step: "installing" })], { mode: "run" }));
    m.beat(300);
    const again = new FleetUpdate({ ...(m as any).fleet.deps });
    assert.equal(again.read()!.state, "interrupted");
    assert.equal(again.read()!.services[0].state, "interrupted");
    assert.equal(again.busy, false);
    m.clock.now += 20_000;
    await again.resume("server");
    assert.deepEqual(m.launches.at(-1)!.args.slice(-3), ["--yes", "--only", "server"]);
  } finally { done(); }
});

test("a tool that was started and left no trace is told as not started, with what the process printed, and the update can be asked again", async () => {
  const { dir, done } = scratch();
  try {
    const m = machine(dir);
    const settings = m.settings;
    const prints: string[] = [];
    // a launcher that prints a line of error to the file of the run and never starts the tool (python3 missing, a wrong path of the tool)
    const failing = new FleetUpdate({ ...(m as any).fleet.deps, launch: () => ({ outFile }) => { prints.push(outFile); fs.writeFileSync(outFile, "python3: can't open file\n"); } });
    await failing.plan();
    const started = await failing.apply(["datalake"]);
    assert.equal(started.state, "running");
    m.clock.now += 10_000;
    assert.equal(failing.read()!.state, "planned");
    m.clock.now += 11_000;
    const lost = failing.read()!;
    assert.equal(lost.state, "interrupted");
    assert.equal(lost.error, "interrupted");
    assert.match(lost.stoppedAt, /can't open file/);
    assert.equal(failing.busy, false);
    // it can be asked again, and a tool that does write its file (even before the grace is over) is never told as lost
    const writing = new FleetUpdate({ ...(m as any).fleet.deps, launch: () => ({ outFile }) => { fs.writeFileSync(outFile, ""); fs.writeFileSync(settings.stateFile, JSON.stringify(file("running", [row("datalake", { state: "running" })], { mode: "run" }))); fs.writeFileSync(`${settings.stateFile}.hb`, "y"); } });
    await writing.apply(["datalake"]);
    m.clock.now += 30_000;
    m.beat(1);
    assert.equal(writing.read()!.state, "running");
    assert.equal(writing.busy, true);
    assert.equal(prints.length, 1);
  } finally { done(); }
});

type Handler = (req: any, res: any, next?: any) => Promise<unknown> | unknown;

function routesWith(look: () => boolean, apply: () => boolean, role = "admin") {
  const { dir, done } = scratch();
  const routes: Record<string, Handler[]> = {};
  const app: any = {
    get(p: string, ...h: Handler[]) { routes[`GET ${p}`] = h; },
    post(p: string, ...h: Handler[]) { routes[`POST ${p}`] = h; },
    put() {}, delete() {}, patch() {},
  };
  const events: any[] = [];
  const m = machine(dir);
  registerFleetUpdateRoutes(app, {
    authenticate: ((req: any, _res: any, next: any) => { req.user = { id: "u1", username: "root", role }; return next(); }) as any,
    requireAdmin: ((req: any, res: any, next: any) => (req.user?.role === "admin" ? next() : res.status(403).json({ error: "administrator required" }))) as any,
    lookEnabled: look, applyEnabled: apply, fleet: m.fleet, audit: { record: (event: any) => { events.push(event); return null as any; } },
  });
  const call = async (key: string, req: any) => {
    const res: any = new EventEmitter();
    res.statusCode = 200;
    res.status = (code: number) => { res.statusCode = code; return res; };
    const finished = new Promise<void>((resolve) => { res.json = (payload: unknown) => { res.body = payload; resolve(); return res; }; });
    const chain = routes[key];
    assert.ok(chain, `route ${key} is registered`);
    const run = async (index: number): Promise<unknown> => (index >= chain.length ? undefined : chain[index](req, res, () => run(index + 1)));
    await run(0);
    await Promise.race([finished, new Promise((r) => setTimeout(r, 300))]);
    return res;
  };
  return { call, events, m, done };
}

test("while the switches are off every route answers 404 and nothing runs", async () => {
  const { call, events, m, done } = routesWith(() => false, () => false);
  try {
    for (const key of ["GET /api/admin/fleet-update", "POST /api/admin/fleet-update/plan", "POST /api/admin/fleet-update/apply", "POST /api/admin/fleet-update/resume"]) {
      assert.equal((await call(key, { query: {}, body: { confirm: true, services: ["datalake"], service: "datalake" } })).statusCode, 404, key);
    }
    assert.equal(m.launches.length, 0);
    assert.equal(events.length, 0);
    assert.equal(m.fleet.read(), null);
  } finally { done(); }
});

test("with only the look on, the plan is read and applying stays at 404", async () => {
  const { call, m, done } = routesWith(() => true, () => false);
  try {
    const first = await call("GET /api/admin/fleet-update", { query: {} });
    assert.deepEqual(first.body, { applyEnabled: false, busy: false, report: null });
    const planned = await call("POST /api/admin/fleet-update/plan", { query: {}, body: {} });
    assert.equal(planned.statusCode, 200);
    assert.equal(planned.body.report.services.length, 3);
    assert.equal((await call("POST /api/admin/fleet-update/apply", { query: {}, body: { confirm: true } })).statusCode, 404);
    assert.equal(m.launches.length, 0);
  } finally { done(); }
});

test("a viewer or operator never reaches it", async () => {
  const { call, m, done } = routesWith(() => true, () => true, "operator");
  try {
    for (const key of ["GET /api/admin/fleet-update", "POST /api/admin/fleet-update/plan", "POST /api/admin/fleet-update/apply", "POST /api/admin/fleet-update/resume"]) assert.equal((await call(key, { query: {}, body: { confirm: true } })).statusCode, 403, key);
    assert.equal(m.launches.length, 0);
  } finally { done(); }
});

test("applying and taking up need the confirmation and are audited whether they start or are refused", async () => {
  const { call, events, m, done } = routesWith(() => true, () => true);
  try {
    assert.equal((await call("POST /api/admin/fleet-update/apply", { query: {}, body: { services: ["datalake"] } })).statusCode, 400);
    assert.equal((await call("POST /api/admin/fleet-update/apply", { query: {}, body: [1] })).statusCode, 400);
    const noPlan = await call("POST /api/admin/fleet-update/apply", { query: {}, ip: "10.0.0.2", body: { confirm: true } });
    assert.equal(noPlan.statusCode, 409);
    assert.equal(events.at(-1).type, "fleet-update");
    assert.equal(events.at(-1).outcome, "refused");
    await call("POST /api/admin/fleet-update/plan", { query: {}, body: {} });
    const bad = await call("POST /api/admin/fleet-update/apply", { query: {}, body: { confirm: true, services: ["../etc"] } });
    assert.equal(bad.statusCode, 400);
    const started = await call("POST /api/admin/fleet-update/apply", { query: {}, ip: "10.0.0.2", body: { confirm: true, services: ["datalake"] } });
    assert.equal(started.statusCode, 200);
    assert.equal(started.body.busy, true);
    assert.equal(events.at(-1).outcome, "ok");
    assert.equal(events.at(-1).username, "root");
    assert.equal(m.launches.length, 1);
    const second = await call("POST /api/admin/fleet-update/apply", { query: {}, body: { confirm: true } });
    assert.equal(second.statusCode, 409);
    assert.equal((await call("POST /api/admin/fleet-update/resume", { query: {}, body: { service: "datalake" } })).statusCode, 400);
    assert.equal((await call("POST /api/admin/fleet-update/resume", { query: {}, body: { confirm: true, service: "datalake" } })).statusCode, 409);
  } finally { done(); }
});


// ---- the helper way (fleetUpdate.helper, off by default): the isolated unit of the server starts nothing; a unit of the device does -------------------------------------------

function helperMachine(dir: string, plan = file("planned", [row("datalake"), row("server", { latest: "v1.0.0" })]), answer: { exit: number } | null = { exit: 0 }) {
  const settings = fleetSettings({ helper: true }, dir);
  const clock = { now: Date.parse("2030-01-01T00:01:00Z") };
  const requests: Array<Record<string, unknown>> = [];
  let toolRuns = 0;
  const launches: unknown[] = [];
  const deps: FleetDeps = {
    settings: () => settings, runnerPrefix: () => ["systemd-run"], dataPath: dir, now: () => clock.now, newId: () => "req1",
    runTool: async () => { toolRuns++; return { exitCode: 1, stdout: "", stderr: "must not run", timedOut: false }; },
    launch: () => (job) => { launches.push(job); },
    // The helper unit of the device: it takes the request away, makes the plan and writes the answer.
    sleep: async () => {
      if (!fs.existsSync(settings.requestFile)) return;
      const request = JSON.parse(fs.readFileSync(settings.requestFile, "utf8"));
      requests.push(request);
      fs.rmSync(settings.requestFile);
      if (answer && request.command === "plan") {
        fs.writeFileSync(settings.stateFile, JSON.stringify(plan));
        fs.writeFileSync(settings.answerFile, JSON.stringify({ id: request.id, command: "plan", exit: answer.exit }));
      }
    },
  };
  return { fleet: new FleetUpdate(deps), settings, requests, clock, launches, toolRuns: () => toolRuns };
}

test("the helper way is off unless the file says true, and its files sit beside the progress file", () => {
  for (const value of [undefined, false, "true", 1, null]) assert.equal(fleetSettings({ helper: value }, "/data").helper, false);
  const on = fleetSettings({ helper: true }, "/data");
  assert.equal(on.helper, true);
  assert.equal(on.requestFile, path.join(path.dirname(on.stateFile), "request.json"));
  assert.equal(on.answerFile, `${on.stateFile}.done`);
});

test("with the helper a look writes one request, waits for the answer and starts no process", async () => {
  const { dir, done } = scratch();
  try {
    const m = helperMachine(dir);
    const report = await m.fleet.plan();
    assert.equal(report.services.length, 2);
    assert.deepEqual(m.requests, [{ v: 1, id: "req1", command: "plan", names: [] }]);
    assert.equal(m.toolRuns(), 0);
    assert.equal(m.launches.length, 0);
    assert.equal(fs.existsSync(m.settings.requestFile), false);
  } finally { done(); }
});

test("with the helper a look that gets no answer is a 502 and the request is taken back so that it cannot run later", async () => {
  const { dir, done } = scratch();
  try {
    const silent = helperMachine(dir, undefined, null);
    await assert.rejects(silent.fleet.plan(), (e: unknown) => e instanceof FleetUpdateError && e.status === 502);
    assert.equal(fs.existsSync(silent.settings.requestFile), false);
    const failed = helperMachine(dir, undefined, { exit: 2 });
    await assert.rejects(failed.fleet.plan(), (e: unknown) => e instanceof FleetUpdateError && e.status === 502);
  } finally { done(); }
});

test("with the helper applying writes a request with the names of the plan, launches nothing and a second ask waits", async () => {
  const { dir, done } = scratch();
  try {
    const m = helperMachine(dir);
    await m.fleet.plan();
    const started = await m.fleet.apply(["datalake"]);
    assert.equal(started.state, "running");
    assert.deepEqual(JSON.parse(fs.readFileSync(m.settings.requestFile, "utf8")), { v: 1, id: "req1", command: "run", names: ["datalake"] });
    assert.equal(m.launches.length, 0);
    assert.equal(m.toolRuns(), 0);
    if (process.platform !== "win32") {
      assert.equal(fs.statSync(m.settings.requestFile).mode & 0o007, 0);
      assert.equal(fs.statSync(`${m.settings.stateFile}.hb`).mode & 0o007, 0);
    }
    await assert.rejects(m.fleet.apply(["datalake"]), (e: unknown) => e instanceof FleetUpdateError && e.status === 409);
  } finally { done(); }
});

test("with the helper taking up a program writes a resume request", async () => {
  const { dir, done } = scratch();
  try {
    const m = helperMachine(dir, file("interrupted", [row("datalake", { state: "interrupted" })]));
    await m.fleet.plan();
    m.clock.now += 60_000;
    fs.writeFileSync(`${m.settings.stateFile}.hb`, "x");
    await m.fleet.resume("datalake");
    assert.deepEqual(JSON.parse(fs.readFileSync(m.settings.requestFile, "utf8")), { v: 1, id: "req1", command: "resume", names: ["datalake"] });
    assert.equal(m.launches.length, 0);
  } finally { done(); }
});

test("with the helper a request nobody took for two minutes is removed and does not hold the next ask", async () => {
  const { dir, done } = scratch();
  try {
    const m = helperMachine(dir);
    await m.fleet.plan();
    await m.fleet.apply(["datalake"]);
    assert.equal(m.fleet.busy, true);
    const old = new Date(m.clock.now - 3 * 60_000);
    fs.utimesSync(m.settings.requestFile, old, old);
    m.clock.now += 3 * 60_000;
    assert.equal(m.fleet.busy, false);
    assert.equal(fs.existsSync(m.settings.requestFile), false);
  } finally { done(); }
});

test("the root helper needs the identifier of the look and the one-time code, which go into the request and nowhere else", async () => {
  const { dir, done } = scratch();
  try {
    const plan = { ...file("planned", [row("datalake", { previous: "v0.9.0" })]), helper: "root", planId: "a".repeat(32), totpRequired: true };
    const m = helperMachine(dir, plan);
    const seen = await m.fleet.plan();
    assert.deepEqual([seen.helper, seen.planId, seen.totpRequired, seen.services[0].previous], ["root", "a".repeat(32), true, "v0.9.0"]);
    await assert.rejects(m.fleet.apply(["datalake"]), (e: unknown) => e instanceof FleetUpdateError && e.status === 400);
    await assert.rejects(m.fleet.apply(["datalake"], { code: "12345" }), (e: unknown) => e instanceof FleetUpdateError && e.status === 400);
    await m.fleet.apply(["datalake"], { code: "123456" });
    assert.deepEqual(JSON.parse(fs.readFileSync(m.settings.requestFile, "utf8")), { v: 1, id: "req1", command: "run", names: ["datalake"], planId: "a".repeat(32), code: "123456" });
  } finally { done(); }
});

test("going back is only for the root helper and for a program that keeps an earlier version", async () => {
  const { dir, done } = scratch();
  try {
    const plain = helperMachine(dir);
    await plain.fleet.plan();
    await assert.rejects(plain.fleet.rollback("datalake", { code: "123456" }), (e: unknown) => e instanceof FleetUpdateError && e.status === 409);
    const m = helperMachine(dir, { ...file("planned", [row("datalake", { previous: "v0.9.0" })]), helper: "root", planId: "b".repeat(32), totpRequired: true });
    await m.fleet.plan();
    await m.fleet.rollback("datalake", { code: "654321" });
    assert.deepEqual(JSON.parse(fs.readFileSync(m.settings.requestFile, "utf8")), { v: 1, id: "req1", command: "rollback", names: ["datalake"], planId: "b".repeat(32), code: "654321" });
  } finally { done(); }
});

// The unit of the server and the default of the way to the tool have to agree: this test pins the facts that make the direct way impossible under the isolated unit
// and the helper way possible, so that a change of either file shows up here.
test("the isolated unit of the server and the settings agree on the account, the folder and the way the work is reached", () => {
  const unit = fs.readFileSync(new URL("../systemd/hydra-umc-server.service", import.meta.url), "utf8");
  const get = (key: string) => (unit.match(new RegExp(`^${key}=(.*)$`, "m")) ?? [])[1]?.trim();
  const writable = (get("ReadWritePaths") ?? "").split(/\s+/).filter(Boolean);
  assert.equal(get("User"), "hydra-umc-server");
  assert.equal(get("Group"), "hydra-umc-server");
  assert.equal(get("NoNewPrivileges"), "true");
  assert.equal(get("CapabilityBoundingSet"), "");
  assert.equal(get("ProtectHome"), "true");
  assert.equal(get("UMask"), "0027");
  assert.deepEqual(writable, ["/opt/hydra-umc/server/data"]);
  assert.equal(get("WorkingDirectory"), "/opt/hydra-umc/server");
  // The data folder is the only one the account can write and its HOME: every file of the helper way has to be inside it.
  const data = path.posix.join(...writable);
  const s = fleetSettings({ helper: true }, data, data);
  for (const name of [s.stateFile, s.requestFile, s.answerFile, `${s.stateFile}.hb`]) assert.ok(path.resolve(name).startsWith(path.resolve(data)), name);
  // The direct way looks for the tool under the HOME of that account, where nothing is installed (and /home is hidden): only the helper way can work under this unit.
  assert.ok(path.resolve(fleetSettings(undefined, data, data).tool).startsWith(path.resolve(data)));
  // The helper unit of HYDRA-UMC-OS (when its checkout is next to this one) uses exactly these files and the group of this unit, and may call sudo.
  const sibling = new URL("../../HYDRA-UMC-OS/systemd/hydra-umc-fleet.service", import.meta.url);
  if (!fs.existsSync(sibling)) return;
  const helper = fs.readFileSync(sibling, "utf8");
  const exec = (helper.match(/^ExecStart=(.*)$/m) ?? [])[1] ?? "";
  assert.ok(exec.includes(`--state ${data}/fleet-update/state.json`), exec);
  assert.ok(exec.includes(`--request ${data}/fleet-update/request.json`), exec);
  assert.match(helper, /^Group=hydra-umc-server$/m);
  assert.doesNotMatch(helper, /^NoNewPrivileges=true$/m);
});
