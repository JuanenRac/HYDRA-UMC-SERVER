// =============================================================================
// HYDRA-UMC-SERVER - src/routes/auth.ts
// Copyright (C) 2026 JuanenRac (Electro Hobby 3D) <electrohobby3d@gmail.com>
// GPL-3.0 - see LICENSE
// =============================================================================
// Login, token refresh and logout, moved out of server.ts unchanged.
import express from "express";
import { findUser, verifyPassword, effectiveTokenVersion, effectiveId } from "../users";
import { issueRefreshToken, consumeRefreshToken, revokeRefreshToken } from "../refresh_tokens";
import { authFailuresTotal } from "../metrics";
import { totpStore } from "../totp";
import { connectionTracker, identify, originOf, type Sighting } from "../connections";
import { outsideNeedsSecondFactor, type TrustedNetworksSettings } from "../trustedNetworks";
import { signLoginToken, signDeviceLoginToken, asyncHandler, loginRateLimiter, refreshRateLimiter, jwksRateLimiter } from "../auth";
import { currentJwtPolicy, jwtKeyStore } from "../jwtKeys";
import { deviceSessionMinutes, type DeviceTokenLimits, type DeviceTokenStore } from "../deviceTokens";

/** Who is asking, as the history of connections describes a client (never a secret: kind, version, address and agent only). */
function sightingOf(req: express.Request, user?: string): Sighting {
  const ip = (req.ip ?? "").replace(/^::ffff:/i, "") || undefined;
  return { ...identify(req), ...(user ? { user } : {}), ip, origin: originOf(ip) };
}

/** Telling the history never stops a sign-in. */
function tell(note: () => void): void {
  try { note(); } catch { /* the history is a convenience */ }
}

/** What the sign-in routes need from the rest of the server (optional: without it nothing changes). */
export interface AuthRouteDeps {
  /** The trusted networks in force (src/trustedNetworks.ts); read on every request. */
  trustedNetworks?: () => TrustedNetworksSettings;
  /** The device tokens (src/deviceTokens.ts): while `enabled()` is false the device sign-in answers 404 and a device session cannot be renewed. */
  devices?: { enabled: () => boolean; store: DeviceTokenStore; limits: () => DeviceTokenLimits | undefined };
}

const NEEDS_SECOND_FACTOR = { error: "from outside the house, signing in needs the second factor turned on for this account: turn it on from the house network or the VPN first", code: "second-factor-required", needs: "vpn" };

export function registerAuthRoutes(app: express.Express, deps: AuthRouteDeps = {}): void {
  // The public keys that verify the EdDSA sign-in tokens (RFC 7517). Public on purpose and only public parameters: the key id, the curve and the
  // x coordinate. While the algorithm is HS256 (the default) there is nothing to publish and the route looks as if it did not exist.
  app.get("/.well-known/jwks.json", jwksRateLimiter, (req, res) => {
    if (currentJwtPolicy().algorithm !== "EdDSA") {
      res.set("Cache-Control", "no-store");
      return res.status(404).json({ error: "Not found" });
    }
    let body: string;
    try {
      body = JSON.stringify(jwtKeyStore().jwks());
    } catch {
      res.set("Cache-Control", "no-store");
      return res.status(503).json({ error: "The key set is not available" });
    }
    // Five minutes: long enough to spare the server, short enough that a rotation reaches a verifier within one cycle.
    res.set({ "Cache-Control": "public, max-age=300, must-revalidate", "X-Content-Type-Options": "nosniff", "Content-Type": "application/jwk-set+json; charset=utf-8" });
    res.send(body);
  });

  app.post("/api/login", loginRateLimiter, asyncHandler(async (req, res) => {
    const { username, password } = req.body || {};
    if (typeof username !== "string" || typeof password !== "string") {
      return res.status(400).json({ error: "username and password required" });
    }
    const user = findUser(username);
    // verifyPassword() is now async (real crypto.scrypt, not
    // scryptSync) so this CPU/memory-heavy check runs on Node's own
    // libuv threadpool instead of blocking the main event loop - every
    // other concurrent HTTP/WebSocket connection (including real-time
    // robot command/telemetry traffic) keeps being served while a login
    // is being verified.
    if (!user || !(await verifyPassword(password, user.passwordHash))) {
      authFailuresTotal.inc({ reason: "invalid_credentials" });
      tell(() => connectionTracker().refused(sightingOf(req, user ? user.username : undefined), "login_failed", Boolean(user)));
      return res.status(401).json({ error: "Invalid credentials" });
    }
    // An account that turned on the second factor needs a current code (or an unused recovery code) as well. Accounts
    // that did not turn it on sign in exactly as before.
    const factor = totpStore();
    // From outside the trusted networks (when that option is on) only an account with the second factor may sign in.
    const networks = deps.trustedNetworks?.();
    if (networks && outsideNeedsSecondFactor(networks, req.ip, factor.enabled(effectiveId(user)))) {
      authFailuresTotal.inc({ reason: "outside_without_second_factor" });
      tell(() => connectionTracker().refused(sightingOf(req, user.username), "second_factor_failed", true));
      return res.status(403).json(NEEDS_SECOND_FACTOR);
    }
    if (factor.enabled(effectiveId(user))) {
      const wait = factor.waitFor(effectiveId(user));
      if (wait > 0) return res.status(429).set("Retry-After", String(wait)).json({ error: "Too many wrong codes - please wait before trying again.", totpRequired: true });
      const { totp } = req.body || {};
      if (typeof totp !== "string" || !totp.trim()) return res.status(401).json({ error: "A second-factor code is required", totpRequired: true });
      if (!factor.verify(effectiveId(user), totp)) {
        authFailuresTotal.inc({ reason: "invalid_totp" });
        tell(() => connectionTracker().refused(sightingOf(req, user.username), "second_factor_failed", true));
        return res.status(401).json({ error: "Invalid credentials", totpRequired: true });
      }
    }
    // See JWT_EXPIRES_IN's own header comment above for why this is
    // configurable instead of a hardcoded '30d' - defaults to 30d so an
    // existing trusted-LAN deployment sees no behavior change.
    // tokenVersion is the real, comparable session generation
    // authenticate()/the WS connect+heartbeat re-checks compare against
    // this account's CURRENT value on every request/tick, not just here
    // at login - see effectiveTokenVersion()'s own doc comment.
    // `id` is this account's own real, never-reused identity -
    // see effectiveId()'s own doc comment for why tokenVersion alone
    // isn't enough once an account can be deleted and its username reused.
    const token = signLoginToken(
      { username: user.username, role: user.role, tokenVersion: effectiveTokenVersion(user), id: effectiveId(user) }
    );
    // Issued alongside the access token so a client can recover from
    // its own real time-based expiry (see refresh_tokens.ts's own header
    // comment) without forcing a manual re-login - a client that predates
    // this field simply never sends refreshToken to POST /api/refresh and
    // keeps today's forced-logout behavior, so this is purely additive.
    let clientId: string | undefined;
    tell(() => { clientId = connectionTracker().login(sightingOf(req, user.username), factor.enabled(effectiveId(user))); });
    const refreshToken = issueRefreshToken(user, clientId);
    res.json({ success: true, token, refreshToken, role: user.role });
  }));

  // A device (the screen of a Compute Module) signs in with the token an administrator issued for it instead of a password. The answer is
  // the same as the one of /api/login, but the access token is short (deviceTokens.accessMinutes) and every renewal asks whether the device
  // token is still valid, so a revoked token stops working within minutes. Off by default (deviceTokens.enabled): the route answers 404.
  // Every refusal gives the same answer, whatever the reason, so the route does not tell which part of a token was right.
  app.post("/api/device/login", loginRateLimiter, asyncHandler(async (req, res) => {
    const devices = deps.devices;
    if (!devices?.enabled()) return res.status(404).json({ error: "Not found" });
    const refuse = (reason: string, username?: string) => {
      authFailuresTotal.inc({ reason: `device_${reason}` });
      tell(() => connectionTracker().refused(sightingOf(req, username), "login_failed", username !== undefined));
      return res.status(401).json({ error: "Invalid device token" });
    };
    const checked = devices.store.verify(req.body?.token);
    if (!checked.ok) return refuse(checked.reason);
    const user = findUser(checked.record.username);
    // An administrator account never signs in this way, and an account deleted and created again under the same name is not the one the token was issued for.
    if (!user || user.role === "admin" || effectiveId(user) !== checked.record.accountId) return refuse("account", checked.record.username);
    const networks = deps.trustedNetworks?.();
    if (networks && outsideNeedsSecondFactor(networks, req.ip, totpStore().enabled(effectiveId(user)))) {
      authFailuresTotal.inc({ reason: "outside_without_second_factor" });
      tell(() => connectionTracker().refused(sightingOf(req, user.username), "second_factor_failed", true));
      return res.status(403).json(NEEDS_SECOND_FACTOR);
    }
    const token = signDeviceLoginToken(
      { username: user.username, role: user.role, tokenVersion: effectiveTokenVersion(user), id: effectiveId(user) },
      deviceSessionMinutes(devices.limits()),
    );
    let clientId: string | undefined;
    tell(() => { clientId = connectionTracker().login(sightingOf(req, user.username), false); });
    const refreshToken = issueRefreshToken(user, clientId, checked.record.id);
    res.json({ success: true, token, refreshToken, role: user.role });
  }));

  // Exchanges a still-valid refresh token for a fresh access token,
  // without the caller's password - see refresh_tokens.ts's own
  // consumeRefreshToken() doc comment for exactly which cases this
  // succeeds vs. correctly still fails closed (a genuinely revoked
  // session, not just an expired access token, must still force a real
  // re-login). Not gated behind authenticate() - the whole point is
  // recovering from an access token that's already expired or otherwise
  // invalid - but has its own, higher rate limit (refreshRateLimiter) as
  // defense-in-depth against abuse; a refresh token is an unguessable 32-byte
  // random value, not a brute-forceable password.
  app.post("/api/refresh", refreshRateLimiter, asyncHandler(async (req, res) => {
    const { refreshToken } = req.body || {};
    if (typeof refreshToken !== "string" || !refreshToken) {
      return res.status(400).json({ error: "refreshToken required" });
    }
    const result = consumeRefreshToken(refreshToken);
    if (!result.ok) {
      authFailuresTotal.inc({ reason: `refresh_${result.reason}` });
      if (result.reason === "expired" && result.clientId) {
        const clientId = result.clientId;
        tell(() => connectionTracker().endedClient(clientId, "session_expired", sightingOf(req)));
      }
      return res.status(401).json({ error: "Invalid or expired refresh token" });
    }
    // A renewal from outside is held to the same rule as a sign-in from outside.
    const networks = deps.trustedNetworks?.();
    if (networks && outsideNeedsSecondFactor(networks, req.ip, totpStore().enabled(effectiveId(result.user)))) {
      authFailuresTotal.inc({ reason: "outside_without_second_factor" });
      return res.status(403).json(NEEDS_SECOND_FACTOR);
    }
    const claims = { username: result.user.username, role: result.user.role, tokenVersion: effectiveTokenVersion(result.user), id: effectiveId(result.user) };
    if (result.deviceId) {
      // A session opened with a device token lives only as long as that token: revoked, expired or switched off, it ends here.
      const devices = deps.devices;
      if (!devices?.enabled() || !devices.store.isActive(result.deviceId) || result.user.role === "admin") {
        revokeRefreshToken(result.refreshToken);
        authFailuresTotal.inc({ reason: "refresh_device_ended" });
        return res.status(401).json({ error: "Invalid or expired refresh token" });
      }
      return res.json({ success: true, token: signDeviceLoginToken(claims, deviceSessionMinutes(devices.limits())), refreshToken: result.refreshToken, role: result.user.role });
    }
    const token = signLoginToken(claims);
    res.json({ success: true, token, refreshToken: result.refreshToken, role: result.user.role });
  }));

  // A real, explicit logout now revokes the refresh token
  // server-side too (see revokeRefreshToken()'s own doc comment) instead
  // of only discarding it client-side, which would otherwise leave it
  // silently valid for the rest of its real TTL. No authenticate() gate,
  // same reasoning as /api/refresh - a client whose access token already
  // expired still needs to be able to log out cleanly. Always reports
  // success: an already-used/expired/never-sent token is a no-op, not an
  // error, from the caller's point of view.
  app.post("/api/logout", asyncHandler(async (req, res) => {
    const { refreshToken } = req.body || {};
    if (typeof refreshToken === "string" && refreshToken) {
      const gone = revokeRefreshToken(refreshToken);
      const clientId = gone?.clientId;
      if (clientId) tell(() => connectionTracker().endedClient(clientId, "logout", sightingOf(req)));
    }
    res.json({ success: true });
  }));
}
