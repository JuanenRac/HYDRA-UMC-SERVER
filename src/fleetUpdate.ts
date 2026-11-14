// =============================================================================
// HYDRA-UMC-SERVER - src/fleetUpdate.ts
// Copyright (C) 2026 JuanenRac (Electro Hobby 3D) <electrohobby3d@gmail.com>
// GPL-3.0-or-later - see LICENSE
// =============================================================================
// Updating every program installed on the device from Studio (GET /api/admin/fleet-update and its POSTs). The work is done by tools/fleet_update.py of
// HYDRA-UMC-OS: it looks at the device, orders the programs by their dependencies, keeps a copy of each, installs the newest release with the installer of the
// program, checks it and puts the earlier program back when it does not hold, one program at a time and stopping at the first failure. This module only
//  * asks it for the plan (`plan`, a look: nothing changes),
//  * starts it DETACHED for the programs that were asked (`run --yes --only ...`) or for one that was cut (`resume`), with its output in a file, because the
//    last program is this server and restarting it kills whatever it started,
//  * and reads the progress file the tool writes (`hydra-fleet-update/1`), telling a run that stopped writing (heartbeat older than a minute) from one that goes on.
// A name is checked against the plan before it reaches the command, the command has no shell, one run goes at a time, and nothing here restarts the machine.
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { launcherWith, type Launcher } from "./selfUpdate";

export const FLEET_SCHEMA = "hydra-fleet-update/1";
export const FLEET_STALE_SECONDS = 60;
export const FLEET_PLAN_MAX_AGE_SECONDS = 30 * 60;
/** How long after the start of the tool its file may still be the one from before: past this, a tool that left no trace did not start. */
export const FLEET_START_GRACE_SECONDS = 20;
const NAME = /^[a-z][a-z0-9-]{0,40}$/;
const OUTPUT_LIMIT = 64 * 1024;

export class FleetUpdateError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
    this.name = "FleetUpdateError";
  }
}

export interface FleetFile {
  tool?: unknown;
  python?: unknown;
  stateFile?: unknown;
}

export interface FleetSettings { tool: string; python: string; stateFile: string }

export function fleetSettings(file: FleetFile | undefined, dataPath: string, home: string = os.homedir()): FleetSettings {
  const text = (value: unknown, fallback: string) => (typeof value === "string" && value.trim() && !value.includes("\0") ? value.trim() : fallback);
  return {
    tool: text(file?.tool, path.join(home, "hydra-umc", "HYDRA-UMC-OS", "tools", "fleet_update.py")),
    python: text(file?.python, "python3"),
    stateFile: path.resolve(dataPath, text(file?.stateFile, path.join("fleet-update", "state.json"))),
  };
}

export type RowAction = "update" | "current" | "skip" | "review";
export type RowState = "waiting" | "running" | "done" | "failed" | "rolled_back" | "interrupted" | "skipped" | "blocked";
export type FleetState = "planned" | "running" | "done" | "failed" | "blocked" | "interrupted";

export interface FleetRow {
  name: string; kind: "repo" | "svc" | "frontend"; repo: string; installed: string | null; latest: string | null; action: RowAction; reason: string; state: RowState;
  step: string; substep: string; substeps: number; detail: string; error: string; order: number; elapsedS: number; freeMb: number | null; needMb: number | null; unitRestored: boolean | null;
  log: Array<{ at: string; text: string }>;
}

export interface FleetReport {
  schema: string; id: string; mode: "plan" | "run"; state: FleetState; startedAt: string; updatedAt: string; error: string; stoppedAt: string; requireSignedTags: boolean;
  disk: { rootFreeMb: number | null; workspaceFreeMb: number | null }; services: FleetRow[];
}

const text = (value: unknown, max = 300): string => (typeof value === "string" ? value.slice(0, max) : "");
const whole = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : null);
const ACTIONS: readonly string[] = ["update", "current", "skip", "review"];
const ROW_STATES: readonly string[] = ["waiting", "running", "done", "failed", "rolled_back", "interrupted", "skipped", "blocked"];
const FLEET_STATES: readonly string[] = ["planned", "running", "done", "failed", "blocked", "interrupted"];

/** The file of the tool, cut down to the fields Studio shows (anything else in it is not forwarded), or null when it is not one. */
export function parseFleetReport(raw: unknown): FleetReport | null {
  if (typeof raw !== "object" || raw === null) return null;
  const body = raw as Record<string, unknown>;
  if (body.schema !== FLEET_SCHEMA || !Array.isArray(body.services) || !FLEET_STATES.includes(String(body.state))) return null;
  const rows: FleetRow[] = [];
  for (const item of body.services) {
    const r = (typeof item === "object" && item !== null ? item : {}) as Record<string, unknown>;
    if (typeof r.name !== "string" || !NAME.test(r.name) || !ACTIONS.includes(String(r.action)) || !ROW_STATES.includes(String(r.state))) continue;
    rows.push({
      name: r.name, kind: r.kind === "repo" || r.kind === "frontend" ? r.kind : "svc", repo: text(r.repo, 80), installed: typeof r.installed === "string" ? r.installed.slice(0, 40) : null,
      latest: typeof r.latest === "string" ? r.latest.slice(0, 40) : null, action: r.action as RowAction, reason: text(r.reason, 60), state: r.state as RowState, step: text(r.step, 30),
      substep: text(r.substep, 40), substeps: whole(r.substeps) ?? 0, detail: text(r.detail, 200), error: text(r.error, 40), order: whole(r.order) ?? rows.length, elapsedS: whole(r.elapsedS) ?? 0,
      freeMb: whole(r.freeMb), needMb: whole(r.needMb), unitRestored: typeof r.unitRestored === "boolean" ? r.unitRestored : null,
      log: Array.isArray(r.log) ? r.log.slice(-30).map((l) => ({ at: text((l as Record<string, unknown>)?.at, 30), text: text((l as Record<string, unknown>)?.text, 300) })) : [],
    });
  }
  const disk = (typeof body.disk === "object" && body.disk !== null ? body.disk : {}) as Record<string, unknown>;
  return {
    schema: FLEET_SCHEMA, id: text(body.id, 40), mode: body.mode === "run" ? "run" : "plan", state: body.state as FleetState, startedAt: text(body.startedAt, 30), updatedAt: text(body.updatedAt, 30),
    error: text(body.error, 60), stoppedAt: text(body.stoppedAt, 60), requireSignedTags: body.requireSignedTags === true,
    disk: { rootFreeMb: whole(disk.rootFreeMb), workspaceFreeMb: whole(disk.workspaceFreeMb) }, services: rows,
  };
}

/** A run that says "running" but whose heartbeat stopped is a run that was cut: the program in its steps is `interrupted`, whatever the file still says. */
export function withInterruption(report: FleetReport, heartbeatAgeSeconds: number | null): FleetReport {
  if (report.state !== "running" || (heartbeatAgeSeconds !== null && heartbeatAgeSeconds < FLEET_STALE_SECONDS)) return report;
  return {
    ...report, state: "interrupted", error: "interrupted",
    services: report.services.map((row) => (row.state === "running" ? { ...row, state: "interrupted" as const, error: "interrupted", detail: `cut at the step ${row.step || "?"}` } : row)),
  };
}

export type ToolRunner = (file: string, args: string[], timeoutMs: number) => Promise<{ exitCode: number; stdout: string; stderr: string; timedOut: boolean }>;

export const defaultToolRunner: ToolRunner = (file, args, timeoutMs) =>
  new Promise((resolve) => {
    execFile(file, args, { timeout: timeoutMs, maxBuffer: 4 * OUTPUT_LIMIT, shell: false, windowsHide: true }, (error, stdout, stderr) => {
      const code = error ? (typeof (error as { code?: unknown }).code === "number" ? (error as { code: number }).code : 1) : 0;
      resolve({ exitCode: code, stdout: String(stdout ?? ""), stderr: String(stderr ?? ""), timedOut: Boolean(error && (error as { killed?: boolean }).killed) });
    });
  });

export interface FleetDeps {
  settings: () => FleetSettings;
  runnerPrefix: () => string[];
  dataPath: string;
  runTool?: ToolRunner;
  launch?: (prefix: string[], job: string) => Launcher;
  now?: () => number;
  newId?: () => string;
}

export class FleetUpdate {
  private readonly deps: FleetDeps;
  private planning = false;
  private launchedAt = 0;
  private lastLaunch: { at: number; outFile: string; seen: string } | null = null;

  constructor(deps: FleetDeps) {
    this.deps = deps;
  }

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }

  private heartbeatFile(): string {
    return `${this.deps.settings().stateFile}.hb`;
  }

  /** The progress file, or null when no plan was ever made. */
  read(): FleetReport | null {
    let raw: unknown;
    try { raw = JSON.parse(fs.readFileSync(this.deps.settings().stateFile, "utf8")); } catch { return null; }
    const report = parseFleetReport(raw);
    if (!report) return null;
    let age: number | null = null;
    try { age = (this.now() - fs.statSync(this.heartbeatFile()).mtimeMs) / 1000; } catch { age = null; }
    return this.withoutStart(withInterruption(report, age));
  }

  /**
   * A tool that was started here but left no trace (no program, no file of the earlier plan rewritten, no beat of its own) did not start: the file would
   * keep saying "planned" for ever. It is told as interrupted, with the last line the process printed, so that Studio does not wait for a run that is not there.
   */
  private withoutStart(report: FleetReport): FleetReport {
    const launch = this.lastLaunch;
    if (!launch || report.state === "running" || this.now() - launch.at < FLEET_START_GRACE_SECONDS * 1000) return report;
    if (this.trace() !== launch.seen) return report;
    let last = "";
    try { last = fs.readFileSync(launch.outFile, "utf8").trim().split(/\r?\n/).slice(-1)[0] ?? ""; } catch { /* nothing written */ }
    return { ...report, state: "interrupted", error: "interrupted", stoppedAt: (last || "the tool did not start").slice(0, 60) };
  }

  /** What the two files of the tool looked like (modification time and size): it changes as soon as the tool writes anything. */
  private trace(): string {
    const stamp = (file: string): string => { try { const s = fs.statSync(file); return `${s.mtimeMs}:${s.size}`; } catch { return "-"; } };
    return `${stamp(this.deps.settings().stateFile)}|${stamp(this.heartbeatFile())}`;
  }

  get busy(): boolean {
    return this.planning || this.now() - this.launchedAt < 15_000 || this.read()?.state === "running";
  }

  /** Looks at the device and at the newest releases; nothing is changed. */
  async plan(): Promise<FleetReport> {
    if (this.busy) throw new FleetUpdateError(409, "Another look or update is going on");
    const settings = this.deps.settings();
    this.planning = true;
    try {
      fs.mkdirSync(path.dirname(settings.stateFile), { recursive: true, mode: 0o700 });
      const done = await (this.deps.runTool ?? defaultToolRunner)(settings.python, [settings.tool, "plan", "--state", settings.stateFile], 5 * 60_000);
      if (done.exitCode !== 0 || done.timedOut) throw new FleetUpdateError(502, done.timedOut ? "The look took too long" : (done.stderr.trim().split("\n").slice(-1)[0] || "The look failed").slice(0, 200));
    } finally {
      this.planning = false;
    }
    const report = this.read();
    if (!report) throw new FleetUpdateError(502, "The tool did not leave a plan");
    return report;
  }

  /** Starts the update of the programs asked for (all the ones the plan marks to update when none is named). The tool runs detached and keeps its progress in the file. */
  async apply(names: unknown): Promise<FleetReport> {
    const report = this.read();
    if (!report) throw new FleetUpdateError(409, "Look first: there is no plan");
    if (this.busy) throw new FleetUpdateError(409, "Another look or update is going on");
    if (report.state === "planned" && (this.now() - Date.parse(report.updatedAt)) / 1000 > FLEET_PLAN_MAX_AGE_SECONDS) throw new FleetUpdateError(409, "The plan is old: look again first");
    const wanted = this.validNames(names, report, (row) => row.action === "update");
    if (wanted.length === 0) throw new FleetUpdateError(409, "There is nothing to update");
    return this.launch(["run", "--yes", "--only", wanted.join(",")]);
  }

  /** Takes up a program whose step was cut, from its first step. */
  async resume(name: unknown): Promise<FleetReport> {
    const report = this.read();
    if (!report) throw new FleetUpdateError(409, "Look first: there is no plan");
    if (this.busy) throw new FleetUpdateError(409, "Another look or update is going on");
    const wanted = this.validNames([name], report, (row) => row.state === "interrupted" || row.state === "failed" || row.state === "rolled_back" || row.state === "blocked");
    if (wanted.length !== 1) throw new FleetUpdateError(409, "That program has nothing to take up");
    return this.launch(["resume", "--yes", "--only", wanted[0]]);
  }

  private validNames(names: unknown, report: FleetReport, fits: (row: FleetRow) => boolean): string[] {
    if (names === undefined || names === null) return report.services.filter(fits).map((row) => row.name);
    if (!Array.isArray(names) || names.length === 0 || names.length > 60 || !names.every((n) => typeof n === "string" && NAME.test(n))) throw new FleetUpdateError(400, "services must be a list of names of programs");
    const known = new Map(report.services.map((row) => [row.name, row]));
    const chosen = [...new Set(names as string[])];
    for (const n of chosen) {
      const row = known.get(n);
      if (!row) throw new FleetUpdateError(400, `${n} is not in the plan`);
      if (!fits(row)) throw new FleetUpdateError(409, `${n} has nothing to take up`);
    }
    return chosen;
  }

  private async launch(args: string[]): Promise<FleetReport> {
    const settings = this.deps.settings();
    const id = (this.deps.newId ?? (() => `${this.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`))();
    const folder = path.dirname(settings.stateFile);
    fs.mkdirSync(folder, { recursive: true, mode: 0o700 });
    const outFile = path.join(folder, `run-${id}.out`);
    fs.writeFileSync(outFile, "", { mode: 0o600 });
    // A fresh heartbeat so that the file is not read as cut in the second before the tool writes its own.
    fs.writeFileSync(this.heartbeatFile(), String(this.now() / 1000), { mode: 0o600 });
    this.launchedAt = this.now();
    this.lastLaunch = { at: this.launchedAt, outFile, seen: this.trace() };
    await (this.deps.launch ?? launcherWith)(this.deps.runnerPrefix(), id)({ file: settings.python, args: [settings.tool, args[0], "--state", settings.stateFile, ...args.slice(1)], outFile });
    const report = this.read();
    if (!report) throw new FleetUpdateError(502, "The tool did not leave a file");
    return { ...report, state: "running" };
  }
}
