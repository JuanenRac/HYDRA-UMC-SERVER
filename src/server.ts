// =============================================================================
// HYDRA-UMC SERVER - Headless Express/WebSocket Backend: src/server.ts
// Copyright (C) 2026 JuanenRac (Electro Hobby 3D) <electrohobby3d@gmail.com>
// GPL-3.0 - see LICENSE
//
// The API/WebSocket engine that used to live inside HYDRA-UMC-STUDIO's own
// server.ts, split out into its own project so the robot-control backend
// (this file) and the browser UI (HYDRA-UMC-STUDIO, now a pure Vite/React
// client) can run, restart, scale, and be hosted independently - see this
// project's own README.md for the full rationale. Still primarily an API +
// WebSocket backend, meant to run headless (e.g. as a daemon on the CM5)
// with no dev middleware of its own - but it DOES optionally serve
// HYDRA-UMC STUDIO's own built frontend as static files from public/ (see
// the express.static(studioPublicPath) mount below and
// build-frontend.sh/.bat), for the common "everything on the CM5, one
// origin" deployment src/lib/apiBase.ts on the STUDIO side already assumes
// by default. Entirely optional: public/ is gitignored and nothing here
// requires it to exist - a deployment that never runs build-frontend stays
// exactly as headless as before, this server just serves 404s at "/"
// instead of a real page.
// =============================================================================

import express from "express";
import cors from "cors";
import rateLimit from "express-rate-limit";
import path from "path";
import fs from "fs";
import http from "http";
import https from "https";
import net from "net";
import os from "os";
import crypto from "crypto";
import { execFile, spawn, type ChildProcess } from "child_process";
import { promisify } from "util";
import { WebSocketServer, WebSocket } from "ws";
import { getSystemMetrics, getSupervisorSnapshot } from "./systemMetrics";
import { registerBluetoothRoutes } from "./routes/bluetoothRoutes";
import { registerSystemRoutes } from "./routes/systemRoutes";
import { registerCameraRoutes } from "./routes/cameraRoutes";
import { registerRobotRoutes } from "./routes/robotRoutes";
import { registerCommandRoutes } from "./routes/commandRoutes";
import { registerUpstreamRoutes } from "./routes/upstreamRoutes";
import { getEcosystemStatus, probeTcp, visionStreamerExecutablePath } from "./ecosystemStatus";
import {
  BLUETOOTH_MAC_RE,
  getBluetoothStatus,
  pairBluetoothDevice,
  removeBluetoothDevice,
  scanBluetoothDevices,
  setBluetoothPower,
} from "./bluetooth";
import {
  realSettings,
  remoteAccessAllowed,
  computeDeviceArg,
  cameraFingerprint,
  cameraStreamPort,
  hi3510Action,
  safeIdSegment,
  slugify,
} from "./serverPolicy";
import Bonjour from 'bonjour-service';
import jwt from 'jsonwebtoken';
import { ensureSeedUser, findUser, verifyPassword, listUsers, createUser, updateUser, deleteUser, effectiveTokenVersion, effectiveId, ScryptOverloadError, type UserRole } from './users';
import { issueRefreshToken, consumeRefreshToken, revokeRefreshToken, pruneExpiredRefreshTokens } from './refresh_tokens';
import {
  registry as metricsRegistry,
  authFailuresTotal,
  settingsWriteDuration,
  setWsClientsSource,
  setSystemMetricsSource,
} from './metrics';

// Set by whatever actually starts this process in a real deployment
// (systemd Environment=, pm2, Docker -e, ...) - defaults to "development"
// so a bare `npm run dev`/fresh checkout keeps today's permissive
// defaults (open CORS fallback, no forced hardening) with zero setup.
// Every "only in production" gate below (CORS allowlist enforcement, the
// startup security warnings) reads this same constant so they can't drift.
const NODE_ENV = process.env.NODE_ENV || "development";

// execFile (not exec/execSync) never invokes a shell to parse the command
// line, so there is no shell-metacharacter injection surface even in
// principle - see the one call site below (GET /api/system/metrics),
// which also needs the async form so it doesn't block the event loop.
const execFileAsync = promisify(execFile);

// Development keeps a deterministic fallback so a fresh checkout can run
// locally. Production never accepts it: a source-known signing key would let
// anyone forge a valid token for an internet-reachable deployment.
const configuredJwtSecret = process.env.JWT_SECRET?.trim();
const JWT_SECRET_IS_DEFAULT = !configuredJwtSecret;
if (NODE_ENV === "production" && JWT_SECRET_IS_DEFAULT) {
  throw new Error("Production startup requires a non-empty JWT_SECRET");
}
const JWT_SECRET = configuredJwtSecret || "hydra_industrial_secret_2026";
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
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || "30d";

// Optional local cognitive boundary. Server is the only component that knows
// how to reach Voice UI; watches and phones keep using their authenticated
// Server session and never receive the Voice UI token. Leaving the URL unset
// keeps the endpoint unavailable rather than silently falling back to an
// unauthenticated or guessed process.
const VOICE_UI_URL = (process.env.HYDRA_UMC_VOICE_UI_URL || "").replace(/\/$/, "");
const VOICE_UI_TOKEN = process.env.HYDRA_UMC_VOICE_UI_TOKEN || "";
const VOICE_UI_TIMEOUT_MS = Math.min(
  Math.max(Number(process.env.HYDRA_UMC_VOICE_UI_TIMEOUT_MS) || 4000, 250),
  10000,
);

// Same reasoning and same shape as VOICE_UI_URL above, for STUDIO's
// Ecosystem > Telemetry panel: Server is the only component that knows how
// to reach Datalake, so STUDIO stays a thin frontend of Server instead of a
// second client that has to know Datalake's own host/port. Datalake's own
// HTTP API (GET /query, GET /aggregate - see HYDRA-UMC-DATALAKE/src/
// hydra_umc_datalake/api.py) takes no auth of its own today (same
// same-host-only assumption as every other real service probe in this
// file), so there is no upstream token to hold here, unlike Voice UI.
const DATALAKE_URL = (process.env.HYDRA_UMC_DATALAKE_URL || "").replace(/\/$/, "");
const DATALAKE_TIMEOUT_MS = Math.min(
  Math.max(Number(process.env.HYDRA_UMC_DATALAKE_TIMEOUT_MS) || 4000, 250),
  10000,
);

// Same reasoning and same shape as VOICE_UI_URL/DATALAKE_URL above, for
// STUDIO's Flasher/Tester (canOta.ts's own `transport === 'hardware'`
// switch): Server is the only component that talks to the real local
// spi_bridge HTTP service (HYDRA-UMC/src/cm5_host/spi_bridge/, itself the
// only thing on the CM5 that owns the real SPI1 device + HYDRA_DATA_READY
// GPIO line). Leaving this unset keeps every /api/hardware/canota/* route
// answering 503 rather than silently pretending hardware is connected -
// same "no guessed process" reasoning as VOICE_UI_URL.
const SPI_BRIDGE_URL = (process.env.HYDRA_UMC_SPI_BRIDGE_URL || "").replace(/\/$/, "");
const SPI_BRIDGE_VERSION_TIMEOUT_MS = Math.min(
  Math.max(Number(process.env.HYDRA_UMC_SPI_BRIDGE_TIMEOUT_MS) || 4000, 250),
  10000,
);

// Same reasoning and same shape as VOICE_UI_URL/DATALAKE_URL/SPI_BRIDGE_URL
// above, for HYDRA-UMC-CONNECTOR-HUB's own real `serve-catalog` (Python,
// GET-only - see that project's own catalog_server.py). This is Server's
// first real client of the adapter catalog (previously only a CLI/fixture
// existed - see that project's own README "No real client integration
// yet"): Server proxies /catalog(/:id) so Studio/Suite/Updater can read
// what an external-machine adapter can do without each of them needing to
// know CONNECTOR-HUB's own host/port. No auth token of its own to hold
// here (same as Datalake) - the catalog is read-only manifest metadata,
// never a real credential (authenticationRef is a reference, never the
// secret itself - see that project's own docs/ADAPTER_MANIFEST.md).
const CONNECTOR_HUB_URL = (process.env.HYDRA_UMC_CONNECTOR_HUB_URL || "").replace(/\/$/, "");
const CONNECTOR_HUB_TIMEOUT_MS = Math.min(
  Math.max(Number(process.env.HYDRA_UMC_CONNECTOR_HUB_TIMEOUT_MS) || 4000, 250),
  10000,
);
// A real flash cycle (page-by-page transfer + verify) genuinely takes
// longer than a version query - bounded separately and far more generously,
// but still bounded: an unresponsive board must eventually surface as a
// real, reported failure, never hang this request forever.
const SPI_BRIDGE_FLASH_TIMEOUT_MS = Math.min(
  Math.max(Number(process.env.HYDRA_UMC_SPI_BRIDGE_FLASH_TIMEOUT_MS) || 120000, 5000),
  600000,
);

const VOICE_REQUEST_ID = /^[A-Za-z0-9_-]{1,64}$/;

function validateVoiceTurnPayload(payload: unknown): string | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return "voice turn must be a JSON object";
  }
  const candidate = payload as Record<string, unknown>;
  if (candidate.type !== "voice_turn") return "type must be voice_turn";
  if (typeof candidate.requestId !== "string" || !VOICE_REQUEST_ID.test(candidate.requestId)) {
    return "requestId must contain 1-64 letters, digits, _ or -";
  }
  if (typeof candidate.transcript !== "string" || !candidate.transcript.trim() || candidate.transcript.length > 500) {
    return "transcript must contain 1-500 characters";
  }
  if (typeof candidate.locale !== "string" || candidate.locale.length < 2 || candidate.locale.length > 35) {
    return "locale must contain 2-35 characters";
  }
  return null;
}

function isAssistantReplyForRequest(payload: unknown, requestId: string): payload is Record<string, unknown> {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return false;
  const candidate = payload as Record<string, unknown>;
  return candidate.type === "assistant_reply" &&
    candidate.requestId === requestId &&
    typeof candidate.text === "string" && candidate.text.length > 0 && candidate.text.length <= 600 &&
    typeof candidate.level === "string" &&
    typeof candidate.speak === "boolean" &&
    typeof candidate.requiresConfirmation === "boolean";
}

// Bonjour/mDNS service for instant discovery
const bonjour = new Bonjour();
let mdnsService: any = null;
// Set once in startServer() below, from resolvePort() - module-scoped
// (rather than threaded as a parameter through every setupDiscovery() call
// site, including the one inside broadcastSettings() reacting to a
// serverName change) so the mDNS advertisement always matches whatever
// port this process is actually listening on, even after an admin-UI
// config change (see resolvePort()'s own comment - takes effect on the
// next restart, same as the HTTP listener itself).
let currentPort = 3000;

function setupDiscovery(serverName: string) {
  if (mdnsService) mdnsService.stop();
  mdnsService = bonjour.publish({ name: serverName, type: 'hydra', port: currentPort });
  console.log(`[mDNS] Advertising as ${serverName}.local (_hydra._tcp)`);
}

// Log rotation utility
const LOG_FILE = path.join(process.cwd(), "data", "logs", "server.log");
if (!fs.existsSync(path.dirname(LOG_FILE))) fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });

// Admin-UI-editable server config (currently just the listen port) -
// separate from data/settings.json (robot/controller state, a much larger
// and more frequently-written file) since this is small, rarely changes,
// and is read once at startup rather than kept live in memory throughout.
const SERVER_CONFIG_FILE = path.join(process.cwd(), "data", "server-config.json");

interface ServerConfig {
  port?: number;
}

function loadServerConfig(): ServerConfig {
  try {
    return JSON.parse(fs.readFileSync(SERVER_CONFIG_FILE, "utf-8"));
  } catch {
    return {};
  }
}

function saveServerConfig(config: ServerConfig) {
  fs.mkdirSync(path.dirname(SERVER_CONFIG_FILE), { recursive: true });
  fs.writeFileSync(SERVER_CONFIG_FILE, JSON.stringify(config, null, 2));
}

// Priority: process.env.PORT (deployment-level override - systemd
// Environment=, pm2, Docker -e - always wins, same convention as
// JWT_SECRET/NODE_ENV elsewhere in this file) > data/server-config.json's
// saved port (written by the admin UI's Config screen) > the historical
// hardcoded default of 3000, unchanged for anyone who never touches this.
// A port change here (either source) only takes effect on the NEXT
// process start - this server doesn't attempt to rebind its own listening
// socket at runtime, which would drop every open WebSocket connection
// anyway - the admin UI's Config screen says so explicitly and offers a
// "Restart now" action (POST /api/admin/restart) rather than pretending
// the change is instant.
function resolvePort(): number {
  const envPort = parseInt(process.env.PORT || "", 10);
  if (Number.isFinite(envPort) && envPort > 0) return envPort;
  const configPort = loadServerConfig().port;
  if (Number.isFinite(configPort) && (configPort as number) > 0) return configPort as number;
  return 3000;
}

// Opened once and kept open for the life of the process instead of the
// open+write+close fs.appendFileSync() this used to do on EVERY call
// (industrialLog() fires on every robot command, not just at startup) -
// that blocked the entire Node event loop (every other in-flight
// request/WS message, since this is a single-threaded server) for the
// duration of a synchronous disk write each time. A persistent
// WriteStream in append mode queues writes internally and flushes them
// asynchronously without blocking, and Node guarantees writes queued on
// the same stream land on disk in the order they were written.
let logStream = fs.createWriteStream(LOG_FILE, { flags: "a" });
logStream.on("error", (err) => console.error("[industrialLog] log stream error", err));

// Real size-based rotation - the "Log rotation utility" comment above this
// block used to be aspirational only (an append-only stream with nothing
// that ever trimmed it): an industrial
// cell logs a line on every robot command, so an unattended CM5 running
// continuously for weeks/months WILL fill the eMMC eventually with no
// bound at all. Single-file rotation (current -> .1, current truncated),
// not a numbered N-file history - simple, and "the last ~10MB plus
// whatever's in .1" is enough for GET /api/admin/logs's own tail view
// (which only ever reads the last few hundred lines anyway, see below),
// not meant to replace `journalctl`/a real log aggregator for long-term
// industrial audit retention.
const MAX_LOG_BYTES = 10 * 1024 * 1024; // 10MB
const ROTATED_LOG_FILE = `${LOG_FILE}.1`;

function rotateLogIfNeeded() {
  let size = 0;
  try {
    size = fs.statSync(LOG_FILE).size;
  } catch {
    return; // file doesn't exist yet (fresh install) - nothing to rotate
  }
  if (size < MAX_LOG_BYTES) return;

  logStream.end();
  try {
    fs.rmSync(ROTATED_LOG_FILE, { force: true });
    fs.renameSync(LOG_FILE, ROTATED_LOG_FILE);
  } catch (err) {
    console.error("[industrialLog] log rotation failed", err);
  }
  logStream = fs.createWriteStream(LOG_FILE, { flags: "a" });
  logStream.on("error", (err) => console.error("[industrialLog] log stream error", err));
}

function industrialLog(msg: string) {
  const entry = `[${new Date().toISOString()}] ${msg}\n`;
  console.log(msg);
  rotateLogIfNeeded();
  logStream.write(entry);
}

// realSettings/remoteAccessAllowed now live in ./serverPolicy (see that
// module's own header comment) - both moved unchanged so they're directly
// unit-testable without spawning a real server process.

// Bumped whenever the /api/hydra-info or /ws message contract changes in a
// way a remote client (HYDRA-UMC SUITE, the mobile control apps) might need
// to branch on - NOT the same number as package.json's own app version.
// 2 = this server can emit a real targeted delta (schema 2) on /ws for a
// client that opts in by connecting with ?remoteApiVersion=2 in its own
// query string - the SAME field/number a client already reads back from
// GET /api/hydra-info, reused here as the version THIS client itself
// understands rather than inventing a separate field (owner's own
// choice). A client that connects without this param (every
// one of the 6 existing clients today, none of which send it) is treated
// as schema 1 and keeps getting the full tree under `type: "delta"`
// exactly like before - bumping this constant is informational-only until
// a client's own code starts sending the param.
const REMOTE_API_VERSION = 2;

// Middleware to verify JWT token - the decoded payload now carries
// {username, role}, not just {username}, so requireAdmin below can gate
// the routes an "operator" account shouldn't reach.
function authenticate(req: any, res: any, next: any) {
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
  jwt.verify(token, JWT_SECRET, { algorithms: ["HS256"] }, (err: any, user: any) => {
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
function asyncHandler(handler: (req: any, res: any) => Promise<any>) {
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

function requireAdmin(req: any, res: any, next: any) {
  if (req.user?.role !== "admin") {
    return res.status(403).json({ error: "Access denied: admin privileges required" });
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
const LOGIN_RATE_LIMIT_WINDOW_MS = Number(process.env.LOGIN_RATE_LIMIT_WINDOW_MS) || 15 * 60 * 1000;
const LOGIN_RATE_LIMIT_MAX = Number(process.env.LOGIN_RATE_LIMIT_MAX) || 5;
const loginRateLimiter = rateLimit({
  windowMs: LOGIN_RATE_LIMIT_WINDOW_MS,
  limit: LOGIN_RATE_LIMIT_MAX,
  standardHeaders: true, // sets RateLimit-* response headers a well-behaved client can read
  legacyHeaders: false,
  // Overrides express-rate-limit's own generic default body (a bare
  // "Too many requests" string, no JSON, easy to mistake for a network/
  // proxy error) with the same {error} shape every other route in this
  // file already responds with, plus a wait hint - never a bare 500, this
  // IS the intended, correctly-functioning response when tripped.
  handler: (req, res) => {
    res.status(429).json({
      error: "Too many login attempts - please wait before trying again.",
      retryAfterMs: LOGIN_RATE_LIMIT_WINDOW_MS,
    });
  },
});

async function startServer() {
  sweepOrphanedTmpFiles(path.join(process.cwd(), "data"));

  const app = express();
  const PORT = resolvePort();
  currentPort = PORT;

  // Real CORS, not same-origin-only: HYDRA-UMC STUDIO (and any other
  // browser-based client of this API) runs as a separate Vite origin in
  // dev (typically localhost:5173) and can be hosted on an entirely
  // different machine/domain in production (see README.md's own "why
  // separate" section - the whole point of splitting this server out is
  // that the UI no longer has to share this process' own origin).
  //
  // Used to be wide-open `cors()` with no arguments unconditionally - a
  // defensible call while every real client sat on the same trusted LAN,
  // but this server can now also be reached over the open internet
  // (NAT/port-forward), where "reflect literally any Origin header" stops
  // being a LAN-only trade-off and starts letting any random website a
  // logged-in admin's browser happens to visit make authenticated
  // cross-origin requests against it. CORS itself doesn't touch the
  // bearer-token gate on the routes that matter (a non-browser caller -
  // curl, the mobile apps, HYDRA-UMC SUITE - never sends an Origin header
  // and CORS never applies to it either way), but a browser DOES attach
  // whatever bearer token that tab already holds to a same-tab
  // cross-origin fetch, so an open allowlist is real exposure specifically
  // for the one client that runs inside a browser (HYDRA-UMC STUDIO).
  //
  // CORS_ALLOWED_ORIGINS (see .env.example) is a comma-separated allowlist
  // - set it to wherever HYDRA-UMC STUDIO is actually served from (e.g.
  // `https://studio.example.com` or `http://192.168.1.20:5173`) once this
  // server is reachable beyond a trusted LAN. Same fallback pattern as
  // JWT_SECRET elsewhere in this file: unset + NODE_ENV!=='production'
  // keeps today's permissive "allow everything" behavior with zero setup
  // (so `npm run dev` from a fresh checkout still works against STUDIO's
  // own dev server without any env configuration) - unset + production
  // does NOT silently stay open; it denies every cross-origin browser
  // request instead (non-browser clients are unaffected either way) and
  // prints a loud startup warning, same severity as the JWT_SECRET/admin
  // password warnings below, so a deployer notices instead of being
  // silently exposed OR silently broken.
  const CORS_ALLOWED_ORIGINS = (process.env.CORS_ALLOWED_ORIGINS || "")
    .split(",")
    .map(s => s.trim())
    .filter(Boolean);

  let corsOptions: cors.CorsOptions;
  if (CORS_ALLOWED_ORIGINS.length > 0) {
    corsOptions = { origin: CORS_ALLOWED_ORIGINS };
  } else if (NODE_ENV !== "production") {
    corsOptions = {}; // same as the old unconditional cors() - reflects any Origin
    console.warn("[SECURITY] CORS_ALLOWED_ORIGINS not set - allowing requests from any origin (development fallback, NODE_ENV != 'production'). Set CORS_ALLOWED_ORIGINS before exposing this server in production.");
  } else {
    corsOptions = { origin: false }; // deny every cross-origin browser request rather than stay silently open
    console.warn("=================================================================");
    console.warn("[SECURITY WARNING] NODE_ENV=production but CORS_ALLOWED_ORIGINS is not set.");
    console.warn("  Every cross-origin browser request (e.g. HYDRA-UMC STUDIO served");
    console.warn("  from a different host/port) will be REJECTED until you set it.");
    console.warn("  Non-browser clients (curl, HYDRA-UMC SUITE, the mobile apps) are unaffected.");
    console.warn("  Set CORS_ALLOWED_ORIGINS to a comma-separated list, e.g.:");
    console.warn("    CORS_ALLOWED_ORIGINS=https://studio.example.com,http://192.168.1.20:5173");
    console.warn("=================================================================");
  }
  app.use(cors(corsOptions));

  app.use(express.json({ limit: "50mb" }));

  // Create data directory if it doesn't exist
  const dataPath = path.join(process.cwd(), "data");
  if (!fs.existsSync(dataPath)) {
    fs.mkdirSync(dataPath, { recursive: true });
  }

  // users.ts requires explicit bootstrap credentials on a production first
  // start. Development/test retain an isolated local convenience account.
  await ensureSeedUser();

  // A hygiene sweep for refresh_tokens.ts's own data/refresh_tokens.json
  // - see pruneExpiredRefreshTokens()'s own doc comment. Run once at
  // startup (same timing as the .tmp sweep above) and again every 6h for
  // a long-running process - an expired-but-never-rotated record (an
  // abandoned/lost device) would otherwise never get removed on its own.
  const prunedAtStartup = pruneExpiredRefreshTokens();
  if (prunedAtStartup > 0) industrialLog(`[STARTUP] Removed ${prunedAtStartup} expired refresh token(s).`);
  setInterval(() => {
    const pruned = pruneExpiredRefreshTokens();
    if (pruned > 0) industrialLog(`[MAINTENANCE] Removed ${pruned} expired refresh token(s).`);
  }, 6 * 60 * 60 * 1000).unref();

  // The signing key and first administrator are enforced above. Keep a loud
  // diagnostic for an operator who deliberately configured the weak literal
  // admin/admin pair, but never create it implicitly in production.
  if (NODE_ENV === "production") {
    // scrypt uses a random salt per user (see users.ts's own
    // hashPassword()), so there's no fixed "known bad hash" to compare
    // against - but verifyPassword() re-derives a hash using the STORED
    // salt and checks it against the stored hash, so calling it with the
    // literal seeded password is a real, reliable check for "this
    // account's password still verifies as admin/admin today", not a
    // guess. False negative only if the admin changed it to something
    // that also happens to verify as "admin" (impossible - verifyPassword
    // is exact) or renamed the account away from "admin" without changing
    // the password (still genuinely fine, since "admin" the username no
    // longer exists to attack).
    const seededAdmin = findUser("admin");
    const adminStillDefault = !!seededAdmin && (await verifyPassword("admin", seededAdmin.passwordHash));
    if (adminStillDefault) {
      console.warn("=================================================================");
      console.warn("[SECURITY WARNING] NODE_ENV=production but the seeded admin/admin");
      console.warn("  account still has its original default password. Anyone who can");
      console.warn("  reach this server can log in as admin. Change it now: Config >");
      console.warn("  Users, or POST /api/users/admin with a new password.");
      console.warn("=================================================================");
    }
  }

  const getSettingsPath = () => {
    return path.join(dataPath, "settings.json");
  };

  // safeIdSegment now lives in ./serverPolicy (see that module's own
  // header comment) - moved unchanged so it's directly unit-testable.

  // See queueSettingsWrite's own header comment for why each robot's
  // recordedPoints array lives in its own file here rather than inline in
  // settings.json - isolates the one field that can legitimately grow to
  // several MB (a long real trajectory) or balloon because of a client-side
  // duplication bug, into its own file whose own size and modification time immediately point at
  // the culprit robot instead of hiding inside one multi-MB settings.json.
  function getPointsPath(controllerId: unknown, robotId: unknown): string {
    return path.join(dataPath, "points", safeIdSegment(controllerId), `${safeIdSegment(robotId)}.json`);
  }

  // Writes `json` to `finalPath` via the same crash-safe pattern
  // queueSettingsWrite always used for settings.json itself -
  // sibling temp file (PID + timestamp, so two overlapping writers never
  // collide on the same temp path) written first, then atomically renamed
  // over the real path, so a write interrupted partway (disk full, process
  // killed, power loss) never leaves `finalPath` itself truncated/corrupt -
  // it's either the complete new content or untouched, never in between.
  // Shared now that queueSettingsWrite writes more than one file per call.
  //
  // Real bug found and fixed here: unlike POSIX rename(2), Windows'
  // rename-over-an-existing-destination isn't guaranteed atomic and can
  // fail with EPERM/EBUSY if the destination is transiently open by
  // something else for a moment (an AV scanner, a backup/sync agent, a
  // file watcher) - and with no retry or cleanup, that left the real
  // tmpPath orphaned forever. Found 16 real orphaned
  // `data/settings.json.<pid>.<timestamp>.tmp` files on this same dev
  // machine, spanning 7 different server runs (see
  // sweepOrphanedTmpFiles(), below, for the cleanup of what already
  // accumulated). Fixed with a few short retries on ENOENT/EPERM/EBUSY
  // (the transient-lock case actually clears almost always within a few
  // ms) and a real cleanup of tmpPath if every retry still fails, so a
  // genuine failure at least doesn't leave garbage behind too.
  async function writeFileAtomic(finalPath: string, json: string): Promise<void> {
    const tmpPath = `${finalPath}.${process.pid}.${Date.now()}.tmp`;
    await fs.promises.mkdir(path.dirname(finalPath), { recursive: true });
    await fs.promises.writeFile(tmpPath, json, "utf-8");
    let lastError: unknown;
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        await fs.promises.rename(tmpPath, finalPath);
        return;
      } catch (err) {
        lastError = err;
        await new Promise((r) => setTimeout(r, 50 * (attempt + 1)));
      }
    }
    try { await fs.promises.unlink(tmpPath); } catch { /* best-effort - don't mask the real error below with a cleanup failure */ }
    throw lastError;
  }

  // Real, honest cleanup for whatever writeFileAtomic() failures already
  // left behind before the fix above existed - a *.tmp sibling of
  // data/settings.json or a data/points/**/*.json file that's still
  // here at startup was never mid-rename (that always completes or gets
  // cleaned up within milliseconds, never across a process restart), so
  // it's real garbage, safe to remove unconditionally.
  function sweepOrphanedTmpFiles(dataDir: string): void {
    let removed = 0;
    const walk = (dir: string) => {
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full);
        } else if (entry.name.endsWith(".tmp")) {
          try { fs.unlinkSync(full); removed++; } catch { /* best-effort */ }
        }
      }
    };
    walk(dataDir);
    if (removed > 0) industrialLog(`[STARTUP] Removed ${removed} orphaned .tmp file(s) under ${dataDir} left over from an earlier interrupted write.`);
  }

  // Reassembles the full in-memory settings shape (recordedPoints inline,
  // exactly as every route/broadcast in this file already expects) from
  // the split on-disk layout: data/settings.json (everything else) plus
  // one data/points/<controllerId>/<robotId>.json per robot. Used both at
  // startup (to seed lastKnownSettings) and by GET /api/settings (which
  // always re-reads disk fresh rather than trusting the in-memory mirror -
  // see that route's own comment) - a single implementation so the two
  // can never quietly diverge on how a robot's points get reattached.
  //
  // Backward compatible with a settings.json from before this split: if a
  // robot's own points file doesn't exist yet AND that robot object
  // already carries an inline recordedPoints array (pre-split data,
  // migrated on-disk once by any subsequent write - see
  // queueSettingsWrite), that inline array is left as-is rather than
  // wiped to []. Only a robot with neither an inline array nor a points
  // file (genuinely never recorded anything) defaults to [].
  function loadFullSettingsFromDisk(): any {
    const settingsPath = getSettingsPath();
    let core: any = {};
    if (fs.existsSync(settingsPath)) {
      core = JSON.parse(fs.readFileSync(settingsPath, "utf-8"));
    }
    for (const c of core.controllers || []) {
      for (const r of c.robots || []) {
        const pointsPath = getPointsPath(c.id, r.id);
        try {
          if (fs.existsSync(pointsPath)) {
            r.recordedPoints = JSON.parse(fs.readFileSync(pointsPath, "utf-8"));
          } else if (!Array.isArray(r.recordedPoints)) {
            r.recordedPoints = [];
          }
        } catch {
          // Corrupt points file for this ONE robot - don't let it take
          // down settings for every other robot, just start this robot
          // with no recorded points (same fallback the whole file already
          // gets one level up if settings.json itself is unreadable).
          r.recordedPoints = [];
        }
      }
    }
    return core;
  }

  let pkgVersion = "0.0.0";
  try {
    pkgVersion = JSON.parse(fs.readFileSync(path.join(process.cwd(), "package.json"), "utf-8")).version || pkgVersion;
  } catch {
    // package.json missing/unreadable - keep the placeholder version rather than fail startup over it
  }

  // In-memory mirror of the last settings write, kept for /api/hydra-info's
  // own cheap robot/controller counts (see that route below) and as the
  // payload broadcastSettings() sends to newly-(re)connecting WebSocket
  // clients. Seeded from disk at startup so a remote client scanning right
  // after a server restart still sees real counts, not zeros.
  let lastKnownSettings: any = {};
  try {
    lastKnownSettings = loadFullSettingsFromDisk();
  } catch {
    // corrupt/unreadable settings.json - start from an empty object rather than crash the server
  }

  // --- Real per-camera process supervisor -------------------------------
  //
  // GET /api/camera/:id/stream (below) is a pure proxy to a local
  // hydra-umc-vision-streamer "stream serve" instance on
  // 127.0.0.1:8100+(id-1) - it never launches one itself. Before this,
  // NOTHING did: STUDIO/SUITE's own camera config UI (sourceType/
  // ipHost/rtspPort/rtspPath/ipUsername/ipPassword, already
  // field-complete on both) only ever persisted JSON here - saving a
  // camera's real IP config had zero effect on whether any video
  // actually showed up. This reconciles the real child process for
  // every camera against its real current config, every time settings
  // are saved (via applySettingsUpdate(), below) and once at startup.
  interface CameraProcessState {
    proc: ChildProcess | null;
    port: number;
    fingerprint: string;
    status: "starting" | "running" | "error" | "stopped";
    lastError: string | null;
    recentOutput: string[];
    // How many times in a row the self-heal below has had to kill and
    // respawn THIS exact fingerprint without ever seeing it reach
    // "running" - drives the escalating backoff between attempts (see
    // the health check below) and resets to 0 the moment it actually
    // comes up. Not persisted across a real fingerprint change/stop -
    // a genuinely different config starts this back at 0.
    restartAttempts: number;
  }
  const cameraProcesses = new Map<string, CameraProcessState>();

  // cameraFingerprint now lives in ./serverPolicy (see that module's own
  // header comment) - moved unchanged so it's directly unit-testable.

  function stopCameraProcess(key: string): void {
    const state = cameraProcesses.get(key);
    if (!state?.proc) return;
    const proc = state.proc;
    industrialLog(`[CAMERA] stopping ${key} pid=${proc.pid}`);
    state.proc = null;
    proc.kill("SIGTERM");
    const killTimer = setTimeout(() => {
      try { proc.kill("SIGKILL"); } catch { /* already gone */ }
    }, 2000);
    killTimer.unref();
    proc.once("exit", () => clearTimeout(killTimer));
    writeCameraPidFile();
  }

  // Real pidfile-based orphan reaping for camera child processes - unlike
  // POSIX, killing this Node process by anything other than a clean
  // SIGINT/SIGTERM that actually reaches gracefulShutdown() (window
  // closed via taskkill /F, a debugger stopping the process, a crash)
  // does NOT take its spawned children down with it on Windows - there's
  // no process-group-wide kill happening automatically. An orphaned
  // `stream serve` child just keeps running forever, silently holding
  // its camera device and TCP port. Caught live on this same dev machine:
  // 2 real orphaned vision-streamer processes still holding ports
  // 8100/8101 from an earlier server incarnation, fighting the current
  // server's own freshly-reconciled replacements over the same real
  // webcam and RTSP stream. Fixed with a small pidfile
  // (data/camera-process-pids.json), kept current by writeCameraPidFile()
  // below every time cameraProcesses actually changes, and read back
  // once here, before this incarnation reconciles (and so spawns) any
  // camera process of its own - a real liveness probe (process.kill(pid,
  // 0), never a guess) decides what's actually still running.
  function cameraPidFilePath(): string {
    return path.join(process.cwd(), "data", "camera-process-pids.json");
  }

  function writeCameraPidFile(): void {
    const pids = Array.from(cameraProcesses.values())
      .map((s) => s.proc?.pid)
      .filter((pid): pid is number => typeof pid === "number");
    try {
      fs.mkdirSync(path.dirname(cameraPidFilePath()), { recursive: true });
      fs.writeFileSync(cameraPidFilePath(), JSON.stringify(pids), "utf-8");
    } catch {
      // best-effort - losing this file only means a future orphan from
      // THIS incarnation won't be reaped next boot, not a functional
      // break today.
    }
  }

  function reapOrphanedCameraProcesses(): void {
    let pids: unknown;
    try {
      pids = JSON.parse(fs.readFileSync(cameraPidFilePath(), "utf-8"));
    } catch {
      return; // no pidfile yet (first run ever, or already empty) - nothing to reap
    }
    if (!Array.isArray(pids)) return;
    let killed = 0;
    for (const pid of pids) {
      if (typeof pid !== "number") continue;
      try {
        process.kill(pid, 0); // real liveness probe - throws (ESRCH) if this PID is already gone, the common case
        process.kill(pid, "SIGTERM");
        killed++;
      } catch {
        // already gone - nothing to reap for this one
      }
    }
    if (killed > 0) {
      industrialLog(`[STARTUP] Reaped ${killed} orphaned camera process(es) left running by an earlier server instance (see reapOrphanedCameraProcesses's own comment).`);
    }
  }

  // Real self-heal, not just a status label: a process that's still
  // technically alive but never answers (a hung RTSP reconnect - the
  // exact real bug reported live: camera 4's own stream would freeze
  // mid-switch and never come back) or one that genuinely exits on its
  // own used to just sit in cameraProcesses forever marked "error" -
  // reconcileCameraProcesses()'s own short-circuit only skips a camera
  // when it already has a live `proc`, so once one went stuck, NOTHING
  // touched it again until an unrelated settings save happened to come
  // through. This schedules a real respawn of the exact same config
  // instead, with an escalating backoff (5s/10s/20s, capped at 30s) so a
  // genuinely broken camera (wrong credentials, unreachable host)
  // doesn't hammer the OS or the real camera hardware with a spawn every
  // few seconds forever.
  function scheduleCameraRespawn(key: string, port: number, deviceArg: string, fingerprint: string, priorAttempts: number): void {
    const delayMs = Math.min(5000 * Math.pow(2, priorAttempts), 30000);
    const retryTimer = setTimeout(() => {
      const current = cameraProcesses.get(key);
      // Only respawn if this exact stuck config is still the one
      // tracked - a real reconcile (config changed, camera disabled or
      // deleted) may already have superseded it, and that always wins
      // over this fallback.
      if (current && current.proc === null && current.fingerprint === fingerprint && current.status === "error") {
        startCameraProcess(key, port, deviceArg, fingerprint, priorAttempts + 1);
      }
    }, delayMs);
    retryTimer.unref();
  }

  function startCameraProcess(key: string, port: number, deviceArg: string, fingerprint: string, restartAttempts: number = 0): void {
    const exePath = visionStreamerExecutablePath();
    if (!fs.existsSync(exePath)) {
      industrialLog(`[CAMERA] ${key}: HYDRA-UMC-VISION-STREAMER not found at ${exePath} - reporting error status, not spawning`);
      cameraProcesses.set(key, {
        proc: null, port, fingerprint, status: "error",
        lastError: `HYDRA-UMC-VISION-STREAMER not found at ${exePath} - is it checked out as a sibling repo with its own .venv installed (pip install -e .)?`,
        recentOutput: [], restartAttempts,
      });
      return;
    }
    const proc = spawn(exePath, ["stream", "serve", "--device", deviceArg, "--port", String(port)], { stdio: ["ignore", "pipe", "pipe"] });
    industrialLog(`[CAMERA] starting ${key} on port ${port} (device=${deviceArg}) pid=${proc.pid}${restartAttempts > 0 ? ` (self-heal retry #${restartAttempts})` : ""}`);
    const state: CameraProcessState = { proc, port, fingerprint, status: "starting", lastError: null, recentOutput: [], restartAttempts };
    cameraProcesses.set(key, state);
    writeCameraPidFile();
    const captureOutput = (data: Buffer) => {
      const lines = data.toString("utf-8").split(/\r?\n/).filter(Boolean);
      state.recentOutput.push(...lines);
      if (state.recentOutput.length > 20) state.recentOutput.splice(0, state.recentOutput.length - 20);
    };
    proc.stdout?.on("data", captureOutput);
    proc.stderr?.on("data", captureOutput);
    // Real check, not a guess: mjpeg_server.py's own stream serve binds
    // and starts serving HTTP as soon as it opens the real camera/RTSP
    // device, before the child process would otherwise ever exit on its
    // own - a short real TCP probe against its own port is a more
    // honest "is this actually up" signal than "the process object
    // still exists".
    // Real retries, not one shot: a cold RTSP connect (real network round
    // trip to the camera, real GStreamer/OpenCV backend init) genuinely
    // took longer than a single 1.5s check allowed for on the real CM5 -
    // caught live testing this against real hardware on the real CM5: a
    // cold RTSP connect over a real network plus real ARM CPU startup
    // overhead can genuinely take well past what any single fixed
    // window covers (10s still wasn't always enough for some of this
    // ecosystem's own real cameras) - and a one-shot check that never
    // runs again also can't ever notice a camera that WAS running and
    // then genuinely dropped. So this is a persistent health check, not
    // a bounded startup probe: ticks every HEALTH_CHECK_INTERVAL_MS for
    // as long as this exact process is the one tracked for `key`,
    // flipping to "running" the moment it answers and to "error" only
    // after HEALTH_CHECK_FAILURE_THRESHOLD consecutive misses (avoids
    // flapping the badge between "starting"/"error" during a normal,
    // if slow, cold start - "starting" is the honest state to show
    // until that many misses actually happen).
    const HEALTH_CHECK_INTERVAL_MS = 2000;
    const HEALTH_CHECK_FAILURE_THRESHOLD = 10; // ~20s of misses before calling it an error
    let consecutiveFailures = 0;
    const healthTimer = setInterval(async () => {
      if (cameraProcesses.get(key)?.proc !== proc) {
        clearInterval(healthTimer); // superseded by a respawn or a stop already
        return;
      }
      const up = await probeTcp(port);
      if (cameraProcesses.get(key)?.proc !== proc) {
        clearInterval(healthTimer);
        return;
      }
      if (up) {
        consecutiveFailures = 0;
        state.status = "running";
        state.lastError = null;
        state.restartAttempts = 0; // it recovered - the next real failure starts backoff over from 5s
        return;
      }
      consecutiveFailures++;
      if (consecutiveFailures >= HEALTH_CHECK_FAILURE_THRESHOLD) {
        clearInterval(healthTimer);
        const nextAttempt = state.restartAttempts + 1;
        const retryInSec = Math.min(5 * Math.pow(2, state.restartAttempts), 30);
        state.status = "error";
        state.lastError =
          (state.recentOutput.slice(-3).join(" | ") ||
            `stream serve has not answered on its own port for ${(HEALTH_CHECK_FAILURE_THRESHOLD * HEALTH_CHECK_INTERVAL_MS) / 1000}s`) +
          ` - killing and retrying in ${retryInSec}s (attempt #${nextAttempt})`;
        industrialLog(`[CAMERA] ${key}: unresponsive, killing pid=${proc.pid} and scheduling a real respawn in ${retryInSec}s`);
        proc.kill("SIGTERM");
        const killTimer = setTimeout(() => { try { proc.kill("SIGKILL"); } catch { /* already gone */ } }, 2000);
        killTimer.unref();
        state.proc = null;
        writeCameraPidFile();
        scheduleCameraRespawn(key, port, deviceArg, fingerprint, state.restartAttempts);
      }
    }, HEALTH_CHECK_INTERVAL_MS);
    healthTimer.unref();
    proc.once("exit", (code, signal) => {
      if (cameraProcesses.get(key)?.proc !== proc) return; // already replaced by a respawn
      clearInterval(healthTimer);
      state.proc = null;
      state.status = "error";
      const retryInSec = Math.min(5 * Math.pow(2, state.restartAttempts), 30);
      state.lastError = `stream serve exited (code=${code}, signal=${signal}) - ${state.recentOutput.slice(-3).join(" | ") || "no output captured"} - retrying in ${retryInSec}s`;
      writeCameraPidFile();
      scheduleCameraRespawn(key, port, deviceArg, fingerprint, state.restartAttempts);
    });
    proc.once("error", (err) => {
      clearInterval(healthTimer);
      state.proc = null;
      state.status = "error";
      const retryInSec = Math.min(5 * Math.pow(2, state.restartAttempts), 30);
      state.lastError = `failed to launch stream serve: ${err.message} - retrying in ${retryInSec}s`;
      writeCameraPidFile();
      scheduleCameraRespawn(key, port, deviceArg, fingerprint, state.restartAttempts);
    });
  }

  function reconcileCameraProcesses(payload: any): void {
    const seenKeys = new Set<string>();
    for (const controller of payload?.controllers ?? []) {
      for (const camera of controller?.cameras ?? []) {
        if (!Number.isInteger(camera?.id)) continue;
        const key = `${controller.id}:${camera.id}`;
        seenKeys.add(key);
        const fingerprint = cameraFingerprint(camera);
        const existing = cameraProcesses.get(key);
        const port = cameraStreamPort(camera.id);

        // The real on/off switch (Vision Center's own "toggle
        // connection" button) - caught live from real user feedback: a
        // camera toggled off kept its real stream serve process alive,
        // silently burning CPU/memory for a feed nothing was even
        // asking to see. `connected` is deliberately NOT part of
        // cameraFingerprint() (see that function's own comment - it
        // only tracks fields a respawn would actually need to react
        // to), so this is checked here, before the fingerprint
        // short-circuit below, not folded into it - toggling connected
        // off/on needs a real stop/start regardless of whether the
        // underlying connection config itself changed at the same time.
        if (camera.connected !== true) {
          if (existing?.proc) stopCameraProcess(key);
          cameraProcesses.set(key, {
            proc: null, port, fingerprint, status: "stopped", lastError: null,
            recentOutput: existing?.recentOutput ?? [], restartAttempts: 0,
          });
          continue;
        }

        if (existing && existing.fingerprint === fingerprint && existing.proc) {
          continue; // unchanged config, already has a real process running (or starting) - don't restart a healthy stream
        }
        const deviceArg = computeDeviceArg(camera);
        stopCameraProcess(key);
        if (deviceArg === null) {
          cameraProcesses.set(key, { proc: null, port, fingerprint, status: "error", lastError: "camera config is incomplete or in an unrecognized format", recentOutput: [], restartAttempts: 0 });
          continue;
        }
        startCameraProcess(key, port, deviceArg, fingerprint);
      }
    }
    // A camera that existed before but is gone from this payload
    // (deleted, or its controller was removed) - stop its process too,
    // don't leave it running with no config backing it anymore.
    for (const key of cameraProcesses.keys()) {
      if (!seenKeys.has(key)) {
        stopCameraProcess(key);
        cameraProcesses.delete(key);
      }
    }
    writeCameraPidFile();
  }

  // The one real hook point both settings-write paths (REST POST and
  // the WS "settings" message, see their own two call sites below) were
  // already calling in the exact same 2-step sequence
  // (queueSettingsWrite then broadcastSettings) - folded into one
  // function that also reconciles camera processes, so both paths stay
  // in sync by construction instead of by remembering to update two
  // call sites identically.
  async function applySettingsUpdate(payload: any, originatorWs?: WebSocket): Promise<void> {
    await queueSettingsWrite(payload);
    broadcastSettings(payload, false, originatorWs);
    reconcileCameraProcesses(payload);
  }

  // Reap anything a PREVIOUS incarnation of this server left running
  // (see reapOrphanedCameraProcesses's own comment) BEFORE this one
  // spawns its own replacements below - otherwise the two fight over
  // the same real camera device/port, which is exactly the real bug
  // this was written to fix, caught live on this dev machine.
  reapOrphanedCameraProcesses();

  // Real cameras already configured before this server process started
  // (like every existing one in data/settings.json) get their own
  // stream serve process without needing a fresh settings save first.
  reconcileCameraProcesses(lastKnownSettings);

  // Every open WebSocket client (the browser UI itself, plus any remote
  // clients - HYDRA-UMC SUITE, the mobile control apps) - broadcastSettings()
  // pushes to all of them on every write, whichever path (REST POST or a
  // WS "settings" message, see the WebSocketServer setup below) produced
  // it. This is what makes "modify a running job from SUITE" actually
  // show up live in an already-open browser tab instead of only on that
  // tab's own next 500ms debounced re-fetch (which never happens today -
  // the browser client only fetches /api/settings once, on mount).
  // Serializes every write to settings.json (POST /api/settings, the
  // atomic POST /api/robot/:id/command, and the WS "settings" message all
  // target this same file) behind one promise chain, so two writes that
  // arrive close together always land on disk in the order they were
  // REQUESTED instead of whichever one's own fs.promises.writeFile()
  // happens to finish first - without this, two concurrent writers could
  // interleave at the OS level, or (more commonly) an earlier request's
  // write could simply finish AFTER a later one's and silently overwrite
  // it with stale data ("Last Write Wins" by completion time, not by
  // request time - the exact data-loss window this queue exists to
  // close). JSON.stringify happens HERE, synchronously, at enqueue time -
  // not lazily inside the queued callback - because /api/robot/:id/command
  // passes the shared, in-place-mutated `lastKnownSettings` object; if the
  // snapshot were taken lazily it could pick up a LATER request's
  // mutations by the time this write actually runs. This only fixes the
  // low-level disk I/O race between concurrent writers on THIS server; it
  // intentionally does not attempt to merge or diff two independent edits
  // made from stale reads (see docs/REMOTE_API.md section 2c's own note
  // on that separate, higher-level, protocol-level race - closing that
  // one would need a real merge/patch contract coordinated with every
  // client, not a server-only change).
  let settingsWriteQueue: Promise<void> = Promise.resolve();
  // Splits `payload` (the full in-memory settings shape, recordedPoints
  // inline - same object every caller already built before this split
  // existed) into settings.json (everything else) plus one
  // points/<controllerId>/<robotId>.json per robot (see getPointsPath's
  // own header comment for why: isolating the one field that can
  // legitimately grow to several MB, or balloon from a client-side bug,
  // into its own file whose size/mtime immediately points at the culprit
  // robot). Every snapshot
  // (JSON.stringify) happens HERE, synchronously, at enqueue time - not
  // lazily inside the queued callback - for the exact same reason this
  // function always took that care for its one JSON.stringify:
  // /api/robot/:id/command passes the shared, in-place-mutated
  // `lastKnownSettings` object; if any of these snapshots were taken
  // lazily they could pick up a LATER request's mutations by the time
  // this write actually runs.
  function queueSettingsWrite(payload: any): Promise<void> {
    const controllers = Array.isArray(payload?.controllers) ? payload.controllers : [];
    const coreJson = JSON.stringify(
      {
        ...payload,
        controllers: controllers.map((c: any) => ({
          ...c,
          robots: Array.isArray(c.robots)
            ? c.robots.map((r: any) => {
                const { recordedPoints, ...rest } = r;
                return rest;
              })
            : c.robots,
        })),
      },
      null,
      2
    );
    const pointsWrites: { path: string; json: string }[] = [];
    for (const c of controllers) {
      for (const r of Array.isArray(c.robots) ? c.robots : []) {
        if (Array.isArray(r.recordedPoints)) {
          pointsWrites.push({ path: getPointsPath(c.id, r.id), json: JSON.stringify(r.recordedPoints) });
        }
      }
    }
    const result = settingsWriteQueue.then(async () => {
      // Wraps every file this call writes (not the snapshotting above, and
      // not the queue-wait time before this callback runs) - src/metrics.ts's
      // own hydra_settings_write_duration_seconds histogram, exposed on
      // GET /metrics. stopTimer() always runs (finally), so a failed write
      // still gets observed rather than silently skewing the histogram
      // toward only-successful, artificially-fast samples.
      const stopTimer = settingsWriteDuration.startTimer();
      try {
        await writeFileAtomic(getSettingsPath(), coreJson);
        for (const w of pointsWrites) {
          await writeFileAtomic(w.path, w.json);
        }
      } finally {
        stopTimer();
      }
    });
    // Keep the queue moving even if this particular write fails - an
    // unhandled rejection here would otherwise permanently wedge every
    // write queued after it. The caller of THIS write still observes its
    // own failure via the `result` promise returned below.
    settingsWriteQueue = result.then(() => undefined, () => undefined);
    return result;
  }

  const wsClients = new Set<WebSocket>();
  // src/metrics.ts's own hydra_ws_clients_connected gauge reads this lazily
  // on every /metrics scrape via this getter - wsClients only exists inside
  // startServer(), so this is registered here rather than at module load
  // (compare setSystemMetricsSource(getSystemMetrics) above, which doesn't
  // need to wait for anything).
  setWsClientsSource(() => wsClients.size);
  function broadcastSettings(payload: any, deltaOnly: boolean = false, originator?: WebSocket) {
    lastKnownSettings = payload;
    const type = deltaOnly ? "delta" : "settings";
    // schema: 1 = today's actual behavior ("delta" is still a full-tree
    // payload, just like "settings"). Purely additive: every client today
    // already ignores unknown fields on this message, so shipping this
    // alone changes nothing for anyone - it only gives a future
    // server/client pair a version to negotiate against before "delta"
    // ever means a real partial patch.
    const msg = JSON.stringify({ type, payload, schema: 1 });
    for (const client of wsClients) {
      if (client !== originator && client.readyState === WebSocket.OPEN) {
        client.send(msg);
      }
    }
    const newServerName = realSettings(payload)?.serverName;
    if (newServerName) setupDiscovery(newServerName);
  }

  /**
   * Real targeted delta broadcast for a write that already went through
   * POST /api/robot/:id/command's own validated switch/case (see that
   * route's own comment on `deltas` below - a delta is only ever built
   * FROM a validated write, never from a generic before/after diff of
   * the tree). `deltas` is one entry per
   * affected robot (self + combinedWith) for this single command.
   *
   * Per connection: a client that declared schema 2 on its /ws query
   * string (see the `?remoteApiVersion=` handling above) gets the real
   * small `patch` payload, one message per affected robot. Every other
   * client (schema 1 - every client deployed before this change, since
   * none of them send that query param yet) gets exactly what it got
   * before this function existed: the full tree under `type: "delta"`,
   * `schema: 1`. Both branches run in the same loop so the two client
   * populations never see a different final state, only a different wire
   * size to get there.
   */
  function broadcastRobotDelta(
    deltas: { controllerId: string; robotId: number; patch: Record<string, unknown>; cameraId?: number; cameraPatch?: Record<string, unknown> }[],
    fullPayload: any
  ) {
    lastKnownSettings = fullPayload;
    const fullMsg = JSON.stringify({ type: "delta", schema: 1, payload: fullPayload });
    for (const client of wsClients) {
      if (client.readyState !== WebSocket.OPEN) continue;
      if ((client as any).schema >= 2) {
        for (const d of deltas) {
          const msg: Record<string, unknown> = { type: "delta", schema: 2, controllerId: d.controllerId, robotId: d.robotId, patch: d.patch };
          if (d.cameraId !== undefined) {
            msg.cameraId = d.cameraId;
            msg.cameraPatch = d.cameraPatch;
          }
          client.send(JSON.stringify(msg));
        }
      } else {
        client.send(fullMsg);
      }
    }
  }

  // V0 server-authoritative playback engine: linear point-to-point replay
  // of a robot's own recordedPoints, straight from each point's OWN
  // stored j1..j6/pos (real values captured live at record time, not
  // re-derived) - deliberately NOT the full velocity/acceleration
  // interpolation curve HYDRA-UMC-STUDIO's own RobotDetail.tsx used to
  // render playback with (that client-side loop is now removed - it
  // rendered whatever this engine broadcasts instead, like every other
  // client already did), and deliberately not running any inverse
  // kinematics itself. Exists so play/pause/stop physically move a robot
  // from ANY client (Android, iOS, DSI, SUITE) without depending on some
  // STUDIO browser tab being open with that exact robot's panel mounted.
  //
  // The server is now the SINGLE source of truth for playback motion:
  // every client (STUDIO included, see RobotDetail.tsx's own
  // playRobotTrajectory comment) only ever renders robot.pos/joints as
  // they arrive over the WebSocket, never drives them locally - avoiding
  // two writers (this engine and a browser tab's own loop) racing to set
  // the same robot's position, which would be a real problem on physical
  // hardware, not just a UI glitch.
  const playbackTimers = new Map<number, NodeJS.Timeout>();
  const PLAYBACK_BASE_INTERVAL_MS = 600;

  function findRobotById(robotId: number): any {
    let found: any = null;
    lastKnownSettings.controllers?.forEach((c: any) => {
      const r = c.robots?.find((r: any) => r.id === robotId);
      if (r) found = r;
    });
    return found;
  }

  function findControllerIdForRobot(robotId: number): string | null {
    let found: string | null = null;
    lastKnownSettings.controllers?.forEach((c: any) => {
      if (c.robots?.some((r: any) => r.id === robotId)) found = c.id;
    });
    return found;
  }

  // P06: command ownership. A real, TTL-bounded claim is embedded
  // directly on the robot object (`robot.reservation`) rather than a
  // separate Map, so it round-trips through the SAME persistence
  // (queueSettingsWrite) and broadcast (broadcastRobotDelta/
  // broadcastSettings) machinery every other robot field already uses,
  // instead of needing its own parallel wiring. Identity is per-ACCOUNT
  // (req.user.id), the only identity this server has - two tabs/devices
  // logged in as the same account share one claim, by design, since
  // there is no per-session/per-tab id anywhere else in this codebase to
  // key a finer-grained lock on.
  const DEFAULT_RESERVATION_TTL_MS = 5 * 60 * 1000;
  const MAX_RESERVATION_TTL_MS = 30 * 60 * 1000;

  function isReservationActive(reservation: any): boolean {
    return !!reservation && typeof reservation.expiresAt === "number" && reservation.expiresAt > Date.now();
  }

  // `robot.reservation` itself only ever held the CURRENT state -
  // overwritten by every claim/release with no trace of who changed it,
  // when, or why. reservationHistory is a real, bounded (last
  // RESERVATION_HISTORY_MAX_ENTRIES) append-only log living on the same
  // robot object, so it round-trips through the exact same persistence/
  // broadcast machinery `reservation` already does - no separate
  // endpoint or storage needed to read it back.
  const RESERVATION_HISTORY_MAX_ENTRIES = 20;

  function appendReservationHistory(
    robot: any,
    action: "claimed" | "renewed" | "force-claimed" | "released" | "force-released" | "expired",
    byUserId: unknown,
    byUsername: unknown,
    reason?: string,
  ) {
    if (!Array.isArray(robot.reservationHistory)) robot.reservationHistory = [];
    robot.reservationHistory.push({
      at: Date.now(),
      action,
      byUserId,
      byUsername,
      ...(reason ? { reason } : {}),
    });
    if (robot.reservationHistory.length > RESERVATION_HISTORY_MAX_ENTRIES) {
      robot.reservationHistory.splice(0, robot.reservationHistory.length - RESERVATION_HISTORY_MAX_ENTRIES);
    }
  }

  function stopServerPlayback(robotId: number) {
    const timer = playbackTimers.get(robotId);
    if (timer) {
      clearInterval(timer);
      playbackTimers.delete(robotId);
    }
  }

  // Called right after the 'play' case above sets robot.playbackState -
  // NOT from inside that forEach's own patch (this needs its own tick
  // loop, not a one-shot patch), but for the SAME robot.id each iteration
  // already covers - so calling this per-robot inside that same forEach
  // (self + every combinedWith sibling) is exactly the right fan-out,
  // reusing affectedIds's own existing combined-group handling rather
  // than duplicating it here.
  function startServerPlayback(robotId: number) {
    stopServerPlayback(robotId); // clean restart if a play was already running

    const robot = findRobotById(robotId);
    const controllerId = findControllerIdForRobot(robotId);
    if (!robot || !controllerId) return;

    if (!Array.isArray(robot.recordedPoints) || robot.recordedPoints.length === 0) {
      // Nothing to play - reflect that immediately instead of leaving
      // every client's UI on a "playing" state forever. Mutates the
      // EXISTING playbackState object's own fields rather than replacing
      // it with a new one (like every other case here does): the 'play'
      // case just above already captured `patch = { playbackState:
      // robot.playbackState }` as a reference to this same object before
      // calling this function, and the caller's own broadcastRobotDelta
      // still fires once, synchronously after this returns - a second,
      // separate broadcast from here (with a replaced object `patch`
      // would no longer even point at) would race it and could arrive in
      // either order.
      robot.playbackState.isPlaying = false;
      robot.playbackState.playing = false;
      robot.playbackState.activeStep = -1;
      return;
    }

    // Scales the same direction as STUDIO's own baseVelocity (higher
    // speed% = shorter interval = faster playback) without attempting
    // its real acceleration curve - a fixed per-point interval only.
    const speed = Number(robot.playbackState?.speed) || 100;
    const intervalMs = Math.max(50, PLAYBACK_BASE_INTERVAL_MS * (100 / speed));

    const timer = setInterval(() => {
      const r = findRobotById(robotId);
      const cId = findControllerIdForRobot(robotId);
      if (!r || !cId) {
        stopServerPlayback(robotId);
        return;
      }

      const pb = r.playbackState || {};
      if (!pb.isPlaying || pb.requestStop) {
        stopServerPlayback(robotId);
        return;
      }
      if (pb.isPaused || pb.requestPause) return; // keep the timer alive, just don't advance this tick

      const step = typeof pb.activeStep === "number" && pb.activeStep >= 0 ? pb.activeStep : 0;
      const points = r.recordedPoints;
      if (!Array.isArray(points) || step >= points.length) {
        if (pb.isLooping && Array.isArray(points) && points.length > 0) {
          // Repeat is on: go around again instead of stopping. Only
          // activeStep resets - isPlaying stays true so the SAME timer
          // keeps ticking and drives the next lap without a fresh 'play'
          // command (which would also re-resolve intervalMs from a
          // possibly-stale speed% for no reason).
          r.playbackState = { ...pb, activeStep: 0 };
          queueSettingsWrite(lastKnownSettings);
          broadcastRobotDelta([{ controllerId: cId, robotId, patch: { playbackState: r.playbackState } }], lastKnownSettings);
          return;
        }
        // Natural completion - isFinished used to be set ONLY by a
        // browser client's own playback loop reaching the end (see
        // RobotDetail.tsx's own isFinished comment); this engine is now
        // an equally real source of that same natural-completion signal.
        r.playbackState = { ...pb, isPlaying: false, playing: false, isFinished: true, finished: true, activeStep: -1 };
        queueSettingsWrite(lastKnownSettings);
        broadcastRobotDelta([{ controllerId: cId, robotId, patch: { playbackState: r.playbackState } }], lastKnownSettings);
        stopServerPlayback(robotId);
        return;
      }

      const rawPoint = points[step];
      // Compact model-specific WORKS may store [j1, j2, j3] triplets. They
      // retain the robot's current wrist values and bypass generic IK.
      const pt = Array.isArray(rawPoint)
        ? { motionType: "model-joints", j1: rawPoint[0], j2: rawPoint[1], j3: rawPoint[2] }
        : rawPoint;
      const patch: Record<string, unknown> = {};
      if (typeof pt.j1 === "number") {
        r.joints = { ...r.joints, j1: pt.j1, j2: pt.j2, j3: pt.j3, j4: pt.j4 ?? r.joints?.j4, j5: pt.j5 ?? r.joints?.j5, j6: pt.j6 ?? r.joints?.j6 };
        patch.joints = r.joints;
      }
      if (typeof pt.x === "number") {
        r.pos = {
          ...r.pos,
          x: pt.x, y: pt.y, z: pt.z,
          a: pt.a ?? r.pos?.a, b: pt.b ?? r.pos?.b, c: pt.c ?? r.pos?.c,
        };
        patch.pos = r.pos;
      }
      // Keep table axes separate from the arm target. The table's full object
      // is sent in the delta because clients shallow-merge it; `{ pos }`
      // alone would erase tableSize and other configuration remotely.
      //
      // Real bug found live on STUDIO/CM5: a combined robot with NO real
      // table (hasXYTable: false) still keeps its own stale `xyTable`
      // config object around (turning the table off in the UI only ever
      // flips the boolean, never clears the object - see
      // XYTableConfig.tsx) - `r.xyTable?.pos` alone was truthy for it
      // too. `pos.tx`/`pos.ty` also does double duty on a table-less
      // combined robot as its own general world-placement in the 3D
      // scene (VirtualKinematics.tsx) - so a stale recorded tx/ty from
      // before the table was disabled silently relocated that robot's
      // WHOLE 3D model, exactly reproducing "moving the table-having
      // robot also visually moves the combined one". Gated on the
      // robot's own real `hasXYTable` now, matching the same real fix
      // already applied to the jog/reset "xytable" target cases below.
      if (r.hasXYTable && (typeof pt.tx === "number" || typeof pt.ty === "number" || typeof pt.trz === "number")) {
        if (r.xyTable?.pos) {
          r.xyTable = {
            ...r.xyTable,
            pos: {
              ...r.xyTable.pos,
              ...(typeof pt.tx === "number" ? { x: pt.tx } : {}),
              ...(typeof pt.ty === "number" ? { y: pt.ty } : {}),
            },
          };
          patch.xyTable = r.xyTable;
        }
        r.pos = {
          ...r.pos,
          ...(typeof pt.tx === "number" ? { tx: pt.tx } : {}),
          ...(typeof pt.ty === "number" ? { ty: pt.ty } : {}),
          ...(typeof pt.trz === "number" ? { trz: pt.trz } : {}),
        };
        patch.pos = r.pos;
      }
      r.playbackState = {
        ...pb,
        activeStep: step + 1,
        trajectoryMode: pt.motionType === "model-joints" ? "model-joints" : (typeof pt.x === "number" ? "cartesian" : "legacy-generic"),
      };
      patch.playbackState = r.playbackState;

      queueSettingsWrite(lastKnownSettings);
      broadcastRobotDelta([{ controllerId: cId, robotId, patch }], lastKnownSettings);
    }, intervalMs);

    playbackTimers.set(robotId, timer);
  }

  // Serve static data files (like WORKS/, and any custom worksPaths a
  // robot is configured to use, which can point anywhere under data/, not
  // just WORKS/) at the root level - but never
  // any file that holds credentials or otherwise-gated data. Block every
  // such file, not just settings.json/users.json (the original 2-entry
  // list left 2 more sensitive things in data/ silently reachable):
  //   - settings.json: controller IPs, CAN-OTA config, full per-robot state
  //   - users.json: password hashes
  //   - model_submissions.json: reading this directly bypasses the
  //     submissions.enabled gate that GET /api/models/:category/:slug/
  //     download itself enforces (see the route below)
  //   - logs/**: industrialLog() output - operational detail, not
  //     credentials, but not meant to be publicly readable either
  //   - points/**: each robot's own recordedPoints array, split out of
  //     settings.json into data/points/<controllerId>/<robotId>.json (see
  //     queueSettingsWrite's own header comment) - equally "full per-robot
  //     state" as settings.json itself, just filed separately now, so it
  //     needs the exact same blanket block settings.json always had rather
  //     than accidentally becoming newly, publicly static-servable just
  //     because it moved to its own directory.
  // Client code only ever fetches WORKS/*, never these directly.
  // Bare filenames (no leading slash) of the same 3 sensitive files, reused
  // below by POST /api/upload-work and POST /api/models/submit - both write
  // caller-controlled filenames to disk and need to refuse landing on one of
  // these regardless of which folder they resolve into.
  const RESERVED_DATA_FILENAMES = new Set(["settings.json", "users.json", "model_submissions.json", "refresh_tokens.json"]);
  app.use((req, res, next) => {
    // An exact-string check against `req.path` (Express's own
    // decoded/routing-normalized path) is NOT the same string
    // `express.static`/`send` below ultimately resolve to a real file
    // with - confirmed live against this exact block, all four of these
    // served the real settings.json despite failing the naive
    // string-equality check that used to run here: a single character
    // percent-encoded (`/%73ettings.json`), a doubled leading slash
    // (`//settings.json`), a case difference (`/Settings.json` - this
    // filesystem resolves it to the same file case-insensitively even
    // though the string comparison did not), and a literal or encoded
    // `.` segment (`/./settings.json`, `/%2e/settings.json`). Decode and
    // normalize the path the same way `send` itself does, then compare
    // only the real, lowercased basename and top-level segment - what
    // matters is which REAL file/directory this request resolves to,
    // not which of countless equivalent spellings of its URL asked for
    // it. A malformed percent-encoding is refused outright rather than
    // guessed at.
    let decoded: string;
    try {
      decoded = decodeURIComponent(req.path);
    } catch {
      res.status(400).end();
      return;
    }
    const normalized = path.posix.normalize(decoded).toLowerCase();
    const segments = normalized.split("/").filter(Boolean);
    const baseName = segments[segments.length - 1] ?? "";
    if (
      RESERVED_DATA_FILENAMES.has(baseName) ||
      segments[0] === "logs" ||
      segments[0] === "points"
    ) {
      res.status(404).end();
      return;
    }
    next();
  });
  app.use(express.static(dataPath));

  // HYDRA-UMC STUDIO's own built frontend (see this file's own header
  // comment) - populated by build-frontend.sh/.bat, gitignored, absent by
  // default on a fresh checkout. express.static() on a missing directory
  // is a harmless no-op (falls through to the next handler, never throws),
  // so this line is always safe to leave in place even on a deployment
  // that deliberately never runs build-frontend and stays headless. Placed
  // AFTER dataPath's own mount above so a WORKS/ file always wins a name
  // collision (extremely unlikely in practice - STUDIO's build output is
  // index.html + hashed asset filenames, nothing a user would ever name a
  // saved trajectory), and mounted at "/" like dataPath - express.static's
  // own default `index: 'index.html'` behavior means a plain
  // `GET /` (or `GET /?hideUI=true&robotId=1&token=...` - query strings
  // never affect path matching) resolves straight to STUDIO's index.html,
  // exactly what HYDRA-UMC-ANDROID-CONTROL/.../ThreeDScreen.kt (and the
  // iOS/DSI equivalents) already assume when they embed this same URL in
  // their own in-app 3D viewer WebView.
  const studioPublicPath = path.join(process.cwd(), "public");
  if (fs.existsSync(studioPublicPath)) {
    app.use(express.static(studioPublicPath));
    console.log(`[STARTUP] Serving HYDRA-UMC STUDIO frontend from ${studioPublicPath}`);
  } else {
    console.log("[STARTUP] No public/ directory - running headless (no frontend served at \"/\"). Run build-frontend.sh/.bat to enable it.");
  }

  // This server's OWN small admin panel (admin-ui/ - device list, log
  // viewer, server config, user management) - a deliberate, narrow
  // exception to "headless, no UI of its own" (see this file's own header
  // comment): unlike STUDIO's build above, admin-ui/ is source IN this
  // repo, not copied in from a sibling one. Served at /admin, gitignored
  // build output like STUDIO's - run build-frontend.sh/.bat (it builds
  // both) to populate public/admin/. Mounted at the /admin PREFIX (not
  // root, unlike the STUDIO mount above) so its own assets never collide
  // with STUDIO's identically-named ones (both are Vite builds, both
  // produce an index.html/assets/ at their own root) - admin-ui/vite.config.ts's
  // own `base: '/admin/'` is what makes its emitted asset URLs match this.
  const adminPublicPath = path.join(process.cwd(), "public", "admin");
  if (fs.existsSync(adminPublicPath)) {
    // admin-ui uses no client-side router (a handful of in-page tabs, same
    // as STUDIO), so there's no SPA-fallback route to add here -
    // express.static's own defaults already cover both cases that matter:
    // GET /admin/ serves index.html directly (its default `index:
    // 'index.html'` behavior), and GET /admin (no trailing slash) 301s to
    // /admin/ on its own (confirmed with a real request, not assumed).
    app.use("/admin", express.static(adminPublicPath));
    console.log(`[STARTUP] Serving HYDRA-UMC SERVER admin UI from ${adminPublicPath} (at /admin)`);
  } else {
    console.log("[STARTUP] No public/admin/ directory - admin UI not served. Run build-frontend.sh/.bat to enable it.");
  }

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
      return res.status(401).json({ error: "Invalid credentials" });
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
    const token = jwt.sign(
      { username: user.username, role: user.role, tokenVersion: effectiveTokenVersion(user), id: effectiveId(user) },
      JWT_SECRET,
      { expiresIn: JWT_EXPIRES_IN as any }
    );
    // Issued alongside the access token so a client can recover from
    // its own real time-based expiry (see refresh_tokens.ts's own header
    // comment) without forcing a manual re-login - a client that predates
    // this field simply never sends refreshToken to POST /api/refresh and
    // keeps today's forced-logout behavior, so this is purely additive.
    const refreshToken = issueRefreshToken(user);
    res.json({ success: true, token, refreshToken, role: user.role });
  }));

  // Exchanges a still-valid refresh token for a fresh access token,
  // without the caller's password - see refresh_tokens.ts's own
  // consumeRefreshToken() doc comment for exactly which cases this
  // succeeds vs. correctly still fails closed (a genuinely revoked
  // session, not just an expired access token, must still force a real
  // re-login). Not gated behind authenticate() - the whole point is
  // recovering from an access token that's already expired or otherwise
  // invalid - but shares loginRateLimiter with POST /api/login as the same
  // defense-in-depth against abuse, even though a refresh token itself is
  // an unguessable 32-byte random value, not a brute-forceable password.
  app.post("/api/refresh", loginRateLimiter, asyncHandler(async (req, res) => {
    const { refreshToken } = req.body || {};
    if (typeof refreshToken !== "string" || !refreshToken) {
      return res.status(400).json({ error: "refreshToken required" });
    }
    const result = consumeRefreshToken(refreshToken);
    if (!result.ok) {
      authFailuresTotal.inc({ reason: `refresh_${result.reason}` });
      return res.status(401).json({ error: "Invalid or expired refresh token" });
    }
    const token = jwt.sign(
      { username: result.user.username, role: result.user.role, tokenVersion: effectiveTokenVersion(result.user), id: effectiveId(result.user) },
      JWT_SECRET,
      { expiresIn: JWT_EXPIRES_IN as any }
    );
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
    if (typeof refreshToken === "string" && refreshToken) revokeRefreshToken(refreshToken);
    res.json({ success: true });
  }));

  // Account management - admin-only (requireAdmin, chained after
  // authenticate), backed by the users.ts module - lets an admin
  // rename/re-password their own account from Config > Users
  // instead of the account being permanently stuck as "admin"/"admin", and
  // create additional lower-privilege "operator" accounts for day-to-day
  // robot operation without exposing settings writes or user management.
  app.get("/api/users", authenticate, requireAdmin, (req, res) => {
    res.json({ users: listUsers() });
  });

  app.post("/api/users", authenticate, requireAdmin, asyncHandler(async (req, res) => {
    const { username, password, role } = req.body || {};
    const safeRole: UserRole = role === "operator" ? "operator" : "admin";
    if (typeof username !== "string" || typeof password !== "string") {
      return res.status(400).json({ error: "username and password required" });
    }
    const result = await createUser(username, password, safeRole);
    if (!result.ok) return res.status(400).json({ error: result.error });
    res.json({ success: true });
  }));

  app.put("/api/users/:username", authenticate, requireAdmin, asyncHandler(async (req, res) => {
    const { newUsername, password, role } = req.body || {};
    const safeRole: UserRole | undefined = role === "operator" || role === "admin" ? role : undefined;
    const result = await updateUser(req.params.username, { newUsername, password, role: safeRole });
    if (!result.ok) return res.status(400).json({ error: result.error });
    res.json({ success: true });
  }));

  app.delete("/api/users/:username", authenticate, requireAdmin, asyncHandler(async (req, res) => {
    // deleteUser() is now async (see users.ts's own
    // withUsersLock()) - awaited here like createUser/updateUser already
    // are, through the same asyncHandler() wrapper.
    const result = await deleteUser(req.params.username);
    if (!result.ok) return res.status(400).json({ error: result.error });
    res.json({ success: true });
  }));

  // Admin UI backend (see admin-ui/ - a small separate Vite/React app this
  // server optionally serves at /admin, same opt-in pattern as STUDIO's
  // own frontend at "/", see build-frontend.sh's own header comment).
  // Every route here is admin-only - this is server/fleet administration,
  // not robot control (that stays STUDIO-only).

  // "Connected devices" list - every currently-open WebSocket connection,
  // with the per-connection metadata attached at connect time (see
  // wss.on("connection", ...) above). Purely informational: this is NOT
  // the robot roster (that's controllers[].robots in /api/settings) - it's
  // literally "who/what has a live socket open to this server right now"
  // (STUDIO tabs, mobile apps, HYDRA-UMC SUITE, ...).
  app.get("/api/admin/clients", authenticate, requireAdmin, (req, res) => {
    const clients = Array.from(wsClients).map((ws: any) => ({
      ...ws.meta,
      connected: ws.readyState === WebSocket.OPEN,
    }));
    res.json({ clients });
  });

  // Tail of the real on-disk log file (LOG_FILE, industrialLog()'s own
  // target) - admin-only for the same reason the static-file guard above
  // (BLOCKED_STATIC_FILES / the /logs path block) already refuses to ever
  // serve this file as a plain static asset: operational logs can contain
  // IPs, usernames, and command payloads, not something to leave reachable
  // without authentication. `lines` caps how much is read/returned (default
  // 300) - this is a full-file read on every call (simple, and LOG_FILE
  // stays small enough in practice that this is fine), not a byte-range
  // seek from the end - fine for a periodically-polled admin log viewer,
  // not meant for tailing a truly enormous file.
  app.get("/api/admin/logs", authenticate, requireAdmin, (req, res) => {
    const requested = parseInt(String(req.query.lines || ""), 10);
    const limit = Number.isFinite(requested) && requested > 0 ? Math.min(requested, 2000) : 300;
    try {
      const raw = fs.readFileSync(LOG_FILE, "utf-8");
      const allLines = raw.split("\n").filter(Boolean);
      res.json({ lines: allLines.slice(-limit) });
    } catch {
      res.json({ lines: [] }); // No log file yet (fresh install) - empty, not an error
    }
  });

  // Server config (currently just the listen port - serverName already
  // lives in /api/settings, reused as-is by the admin UI's Config screen
  // rather than duplicated here). See resolvePort()'s own comment for why
  // a port change here needs a restart to take effect, and why that's the
  // correct behavior rather than a limitation to work around.
  app.get("/api/admin/server-config", authenticate, requireAdmin, (req, res) => {
    res.json({ port: currentPort, pendingPort: loadServerConfig().port ?? null });
  });

  app.put("/api/admin/server-config", authenticate, requireAdmin, (req, res) => {
    const { port } = req.body || {};
    if (port !== undefined && port !== null) {
      const portNum = Number(port);
      if (!Number.isInteger(portNum) || portNum < 1 || portNum > 65535) {
        return res.status(400).json({ error: "port must be an integer between 1 and 65535" });
      }
      saveServerConfig({ ...loadServerConfig(), port: portNum });
    }
    res.json({ success: true, appliesOnRestart: true });
  });

  // Graceful self-restart - only meaningful behind a process supervisor
  // that auto-restarts on exit (systemd Restart=always, pm2, Docker
  // --restart, the CM5 deployment this whole feature targets) - documented
  // as such in the admin UI itself rather than silently doing nothing
  // useful under `npm run dev`. Responds BEFORE exiting so the admin UI's
  // own fetch() doesn't see a connection-reset instead of a clean 200.
  app.post("/api/admin/restart", authenticate, requireAdmin, (req, res) => {
    res.json({ success: true });
    industrialLog("[ADMIN] Restart requested via admin UI - exiting for the process supervisor to restart.");
    setTimeout(() => process.exit(0), 250);
  });

  // API routes FIRST
  // This had no auth middleware at all - any unauthenticated
  // caller could GET the full settings object (controller IPs,
  // CAN-OTA config, complete per-robot state - see the comment on
  // RESERVED_DATA_FILENAMES above for exactly what this file holds),
  // confirmed live (200 with no Authorization header at all). `authenticate`
  // only (not `requireAdmin`, unlike the POST just below) - every logged-in
  // STUDIO operator legitimately reads this today, not only an admin;
  // writing it already correctly requires admin.
  app.get("/api/settings", authenticate, (req, res) => {
    try {
      res.json(loadFullSettingsFromDisk());
    } catch (e) {
      console.error("Error reading settings", e);
      res.status(500).json({ error: "Failed to read settings" });
    }
  });

  app.post("/api/settings", authenticate, requireAdmin, async (req, res) => {
    try {
      const payload = req.body;
      await applySettingsUpdate(payload);
      res.json({ success: true });
    } catch (e) {
      console.error("Error writing settings", e);
      res.status(500).json({ error: "Failed to save settings" });
    }
  });

  // Real spoken "status" text for the voice assistant's own status intent -
  // see this function's one real call site (POST /api/voice/turn) for why
  // this exists at all. Reuses the exact same real sources
  // GET /api/hydra-info (controller/robot counts) and
  // GET /api/watch/system-status (CPU/memory/uptime) already read from -
  // never a second, competing computation of either. `robotIdEntity`, when
  // present ("status of robot N"), is answered honestly from this Server's
  // own real registered-robot list - there is no real per-robot LIVE
  // telemetry available at this relay step yet, so this never fabricates
  // an online/offline claim for one, only whether it's actually registered.
  async function buildVoiceStatusText(entities: unknown): Promise<string> {
    const s = lastKnownSettings;
    const controllers = Array.isArray(s?.controllers) ? s.controllers : [];
    const controllerCount = controllers.length;
    const robotCount = controllers.reduce(
      (n: number, c: any) => n + (Array.isArray(c.robots) ? c.robots.length : 0),
      0,
    );
    const metrics = await getSystemMetrics();
    const summary = `${controllerCount} controller${controllerCount === 1 ? "" : "s"}, ` +
      `${robotCount} robot${robotCount === 1 ? "" : "s"} configured. ` +
      `CPU load ${metrics.cpu_load}%, memory ${metrics.memory_usage}%, uptime ${metrics.uptime}s.`;

    const robotIdRaw = entities && typeof entities === "object" ? (entities as Record<string, unknown>).robot_id : undefined;
    if (typeof robotIdRaw !== "string") return summary;
    const robotId = parseInt(robotIdRaw, 10);
    let found = false;
    for (const c of controllers) {
      if (Array.isArray(c.robots) && c.robots.some((r: any) => r.id === robotId)) {
        found = true;
        break;
      }
    }
    const robotNote = found
      ? `Robot ${robotId} is registered on this Server. `
      : `Robot ${robotId} is not registered on this Server. `;
    return robotNote + summary;
  }

  // Authenticated, non-actuating relay for a recognised voice turn. The
  // phone/watch presents its ordinary Server JWT; the Server alone holds the
  // local Voice UI token. This is intentionally REST rather than a robot
  // command route, and it never translates an intent into movement.
  app.post("/api/voice/turn", authenticate, async (req, res) => {
    // Real per-client gate (Config > Remote Access, remoteAccessAllowed()'s
    // own header comment above) - the paired phone sends
    // X-Hydra-Client: watch only for this relayed-on-the-Watch's-behalf
    // call, never for its own ordinary Android traffic, so disabling Watch
    // access here cannot also lock that same phone out of its own session.
    if (!remoteAccessAllowed(realSettings(lastKnownSettings), req.headers["x-hydra-client"] as string | undefined)) {
      return res.status(404).end();
    }
    const validationError = validateVoiceTurnPayload(req.body);
    if (validationError) return res.status(400).json({ error: validationError });
    if (!VOICE_UI_URL) {
      return res.status(503).json({ error: "HYDRA-UMC-VOICE-UI is not configured on this Server" });
    }

    const requestId = req.body.requestId as string;
    try {
      const upstream = await fetch(`${VOICE_UI_URL}/v1/voice/turn`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(VOICE_UI_TOKEN ? { authorization: `Bearer ${VOICE_UI_TOKEN}` } : {}),
        },
        body: JSON.stringify(req.body),
        signal: AbortSignal.timeout(VOICE_UI_TIMEOUT_MS),
      });
      const reply = await upstream.json().catch(() => null);
      if (!upstream.ok) {
        console.warn(`[VOICE] gateway rejected requestId=${requestId} status=${upstream.status}`);
        return res.status(502).json({ error: "HYDRA-UMC-VOICE-UI rejected the voice turn" });
      }
      if (!isAssistantReplyForRequest(reply, requestId)) {
        console.error(`[VOICE] gateway contract failure requestId=${requestId}`);
        return res.status(502).json({ error: "HYDRA-UMC-VOICE-UI returned an invalid assistant reply" });
      }
      // Real gap found live: HYDRA-UMC-VOICE-UI's own gateway.py is a
      // deliberately pure/stateless intent classifier (its own docstring:
      // "an authenticated Server ... integration can replace the response
      // policy without changing the wire shape") - a real "status" turn
      // came back as a canned "Live telemetry will be supplied by the
      // authenticated HYDRA-UMC gateway" placeholder, never actual data,
      // because nothing ever supplied it. This Server already has the
      // real data (the same getSystemMetrics()/lastKnownSettings.controllers
      // GET /api/watch/system-status and GET /api/hydra-info themselves
      // read from) and already owns this relay step - the natural, real
      // place to fill that promise in, without VOICE-UI ever needing
      // outbound network access of its own.
      if (reply.intent && (reply.intent as any).name === "status") {
        reply.text = await buildVoiceStatusText((reply.intent as any).entities);
      }
      // Do not log the transcript or reply text: both can contain operator
      // information. The correlation ID and safety fields are sufficient for
      // operational diagnosis.
      industrialLog(`[VOICE] requestId=${requestId} level=${reply.level} confirmation=${reply.requiresConfirmation}`);
      res.set("Cache-Control", "no-store").json(reply);
    } catch (error) {
      const timedOut = error instanceof DOMException && error.name === "TimeoutError";
      console.error(`[VOICE] gateway unavailable requestId=${requestId} reason=${timedOut ? "timeout" : "connection"}`);
      res.status(503).json({ error: timedOut ? "HYDRA-UMC-VOICE-UI timed out" : "HYDRA-UMC-VOICE-UI is unavailable" });
    }
  });

  // Small, authenticated status payload shared by phone/watch surfaces. It
  // exposes health only, never full settings, usernames or machine paths.
  app.get("/api/watch/system-status", authenticate, async (req, res) => {
    // Same real per-client gate as POST /api/voice/turn above - see that
    // route's own comment.
    if (!remoteAccessAllowed(realSettings(lastKnownSettings), req.headers["x-hydra-client"] as string | undefined)) {
      return res.status(404).end();
    }
    const metrics = await getSystemMetrics();
    const level = metrics.temp_is_real && (metrics.temp ?? 0) >= 80
      ? "CRITICAL"
      : metrics.temp_is_real && (metrics.temp ?? 0) >= 70
        ? "WARNING"
        : "NOMINAL";
    res.set("Cache-Control", "no-store").json({
      type: "system_status",
      headline: level === "NOMINAL" ? "HYDRA-UMC Server online" : "HYDRA-UMC Server temperature warning",
      detail: `CPU load ${metrics.cpu_load} · memory ${metrics.memory_usage}% · uptime ${metrics.uptime}s`,
      level,
      speak: level !== "NOMINAL",
    });
  });

  registerCommandRoutes(app, {
    authenticate,
    getSettings: () => lastKnownSettings,
    industrialLog,
    isReservationActive,
    queueSettingsWrite,
    broadcastRobotDelta,
    startServerPlayback,
    stopServerPlayback,
  });

  registerRobotRoutes(app, {
    authenticate,
    getSettings: () => lastKnownSettings,
    findRobotById,
    findControllerIdForRobot,
    isReservationActive,
    appendReservationHistory,
    queueSettingsWrite,
    broadcastRobotDelta,
    DEFAULT_RESERVATION_TTL_MS,
    MAX_RESERVATION_TTL_MS,
  });

  registerCameraRoutes(app, { authenticate, requireAdmin, dataPath, resolveWithinDataDir, cameraProcesses });

  // Real proxy to this cell's own local Hailo-accelerated AI services -
  // each one already runs as its own real systemd unit
  // (hydra-umc-<service>.service), bound to 127.0.0.1 only by design
  // (same loopback-only posture DATALAKE/ANOMALY-DETECTOR already use),
  // so nothing outside this host could ever reach them directly. Before
  // this route, that was true even for a legitimate development/control
  // machine on the same LAN or over the same remote-access path already
  // used for everything else this server exposes - there was no real
  // path in, at all, to a service's own real endpoints (only
  // /api/ecosystem/status's generic start/stop/health check, which
  // never relays an actual request). Real passthrough, not a
  // reimplementation: the upstream's own path, method, query string,
  // JSON body and status code all pass through unchanged, so this
  // route's own behavior can never drift from what each service's own
  // api.py actually does. Every one of these still honestly reports
  // "not ready" for real inference until a Hailo module and a loaded
  // model exist - this only carries that answer through the network,
  // it doesn't change it.
  const LOCAL_AI_SERVICE_PORTS: Record<string, number> = {
    "cognitive-node": 8096,
    "detection-hef": 8093,
    "visual-servoing-api": 8091,
    "vla-engine": 8098,
  };

  app.all("/api/ai/:service/*rest", authenticate, async (req, res) => {
    const port = LOCAL_AI_SERVICE_PORTS[req.params.service];
    if (port === undefined) {
      return res.status(404).json({
        error: `Unknown local AI service '${req.params.service}' - known services: ${Object.keys(LOCAL_AI_SERVICE_PORTS).join(", ")}`,
      });
    }
    const restSegments = req.params.rest;
    const upstreamPath = "/" + (Array.isArray(restSegments) ? restSegments.join("/") : String(restSegments ?? ""));
    const queryString = req.url.includes("?") ? req.url.slice(req.url.indexOf("?")) : "";
    const url = `http://127.0.0.1:${port}${upstreamPath}${queryString}`;

    const hasBody = !["GET", "HEAD"].includes(req.method);
    const controller = new AbortController();
    const connectTimeout = setTimeout(() => controller.abort(), 10000);
    let upstream: Response;
    try {
      upstream = await fetch(url, {
        method: req.method,
        headers: hasBody ? { "Content-Type": "application/json" } : undefined,
        body: hasBody ? JSON.stringify(req.body ?? {}) : undefined,
        signal: controller.signal,
      });
    } catch {
      return res.status(503).json({
        error: `Local AI service '${req.params.service}' is not reachable on 127.0.0.1:${port} - is hydra-umc-${req.params.service}.service running?`,
        available: false,
      });
    } finally {
      clearTimeout(connectTimeout);
    }
    const text = await upstream.text();
    res.status(upstream.status);
    res.setHeader("Content-Type", upstream.headers.get("content-type") || "application/json");
    res.send(text);
  });

  registerSystemRoutes(app, { authenticate, requireAdmin, industrialLog });

  registerBluetoothRoutes(app, { authenticate, requireAdmin, industrialLog });

  registerUpstreamRoutes(app, {
    authenticate, requireAdmin, industrialLog, wsClients, DATALAKE_URL, DATALAKE_TIMEOUT_MS, CONNECTOR_HUB_URL,
    CONNECTOR_HUB_TIMEOUT_MS, SPI_BRIDGE_URL, SPI_BRIDGE_VERSION_TIMEOUT_MS, SPI_BRIDGE_FLASH_TIMEOUT_MS,
  });

  // Prometheus scrape endpoint - text exposition format via `prom-client`
  // (src/metrics.ts owns every metric definition; this route only renders
  // the registry). Deliberately unauthenticated, same posture as GET
  // /api/system/metrics right above and the wide-open cors() at the top of
  // this file: this is a LAN industrial controller, and a Prometheus
  // scrape config is one more trusted-LAN caller, not a public one. If this
  // server is ever exposed beyond a fully trusted LAN, put it behind the
  // same reverse-proxy/network boundary you'd already need for the rest of
  // this API (see README.md's own security notes) rather than gating it
  // with the bearer-token scheme every other write route uses - Prometheus
  // itself supports a bearer_token in its scrape config if that's ever
  // wanted, but nothing here requires it today.
  app.get("/metrics", async (req, res) => {
    try {
      res.set("Content-Type", metricsRegistry.contentType);
      res.end(await metricsRegistry.metrics());
    } catch (e) {
      console.error("Error collecting Prometheus metrics", e);
      res.status(500).end("Error collecting metrics");
    }
  });

  // Discovery/identity endpoint - what a remote client (HYDRA-UMC SUITE
  // scanning a subnet for controllers, or one of the mobile control apps)
  // hits first to confirm a given host/IP is actually running HYDRA-UMC
  // STUDIO before trying to talk the real API to it. Deliberately cheap
  // (no settings.json read) so a swarm scan across many IPs stays fast -
  // robot/controller counts come from the same in-memory cache the
  // WebSocket broadcast path already maintains, not a fresh disk read
  // per request.
  app.get("/api/hydra-info", (req, res) => {
    // Real enable/disable gate (Config > Remote Access in the browser UI,
    // src/store.tsx's own SystemSettings.remoteAccess) - per-client (see
    // remoteAccessAllowed()'s own header comment above for
    // the X-Hydra-Client header each real client sends). When disabled for
    // that client, this endpoint responds 404 - the same as a plain "not
    // running HYDRA-UMC STUDIO" host looks like to a scanning client (each
    // client's own discovery code already treats a non-200 as "not
    // found", no client-side change needed beyond sending the header) -
    // the server becomes undiscoverable/unidentifiable to THAT app's own
    // scan, without touching GET/POST /api/settings or /ws (this SAME
    // browser tab's own connection to its own server also goes through
    // those, so gating them would break the core web UI, not just remote
    // apps - see that settings field's own comment in store.tsx).
    if (!remoteAccessAllowed(realSettings(lastKnownSettings), req.headers["x-hydra-client"] as string | undefined)) {
      res.status(404).end();
      return;
    }
    const s = lastKnownSettings;
    res.json({
      schema_version: "1.0",
      product: realSettings(lastKnownSettings)?.serverName || "HYDRA-UMC STUDIO",
      remoteApiVersion: REMOTE_API_VERSION,
      appVersion: pkgVersion,
      hostname: os.hostname(),
      controllerCount: Array.isArray(s?.controllers) ? s.controllers.length : 0,
      robotCount: Array.isArray(s?.controllers)
        ? s.controllers.reduce((n: number, c: any) => n + (Array.isArray(c.robots) ? c.robots.length : 0), 0)
        : 0,
      uptimeSeconds: Math.round(process.uptime()),
    });
  });

  // Real, deliberately UNauthenticated power controls for THIS device's own
  // kiosk (HYDRA-UMC-OS's install_kiosk.sh) - the shutdown/restart buttons
  // on STUDIO's own pre-login screen (AuthGate.tsx) have to work before an
  // operator standing at the physical touchscreen has logged in at all, the
  // same way a real power button would. Safe specifically because they are
  // gated to loopback callers only: this server's own HTTP listener binds
  // 0.0.0.0 (STUDIO/mobile apps need real LAN reach), so without a loopback
  // check the exact same unauthenticated request from any other device on
  // the network could power off the robot controller. The kiosk's own
  // Chromium runs ON this device (see kiosk-session.sh), so its requests
  // genuinely originate from 127.0.0.1/::1 - nothing else on the LAN can
  // spoof req.socket.remoteAddress.
  function requireLoopbackCaller(req: express.Request, res: express.Response): boolean {
    const addr = req.socket.remoteAddress || "";
    if (addr === "127.0.0.1" || addr === "::1" || addr === "::ffff:127.0.0.1") return true;
    res.status(403).json({ error: "This endpoint only accepts requests from this device itself." });
    return false;
  }

  // Responds BEFORE actually executing systemctl: once reboot/poweroff
  // really runs, this process (and the TCP connection carrying the
  // response) can be torn down mid-flight, and a client that never sees a
  // response would show its own confusing network-error state instead of
  // "it's shutting down". Requires the polkit rule
  // HYDRA-UMC-OS/provisioning/polkit/49-hydra-umc-server-power.rules -
  // this service otherwise runs as the unprivileged hydra-umc-server user
  // (NoNewPrivileges, see its own systemd unit) and could not reboot/power
  // off the host on its own.
  async function runPowerAction(action: "reboot" | "poweroff", res: express.Response) {
    res.json({ success: true });
    try {
      await execFileAsync("systemctl", [action]);
    } catch (error) {
      // The response above already went out - this can only ever reach the
      // server's own log now, never a second HTTP response.
      console.error(`[POWER] systemctl ${action} failed:`, error);
    }
  }

  app.post("/api/system/reboot", (req, res) => {
    if (!requireLoopbackCaller(req, res)) return;
    void runPowerAction("reboot", res);
  });

  app.post("/api/system/shutdown", (req, res) => {
    if (!requireLoopbackCaller(req, res)) return;
    void runPowerAction("poweroff", res);
  });

  // authenticate (not requireAdmin): saving/loading a robot's own
  // trajectory files is an operational action, same tier as POST
  // /api/robot/:id/command below - it writes to disk so it must not be
  // reachable by a fully anonymous caller, but an "operator" account
  // shouldn't need admin rights just to save a work file. This route was
  // previously missing ANY auth check at all (every other disk-writing
  // route in this file requires at least authenticate) - see
  // src/components/AuthGate.tsx's own header comment, which already
  // enumerated POST /api/settings and POST /api/robot/:id/command as the
  // writes gated behind login and never mentioned this one.
  app.post("/api/upload-work", authenticate, (req, res) => {
    try {
      const { folderPath, fileName, content } = req.body || {};
      if (typeof folderPath !== "string" || typeof fileName !== "string") {
        return res.status(400).json({ error: "folderPath and fileName required" });
      }

      // Sanitize folderPath to prevent Path Traversal
      const sanitizedFolderPath = folderPath.replace(/\.\./g, "");
      const absoluteFolderPath = path.resolve(dataPath, sanitizedFolderPath);

      if (!absoluteFolderPath.startsWith(dataPath)) {
        return res.status(403).json({ error: "Access denied: Path traversal detected" });
      }

      // fileName only ever needed the SAME guard folderPath gets above, but
      // never got it - it was joined into the write path as-is, so a value
      // like "../../../../etc/cron.d/evil" would walk the write target back
      // out of absoluteFolderPath (already validated to sit inside dataPath)
      // and out of dataPath entirely, the exact path-traversal risk the
      // folderPath check exists to stop. path.basename() strips any
      // directory component - "../x", "/etc/passwd", and embedded
      // separators all collapse to a bare filename that can only land
      // inside the already-validated folder.
      const safeFileName = path.basename(fileName);
      if (!safeFileName || safeFileName === "." || safeFileName === "..") {
        return res.status(400).json({ error: "Invalid file name" });
      }

      // Audit #016: the folderPath guard above stops ".." from escaping
      // dataPath, but folderPath is caller-controlled and can legitimately
      // resolve to dataPath's OWN root (folderPath: "" or "."), which
      // startsWith(dataPath) allows (dataPath starts with itself). An
      // authenticate()-only route (this one is intentionally NOT
      // requireAdmin - see the comment above this route - an "operator"
      // account can reach it) combined with fileName: "users.json" would
      // then write straight over the real data/users.json (password
      // hashes) or data/settings.json - turning "save a work file" into a
      // privilege-escalation primitive for an operator account. Not a "../"
      // traversal in the classic sense (absoluteFolderPath genuinely never
      // leaves dataPath), which is why the existing traversal check alone
      // didn't catch it. Blocking the 3 reserved filenames regardless of
      // which folder they'd land in closes this without restricting the
      // legitimate use case (arbitrary folderPath values under dataPath,
      // including settings.worksPaths).
      if (RESERVED_DATA_FILENAMES.has(safeFileName.toLowerCase())) {
        return res.status(403).json({ error: "Access denied: reserved file name" });
      }

      if (!fs.existsSync(absoluteFolderPath)) {
        fs.mkdirSync(absoluteFolderPath, { recursive: true });
      }

      const filePath = path.join(absoluteFolderPath, safeFileName);
      fs.writeFileSync(filePath, JSON.stringify(content, null, 2));

      // update index.json
      const indexPath = path.join(absoluteFolderPath, "index.json");
      let index: string[] = [];
      if (fs.existsSync(indexPath)) {
        index = JSON.parse(fs.readFileSync(indexPath, "utf-8"));
      }
      if (!index.includes(safeFileName)) {
        index.push(safeFileName);
        fs.writeFileSync(indexPath, JSON.stringify(index, null, 2));
      }

      res.json({ success: true });
    } catch (e: any) {
      console.error("Error uploading work", e);
      res.status(500).json({ error: e.message || "Error saving file" });
    }
  });

  // =========================================================================
  // Model submissions - the server side of HYDRA-UMC-EDITOR-URDF
  // (github.com/JuanenRac/HYDRA-UMC-EDITOR-URDF). That project
  // is a graphical URDF creator/editor meant to push a finished robot/
  // machine (3D meshes + kinematics) straight into this server's own
  // catalog instead of the manual "hand-add files to public/models/" pass
  // every robot in this ecosystem's own history got so far. Off by default
  // (settings.modelSubmissions.enabled) - an admin opts in from Config,
  // same gate philosophy as remoteAccess above: nothing lands on disk
  // just because a client asked.
  // =========================================================================
  const MODEL_SUBMISSIONS_INDEX_PATH = () => path.join(dataPath, "model_submissions.json");

  function readModelSubmissionsIndex(): any[] {
    try {
      const raw = fs.readFileSync(MODEL_SUBMISSIONS_INDEX_PATH(), "utf-8");
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  function writeModelSubmissionsIndex(entries: any[]): void {
    fs.writeFileSync(MODEL_SUBMISSIONS_INDEX_PATH(), JSON.stringify(entries, null, 2), "utf-8");
  }

  // slugify now lives in ./serverPolicy (see that module's own header
  // comment) - moved unchanged so it's directly unit-testable.

  // Same path-traversal guard POST /api/upload-work already applies above,
  // reused here for both the submission folder itself and every individual
  // mesh filename inside it (a malicious/malformed filename like
  // "../../../etc/passwd" must not escape the model's own folder either).
  function resolveWithinDataDir(...segments: string[]): string | null {
    const sanitized = segments.map(s => String(s).replace(/\.\./g, ""));
    const resolved = path.resolve(dataPath, ...sanitized);
    return resolved.startsWith(dataPath) ? resolved : null;
  }

  app.post("/api/models/submit", authenticate, requireAdmin, (req, res) => {
    try {
      const submissions = realSettings(lastKnownSettings)?.modelSubmissions;
      if (!submissions?.enabled) {
        return res.status(403).json({ error: "This server isn't accepting model submissions right now - enable it from Config > Models first." });
      }
      const { name, category, urdfFilename, urdfXml, meshFiles, overwrite } = req.body || {};
      if (typeof name !== "string" || !name.trim() || typeof category !== "string" || typeof urdfXml !== "string") {
        return res.status(400).json({ error: "name, category, and urdfXml are required" });
      }
      const slug = slugify(name);
      const destFolderRel = String(submissions.destinationFolder || "models/submitted");
      const destFolder = resolveWithinDataDir(destFolderRel, category, slug);
      if (!destFolder) {
        return res.status(403).json({ error: "Access denied: path traversal detected" });
      }

      const index = readModelSubmissionsIndex();
      const existing = index.find((e: any) => e.slug === slug && e.category === category);
      if (existing && !overwrite) {
        return res.status(409).json({ error: `A model named "${slug}" already exists in category "${category}" - resubmit with overwrite:true to replace it, or pick a different name.`, slug });
      }

      // Same class of bug as #016 above, found while fixing it: unlike
      // every mesh filename below (already routed through
      // resolveWithinDataDir's own dataPath-prefix check),
      // urdfFilename came straight from req.body and was joined onto
      // destFolder with no guard at all - a value like
      // "../../../../users.json" would walk the write target back out of
      // destFolder (and out of dataPath) via ordinary path.join()
      // normalization. This route is requireAdmin (unlike upload-work), so
      // the caller is already trusted, but there's no reason an admin
      // token should be able to write outside this model's own folder
      // just by naming its URDF file oddly - path.basename() strips any
      // directory component the same way upload-work's fileName already
      // does.
      const safeUrdfFilename = path.basename(String(urdfFilename || "")) || `${slug}.urdf`;
      fs.mkdirSync(destFolder, { recursive: true });
      fs.writeFileSync(path.join(destFolder, safeUrdfFilename), urdfXml, "utf-8");

      const meshDir = path.join(destFolder, "meshes");
      if (Array.isArray(meshFiles) && meshFiles.length > 0) {
        fs.mkdirSync(meshDir, { recursive: true });
        for (const mf of meshFiles) {
          if (!mf || typeof mf.filename !== "string" || typeof mf.base64 !== "string") continue;
          const meshPath = resolveWithinDataDir(destFolderRel, category, slug, "meshes", mf.filename);
          if (!meshPath) continue; // silently skip a traversal attempt in one file rather than aborting the whole submission
          fs.writeFileSync(meshPath, Buffer.from(mf.base64, "base64"));
        }
      }

      const entry = { slug, name: name.trim(), category, submittedAt: new Date().toISOString(), folder: path.relative(dataPath, destFolder).split(path.sep).join("/") };
      const nextIndex = existing ? index.map((e: any) => (e.slug === slug && e.category === category ? entry : e)) : [...index, entry];
      writeModelSubmissionsIndex(nextIndex);

      res.json({ success: true, slug });
    } catch (e: any) {
      console.error("Error accepting model submission", e);
      res.status(500).json({ error: e.message || "Error saving submitted model" });
    }
  });

  app.get("/api/models", (req, res) => {
    res.json({ models: readModelSubmissionsIndex() });
  });

  app.get("/api/models/:category/:slug/download", (req, res) => {
    const submissions = realSettings(lastKnownSettings)?.modelSubmissions;
    if (!submissions?.enabled) {
      return res.status(403).json({ error: "This server isn't accepting model submissions right now - enable it from Config > Models first." });
    }
    const { category, slug } = req.params;
    const index = readModelSubmissionsIndex();
    const entry = index.find((e: any) => e.slug === slug && e.category === category);
    if (!entry) {
      return res.status(404).json({ error: "No such submitted model" });
    }
    const folder = resolveWithinDataDir(entry.folder);
    if (!folder || !fs.existsSync(folder)) {
      return res.status(404).json({ error: "Submitted model is recorded in the index but its files are missing on disk" });
    }
    try {
      const files = fs.readdirSync(folder);
      const urdfFile = files.find(f => f.endsWith(".urdf"));
      const urdfXml = urdfFile ? fs.readFileSync(path.join(folder, urdfFile), "utf-8") : "";
      const meshDir = path.join(folder, "meshes");
      const meshFiles = fs.existsSync(meshDir)
        ? fs.readdirSync(meshDir).map(filename => ({ filename, base64: fs.readFileSync(path.join(meshDir, filename)).toString("base64") }))
        : [];
      res.json({ slug, name: entry.name, category, urdfFilename: urdfFile || "", urdfXml, meshFiles });
    } catch (e: any) {
      console.error("Error reading submitted model", e);
      res.status(500).json({ error: e.message || "Error reading submitted model" });
    }
  });

  // Wrapping express in a plain http.Server (instead of app.listen's own
  // implicit one) is what lets the WebSocketServer below share the same
  // port - a remote client only has to know one endpoint (host:3000) for
  // both the REST API and live sync, not a second port to discover/open
  // through a firewall separately.
  //
  // Optional TLS: set BOTH TLS_CERT_PATH and TLS_KEY_PATH to switch this
  // same shared listener to https.createServer() instead - WebSocketServer
  // attaches to whichever `server` it's given either way (the `ws` library
  // just listens for that server's own 'upgrade' event), so /ws
  // automatically becomes WSS the moment the underlying server is HTTPS;
  // no separate WSS setup needed. Only ONE of the two paths below ever
  // runs - default behavior (both unset -> plain HTTP, exactly as before
  // this change) is completely unchanged for every deployment that
  // doesn't opt in. A cert/key path that IS set but unreadable/invalid
  // fails startup loudly instead of silently falling back to plain HTTP -
  // a deployer who explicitly asked for TLS and typo'd a path should see
  // a startup crash with the real fs error, not an industrial controller
  // that quietly serves robot control over plaintext HTTP while believing
  // it's on TLS. See README.md's own "TLS / HTTPS" section for how to get
  // a cert (Let's Encrypt with a real domain, or self-signed for testing).
  const TLS_CERT_PATH = process.env.TLS_CERT_PATH;
  const TLS_KEY_PATH = process.env.TLS_KEY_PATH;
  const tlsEnabled = !!(TLS_CERT_PATH && TLS_KEY_PATH);
  const httpServer: http.Server = tlsEnabled
    ? https.createServer(
        { cert: fs.readFileSync(TLS_CERT_PATH!), key: fs.readFileSync(TLS_KEY_PATH!) },
        app
      ) as unknown as http.Server
    : http.createServer(app);
  if (tlsEnabled) {
    console.log(`[TLS] HTTPS/WSS enabled - cert: ${TLS_CERT_PATH}, key: ${TLS_KEY_PATH}`);
  }
  const wss = new WebSocketServer({ server: httpServer, path: "/ws" });

  wss.on("connection", (ws, req) => {
    // Extract token from query string (?token=...)
    const url = new URL(req.url || "", "http://localhost");
    const token = url.searchParams.get("token");

    if (!token) {
      authFailuresTotal.inc({ reason: "ws_no_token" });
      ws.send(JSON.stringify({ error: "Access denied: No token provided" }));
      setTimeout(() => ws.close(1008, "Access denied: No token provided"), 100);
      return;
    }

    // Same explicit HS256 pin as authenticate()'s own jwt.verify() above -
    // see that call site's own comment for why.
    jwt.verify(token, JWT_SECRET, { algorithms: ["HS256"] }, (err: any, decoded: any) => {
      if (err) {
        authFailuresTotal.inc({ reason: "ws_token_invalid" });
        ws.send(JSON.stringify({ error: "Access denied: Invalid token" }));
        setTimeout(() => ws.close(1008, "Access denied: Invalid token"), 100);
        return;
      }

      // Same real re-check authenticate() runs for HTTP,
      // applied at WS connect time too - a signature-valid token whose
      // account was deleted, or whose tokenVersion has since moved on
      // (password/role changed), must not even open the connection.
      // (ws as any).tokenVersion is cached below so the heartbeat
      // interval can re-check this SAME connection periodically too,
      // without re-verifying the JWT signature on every tick.
      // Same real identity check authenticate() runs for HTTP -
      // see its own comment for why tokenVersion alone is not enough.
      const currentUser = findUser(decoded?.username || "");
      if (!currentUser || effectiveTokenVersion(currentUser) !== decoded?.tokenVersion || effectiveId(currentUser) !== decoded?.id) {
        authFailuresTotal.inc({ reason: "ws_session_revoked" });
        ws.send(JSON.stringify({ error: "Access denied: this session is no longer valid, please log in again" }));
        setTimeout(() => ws.close(1008, "Access denied: session revoked"), 100);
        return;
      }
      decoded.role = currentUser.role; // never trust the token's own stale role claim below

      wsClients.add(ws);
      // Schema this CLIENT declared it understands, via the same
      // ?remoteApiVersion= query param name GET /api/hydra-info reports
      // back (see REMOTE_API_VERSION's own comment above) - defaults to 1
      // (today's full-tree-under-"delta" behavior) for any connection that
      // doesn't send it, which is every client deployed before this change.
      // Read once at connect time, not re-checked per message - a client
      // that wants to change what it declares reconnects, same as any
      // other capability negotiated at handshake time.
      const declaredSchema = parseInt(url.searchParams.get("remoteApiVersion") || "1", 10);
      (ws as any).schema = declaredSchema >= 2 ? 2 : 1;
      // Per-connection metadata for the admin UI's "connected devices" list
      // (GET /api/admin/clients below) - nothing here is used for any
      // access-control decision (that's still decoded.role, checked at the
      // point each action happens, same as before this existed), purely
      // informational display data.
      (ws as any).meta = {
        username: decoded?.username || null,
        role: decoded?.role || null,
        remoteAddress: req.socket.remoteAddress || null,
        connectedAt: new Date().toISOString(),
        remoteApiVersion: (ws as any).schema,
      };
      // This connection's own claimed session generation,
      // re-checked against the account's CURRENT one on every heartbeat
      // tick below - a password/role change or account deletion that
      // happens WHILE this socket is open must still close it, not wait
      // for the client to reconnect on its own.
      (ws as any).authTokenVersion = decoded?.tokenVersion;
      // This connection's own claimed real identity, re-checked
      // against the account's CURRENT one on every heartbeat tick below,
      // same reasoning as authTokenVersion above.
      (ws as any).authUserId = decoded?.id;
      // Heartbeat state for this connection - see the
      // setInterval below for why this exists.
      (ws as any).isAlive = true;
      ws.on("pong", () => { (ws as any).isAlive = true; });
      // New connection immediately gets the current state, same shape as a
      // broadcast - a client (e.g. HYDRA-UMC SUITE, freshly connected to one
      // controller in a swarm) doesn't have to also do a separate REST GET
      // /api/settings just to get its first real payload.
      ws.send(JSON.stringify({ type: "settings", payload: lastKnownSettings }));

      ws.on("message", async (raw) => {
        try {
          const msg = JSON.parse(raw.toString());
          if (msg && msg.type === "settings" && msg.payload) {
            // This WS path is a second route to the exact
            // same full-tree overwrite the REST POST /api/settings performs,
            // and jwt.verify() above only checks
            // signature validity - not role - so without this check an
            // "operator" token could just open a WebSocket and send this
            // message to do the one thing requireAdmin exists to stop it
            // from doing over REST. Same admin-only rule, enforced here too.
            // A live lookup, not the connection's own
            // possibly-stale `decoded.role` from connect time - a
            // demotion takes effect on this very next message, not only
            // once the next heartbeat tick happens to close the socket.
            const liveUser = findUser(decoded?.username || "");
            if (!liveUser || liveUser.role !== "admin") {
              ws.send(JSON.stringify({ error: "Access denied: admin privileges required" }));
              return;
            }
            await applySettingsUpdate(msg.payload, ws); // Skip originator to avoid echo
          }
        } catch (e) {
          console.error("Malformed WebSocket message", e);
        }
      });

      ws.on("close", () => wsClients.delete(ws));
      ws.on("error", () => wsClients.delete(ws));
    });
  });

  // Application-level heartbeat: TCP alone doesn't notice a
  // client that vanished without a clean close (laptop went to sleep, Wi-Fi
  // dropped, phone app was killed) - that socket looks OPEN to `ws` and
  // stays in wsClients indefinitely, silently eating a slot in every
  // broadcastSettings() loop, until the OS's own TCP keepalive eventually
  // times out (minutes, and disabled/very long by default on most stacks).
  // Every open connection gets ping()'d on this interval; the `pong`
  // handler above marks it alive again. A connection that was already
  // marked not-alive when its next ping would fire never answered the
  // previous one in time, so it's a half-open socket - terminate() it
  // (skips the graceful close handshake, which a half-open socket can't
  // complete anyway) rather than waiting on TCP. unref() so this timer
  // alone never keeps the process running past a real shutdown signal.
  const HEARTBEAT_INTERVAL_MS = 30000;
  const heartbeatTimer = setInterval(() => {
    for (const ws of wsClients) {
      if ((ws as any).isAlive === false) {
        ws.terminate();
        wsClients.delete(ws);
        continue;
      }
      // The same real re-check as WS connect time, run again
      // on every heartbeat tick - a password/role change or account
      // deletion that happens WHILE this socket is already open closes
      // it here instead of leaving an already-revoked session connected
      // indefinitely until the client happens to reconnect on its own.
      const username = (ws as any).meta?.username;
      if (username) {
        const currentUser = findUser(username);
        // Same real identity check as WS connect time above.
        if (!currentUser || effectiveTokenVersion(currentUser) !== (ws as any).authTokenVersion || effectiveId(currentUser) !== (ws as any).authUserId) {
          authFailuresTotal.inc({ reason: "ws_session_revoked" });
          ws.close(1008, "Access denied: session revoked");
          wsClients.delete(ws);
          continue;
        }
      }
      (ws as any).isAlive = false;
      ws.ping();
    }
  }, HEARTBEAT_INTERVAL_MS);
  heartbeatTimer.unref();

  httpServer.listen(PORT, "0.0.0.0", () => {
    const serverName = realSettings(lastKnownSettings)?.serverName || "HYDRA-UMC STUDIO";
    setupDiscovery(serverName);
    industrialLog(`=================================================`);
    industrialLog(` HYDRA-UMC SERVER: ${serverName}`);
    industrialLog(` STATUS: Running on port ${PORT} (${tlsEnabled ? "HTTPS/WSS" : "HTTP/WS"})`);
    industrialLog(` DISCOVERY: Active (mDNS + ${tlsEnabled ? "HTTPS + WSS" : "HTTP + WS"})`);
    industrialLog(`=================================================`);
  });

  // Graceful shutdown: a
  // normal `systemctl stop`/`pm2 stop`/Ctrl-C sends SIGTERM/SIGINT, and
  // before this handler existed nothing here ever ran on that path - the
  // process just died mid-flight, leaving the mDNS record unpublished
  // only via its own TTL expiry (real, but not instant - other clients on
  // the LAN can keep resolving a server that's already gone for a
  // stretch) and the log WriteStream un-flushed. Can't do anything about
  // a hard crash/power loss (that's exactly what the TTL is FOR), but a
  // clean stop/restart - the common case - now un-advertises immediately.
  let shuttingDown = false;
  function gracefulShutdown(signal: string) {
    if (shuttingDown) return; // a second signal while already shutting down - don't double-run this
    shuttingDown = true;
    industrialLog(`[SHUTDOWN] ${signal} received - unpublishing mDNS and closing cleanly...`);
    try { bonjour.unpublishAll(() => bonjour.destroy()); } catch { /* best-effort */ }
    // Every real per-camera stream serve child process this server itself
    // launched - without this they survive this process exiting (real,
    // reproduced today: a stuck one had to be killed by hand from outside
    // this app entirely) and keep holding the real camera device open,
    // so a fresh server start can't reopen it either.
    for (const key of cameraProcesses.keys()) stopCameraProcess(key);
    logStream.end();
    httpServer.close(() => process.exit(0));
    // httpServer.close() waits for in-flight HTTP requests but not for
    // open WebSocket connections (they aren't tracked by Node's own HTTP
    // Server.close()) - force-exit after a short grace period so a
    // shutdown never hangs indefinitely on a client that never
    // disconnects.
    setTimeout(() => process.exit(0), 2000).unref();
  }
  process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
  process.on("SIGINT", () => gracefulShutdown("SIGINT"));
}

startServer().catch((error: unknown) => {
  // A rejected bootstrap promise must terminate the process. Merely leaving an
  // unhandled rejection can keep Node alive on some runtimes and turn a
  // fail-closed production configuration error into a hung service manager.
  console.error("[STARTUP] Fatal configuration error:", error);
  process.exit(1);
});
