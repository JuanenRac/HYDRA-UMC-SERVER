// =============================================================================
// HYDRA-UMC-SERVER - Unit tests for what survives a restart (src/restartSafety.ts)
// Copyright (C) 2026 JuanenRac (Electro Hobby 3D) <electrohobby3d@gmail.com>
// GPL-3.0-or-later - see LICENSE
// =============================================================================
// The global stop is written before the answer and comes back after a restart until an administrator releases it; a record that can not be read
// counts as a stop; the attempts of the job executor are kept. The restart is simulated: the routes and the state of the first "process" are thrown
// away and a new StopState is built from the same data folder.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { registerCommandRoutes } from "../src/routes/commandRoutes.ts";
import { StopState, holdsBack } from "../src/stopState.ts";
import {
  EXECUTOR_ATTEMPTS_FILE, GLOBAL_STOP_FILE, clearGlobalStop, loadExecutorAttempts, persistGlobalStop, readGlobalStop, saveExecutorAttempts,
} from "../src/restartSafety.ts";

let dir = "";
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), "hydra-restart-")); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

/** One "process": a stop state restored from the folder, and the two routes wired to the files exactly as the server wires them. */
function boot(settings: any) {
  const stopState = new StopState({ fetchPhysical: async () => null, onChange: () => undefined });
  const kept = readGlobalStop(dir);
  if (kept.stopped) stopState.restoreSoftware();
  const handlers: Record<string, (req: any, res: any) => unknown> = {};
  const app: any = { post(route: string, ...chain: unknown[]) { handlers[route] = chain[chain.length - 1] as (req: any, res: any) => unknown; } };
  registerCommandRoutes(app, {
    authenticate: () => undefined,
    getSettings: () => settings,
    industrialLog: () => undefined,
    isReservationActive: () => false,
    queueSettingsWrite: async () => undefined,
    broadcastRobotDelta: () => undefined,
    startServerPlayback: () => undefined,
    stopServerPlayback: () => undefined,
    onGlobalStopChanged: (stopped: boolean) => stopState.setSoftware(stopped),
    persistGlobalStop: (by: string) => persistGlobalStop(dir, by),
    clearGlobalStop: () => clearGlobalStop(dir),
    motionLatched: () => stopState.snapshot().software === "stopped",
  } as any);
  const stopAll = async (user = { id: "u1", username: "alice", role: "operator" }) => {
    let body: any;
    await handlers["/api/stop-all"]({ user, ip: "10.0.0.7" }, { json: (value: any) => { body = value; return undefined; } });
    return body;
  };
  const release = async (user = { id: "a1", username: "root", role: "admin" }) => {
    let status = 200;
    let body: any;
    const res: any = { status(code: number) { status = code; return res; }, json(value: any) { body = value; return res; } };
    await handlers["/api/stop-all/release"]({ user, ip: "10.0.0.8" }, res);
    return { status, body };
  };
  return { stopState, stopAll, release, kept };
}

const roster = () => ({ controllers: [{ id: "c1", robots: [{ id: 1, name: "A", playbackState: { isPlaying: true } }] }] });

describe("the global stop across a restart", () => {
  it("is on disk before the answer of the stop and the new process starts STOPPED, flagged as restored", async () => {
    const first = boot(roster());
    assert.equal(first.kept.stopped, false);
    assert.equal(first.stopState.snapshot().state, "UNKNOWN", "nothing is stopped yet");
    const body = await first.stopAll();
    assert.equal(body.success, true);
    // the answer is out: the record is already on disk
    const onDisk = readGlobalStop(dir);
    assert.equal(onDisk.stopped, true);
    assert.equal(onDisk.stopped && onDisk.by, "alice");
    assert.equal(onDisk.stopped && onDisk.damaged, false);
    assert.equal(first.stopState.snapshot().restoredAfterRestart, undefined, "a stop pressed now is not a restored one");

    // --- the process dies and a new one starts from the same folder
    const second = boot(roster());
    const snapshot = second.stopState.snapshot();
    assert.equal(snapshot.state, "STOPPED");
    assert.equal(snapshot.software, "stopped");
    assert.equal(snapshot.restoredAfterRestart, true);
    assert.equal(holdsBack(snapshot, false), "the server is stopped", "the executor stays gated");
    assert.equal(fs.existsSync(path.join(dir, GLOBAL_STOP_FILE)), true);
  });

  it("stays stopped through any number of restarts until the release, and the release ends it for good", async () => {
    await boot(roster()).stopAll();
    boot(roster());
    const third = boot(roster());
    assert.equal(third.stopState.snapshot().state, "STOPPED");
    const released = await third.release();
    assert.equal(released.status, 200);
    assert.equal(fs.existsSync(path.join(dir, GLOBAL_STOP_FILE)), false);
    const snapshot = third.stopState.snapshot();
    assert.equal(snapshot.software, "ready");
    assert.equal(snapshot.restoredAfterRestart, undefined, "the flag goes with the release");
    const fourth = boot(roster());
    assert.equal(fourth.kept.stopped, false);
    assert.equal(fourth.stopState.snapshot().software, "ready");
  });

  it("keeps the first time of the stop when it is pressed again, and a new stop after a restart clears the restored flag", async () => {
    const first = boot(roster());
    await first.stopAll();
    const before = readGlobalStop(dir);
    const second = boot(roster());
    assert.equal(second.stopState.snapshot().restoredAfterRestart, true);
    await second.stopAll({ id: "u2", username: "bob", role: "operator" });
    const after = readGlobalStop(dir);
    assert.equal(before.stopped && after.stopped && after.since, before.stopped && before.since, "the stop keeps its first time");
    assert.equal(second.stopState.snapshot().restoredAfterRestart, undefined);
  });

  it("a record that can not be understood counts as a stop, and so does one that can not be read", () => {
    fs.writeFileSync(path.join(dir, GLOBAL_STOP_FILE), "{ not json");
    const damaged = readGlobalStop(dir);
    assert.deepEqual(damaged, { stopped: true, since: null, by: null, damaged: true });
    fs.writeFileSync(path.join(dir, GLOBAL_STOP_FILE), JSON.stringify({ schema: 1, who: "nobody" }));
    assert.equal(readGlobalStop(dir).stopped, true, "a record with no state is not a release");
    fs.writeFileSync(path.join(dir, GLOBAL_STOP_FILE), JSON.stringify([1, 2]));
    assert.equal(readGlobalStop(dir).stopped, true);
    // a folder where the file should be: reading it fails with something other than "not there"
    fs.rmSync(path.join(dir, GLOBAL_STOP_FILE));
    fs.mkdirSync(path.join(dir, GLOBAL_STOP_FILE));
    assert.equal(readGlobalStop(dir).stopped, true);
    assert.equal(boot(roster()).stopState.snapshot().state, "STOPPED", "the server comes back stopped");
  });

  it("a missing record is not a stop, and only an explicit release record (stopped: false) is read as not stopped", () => {
    assert.deepEqual(readGlobalStop(dir), { stopped: false });
    fs.writeFileSync(path.join(dir, GLOBAL_STOP_FILE), JSON.stringify({ schema: 1, stopped: false }));
    assert.deepEqual(readGlobalStop(dir), { stopped: false });
  });

  it("fails closed: a stop that can not be written is still applied, and a release that can not remove the record is refused", async () => {
    // the data folder is a file, so nothing can be written under it
    const blocked = path.join(dir, "blocked");
    fs.writeFileSync(blocked, "x");
    assert.equal(persistGlobalStop(path.join(blocked, "data"), "alice"), false);
    // the record exists as a folder with something in it: it can not be removed
    const stuck = path.join(dir, "stuck");
    fs.mkdirSync(path.join(stuck, GLOBAL_STOP_FILE, "inner"), { recursive: true });
    assert.equal(clearGlobalStop(stuck), false);
    assert.equal(readGlobalStop(stuck).stopped, true);
  });

  it("with the latch on the restored server refuses motion until the release (the check the route uses)", async () => {
    await boot(roster()).stopAll();
    const restarted = boot(roster());
    assert.equal(restarted.stopState.snapshot().software === "stopped", true);
    await restarted.release();
    assert.equal(restarted.stopState.snapshot().software === "stopped", false);
  });

  it("writes no temporary file behind it", async () => {
    await boot(roster()).stopAll();
    assert.deepEqual(fs.readdirSync(dir).filter((name) => name.endsWith(".tmp")), []);
  });
});

describe("the attempts of the job executor", () => {
  it("are kept sorted, read back, and a missing record is an empty list", () => {
    assert.deepEqual(loadExecutorAttempts(dir), []);
    assert.equal(saveExecutorAttempts(dir, ["b#1", "a#2"]), true);
    assert.deepEqual(loadExecutorAttempts(dir), ["a#2", "b#1"]);
    assert.equal(saveExecutorAttempts(dir, []), true);
    assert.deepEqual(loadExecutorAttempts(dir), []);
  });

  it("a record that can not be read is unknown (null), never an empty list", () => {
    fs.writeFileSync(path.join(dir, EXECUTOR_ATTEMPTS_FILE), "oops");
    assert.equal(loadExecutorAttempts(dir), null);
    fs.writeFileSync(path.join(dir, EXECUTOR_ATTEMPTS_FILE), JSON.stringify({ attempts: [1] }));
    assert.equal(loadExecutorAttempts(dir), null);
    fs.writeFileSync(path.join(dir, EXECUTOR_ATTEMPTS_FILE), JSON.stringify({ attempts: "x" }));
    assert.equal(loadExecutorAttempts(dir), null);
  });

  it("a write into a place that does not exist fails without throwing", () => {
    const blocked = path.join(dir, "blocked");
    fs.writeFileSync(blocked, "x");
    assert.equal(saveExecutorAttempts(path.join(blocked, "data"), ["a#1"]), false);
  });
});

describe("what holds the job executor back", () => {
  it("a stop does, an unknown state does only while the watch of the physical stop is on, a ready state never", () => {
    assert.equal(holdsBack({ state: "STOPPED" }, false), "the server is stopped");
    assert.equal(holdsBack({ state: "STOPPED" }, true), "the server is stopped");
    assert.match(holdsBack({ state: "UNKNOWN" }, true) ?? "", /not known/);
    assert.equal(holdsBack({ state: "UNKNOWN" }, false), null, "with the watch off the physical part is always unknown, which holds nothing back");
    assert.equal(holdsBack({ state: "READY" }, true), null);
    assert.equal(holdsBack({ state: "READY" }, false), null);
  });
});
