// =============================================================================
// HYDRA-UMC-SERVER - src/auth.ts
// Copyright (C) 2026 JuanenRac (Electro Hobby 3D) <electrohobby3d@gmail.com>
// GPL-3.0 - see LICENSE
// =============================================================================
// Token verification, the admin gate, the async handler wrapper and the rate limiters,
// moved out of server.ts unchanged.
import rateLimit from "express-rate-limit";
import type { RequestHandler } from "express";
import { rateLimitSettings, securityEnvFrom, type RateLimitSettings } from "./securityConfig";
import { findUser, effectiveTokenVersion, effectiveId, ScryptOverloadError } from "./users";
import { jwtSecretProblem } from "./secretsPolicy";
import { authFailuresTotal } from "./metrics";
import { viewerMayCall } from "./serverPolicy";
import { verifyAccessToken, signAccessToken } from "./jwtKeys";

export const NODE_ENV = process.env.NODE_ENV || "development";

// Development keeps a deterministic fallback so a fresh checkout can run
// locally. Production never accepts it: a source-known signing key would let
// anyone forge a valid token for an internet-reachable deployment.
const configuredJwtSecret = process.env.JWT_SECRET?.trim();
export const JWT_SECRET_IS_DEFAULT = !configuredJwtSecret;
if (NODE_ENV === "production" && JWT_SECRET_IS_DEFAULT) {
  throw new Error("Production startup requires a non-empty JWT_SECRET");
}
// A deployment template carries an example secret; accepting it would let anybody who has read the template forge an administrator's token.
if (NODE_ENV === "production") {
  const problem = jwtSecretProblem(configuredJwtSecret ?? "");
  if (problem) throw new Error(`Production startup refused: ${problem}`);
}
export const JWT_SECRET = configuredJwtSecret || "hydra_industrial_secret_2026";
if (JWT_SECRET_IS_DEFAULT) {
  console.warn("[SECURITY] JWT_SECRET not set in the environment - using the built-in development default. Set a real JWT_SECRET before exposing this server beyond a trusted LAN.");
}

// How long a login token stays valid before the client has to log in
// again. 30 days is the historical default from when this was assumed to
// always run on a fully trusted LAN - fine there, but a token that leaks
// from a server reachable over the open internet (NAT/port-forward, a
// public tunnel, ...) stays usable for up to 30 days with no way to
// revoke it short of changing that account's password (see
// docs/REMOTE_API.md section 4's own note on this). Kept as 30d by
// default so nothing breaks for an existing trusted-LAN deployment that
// never sets this; an internet-facing deployment should set this to
// something much shorter (README.md recommends 24h) via JWT_EXPIRES_IN -
// any string jsonwebtoken's own `expiresIn` option accepts ("24h", "7d",
// a bare number of seconds, ...).
export const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || "30d";

/** Signs a login token with the algorithm in force (HS256 with JWT_SECRET by default; EdDSA when an administrator chose it). */
export function signLoginToken(claims: Record<string, unknown>): string {
  return signAccessToken(claims, JWT_SECRET, JWT_EXPIRES_IN);
}

/** The short sign-in a device gets for its device token (src/deviceTokens.ts): it lives for minutes, so that revoking the token ends the device's access soon. */
export function signDeviceLoginToken(claims: Record<string, unknown>, minutes: number): string {
  return signAccessToken(claims, JWT_SECRET, `${Math.max(1, Math.floor(minutes))}m`);
}

// Middleware to verify JWT token - the decoded payload now carries
// {username, role}, not just {username}, so requireAdmin below can gate
// the routes an "operator" account shouldn't reach.
export function authenticate(req: any, res: any, next: any) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    authFailuresTotal.inc({ reason: "no_token" });
    return res.status(401).json({ error: "Access denied: No token provided" });
  }

  // `algorithms` pinned explicitly to this token's own real signing
  // algorithm (jwt.sign() above uses a plain string secret, which
  // defaults to HS256) - jsonwebtoken 9.x already refuses `alg: none`
  // unless a caller opts into it, so this was never the classic
  // unsigned-token bypass, but pinning it closes the real, separate
  // algorithm-confusion class (a token crafted with a different
  // algorithm this secret happens to also validate under) rather than
  // relying on the library's own current default alone.
  // The algorithm comes from the configured policy (HS256 unless an administrator chose EdDSA), never from the token itself: see src/jwtKeys.ts.
  verifyAccessToken(token, JWT_SECRET, (err: any, user: any) => {
    if (err) {
      // Same 403 status for both cases, deliberately (a real 401-vs-403 split was wanted at one point, but that
      // "token expired" vs "token has no
      // permissions" split - but the 4 remote clients of this API aren't open in
      // this session to confirm they don't branch on the exact status code
      // today; changing 403->401 here would be a wire-visible contract
      // change needing the same cross-client coordination already declined
      // for the earlier compatibility findings). Adding a stable `code`
      // field is backward compatible instead: a client that only checks
      // the HTTP status sees no difference, while a future client update
      // can branch on TOKEN_EXPIRED ("log in again") vs TOKEN_INVALID
      // ("this token was never valid") without any further server change.
      const expired = err.name === "TokenExpiredError";
      authFailuresTotal.inc({ reason: expired ? "token_expired" : "token_invalid" });
      return res.status(403).json({
        error: expired ? "Access denied: token expired, please log in again" : "Access denied: invalid token",
        code: expired ? "TOKEN_EXPIRED" : "TOKEN_INVALID",
      });
    }
    // A valid JWT signature alone used to authorize for the token's
    // entire lifetime - deleting or demoting a user never revoked an
    // already-issued token, since {username, role} were trusted straight
    // from the (old, stale) token claims. Re-looks up the account on
    // EVERY request instead: gone entirely (deleted), or a real,
    // comparable tokenVersion mismatch (password/role changed since this
    // token was issued) - either way, this exact token no longer
    // authorizes, even though it hasn't expired yet. requireAdmin below
    // reads req.user.role from THIS fresh lookup, never the token's own
    // stale claim, so a demotion takes effect on the very next request.
    // tokenVersion
    // alone is only ever compared PER USERNAME - deleting this account and
    // recreating the same username reset tokenVersion back to its own
    // starting value on the brand-new account, so an old, not-yet-expired
    // token for the DELETED account could still authenticate as the new
    // one. effectiveId() is a real, random, never-reused identity (see
    // users.ts's own StoredUser.id doc comment) - an old token's `id`
    // claim can never match a same-named account created after it.
    const currentUser = findUser(user.username);
    if (!currentUser || effectiveTokenVersion(currentUser) !== user.tokenVersion || effectiveId(currentUser) !== user.id) {
      authFailuresTotal.inc({ reason: "token_session_revoked" });
      return res.status(401).json({
        error: "Access denied: this session is no longer valid, please log in again",
        code: "SESSION_REVOKED",
      });
    }
    req.user = { ...user, role: currentUser.role };
    // A read-only account reads and nothing else; the role is the live one of the account, never the token's own claim.
    if (currentUser.role === "viewer" && !viewerMayCall(req.method, req.path ?? req.url)) {
      authFailuresTotal.inc({ reason: "viewer_read_only" });
      return res.status(403).json({ error: "Access denied: this account is read-only", code: "VIEWER_READ_ONLY" });
    }
    next();
  });
}

/** Chain after authenticate() - rejects anyone whose token role isn't "admin".
 * Gates POST /api/settings (full-tree overwrite) and every /api/users route -
 * an "operator" account can still drive robots via the atomic
 * /api/robot/:id/command endpoint, just can't touch global config or accounts. */
// Express 4 does not automatically catch a rejected
// promise from an async route handler (nor a synchronous throw inside
// one - that also becomes a rejected promise once the function is
// async) - it would otherwise become an unhandled promise rejection
// instead of a clean response. Needed now that users.ts's own functions
// are real async (crypto.scrypt, see the async-scrypt reasoning in users.ts) and can throw a real,
// distinct UsersFileError for a genuinely corrupted users.json
// that a plain synchronous handler used to catch for free.
export function asyncHandler(handler: (req: any, res: any) => Promise<any>) {
  return (req: any, res: any) => {
    handler(req, res).catch((err: unknown) => {
      // A real overload
      // rejection, not just an unbounded queue - users.ts bounds how many
      // password-hashing operations (login, and admin user create/update)
      // run at once and throws ScryptOverloadError once even the wait
      // queue is full. Handled here, once, for every async route (login
      // included) instead of duplicating this check in each one.
      if (err instanceof ScryptOverloadError) {
        if (!res.headersSent) {
          res.status(503).json({ error: "Server is busy processing other password operations - please try again shortly." });
        }
        return;
      }
      console.error("[API] unhandled error in async route handler:", err);
      if (!res.headersSent) {
        res.status(500).json({ error: "internal server error" });
      }
    });
  };
}

export function requireAdmin(req: any, res: any, next: any) {
  if (req.user?.role !== "admin") {
    return res.status(403).json({ error: "Access denied: admin privileges required" });
  }
  next();
}

/** Chain after authenticate() - lets through an "admin" or an "operator" and nobody else. Gates the relays that reach services able
 * to move a robot or run a model: a session whose role is anything other than these two (a role that does not exist yet, a value
 * that is missing) is refused instead of being let through because it signed in. */
export function requireOperator(req: any, res: any, next: any) {
  const role = req.user?.role;
  if (role !== "admin" && role !== "operator") {
    return res.status(403).json({ error: "Access denied: operator or admin privileges required" });
  }
  next();
}

// Throttles POST /api/login only - every other route stays unlimited (a
// robot-control endpoint being rate-limited would be a much worse problem
// than the one this solves). Exposed to the internet via NAT/port-forward,
// this route is the one realistic brute-force target: findUser()/
// verifyPassword() have no throttling of their own, and scrypt (deliberately
// slow, but not THAT slow) doesn't make a fast automated guesser impractical
// on its own. Both knobs are configurable because "reasonable" depends on
// the deployment - a single-admin LAN box and a multi-operator internet-
// facing one don't want the same threshold - but default to something
// sane (5 attempts / 15 minutes / IP) so a fresh checkout is protected with
// zero configuration, matching the JWT_SECRET/CORS fallback pattern used
// elsewhere in this file.
// Every limiter reads its numbers from the request limits in force (the environment of the deployment first, then what an administrator saved
// in Server Admin, then the defaults) at the moment of each request, so a change applies at once and the switch can turn all of them off.
// A limiter is rebuilt when its numbers change (its counters then start again).
type LimitPick = (s: RateLimitSettings) => { limit: number; windowMs: number };
type LimitedHandler = (req: any, res: any, windowMs: number) => void;

let rateLimitSource: () => RateLimitSettings = () => rateLimitSettings(securityEnvFrom(process.env), {});
/** The server gives the limiters the settings of its security configuration (data/server-config.json); without it they use the environment and the defaults. */
export function setRateLimitSettingsProvider(provider: (() => RateLimitSettings) | null): void {
  rateLimitSource = provider ?? (() => rateLimitSettings(securityEnvFrom(process.env), {}));
}

function configurableLimiter(pick: LimitPick, onLimit: LimitedHandler, options: { skipSuccessfulRequests?: boolean } = {}): RequestHandler {
  let built: { key: string; handler: RequestHandler } | null = null;
  return (req, res, next) => {
    const settings = rateLimitSource();
    if (!settings.enabled) return next();
    const { limit, windowMs } = pick(settings);
    const key = `${limit}:${windowMs}`;
    if (!built || built.key !== key) {
      built = {
        key,
        handler: rateLimit({
          windowMs,
          limit,
          standardHeaders: true, // sets RateLimit-* response headers a well-behaved client can read
          legacyHeaders: false,
          // the instance is rebuilt on purpose when an administrator changes its numbers, so the library's check for one created per request does not apply
          validate: { creationStack: false },
          ...options,
          // Replaces express-rate-limit's generic default body (a bare "Too many requests" string, easy to mistake for a network/proxy error)
          // with the {error} shape every other route answers with, plus a wait hint.
          handler: (rq, rs) => onLimit(rq, rs, windowMs),
        }),
      };
    }
    return built.handler(req, res, next);
  };
}

const tooMany = (message: string): LimitedHandler => (_req, res, windowMs) => {
  res.status(429).json({ error: message, retryAfterMs: windowMs });
};

// Only failed sign-in attempts count: a script that logs in once per run (a CLI) must not lock itself out, while password guessing is still capped.
export const loginRateLimiter = configurableLimiter(
  (s) => ({ limit: s.loginMax, windowMs: s.loginWindowMs }),
  tooMany("Too many login attempts - please wait before trying again."),
  { skipSuccessfulRequests: true },
);

// The public key set is asked for by verifiers that cache it, so a modest budget per address is plenty.
export const jwksRateLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 60,
  standardHeaders: true,
  legacyHeaders: false,
  skip: () => !rateLimitSource().enabled,
  handler: (req, res) => {
    res.status(429).json({ error: "Too many requests for the key set - please wait before trying again.", retryAfterMs: 60 * 1000 });
  },
});

// Refresh tokens are unguessable 32-byte values, not passwords, and every signed-in client refreshes on its own schedule (often behind one shared NAT
// address), so the refresh route gets its own, much higher budget, in the sign-in window.
export const refreshRateLimiter = configurableLimiter(
  (s) => ({ limit: s.refreshMax, windowMs: s.loginWindowMs }),
  tooMany("Too many refresh attempts - please wait before trying again."),
);

// The global stop (POST /api/stop-all) is a safety function: it has its own, much higher budget than the login (an emergency stop must not be starved by
// anything else), but it is still bounded, per address, so a loop of calls cannot saturate the server.
export const stopAllRateLimiter = configurableLimiter(
  (s) => ({ limit: s.stopAllMax, windowMs: s.stopAllWindowMs }),
  tooMany("Too many global stop requests from this address - the robots were not touched by this call, use the per-robot stop meanwhile."),
);

// The general budget per address for the API routes that read or change things: generous (a kiosk, a phone and a browser behind one address all poll),
// so only a loop that hammers the server is stopped.
export const apiRateLimiter = configurableLimiter(
  (s) => ({ limit: s.apiMax, windowMs: s.apiWindowMs }),
  tooMany("Too many requests from this address - please wait before trying again."),
);

// A tighter budget for the routes that check a one-time code or password again, or that start and stop services: guessing is capped.
export const sensitiveRateLimiter = configurableLimiter(
  (s) => ({ limit: s.sensitiveMax, windowMs: s.apiWindowMs }),
  tooMany("Too many attempts from this address - please wait before trying again."),
);
