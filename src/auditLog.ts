// =============================================================================
// HYDRA-UMC-SERVER - src/auditLog.ts
// Copyright (C) 2026 JuanenRac (Electro Hobby 3D) <electrohobby3d@gmail.com>
// GPL-3.0-or-later - see LICENSE
// =============================================================================
// The audit record: a bounded, append-only log of the changes that matter (claims, forced
// releases, safety limits, jog arming, global stops, table moves). One JSON object per line in
// data/audit.jsonl; every line carries the SHA-256 of the line before it, so a line that is
// removed or edited later shows when the chain is verified. The file is rotated by size (the
// chain goes on in the new file) and the newest files are copied next to the settings backups.
// Everything written passes through the shared secret redaction.
import fs from "node:fs";
import path from "node:path";
import nodeCrypto from "node:crypto";
import { redactJson } from "./redaction";

export const AUDIT_FILE = "audit.jsonl";
const ROTATED_PREFIX = "audit-";

export interface AuditEvent {
  /** Short stable name: claim, release, force-claim, force-release, safety-limits, jog-arm, stop-all, table-move, ... */
  type: string;
  outcome: "ok" | "refused" | "failed";
  userId?: unknown;
  username?: string;
  controllerId?: string;
  ip?: string;
  robotId?: number;
  detail?: Record<string, unknown>;
}

export interface AuditEntry extends AuditEvent {
  seq: number;
  ts: string;
  prev: string;
  hash: string;
}

export interface AuditOptions {
  enabled?: boolean;
  maxBytes?: number;
  keep?: number;
  log?: (message: string) => void;
}

const GENESIS = "0".repeat(64);

function hashOf(entry: Omit<AuditEntry, "hash">): string {
  return nodeCrypto.createHash("sha256").update(JSON.stringify(entry)).digest("hex");
}

/** Reads the audit option from the environment: on unless HYDRA_UMC_AUDIT is off. */
export function auditOptionsFromEnv(env: NodeJS.ProcessEnv): AuditOptions {
  const number = (name: string, fallback: number) => {
    const value = Number(env[name]);
    return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
  };
  return {
    enabled: (env.HYDRA_UMC_AUDIT ?? "").trim().toLowerCase() !== "off",
    maxBytes: number("HYDRA_UMC_AUDIT_MAX_BYTES", 5 * 1024 * 1024),
    keep: number("HYDRA_UMC_AUDIT_KEEP", 5),
  };
}

export class AuditLog {
  private readonly file: string;
  private seq = 0;
  private lastHash = GENESIS;
  private enabledFlag: boolean;
  private readonly maxBytes: number;
  private readonly keep: number;
  private readonly log: (message: string) => void;
  /** True when the environment of the deployment switched the record off; the panel cannot switch it on. */
  readonly lockedOff: boolean;

  constructor(private readonly dataPath: string, options: AuditOptions = {}) {
    this.file = path.join(dataPath, AUDIT_FILE);
    this.enabledFlag = options.enabled !== false;
    this.lockedOff = options.enabled === false;
    this.maxBytes = options.maxBytes ?? 5 * 1024 * 1024;
    this.keep = options.keep ?? 5;
    this.log = options.log ?? (() => undefined);
    this.resume();
  }

  /** Continues the chain from the last line already on disk. */
  private resume(): void {
    const last = this.readFileEntries(this.file).at(-1);
    if (last) {
      this.seq = last.seq;
      this.lastHash = last.hash;
    }
  }

  get enabled(): boolean {
    return this.enabledFlag && !this.lockedOff;
  }

  /** The administrator's switch (kept in the safety limits). The environment may still lock it off. */
  setEnabled(value: boolean): void {
    this.enabledFlag = value;
  }

  /** Appends one event. Never throws: a failing disk must not stop a robot command; it is logged instead. */
  record(event: AuditEvent): AuditEntry | null {
    if (!this.enabled) return null;
    try {
      fs.mkdirSync(this.dataPath, { recursive: true });
      this.rotateIfNeeded();
      const clean = redactJson({ ...event }) as AuditEvent;
      const body: Omit<AuditEntry, "hash"> = { seq: this.seq + 1, ts: new Date().toISOString(), prev: this.lastHash, ...clean };
      const entry: AuditEntry = { ...body, hash: hashOf(body) };
      fs.appendFileSync(this.file, JSON.stringify(entry) + "\n", { encoding: "utf-8" });
      this.seq = entry.seq;
      this.lastHash = entry.hash;
      return entry;
    } catch (error) {
      this.log(`[AUDIT] could not record ${event.type}: ${error instanceof Error ? error.message : "unknown error"}`);
      return null;
    }
  }

  private rotateIfNeeded(): void {
    let size = 0;
    try { size = fs.statSync(this.file).size; } catch { return; }
    if (size < this.maxBytes) return;
    const target = path.join(this.dataPath, `${ROTATED_PREFIX}${String(this.seq).padStart(10, "0")}.jsonl`);
    fs.renameSync(this.file, target);
    const rotated = this.rotatedFiles();
    for (const old of rotated.slice(0, Math.max(0, rotated.length - this.keep))) {
      try { fs.unlinkSync(path.join(this.dataPath, old)); } catch { /* best effort */ }
    }
  }

  private rotatedFiles(): string[] {
    try {
      return fs.readdirSync(this.dataPath).filter((n) => n.startsWith(ROTATED_PREFIX) && n.endsWith(".jsonl")).sort();
    } catch {
      return [];
    }
  }

  private readFileEntries(file: string): AuditEntry[] {
    let text = "";
    try { text = fs.readFileSync(file, "utf-8"); } catch { return []; }
    const entries: AuditEntry[] = [];
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      try { entries.push(JSON.parse(line) as AuditEntry); } catch { /* a damaged line is reported by verify() */ }
    }
    return entries;
  }

  /** The newest entries (oldest first), newest `limit`, optionally filtered. Reads the rotated files too when the live one is short. */
  read(query: { limit?: number; afterSeq?: number; type?: string; robotId?: number } = {}): AuditEntry[] {
    const limit = Math.min(Math.max(query.limit ?? 100, 1), 1000);
    let all = this.readFileEntries(this.file);
    if (all.length < limit) {
      for (const name of this.rotatedFiles().reverse()) {
        all = [...this.readFileEntries(path.join(this.dataPath, name)), ...all];
        if (all.length >= limit) break;
      }
    }
    return all
      .filter((e) => (query.afterSeq === undefined || e.seq > query.afterSeq)
        && (query.type === undefined || e.type === query.type)
        && (query.robotId === undefined || e.robotId === query.robotId))
      .slice(-limit);
  }

  /** Checks the chain of every file on disk; says where it breaks. */
  verify(): { ok: boolean; entries: number; brokenAtSeq?: number; reason?: string } {
    const files = [...this.rotatedFiles().map((n) => path.join(this.dataPath, n)), this.file];
    let entries = 0;
    let expectedPrev: string | null = null;
    for (const file of files) {
      let text = "";
      try { text = fs.readFileSync(file, "utf-8"); } catch { continue; }
      for (const line of text.split("\n")) {
        if (!line.trim()) continue;
        let entry: AuditEntry;
        try { entry = JSON.parse(line) as AuditEntry; } catch { return { ok: false, entries, reason: "a line is not valid JSON" }; }
        const { hash, ...rest } = entry;
        if (hashOf(rest) !== hash) return { ok: false, entries, brokenAtSeq: entry.seq, reason: "a line was changed" };
        if (expectedPrev !== null && entry.prev !== expectedPrev) return { ok: false, entries, brokenAtSeq: entry.seq, reason: "a line is missing before this one" };
        expectedPrev = hash;
        entries++;
      }
    }
    return { ok: true, entries };
  }

  /** Copies the live file and the rotated ones next to the settings backups; keeps the newest `keepCopies`. */
  backupTo(backupDir: string, stampText: string, keepCopies: number): string | null {
    if (keepCopies <= 0) return null;
    try {
      if (!fs.existsSync(this.file)) return null;
      fs.mkdirSync(backupDir, { recursive: true });
      const target = path.join(backupDir, `audit-backup-${stampText}.jsonl`);
      fs.copyFileSync(this.file, target);
      const copies = fs.readdirSync(backupDir).filter((n) => n.startsWith("audit-backup-")).sort();
      for (const old of copies.slice(0, Math.max(0, copies.length - keepCopies))) {
        try { fs.unlinkSync(path.join(backupDir, old)); } catch { /* best effort */ }
      }
      return target;
    } catch (error) {
      this.log(`[AUDIT] backup failed: ${error instanceof Error ? error.message : "unknown error"}`);
      return null;
    }
  }
}
