// =============================================================================
// HYDRA-UMC-SERVER - src/ingestFeeds.ts
// Copyright (C) 2026 JuanenRac (Electro Hobby 3D) <electrohobby3d@gmail.com>
// GPL-3.0-or-later - see LICENSE
// =============================================================================
// What the sibling services hand to this server so that it keeps the state (the services keep none of their own):
//   * `ScenarioOutcome` of the shared contract (a run of a reproduction scenario), from an operator or a service that signs in;
//   * `developer-node-status/1`, the status document of the developer node, sent with the token of that node over HTTPS;
//   * `fault-event/1`, the faults of the machines, read from the broker (MQTT) the server already uses for telemetry.
// Each one is OFF until its switch is turned on (environment word "1"), is kept in a signed, hash-chained record (ingestLog.ts) with a
// retention that can be set, and is read back with a GET route. Nothing here moves hardware.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { ChainedLog, DEFAULT_RETENTION, type Retention } from "./ingestLog";
import { identityKey } from "./serviceIdentity";
import { AnomalyFeed } from "./anomalyFeed";

export type Env = Record<string, string | undefined>;

export const SWITCH_SCENARIO = "HYDRA_UMC_INGEST_SCENARIO";
export const SWITCH_DEVELOPER_NODE = "HYDRA_UMC_INGEST_DEVELOPER_NODE";
export const SWITCH_FAULT_FEED = "HYDRA_UMC_FAULT_FEED";
export const DEVELOPER_NODE_TOKENS_FILE = "HYDRA_UMC_DEVELOPER_NODE_TOKENS_FILE";
export const ALLOW_PLAIN_HTTP = "HYDRA_UMC_INGEST_ALLOW_HTTP";

export const MAX_BODY_BYTES = 64 * 1024;

export function switchOn(name: string, env: Env = process.env): boolean {
  return (env[name] ?? "").trim() === "1";
}

export function retentionFromEnv(prefix: string, env: Env = process.env): Retention {
  const num = (value: string | undefined, fallback: number) => {
    const n = Number((value ?? "").trim());
    return value !== undefined && value.trim() !== "" && Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
  };
  return { maxAgeDays: num(env[`${prefix}_RETENTION_DAYS`], DEFAULT_RETENTION.maxAgeDays), maxRecords: num(env[`${prefix}_RETENTION_RECORDS`], DEFAULT_RETENTION.maxRecords) };
}

// ---------------------------------------------------------------------------
// ScenarioOutcome (contract of the SDK, version 1.0)
// ---------------------------------------------------------------------------
const isText = (v: unknown): v is string => typeof v === "string" && v.length > 0 && v.length <= 512;

/** Why the body is not a ScenarioOutcome of version 1.0 (null when it is). Extra fields are allowed, as the contract allows them. */
export function scenarioOutcomeProblem(body: unknown): string | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return "the body must be a JSON object";
  const o = body as Record<string, any>;
  if (o.schema_version !== "1.0") return 'schema_version must be "1.0"';
  for (const field of ["scenario_id", "run_id", "base_fingerprint", "repro_case"]) if (!isText(o[field])) return `${field} must be a non-empty text`;
  if (o.phase !== "before" && o.phase !== "after") return 'phase must be "before" or "after"';
  if (!o.observed || typeof o.observed !== "object" || Array.isArray(o.observed)) return "observed must be an object";
  if (!["reproduced", "not-reproduced", "error"].includes(o.observed.outcome)) return "observed.outcome is not one of reproduced, not-reproduced, error";
  if (o.observed.exit_code !== undefined && !Number.isInteger(o.observed.exit_code)) return "observed.exit_code must be an integer";
  if (o.observed.evidence !== undefined && typeof o.observed.evidence !== "string") return "observed.evidence must be a text";
  if (typeof o.timestamp_utc !== "string" || Number.isNaN(Date.parse(o.timestamp_utc))) return "timestamp_utc must be a date-time";
  return null;
}

// ---------------------------------------------------------------------------
// developer-node-status/1 and the token of each node
// ---------------------------------------------------------------------------
export function developerNodeStatusProblem(body: unknown): string | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return "the body must be a JSON object";
  const o = body as Record<string, any>;
  if (o.contract !== "developer-node-status/1") return 'contract must be "developer-node-status/1"';
  if (!isText(o.version)) return "version must be a non-empty text";
  if (typeof o.generated_at !== "number" || !Number.isFinite(o.generated_at)) return "generated_at must be a number";
  for (const field of ["switches", "queue", "health"]) if (!o[field] || typeof o[field] !== "object" || Array.isArray(o[field])) return `${field} must be an object`;
  if (!Array.isArray(o.journal)) return "journal must be a list";
  return null;
}

export function hashToken(token: string): string {
  return crypto.createHash("sha256").update(token, "utf8").digest("hex");
}

/**
 * The registry of the tokens of the developer nodes: {"nodes": {"<node id>": "<sha256 hex of the token>"}}. Only the hash of a token
 * is ever stored. A missing or unreadable file means no node is known, so every token is refused. The file is read on every call so a
 * node added or removed takes effect without a restart.
 */
export function nodeIdForToken(token: string, env: Env = process.env): string | null {
  const file = (env[DEVELOPER_NODE_TOKENS_FILE] ?? "").trim();
  if (!file || !token) return null;
  let nodes: Record<string, unknown>;
  try { nodes = JSON.parse(fs.readFileSync(file, "utf8")).nodes ?? {}; } catch { return null; }
  const given = Buffer.from(hashToken(token));
  let found: string | null = null;
  for (const [id, hash] of Object.entries(nodes)) {
    if (typeof hash !== "string") continue;
    const stored = Buffer.from(hash.toLowerCase());
    // every entry is compared, so the time does not tell which one matched
    if (stored.length === given.length && crypto.timingSafeEqual(stored, given)) found = id;
  }
  return found;
}

/** The ingest needs HTTPS (the token is a secret): a TLS request, one a reverse proxy says was TLS, or one that never left this machine. The environment can allow plain HTTP for a bench. */
export function transportAcceptable(req: { secure?: boolean; headers?: Record<string, any>; socket?: { remoteAddress?: string } }, env: Env = process.env): boolean {
  if (switchOn(ALLOW_PLAIN_HTTP, env)) return true;
  if (req.secure) return true;
  const address = req.socket?.remoteAddress ?? "";
  const loopback = address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
  const forwarded = String(req.headers?.["x-forwarded-proto"] ?? "").split(",")[0].trim().toLowerCase();
  return forwarded === "https" || (loopback && forwarded === "");
}

// ---------------------------------------------------------------------------
// fault-event/1
// ---------------------------------------------------------------------------
export const SEVERITIES = ["info", "warning", "error", "critical"] as const;
export type Severity = (typeof SEVERITIES)[number];

export interface FaultEvent {
  schema: "fault-event/1";
  source: string;
  robotId: string | null;
  code: string;
  severity: Severity;
  text: string;
  state: "raised" | "cleared";
}

/** A `fault-event/1` message; null when it is not one. Texts are cut short: a fault is a line, not a log. */
export function parseFaultEvent(raw: unknown): FaultEvent | null {
  let o: any = raw;
  if (typeof raw === "string" || Buffer.isBuffer(raw)) { try { o = JSON.parse(raw.toString()); } catch { return null; } }
  if (!o || typeof o !== "object" || Array.isArray(o) || o.schema !== "fault-event/1") return null;
  if (!isText(o.source) || !isText(o.code)) return null;
  if (o.state !== "raised" && o.state !== "cleared") return null;
  const severity: Severity = SEVERITIES.includes(o.severity) ? o.severity : "error";
  const robotId = o.robot_id === undefined || o.robot_id === null ? null : String(o.robot_id).slice(0, 64);
  const text = typeof o.text === "string" ? o.text.slice(0, 240) : "";
  return { schema: "fault-event/1", source: o.source.slice(0, 64), robotId, code: o.code.slice(0, 64), severity, text, state: o.state };
}

const faultKey = (e: FaultEvent) => `${e.source}|${e.robotId ?? ""}|${e.code}`;

/** The active faults (raised and not cleared) and the history. The state lives here and survives a restart because it is rebuilt from the record. */
export class FaultFeed {
  private active = new Map<string, FaultEvent & { since: number }>();

  constructor(readonly log: ChainedLog) {
    // oldest first, so the last word on each fault wins
    for (const r of [...log.list(Number.MAX_SAFE_INTEGER, "fault")].reverse()) this.apply(r.payload as FaultEvent, r.at);
  }

  private apply(event: FaultEvent, at: number): void {
    const key = faultKey(event);
    if (event.state === "cleared") this.active.delete(key);
    else this.active.set(key, { ...event, since: this.active.get(key)?.since ?? at });
  }

  record(event: FaultEvent): void {
    const record = this.log.append("fault", event);
    this.apply(event, record.at);
  }

  activeFaults(): Array<FaultEvent & { since: number }> { return [...this.active.values()]; }
  recent(limit = 100) { return this.log.list(limit, "fault").map((r) => ({ at: r.at, ...(r.payload as FaultEvent) })); }
}

/** What opens the broker for the feed: the same URL and account the MQTT bridge of the server uses. */
export interface BrokerOptions { url: string; username?: string; password?: string; topic: string }

export function faultTopicFromEnv(env: Env = process.env): string {
  const t = (env.HYDRA_UMC_FAULT_FEED_TOPIC ?? "hydra/faults/#").trim();
  return /^[A-Za-z0-9._\-/+#]+$/.test(t) && !t.startsWith("/") && !t.includes("//") ? t : "hydra/faults/#";
}

// ---------------------------------------------------------------------------
// The stores, built from the environment on first use
// ---------------------------------------------------------------------------
export function makeLog(dir: string, name: string, env: Env = process.env): ChainedLog {
  return new ChainedLog(path.join(dir, `${name}.jsonl`), () => identityKey(env), () => retentionFromEnv(`HYDRA_UMC_INGEST_${name.toUpperCase().replace(/-/g, "_")}`, env));
}

export interface Ingest {
  scenario: ChainedLog;
  developerNode: ChainedLog;
  faults: FaultFeed;
  /** The latest verdict of each series of the anomaly detector, and the record of its changes. */
  anomaly: AnomalyFeed;
  /** The voice commands that passed through this server (see voiceChain.ts). */
  voice: ChainedLog;
}

/** The five stores, under `dir` (the data folder of the server). */
export function makeIngest(dir: string, env: Env = process.env): Ingest {
  return {
    scenario: makeLog(dir, "scenario-outcomes", env), developerNode: makeLog(dir, "developer-node", env), faults: new FaultFeed(makeLog(dir, "faults", env)),
    anomaly: new AnomalyFeed(makeLog(dir, "anomaly", env)), voice: makeLog(dir, "voice", env),
  };
}
