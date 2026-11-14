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
