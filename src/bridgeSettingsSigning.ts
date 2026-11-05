// =============================================================================
// HYDRA-UMC-SERVER - src/bridgeSettingsSigning.ts
// Copyright (C) 2026 JuanenRac (Electro Hobby 3D) <electrohobby3d@gmail.com>
// GPL-3.0-or-later - see LICENSE
// =============================================================================
// The retained settings message of a machine bridge (`<prefix>/<bridge>/settings`) is SIGNED. Anyone who may publish on that topic could otherwise change
// the switches of a bridge whose host allows remote settings; with the signature a bridge applies a message only when it was made with the key that the
// server and that bridge share, it has not expired, it is not from the future, and its counter is not older than the last one the bridge applied.
//
// The signature is the one of the signed commands of the SDK (hydra_umc_sdk.signed_commands): the HMAC-SHA256 (64 lowercase hexadecimal digits) of
// `hydra-umc-cmd-v1`, a newline, the topic, a newline and the payload without `signature` written as JSON with sorted keys, no spaces and ASCII escapes.
// The signed message is schema 2 (schema 1 was the unsigned one, which a bridge no longer reads): {schema, settings, seq, issued_at_ms, expires_in_ms, signature}.
//
// One key per bridge, in its own file (never in the configuration, never in a log or an answer): by default ~/.hydra-umc-keys/bridge-settings/<bridge>.key, or the
// folder named by HYDRA_UMC_BRIDGE_SETTINGS_KEY_DIR. A missing key is made once (64 hexadecimal digits, mode 600) so the operator can copy it to the host of the
// bridge; an unreadable or short key means the bridge gets no message at all (it then keeps its own configuration: the conservative result).
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { BridgeName } from "./bridgeSettings";

export const SETTINGS_SIGNED_SCHEMA = 2;
export const SIGNING_DOMAIN = "hydra-umc-cmd-v1";
export const MIN_KEY_CHARS = 32;
/** How long a message stays valid. The bridge accepts at most 300000 ms; the gateway repeats the message well before this runs out. */
export const SETTINGS_EXPIRES_IN_MS = 120_000;
/** How often the gateway signs and publishes the messages again, so a bridge that restarts always finds a current one. */
export const SETTINGS_REFRESH_MS = 60_000;

export type KeyState = "present" | "missing" | "unusable";
export interface SigningStatus {
  /** Where the key of the bridge is kept (the path only; the key is never shown). */
  keyFile: string;
  key: KeyState;
  lastSignedAt: string | null;
  seq: number;
}

/** JSON with sorted keys, no spaces and ASCII escapes: the bytes that the Python side writes for the same message. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) throw new Error("only whole numbers can be signed");
    return String(value);
  }
  if (typeof value === "string") {
    let out = '"';
    for (let i = 0; i < value.length; i += 1) {
      const code = value.charCodeAt(i);
      const ch = value[i];
      if (ch === '"') out += '\\"';
      else if (ch === "\\") out += "\\\\";
      else if (ch === "\n") out += "\\n";
      else if (ch === "\r") out += "\\r";
      else if (ch === "\t") out += "\\t";
      else if (ch === "\b") out += "\\b";
      else if (ch === "\f") out += "\\f";
      else if (code < 0x20 || code > 0x7e) out += `\\u${code.toString(16).padStart(4, "0")}`;
      else out += ch;
    }
    return `${out}"`;
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((k) => `${canonicalJson(k)}:${canonicalJson(record[k])}`).join(",")}}`;
  }
  throw new Error("this value cannot be signed");
}

export function signatureOf(topic: string, payload: Record<string, unknown>, key: string): string {
  const { signature: _ignored, ...body } = payload;
  void _ignored;
  return createHmac("sha256", key).update(`${SIGNING_DOMAIN}\n${topic}\n${canonicalJson(body)}`).digest("hex");
}

/** The message for `topic`: `body` plus `seq`, `issued_at_ms`, `expires_in_ms` and `signature`. */
export function signSettings(topic: string, body: Record<string, unknown>, key: string, seq: number, nowMs: number, expiresInMs: number = SETTINGS_EXPIRES_IN_MS): Record<string, unknown> {
  if (key.length < MIN_KEY_CHARS) throw new Error(`the key must have at least ${MIN_KEY_CHARS} characters`);
  const signed: Record<string, unknown> = { ...body, schema: SETTINGS_SIGNED_SCHEMA, seq, issued_at_ms: nowMs, expires_in_ms: expiresInMs };
  signed.signature = signatureOf(topic, signed, key);
  return signed;
}

export interface SettingsVerdict {
  ok: boolean;
  reason: string;
}

export const MAX_CLOCK_SKEW_MS = 5_000;
export const MAX_EXPIRES_IN_MS = 300_000;

/** The rules a bridge applies to the message (the same as the bridges' own check, kept here so the server can test what it publishes): the signature first, then
 *  the time, then the counter (`lastSeq` is the largest counter the bridge applied; an older one is a replay, the same one again is harmless). */
export function verifySettings(topic: string, message: unknown, key: string, nowMs: number, lastSeq = -1): SettingsVerdict {
  if (typeof message !== "object" || message === null || Array.isArray(message)) return { ok: false, reason: "not a JSON object" };
  const m = message as Record<string, unknown>;
  if (m.schema !== SETTINGS_SIGNED_SCHEMA) return { ok: false, reason: "not the signed schema" };
  const { issued_at_ms: issued, expires_in_ms: expires, signature, seq } = m;
  if (typeof issued !== "number" || !Number.isInteger(issued) || issued < 0 || typeof expires !== "number" || !Number.isInteger(expires) || expires <= 0) return { ok: false, reason: "bad times" };
  if (typeof signature !== "string" || !/^[0-9a-f]{64}$/.test(signature)) return { ok: false, reason: "bad signature format" };
  let expected: string;
  try {
    expected = signatureOf(topic, m, key);
  } catch {
    return { ok: false, reason: "cannot be written the way it was signed" };
  }
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return { ok: false, reason: "signature does not match" };
  if (expires > MAX_EXPIRES_IN_MS) return { ok: false, reason: "asks too long a life" };
  if (issued > nowMs + MAX_CLOCK_SKEW_MS) return { ok: false, reason: "issued in the future" };
  if (nowMs > issued + expires) return { ok: false, reason: "expired" };
  if (typeof seq !== "number" || !Number.isInteger(seq) || seq < 0) return { ok: false, reason: "no counter" };
  if (seq < lastSeq) return { ok: false, reason: "replay" };
  return { ok: true, reason: "signed and current" };
}

export interface BridgeSettingsSignerOptions {
  /** Folder of the key files (default: HYDRA_UMC_BRIDGE_SETTINGS_KEY_DIR, else ~/.hydra-umc-keys/bridge-settings). */
  keyDir?: string;
  now?: () => number;
  log?: (message: string) => void;
}

export function defaultKeyDir(env: NodeJS.ProcessEnv = process.env): string {
  const named = (env.HYDRA_UMC_BRIDGE_SETTINGS_KEY_DIR ?? "").trim();
  return named || path.join(os.homedir(), ".hydra-umc-keys", "bridge-settings");
}

export class BridgeSettingsSigner {
  private readonly keyDir: string;
  private readonly now: () => number;
  private readonly log: (message: string) => void;
  private readonly lastSeq = new Map<string, number>();
  private readonly lastAt = new Map<string, number>();

  constructor(options: BridgeSettingsSignerOptions = {}) {
    this.keyDir = options.keyDir ?? defaultKeyDir();
    this.now = options.now ?? Date.now;
    this.log = options.log ?? (() => undefined);
  }

  keyPath(name: BridgeName | string): string {
    return path.join(this.keyDir, `${name}.key`);
  }

  private readKey(name: string): { state: KeyState; key?: string } {
    const file = this.keyPath(name);
    let raw: string;
    try {
      raw = fs.readFileSync(file, "utf8");
    } catch (error) {
      return { state: (error as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "unusable" };
    }
    const key = raw.trim();
    return key.length >= MIN_KEY_CHARS ? { state: "present", key } : { state: "unusable" };
  }

  /** Makes the key of the bridge when there is none (64 hexadecimal digits, mode 600, never overwrites). Returns the state afterwards. */
  ensureKey(name: BridgeName | string): KeyState {
    const found = this.readKey(name);
    if (found.state !== "missing") return found.state;
    try {
      fs.mkdirSync(this.keyDir, { recursive: true, mode: 0o700 });
      fs.writeFileSync(this.keyPath(name), `${randomBytes(32).toString("hex")}\n`, { flag: "wx", mode: 0o600 });
      this.log(`[GATEWAY] made the key that signs the settings of the ${name} bridge (${this.keyPath(name)}); copy it to the host of the bridge`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        this.log(`[GATEWAY] could not make the key of the ${name} bridge: ${(error as Error).message}`);
        return "unusable";
      }
    }
    return this.readKey(name).state;
  }

  /** The signed message for the bridge, or null when its key cannot be used (then nothing is published for it). The counter only goes up. */
  sign(topic: string, name: BridgeName | string, body: Record<string, unknown>): Record<string, unknown> | null {
    if (this.ensureKey(name) !== "present") return null;
    const { key } = this.readKey(name);
    if (!key) return null;
    const nowMs = this.now();
    const seq = Math.max(nowMs, (this.lastSeq.get(name) ?? 0) + 1);
    this.lastSeq.set(name, seq);
    this.lastAt.set(name, nowMs);
    return signSettings(topic, body, key, seq, nowMs);
  }

  status(names: readonly string[]): Record<string, SigningStatus> {
    const out: Record<string, SigningStatus> = {};
    for (const name of names) {
      const at = this.lastAt.get(name);
      out[name] = { keyFile: this.keyPath(name), key: this.readKey(name).state, lastSignedAt: at ? new Date(at).toISOString() : null, seq: this.lastSeq.get(name) ?? 0 };
    }
    return out;
  }
}
