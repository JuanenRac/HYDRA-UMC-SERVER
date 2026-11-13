// =============================================================================
// HYDRA-UMC-SERVER - Unit tests for the update of the programs from Studio (src/selfUpdate.ts and its routes)
// Copyright (C) 2026 JuanenRac (Electro Hobby 3D) <electrohobby3d@gmail.com>
// GPL-3.0-or-later - see LICENSE
// =============================================================================
// Everything here runs on doubles: GitHub, the download, the check of the package, the deploy tool and the restart of the server are simulated, so the
// evidence is `simulator`. What is not proved here is the real thing on the CM5: a real package from a real release, the real unit restarting, the real
// health check. The cases: the whole way to done, a signature that does not hold, a download cut in the middle, a restart of the server in the middle of the
// job (a second object over the same files), a deploy that goes back by itself, the way back by hand and every refusal.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { maintenanceSettings, type Runner } from "../src/maintenance.ts";
import {
  SelfUpdate, SelfUpdateError, installedFromStatus, launcherWith, packageNames, parseLatestRelease, readDeployOutcome, releaseAssetUrl, selfUpdateSettings,
  type Downloader, type FetchLike, type Installed, type Launcher, type SelfUpdateComponent, type SelfUpdateDeps,
} from "../src/selfUpdate.ts";
import { registerSelfUpdateRoutes } from "../src/routes/selfUpdateRoutes.ts";

const DIGEST = "a".repeat(64);

function scratch() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hydra-selfup-"));
  return { dir, done: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

/** GitHub as the releases/latest call answers it, for one version of every repository. */
function github(version: string, options: { withSig?: boolean; status?: number } = {}): FetchLike {
  return async (url) => {
    const match = /repos\/([^/]+)\/(HYDRA-UMC-[A-Z]+)\/releases\/latest$/.exec(url);
    const component = (match && ({ "HYDRA-UMC-SERVER": "server", "HYDRA-UMC-STUDIO": "studio", "HYDRA-UMC-OS": "os-agent" } as Record<string, SelfUpdateComponent>)[match[2]]) ?? null;
    if (!component || options.status) return { status: options.status ?? 404, ok: false, json: async () => ({}) };
    const names = packageNames(component, version);
    const assets = [{ name: names.pkg, size: 1000 }, { name: names.sha256, size: 90 }, ...(options.withSig === false ? [] : [{ name: names.sig, size: 130 }])];
    return { status: 200, ok: true, json: async () => ({ tag_name: `v${version}`, assets }) };
  };
}

/** One machine: the versions the deploy tool keeps, what the check says, and a tool that ends the way the case wants. */
function machine(dir: string, start: Installed, extra: Partial<SelfUpdateDeps> = {}, ending: "pass" | "fail" | "hang" = "pass") {
  const state: Record<string, Installed> = { server: { ...start }, studio: { ...start }, "os-agent": { ...start } };
  const calls = { downloads: [] as string[], verifies: 0, launches: [] as string[][], gone: 0 };
  const download: Downloader = async (url, destination) => { calls.downloads.push(url); fs.writeFileSync(destination, "package"); };
  const run: Runner = async (command) => {
    calls.verifies += 1;
    const file = path.basename(command.args[2]);
    const m = /^hydra-([a-z-]+)-([0-9.]+)\.tgz$/.exec(file) as RegExpExecArray;
    return { exitCode: 0, stdout: `PACKAGE=OK ${m[1]} ${m[2]} ${DIGEST}\n`, stderr: "", timedOut: false };
  };
  const launch: Launcher = ({ args, outFile }) => {
    calls.launches.push(args);
    const component = args.includes("rollback") ? args[args.length - 1] : /hydra-([a-z-]+)-/.exec(path.basename(args[args.length - 1]))![1];
    if (ending === "hang") return;
    if (ending === "fail") { fs.appendFileSync(outFile, `DEPLOY=FAIL ${component} did not pass the health check; the release in use is ${state[component].current}\n`); return; }
    const target = args.includes("rollback") ? state[component].previous : /-([0-9.]+)\.tgz$/.exec(args[args.length - 1])![1];
    state[component] = { current: target, previous: state[component].current };
    fs.appendFileSync(outFile, "{}\nDEPLOY=PASS\n");
  };
  let clock = Date.parse("2030-01-01T00:00:00Z");
  const deps: SelfUpdateDeps = {
    settings: () => selfUpdateSettings(undefined),
    maintenance: () => maintenanceSettings({ root: "/opt/test", tool: "/opt/test/tools/deploy_release.py", python: "python3" }, dir),
    dataPath: dir,
    installed: async (component) => ({ ...state[component] }),
    fetch: github("0.9.0"), download, run, launch, now: () => clock, newId: () => "job1",
    ...extra,
  };
  return { deps, state, calls, tick: (ms: number) => { clock += ms; } };
}

const stepsOf = (job: { log: Array<{ step: string }> }) => job.log.map((entry) => entry.step);

test("the settings come from the file within their limits", () => {
  assert.deepEqual(selfUpdateSettings(undefined), { owner: "JuanenRac", runnerPrefix: [], applyTimeoutSeconds: 600 });
  assert.equal(selfUpdateSettings({ owner: "bad owner!" }).owner, "JuanenRac");
  assert.equal(selfUpdateSettings({ owner: "Someone-Else" }).owner, "Someone-Else");
  assert.equal(selfUpdateSettings({ applyTimeoutSeconds: 1 }).applyTimeoutSeconds, 30);
  assert.equal(selfUpdateSettings({ applyTimeoutSeconds: 1e9 }).applyTimeoutSeconds, 3600);
  assert.deepEqual(selfUpdateSettings({ runnerPrefix: ["systemd-run", "--collect", "{out}"] }).runnerPrefix, ["systemd-run", "--collect", "{out}"]);
  assert.deepEqual(selfUpdateSettings({ runnerPrefix: ["ok", 5] as any }).runnerPrefix, []);
  assert.deepEqual(selfUpdateSettings({ runnerPrefix: "sudo" as any }).runnerPrefix, []);
});

test("a release is read for its version and for the three files of a signed package", () => {
  const names = packageNames("server", "0.9.0");
  assert.deepEqual(names, { pkg: "hydra-server-0.9.0.tgz", sha256: "hydra-server-0.9.0.tgz.sha256", sig: "hydra-server-0.9.0.tgz.sig" });
  const complete = parseLatestRelease({ tag_name: "v0.9.0", assets: [{ name: names.pkg, size: 5 }, { name: names.sha256, size: 1 }, { name: names.sig, size: 1 }] }, "JuanenRac", "server");
  assert.equal(complete?.version, "0.9.0");
  assert.equal(complete?.assets?.pkg.url, "https://github.com/JuanenRac/HYDRA-UMC-SERVER/releases/download/v0.9.0/hydra-server-0.9.0.tgz");
  const unsigned = parseLatestRelease({ tag_name: "v0.9.0", assets: [{ name: names.pkg, size: 5 }, { name: names.sha256, size: 1 }] }, "JuanenRac", "server");
  assert.equal(unsigned?.version, "0.9.0");
  assert.equal(unsigned?.assets, null);
  assert.equal(parseLatestRelease({ tag_name: "v0.9.0", prerelease: true, assets: [] }, "JuanenRac", "server"), null);
  assert.equal(parseLatestRelease({ tag_name: "v0.9.0", draft: true }, "JuanenRac", "server"), null);
  assert.equal(parseLatestRelease({ tag_name: "latest" }, "JuanenRac", "server"), null);
  assert.equal(parseLatestRelease(null, "JuanenRac", "server"), null);
  // a package of another program in the same release is not this program's
  assert.equal(parseLatestRelease({ tag_name: "v0.9.0", assets: [{ name: "hydra-studio-0.9.0.tgz", size: 1 }] }, "JuanenRac", "server")?.assets, null);
  assert.equal(releaseAssetUrl("Me", "os-agent", "1.0", "x.tgz"), "https://github.com/Me/HYDRA-UMC-OS/releases/download/v1.0/x.tgz");
});

test("the versions in use are read from the status of the deploy tool", () => {
  const status = { server: { current: { version: "0.8.1.0" }, previous: { version: "0.8.0.9" } }, studio: { current: { version: "x" }, previous: null } };
  assert.deepEqual(installedFromStatus(status, "server"), { current: "0.8.1.0", previous: "0.8.0.9" });
  assert.deepEqual(installedFromStatus(status, "studio", "0.7.0"), { current: "0.7.0", previous: null });
  assert.deepEqual(installedFromStatus(status, "os-agent", "1.2.3"), { current: "1.2.3", previous: null });
  assert.deepEqual(installedFromStatus(null, "server"), { current: null, previous: null });
});

test("what the deploy tool printed tells how it ended", () => {
  assert.deepEqual(readDeployOutcome(""), { result: "running" });
  assert.deepEqual(readDeployOutcome("{}\nDEPLOY=PASS\n"), { result: "pass" });
  assert.deepEqual(readDeployOutcome("DEPLOY=FAIL refused: nothing\n"), { result: "fail", reason: "refused: nothing" });
  assert.deepEqual(readDeployOutcome("noise DEPLOY=PASS in the middle"), { result: "running" });
});

test("the report sets what is installed against the newest signed release", async () => {
  const { dir, done } = scratch();
  try {
    const { deps } = machine(dir, { current: "0.8.1.0", previous: null });
    const update = new SelfUpdate(deps);
    const report = await update.report();
    assert.equal(report.rateLimited, false);
    assert.deepEqual(report.items.map((item) => [item.id, item.installed, item.latest, item.state, item.signedPackage]), [
      ["server", "0.8.1.0", "0.9.0", "behind", true], ["studio", "0.8.1.0", "0.9.0", "behind", true], ["os-agent", "0.8.1.0", "0.9.0", "behind", true],
    ]);
    const unsigned = await new SelfUpdate({ ...deps, fetch: github("0.9.0", { withSig: false }) }).report();
    assert.equal(unsigned.items[0].signedPackage, false);
    const current = await new SelfUpdate({ ...deps, fetch: github("0.8.1.0") }).report();
    assert.equal(current.items[0].state, "current");
    const ahead = await new SelfUpdate({ ...deps, fetch: github("0.8.0.0") }).report();
    assert.equal(ahead.items[0].state, "ahead");
    const limited = await new SelfUpdate({ ...deps, fetch: github("0.9.0", { status: 403 }) }).report();
    assert.equal(limited.rateLimited, true);
    assert.equal(limited.items[0].latest, null);
    assert.equal(limited.items[0].state, "unknown");
  } finally { done(); }
});

test("the report is kept ten minutes and a new look never comes more than once a minute", async () => {
  const { dir, done } = scratch();
  try {
    let asked = 0;
    const m = machine(dir, { current: "0.8.1.0", previous: null });
    const counted: FetchLike = async (url, init) => { asked += 1; return github("0.9.0")(url, init); };
    const update = new SelfUpdate({ ...m.deps, fetch: counted });
    await update.report();
    assert.equal(asked, 3);
    await update.report(true);
    assert.equal(asked, 3);
    m.tick(61_000);
    await update.report(true);
    assert.equal(asked, 6);
    m.tick(11 * 60_000);
    await update.report();
    assert.equal(asked, 9);
  } finally { done(); }
});

test("an update goes through every step to done, then the new version is the one in use", async () => {
  const { dir, done } = scratch();
  try {
    const m = machine(dir, { current: "0.8.1.0", previous: null }, {}, "hang");
    const update = new SelfUpdate(m.deps);
    const started = await update.start("apply", "server", "admin");
    assert.equal(started.state, "checking");
    await update.idle();
    assert.equal(m.calls.downloads.length, 3);
    assert.ok(m.calls.downloads.every((url) => url.startsWith("https://github.com/JuanenRac/HYDRA-UMC-SERVER/releases/download/v0.9.0/")));
    assert.equal(m.calls.verifies, 1);
    assert.equal(m.calls.launches.length, 1);
    assert.deepEqual(m.calls.launches[0].slice(1, 3), ["--root", "/opt/test"]);
    assert.equal(m.calls.launches[0][3], "install");
    // the tool has switched the release and is restarting the unit; no end written yet
    m.state.server = { current: "0.9.0", previous: "0.8.1.0" };
    const outFile = (await update.current())!.outFile;
    fs.writeFileSync(outFile, "");
    const restarting = await update.current("job1");
    assert.equal(restarting?.state, "restarting");
    fs.appendFileSync(outFile, "{}\nDEPLOY=PASS\n");
    const finished = await update.current("job1");
    assert.equal(finished?.state, "done");
    assert.equal(finished?.error, null);
    assert.deepEqual(stepsOf(finished!), ["checking", "downloading", "verifying", "applying", "restarting", "done"]);
    assert.equal(finished?.targetVersion, "0.9.0");
    assert.equal(finished?.by, "admin");
    assert.equal(await update.current("other"), null);
    // the packages stay where the maintenance routes look for them
    assert.ok(fs.existsSync(path.join(dir, "packages", "hydra-server-0.9.0.tgz")));
  } finally { done(); }
});

test("a package whose signature does not hold is refused, removed and never installed", async () => {
  const { dir, done } = scratch();
  try {
    const bad: Runner = async () => ({ exitCode: 1, stdout: "", stderr: "PACKAGE=REFUSED the signature does not match the key of the releases\n", timedOut: false });
    const m = machine(dir, { current: "0.8.1.0", previous: null }, { run: bad });
    const update = new SelfUpdate(m.deps);
    await update.start("apply", "server", "admin");
    await update.idle();
    const job = (await update.current())!;
    assert.equal(job.state, "failed");
    assert.equal(job.error, "signature_invalid");
    assert.match(job.detail, /signature does not match/);
    assert.equal(m.calls.launches.length, 0);
    assert.deepEqual(fs.readdirSync(path.join(dir, "packages")), []);
    // a package that passes but is another program's, or another version, is refused as well
    for (const line of ["PACKAGE=OK studio 0.9.0 " + DIGEST, "PACKAGE=OK server 0.8.9 " + DIGEST, "something else"]) {
      const odd: Runner = async () => ({ exitCode: 0, stdout: `${line}\n`, stderr: "", timedOut: false });
      const again = new SelfUpdate({ ...machine(dir, { current: "0.8.1.0", previous: null }, { run: odd }).deps, newId: () => "job2" });
      await again.start("apply", "server", "admin");
      await again.idle();
      assert.equal((await again.current())?.error, "signature_invalid", line);
    }
    const timedOut: Runner = async () => ({ exitCode: 0, stdout: `PACKAGE=OK server 0.9.0 ${DIGEST}\n`, stderr: "", timedOut: true });
    const slow = new SelfUpdate({ ...machine(dir, { current: "0.8.1.0", previous: null }, { run: timedOut }).deps, newId: () => "job3" });
    await slow.start("apply", "server", "admin");
    await slow.idle();
    assert.equal((await slow.current())?.error, "signature_invalid");
  } finally { done(); }
});

test("a download cut in the middle leaves nothing behind and ends as failed", async () => {
  const { dir, done } = scratch();
  try {
    let count = 0;
    const cut: Downloader = async (_url, destination) => {
      count += 1;
      if (count === 2) { fs.writeFileSync(`${destination}.part`, "half"); throw new Error("connection reset"); }
      fs.writeFileSync(destination, "package");
    };
    const m = machine(dir, { current: "0.8.1.0", previous: null }, { download: cut });
    const update = new SelfUpdate(m.deps);
    await update.start("apply", "studio", "admin");
    await update.idle();
    const job = (await update.current())!;
    assert.equal(job.state, "failed");
    assert.equal(job.error, "download_failed");
    assert.match(job.detail, /connection reset/);
    assert.deepEqual(fs.readdirSync(path.join(dir, "packages")), []);
    assert.equal(m.calls.verifies, 0);
    assert.equal(m.calls.launches.length, 0);
    // and a new update can start straight after
    const retry = await new SelfUpdate({ ...m.deps, download: async (_u, d) => fs.writeFileSync(d, "x"), newId: () => "job2" }).start("apply", "studio", "admin");
    assert.equal(retry.id, "job2");
  } finally { done(); }
});

test("a package past the limit stops the job", async () => {
  const { dir, done } = scratch();
  try {
    const big: FetchLike = async () => ({ status: 200, ok: true, json: async () => ({ tag_name: "v0.9.0", assets: [
      { name: "hydra-server-0.9.0.tgz", size: 400 * 1024 * 1024 }, { name: "hydra-server-0.9.0.tgz.sha256", size: 90 }, { name: "hydra-server-0.9.0.tgz.sig", size: 130 }] }) });
    const m = machine(dir, { current: "0.8.1.0", previous: null }, { fetch: big });
    const update = new SelfUpdate(m.deps);
    await update.start("apply", "server", "admin");
    await update.idle();
    assert.equal((await update.current())?.error, "package_too_large");
    assert.equal(m.calls.downloads.length, 0);
    const refused: Downloader = async () => { throw new SelfUpdateError(413, "too large"); };
    const second = new SelfUpdate({ ...machine(dir, { current: "0.8.1.0", previous: null }, { download: refused }).deps, newId: () => "job2" });
    await second.start("apply", "server", "admin");
    await second.idle();
    assert.equal((await second.current())?.error, "package_too_large");
  } finally { done(); }
});

test("nothing to install: already current, no release, no signed package", async () => {
  const { dir, done } = scratch();
  try {
    const cases: Array<[Partial<SelfUpdateDeps>, string, string]> = [
      [{ fetch: github("0.8.1.0") }, "already_current", "0.8.1.0"],
      [{ fetch: github("0.8.0.0") }, "already_current", "0.8.1.0"],
      [{ fetch: github("0.9.0", { status: 404 }) }, "no_release", "0.8.1.0"],
      [{ fetch: github("0.9.0", { withSig: false }) }, "no_signed_package", "0.8.1.0"],
      [{ fetch: async () => { throw new Error("offline"); } }, "no_release", "0.8.1.0"],
    ];
    for (const [extra, error, installed] of cases) {
      const m = machine(dir, { current: installed, previous: null }, { ...extra, newId: () => `j${error}` });
      const update = new SelfUpdate(m.deps);
      await update.start("apply", "server", "admin");
      await update.idle();
      assert.equal((await update.current())?.error, error);
      assert.equal(m.calls.downloads.length, 0);
    }
  } finally { done(); }
});

test("the server restarting in the middle of the job: the new process reads the job and ends it", async () => {
  const { dir, done } = scratch();
  try {
    const m = machine(dir, { current: "0.8.1.0", previous: null }, {}, "hang");
    const first = new SelfUpdate(m.deps);
    await first.start("apply", "server", "admin");
    await first.idle();
    assert.equal((await first.current())?.state, "applying");
    // the unit is restarted: the old process is gone, a new object reads the job from its file
    m.state.server = { current: "0.9.0", previous: "0.8.1.0" };
    const second = new SelfUpdate(m.deps);
    assert.equal((await second.current("job1"))?.state, "restarting");
    const outFile = (await second.current())!.outFile;
    fs.appendFileSync(outFile, "{}\nDEPLOY=PASS\n");
    const third = new SelfUpdate(m.deps);
    const finished = await third.current();
    assert.equal(finished?.state, "done");
    assert.equal(finished?.fromVersion, "0.8.1.0");
  } finally { done(); }
});

test("a job whose in-process steps were cut by a restart ends as interrupted, and the file is not trusted blindly", async () => {
  const { dir, done } = scratch();
  try {
    const m = machine(dir, { current: "0.8.1.0", previous: null });
    fs.mkdirSync(path.join(dir, "self-update"), { recursive: true });
    fs.writeFileSync(path.join(dir, "self-update", "job.json"), JSON.stringify({ id: "old", action: "apply", component: "server", state: "downloading", log: [], by: "x" }));
    const update = new SelfUpdate(m.deps);
    const job = await update.current();
    assert.equal(job?.state, "failed");
    assert.equal(job?.error, "interrupted");
    fs.writeFileSync(path.join(dir, "self-update", "job.json"), "{not json");
    assert.equal(await new SelfUpdate(m.deps).current(), null);
    fs.writeFileSync(path.join(dir, "self-update", "job.json"), JSON.stringify({ id: "x", component: "../../etc", state: "done" }));
    assert.equal(await new SelfUpdate(m.deps).current(), null);
  } finally { done(); }
});

test("a deploy that does not hold goes back by itself and the job says so", async () => {
  const { dir, done } = scratch();
  try {
    const m = machine(dir, { current: "0.8.1.0", previous: null }, {}, "fail");
    const update = new SelfUpdate(m.deps);
    await update.start("apply", "server", "admin");
    await update.idle();
    const job = (await update.current())!;
    assert.equal(job.state, "failed");
    assert.equal(job.error, "rolled_back");
    assert.match(job.detail, /did not pass the health check/);
    assert.equal(m.state.server.current, "0.8.1.0");
    const refused = machine(dir, { current: "0.8.1.0", previous: null }, { newId: () => "j3" }, "hang");
    const again = new SelfUpdate(refused.deps);
    await again.start("apply", "server", "admin");
    await again.idle();
    fs.writeFileSync((await again.current())!.outFile, "DEPLOY=FAIL refused: a version lower than the one in use\n");
    assert.equal((await again.current())?.error, "deploy_failed");
  } finally { done(); }
});

test("a tool that finished but left another release in use is a failure", async () => {
  const { dir, done } = scratch();
  try {
    const m = machine(dir, { current: "0.8.1.0", previous: null }, {}, "hang");
    const update = new SelfUpdate(m.deps);
    await update.start("apply", "server", "admin");
    await update.idle();
    fs.writeFileSync((await update.current())!.outFile, "DEPLOY=PASS\n");
    const job = await update.current();
    assert.equal(job?.state, "failed");
    assert.equal(job?.error, "deploy_failed");
  } finally { done(); }
});

test("a tool that never reports an end times out", async () => {
  const { dir, done } = scratch();
  try {
    const m = machine(dir, { current: "0.8.1.0", previous: null }, {}, "hang");
    const update = new SelfUpdate(m.deps);
    await update.start("apply", "server", "admin");
    await update.idle();
    m.tick(599_000);
    assert.equal((await update.current())?.state, "applying");
    m.tick(2_000);
    const job = await update.current();
    assert.equal(job?.state, "failed");
    assert.equal(job?.error, "timeout");
  } finally { done(); }
});

test("going back puts the earlier release in use and needs one to exist", async () => {
  const { dir, done } = scratch();
  try {
    const none = new SelfUpdate(machine(dir, { current: "0.9.0", previous: null }).deps);
    await assert.rejects(none.start("rollback", "server", "admin"), (error: unknown) => error instanceof SelfUpdateError && error.status === 409);
    const m = machine(dir, { current: "0.9.0", previous: "0.8.1.0" }, { newId: () => "back" });
    const update = new SelfUpdate(m.deps);
    const job = await update.start("rollback", "server", "admin");
    assert.equal(job.state, "applying");
    assert.equal(job.targetVersion, "0.8.1.0");
    await update.idle();
    assert.deepEqual(m.calls.launches[0].slice(3), ["rollback", "server"]);
    assert.equal(m.calls.downloads.length, 0);
    const finished = await update.current();
    assert.equal(finished?.state, "done");
    assert.match(finished!.detail, /back to 0.8.1.0/);
  } finally { done(); }
});

test("one job at a time, only the three programs, and an unknown name never reaches the tool", async () => {
  const { dir, done } = scratch();
  try {
    const m = machine(dir, { current: "0.8.1.0", previous: "0.8.0.0" }, {}, "hang");
    const update = new SelfUpdate(m.deps);
    for (const bad of ["", "../x", "server;rm", "HYDRA-UMC-SERVER", 5, null, undefined, "constructor", "__proto__"]) {
      await assert.rejects(update.start("apply", bad, "a"), (error: unknown) => error instanceof SelfUpdateError && error.status === 400, String(bad));
    }
    await update.start("apply", "server", "a");
    await update.idle();
    await assert.rejects(update.start("rollback", "studio", "a"), (error: unknown) => error instanceof SelfUpdateError && error.status === 409);
    assert.equal(m.calls.launches.length, 1);
  } finally { done(); }
});

test("the detached launcher puts the prefix in front, writes to the file and never uses a shell", async () => {
  const { dir, done } = scratch();
  try {
    const out = path.join(dir, "out.txt");
    launcherWith([], "j")({ file: process.execPath, args: ["-e", "console.log('DEPLOY=PASS')"], outFile: out });
    for (let i = 0; i < 60 && !fs.existsSync(out) || (fs.existsSync(out) && fs.readFileSync(out, "utf8") === ""); i += 1) await new Promise((r) => setTimeout(r, 100));
    assert.match(fs.readFileSync(out, "utf8"), /DEPLOY=PASS/);
    // a command that does not exist does not throw: the job ends by its own time limit instead
    assert.doesNotThrow(() => launcherWith(["no-such-program-hydra"], "j")({ file: "x", args: [], outFile: path.join(dir, "o2.txt") }));
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
  const m = machine(dir, { current: "0.8.1.0", previous: "0.8.0.0" }, {}, "hang");
  const selfUpdate = new SelfUpdate(m.deps);
  registerSelfUpdateRoutes(app, {
    authenticate: ((req: any, _res: any, next: any) => { req.user = { id: "u1", username: "root", role }; return next(); }) as any,
    requireAdmin: ((req: any, res: any, next: any) => (req.user?.role === "admin" ? next() : res.status(403).json({ error: "administrator required" }))) as any,
    lookEnabled: look, applyEnabled: apply, selfUpdate,
    audit: { record: (event: any) => { events.push(event); return null as any; } },
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
  return { call, events, selfUpdate, calls: m.calls, done };
}

test("while the switches are off the routes answer 404 and nothing is asked or run", async () => {
  const { call, events, calls, done } = routesWith(() => false, () => false);
  try {
    for (const key of ["GET /api/admin/self-update", "GET /api/admin/self-update/jobs/:id"]) assert.equal((await call(key, { query: {}, params: { id: "x" } })).statusCode, 404, key);
    for (const key of ["POST /api/admin/self-update/apply", "POST /api/admin/self-update/rollback"]) assert.equal((await call(key, { query: {}, body: { component: "server", confirm: true } })).statusCode, 404, key);
    assert.equal(calls.downloads.length + calls.launches.length, 0);
    assert.equal(events.length, 0);
  } finally { done(); }
});

test("with only the look on, the status answers and applying stays at 404", async () => {
  const { call, done } = routesWith(() => true, () => false);
  try {
    const status = await call("GET /api/admin/self-update", { query: {} });
    assert.equal(status.statusCode, 200);
    assert.equal(status.body.applyEnabled, false);
    assert.equal(status.body.items.length, 3);
    assert.equal(status.body.job, null);
    assert.equal((await call("POST /api/admin/self-update/apply", { query: {}, body: { component: "server", confirm: true } })).statusCode, 404);
  } finally { done(); }
});

test("a viewer or operator never reaches it", async () => {
  const { call, calls, done } = routesWith(() => true, () => true, "operator");
  try {
    assert.equal((await call("GET /api/admin/self-update", { query: {} })).statusCode, 403);
    assert.equal((await call("POST /api/admin/self-update/apply", { query: {}, body: { component: "server", confirm: true } })).statusCode, 403);
    assert.equal(calls.launches.length, 0);
  } finally { done(); }
});

test("applying needs the confirmation, is audited whether it starts or is refused, and a second job gets 409", async () => {
  const { call, events, selfUpdate, calls, done } = routesWith(() => true, () => true);
  try {
    const unconfirmed = await call("POST /api/admin/self-update/apply", { query: {}, body: { component: "server" } });
    assert.equal(unconfirmed.statusCode, 400);
    assert.equal((await call("POST /api/admin/self-update/apply", { query: {}, body: [1] })).statusCode, 400);
    const unknown = await call("POST /api/admin/self-update/apply", { query: {}, ip: "10.0.0.2", body: { component: "kernel", confirm: true } });
    assert.equal(unknown.statusCode, 400);
    assert.equal(events.at(-1).type, "self-update");
    assert.equal(events.at(-1).outcome, "refused");
    const started = await call("POST /api/admin/self-update/apply", { query: {}, ip: "10.0.0.2", body: { component: "server", confirm: true } });
    assert.equal(started.statusCode, 200);
    assert.equal(started.body.component, "server");
    assert.equal(events.at(-1).outcome, "ok");
    assert.equal(events.at(-1).username, "root");
    await selfUpdate.idle();
    assert.equal(calls.launches.length, 1);
    const second = await call("POST /api/admin/self-update/rollback", { query: {}, body: { component: "server", confirm: true } });
    assert.equal(second.statusCode, 409);
    const job = await call("GET /api/admin/self-update/jobs/:id", { query: {}, params: { id: started.body.id } });
    assert.equal(job.statusCode, 200);
    assert.equal(job.body.state, "applying");
    assert.equal((await call("GET /api/admin/self-update/jobs/:id", { query: {}, params: { id: "nope" } })).statusCode, 404);
    const status = await call("GET /api/admin/self-update", { query: {} });
    assert.equal(status.body.applyEnabled, true);
    assert.equal(status.body.job.id, started.body.id);
  } finally { done(); }
});
