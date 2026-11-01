// =============================================================================
// HYDRA-UMC-SERVER - src/orchestratorTakeover.ts
// Copyright (C) 2026 JuanenRac (Electro Hobby 3D) <electrohobby3d@gmail.com>
// GPL-3.0-or-later - see LICENSE
// =============================================================================
// The hand-over of the missions to a standby orchestrator, with the proof that the robots stopped.
//
// A second orchestrator can take the replicated registry of the first over (POST /replica/takeover, only when it was started with
// --takeover). A mission that was in flight goes back to Pending there only when a proof names its holder, the mission and the attempt it
// was on: otherwise it stays Unknown and is not dispatched twice. The proof is the acknowledgement that a robot gave to the stop request of
// the job dispatcher, which this server delivers (src/jobStopRelay.ts). So this server is the one that holds the proofs and hands them over:
//
//   1. while the primary orchestrator answers, it keeps its last replica (GET /replica) and forgets nothing it was told about stops;
//   2. when the primary has been silent for `failuresBeforeTakeover` checks in a row, it sends the last replica and the proofs that still
//      apply to the standby, once per outage;
//   3. a proof applies only if it is younger than `proofMaxAgeSeconds`, and only to a mission that was in flight, held by the same robot
//      that acknowledged the stop, in the replica it sends.
//
// Fail closed: off unless `jobDispatcher.takeover.enabled` (data/server-config.json) or HYDRA_UMC_ORCH_TAKEOVER=1 says so; a replica older
// than `maxSnapshotAgeSeconds` at the moment the primary went silent, or none at all, is never delivered; a standby that refuses
// (takeover off, a wrong token) is not tried again with something else. Every time and limit is a setting, the addresses and tokens come
// from the environment (a token is never kept in the settings file). The clock, the HTTP client and the timers are injected.

export const TAKEOVER_DEFAULTS = {
  pollSeconds: 5,
  requestTimeoutMs: 3000,
  failuresBeforeTakeover: 3,
  maxSnapshotAgeSeconds: 60,
  proofMaxAgeSeconds: 3600,
  maxProofs: 1000,
  maxDeliveryAttempts: 5,
  retrySeconds: 10,
} as const;

/** The most records the orchestrator takes in one takeover (its own limit). */
export const ORCHESTRATOR_MAX_ITEMS = 5000;

export interface TakeoverFile {
  enabled?: unknown;
  primaryUrl?: unknown;
  standbyUrl?: unknown;
  pollSeconds?: unknown;
  requestTimeoutMs?: unknown;
  failuresBeforeTakeover?: unknown;
  maxSnapshotAgeSeconds?: unknown;
  proofMaxAgeSeconds?: unknown;
  maxProofs?: unknown;
  maxDeliveryAttempts?: unknown;
  retrySeconds?: unknown;
}

export interface TakeoverEnv {
  HYDRA_UMC_ORCH_TAKEOVER?: string;
  HYDRA_UMC_ORCHESTRATOR_URL?: string;
  HYDRA_UMC_ORCHESTRATOR_STANDBY_URL?: string;
  HYDRA_UMC_ORCHESTRATOR_TOKEN?: string;
  HYDRA_UMC_ORCHESTRATOR_STANDBY_TOKEN?: string;
}

export interface TakeoverSettings {
  enabled: boolean;
  primaryUrl: string;
  standbyUrl: string;
  primaryToken: string;
  standbyToken: string;
  pollSeconds: number;
  requestTimeoutMs: number;
  failuresBeforeTakeover: number;
  maxSnapshotAgeSeconds: number;
  proofMaxAgeSeconds: number;
  maxProofs: number;
  maxDeliveryAttempts: number;
  retrySeconds: number;
}

export type TakeoverResolution = { ok: true; settings: TakeoverSettings } | { ok: false; error: string };

function inRange(value: unknown, name: string, min: number, max: number, fallback: number, integer = false): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max || (integer && !Number.isInteger(value))) {
    throw new Error(`jobDispatcher.takeover.${name} must be ${integer ? "a whole number" : "a number"} from ${min} to ${max}`);
  }
  return value;
}

const cleanUrl = (value: string) => value.trim().replace(/\/+$/, "");

/** A wrong setting is an error (the hand-over does not start), never a silent default. */
export function resolveTakeover(env: TakeoverEnv, file: TakeoverFile | undefined): TakeoverResolution {
  try {
    if (file?.enabled !== undefined && typeof file.enabled !== "boolean") throw new Error("jobDispatcher.takeover.enabled must be true or false");
    const raw = (env.HYDRA_UMC_ORCH_TAKEOVER ?? "").trim();
    const enabled = raw !== "" ? raw === "1" : file?.enabled === true;
    const primaryUrl = cleanUrl(env.HYDRA_UMC_ORCHESTRATOR_URL ?? (typeof file?.primaryUrl === "string" ? file.primaryUrl : ""));
    const standbyUrl = cleanUrl(env.HYDRA_UMC_ORCHESTRATOR_STANDBY_URL ?? (typeof file?.standbyUrl === "string" ? file.standbyUrl : ""));
    const primaryToken = (env.HYDRA_UMC_ORCHESTRATOR_TOKEN ?? "").trim();
    const standbyToken = (env.HYDRA_UMC_ORCHESTRATOR_STANDBY_TOKEN ?? "").trim() || primaryToken;
    const settings: TakeoverSettings = {
      enabled, primaryUrl, standbyUrl, primaryToken, standbyToken,
      pollSeconds: inRange(file?.pollSeconds, "pollSeconds", 1, 3600, TAKEOVER_DEFAULTS.pollSeconds),
      requestTimeoutMs: inRange(file?.requestTimeoutMs, "requestTimeoutMs", 100, 60000, TAKEOVER_DEFAULTS.requestTimeoutMs),
      failuresBeforeTakeover: inRange(file?.failuresBeforeTakeover, "failuresBeforeTakeover", 1, 1000, TAKEOVER_DEFAULTS.failuresBeforeTakeover, true),
      maxSnapshotAgeSeconds: inRange(file?.maxSnapshotAgeSeconds, "maxSnapshotAgeSeconds", 1, 86400, TAKEOVER_DEFAULTS.maxSnapshotAgeSeconds),
      proofMaxAgeSeconds: inRange(file?.proofMaxAgeSeconds, "proofMaxAgeSeconds", 1, 604800, TAKEOVER_DEFAULTS.proofMaxAgeSeconds),
      maxProofs: inRange(file?.maxProofs, "maxProofs", 1, ORCHESTRATOR_MAX_ITEMS, TAKEOVER_DEFAULTS.maxProofs, true),
      maxDeliveryAttempts: inRange(file?.maxDeliveryAttempts, "maxDeliveryAttempts", 1, 100, TAKEOVER_DEFAULTS.maxDeliveryAttempts, true),
      retrySeconds: inRange(file?.retrySeconds, "retrySeconds", 1, 3600, TAKEOVER_DEFAULTS.retrySeconds),
    };
    if (enabled) {
      if (primaryUrl === "" || standbyUrl === "") throw new Error("the hand-over is on but the addresses of the two orchestrators are not set (HYDRA_UMC_ORCHESTRATOR_URL and HYDRA_UMC_ORCHESTRATOR_STANDBY_URL)");
      if (primaryUrl === standbyUrl) throw new Error("the primary and the standby orchestrator must be different");
    }
    return { ok: true, settings };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "invalid takeover settings" };
  }
}

export interface ReplicaRecord {
  key: string;
  value: string;
  generation: number;
}

export interface StopEvidence {
  owner: string;
  mission_id: string;
  attempt: number;
}

interface Proof {
  jobId: string;
  robotId: string;
  atMs: number;
}

export interface TakeoverDeps {
  settings: TakeoverSettings;
  fetch: (url: string, init: { method: string; headers: Record<string, string>; body?: string; signal: AbortSignal }) => Promise<{ status: number; json: () => Promise<unknown> }>;
  now: () => number;
  log: (line: string) => void;
  audit?: (event: { type: string; outcome: "ok" | "failed" | "refused"; detail: Record<string, unknown> }) => void;
}

/** The mission an in-flight record describes: id, holder and attempt; null for a record that is not in flight or cannot be read. */
export function inFlight(record: ReplicaRecord): { missionId: string; owner: string; attempt: number } | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(record.value);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const v = parsed as Record<string, unknown>;
  if ((v.status !== "assigned" && v.status !== "running") || typeof v.mission_id !== "string" || typeof v.owner !== "string" || !Number.isInteger(v.attempt) || (v.attempt as number) < 0) return null;
  return { missionId: v.mission_id, owner: v.owner, attempt: v.attempt as number };
}

function isRecord(value: unknown): value is ReplicaRecord {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return typeof v.key === "string" && typeof v.value === "string" && typeof v.generation === "number";
}

export type TakeoverState = "watching" | "primary-silent" | "delivered" | "gave-up" | "refused";

export class OrchestratorTakeover {
  private readonly proofs = new Map<string, Proof>();
  private snapshot: { records: ReplicaRecord[]; atMs: number } | null = null;
  private failures = 0;
  private silentSinceMs: number | null = null;
  private attempts = 0;
  private nextAttemptMs = 0;
  state: TakeoverState = "watching";
  private timer: unknown = null;
  private running = false;
  private stopTimers: () => void = () => undefined;

  constructor(private readonly deps: TakeoverDeps) {}

  /** The relay calls this for every stop it applied and the dispatcher accepted: the robot stopped working on the job. */
  recordProof(jobId: string, robotId: string): void {
    const { settings } = this.deps;
    this.proofs.set(jobId, { jobId, robotId, atMs: this.deps.now() });
    // bounded: the oldest are forgotten first
    while (this.proofs.size > settings.maxProofs) {
      const oldest = [...this.proofs.values()].sort((a, b) => a.atMs - b.atMs)[0];
      this.proofs.delete(oldest.jobId);
    }
  }

  proofCount(): number {
    return this.proofs.size;
  }

  private async call(method: string, url: string, token: string, body?: unknown): Promise<{ status: number; json: unknown } | null> {
    const { settings } = this.deps;
    const controller = new AbortController();
    const abort = setTimeout(() => controller.abort(), settings.requestTimeoutMs);
    try {
      const headers: Record<string, string> = { Accept: "application/json" };
      if (token) headers.Authorization = `Bearer ${token}`;
      if (body !== undefined) headers["Content-Type"] = "application/json";
      const answer = await this.deps.fetch(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: controller.signal });
      let json: unknown = null;
      try {
        json = await answer.json();
      } catch {
        json = null;
      }
      return { status: answer.status, json };
    } catch {
      return null;
    } finally {
      clearTimeout(abort);
    }
  }

  /** The proofs that apply to the records to send: young enough, for a mission in flight, held by the robot that acknowledged the stop. */
  evidenceFor(records: ReplicaRecord[], nowMs: number): StopEvidence[] {
    const limit = this.deps.settings.proofMaxAgeSeconds * 1000;
    const out: StopEvidence[] = [];
    for (const record of records) {
      const flight = inFlight(record);
      if (!flight) continue;
      const proof = this.proofs.get(flight.missionId);
      if (!proof || nowMs - proof.atMs > limit || proof.robotId !== flight.owner) continue;
      out.push({ owner: flight.owner, mission_id: flight.missionId, attempt: flight.attempt });
    }
    return out;
  }

  /** One check: keep the replica while the primary answers; deliver the hand-over once it has been silent long enough. Never throws. */
  async tick(): Promise<TakeoverState> {
    const { settings, now, log, audit } = this.deps;
    const t = now();
    if (this.state === "delivered" || this.state === "gave-up" || this.state === "refused") {
      // a primary that is back ends the outage and re-arms the hand-over
      const back = await this.call("GET", `${settings.primaryUrl}/health`, "");
      if (back && back.status === 200) {
        this.reset();
        await this.refreshSnapshot();
      }
      return this.state;
    }
    const health = await this.call("GET", `${settings.primaryUrl}/health`, "");
    if (health && health.status === 200) {
      this.failures = 0;
      this.silentSinceMs = null;
      this.attempts = 0;
      this.state = "watching";
      await this.refreshSnapshot();
      return this.state;
    }
    this.failures += 1;
    if (this.silentSinceMs === null) this.silentSinceMs = t;
    if (this.failures < settings.failuresBeforeTakeover) return this.state;
    this.state = "primary-silent";
    if (t < this.nextAttemptMs) return this.state;
    return this.deliver(t);
  }

  private reset(): void {
    this.failures = 0;
    this.silentSinceMs = null;
    this.attempts = 0;
    this.nextAttemptMs = 0;
    this.state = "watching";
  }

  private async refreshSnapshot(): Promise<void> {
    const { settings, now, log } = this.deps;
    const answer = await this.call("GET", `${settings.primaryUrl}/replica`, settings.primaryToken);
    if (!answer || answer.status !== 200) {
      if (answer) log(`[takeover] the replica of the primary could not be read (${answer.status}); the previous one is kept`);
      return;
    }
    const records = (answer.json as { records?: unknown })?.records;
    if (!Array.isArray(records) || !records.every(isRecord)) {
      log("[takeover] the replica of the primary is not in the expected shape; the previous one is kept");
      return;
    }
    this.snapshot = { records, atMs: now() };
  }

  private async deliver(t: number): Promise<TakeoverState> {
    const { settings, log, audit } = this.deps;
    const silentSince = this.silentSinceMs ?? t;
    const refuse = (reason: string) => {
      this.state = "refused";
      log(`[takeover] NOT delivered: ${reason}`);
      audit?.({ type: "orchestrator-takeover", outcome: "refused", detail: { reason } });
      return this.state;
    };
    if (!this.snapshot) return refuse("no replica of the primary was ever read");
    if (silentSince - this.snapshot.atMs > settings.maxSnapshotAgeSeconds * 1000) {
      return refuse(`the last replica is older than ${settings.maxSnapshotAgeSeconds} s when the primary went silent`);
    }
    let records = this.snapshot.records;
    if (records.length > ORCHESTRATOR_MAX_ITEMS) {
      // the orchestrator takes at most so many: what is still open goes first and nothing is cut silently
      records = records.filter((r) => {
        const v = inFlight(r);
        if (v) return true;
        try {
          const status = (JSON.parse(r.value) as { status?: string }).status;
          return status === "queued";
        } catch {
          return false;
        }
      });
      if (records.length > ORCHESTRATOR_MAX_ITEMS) return refuse(`more than ${ORCHESTRATOR_MAX_ITEMS} missions are open`);
    }
    const evidence = this.evidenceFor(records, t).slice(0, ORCHESTRATOR_MAX_ITEMS);
    this.attempts += 1;
    const answer = await this.call("POST", `${settings.standbyUrl}/replica/takeover`, settings.standbyToken, { records, confirmed_stopped: evidence });
    if (answer && answer.status === 200) {
      this.state = "delivered";
      const report = (answer.json ?? {}) as Record<string, unknown>;
      const count = (key: string) => (Array.isArray(report[key]) ? (report[key] as unknown[]).length : 0);
      log(`[takeover] delivered to the standby: ${records.length} record(s), ${evidence.length} proof(s); adopted ${count("adopted")}, requeued ${count("requeued")}, unconfirmed ${count("unconfirmed")}`);
      audit?.({ type: "orchestrator-takeover", outcome: "ok", detail: { records: records.length, proofs: evidence.length, adopted: count("adopted"), requeued: count("requeued"), unconfirmed: count("unconfirmed"), existing: count("existing"), rejected: count("rejected") } });
      return this.state;
    }
    if (answer && (answer.status === 404 || answer.status === 401 || answer.status === 403 || answer.status === 400)) {
      return refuse(`the standby refused the hand-over (${answer.status}); it is not tried again until the primary comes back`);
    }
    if (this.attempts >= settings.maxDeliveryAttempts) {
      this.state = "gave-up";
      log(`[takeover] gave up after ${this.attempts} attempts: the standby does not answer`);
      audit?.({ type: "orchestrator-takeover", outcome: "failed", detail: { attempts: this.attempts } });
      return this.state;
    }
    this.nextAttemptMs = t + settings.retrySeconds * 1000;
    log(`[takeover] the standby did not take the hand-over (${answer ? answer.status : "no answer"}); attempt ${this.attempts} of ${settings.maxDeliveryAttempts}`);
    return this.state;
  }

  start(timers: { set: (fn: () => void, ms: number) => unknown; clear: (handle: unknown) => void }): void {
    if (this.running) return;
    this.running = true;
    const tick = () => {
      this.timer = null;
      void this.tick().finally(() => {
        if (this.running) this.timer = timers.set(tick, this.deps.settings.pollSeconds * 1000);
      });
    };
    this.timer = timers.set(tick, 0);
    this.stopTimers = () => {
      if (this.timer !== null) timers.clear(this.timer);
      this.timer = null;
    };
  }

  stop(): void {
    this.running = false;
    this.stopTimers();
  }
}
