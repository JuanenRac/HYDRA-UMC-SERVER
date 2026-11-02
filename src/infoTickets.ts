// =============================================================================
// HYDRA-UMC-SERVER - src/infoTickets.ts
// Copyright (C) 2026 JuanenRac (Electro Hobby 3D) <electrohobby3d@gmail.com>
// GPL-3.0-or-later - see LICENSE
// =============================================================================
// Signed tickets for the read-only information routes (GET /metrics, /api/system/metrics, /api/system/supervisor, /api/ecosystem/status and the
// model catalogue). They follow the scheme of the tickets of the camera pictures (see mediaTickets.ts) so that a dashboard or a Prometheus that
// cannot send a bearer token can still read them once an administrator turned HYDRA_UMC_INFO_AUTH on: a signed-in client asks for a ticket
// (POST /api/info/ticket) and puts it in the address (`?ticket=...`). The ticket says who asked and until when, is signed with a key derived from
// the server's own secret that is not the key of the camera tickets, and opens nothing but these read-only routes. Off by default (infoTickets.enabled).
import crypto from "node:crypto";

export const INFO_TICKET_DEFAULT_SECONDS = 300;
export const INFO_TICKET_MIN_SECONDS = 30;
/** The longest life a configured maximum may allow (30 days). */
export const INFO_TICKET_LIMIT_SECONDS = 30 * 24 * 3600;

function signature(key: Buffer, username: string, expiresAt: number): string {
  return crypto.createHmac("sha256", key).update(`hydra-info-ticket-v1|${username}|${expiresAt}`).digest("base64url");
}

/** The key the tickets are signed with: derived from the server's own secret, and different from the key of the camera tickets. */
export function infoTicketKey(serverSecret: string): Buffer {
  return crypto.createHmac("sha256", serverSecret).update("hydra-info-ticket-key-v1").digest();
}

/** What data/server-config.json may hold in the `infoTickets` block besides the switch (not security switches: read from the file only). */
export interface InfoTicketLimits {
  /** Life of a ticket when the client does not ask for another (30 to maxTtlSeconds; 300 by default). */
  ttlSeconds?: unknown;
  /** The longest life a ticket may be asked for (30 to 2592000; 300 by default, so nothing lives longer than the default until an administrator allows it). */
  maxTtlSeconds?: unknown;
}

function clamp(value: unknown, fallback: number, min: number, max: number): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.min(max, Math.max(min, Math.floor(value))) : fallback;
}

/** The life of the ticket to issue: the one asked for (if any) within the configured maximum, else the configured default. */
export function infoTicketSeconds(limits: InfoTicketLimits | undefined, requested: unknown): number {
  const max = clamp(limits?.maxTtlSeconds, INFO_TICKET_DEFAULT_SECONDS, INFO_TICKET_MIN_SECONDS, INFO_TICKET_LIMIT_SECONDS);
  const base = Math.min(max, clamp(limits?.ttlSeconds, INFO_TICKET_DEFAULT_SECONDS, INFO_TICKET_MIN_SECONDS, INFO_TICKET_LIMIT_SECONDS));
  if (requested === undefined || requested === null) return base;
  if (typeof requested !== "number" || !Number.isFinite(requested)) return base;
  return Math.min(max, Math.max(INFO_TICKET_MIN_SECONDS, Math.floor(requested)));
}

export function issueInfoTicket(key: Buffer, username: string, nowMs: number, seconds: number): { ticket: string; expiresInSeconds: number } {
  const expiresAt = Math.floor(nowMs / 1000) + seconds;
  const encodedUser = Buffer.from(username, "utf8").toString("base64url");
  return { ticket: `${encodedUser}.${expiresAt}.${signature(key, username, expiresAt)}`, expiresInSeconds: seconds };
}

/** The user name a valid, unexpired ticket was issued to, or null. */
export function verifyInfoTicket(key: Buffer, ticket: unknown, nowMs: number): string | null {
  if (typeof ticket !== "string" || ticket.length > 512) return null;
  const parts = ticket.split(".");
  if (parts.length !== 3) return null;
  const [encodedUser, expiry, given] = parts;
  const expiresAt = Number(expiry);
  if (!Number.isInteger(expiresAt) || expiresAt * 1000 < nowMs) return null;
  let username: string;
  try { username = Buffer.from(encodedUser, "base64url").toString("utf8"); } catch { return null; }
  if (!username) return null;
  const expected = Buffer.from(signature(key, username, expiresAt));
  const actual = Buffer.from(given);
  if (expected.length !== actual.length || !crypto.timingSafeEqual(expected, actual)) return null;
  return username;
}
