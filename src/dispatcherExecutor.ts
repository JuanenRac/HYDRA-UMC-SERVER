// =============================================================================
// HYDRA-UMC-SERVER - src/dispatcherExecutor.ts
// Copyright (C) 2026 JuanenRac (Electro Hobby 3D) <electrohobby3d@gmail.com>
// GPL-3.0-or-later - see LICENSE
// =============================================================================
// The execution of the jobs that the job dispatcher assigns to a robot of this server. The dispatcher decides WHO does a job and keeps no content for it
// (a job has a priority, a tool, a location and dependencies); something has to turn "robot 3 has job J" into motion and say when it is done. This server
// owns the robots, their stop, their claims and their recorded trajectory, so it does that, in the narrowest way there is:
//
//   1. read the jobs the dispatcher has assigned (GET /jobs?status=assigned);
//   2. for a job whose robot is one of the robot map (dispatcher id -> robot id of this server, the same map as the stop relay and the registrar), start the
//      server playback of that robot's own recorded trajectory, the same "play" as the command of the person, only when nothing holds it back: the server
//      is not stopped (global or physical), not in read-only mode, the robot is enabled and not reserved by a person, has a trajectory, is not already playing and its id is not shared
//      with another robot, and no other job of this executor is running on it;
//   3. when the playback ends by itself (the robot's playbackState says it finished), report the job as done (POST /jobs/complete with the robot and the
//      attempt, so the report of an abandoned attempt can never close a newer one). A playback that was stopped by a person, a job that left the assigned
//      list (cancelled or given to another robot) or a run that takes longer than `maxRunSeconds` is NEVER reported as done: a running robot is stopped
//      when its job is gone, and the rest is left to the dispatcher (its own stale-job detection and requeue).
//
// Everything is off until `jobDispatcher.executor.enabled` (data/server-config.json) or HYDRA_UMC_JOB_EXECUTOR=1 says so (the environment wins), and even
// then it starts in DRY RUN: it reads, decides and audits "would start", and moves nothing and completes nothing, until `jobDispatcher.executor.dryRun` is
// false or HYDRA_UMC_JOB_EXECUTOR_LIVE=1. `jobDispatcher.executor.tools` limits it to the jobs of those tools. The address of the dispatcher and its token are
// those of the stop relay. The clock, the HTTP client and the timers are injected, so the whole behaviour is tested with simulated time.

import { robotIdConflicts } from "./robotIds";
import { identityHeader } from "./serviceIdentity";

export const EXECUTOR_DEFAULTS = {
  pollSeconds: 5,
  requestTimeoutMs: 3000,
  maxFailureBackoffSeconds: 300,
  maxRunSeconds: 3600,
} as const;

export interface ExecutorFile {
  enabled?: unknown;
  /** True (the default): decide and audit only. False: really start the robots and complete the jobs. */
  dryRun?: unknown;
  url?: unknown;
  pollSeconds?: unknown;
  requestTimeoutMs?: unknown;
  maxFailureBackoffSeconds?: unknown;
  /** A run that lasts longer is given up (not reported as done) and stays with the dispatcher. */
  maxRunSeconds?: unknown;
  /** Only the jobs whose required tool is in this list are executed; without the key every tool is. */
  tools?: unknown;
}

export interface ExecutorSettings {
  enabled: boolean;
  dryRun: boolean;
  url: string;
  token: string;
  pollSeconds: number;
  requestTimeoutMs: number;
  maxFailureBackoffSeconds: number;
  maxRunSeconds: number;
  tools: string[] | null;
}

export interface ExecutorEnv {
  HYDRA_UMC_JOB_EXECUTOR?: string;
  HYDRA_UMC_JOB_EXECUTOR_LIVE?: string;
  HYDRA_UMC_JOB_DISPATCHER_URL?: string;
  HYDRA_UMC_JOB_DISPATCHER_TOKEN?: string;
}

export type ExecutorResolution = { ok: true; settings: ExecutorSettings } | { ok: false; error: string };

function inRange(value: unknown, name: string, min: number, max: number, fallback: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) {
    throw new Error(`jobDispatcher.executor.${name} must be a number from ${min} to ${max}`);
  }
  return value;
}

/** Reads the switches, the address and the limits. A wrong value is an error (the executor does not start), never a silent default. */
export function resolveExecutor(env: ExecutorEnv, file: ExecutorFile | undefined, fileUrl?: unknown): ExecutorResolution {
  try {
    if (file?.enabled !== undefined && typeof file.enabled !== "boolean") throw new Error("jobDispatcher.executor.enabled must be true or false");
    if (file?.dryRun !== undefined && typeof file.dryRun !== "boolean") throw new Error("jobDispatcher.executor.dryRun must be true or false");
    let tools: string[] | null = null;
    if (file?.tools !== undefined) {
      if (!Array.isArray(file.tools) || file.tools.some((tool) => typeof tool !== "string")) throw new Error("jobDispatcher.executor.tools must be a list of texts");
      tools = file.tools as string[];
    }
    const raw = (env.HYDRA_UMC_JOB_EXECUTOR ?? "").trim();
    const enabled = raw !== "" ? raw === "1" : file?.enabled === true;
    const live = (env.HYDRA_UMC_JOB_EXECUTOR_LIVE ?? "").trim();
    const dryRun = live !== "" ? live !== "1" : file?.dryRun !== false;
    const ownUrl = typeof file?.url === "string" ? file.url : typeof fileUrl === "string" ? fileUrl : "";
    const url = (env.HYDRA_UMC_JOB_DISPATCHER_URL ?? ownUrl).trim().replace(/\/+$/, "");
    const settings: ExecutorSettings = {
      enabled,
      dryRun,
      url,
      token: env.HYDRA_UMC_JOB_DISPATCHER_TOKEN ?? "",
      pollSeconds: inRange(file?.pollSeconds, "pollSeconds", 1, 86400, EXECUTOR_DEFAULTS.pollSeconds),
      requestTimeoutMs: inRange(file?.requestTimeoutMs, "requestTimeoutMs", 100, 60000, EXECUTOR_DEFAULTS.requestTimeoutMs),
      maxFailureBackoffSeconds: inRange(file?.maxFailureBackoffSeconds, "maxFailureBackoffSeconds", 1, 86400, EXECUTOR_DEFAULTS.maxFailureBackoffSeconds),
      maxRunSeconds: inRange(file?.maxRunSeconds, "maxRunSeconds", 1, 604800, EXECUTOR_DEFAULTS.maxRunSeconds),
      tools,
    };
    if (enabled && url === "") throw new Error("the executor is on but no dispatcher address is set (HYDRA_UMC_JOB_DISPATCHER_URL or jobDispatcher.executor.url)");
    return { ok: true, settings };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "invalid executor settings" };
  }
}

/** One assigned job as the dispatcher lists it, whichever way it names the fields (the Go names or the camelCase ones). */
export interface AssignedJob {
  id: string;
  robot: string;
  attempt: number;
  tool: string;
}

export function assignedJobs(list: unknown): AssignedJob[] {
  const jobs: AssignedJob[] = [];
  if (!Array.isArray(list)) return jobs;
  for (const entry of list) {
    if (typeof entry !== "object" || entry === null) continue;
    const e = entry as Record<string, unknown>;
    const pick = (a: string, b: string) => (typeof e[a] === "string" ? (e[a] as string) : typeof e[b] === "string" ? (e[b] as string) : "");
    const id = pick("id", "ID");
    const robot = pick("assignedRobot", "AssignedRobot");
    const attemptRaw = typeof e.attempt === "number" ? e.attempt : typeof e.Attempt === "number" ? e.Attempt : 0;
    const status = pick("status", "Status");
    if (id === "" || robot === "" || (status !== "" && status !== "assigned")) continue;
    jobs.push({ id, robot, attempt: Number.isInteger(attemptRaw) && attemptRaw >= 0 ? attemptRaw : 0, tool: pick("requiredTool", "RequiredTool") });
  }
  return jobs;
}

/** What the executor needs to know about a robot of this server. */
export interface RobotRunState {
  enabled: boolean;
  /** A person holds a reservation on the robot: an automatic start never takes a robot from a person. */
  reserved: boolean;
  hasTrajectory: boolean;
  playing: boolean;
  /** The playback reached its end by itself (not stopped by anyone). */
  finished: boolean;
}

export interface ExecutorDeps {
  settings: ExecutorSettings;
  fetch: (url: string, init: { method: string; headers: Record<string, string>; body?: string; signal: AbortSignal }) => Promise<{ status: number; json: () => Promise<unknown> }>;
  /** The settings tree of the server, read at every pass (a robot id may become ambiguous). */
  getSettings: () => unknown;
  /** The robot map (dispatcher id -> robot id of this server), read at every pass. */
  robotMap: () => Record<string, number>;
  now: () => number;
  /** A reason why nothing may be started now (a stop, the read-only mode), or null. */
  gate: () => string | null;
  /** null when the robot is not in this server. */
  robotState: (robotId: number) => RobotRunState | null;
  /** Starts the playback of the trajectory of the robot, like the command "play". False when it could not. */
  startRobot: (robotId: number) => boolean | Promise<boolean>;
  /** Stops the robot, like the command "stop". */
  stopRobot: (robotId: number) => boolean | Promise<boolean>;
  log: (line: string) => void;
  audit?: (event: { type: string; outcome: "ok" | "failed" | "refused"; robotId?: number; detail: Record<string, unknown> }) => void;
}

export interface ExecutorReport {
  read: boolean;
  /** Started in this pass. */
  started: string[];
  /** Dry run: would have been started. */
  would: string[];
  /** Reported as done to the dispatcher. */
  completed: string[];
  /** Given up or stopped because the job is gone. */
  stopped: string[];
  skipped: { jobId: string; reason: string }[];
}

interface Run {
  jobId: string;
  attempt: number;
  dispatcherRobot: string;
  robotId: number;
  startedMs: number;
  /** After a give-up or an interruption the run is kept so that the job is not started again by this executor. */
  closed: boolean;
}

export class DispatcherExecutor {
  private failures = 0;
  private timer: unknown = null;
  private running = false;
  private readonly runs = new Map<string, Run>();
  private readonly wouldSeen = new Set<string>();
  /** The attempts already reported as done: the list of the dispatcher can still show them for a moment, and they must not be started again. */
  private readonly reported = new Set<string>();

  constructor(private readonly deps: ExecutorDeps) {}

  private async call(method: string, path: string, body?: unknown): Promise<{ status: number; json: unknown }> {
    const { settings } = this.deps;
    const controller = new AbortController();
    const abort = setTimeout(() => controller.abort(), settings.requestTimeoutMs);
    try {
      const headers: Record<string, string> = { Accept: "application/json" };
      if (settings.token) headers.Authorization = `Bearer ${settings.token}`;
      else Object.assign(headers, identityHeader("operator"));
      if (body !== undefined) headers["Content-Type"] = "application/json";
      const answer = await this.deps.fetch(settings.url + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: controller.signal });
      let json: unknown = null;
      try {
        json = await answer.json();
      } catch {
        json = null;
      }
      return { status: answer.status, json };
    } finally {
      clearTimeout(abort);
    }
  }

  private static key(job: { id: string; attempt: number }): string {
    return `${job.id}#${job.attempt}`;
  }

  /** The robots this executor is running a job on. */
  private busyRobots(): Set<number> {
    const busy = new Set<number>();
    for (const run of this.runs.values()) if (!run.closed) busy.add(run.robotId);
    return busy;
  }

  /** One pass. Never throws. */
  async pass(): Promise<ExecutorReport> {
    const { settings, log, audit } = this.deps;
    const report: ExecutorReport = { read: false, started: [], would: [], completed: [], stopped: [], skipped: [] };
    let jobs: AssignedJob[];
    try {
      const answer = await this.call("GET", "/jobs?status=assigned");
      if (answer.status !== 200 || !Array.isArray(answer.json)) throw new Error(`the dispatcher answered ${answer.status}`);
      jobs = assignedJobs(answer.json);
    } catch (error) {
      this.failures += 1;
      log(`[job-executor] the assigned jobs could not be read (${error instanceof Error ? error.message : "unknown error"}); ${this.failures} in a row`);
      return report;
    }
    this.failures = 0;
    report.read = true;
    const now = this.deps.now();
    const map = this.deps.robotMap();
    const ambiguous = new Set(robotIdConflicts(this.deps.getSettings()).map((conflict) => String(conflict.robotId)));
    const listed = new Set(jobs.map((job) => DispatcherExecutor.key(job)));
    for (const key of [...this.reported]) if (!listed.has(key)) this.reported.delete(key);

    // 1. the runs whose job is no longer assigned: a robot still moving for a job that is gone is stopped
    for (const [key, run] of [...this.runs]) {
      if (listed.has(key)) continue;
      this.runs.delete(key);
      if (run.closed) continue;
      const state = this.deps.robotState(run.robotId);
      if (state?.playing && !settings.dryRun) {
        const stopped = (await this.deps.stopRobot(run.robotId)) === true;
        log(`[job-executor] job ${run.jobId} is no longer assigned: robot ${run.robotId} ${stopped ? "stopped" : "could not be stopped"}`);
        audit?.({ type: "job-executor", outcome: stopped ? "ok" : "failed", robotId: run.robotId, detail: { jobId: run.jobId, action: "stop-job-gone" } });
        if (stopped) report.stopped.push(run.jobId);
      }
    }

    for (const job of jobs) {
      const key = DispatcherExecutor.key(job);
      const run = this.runs.get(key);
      if (run) {
        await this.follow(run, now, report);
        continue;
      }
      if (this.reported.has(key)) continue;
      const reason = this.refusal(job, map, ambiguous);
      if (reason !== null) {
        report.skipped.push({ jobId: job.id, reason });
        continue;
      }
      const robotId = map[job.robot] as number;
      if (settings.dryRun) {
        if (!this.wouldSeen.has(key)) {
          this.wouldSeen.add(key);
          log(`[job-executor] DRY RUN: job ${job.id} (attempt ${job.attempt}) would start the trajectory of robot ${robotId}`);
          audit?.({ type: "job-executor", outcome: "ok", robotId, detail: { jobId: job.id, attempt: job.attempt, action: "would-start", dryRun: true } });
        }
        report.would.push(job.id);
        continue;
      }
      let started = false;
      try {
        started = (await this.deps.startRobot(robotId)) === true;
      } catch {
        started = false;
      }
      if (!started) {
        report.skipped.push({ jobId: job.id, reason: "the robot could not be started" });
        audit?.({ type: "job-executor", outcome: "failed", robotId, detail: { jobId: job.id, attempt: job.attempt, action: "start" } });
        continue;
      }
      this.runs.set(key, { jobId: job.id, attempt: job.attempt, dispatcherRobot: job.robot, robotId, startedMs: now, closed: false });
      report.started.push(job.id);
      log(`[job-executor] job ${job.id} (attempt ${job.attempt}) started on robot ${robotId}`);
      audit?.({ type: "job-executor", outcome: "ok", robotId, detail: { jobId: job.id, attempt: job.attempt, action: "start" } });
    }
    return report;
  }

  /** Why a job is not started now, or null when it can be. */
  private refusal(job: AssignedJob, map: Record<string, number>, ambiguous: Set<string>): string | null {
    const { settings } = this.deps;
    if (settings.tools !== null && !settings.tools.includes(job.tool)) return "the tool of the job is not in the list of the executor";
    if (!Object.prototype.hasOwnProperty.call(map, job.robot)) return "the robot of the job is not in the robot map";
    const robotId = map[job.robot] as number;
    if (ambiguous.has(String(robotId))) return "the robot id is shared with another robot";
    const gate = this.deps.gate();
    if (gate !== null) return gate;
    const state = this.deps.robotState(robotId);
    if (state === null) return "the robot is not in this server";
    if (!state.enabled) return "the robot is disabled";
    if (state.reserved) return "a person has reserved the robot";
    if (!state.hasTrajectory) return "the robot has no recorded trajectory";
    if (state.playing) return "the robot is already playing";
    if (this.busyRobots().has(robotId)) return "another job of the executor is running on the robot";
    return null;
  }

  /** A job the executor already started: done, interrupted, too long, or still running. */
  private async follow(run: Run, now: number, report: ExecutorReport): Promise<void> {
    const { settings, log, audit } = this.deps;
    if (run.closed) return;
    const state = this.deps.robotState(run.robotId);
    if (state?.finished && !state.playing) {
      try {
        const answer = await this.call("POST", "/jobs/complete", { id: run.jobId, success: true, robotId: run.dispatcherRobot, attempt: run.attempt });
        if (answer.status === 200) {
          this.runs.delete(DispatcherExecutor.key(run));
          this.reported.add(DispatcherExecutor.key(run));
          report.completed.push(run.jobId);
          log(`[job-executor] job ${run.jobId} done on robot ${run.robotId}`);
          audit?.({ type: "job-executor", outcome: "ok", robotId: run.robotId, detail: { jobId: run.jobId, attempt: run.attempt, action: "complete" } });
        } else {
          // The dispatcher refused (a newer attempt, a job it no longer has): the run is closed, the answer is not asked again
          run.closed = true;
          report.skipped.push({ jobId: run.jobId, reason: `the dispatcher answered ${answer.status} to the report` });
          audit?.({ type: "job-executor", outcome: "refused", robotId: run.robotId, detail: { jobId: run.jobId, attempt: run.attempt, action: "complete", answer: answer.status } });
        }
      } catch (error) {
        this.failures += 1;
        log(`[job-executor] the end of job ${run.jobId} could not be reported (${error instanceof Error ? error.message : "unknown error"}); it is tried again`);
      }
      return;
    }
    if (!state || (!state.playing && !state.finished)) {
      run.closed = true;
      log(`[job-executor] job ${run.jobId}: the playback of robot ${run.robotId} ended without finishing; the job is left to the dispatcher`);
      audit?.({ type: "job-executor", outcome: "failed", robotId: run.robotId, detail: { jobId: run.jobId, attempt: run.attempt, action: "interrupted" } });
      return;
    }
    if (now - run.startedMs > settings.maxRunSeconds * 1000) {
      run.closed = true;
      const stopped = (await this.deps.stopRobot(run.robotId)) === true;
      report.stopped.push(run.jobId);
      log(`[job-executor] job ${run.jobId} ran longer than ${settings.maxRunSeconds} s: robot ${run.robotId} ${stopped ? "stopped" : "could not be stopped"}, the job is left to the dispatcher`);
      audit?.({ type: "job-executor", outcome: stopped ? "ok" : "failed", robotId: run.robotId, detail: { jobId: run.jobId, attempt: run.attempt, action: "too-long" } });
    }
  }

  /** Seconds to wait before the next pass: the poll period, doubled after each failure up to the configured limit. */
  nextDelaySeconds(): number {
    const { pollSeconds, maxFailureBackoffSeconds } = this.deps.settings;
    if (this.failures === 0) return pollSeconds;
    return Math.min(pollSeconds * 2 ** Math.min(this.failures, 20), Math.max(maxFailureBackoffSeconds, pollSeconds));
  }

  start(timers: { set: (fn: () => void, ms: number) => unknown; clear: (handle: unknown) => void }): void {
    if (this.running) return;
    this.running = true;
    const tick = () => {
      this.timer = null;
      void this.pass().finally(() => {
        if (this.running) this.timer = timers.set(tick, this.nextDelaySeconds() * 1000);
      });
    };
    this.timer = timers.set(tick, 0);
    this.stopTimers = () => {
      if (this.timer !== null) timers.clear(this.timer);
      this.timer = null;
    };
  }

  private stopTimers: () => void = () => undefined;

  stop(): void {
    this.running = false;
    this.stopTimers();
  }
}
