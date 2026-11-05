// =============================================================================
// HYDRA-UMC-SERVER - src/anomalyFeed.ts
// Copyright (C) 2026 JuanenRac (Electro Hobby 3D) <electrohobby3d@gmail.com>
// GPL-3.0-or-later - see LICENSE
// =============================================================================
// The verdicts of the anomaly detector (`anomaly-verdict/1`), read from the broker the server already uses, where the detector leaves one
// retained message per series. The server keeps the latest verdict of each series (rebuilt from a signed hash-chained record when it starts),
// records every CHANGE of verdict in that record, and can hand a verdict that is worth saying aloud to the voice interface (the voice
// interface decides the sentence, the language and whether to say it now; see `voiceAlertBody`). Read only: nothing here moves hardware.
import { ChainedLog } from "./ingestLog";

export type Env = Record<string, string | undefined>;

export const SWITCH_ANOMALY_FEED = "HYDRA_UMC_ANOMALY_FEED";
export const SWITCH_ANOMALY_VOICE_RELAY = "HYDRA_UMC_ANOMALY_VOICE_RELAY";
export const VERDICTS = ["normal", "suspect", "anomalous"] as const;
export type VerdictName = (typeof VERDICTS)[number];

export interface AnomalyVerdict {
  schema: "anomaly-verdict/1";
  sourceId: string;
  kind: string;
  field: string;
  verdict: VerdictName;
  score: number;
  threshold: number | null;
  modelVersion: number | string | null;
  /** Milliseconds, as the detector stamped the window; 0 when it did not say. */
  timestamp: number;
}

const NAME = /^[A-Za-z0-9_.-]{1,64}$/;

/** An `anomaly-verdict/1` message (`{"schema", "source_id", "kind", "field", "verdict", "score", "threshold"?, "model_version"?, "timestamp"?}`); null when it is not one. */
export function parseAnomalyVerdict(raw: unknown): AnomalyVerdict | null {
  let o: any = raw;
  if (typeof raw === "string" || Buffer.isBuffer(raw)) { try { o = JSON.parse(raw.toString()); } catch { return null; } }
  if (!o || typeof o !== "object" || Array.isArray(o) || o.schema !== "anomaly-verdict/1") return null;
  if (![o.source_id, o.kind, o.field].every((v) => typeof v === "string" && NAME.test(v))) return null;
  if (!VERDICTS.includes(o.verdict)) return null;
  if (typeof o.score !== "number" || !Number.isFinite(o.score)) return null;
  const threshold = typeof o.threshold === "number" && Number.isFinite(o.threshold) ? o.threshold : null;
  const modelVersion = typeof o.model_version === "number" || (typeof o.model_version === "string" && o.model_version.length <= 64) ? o.model_version : null;
  const timestamp = typeof o.timestamp === "number" && Number.isFinite(o.timestamp) ? o.timestamp : 0;
  return { schema: "anomaly-verdict/1", sourceId: o.source_id, kind: o.kind, field: o.field, verdict: o.verdict, score: o.score, threshold, modelVersion, timestamp };
}

const keyOf = (v: AnomalyVerdict) => `${v.sourceId}|${v.kind}|${v.field}`;

export class AnomalyFeed {
  private latest = new Map<string, AnomalyVerdict & { at: number }>();
  private alerts = new Map<string, Record<string, unknown>>();

  constructor(readonly log: ChainedLog, private readonly now: () => number = Date.now) {
    // oldest first, so the last word on each series wins
    for (const r of [...log.list(Number.MAX_SAFE_INTEGER, "verdict")].reverse()) this.latest.set(keyOf(r.payload as AnomalyVerdict), { ...(r.payload as AnomalyVerdict), at: r.at });
  }

  /** Keeps the verdict as the latest of its series. Returns the verdict it replaced (null for the first one) and whether the verdict CHANGED; only a change is written to the record. */
  record(verdict: AnomalyVerdict): { changed: boolean; previous: VerdictName | null } {
    const key = keyOf(verdict);
    const before = this.latest.get(key);
    const changed = !before || before.verdict !== verdict.verdict;
    if (changed) this.log.append("verdict", verdict);
    this.latest.set(key, { ...verdict, at: this.now() });
    return { changed, previous: before ? before.verdict : null };
  }

  /** Keeps what the voice interface answered about the latest verdict of a series (the sentence code and whether it is to be said now). */
  setAlert(verdict: AnomalyVerdict, reply: Record<string, unknown>): void {
    this.alerts.set(keyOf(verdict), reply);
  }

  /** How a node is doing: the worst latest verdict among the series of that node (names are compared without spaces, dashes or capitals), or "unknown". */
  stateOfNode(node: string): VerdictName | "unknown" {
    const compact = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
    const wanted = compact(node);
    if (!wanted) return "unknown";
    let worst = -1;
    for (const v of this.latest.values()) if (compact(v.sourceId) === wanted) worst = Math.max(worst, VERDICTS.indexOf(v.verdict));
    return worst < 0 ? "unknown" : VERDICTS[worst];
  }

  /** The latest verdict of every series (with the answer of the voice interface when it was asked); `only` narrows it to one verdict. */
  verdicts(only?: VerdictName): Array<AnomalyVerdict & { at: number; alert?: Record<string, unknown> }> {
    const all = [...this.latest.entries()].map(([key, v]) => (this.alerts.has(key) && v.verdict !== "normal" ? { ...v, alert: this.alerts.get(key) } : v));
    return only ? all.filter((v) => v.verdict === only) : all;
  }
}

/** The body for `POST /v1/voice/alert` of the voice interface: a verdict that is not normal, as an alert about the node. Null for a normal verdict (it is never spoken). */
export function voiceAlertBody(verdict: AnomalyVerdict, locale: string): Record<string, unknown> | null {
  if (verdict.verdict === "normal") return null;
  const id = `anomaly-${verdict.sourceId}-${verdict.kind}-${verdict.field}`.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 52) + `-${verdict.verdict}`;
  return {
    alertId: id.slice(0, 64),
    source: "anomaly",
    severity: verdict.verdict === "anomalous" ? "critical" : "warning",
    locale,
    node: verdict.sourceId,
    verdict: verdict.verdict,
  };
}

export function anomalyTopicFromEnv(env: Env = process.env): string {
  const t = (env.HYDRA_UMC_ANOMALY_FEED_TOPIC ?? "hydra/anomaly/verdict/#").trim();
  return /^[A-Za-z0-9._\-/+#]+$/.test(t) && !t.startsWith("/") && !t.includes("//") ? t : "hydra/anomaly/verdict/#";
}
