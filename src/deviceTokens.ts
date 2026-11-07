// =============================================================================
// HYDRA-UMC-SERVER - src/deviceTokens.ts
// Copyright (C) 2026 JuanenRac (Electro Hobby 3D) <electrohobby3d@gmail.com>
// GPL-3.0-or-later - see LICENSE
// =============================================================================
// Signed tokens for one device (the screen of a Compute Module, a kiosk): an administrator issues a token for a device and the account
// it signs in as, the device exchanges it for a normal short sign-in (POST /api/device/login) and renews that sign-in without a person
// typing a password. A token belongs to one device, expires and can be revoked at any time. The token is signed with a key derived from
// the server's own secret (and not the key of any other ticket); the server keeps only the record of the token (its id, the account,
// the dates), never the token itself, so a copy of the record file opens nothing. Off by default (deviceTokens.enabled).
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const DEVICE_TOKEN_PREFIX = "hdt1";
export const DEVICE_TOKEN_DEFAULT_DAYS = 30;
export const DEVICE_TOKEN_MIN_DAYS = 1;
/** The longest life a configured maximum may allow. */
export const DEVICE_TOKEN_LIMIT_DAYS = 365;
export const DEVICE_TOKEN_DEFAULT_MAX_DEVICES = 20;
export const DEVICE_TOKEN_LIMIT_MAX_DEVICES = 500;
export const DEVICE_SESSION_DEFAULT_MINUTES = 15;
export const DEVICE_SESSION_MIN_MINUTES = 5;
export const DEVICE_SESSION_LIMIT_MINUTES = 24 * 60;
/** A record that expired or was revoked is forgotten after this many days. */
export const DEVICE_RECORD_KEEP_DAYS = 90;
const DAY_MS = 86_400_000;

/** What the configuration file may hold in the `deviceTokens` block besides the switch (not security switches: read from the file only). */
export interface DeviceTokenLimits {
  /** Life of a token when the request does not ask for another (1 to maxTtlDays; 30 by default). */
  ttlDays?: unknown;
  /** The longest life a token may be asked for (1 to 365; 90 by default). */
  maxTtlDays?: unknown;
  /** How many tokens may be active at once (1 to 500; 20 by default). */
  maxDevices?: unknown;
  /** Life of the sign-in a device gets for its token, in minutes (5 to 1440; 15 by default): the longest a revoked device keeps working. */
  accessMinutes?: unknown;
}

export const DEVICE_TOKEN_DEFAULT_MAX_DAYS = 90;

function clamp(value: unknown, fallback: number, min: number, max: number): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.min(max, Math.max(min, Math.floor(value))) : fallback;
}

export function deviceTokenMaxDays(limits: DeviceTokenLimits | undefined): number {
  return clamp(limits?.maxTtlDays, DEVICE_TOKEN_DEFAULT_MAX_DAYS, DEVICE_TOKEN_MIN_DAYS, DEVICE_TOKEN_LIMIT_DAYS);
}

/** The life, in days, of the token to issue: the one asked for (if any) within the configured maximum, else the configured default. */
export function deviceTokenDays(limits: DeviceTokenLimits | undefined, requested: unknown): number {
  const max = deviceTokenMaxDays(limits);
  const base = Math.min(max, clamp(limits?.ttlDays, DEVICE_TOKEN_DEFAULT_DAYS, DEVICE_TOKEN_MIN_DAYS, DEVICE_TOKEN_LIMIT_DAYS));
  if (typeof requested !== "number" || !Number.isFinite(requested)) return base;
  return Math.min(max, Math.max(DEVICE_TOKEN_MIN_DAYS, Math.floor(requested)));
}

export function deviceTokenMaxDevices(limits: DeviceTokenLimits | undefined): number {
  return clamp(limits?.maxDevices, DEVICE_TOKEN_DEFAULT_MAX_DEVICES, 1, DEVICE_TOKEN_LIMIT_MAX_DEVICES);
}

export function deviceSessionMinutes(limits: DeviceTokenLimits | undefined): number {
  return clamp(limits?.accessMinutes, DEVICE_SESSION_DEFAULT_MINUTES, DEVICE_SESSION_MIN_MINUTES, DEVICE_SESSION_LIMIT_MINUTES);
}

/** The key the tokens are signed with: derived from the server's own secret, and different from the key of every other ticket. */
export function deviceTokenKey(serverSecret: string): Buffer {
  return crypto.createHmac("sha256", serverSecret).update("hydra-device-token-key-v1").digest();
}

function signature(key: Buffer, id: string, username: string, accountId: string, expiresAt: number): string {
  return crypto.createHmac("sha256", key).update(`hydra-device-token-v1|${id}|${username}|${accountId}|${expiresAt}`).digest("base64url");
}

const ID_PATTERN = /^[A-Za-z0-9_-]{22}$/;
export const validDeviceTokenId = (value: unknown): value is string => typeof value === "string" && ID_PATTERN.test(value);

export type DeviceTokenState = "active" | "expired" | "revoked";

/** What is kept about a token: never the token itself. */
export interface DeviceTokenRecord {
  id: string;
  /** What the administrator called the device. */
  name: string;
  /** The account the device signs in as. */
  username: string;
  /** The identity of that account when the token was issued: a deleted and re-created account of the same name does not inherit it. */
  accountId: string;
  createdAt: string;
  createdBy: string;
  expiresAt: string;
  revokedAt?: string;
  lastUsedAt?: string;
}

export interface DeviceTokenView {
  id: string;
  name: string;
  username: string;
  createdAt: string;
  expiresAt: string;
  revokedAt: string | null;
  lastUsedAt: string | null;
  state: DeviceTokenState;
}

export class DeviceTokensFileError extends Error {}
export class DeviceTokenError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export type VerifyResult = { ok: true; record: DeviceTokenRecord } | { ok: false; reason: "malformed" | "unknown" | "signature" | "expired" | "revoked" };

export interface DeviceTokenStoreOptions {
  /** The file the records are kept in (created with owner-only permissions). */
  file: string;
  /** The clock, in milliseconds (tests pass a simulated one). */
  now?: () => number;
  /** The key the tokens are signed with. */
  key: Buffer;
}

export class DeviceTokenStore {
  private readonly file: string;
  private readonly now: () => number;
  private readonly key: Buffer;

  constructor(options: DeviceTokenStoreOptions) {
    this.file = options.file;
    this.now = options.now ?? Date.now;
    this.key = options.key;
  }

  private load(): DeviceTokenRecord[] {
    let raw: string;
    try {
      raw = fs.readFileSync(this.file, "utf-8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw new DeviceTokensFileError(`could not read ${this.file}: ${(error as Error).message}`);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      // A damaged file must never read as "no tokens yet": that would silently forget a revocation.
      throw new DeviceTokensFileError(`${this.file} exists but is not valid JSON: ${(error as Error).message}`);
    }
    if (!Array.isArray(parsed)) throw new DeviceTokensFileError(`${this.file} exists but does not contain a JSON array`);
    return parsed.filter((item): item is DeviceTokenRecord => typeof item === "object" && item !== null && validDeviceTokenId((item as DeviceTokenRecord).id));
  }

  private save(records: DeviceTokenRecord[]): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.${this.now()}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(records, null, 2), { encoding: "utf-8", mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }

  private stateOf(record: DeviceTokenRecord): DeviceTokenState {
    if (record.revokedAt) return "revoked";
    return Date.parse(record.expiresAt) <= this.now() ? "expired" : "active";
  }

  private view(record: DeviceTokenRecord): DeviceTokenView {
    return {
      id: record.id, name: record.name, username: record.username, createdAt: record.createdAt, expiresAt: record.expiresAt,
      revokedAt: record.revokedAt ?? null, lastUsedAt: record.lastUsedAt ?? null, state: this.stateOf(record),
    };
  }

  /** Every record, newest first, with whether it still works. */
  list(): DeviceTokenView[] {
    return this.load().map((record) => this.view(record)).sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
  }

  activeCount(): number {
    return this.load().filter((record) => this.stateOf(record) === "active").length;
  }

  /** Is the token with this id still usable (not revoked, not expired)? A sign-in renewed by a device asks this on every renewal. */
  isActive(id: string): boolean {
    const record = this.load().find((item) => item.id === id);
    return record !== undefined && this.stateOf(record) === "active";
  }

  /** Issues a token for a device. The token is returned once and is not kept. */
  issue(input: { name: string; username: string; accountId: string; days: number; createdBy: string; maxDevices: number }): { token: string; view: DeviceTokenView } {
    const records = this.load();
    const nowMs = this.now();
    const forgotten = (record: DeviceTokenRecord): boolean => this.stateOf(record) !== "active" && nowMs - Date.parse(record.revokedAt ?? record.expiresAt) > DEVICE_RECORD_KEEP_DAYS * DAY_MS;
    const kept = records.filter((record) => !forgotten(record));
    if (kept.filter((record) => this.stateOf(record) === "active").length >= input.maxDevices) {
      throw new DeviceTokenError(409, `there are already ${input.maxDevices} active device tokens: revoke one first`);
    }
    const id = crypto.randomBytes(16).toString("base64url");
    const expiresAtMs = nowMs + input.days * DAY_MS;
    const expiresAtSeconds = Math.floor(expiresAtMs / 1000);
    const record: DeviceTokenRecord = {
      id, name: input.name, username: input.username, accountId: input.accountId, createdAt: new Date(nowMs).toISOString(), createdBy: input.createdBy,
      expiresAt: new Date(expiresAtSeconds * 1000).toISOString(),
    };
    this.save([...kept, record]);
    return { token: `${DEVICE_TOKEN_PREFIX}.${id}.${expiresAtSeconds}.${signature(this.key, id, input.username, input.accountId, expiresAtSeconds)}`, view: this.view(record) };
  }

  /** Revokes a token for good. False when there is no such token or it was revoked already. */
  revoke(id: string): boolean {
    const records = this.load();
    const record = records.find((item) => item.id === id);
    if (!record || record.revokedAt) return false;
    record.revokedAt = new Date(this.now()).toISOString();
    this.save(records);
    return true;
  }

  /** Checks a token a device presents. A success also notes when it was last used. */
  verify(token: unknown): VerifyResult {
    if (typeof token !== "string" || token.length > 256) return { ok: false, reason: "malformed" };
    const parts = token.split(".");
    if (parts.length !== 4 || parts[0] !== DEVICE_TOKEN_PREFIX) return { ok: false, reason: "malformed" };
    const [, id, expiry, given] = parts;
    const expiresAt = Number(expiry);
    if (!validDeviceTokenId(id) || !Number.isInteger(expiresAt) || expiresAt <= 0) return { ok: false, reason: "malformed" };
    const records = this.load();
    const record = records.find((item) => item.id === id);
    if (!record) return { ok: false, reason: "unknown" };
    const expected = Buffer.from(signature(this.key, id, record.username, record.accountId, expiresAt));
    const actual = Buffer.from(given);
    if (expected.length !== actual.length || !crypto.timingSafeEqual(expected, actual)) return { ok: false, reason: "signature" };
    // The signature covers the expiry written in the token, and the record must say the same.
    if (Math.floor(Date.parse(record.expiresAt) / 1000) !== expiresAt) return { ok: false, reason: "signature" };
    if (record.revokedAt) return { ok: false, reason: "revoked" };
    if (expiresAt * 1000 <= this.now()) return { ok: false, reason: "expired" };
    record.lastUsedAt = new Date(this.now()).toISOString();
    this.save(records);
    return { ok: true, record };
  }
}
