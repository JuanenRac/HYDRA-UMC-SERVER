// =============================================================================
// HYDRA-UMC STUDIO - Refresh Token Store: refresh_tokens.ts
// Copyright (C) 2026 JuanenRac (Electro Hobby 3D) <electrohobby3d@gmail.com>
// GPL-3.0 - see LICENSE
//
// C08 (client-side automatic reauthentication): until now, ANY WebSocket
// close 1008 (its own real access-token expiry, most commonly - JWT_EXPIRES_IN
// defaults to 30d but a dashboard genuinely left open that long, or a
// shorter deployment-configured value, does hit it) forced every client
// (STUDIO/Android/iOS/DSI) to drop the user back to a manual login screen,
// discarding whatever view/robot selection was open - even though the
// account itself was never actually revoked. This module gives a client a
// real, safe way to recover a fresh access token WITHOUT re-prompting for a
// password, while still failing closed exactly where forcing a real
// re-login is the correct, secure behavior:
//   - opaque, unguessable (crypto.randomBytes(32)) refresh tokens, never a
//     signed JWT - a refresh token exists to be looked up server-side and
//     revoked, not decoded client-side, so a signed/self-contained token
//     would give this module nothing a plain random string doesn't.
//   - each one records the account's tokenVersion/id AT ISSUANCE (the exact
//     same two fields server.ts's own authenticate()/WS checks already
//     compare a JWT's claims against - see users.ts's own StoredUser.id/
//     tokenVersion doc comments) - a password/role change or account
//     delete-and-recreate bumps one of those, and consumeRefreshToken()
//     below refuses to mint a new access token for a refresh token issued
//     before that change, exactly mirroring the existing JWT revocation
//     guarantee instead of silently punching a hole in it.
//   - rotated on every successful use (the old record is deleted, a new one
//     issued) - a leaked refresh token has a single real use before it stops
//     working, not an indefinite one.
//   - persisted the same way data/users.json already is (temp-file-then-
//     rename, same directory, same atomicity guarantee) so an in-flight
//     refresh token survives a server restart instead of forcing every
//     still-open client to fully re-login the moment the process restarts.
// =============================================================================

import fs from "fs";
import path from "path";
import crypto from "crypto";
import { findUser, effectiveTokenVersion, effectiveId, type StoredUser } from "./users";

interface StoredRefreshToken {
  token: string;
  username: string;
  tokenVersion: number;
  userId: string;
  expiresAt: number; // epoch ms
  createdAt: string;
}

const refreshTokensPath = () => path.join(process.cwd(), "data", "refresh_tokens.json");

// Same "?X.Y.Zd/h/m/s" duration parsing JWT_EXPIRES_IN itself is handed to
// jsonwebtoken for - re-implemented minimally here (no jsonwebtoken
// dependency needed for a plain expiresAt timestamp) so an operator can
// configure this with the exact same string shape as JWT_EXPIRES_IN,
// without needing to learn a second format. An unparseable value (or none
// set) falls back to 90d - long enough that a real user's normal usage
// pattern rotates it via consumeRefreshToken() well before it would ever
// expire on its own, short enough that a genuinely abandoned refresh token
// (a lost/wiped device) doesn't stay valid forever.
function parseDurationMs(spec: string): number {
  const match = /^(\d+)\s*([smhd])$/i.exec(spec.trim());
  if (!match) return 90 * 24 * 60 * 60 * 1000;
  const value = Number(match[1]);
  const unitMs: Record<string, number> = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };
  return value * unitMs[match[2].toLowerCase()];
}

const REFRESH_TOKEN_TTL_MS = parseDurationMs(process.env.HYDRA_UMC_REFRESH_TOKEN_EXPIRES_IN || "90d");

export class RefreshTokensFileError extends Error {}

function loadRefreshTokens(): StoredRefreshToken[] {
  let raw: string;
  try {
    raw = fs.readFileSync(refreshTokensPath(), "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw new RefreshTokensFileError(`could not read ${refreshTokensPath()}: ${(err as Error).message}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    // Same reasoning as users.ts's own loadUsers(): a corrupted file must
    // never be silently treated as "no refresh tokens yet" - that would
    // just be a quieter, harder-to-notice version of the same real bug.
    throw new RefreshTokensFileError(`${refreshTokensPath()} exists but is not valid JSON: ${(err as Error).message}`);
  }
  if (!Array.isArray(parsed)) {
    throw new RefreshTokensFileError(`${refreshTokensPath()} exists but does not contain a JSON array`);
  }
  return parsed as StoredRefreshToken[];
}

function saveRefreshTokens(tokens: StoredRefreshToken[]): void {
  const dir = path.dirname(refreshTokensPath());
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const target = refreshTokensPath();
  const tmp = `${target}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(tokens, null, 2), "utf-8");
  fs.renameSync(tmp, target);
}

// No promise-based lock (unlike users.ts's withUsersLock) - every mutating
// function below is fully synchronous, start to finish, with no `await` in
// the middle. Node never interleaves two synchronous call stacks, so a
// plain read-modify-write here already has the same atomicity guarantee
// users.ts needs a real lock chain for specifically because its own
// hashPassword() await opens a real window between its read and its write.

/** Mints and persists a new refresh token for `user`, returning the opaque
 * token value the client stores alongside its access token. */
export function issueRefreshToken(user: StoredUser): string {
  const tokens = loadRefreshTokens();
  const token = crypto.randomBytes(32).toString("hex");
  tokens.push({
    token,
    username: user.username,
    tokenVersion: effectiveTokenVersion(user),
    userId: effectiveId(user),
    expiresAt: Date.now() + REFRESH_TOKEN_TTL_MS,
    createdAt: new Date().toISOString(),
  });
  saveRefreshTokens(tokens);
  return token;
}

export type ConsumeRefreshTokenResult =
  | { ok: true; user: StoredUser; refreshToken: string }
  | { ok: false; reason: "invalid" | "expired" | "revoked" };

/** Validates `token`, and on success ROTATES it (deletes the old record,
 * issues a new one for the account's CURRENT tokenVersion/id) and returns
 * the account to mint a fresh access token for. Fails closed - the same
 * account-mutation/deletion checks server.ts's own authenticate()/WS
 * handlers already apply to a JWT's claims are applied here to the refresh
 * token's own recorded claims, so a password/role change or account
 * delete-and-recreate revokes an outstanding refresh token exactly as
 * completely as it already revokes an outstanding access token. */
export function consumeRefreshToken(token: string): ConsumeRefreshTokenResult {
  const tokens = loadRefreshTokens();
  const idx = tokens.findIndex(t => t.token === token);
  if (idx === -1) return { ok: false, reason: "invalid" };
  const record = tokens[idx];

  if (Date.now() > record.expiresAt) {
    tokens.splice(idx, 1);
    saveRefreshTokens(tokens);
    return { ok: false, reason: "expired" };
  }

  const currentUser = findUser(record.username);
  if (!currentUser || effectiveTokenVersion(currentUser) !== record.tokenVersion || effectiveId(currentUser) !== record.userId) {
    // Account deleted, or genuinely mutated (password/role change, or a
    // delete-and-recreate of the same username - see users.ts's own
    // effectiveId() doc comment) since this refresh token was issued.
    tokens.splice(idx, 1);
    saveRefreshTokens(tokens);
    return { ok: false, reason: "revoked" };
  }

  tokens.splice(idx, 1);
  const newToken = crypto.randomBytes(32).toString("hex");
  tokens.push({
    token: newToken,
    username: currentUser.username,
    tokenVersion: effectiveTokenVersion(currentUser),
    userId: effectiveId(currentUser),
    expiresAt: Date.now() + REFRESH_TOKEN_TTL_MS,
    createdAt: new Date().toISOString(),
  });
  saveRefreshTokens(tokens);
  return { ok: true, user: currentUser, refreshToken: newToken };
}

/** POST /api/logout calls this so a real, explicit logout actually
 * invalidates the refresh token server-side too, not just discards it
 * client-side (leaving it silently valid for REFRESH_TOKEN_TTL_MS). A
 * token that doesn't exist (already used, already expired, or simply never
 * sent) is a harmless no-op - logout always succeeds from the client's
 * point of view. */
export function revokeRefreshToken(token: string): void {
  const tokens = loadRefreshTokens();
  const next = tokens.filter(t => t.token !== token);
  if (next.length !== tokens.length) saveRefreshTokens(next);
}

/** Startup + periodic hygiene sweep - a refresh token that expired without
 * ever being rotated (an abandoned/lost device) would otherwise sit in
 * data/refresh_tokens.json forever; nothing else ever removes it. Mirrors
 * this repo's own startup sweep of orphaned data/**\/*.tmp files - dead
 * state left behind by something that will never come back to clean up
 * after itself. Returns the number of records removed, for the startup log
 * line to report. */
export function pruneExpiredRefreshTokens(): number {
  const tokens = loadRefreshTokens();
  const now = Date.now();
  const next = tokens.filter(t => t.expiresAt > now);
  if (next.length !== tokens.length) saveRefreshTokens(next);
  return tokens.length - next.length;
}
