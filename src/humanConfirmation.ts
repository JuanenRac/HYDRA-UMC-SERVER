// =============================================================================
// HYDRA-UMC-SERVER - src/humanConfirmation.ts
// Copyright (C) 2026 JuanenRac (Electro Hobby 3D) <electrohobby3d@gmail.com>
// GPL-3.0-or-later - see LICENSE
// =============================================================================
// The confirmation of a person that a robot or flight request may go ahead: a short token, valid once, that the machine bridges (UAV, droids) check before
// they act. It is issued only after the person confirmed on a screen (the request carries confirm: true), for ONE action and ONE job, and it dies fast.
//
// Format: a JWT (RFC 7519) signed with HS256 with its own key (a file outside the repository, at least 32 characters, never the sign-in secret), claims
// purpose "human-confirmation", sub (the account), role, act (the action), job (the job id), jti (unique), iat and exp. The bridges check exactly this
// (hydra_umc_bridge_uav/human_confirmation.py and hydra_umc_bridge_droids/human_confirmation.py); they remember each jti, so a token works once.
//
// Off by default (HYDRA_UMC_HUMAN_CONFIRMATION=1 switches the route on; until then it answers 404). With no usable key the route answers 503 and issues nothing.
import crypto from "node:crypto";
import fs from "node:fs";

export const CONFIRMATION_PURPOSE = "human-confirmation";
export const MIN_KEY_CHARS = 32;
export const DEFAULT_TTL_SECONDS = 60;
export const MAX_TTL_SECONDS = 120;
/** The requests of the machine bridges that need a confirmation. */
export const CONFIRMABLE_ACTIONS: readonly string[] = ["ARM", "TAKEOFF", "GOTO_WAYPOINT", "HOVER_AND_CAPTURE", "WALK_TO", "PICK_OBJECT", "PLACE_OBJECT"];
const JOB_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;

/** Is the route on? Only a plain yes switches it on; anything else leaves it off. */
export function confirmationEnabled(value: string | undefined = process.env.HYDRA_UMC_HUMAN_CONFIRMATION): boolean {
  return ["1", "true", "on", "yes"].includes((value ?? "").trim().toLowerCase());
}

/** The key from a file; null when it is missing, unreadable or too short. Never logged. */
export function loadConfirmationKey(file: string | undefined): Buffer | null {
  if (!file || !file.trim()) return null;
  try {
    const text = fs.readFileSync(file, "utf8").trim();
    return text.length >= MIN_KEY_CHARS ? Buffer.from(text, "utf8") : null;
  } catch {
    return null;
  }
}

const b64 = (value: Buffer | string): string => Buffer.from(value).toString("base64url");

export interface ConfirmationRequest {
  action: string;
  jobId: string;
  ttlSeconds: number;
}

/** Validates the body of the request; the message is the 400 answer. confirm must be exactly true: the person confirmed on a screen. */
export function parseConfirmationRequest(body: unknown): { ok: true; request: ConfirmationRequest } | { ok: false; error: string; code: string } {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return { ok: false, error: "the body must be an object", code: "invalid-confirmation-request" };
  const record = body as Record<string, unknown>;
  const unknown = Object.keys(record).filter((key) => !["action", "job_id", "confirm", "ttl_seconds"].includes(key));
  if (unknown.length > 0) return { ok: false, error: `unknown field(s): ${unknown.join(", ")}`, code: "invalid-confirmation-request" };
  if (record.confirm !== true) return { ok: false, error: "confirm must be true: the person has to confirm on the screen first", code: "confirmation-not-confirmed" };
  if (typeof record.action !== "string" || !CONFIRMABLE_ACTIONS.includes(record.action)) return { ok: false, error: `action must be one of ${CONFIRMABLE_ACTIONS.join(", ")}`, code: "invalid-confirmation-action" };
  if (typeof record.job_id !== "string" || !JOB_ID_PATTERN.test(record.job_id)) return { ok: false, error: "job_id must be 1 to 128 letters, digits, dot, colon, dash or underscore", code: "invalid-confirmation-job" };
  let ttl = DEFAULT_TTL_SECONDS;
  if (record.ttl_seconds !== undefined) {
    if (typeof record.ttl_seconds !== "number" || !Number.isInteger(record.ttl_seconds) || record.ttl_seconds < 1 || record.ttl_seconds > MAX_TTL_SECONDS) {
      return { ok: false, error: `ttl_seconds must be a whole number from 1 to ${MAX_TTL_SECONDS}`, code: "invalid-confirmation-ttl" };
    }
    ttl = record.ttl_seconds;
  }
  return { ok: true, request: { action: record.action, jobId: record.job_id, ttlSeconds: ttl } };
}

export interface IssuedConfirmation {
  token: string;
  action: string;
  job_id: string;
  expires_at: number;
  ttl_seconds: number;
  single_use: true;
}

/** Signs a confirmation. `now` is in milliseconds. */
export function issueConfirmation(key: Buffer, who: { username: string; role: string }, request: ConfirmationRequest, now: number = Date.now()): IssuedConfirmation {
  const iat = Math.floor(now / 1000);
  const exp = iat + request.ttlSeconds;
  const head = b64(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const body = b64(JSON.stringify({ purpose: CONFIRMATION_PURPOSE, sub: who.username, role: who.role, act: request.action, job: request.jobId, jti: crypto.randomUUID(), iat, exp }));
  const signature = b64(crypto.createHmac("sha256", key).update(`${head}.${body}`).digest());
  return { token: `${head}.${body}.${signature}`, action: request.action, job_id: request.jobId, expires_at: exp, ttl_seconds: request.ttlSeconds, single_use: true };
}
