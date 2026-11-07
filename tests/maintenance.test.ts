// =============================================================================
// HYDRA-UMC-SERVER - Unit tests for the maintenance routes and the settings file of DETECTION-HEF
// Copyright (C) 2026 JuanenRac (Electro Hobby 3D) <electrohobby3d@gmail.com>
// GPL-3.0-or-later - see LICENSE
// =============================================================================
// /api/admin/maintenance wraps the deploy tool of the operating system image: off by default, no shell, a package is named and must be a
// file inside one folder, every change needs a confirmation and is audited. The detectionHef block writes the file that service re-reads.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import {
  Maintenance, MaintenanceError, buildCommand, maintenanceSettings, parseToolOutput, resolvePackage, validComponentName, validPackageName,
  type MaintenanceCommand, type RunResult, type Runner,
} from "../src/maintenance.ts";
import { registerMaintenanceRoutes } from "../src/routes/maintenanceRoutes.ts";
import { DETECTION_HEF_SETTINGS_NAME, detectionHefSettingsPath, detectionHefSettingsText, writeDetectionHefSettings } from "../src/detectionHefSettings.ts";
import { SecurityConfig, SecurityConfigError, resolveDetectionHefReports, resolveMaintenance, type SecurityFile } from "../src/securityConfig.ts";

function scratch() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hydra-maint-"));
  return { dir, done: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

function settingsIn(dir: string) {
  fs.mkdirSync(path.join(dir, "packages"), { recursive: true });
  return maintenanceSettings({ root: "/opt/test", python: "python3", timeoutSeconds: 20 }, dir);
}

test("component and package names are plain names", () => {
  for (const good of ["server", "hydra-umc-os", "a.b_c-1", "A"]) assert.equal(validComponentName(good), true, good);
  for (const bad of ["", "-x", ".x", "a/b", "a\\b", "a b", "a..b", "x".repeat(65), 5, null, undefined, ["a"], "a;rm"]) assert.equal(validComponentName(bad as any), false, String(bad));
  for (const good of ["release-1.2.3.tgz", "p"]) assert.equal(validPackageName(good), true, good);
  for (const bad of ["../x.tgz", "dir/x.tgz", "/etc/passwd", "x".repeat(129), ".hidden", "-rf", "a..b", 7]) assert.equal(validPackageName(bad as any), false, String(bad));
});

test("the settings come from the file within their limits, with defaults for the rest", () => {
  const s = maintenanceSettings(undefined, "/data");
  assert.equal(s.root, "/opt/hydra-umc");
  assert.equal(s.python, "python3");
  assert.equal(s.timeoutSeconds, 300);
  assert.equal(s.tool, path.join("/opt/hydra-umc", "tools/deploy_release.py"));
  assert.equal(s.packagesDir, path.resolve("/data", "packages"));
  assert.equal(maintenanceSettings({ timeoutSeconds: 1 }, "/d").timeoutSeconds, 10);
  assert.equal(maintenanceSettings({ timeoutSeconds: 1e9 }, "/d").timeoutSeconds, 1800);
  assert.equal(maintenanceSettings({ timeoutSeconds: "no" as any }, "/d").timeoutSeconds, 300);
  assert.equal(maintenanceSettings({ root: "/srv/h", tool: "/usr/bin/tool.py" }, "/d").tool, "/usr/bin/tool.py");
  assert.equal(maintenanceSettings({ root: "bad\0path" }, "/d").root, "/opt/hydra-umc");
});

test("a package is a regular file directly inside the packages folder", () => {
  const { dir, done } = scratch();
  try {
    const s = settingsIn(dir);
    fs.writeFileSync(path.join(s.packagesDir, "good.tgz"), "x");
    fs.mkdirSync(path.join(s.packagesDir, "folder.tgz"));
    fs.writeFileSync(path.join(dir, "outside.tgz"), "x");
    assert.equal(resolvePackage(s, "good.tgz"), fs.realpathSync(path.join(s.packagesDir, "good.tgz")));
    assert.throws(() => resolvePackage(s, "../outside.tgz"), (e: unknown) => e instanceof MaintenanceError && e.status === 400);
    assert.throws(() => resolvePackage(s, "missing.tgz"), (e: unknown) => e instanceof MaintenanceError && e.status === 404);
    assert.throws(() => resolvePackage(s, "folder.tgz"), (e: unknown) => e instanceof MaintenanceError && e.status === 400);
    assert.throws(() => resolvePackage(s, 5), (e: unknown) => e instanceof MaintenanceError && e.status === 400);
    // a link that points outside the folder is refused (skipped where links cannot be made)
    try {
      fs.symlinkSync(path.join(dir, "outside.tgz"), path.join(s.packagesDir, "link.tgz"));
      assert.throws(() => resolvePackage(s, "link.tgz"), (e: unknown) => e instanceof MaintenanceError && e.status === 400);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EPERM" && !(error instanceof MaintenanceError)) throw error;
    }
    assert.throws(() => resolvePackage({ ...s, packagesDir: path.join(dir, "nowhere") }, "good.tgz"), (e: unknown) => e instanceof MaintenanceError && e.status === 404);
  } finally {
    done();
  }
});

test("each action builds an argument list for the tool and nothing else", () => {
  const { dir, done } = scratch();
  try {
    const s = settingsIn(dir);
    fs.writeFileSync(path.join(s.packagesDir, "p.tgz"), "x");
    const head = [s.tool, "--root", s.root];
    assert.deepEqual(buildCommand("status", {}, s), { file: "python3", args: [...head, "status"] });
    assert.deepEqual(buildCommand("status", { component: "server" }, s).args.slice(-2), ["status", "server"]);
    assert.deepEqual(buildCommand("rollback", { component: "server" }, s).args.slice(-2), ["rollback", "server"]);
    assert.deepEqual(buildCommand("prune", { component: "server" }, s).args.slice(-2), ["prune", "server"]);
    assert.deepEqual(buildCommand("prune", { component: "server", keep: 4 }, s).args.slice(-4), ["prune", "server", "--keep", "4"]);
    const install = buildCommand("install", { package: "p.tgz" }, s);
    assert.equal(install.args[3], "install");
    assert.equal(install.args.includes("--allow-downgrade"), false);
    assert.equal(buildCommand("install", { package: "p.tgz", allowDowngrade: true }, s).args.at(-1), "--allow-downgrade");
    const refused = (action: any, body: any) => assert.throws(() => buildCommand(action, body, s), (e: unknown) => e instanceof MaintenanceError && e.status === 400, JSON.stringify(body));
    refused("status", { component: "../x" });
    refused("status", { component: ["a"] });
    refused("rollback", {});
    refused("rollback", { component: "a b" });
    refused("prune", { component: "server", keep: 1 });
    refused("prune", { component: "server", keep: 51 });
    refused("prune", { component: "server", keep: 2.5 });
    refused("prune", { component: "server", keep: "3" });
    refused("install", { package: "p.tgz", allowDowngrade: "yes" });
    // nothing a caller sends ends up as a separate argument of the tool beyond the ones above
    for (const hostile of ["server; reboot", "$(reboot)", "server --root /", "`id`", "a|b"]) refused("rollback", { component: hostile });
  } finally {
    done();
  }
});

test("the tool prints a JSON document and a DEPLOY=PASS line", () => {
  assert.deepEqual(parseToolOutput('{\n  "a": 1\n}\nDEPLOY=PASS\n'), { a: 1 });
  assert.deepEqual(parseToolOutput('{"a":1}\r\nDEPLOY=PASS\r\n'), { a: 1 });
  assert.equal(parseToolOutput("not json\nDEPLOY=PASS\n"), null);
  assert.equal(parseToolOutput(""), null);
});

const okRun = (stdout = '{"removed": []}\nDEPLOY=PASS\n'): RunResult => ({ exitCode: 0, stdout, stderr: "", timedOut: false });

test("one run at a time; a failed run is reported with the last lines of its error output", async () => {
  const { dir, done } = scratch();
  try {
    const s = settingsIn(dir);
    const seen: MaintenanceCommand[] = [];
    let release!: (value: RunResult) => void;
    const runner: Runner = (command) => { seen.push(command); return new Promise((resolve) => { release = resolve; }); };
    const maintenance = new Maintenance({ settings: () => s, runner });
    const first = maintenance.run("rollback", { component: "server" });
    assert.equal(maintenance.running, true);
    await assert.rejects(maintenance.run("rollback", { component: "server" }), (e: unknown) => e instanceof MaintenanceError && e.status === 409);
    release({ exitCode: 3, stdout: "", stderr: `${"line\n".repeat(30)}DEPLOY=FAIL went back`, timedOut: false });
    const outcome = await first;
    assert.equal(outcome.ok, false);
    assert.equal(outcome.exitCode, 3);
    assert.equal(outcome.result, null);
    assert.ok(outcome.message.endsWith("DEPLOY=FAIL went back"));
    assert.ok(outcome.message.split("\n").length <= 20);
    assert.equal(maintenance.running, false);
    assert.equal(seen.length, 1);
  } finally {
    done();
  }
});

test("a refused request does not start the tool and does not hold the slot", async () => {
  const { dir, done } = scratch();
  try {
    let started = 0;
    const maintenance = new Maintenance({ settings: () => settingsIn(dir), runner: async () => { started += 1; return okRun(); } });
    await assert.rejects(maintenance.run("rollback", {}), MaintenanceError);
    assert.equal(started, 0);
    assert.equal(maintenance.running, false);
    const outcome = await maintenance.run("prune", { component: "server" });
    assert.equal(outcome.ok, true);
    assert.deepEqual(outcome.result, { removed: [] });
    assert.equal(started, 1);
  } finally {
    done();
  }
});

test("a run that times out is not ok", async () => {
  const { dir, done } = scratch();
  try {
    const maintenance = new Maintenance({ settings: () => settingsIn(dir), runner: async () => ({ exitCode: 1, stdout: "", stderr: "", timedOut: true }) });
    const outcome = await maintenance.run("status", {});
    assert.equal(outcome.ok, false);
    assert.equal(outcome.timedOut, true);
  } finally {
    done();
  }
});

type Handler = (req: any, res: any, next?: any) => Promise<unknown> | unknown;

function routesWith(enabled: () => boolean, runner: Runner, role = "admin") {
  const { dir, done } = scratch();
  const routes: Record<string, Handler[]> = {};
  const app: any = {
    get(p: string, ...h: Handler[]) { routes[`GET ${p}`] = h; },
    post(p: string, ...h: Handler[]) { routes[`POST ${p}`] = h; },
    put() {}, delete() {}, patch() {},
  };
  const events: any[] = [];
  const s = settingsIn(dir);
  fs.writeFileSync(path.join(s.packagesDir, "p.tgz"), "x");
  registerMaintenanceRoutes(app, {
    authenticate: ((req: any, _res: any, next: any) => { req.user = { id: "u1", username: "root", role }; return next(); }) as any,
    requireAdmin: ((req: any, res: any, next: any) => (req.user?.role === "admin" ? next() : res.status(403).json({ error: "administrator required" }))) as any,
    enabled,
    audit: { record: (event: any) => { events.push(event); return null as any; } },
    maintenance: new Maintenance({ settings: () => s, runner }),
  });
  const call = async (key: string, req: any) => {
    const res: any = new EventEmitter();
    res.statusCode = 200;
    res.status = (code: number) => { res.statusCode = code; return res; };
    const done2 = new Promise<void>((resolve) => { res.json = (payload: unknown) => { res.body = payload; resolve(); return res; }; });
    const chain = routes[key];
    assert.ok(chain, `route ${key} is registered`);
    const run = async (index: number): Promise<unknown> => (index >= chain.length ? undefined : chain[index](req, res, () => run(index + 1)));
    await run(0);
    await Promise.race([done2, new Promise((r) => setTimeout(r, 300))]);
    return res;
  };
  return { call, events, done };
}

test("while the switch is off every route answers 404 and nothing is run", async () => {
  let started = 0;
  const { call, events, done } = routesWith(() => false, async () => { started += 1; return okRun(); });
  try {
    for (const key of ["GET /api/admin/maintenance/status", "POST /api/admin/maintenance/install", "POST /api/admin/maintenance/rollback", "POST /api/admin/maintenance/prune"]) {
      const res = await call(key, { query: {}, body: { package: "p.tgz", component: "server", confirm: true } });
      assert.equal(res.statusCode, 404, key);
    }
    assert.equal(started, 0);
    assert.equal(events.length, 0);
  } finally {
    done();
  }
});

test("a viewer or operator never reaches the tool", async () => {
  let started = 0;
  const { call, done } = routesWith(() => true, async () => { started += 1; return okRun(); }, "operator");
  try {
    const res = await call("POST /api/admin/maintenance/rollback", { query: {}, body: { component: "server", confirm: true } });
    assert.equal(res.statusCode, 403);
    assert.equal(started, 0);
  } finally {
    done();
  }
});

test("a change needs the confirmation, is audited whatever its result, and the status is read only", async () => {
  const runs: MaintenanceCommand[] = [];
  let result: RunResult = okRun('{"server": {}}\nDEPLOY=PASS\n');
  const { call, events, done } = routesWith(() => true, async (command) => { runs.push(command); return result; });
  try {
    const status = await call("GET /api/admin/maintenance/status", { query: { component: "server" }, body: undefined });
    assert.equal(status.statusCode, 200);
    assert.deepEqual(status.body.result, { server: {} });
    assert.equal(events.length, 0, "a status read is not a change");
    assert.equal((await call("GET /api/admin/maintenance/status", { query: { component: "../x" } })).statusCode, 400);

    const unconfirmed = await call("POST /api/admin/maintenance/rollback", { query: {}, body: { component: "server" } });
    assert.equal(unconfirmed.statusCode, 400);
    assert.match(unconfirmed.body.error, /confirm/);
    assert.equal(runs.length, 1, "nothing ran without the confirmation");

    const done1 = await call("POST /api/admin/maintenance/install", { query: {}, ip: "10.0.0.2", body: { package: "p.tgz", confirm: true } });
    assert.equal(done1.statusCode, 200);
    assert.equal(done1.body.ok, true);
    assert.equal(events.at(-1).type, "maintenance-run");
    assert.equal(events.at(-1).outcome, "ok");
    assert.equal(events.at(-1).detail.package, "p.tgz");

    result = { exitCode: 3, stdout: "", stderr: "DEPLOY=FAIL x", timedOut: false };
    const failed = await call("POST /api/admin/maintenance/rollback", { query: {}, body: { component: "server", confirm: true } });
    assert.equal(failed.statusCode, 502);
    assert.equal(failed.body.ok, false);
    assert.equal(events.at(-1).outcome, "failed");
    assert.equal(events.at(-1).detail.exit_code, 3);

    const refused = await call("POST /api/admin/maintenance/install", { query: {}, body: { package: "../x", confirm: true } });
    assert.equal(refused.statusCode, 400);
    assert.equal(events.at(-1).outcome, "refused");
    const missing = await call("POST /api/admin/maintenance/install", { query: {}, body: { package: "nothere.tgz", confirm: true } });
    assert.equal(missing.statusCode, 404);
    const notObject = await call("POST /api/admin/maintenance/prune", { query: {}, body: [1] });
    assert.equal(notObject.statusCode, 400);
  } finally {
    done();
  }
});

function makeConfig(env: any = {}, initial: SecurityFile = {}, extra: Record<string, unknown> = {}) {
  let stored: SecurityFile = { ...initial };
  const logs: string[] = [];
  const config = new SecurityConfig({ env, load: () => ({ ...stored }), save: (file) => { stored = { ...file }; }, tlsActive: false, log: (m) => logs.push(m), ...extra });
  return { config, logs, stored: () => stored };
}
const bad400 = (e: unknown) => e instanceof SecurityConfigError && e.status === 400;

test("the maintenance routes are off by default; turning them on needs the confirmation and the environment can lock them", () => {
  const { config, logs, stored } = makeConfig();
  assert.equal(config.maintenanceEnabled(), false);
  assert.deepEqual(config.snapshot().maintenance.enabled, { value: false, source: "default" });
  assert.throws(() => config.update({ maintenance: { enabled: true } }, "root"), bad400);
  assert.throws(() => config.update({ maintenance: { enabled: true, confirm: "yes" } }, "root"), bad400);
  assert.throws(() => config.update({ maintenance: { enabled: "yes" } }, "root"), bad400);
  assert.throws(() => config.update({ maintenance: [] }, "root"), bad400);
  const on = config.update({ maintenance: { enabled: true, confirm: true } }, "root");
  assert.ok(on.warnings.includes("maintenance_on"));
  assert.equal(config.maintenanceEnabled(), true);
  assert.deepEqual(stored().maintenance, { enabled: true });
  assert.ok(logs.some((line) => /maintenance routes/.test(line)));
  const off = config.update({ maintenance: { enabled: false } }, "root");
  assert.equal(off.warnings.includes("maintenance_on"), false);
  assert.equal(config.maintenanceEnabled(), false);
  assert.equal(resolveMaintenance("1", {}).value, true);
  for (const word of ["0", "true", "yes", " ", "on"]) assert.equal(resolveMaintenance(word, {}).value, word === " " ? false : false, word);
  assert.throws(() => makeConfig({ maintenance: "1" }).config.update({ maintenance: { enabled: false } }, "root"), (e: unknown) => e instanceof SecurityConfigError && e.status === 409 && /MAINTENANCE/.test(e.message));
  // the paths and the time limit are edited in the file only
  const file = makeConfig({}, { maintenance: { root: "/srv/h", timeoutSeconds: 60 } });
  file.config.update({ maintenance: { enabled: true, confirm: true } }, "root");
  assert.deepEqual(file.stored().maintenance, { root: "/srv/h", timeoutSeconds: 60, enabled: true });
});

test("the reports of loaded models write the settings file that DETECTION-HEF re-reads", () => {
  const written: Array<[boolean, string | undefined]> = [];
  const { config, stored } = makeConfig({}, { detectionHef: { settingsFile: "custom.json" } }, { writeDetectionHefSettings: (value: boolean, file: string | undefined) => { written.push([value, file]); } });
  assert.deepEqual(config.snapshot().detectionHef.acceptLoadedReports, { value: false, source: "default" });
  assert.throws(() => config.update({ detectionHef: { acceptLoadedReports: true } }, "root"), bad400);
  assert.throws(() => config.update({ detectionHef: { acceptLoadedReports: "yes", confirm: true } }, "root"), bad400);
  assert.throws(() => config.update({ detectionHef: 3 }, "root"), bad400);
  assert.deepEqual(written, []);
  const on = config.update({ detectionHef: { acceptLoadedReports: true, confirm: true } }, "root");
  assert.ok(on.warnings.includes("detection_hef_reports_on"));
  assert.deepEqual(written, [[true, "custom.json"]]);
  assert.deepEqual(stored().detectionHef, { settingsFile: "custom.json", acceptLoadedReports: true });
  config.update({ detectionHef: { acceptLoadedReports: false } }, "root");
  assert.deepEqual(written.at(-1), [false, "custom.json"]);
  assert.equal(resolveDetectionHefReports({}).value, false);
});

test("a settings file that cannot be written is told to the administrator and does not undo the saved value", () => {
  const { config, logs } = makeConfig({}, {}, { writeDetectionHefSettings: () => { throw new Error("disk full"); } });
  const result = config.update({ detectionHef: { acceptLoadedReports: true, confirm: true } }, "root");
  assert.ok(result.warnings.includes("detection_hef_settings_file_not_written"));
  assert.equal(result.snapshot.detectionHef.acceptLoadedReports.value, true);
  assert.ok(logs.some((line) => /disk full/.test(line)));
});

test("the settings file is a small JSON object written whole, readable by its owner and group", () => {
  const { dir, done } = scratch();
  try {
    assert.equal(detectionHefSettingsText(true), '{"acceptLoadedReports":true}\n');
    assert.equal(detectionHefSettingsPath(dir, undefined), path.join(dir, DETECTION_HEF_SETTINGS_NAME));
    assert.equal(detectionHefSettingsPath(dir, "  "), path.join(dir, DETECTION_HEF_SETTINGS_NAME));
    assert.equal(detectionHefSettingsPath(dir, "sub/x.json"), path.resolve(dir, "sub/x.json"));
    assert.throws(() => detectionHefSettingsPath(dir, "a\0b"));
    const written = writeDetectionHefSettings(dir, true);
    assert.deepEqual(JSON.parse(fs.readFileSync(written, "utf8")), { acceptLoadedReports: true });
    writeDetectionHefSettings(dir, false);
    assert.deepEqual(JSON.parse(fs.readFileSync(written, "utf8")), { acceptLoadedReports: false });
    if (process.platform !== "win32") assert.equal(fs.statSync(written).mode & 0o777, 0o640);
    assert.deepEqual(fs.readdirSync(dir).filter((name) => name.endsWith(".tmp")), [], "no temporary file is left behind");
    const nested = writeDetectionHefSettings(dir, true, path.join("deeper", "still", "f.json"));
    assert.ok(fs.existsSync(nested));
  } finally {
    done();
  }
});
