// =============================================================================
// HYDRA-UMC-SERVER - src/ingestLog.ts
// Copyright (C) 2026 JuanenRac (Electro Hobby 3D) <electrohobby3d@gmail.com>
// GPL-3.0-or-later - see LICENSE
// =============================================================================
// A small append-only record of what other services hand to this server (scenario outcomes, the status of the developer node, the
// feed of faults). Every record is chained to the one before it by a hash and signed with the key of this server, so a record that
// was changed, removed from the middle or forged can be found by `verify()`. Old records are dropped by age and by count (the
// retention is configurable); the first record kept names the hash it followed, so the chain still checks after a trim.
//
// One JSON object per line. The file is read whole on start (the retention keeps it small) and rewritten only when a trim happens.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export interface LogRecord {
  /** Position in the chain; grows by one for every record, never reused. */
  seq: number;
  /** Milliseconds since the epoch, by the clock of this server. */
  at: number;
  kind: string;
  payload: unknown;
  /** The hash of the previous record ("" for the first record ever written). */
  prev: string;
  hash: string;
  /** HMAC-SHA256 over the hash, with the key of this server (hex). */
  sig: string;
}

export interface Retention {
  /** Records older than this many days are dropped (0 = no age limit). */
  maxAgeDays: number;
  /** At most this many records are kept (0 = no count limit). */
  maxRecords: number;
}

export const DEFAULT_RETENTION: Retention = { maxAgeDays: 30, maxRecords: 5000 };

/** Canonical JSON: keys sorted, so the same content always has the same hash. */
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).filter(([, v]) => v !== undefined).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function hashOf(seq: number, at: number, kind: string, payload: unknown, prev: string): string {
  return crypto.createHash("sha256").update(canonical({ seq, at, kind, payload, prev })).digest("hex");
}

function sign(key: string, hash: string): string {
  return crypto.createHmac("sha256", key).update(hash).digest("hex");
}

export class ChainedLog {
  private records: LogRecord[] = [];
  private nextSeq = 0;

  constructor(
    private readonly file: string,
    private readonly key: () => string,
    private readonly retention: () => Retention = () => DEFAULT_RETENTION,
    private readonly now: () => number = Date.now,
  ) {
    this.load();
  }

  private load(): void {
    let text = "";
    try { text = fs.readFileSync(this.file, "utf8"); } catch { return; }
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      try { this.records.push(JSON.parse(line) as LogRecord); } catch { /* a torn last line is skipped */ }
    }
    const last = this.records[this.records.length - 1];
    this.nextSeq = last ? last.seq + 1 : 0;
  }

  /** Adds a record. Throws when the key of the server is not usable: nothing unsigned is ever written. */
  append(kind: string, payload: unknown): LogRecord {
    const key = this.key();
    if (!key) throw new Error("no usable signing key");
    const prev = this.records.length ? this.records[this.records.length - 1].hash : "";
    const seq = this.nextSeq;
    const at = this.now();
    const hash = hashOf(seq, at, kind, payload, prev);
    const record: LogRecord = { seq, at, kind, payload, prev, hash, sig: sign(key, hash) };
    this.records.push(record);
    this.nextSeq = seq + 1;
    if (this.trim()) this.rewrite();
    else {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.appendFileSync(this.file, JSON.stringify(record) + "\n", { mode: 0o600 });
    }
    return record;
  }

  private trim(): boolean {
    const { maxAgeDays, maxRecords } = this.retention();
    const before = this.records.length;
    if (maxAgeDays > 0) {
      const cutoff = this.now() - maxAgeDays * 86_400_000;
      while (this.records.length > 1 && this.records[0].at < cutoff) this.records.shift();
    }
    if (maxRecords > 0) while (this.records.length > maxRecords) this.records.shift();
    return this.records.length !== before;
  }

  private rewrite(): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, this.records.map((r) => JSON.stringify(r)).join("\n") + "\n", { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }

  /** The newest records, newest first; `kind` narrows them. */
  list(limit = 100, kind?: string): LogRecord[] {
    const pool = kind ? this.records.filter((r) => r.kind === kind) : this.records;
    return pool.slice(-Math.max(1, limit)).reverse();
  }

  count(): number { return this.records.length; }

  /** Checks the hash chain and every signature. `ok` is false at the first record that does not fit; `brokenAt` is its seq. */
  verify(): { ok: boolean; records: number; brokenAt?: number; reason?: string } {
    const key = this.key();
    let prev: string | null = null;
    for (const r of this.records) {
      if (prev !== null && r.prev !== prev) return { ok: false, records: this.records.length, brokenAt: r.seq, reason: "chain" };
      if (hashOf(r.seq, r.at, r.kind, r.payload, r.prev) !== r.hash) return { ok: false, records: this.records.length, brokenAt: r.seq, reason: "hash" };
      if (!key || !timingEqual(sign(key, r.hash), r.sig)) return { ok: false, records: this.records.length, brokenAt: r.seq, reason: "signature" };
      prev = r.hash;
    }
    return { ok: true, records: this.records.length };
  }
}

function timingEqual(a: string, b: string): boolean {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}
