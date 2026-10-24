// =============================================================================
// HYDRA-UMC-SERVER - src/telemetryProducer.ts
// Copyright (C) 2026 JuanenRac (Electro Hobby 3D) <electrohobby3d@gmail.com>
// GPL-3.0-or-later - see LICENSE
// =============================================================================
// The first producer of the telemetry chain: this server tells HYDRA-UMC-TELEMETRY-COLLECTOR what its robots do.
//
// Every robot delta this server broadcasts (a jog, a play, a stop, a valve) carries the part of the robot that changed. Here the
// numbers of that delta become one `Sample` per robot (kind `robot_state`, fields such as `pos_x` or `joints_j1`), posted to the
// collector's `/ingest/ws`, which hands them to the data lake the anomaly detector, the reports and the AI dashboard read.
//
// Off unless `HYDRA_UMC_TELEMETRY_COLLECTOR_URL` is set. It never delays a command: a delta only records its numbers; a timer sends
// them, at most one sample per robot per interval, merged (the latest value of each field wins). Everything is bounded: a cap on the
// robots and on the fields of a sample, one request at a time, a short timeout, and a pause after a failure, so an unreachable
// collector costs a few skipped samples and nothing else. The token (`HYDRA_UMC_TELEMETRY_COLLECTOR_TOKEN` or its `_FILE`) is the one
// the collector asks for.
import { bearerHeader, resolveToken, type Env } from "./upstreamAuth";

export const COLLECTOR_URL_VARIABLE = "HYDRA_UMC_TELEMETRY_COLLECTOR_URL";
export const COLLECTOR_TOKEN_VARIABLES = ["HYDRA_UMC_TELEMETRY_COLLECTOR_TOKEN"] as const;
export const INTERVAL_VARIABLE = "HYDRA_UMC_TELEMETRY_INTERVAL_MS";

export const DEFAULT_INTERVAL_MS = 1000;
export const MIN_INTERVAL_MS = 100;
export const MAX_INTERVAL_MS = 60_000;
export const MAX_SOURCES = 256;
export const MAX_FIELDS = 32;
export const MAX_DEPTH = 2;
export const REQUEST_TIMEOUT_MS = 2000;
export const FAILURE_PAUSE_MS = 30_000;

export type Delta = { controllerId: string; robotId: number; patch: Record<string, unknown> };
export type SampleBody = { sourceId: string; kind: string; timestamp: number; fields: Record<string, number>; sequence: number };

export interface ProducerOptions {
  url: string;
  token?: string;
  intervalMs?: number;
  now?: () => number;
  post?: (url: string, init: { headers: Record<string, string>; body: string; signal: AbortSignal }) => Promise<{ ok: boolean; status: number }>;
}

/** The interval from the environment, clamped; the default when it is missing or not a number. */
export function intervalFrom(env: Env = process.env): number {
  const raw = Number((env[INTERVAL_VARIABLE] ?? "").trim());
  if (!Number.isFinite(raw) || raw <= 0) return DEFAULT_INTERVAL_MS;
  return Math.min(Math.max(Math.round(raw), MIN_INTERVAL_MS), MAX_INTERVAL_MS);
}

/** The address of the collector's write route for samples, or empty when the producer is off or the address is not an http(s) address. */
export function ingestUrlFrom(env: Env = process.env): string {
  const raw = (env[COLLECTOR_URL_VARIABLE] ?? "").trim();
  if (!raw) return "";
  try {
    const url = new URL(raw);
    if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password) return "";
    return `${url.origin}${url.pathname.replace(/\/+$/, "")}/ingest/ws`;
  } catch {
    return "";
  }
}

const KEY_PATTERN = /^[A-Za-z0-9_]{1,40}$/;

/** The numbers of a patch as a flat map of fields: `pos.x` -> `pos_x`, a boolean -> 0 or 1. Strings, arrays and anything deeper than MAX_DEPTH are left out. */
export function flattenPatch(patch: unknown, prefix = "", depth = 0, out: Record<string, number> = {}): Record<string, number> {
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) return out;
  for (const [key, value] of Object.entries(patch as Record<string, unknown>)) {
    if (Object.keys(out).length >= MAX_FIELDS) break;
    if (!KEY_PATTERN.test(key)) continue;
    const name = prefix ? `${prefix}_${key}` : key;
    if (typeof value === "number") {
      if (Number.isFinite(value)) out[name] = value;
    } else if (typeof value === "boolean") {
      out[name] = value ? 1 : 0;
    } else if (value && typeof value === "object" && !Array.isArray(value) && depth + 1 < MAX_DEPTH) {
      flattenPatch(value, name, depth + 1, out);
    }
  }
  return out;
}

export function sourceIdOf(delta: Delta): string {
  const safe = (text: string) => text.replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, 48) || "x";
  return `robot-${safe(String(delta.controllerId))}-${Math.trunc(Number(delta.robotId))}`;
}

export class TelemetryProducer {
  private readonly pending = new Map<string, Record<string, number>>();
  private readonly sequences = new Map<string, number>();
  private timer: ReturnType<typeof setInterval> | undefined;
  private pausedUntil = 0;
  private sending = false;
  readonly stats = { sent: 0, failed: 0, dropped: 0 };

  constructor(private readonly options: ProducerOptions) {}

  private now(): number {
    return (this.options.now ?? Date.now)();
  }

  /** Records the numbers of these deltas; nothing is sent here. */
  record(deltas: Delta[]): void {
    for (const delta of deltas) {
      const fields = flattenPatch(delta.patch);
      if (Object.keys(fields).length === 0) continue;
      const source = sourceIdOf(delta);
      let slot = this.pending.get(source);
      if (!slot) {
        if (this.pending.size >= MAX_SOURCES) {
          this.stats.dropped += 1;
          continue;
        }
        slot = {};
        this.pending.set(source, slot);
      }
      for (const [name, value] of Object.entries(fields)) {
        if (name in slot || Object.keys(slot).length < MAX_FIELDS) slot[name] = value;
      }
    }
  }

  /** The samples to send now, one per robot with something pending; empties the pending set. */
  private takeSamples(): SampleBody[] {
    const timestamp = this.now();
    const samples: SampleBody[] = [];
    for (const [sourceId, fields] of this.pending) {
      const sequence = (this.sequences.get(sourceId) ?? 0) + 1;
      this.sequences.set(sourceId, sequence);
      samples.push({ sourceId, kind: "robot_state", timestamp, fields, sequence });
    }
    this.pending.clear();
    return samples;
  }

  /** Sends what is pending, one request per robot, unless a send is under way or the last one failed a moment ago. */
  async flush(): Promise<void> {
    if (this.sending || this.pending.size === 0 || this.now() < this.pausedUntil) return;
    this.sending = true;
    try {
      const headers: Record<string, string> = { "content-type": "application/json", ...bearerHeader(this.options.token ?? "") };
      const post = this.options.post ?? (async (url, init) => {
        const response = await fetch(url, { method: "POST", ...init });
        return { ok: response.ok, status: response.status };
      });
      for (const sample of this.takeSamples()) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
        try {
          const answer = await post(this.options.url, { headers, body: JSON.stringify(sample), signal: controller.signal });
          if (answer.ok) {
            this.stats.sent += 1;
          } else {
            // a refusal of this sample (bad request) is not the collector being down: count it and go on; an outage pauses the producer
            this.stats.failed += 1;
            if (answer.status >= 500 || answer.status === 401 || answer.status === 403) {
              this.pausedUntil = this.now() + FAILURE_PAUSE_MS;
              break;
            }
          }
        } catch {
          this.stats.failed += 1;
          this.pausedUntil = this.now() + FAILURE_PAUSE_MS;
          break;
        } finally {
          clearTimeout(timer);
        }
      }
    } finally {
      this.sending = false;
    }
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.flush();
    }, this.options.intervalMs ?? DEFAULT_INTERVAL_MS);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }
}

/** The producer the environment asks for, or none when no collector address is configured. */
export function createTelemetryProducer(env: Env = process.env): TelemetryProducer | undefined {
  const url = ingestUrlFrom(env);
  if (!url) return undefined;
  return new TelemetryProducer({ url, token: resolveToken(COLLECTOR_TOKEN_VARIABLES, env), intervalMs: intervalFrom(env) });
}
