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
import os from "os";
import { execFile } from "child_process";
import { promisify } from "util";
import { WebSocketServer, WebSocket } from "ws";
import { calculateJoints } from "./kinematics";
import Bonjour from 'bonjour-service';
import jwt from 'jsonwebtoken';
import { ensureSeedUser, findUser, verifyPassword, listUsers, createUser, updateUser, deleteUser, type UserRole } from './users';
import {
  registry as metricsRegistry,
  robotCommandsTotal,
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

// Falls back to this literal only when JWT_SECRET isn't set in the
// environment - keeps `npm run dev`/a fresh checkout working with zero
// setup. A deployment exposed beyond a fully trusted LAN should set its
// own JWT_SECRET (see .env.example and README.md) so a leaked/published
// source tree can't be used to forge admin tokens.
const JWT_SECRET_IS_DEFAULT = !process.env.JWT_SECRET;
const JWT_SECRET = process.env.JWT_SECRET || "hydra_industrial_secret_2026";
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

// wifi/ethernet: read from /sys/class/net/<iface>/operstate, Linux-only (real
// on a CM5, absent on Windows/macOS dev machines - null there rather than a
// guess). bluetooth: presence of any /sys/class/bluetooth/hci* controller
// with an "up" state file is the closest cheap signal without a native BLE
// dependency. Each check is independently wrapped so one missing interface
// (e.g. no onboard Wi-Fi) doesn't blank out the other two.
function readInterfaceUp(iface: string): boolean | null {
  try {
    const state = fs.readFileSync(`/sys/class/net/${iface}/operstate`, "utf-8").trim();
    return state === "up";
  } catch {
    return null;
  }
}

function readBluetoothUp(): boolean | null {
  try {
    const controllers = fs.readdirSync("/sys/class/bluetooth").filter(n => n.startsWith("hci"));
    if (controllers.length === 0) return null;
    return controllers.some(c => {
      try { return fs.readFileSync(`/sys/class/bluetooth/${c}/../../power/runtime_status`, "utf-8").trim() !== "suspended"; }
      catch { return true; } // controller present but state file layout differs by kernel - assume present means available
    });
  } catch {
    return null;
  }
}

function readNetworkStatus() {
  return {
    wifi: readInterfaceUp("wlan0"),
    ethernet: readInterfaceUp("eth0"),
    bluetooth: readBluetoothUp(),
  };
}

// Shared by GET /api/system/metrics (unchanged wire shape - the browser
// UI's own StatusFooter) and GET /metrics (src/metrics.ts's own
// hydra_system_* Prometheus gauges, wired up via setSystemMetricsSource()
// below) - pulled out of the route handler it used to live in directly so
// both call sites do the exact same vcgencmd read/os.loadavg() computation
// instead of two copies drifting apart. See the original inline comment
// (now here) for why this is execFile (async, no shell) and not execSync.
async function getSystemMetrics(): Promise<{
  cpu_load: number;
  memory_usage: number;
  temp: number | null;
  temp_is_real: boolean;
  uptime: number;
  network: ReturnType<typeof readNetworkStatus>;
}> {
  // Real read on a CM5/Pi host; throws (command not found) on any other OS,
  // in which case we fall back to a clearly-mocked value rather than lie.
  // execFile (async, no shell) instead of the old execSync: a synchronous
  // call here stalled the ENTIRE event loop - every other in-flight
  // request and every open WebSocket's message handling on this
  // single-threaded server - for as long as vcgencmd took to answer, up
  // to the 500ms timeout below if it ever hung (and this route can be
  // polled every few seconds by the dashboard's own status footer, and now
  // also by a Prometheus scrape on its own interval). execFile also never
  // spawns a shell to parse the command line, so there's no
  // shell-metacharacter injection surface even in principle - moot today
  // since "vcgencmd"/"measure_temp" are fixed literals with no
  // interpolated input, but a strictly safer default regardless.
  let temp: number | null = null;
  let tempIsReal = false;
  try {
    const { stdout } = await execFileAsync("vcgencmd", ["measure_temp"], { timeout: 500 });
    const match = stdout.match(/temp=([\d.]+)/);
    if (match) { temp = parseFloat(match[1]); tempIsReal = true; }
  } catch {
    temp = 45 + Math.random() * 10; // Mock - vcgencmd isn't available on this host (not a Pi, or dev machine)
  }

  return {
    cpu_load: Math.round(os.loadavg()[0] * 10), // simplified load
    memory_usage: Math.round((1 - os.freemem() / os.totalmem()) * 100),
    temp,
    temp_is_real: tempIsReal,
    uptime: Math.round(process.uptime()),
    network: readNetworkStatus(),
  };
}

// Registered once, at module load - independent of startServer()'s own
// local state, unlike setWsClientsSource() below which has to wait for
// wsClients to exist.
setSystemMetricsSource(getSystemMetrics);

// The real wire shape POST/GET /api/settings and the WS "settings"/"delta"
// payload all use is { settings: SystemSettings, controllers, activeControllerId }
// (see docs/REMOTE_API.md section 2c, src/store.tsx's own POST body) - every
// SystemSettings field (serverName, remoteAccess, modelSubmissions, ...)
// lives ONE LEVEL DEEPER than `controllers`/`activeControllerId`. Reading
// lastKnownSettings.serverName / lastKnownSettings.remoteAccess directly
// (instead of lastKnownSettings.settings.serverName /
// lastKnownSettings.settings.remoteAccess) is always undefined against the
// real payload shape - a trap it's easy to fall into at any call site that
// reads lastKnownSettings (the mDNS name at startup/on every write, and
// this exact remoteAccessAllowed() call), which would silently make the
// per-client Remote Access toggles do nothing (remoteAccessAllowed() would
// always see `settings` as undefined and therefore always return true) and
// make a server rename from Config > Identity never actually update its
// own mDNS advertisement. This helper is the one place that gets it right,
// used everywhere below instead of reaching into either shape directly.
function realSettings(payload: any): any {
  return payload?.settings ?? payload;
}

// Per-client remote-access toggles (Config > Remote Access in the browser
// UI, src/store.tsx's own SystemSettings.remoteAccess) - 3 independent
// toggles (SUITE/Android/iOS) instead of one combined switch, so e.g.
// Android access can be revoked without also blocking SUITE. Each of the 3 real clients sends its
// own `X-Hydra-Client: suite|android|ios` request header (see each
// project's own network client) - a request with NO such header (a plain
// browser tab, curl, or any other unidentified caller) is never gated here,
// since this check only exists to control the 3 named remote apps, not
// this same server's own browser UI (which never sends that header and
// reaches this same route from About.tsx's own version check).
function remoteAccessAllowed(settings: any, clientType: string | undefined): boolean {
  if (clientType !== "suite" && clientType !== "android" && clientType !== "ios") return true;
  const ra = settings?.remoteAccess;
  if (!ra) return true; // no config saved at all yet - matches this feature's own original always-on default
  const specific = ra[clientType];
  if (specific !== undefined) return specific !== false;
  return ra.enabled !== false; // legacy singular toggle, only consulted if this client's own flag was never set
}

// Bumped whenever the /api/hydra-info or /ws message contract changes in a
// way a remote client (HYDRA-UMC SUITE, the mobile control apps) might need
// to branch on - NOT the same number as package.json's own app version.
// 2 = this server can emit a real targeted delta (schema 2, see
// DISEÑO_SYNC_DELTAS.txt section 2) on /ws for a client that opts in by
// connecting with ?remoteApiVersion=2 in its own query string - the SAME
// field/number a client already reads back from GET /api/hydra-info,
// reused here as the version THIS client itself understands rather than
// inventing a separate field (owner's own choice, per that document's
// section 8 question 3). A client that connects without this param (every
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

  jwt.verify(token, JWT_SECRET, (err: any, user: any) => {
    if (err) {
      // Same 403 status for both cases, deliberately (audit #019 wanted a
      // real 401-vs-403 split - "token expired" vs "token has no
      // permissions" - but the 4 remote clients of this API aren't open in
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
    req.user = user;
    next();
  });
}

/** Chain after authenticate() - rejects anyone whose token role isn't "admin".
 * Gates POST /api/settings (full-tree overwrite) and every /api/users route -
 * an "operator" account can still drive robots via the atomic
 * /api/robot/:id/command endpoint, just can't touch global config or accounts. */
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

  // First-ever start seeds data/users.json with a single admin/admin
  // account - see users.ts's own header comment for why this replaced the
  // old hardcoded "demo"/"demo" check below.
  ensureSeedUser();

  // Production-only startup checks (audit: real internet exposure via
  // NAT/port-forward confirmed by the owner) - loud, impossible-to-miss
  // warnings for the two defaults that matter most if this process is
  // reachable from outside a trusted LAN: a JWT signing secret anyone can
  // read straight out of the published source tree, and the seeded
  // admin/admin account still sitting at its original password. Neither
  // check ever runs (or prints anything) outside NODE_ENV=production, so
  // a plain `npm run dev` checkout is unaffected. This is detection, not
  // enforcement - the server still starts either way, since refusing to
  // boot on a fresh CM5 deployment before the owner has even had a chance
  // to log in and change anything would be a worse failure mode than a
  // warning.
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
    const adminStillDefault = !!seededAdmin && verifyPassword("admin", seededAdmin.passwordHash);
    if (adminStillDefault) {
      console.warn("=================================================================");
      console.warn("[SECURITY WARNING] NODE_ENV=production but the seeded admin/admin");
      console.warn("  account still has its original default password. Anyone who can");
      console.warn("  reach this server can log in as admin. Change it now: Config >");
      console.warn("  Users, or POST /api/users/admin with a new password.");
      console.warn("=================================================================");
    }
    if (JWT_SECRET_IS_DEFAULT) {
      console.warn("=================================================================");
      console.warn("[SECURITY WARNING] NODE_ENV=production but JWT_SECRET is not set -");
      console.warn("  using the built-in development default, which is published in");
      console.warn("  this project's own source code. Anyone who reads it can forge a");
      console.warn("  valid admin login token. Set a real JWT_SECRET (see .env.example)");
      console.warn("  before this server is reachable outside a fully trusted LAN.");
      console.warn("=================================================================");
    }
  }

  const getSettingsPath = () => {
    return path.join(dataPath, "settings.json");
  };

  // Filesystem-safe rendering of a controller/robot id for use as a path
  // segment in getPointsPath() below - controller ids are client-supplied
  // (POST /api/settings writes controllers[].id as given, see that route),
  // so this can't just interpolate one raw into a path: anything outside
  // this allowlist (a literal ".."/"/" segment, most obviously) becomes a
  // single "_" instead, closing off path traversal without ever rejecting
  // the write outright (an id this function would need to touch already
  // isn't achievable through the STUDIO/SUITE/mobile UIs, which only ever
  // set it to an IP or hostname - this is defense in depth against a
  // malformed/adversarial direct API caller, not a UI validation gap).
  function safeIdSegment(id: unknown): string {
    const s = String(id ?? "");
    const cleaned = s.replace(/[^A-Za-z0-9._-]/g, "_");
    return cleaned.length > 0 ? cleaned.slice(0, 128) : "_";
  }

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
  // queueSettingsWrite always used for settings.json itself (audit #013) -
  // sibling temp file (PID + timestamp, so two overlapping writers never
  // collide on the same temp path) written first, then atomically renamed
  // over the real path, so a write interrupted partway (disk full, process
  // killed, power loss) never leaves `finalPath` itself truncated/corrupt -
  // it's either the complete new content or untouched, never in between.
  // Shared now that queueSettingsWrite writes more than one file per call.
  async function writeFileAtomic(finalPath: string, json: string): Promise<void> {
    const tmpPath = `${finalPath}.${process.pid}.${Date.now()}.tmp`;
    await fs.promises.mkdir(path.dirname(finalPath), { recursive: true });
    await fs.promises.writeFile(tmpPath, json, "utf-8");
    await fs.promises.rename(tmpPath, finalPath);
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
    // payload, just like "settings" - see DISEÑO_SYNC_DELTAS.txt section 3
    // step 1). Purely additive: every client today already ignores unknown
    // fields on this message, so shipping this alone changes nothing for
    // anyone - it only gives a future server/client pair a version to
    // negotiate against before "delta" ever means a real partial patch.
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
   * route's own comment on `deltas` below - DISEÑO_SYNC_DELTAS.txt section
   * 5a: a delta is only ever built FROM a validated write, never from a
   * generic before/after diff of the tree). `deltas` is one entry per
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

  // V0 server-authoritative playback engine (2026-08-29): linear
  // point-to-point replay of a robot's own recordedPoints, straight from
  // each point's OWN stored j1..j6/pos (real values captured live at
  // record time, not re-derived) - deliberately NOT the full velocity/
  // acceleration interpolation curve HYDRA-UMC-STUDIO's own
  // RobotDetail.tsx (playRobotTrajectory) still uses for its own render,
  // and deliberately not running any inverse kinematics itself. Exists so
  // play/pause/stop physically move a robot from ANY client (Android,
  // iOS, DSI, SUITE) without depending on some STUDIO browser tab being
  // open with that exact robot's panel mounted and running its own local
  // interpolation loop - see docs this session's own SONNET tracking
  // (HYDRA-UMC-SERVER/mejoras_futuras.txt) for the full investigation and
  // the reasoning behind keeping this intentionally small.
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

      const pt = points[step];
      const patch: Record<string, unknown> = {};
      if (typeof pt.j1 === "number") {
        r.joints = { j1: pt.j1, j2: pt.j2, j3: pt.j3, j4: pt.j4, j5: pt.j5, j6: pt.j6 };
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
      r.playbackState = { ...pb, activeStep: step + 1 };
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
  // these regardless of which folder they resolve into (audit #016).
  const RESERVED_DATA_FILENAMES = new Set(["settings.json", "users.json", "model_submissions.json"]);
  const BLOCKED_STATIC_FILES = new Set(["/settings.json", "/users.json", "/model_submissions.json"]);
  app.use((req, res, next) => {
    if (
      BLOCKED_STATIC_FILES.has(req.path) ||
      req.path === "/logs" || req.path.startsWith("/logs/") ||
      req.path === "/points" || req.path.startsWith("/points/")
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

  app.post("/api/login", loginRateLimiter, (req, res) => {
    const { username, password } = req.body || {};
    if (typeof username !== "string" || typeof password !== "string") {
      return res.status(400).json({ error: "username and password required" });
    }
    const user = findUser(username);
    if (!user || !verifyPassword(password, user.passwordHash)) {
      authFailuresTotal.inc({ reason: "invalid_credentials" });
      return res.status(401).json({ error: "Invalid credentials" });
    }
    // See JWT_EXPIRES_IN's own header comment above for why this is
    // configurable instead of a hardcoded '30d' - defaults to 30d so an
    // existing trusted-LAN deployment sees no behavior change.
    const token = jwt.sign({ username: user.username, role: user.role }, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN as any });
    res.json({ success: true, token, role: user.role });
  });

  // Account management - admin-only (requireAdmin, chained after
  // authenticate), backed by the users.ts module - lets an admin
  // rename/re-password their own account from Config > Users
  // instead of the account being permanently stuck as "admin"/"admin", and
  // create additional lower-privilege "operator" accounts for day-to-day
  // robot operation without exposing settings writes or user management.
  app.get("/api/users", authenticate, requireAdmin, (req, res) => {
    res.json({ users: listUsers() });
  });

  app.post("/api/users", authenticate, requireAdmin, (req, res) => {
    const { username, password, role } = req.body || {};
    const safeRole: UserRole = role === "operator" ? "operator" : "admin";
    if (typeof username !== "string" || typeof password !== "string") {
      return res.status(400).json({ error: "username and password required" });
    }
    const result = createUser(username, password, safeRole);
    if (!result.ok) return res.status(400).json({ error: result.error });
    res.json({ success: true });
  });

  app.put("/api/users/:username", authenticate, requireAdmin, (req, res) => {
    const { newUsername, password, role } = req.body || {};
    const safeRole: UserRole | undefined = role === "operator" || role === "admin" ? role : undefined;
    const result = updateUser(req.params.username, { newUsername, password, role: safeRole });
    if (!result.ok) return res.status(400).json({ error: result.error });
    res.json({ success: true });
  });

  app.delete("/api/users/:username", authenticate, requireAdmin, (req, res) => {
    const result = deleteUser(req.params.username);
    if (!result.ok) return res.status(400).json({ error: result.error });
    res.json({ success: true });
  });

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
  app.get("/api/settings", (req, res) => {
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
      await queueSettingsWrite(payload);
      broadcastSettings(payload);
      res.json({ success: true });
    } catch (e) {
      console.error("Error writing settings", e);
      res.status(500).json({ error: "Failed to save settings" });
    }
  });

  // Authenticated, non-actuating relay for a recognised voice turn. The
  // phone/watch presents its ordinary Server JWT; the Server alone holds the
  // local Voice UI token. This is intentionally REST rather than a robot
  // command route, and it never translates an intent into movement.
  app.post("/api/voice/turn", authenticate, async (req, res) => {
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
  app.get("/api/watch/system-status", authenticate, async (_req, res) => {
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

  // Direct Atomic API for Industrial Control
  app.post("/api/robot/:id/command", authenticate, async (req, res) => {
    const robotId = parseInt(req.params.id);
    const { command, params } = req.body;

    if (!lastKnownSettings.controllers) {
      return res.status(400).json({ error: "No settings loaded" });
    }

    let targetRobot: any = null;
    lastKnownSettings.controllers.forEach((c: any) => {
      const r = c.robots?.find((r: any) => r.id === robotId);
      if (r) targetRobot = r;
    });

    if (!targetRobot) {
      return res.status(404).json({ error: "Robot not found" });
    }

    // Identify all robots that should receive this command (Self + Combined)
    const affectedIds = [robotId, ...(targetRobot.combinedWith || [])];
    // Resolve pause once from the command target. Applying `!isPaused` to
    // each member separately lets a stale combined pair (for example A1/A2)
    // end in opposite states; every client must receive one desired group
    // state instead. Older clients that send no parameter retain toggle UX.
    const requestedPause = typeof params?.paused === "boolean"
      ? params.paused
      : !Boolean(targetRobot.playbackState?.isPaused ?? targetRobot.playbackState?.paused);

    // One entry per affected robot this command actually mutated - built
    // FROM the same validated switch/case below as it runs, never from a
    // before/after diff of the tree (DISEÑO_SYNC_DELTAS.txt section 5a).
    // Feeds broadcastRobotDelta() below so a schema-2 client gets this
    // small targeted patch instead of the full tree.
    const deltas: { controllerId: string; robotId: number; patch: Record<string, unknown>; cameraId?: number; cameraPatch?: Record<string, unknown> }[] = [];

    lastKnownSettings.controllers.forEach((controller: any) => {
      controller.robots?.forEach((robot: any) => {
        if (affectedIds.includes(robot.id)) {
          let patch: Record<string, unknown> | null = null;
          let cameraId: number | undefined;
          let cameraPatch: Record<string, unknown> | undefined;
          switch (command) {
            case "stop":
              // isFinished/finished reset here too, not just isPlaying/
              // activeStep/isPaused - every one of the 6 clients' own LOCAL
              // optimistic "stop" mutation already does this (STUDIO's own
              // RobotDetail.tsx handleStop, Android's HydraState.kt stop(),
              // iOS/DSI's RobotView.stop()), on the assumption that a
              // manual stop always clears a stale "job finished
              // successfully" flag from a previous run - this case just
              // never actually matched that assumption itself. Harmless
              // while every client trusted only its own optimistic
              // mutation and never round-tripped this value back from here,
              // but a real bug once a client (see
              // DISEÑO_SYNC_DELTAS.txt) starts treating this endpoint's own
              // patch as authoritative: without this, a robot that
              // finished a job once, then gets manually stopped after
              // being replayed, could show a stale "completed successfully"
              // notification/badge again once this patch's own isFinished
              // (silently still true) lands.
              robot.playbackState = { ...robot.playbackState, isPlaying: false, playing: false, activeStep: -1, isPaused: false, paused: false, requestPause: false, requestStop: true, isFinished: false, finished: false };
              patch = { playbackState: robot.playbackState };
              // Stops this robot's own V0 server-side playback timer (see
              // startServerPlayback's own header comment) immediately
              // rather than waiting for its next tick to notice
              // requestStop - a manual stop should feel instant.
              stopServerPlayback(robot.id);
              break;
            case "play":
              // See "stop" case's own comment just above - same gap, same fix.
              robot.playbackState = { ...robot.playbackState, isPlaying: true, playing: true, activeStep: 0, isPaused: false, paused: false, requestPause: false, requestStop: false, isFinished: false, finished: false };
              patch = { playbackState: robot.playbackState };
              // Starts this robot's own V0 server-side playback timer -
              // see startServerPlayback's own header comment for why this
              // exists and what it deliberately doesn't attempt yet.
              startServerPlayback(robot.id);
              break;
            case "pause":
              robot.playbackState = { ...robot.playbackState, isPlaying: true, playing: true, isPaused: requestedPause, paused: requestedPause, requestPause: requestedPause, requestStop: false, isFinished: false, finished: false };
              patch = { playbackState: robot.playbackState };
              break;
            case "jog": {
              // Axis allowlisted against the real Position shape
              // (kinematics.ts's own {x,y,z,a,b,c}) - params.axis is
              // caller-controlled and used directly as an object key on
              // robot.pos. Investigated as a possible prototype-pollution
              // vector (external audit #036/#235): NOT exploitable as
              // written even before this fix (JS's own `__proto__` setter
              // silently ignores a non-object assignment, and `+=` here
              // always produces a number/string, never an object) - but an
              // unvalidated axis string could still write an arbitrary new
              // property onto robot.pos (e.g. from a buggy/malformed
              // client) that then gets persisted to settings.json and
              // broadcast to every other client. Allowlisting is a cheap,
              // real correctness fix independent of the pollution
              // question, and matches the typeof-checked style every
              // other case below (valve/pump/speed) already uses.
              const ROBOT_AXES = new Set(["x", "y", "z", "a", "b", "c"]);
              const JOINT_KEYS = ["j1", "j2", "j3", "j4", "j5", "j6"];
              // Finite + bounded, not just typeof "number": a caller could send
              // NaN/Infinity - both pass `typeof === "number"` - or an
              // absurd single-command delta like 1e9). STUDIO's own largest
              // JOG_STEP_OPTIONS entry is 100 (RobotDetail.tsx), so a single
              // real jog command from any real client never needs an
              // |amount| anywhere near this cap - 1000 is 10x headroom for
              // legitimate use while still refusing to yank a real,
              // physical robot toward an extreme position from one
              // malformed/malicious atomic command.
              const MAX_JOG_AMOUNT = 1000;
              const validAmount = typeof params?.amount === "number" && Number.isFinite(params.amount) && Math.abs(params.amount) <= MAX_JOG_AMOUNT;
              if (typeof params?.axis === "string" && ROBOT_AXES.has(params.axis) && validAmount) {
                const target = params.target || "robot";
                if (target === "robot") {
                  robot.pos[params.axis] += params.amount;
                  // An optional, client-supplied joints override -
                  // HYDRA-UMC-STUDIO's own browser UI resolves jog targets
                  // through resolveTargetJoints(), a PER-MODEL inverse-
                  // kinematics solver (Parol6/Faze4/AR3/AR4/UR3e/... each
                  // have real, different kinematic chains) - calculateJoints()
                  // right below is a single generic IK formula that doesn't
                  // know about any of that, so blindly recomputing joints
                  // server-side for a STUDIO-originated jog would silently
                  // diverge from what that same client already shows in its
                  // own 3D viewport for most models (see
                  // DISEÑO_SYNC_DELTAS.txt's own "jog" caveat). This is the
                  // SAME trust level STUDIO's joints already had under the
                  // full-tree POST /api/settings path it used before this
                  // atomic command existed - not a new attack surface, just
                  // the same client-authoritative value taking a smaller
                  // door in. Validated as 6 finite numbers, one per real
                  // joint name, before being trusted; anything else (a
                  // client that doesn't send it - Android/iOS/DSI/SUITE
                  // never do - or sends something malformed) falls through
                  // to calculateJoints() exactly like before this existed.
                  const j = params?.joints;
                  const hasValidJoints = j && typeof j === "object" && JOINT_KEYS.every((k) => typeof j[k] === "number" && Number.isFinite(j[k]));
                  robot.joints = hasValidJoints ? { j1: j.j1, j2: j.j2, j3: j.j3, j4: j.j4, j5: j.j5, j6: j.j6 } : calculateJoints(robot.pos);
                  patch = { pos: robot.pos, joints: robot.joints };
                } else if (target === "xytable" && robot.xyTable) {
                  const axis = params.axis === "x" ? "x" : (params.axis === "y" ? "y" : null);
                  if (axis) {
                    robot.xyTable.pos[axis] += params.amount;
                    // The FULL xyTable object, not just { pos: ... } - every
                    // client's own delta-merge (STUDIO's applyRobotDelta in
                    // store.tsx, Android's RobotViewModel.onDelta, iOS/DSI's
                    // equivalents) applies a patch as a SHALLOW top-level-key
                    // replace ({ ...robot, ...patch }, or the JSONObject
                    // equivalent) - a patch of just { xyTable: { pos } }
                    // replaced the receiving client's ENTIRE xyTable object
                    // with just that pos, silently deleting tableSize/
                    // worldPos/renderScale/worldRot. STUDIO's own
                    // VirtualKinematics.tsx then dereferenced
                    // xyTable.tableSize.width with no null-guard - a real,
                    // reproducible crash-to-blank-page on every OTHER
                    // connected client the instant anyone jogged an XY
                    // table, not a hypothetical: this is the confirmed root
                    // cause of the "moved the XY table from the Android app
                    // while STUDIO was open - STUDIO went blank and the app
                    // crashed" report. Sending the complete object here
                    // means a shallow merge on the receiving end reconstructs
                    // the exact same xyTable instead of an amputated one.
                    patch = { xyTable: robot.xyTable };
                  }
                }
              }
              break;
            }
            case "tool":
              if (params?.tool) {
                robot.tool = params.tool;
                patch = { tool: robot.tool };
              }
              break;
            case "valve":
              if (typeof params?.index === "number" && typeof params?.state === "boolean") {
                if (!robot.valves) robot.valves = [false, false];
                robot.valves[params.index] = params.state;
                patch = { valves: robot.valves };
              }
              break;
            case "pump":
              if (typeof params?.index === "number" && typeof params?.state === "boolean") {
                if (!robot.pumps) robot.pumps = [false, false];
                robot.pumps[params.index] = params.state;
                patch = { pumps: robot.pumps };
              }
              break;
            case "speed": {
              // Bounded to STUDIO's own RotaryKnob/FuturisticSlider range
              // for both fields (RobotDetail.tsx: min={10} max={500}) -
              // `typeof === "number"` alone (the only check here before
              // this fix) let a caller push NaN/Infinity/a negative value
              // straight into playbackState.speed, from where it feeds the
              // real motion-profile math on every subsequent jog/playback
              // step (AUDITORIA_COMPLETA_44_PROYECTOS.txt #6).
              const validSpeedField = (v: unknown) => typeof v === "number" && Number.isFinite(v) && v >= 10 && v <= 500;
              let touched = false;
              if (validSpeedField(params?.speed)) {
                if (!robot.playbackState) robot.playbackState = { isPlaying: false, activeStep: 0, speed: 100 };
                robot.playbackState.speed = params.speed;
                touched = true;
              }
              if (validSpeedField(params?.acceleration)) {
                if (!robot.playbackState) robot.playbackState = { isPlaying: false, activeStep: 0, speed: 100 };
                robot.playbackState.acceleration = params.acceleration;
                touched = true;
              }
              if (touched) patch = { playbackState: robot.playbackState };
              break;
            }
            // Lets a remote client (the Android app's own Camera
            // screen) toggle a robot's vision system without a full
            // POST /api/settings overwrite - mirrors the same 2 fields
            // src/Dashboard.tsx's OverviewPanel already writes locally
            // (visionEnabled on the robot, connected on its paired camera entry).
            case "vision":
              if (typeof params?.enabled === "boolean") {
                robot.visionEnabled = params.enabled;
                if (robot.camera && typeof robot.camera === "object") {
                  robot.camera.connected = params.enabled;
                }
                patch = robot.camera && typeof robot.camera === "object"
                  ? { visionEnabled: robot.visionEnabled, camera: robot.camera }
                  : { visionEnabled: robot.visionEnabled };
                const cam = (controller.cameras || []).find((c: any) => c.assignedRobotId === robot.id || c.id === robot.id);
                if (cam) {
                  cam.connected = params.enabled;
                  cameraId = cam.id;
                  cameraPatch = { connected: cam.connected };
                }
              }
              break;
          }
          if (patch) deltas.push({ controllerId: controller.id, robotId: robot.id, patch, cameraId, cameraPatch });
        }
      });
    });

    industrialLog(`Command: ${command} on Robot ${robotId}`);

    // Counted once per REQUEST (this endpoint may fan a single command out
    // to several combined robots via affectedIds above, but that's still
    // one command received) - "unknown" for anything the switch above
    // doesn't recognize, same as an unhandled case there falls through
    // with no effect. src/metrics.ts's own hydra_robot_commands_total,
    // exposed on GET /metrics.
    robotCommandsTotal.inc({ command: typeof command === "string" ? command : "unknown" });

    await queueSettingsWrite(lastKnownSettings);
    broadcastRobotDelta(deltas, lastKnownSettings);
    res.json({ success: true, affectedCount: affectedIds.length });
  });

  // Industrial Native Streaming Server (MJPEG Proxy Placeholder)
  // Allows the Android app to show video directly from the CM5
  app.get("/api/camera/:id/stream", (req, res) => {
    res.writeHead(200, {
      'Content-Type': 'multipart/x-mixed-replace; boundary=--boundary',
      'Cache-Control': 'no-cache',
      'Connection': 'close',
      'Pragma': 'no-cache'
    });

    // In a real CM5 implementation, this would pipe from a libcamera or ffmpeg process
    // For now, we send a "Camera Offline" placeholder frame periodically
    const interval = setInterval(() => {
      const frame = Buffer.from("placeholder_frame_data");
      res.write(`--boundary\r\nContent-Type: image/jpeg\r\nContent-Length: ${frame.length}\r\n\r\n`);
      res.write(frame);
      res.write("\r\n");
    }, 100);

    req.on('close', () => clearInterval(interval));
  });

  // System Metrics API for industrial monitoring - powers the Overview
  // footer's CPU/memory/temp/network readout (Dashboard.tsx StatusFooter).
  // The actual read now lives in the module-level getSystemMetrics() above
  // (shared with GET /metrics's own hydra_system_* gauges below) - this
  // route is just that function's own JSON wire shape, unchanged.
  app.get("/api/system/metrics", async (req, res) => {
    res.json(await getSystemMetrics());
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

  function slugify(name: string): string {
    const slug = name.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
    return slug || "model";
  }

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

    jwt.verify(token, JWT_SECRET, (err: any, decoded: any) => {
      if (err) {
        authFailuresTotal.inc({ reason: "ws_token_invalid" });
        ws.send(JSON.stringify({ error: "Access denied: Invalid token" }));
        setTimeout(() => ws.close(1008, "Access denied: Invalid token"), 100);
        return;
      }

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
      // Heartbeat state for this connection (audit #017) - see the
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
            if (decoded?.role !== "admin") {
              ws.send(JSON.stringify({ error: "Access denied: admin privileges required" }));
              return;
            }
            await queueSettingsWrite(msg.payload);
            broadcastSettings(msg.payload, false, ws); // Skip originator to avoid echo
          }
        } catch (e) {
          console.error("Malformed WebSocket message", e);
        }
      });

      ws.on("close", () => wsClients.delete(ws));
      ws.on("error", () => wsClients.delete(ws));
    });
  });

  // Application-level heartbeat (audit #017): TCP alone doesn't notice a
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

startServer();
