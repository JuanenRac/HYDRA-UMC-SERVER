// =============================================================================
// HYDRA-UMC-SERVER - src/dispatcherRegistrar.ts
// Copyright (C) 2026 JuanenRac (Electro Hobby 3D) <electrohobby3d@gmail.com>
// GPL-3.0-or-later - see LICENSE
// =============================================================================
// The registration of the robots of this server in the job dispatcher. The dispatcher only assigns jobs to robots it knows (POST /robots),
// and nothing told it about the robots of the roster (controllers[].robots in the settings). This server owns the roster and the
// authentication, so it does the registration:
//
//   1. read the robots the dispatcher knows (GET /robots);
//   2. for each robot of the roster that has an id there (the robot map of the stop relay, dispatcher id -> robot id of this server) and is
//      not known yet, register it (POST /robots with its id and available: true);
//   3. never touch a robot the dispatcher already knows: its tool, location, availability and load are the dispatcher's own, so a
//      registration can never overwrite a robot that is working on a job.
//
// Off until `jobDispatcher.registrar.enabled` (data/server-config.json) or HYDRA_UMC_JOB_ROBOT_REGISTRAR=1 says so (the environment wins).
// A robot of the roster without an entry in the robot map is not registered, unless `registerUnmapped` is true (then its id here, as text,
// is the id there). A robot id used by more than one robot is never registered (src/robotIds.ts). The address of the dispatcher and its token
// are those of the stop relay (HYDRA_UMC_JOB_DISPATCHER_URL, HYDRA_UMC_JOB_DISPATCHER_TOKEN). The clock-free loop takes its timers and its HTTP
// client from outside, so the whole behaviour is tested with simulated time.
//
// The dispatcher answers its robot list with the field names of its own Go structure (`ID`, `Tool`, ...) and, when its camelCase aliases are
// switched on, also `id`, `tool`: this reader accepts both.

import { robotIdConflicts } from "./robotIds";
import { identityHeader } from "./serviceIdentity";

export const REGISTRAR_DEFAULTS = {
  pollSeconds: 30,
  requestTimeoutMs: 3000,
  maxFailureBackoffSeconds: 300,
} as const;

export interface RegistrarFile {
  enabled?: unknown;
  url?: unknown;
  pollSeconds?: unknown;
  requestTimeoutMs?: unknown;
  maxFailureBackoffSeconds?: unknown;
  /** Also register the robots that have no entry in the robot map, with their id here (as text) as their id there. */
  registerUnmapped?: unknown;
}

export interface RegistrarSettings {
  enabled: boolean;
  url: string;
  token: string;
  pollSeconds: number;
  requestTimeoutMs: number;
  maxFailureBackoffSeconds: number;
  registerUnmapped: boolean;
}

export interface RegistrarEnv {
  HYDRA_UMC_JOB_ROBOT_REGISTRAR?: string;
  HYDRA_UMC_JOB_DISPATCHER_URL?: string;
  HYDRA_UMC_JOB_DISPATCHER_TOKEN?: string;
}

export type RegistrarResolution = { ok: true; settings: RegistrarSettings } | { ok: false; error: string };

function inRange(value: unknown, name: string, min: number, max: number, fallback: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) {
    throw new Error(`jobDispatcher.registrar.${name} must be a number from ${min} to ${max}`);
  }
  return value;
}

/** Reads the switch, the address and the limits. A wrong value is an error (the registrar does not start), never a silent default. */
export function resolveRegistrar(env: RegistrarEnv, file: RegistrarFile | undefined, fileUrl?: unknown): RegistrarResolution {
  try {
    if (file?.enabled !== undefined && typeof file.enabled !== "boolean") throw new Error("jobDispatcher.registrar.enabled must be true or false");
    if (file?.registerUnmapped !== undefined && typeof file.registerUnmapped !== "boolean") throw new Error("jobDispatcher.registrar.registerUnmapped must be true or false");
    const raw = (env.HYDRA_UMC_JOB_ROBOT_REGISTRAR ?? "").trim();
    const enabled = raw !== "" ? raw === "1" : file?.enabled === true;
    const ownUrl = typeof file?.url === "string" ? file.url : typeof fileUrl === "string" ? fileUrl : "";
    const url = (env.HYDRA_UMC_JOB_DISPATCHER_URL ?? ownUrl).trim().replace(/\/+$/, "");
    const settings: RegistrarSettings = {
      enabled,
      url,
      token: env.HYDRA_UMC_JOB_DISPATCHER_TOKEN ?? "",
      pollSeconds: inRange(file?.pollSeconds, "pollSeconds", 1, 86400, REGISTRAR_DEFAULTS.pollSeconds),
      requestTimeoutMs: inRange(file?.requestTimeoutMs, "requestTimeoutMs", 100, 60000, REGISTRAR_DEFAULTS.requestTimeoutMs),
      maxFailureBackoffSeconds: inRange(file?.maxFailureBackoffSeconds, "maxFailureBackoffSeconds", 1, 86400, REGISTRAR_DEFAULTS.maxFailureBackoffSeconds),
      registerUnmapped: file?.registerUnmapped === true,
    };
    if (enabled && url === "") throw new Error("the registrar is on but no dispatcher address is set (HYDRA_UMC_JOB_DISPATCHER_URL or jobDispatcher.registrar.url)");
    return { ok: true, settings };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "invalid registrar settings" };
  }
}

export interface DesiredRobot {
  /** The id the dispatcher knows the robot by. */
  dispatcherId: string;
  /** The id of the robot in this server. */
  robotId: number;
}

/**
 * The robots of the roster that should exist in the dispatcher. A robot used by more than one robot is left out; so is one with no entry
 * in the robot map unless [registerUnmapped]. An entry of the map whose robot is not in the roster is not registered either.
 */
export function desiredRobots(settings: unknown, robotMap: Record<string, number>, registerUnmapped: boolean): DesiredRobot[] {
  const ambiguous = new Set(robotIdConflicts(settings).map((c) => String(c.robotId)));
  const controllers = Array.isArray((settings as { controllers?: unknown })?.controllers) ? ((settings as { controllers: unknown[] }).controllers as { robots?: unknown }[]) : [];
  const byRobot = new Map<number, string>();
  for (const [dispatcherId, robotId] of Object.entries(robotMap)) {
    if (!byRobot.has(robotId)) byRobot.set(robotId, dispatcherId);
  }
  const wanted: DesiredRobot[] = [];
  const seen = new Set<string>();
  for (const controller of controllers) {
    const robots = Array.isArray(controller?.robots) ? (controller.robots as { id?: unknown }[]) : [];
    for (const robot of robots) {
      if (typeof robot?.id !== "number" || !Number.isInteger(robot.id) || ambiguous.has(String(robot.id))) continue;
      const dispatcherId = byRobot.get(robot.id) ?? (registerUnmapped ? String(robot.id) : undefined);
      if (dispatcherId === undefined || seen.has(dispatcherId)) continue;
      seen.add(dispatcherId);
      wanted.push({ dispatcherId, robotId: robot.id });
    }
  }
  return wanted;
}

/** The ids of a robot list of the dispatcher, whichever way it names the field (`ID` of its structure or the `id` alias). */
export function knownRobotIds(list: unknown): Set<string> {
  const ids = new Set<string>();
  if (!Array.isArray(list)) return ids;
  for (const entry of list) {
    if (typeof entry !== "object" || entry === null) continue;
    const e = entry as Record<string, unknown>;
    const id = typeof e.id === "string" ? e.id : typeof e.ID === "string" ? e.ID : "";
    if (id !== "") ids.add(id);
  }
  return ids;
}

export interface RegistrarDeps {
  settings: RegistrarSettings;
  fetch: (url: string, init: { method: string; headers: Record<string, string>; body?: string; signal: AbortSignal }) => Promise<{ status: number; json: () => Promise<unknown> }>;
  /** The settings tree of the server, read at every pass (the roster can change). */
  getSettings: () => unknown;
  /** The robot map (dispatcher id -> robot id of this server), read at every pass. */
  robotMap: () => Record<string, number>;
  log: (line: string) => void;
  audit?: (event: { type: string; outcome: "ok" | "failed" | "refused"; robotId?: number; detail: Record<string, unknown> }) => void;
}

export interface RegistrarReport {
  read: boolean;
  /** Registered in this pass. */
  registered: string[];
  /** The dispatcher already knew them. */
  known: string[];
  /** Not registered, with the reason. */
  failed: { dispatcherId: string; reason: string }[];
}

export class DispatcherRegistrar {
  private failures = 0;
  private timer: unknown = null;
  private running = false;

  constructor(private readonly deps: RegistrarDeps) {}

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

  /** One pass: register what the dispatcher does not know. Never throws. */
  async pass(): Promise<RegistrarReport> {
    const { settings, log, audit } = this.deps;
    const report: RegistrarReport = { read: false, registered: [], known: [], failed: [] };
    const wanted = desiredRobots(this.deps.getSettings(), this.deps.robotMap(), settings.registerUnmapped);
    let known: Set<string>;
    try {
      const answer = await this.call("GET", "/robots");
      if (answer.status !== 200 || !Array.isArray(answer.json)) throw new Error(`the dispatcher answered ${answer.status}`);
      known = knownRobotIds(answer.json);
    } catch (error) {
      this.failures += 1;
      log(`[robot-registrar] the robots of the dispatcher could not be read (${error instanceof Error ? error.message : "unknown error"}); ${this.failures} in a row`);
      return report;
    }
    this.failures = 0;
    report.read = true;
    for (const robot of wanted) {
      if (known.has(robot.dispatcherId)) {
        report.known.push(robot.dispatcherId);
        continue;
      }
      try {
        const answer = await this.call("POST", "/robots", { id: robot.dispatcherId, available: true });
        if (answer.status === 200) {
          report.registered.push(robot.dispatcherId);
          log(`[robot-registrar] robot ${robot.robotId} registered in the dispatcher as ${robot.dispatcherId}`);
          audit?.({ type: "job-robot-registrar", outcome: "ok", robotId: robot.robotId, detail: { dispatcherId: robot.dispatcherId } });
        } else {
          report.failed.push({ dispatcherId: robot.dispatcherId, reason: `the dispatcher answered ${answer.status}` });
          audit?.({ type: "job-robot-registrar", outcome: "refused", robotId: robot.robotId, detail: { dispatcherId: robot.dispatcherId, answer: answer.status } });
        }
      } catch (error) {
        this.failures += 1;
        report.failed.push({ dispatcherId: robot.dispatcherId, reason: error instanceof Error ? error.message : "unknown error" });
        log(`[robot-registrar] robot ${robot.robotId} could not be registered (${error instanceof Error ? error.message : "unknown error"})`);
        break;
      }
    }
    return report;
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
