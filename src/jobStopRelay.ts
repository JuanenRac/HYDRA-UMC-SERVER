// =============================================================================
// HYDRA-UMC-SERVER - src/jobStopRelay.ts
// Copyright (C) 2026 JuanenRac (Electro Hobby 3D) <electrohobby3d@gmail.com>
// GPL-3.0-or-later - see LICENSE
// =============================================================================
// The delivery of the stop that the job dispatcher asks for. When a robot goes silent and has declared that it can confirm a
// stop, the dispatcher does not give its job to another robot: it records a stop request (GET /jobs/stop-requests) and waits
// for an acknowledgement (POST /jobs/stop-ack). Something has to carry the request to the robot and carry the answer back; this
// server owns the robots and their stop, so it does both:
//
//   1. read the open requests of the dispatcher;
//   2. stop the robot that the request names (the same stop as POST /api/robot/:id/command "stop", which no claim can hold back);
//   3. only when that stop was applied, acknowledge it. A stop that could not be applied is never acknowledged: the dispatcher then
//      keeps the job `unknown` (or, with its own `allow_unconfirmed` switch, reassigns it on its own responsibility).
//
// Everything is off until `jobDispatcher.stopRelay.enabled` (data/server-config.json) or HYDRA_UMC_JOB_STOP_RELAY=1 says so (the
// environment wins). Every time and limit is a parameter of that file, never a constant of the code; the address of the dispatcher
// and its token come from the environment (HYDRA_UMC_JOB_DISPATCHER_URL, HYDRA_UMC_JOB_DISPATCHER_TOKEN): a token is never kept in the
// settings file. The clock, the HTTP client and the timers are injected, so the whole behaviour is tested with simulated time.

import { identityHeader } from "./serviceIdentity";

export const STOP_RELAY_DEFAULTS = {
  pollSeconds: 2,
  requestTimeoutMs: 3000,
  maxRequestAgeSeconds: 120,
  maxFailureBackoffSeconds: 60,
} as const;

export interface StopRelayFile {
  enabled?: unknown;
  url?: unknown;
  /** Seconds between two reads of the stop requests. */
  pollSeconds?: unknown;
  /** The longest wait for one answer of the dispatcher. */
  requestTimeoutMs?: unknown;
  /** A request older than this is not delivered any more (the dispatcher has decided by then): a late stop of a robot that moved on is not wanted. */
  maxRequestAgeSeconds?: unknown;
  /** After a failed read the pause doubles up to this many seconds. */
  maxFailureBackoffSeconds?: unknown;
  /** The robot id the dispatcher uses -> the id of the robot in this server. A robot that is not here is never stopped nor acknowledged. */
  robotMap?: unknown;
}

export interface StopRelaySettings {
  enabled: boolean;
  url: string;
  token: string;
  pollSeconds: number;
  requestTimeoutMs: number;
  maxRequestAgeSeconds: number;
  maxFailureBackoffSeconds: number;
  robotMap: Record<string, number>;
}

export interface StopRelayEnv {
  HYDRA_UMC_JOB_STOP_RELAY?: string;
  HYDRA_UMC_JOB_DISPATCHER_URL?: string;
  HYDRA_UMC_JOB_DISPATCHER_TOKEN?: string;
}

export type StopRelayResolution = { ok: true; settings: StopRelaySettings } | { ok: false; error: string };

function inRange(value: unknown, name: string, min: number, max: number, fallback: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) {
    throw new Error(`jobDispatcher.stopRelay.${name} must be a number from ${min} to ${max}`);
  }
  return value;
}

/** Reads the switch, the address and the limits. A wrong value is an error (the relay does not start), never a silent default: a stop must not depend on a typing mistake. */
export function resolveStopRelay(env: StopRelayEnv, file: StopRelayFile | undefined): StopRelayResolution {
  try {
    const raw = (env.HYDRA_UMC_JOB_STOP_RELAY ?? "").trim();
    const enabled = raw !== "" ? raw === "1" : file?.enabled === true;
    if (file?.enabled !== undefined && typeof file.enabled !== "boolean") throw new Error("jobDispatcher.stopRelay.enabled must be true or false");
    const url = (env.HYDRA_UMC_JOB_DISPATCHER_URL ?? (typeof file?.url === "string" ? file.url : "")).trim().replace(/\/+$/, "");
    const robotMap: Record<string, number> = {};
    if (file?.robotMap !== undefined) {
      if (typeof file.robotMap !== "object" || file.robotMap === null || Array.isArray(file.robotMap)) throw new Error("jobDispatcher.stopRelay.robotMap must be an object");
      for (const [dispatcherId, serverId] of Object.entries(file.robotMap)) {
        if (!Number.isInteger(serverId) || (serverId as number) < 0) throw new Error(`jobDispatcher.stopRelay.robotMap: "${dispatcherId}" must map to a robot id of this server`);
        robotMap[dispatcherId] = serverId as number;
      }
    }
    const settings: StopRelaySettings = {
      enabled,
      url,
      token: env.HYDRA_UMC_JOB_DISPATCHER_TOKEN ?? "",
      pollSeconds: inRange(file?.pollSeconds, "pollSeconds", 0.5, 3600, STOP_RELAY_DEFAULTS.pollSeconds),
      requestTimeoutMs: inRange(file?.requestTimeoutMs, "requestTimeoutMs", 100, 60000, STOP_RELAY_DEFAULTS.requestTimeoutMs),
      maxRequestAgeSeconds: inRange(file?.maxRequestAgeSeconds, "maxRequestAgeSeconds", 1, 86400, STOP_RELAY_DEFAULTS.maxRequestAgeSeconds),
      maxFailureBackoffSeconds: inRange(file?.maxFailureBackoffSeconds, "maxFailureBackoffSeconds", 1, 3600, STOP_RELAY_DEFAULTS.maxFailureBackoffSeconds),
      robotMap,
    };
    if (enabled && url === "") throw new Error("the stop relay is on but no dispatcher address is set (HYDRA_UMC_JOB_DISPATCHER_URL or jobDispatcher.stopRelay.url)");
    return { ok: true, settings };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "invalid stop relay settings" };
  }
}

/** One open request of GET /jobs/stop-requests. */
export interface StopRequest {
  jobId: string;
  robotId: string;
  requestedAtMs: number;
  expired?: boolean;
}

export interface StopRelayDeps {
  settings: StopRelaySettings;
  /** The HTTP client (the global fetch in production). */
  fetch: (url: string, init: { method: string; headers: Record<string, string>; body?: string; signal: AbortSignal }) => Promise<{ status: number; json: () => Promise<unknown> }>;
  /** The wall clock in milliseconds (Date.now in production). */
  now: () => number;
  /** Stops a robot of this server; true only when the stop was applied. */
  stopRobot: (robotId: number) => boolean | Promise<boolean>;
  log: (line: string) => void;
  audit?: (event: { type: string; outcome: "ok" | "failed" | "refused"; robotId?: number; detail: Record<string, unknown> }) => void;
  /** Called for every stop that was applied and that the dispatcher took as acknowledged: the proof that the robot stopped working on the job. */
  onAcknowledged?: (jobId: string, dispatcherRobotId: string) => void;
}

export interface PassReport {
  read: boolean;
  /** Requests the dispatcher listed. */
  seen: number;
  /** Stopped here and acknowledged to the dispatcher. */
  acknowledged: string[];
  /** Not delivered, with the reason (unmapped robot, expired, too old, the stop failed, the acknowledgement was refused or lost). */
  skipped: { jobId: string; reason: string }[];
}

function isRequest(value: unknown): value is StopRequest {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return typeof v.jobId === "string" && v.jobId !== "" && typeof v.robotId === "string" && v.robotId !== "" && typeof v.requestedAtMs === "number";
}

export class JobStopRelay {
  private failures = 0;
  private timer: unknown = null;
  private running = false;
  /** jobId -> robotId already acknowledged: a request that stays listed for a moment is not stopped and acknowledged again. */
  private readonly settled = new Map<string, string>();

  constructor(private readonly deps: StopRelayDeps) {}

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

  /** One pass: read the requests, stop what can be stopped, acknowledge only what was stopped. Never throws. */
  async pass(): Promise<PassReport> {
    const { settings, log, audit, now } = this.deps;
    const report: PassReport = { read: false, seen: 0, acknowledged: [], skipped: [] };
    let list: unknown;
    try {
      const answer = await this.call("GET", "/jobs/stop-requests");
      // 404: the dispatcher has replanning off, so there is nothing to deliver (not a failure of the link).
      if (answer.status === 404) {
        this.failures = 0;
        report.read = true;
        return report;
      }
      if (answer.status !== 200 || !Array.isArray(answer.json)) throw new Error(`the dispatcher answered ${answer.status}`);
      list = answer.json;
    } catch (error) {
      this.failures += 1;
      log(`[stop-relay] the stop requests could not be read (${error instanceof Error ? error.message : "unknown error"}); ${this.failures} in a row`);
      return report;
    }
    this.failures = 0;
    report.read = true;
    const requests = (list as unknown[]).filter(isRequest);
    report.seen = requests.length;
    const open = new Set(requests.map((r) => r.jobId));
    for (const jobId of [...this.settled.keys()]) if (!open.has(jobId)) this.settled.delete(jobId);

    for (const request of requests) {
      const skip = (reason: string) => report.skipped.push({ jobId: request.jobId, reason });
      if (this.settled.get(request.jobId) === request.robotId) {
        skip("already acknowledged");
        continue;
      }
      if (request.expired === true) {
        skip("expired at the dispatcher");
        continue;
      }
      const ageSeconds = (now() - request.requestedAtMs) / 1000;
      if (ageSeconds > settings.maxRequestAgeSeconds) {
        skip("too old");
        audit?.({ type: "job-stop-relay", outcome: "refused", detail: { jobId: request.jobId, dispatcherRobotId: request.robotId, reason: "too-old", ageSeconds: Math.round(ageSeconds) } });
        continue;
      }
      if (!Object.prototype.hasOwnProperty.call(settings.robotMap, request.robotId)) {
        skip("the robot is not in the robot map");
        audit?.({ type: "job-stop-relay", outcome: "refused", detail: { jobId: request.jobId, dispatcherRobotId: request.robotId, reason: "robot-not-mapped" } });
        continue;
      }
      const robotId = settings.robotMap[request.robotId];
      let stopped = false;
      try {
        stopped = (await this.deps.stopRobot(robotId)) === true;
      } catch (error) {
        log(`[stop-relay] the stop of robot ${robotId} failed (${error instanceof Error ? error.message : "unknown error"})`);
      }
      if (!stopped) {
        skip("the stop could not be applied");
        audit?.({ type: "job-stop-relay", outcome: "failed", robotId, detail: { jobId: request.jobId, dispatcherRobotId: request.robotId, reason: "stop-failed" } });
        continue;
      }
      try {
        const ack = await this.call("POST", "/jobs/stop-ack", { robotId: request.robotId, jobId: request.jobId });
        if (ack.status === 200 || ack.status === 409) {
          // 409: nothing is open for it any more (answered by another way or already sent back): the robot is stopped all the same.
          this.settled.set(request.jobId, request.robotId);
          try {
            this.deps.onAcknowledged?.(request.jobId, request.robotId);
          } catch {
            // keeping the proof is secondary: it never undoes the acknowledgement
          }
          report.acknowledged.push(request.jobId);
          log(`[stop-relay] robot ${robotId} stopped for job ${request.jobId}; the dispatcher answered ${ack.status}`);
          audit?.({ type: "job-stop-relay", outcome: "ok", robotId, detail: { jobId: request.jobId, dispatcherRobotId: request.robotId, answer: ack.status } });
        } else {
          skip(`the acknowledgement was refused (${ack.status})`);
          audit?.({ type: "job-stop-relay", outcome: "failed", robotId, detail: { jobId: request.jobId, reason: "ack-refused", answer: ack.status } });
        }
      } catch (error) {
        // The robot is stopped but the dispatcher does not know: the next pass stops it again (harmless) and retries the acknowledgement.
        skip("the acknowledgement was lost");
        log(`[stop-relay] robot ${robotId} stopped but the acknowledgement of job ${request.jobId} was lost (${error instanceof Error ? error.message : "unknown error"})`);
      }
    }
    return report;
  }

  /** Seconds to wait before the next pass: the poll period, doubled after each failed read up to the configured limit. */
  nextDelaySeconds(): number {
    const { pollSeconds, maxFailureBackoffSeconds } = this.deps.settings;
    if (this.failures === 0) return pollSeconds;
    return Math.min(pollSeconds * 2 ** Math.min(this.failures, 20), Math.max(maxFailureBackoffSeconds, pollSeconds));
  }

  /** Starts the loop with the timers given (setTimeout/clearTimeout in production). */
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
