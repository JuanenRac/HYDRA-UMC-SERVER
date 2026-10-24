// =============================================================================
// HYDRA-UMC-SERVER - src/voiceConfirm.ts
// Copyright (C) 2026 JuanenRac (Electro Hobby 3D) <electrohobby3d@gmail.com>
// GPL-3.0-or-later - see LICENSE
// =============================================================================
// The confirmation of a spoken request, as this server relays and checks it.
//
// HYDRA-UMC-VOICE-UI mints a signed, single-use confirmation token for a movement request and, when the person confirms, answers
// `confirmation_result` / `confirmed`. This server is the one that decides what to do with that answer, so it does not take a
// JSON for the truth: when `HYDRA_UMC_VOICE_UI_RESULT_KEY` (or `..._FILE`) is set, the same value the Voice UI signs with, a confirmed
// result is believed only if its HMAC-SHA256 signature verifies, if it names the signed-in user that asked as its subject and
// if it carries the request it is for. The subject is always the signed-in user of the session, never something the client says.
import crypto from "node:crypto";
import { resolveToken, type Env } from "./upstreamAuth";

export const VOICE_RESULT_KEY_VARIABLES = ["HYDRA_UMC_VOICE_UI_RESULT_KEY"] as const;
export const VOICE_REQUIRE_SIGNATURE_VARIABLE = "HYDRA_UMC_VOICE_CONFIRM_REQUIRE_SIGNATURE";
/** The fields of a confirmed result that are signed, in the order the Voice UI lists them (the JSON is rebuilt with sorted keys). */
export const SIGNED_FIELDS = ["type", "status", "requestId", "intent", "subject", "confirmedAtUtc", "nonce"] as const;

export const CONFIRMATION_TOKEN_MAX_LENGTH = 2048;
const SUBJECT_PATTERN = /^[A-Za-z0-9_.@:+-]{1,128}$/;
const REQUEST_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

/** The key the Voice UI signs confirmed results with; empty when none is configured. Read on every call. */
export function voiceResultKey(env: Env = process.env): string {
  const key = resolveToken(VOICE_RESULT_KEY_VARIABLES, env);
  return key.length >= 16 ? key : "";
}

/** Must a confirmed result be signed even when no key is configured (then it is refused)? Off unless the variable is exactly "1". */
export function requireSignature(env: Env = process.env): boolean {
  return (env[VOICE_REQUIRE_SIGNATURE_VARIABLE] ?? "").trim() === "1";
}

/** The username to use as the subject of a session, or empty when it is not a safe subject. */
export function subjectOf(user: unknown): string {
  const name = user && typeof user === "object" ? (user as { username?: unknown }).username : undefined;
  return typeof name === "string" && SUBJECT_PATTERN.test(name) ? name : "";
}

/** JSON with the keys of every object sorted, no spaces: the bytes the Voice UI signs. */
export function canonicalJson(value: unknown): string {
  const sort = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(sort);
    if (item && typeof item === "object") {
      return Object.fromEntries(Object.keys(item as object).sort().map((key) => [key, sort((item as Record<string, unknown>)[key])]));
    }
    return item;
  };
  return JSON.stringify(sort(value));
}

/** The HMAC-SHA256 (hex) the Voice UI puts in `signature` for this result. */
export function signResult(result: Record<string, unknown>, key: string): string {
  const signed: Record<string, unknown> = {};
  for (const field of SIGNED_FIELDS) if (field in result) signed[field] = result[field];
  return crypto.createHmac("sha256", key).update(canonicalJson(signed), "utf8").digest("hex");
}

/** Does the signature of this result verify under the key? Constant time; false for anything that is not a 64-digit hex string. */
export function verifyResultSignature(result: Record<string, unknown>, key: string): boolean {
  const given = result.signature;
  if (typeof given !== "string" || !/^[0-9a-f]{64}$/.test(given)) return false;
  const expected = signResult(result, key);
  return crypto.timingSafeEqual(Buffer.from(given, "hex"), Buffer.from(expected, "hex"));
}

export function validateConfirmRequest(body: unknown): string | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return "confirmation must be a JSON object";
  const token = (body as Record<string, unknown>).confirmationToken;
  if (typeof token !== "string" || token.length === 0 || token.length > CONFIRMATION_TOKEN_MAX_LENGTH) {
    return `confirmationToken must contain 1-${CONFIRMATION_TOKEN_MAX_LENGTH} characters`;
  }
  return null;
}

export type ConfirmVerdict =
  | { ok: true; result: Record<string, unknown>; verified: boolean }
  | { ok: false; status: number; error: string };

/**
 * What to do with the answer of the Voice UI to a confirmation. `expected` is the session that asked: a confirmed result must name
 * that subject. With a key configured a confirmed result is believed only when its signature verifies; with none it is relayed with
 * `verified: false` (and refused when REQUIRE_SIGNATURE is on). Results that are not confirmed carry nothing to execute and are relayed.
 */
export function judgeConfirmationResult(raw: unknown, expectedSubject: string, env: Env = process.env): ConfirmVerdict {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, status: 502, error: "HYDRA-UMC-VOICE-UI returned an invalid confirmation result" };
  const result = raw as Record<string, unknown>;
  if (result.type !== "confirmation_result" || !["confirmed", "expired", "invalid"].includes(String(result.status))) {
    return { ok: false, status: 502, error: "HYDRA-UMC-VOICE-UI returned an invalid confirmation result" };
  }
  if (result.status !== "confirmed") return { ok: true, result, verified: false };

  if (typeof result.requestId !== "string" || !REQUEST_ID_PATTERN.test(result.requestId)) {
    return { ok: false, status: 502, error: "HYDRA-UMC-VOICE-UI confirmed a result with no valid requestId" };
  }
  const intent = result.intent as { name?: unknown } | undefined;
  if (!intent || typeof intent !== "object" || typeof intent.name !== "string") {
    return { ok: false, status: 502, error: "HYDRA-UMC-VOICE-UI confirmed a result with no intent" };
  }
  if (result.subject !== expectedSubject) {
    return { ok: false, status: 502, error: "HYDRA-UMC-VOICE-UI confirmed a result for another subject" };
  }
  const key = voiceResultKey(env);
  if (!key) {
    if (requireSignature(env)) {
      return { ok: false, status: 503, error: `${VOICE_REQUIRE_SIGNATURE_VARIABLE} is on and no HYDRA_UMC_VOICE_UI_RESULT_KEY is configured on this Server` };
    }
    return { ok: true, result, verified: false };
  }
  if (!verifyResultSignature(result, key)) {
    return { ok: false, status: 502, error: "the confirmation result of HYDRA-UMC-VOICE-UI is not signed with the shared key" };
  }
  return { ok: true, result, verified: true };
}
