// =============================================================================
// HYDRA-UMC-SERVER - src/globalStopSigning.ts
// Copyright (C) 2026 JuanenRac (Electro Hobby 3D) <electrohobby3d@gmail.com>
// GPL-3.0-or-later - see LICENSE
// =============================================================================
// The signature of the announcement of the global stop, the same bytes as hydra_umc_sdk.global_stop: HMAC-SHA256 over the domain text, the topic and the other
// fields as JSON with sorted keys, no spaces and ASCII escapes. It is on only when a key file is configured. A bridge always obeys a SAFE_STOP; with the same key
// it believes a READY only when it is signed. So when the key cannot be read a SAFE_STOP still goes out (unsigned) and a READY does not.
import crypto from "node:crypto";
import fs from "node:fs";

const DOMAIN = "hydra-umc-global-stop-v1";
const MIN_KEY_BYTES = 32;

/** JSON with sorted keys, no spaces and every character outside printable ASCII escaped (what Python writes with ensure_ascii). Strings, booleans and whole numbers only. */
export function canonicalJson(body: Record<string, unknown>): string {
  const text = (value: unknown): string => JSON.stringify(value).replace(/[\u007f-\uffff]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);
  return `{${Object.keys(body).sort().map((name) => `${text(name)}:${text(body[name])}`).join(",")}}`;
}

export function signAnnouncement(topic: string, payload: Record<string, unknown>, key: Buffer, nowMs: number): Record<string, unknown> {
  const body: Record<string, unknown> = { ...payload, issued_at_ms: nowMs };
  delete body.signature;
  const signature = crypto.createHmac("sha256", key).update(`${DOMAIN}\n${topic}\n${canonicalJson(body)}`, "utf8").digest("hex");
  return { ...body, signature };
}

/** The key of the file (one line of at least 32 characters, mode 600 where the system has modes); throws when it cannot be used. Never puts the key in a message. */
export function loadGlobalStopKey(file: string): Buffer {
  const info = fs.statSync(file);
  if (process.platform !== "win32" && (info.mode & 0o077) !== 0) throw new Error("the global stop key file must not be readable by the group or by others (mode 600)");
  const key = Buffer.from(fs.readFileSync(file, "latin1").trim(), "latin1");
  if (key.length < MIN_KEY_BYTES) throw new Error(`the global stop key must have at least ${MIN_KEY_BYTES} characters`);
  return key;
}

/** What a key an administrator stores through the API may look like (what the bridges' key file loaders accept). */
export const GLOBAL_STOP_KEY_PATTERN = /^[\x21-\x7e]{32,256}$/;

/** Writes the key to `file` (mode 600), replacing it as a whole: a reader finds the old key or the new one. */
export function storeGlobalStopKey(file: string, key: string): void {
  const temporary = `${file}.${crypto.randomBytes(8).toString("hex")}.tmp`;
  try {
    fs.writeFileSync(temporary, `${key}\n`, { mode: 0o600, flag: "wx" });
    fs.renameSync(temporary, file);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

export function removeGlobalStopKey(file: string): void {
  fs.rmSync(file, { force: true });
}

/** Whether `file` holds a key that can be used. */
export function globalStopKeyUsable(file: string): boolean {
  try {
    loadGlobalStopKey(file);
    return true;
  } catch {
    return false;
  }
}

/** What to publish: the payload as it is without a key file, signed with one, and null for a READY that cannot be signed as configured. */
export function announcementFor(topic: string, payload: Record<string, unknown>, keyFile: string | undefined, nowMs: number, log: (line: string) => void): Record<string, unknown> | null {
  if (!keyFile) return payload;
  try {
    return signAnnouncement(topic, payload, loadGlobalStopKey(keyFile), nowMs);
  } catch (error) {
    log(`[SECURITY] the global stop key file cannot be used (${error instanceof Error ? error.message : "unknown error"})`);
    return payload.state === "SAFE_STOP" ? payload : null;
  }
}
