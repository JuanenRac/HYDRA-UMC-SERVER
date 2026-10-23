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
import path from "path";
import fs from "fs";
import http from "http";
import https from "https";
import { type WebSocket } from "ws";
import { registerBluetoothRoutes } from "./routes/bluetoothRoutes";
import { registerSystemRoutes } from "./routes/systemRoutes";
import { registerAdminRoutes } from "./routes/adminRoutes";
import { registerCameraRoutes } from "./routes/cameraRoutes";
import { registerRobotRoutes } from "./routes/robotRoutes";
import { registerCommandRoutes } from "./routes/commandRoutes";
import { registerUpstreamRoutes } from "./routes/upstreamRoutes";
import { realSettings, wsQueryTokenAllowed } from "./serverPolicy";
import { ensureSeedUser, findUser, verifyPassword } from "./users";
import { pruneExpiredRefreshTokens } from "./refresh_tokens";
import { SafetyLimits, JogArming } from "./safetyLimits";
import { registerSafetyRoutes } from "./routes/safetyRoutes";
import { listClaims } from "./claimPolicy";
import { AuditLog, auditOptionsFromEnv } from "./auditLog";
import { SecurityConfig, certFingerprint, resolveTls, securityEnvFrom } from "./securityConfig";
import { cameraAuthRequiredByDefault, issueMediaTicket, mediaTicketKey, verifyMediaTicket } from "./mediaTickets";
import { registerAuthRoutes } from "./routes/auth";
import { registerSettingsRoutes } from "./routes/settings";
import { registerStaticRoutes } from "./routes/staticRoutes";
import { registerAssistantRoutes } from "./routes/assistantRoutes";
import { registerLocalAiRoutes } from "./routes/localAiRoutes";
import { registerInfoRoutes } from "./routes/infoRoutes";
import { registerPowerRoutes } from "./routes/powerRoutes";
import { registerWorksRoutes } from "./routes/worksRoutes";
import { createSettingsStore, settingsStoreOptionsFromEnv, sweepOrphanedTmpFiles } from "./settingsStore";
import { createCameraSupervisor } from "./cameraSupervisor";
import { createPlayback } from "./playback";
import { createWsHub, attachWebSocketServer } from "./ws";
import { NODE_ENV, JWT_SECRET, authenticate, asyncHandler, requireAdmin, stopAllRateLimiter } from "./auth";
import { DATALAKE_URL, DATALAKE_TIMEOUT_MS, CONNECTOR_HUB_URL, CONNECTOR_HUB_TIMEOUT_MS, SPI_BRIDGE_URL, SPI_BRIDGE_VERSION_TIMEOUT_MS, SPI_BRIDGE_FLASH_TIMEOUT_MS } from "./upstreamConfig";
import { LOG_FILE, bonjour, setupDiscovery, loadServerConfig, saveServerConfig, resolvePort, industrialLog, setCurrentPort, getCurrentPort, closeLog } from "./runtime";

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

async function startServer() {
  sweepOrphanedTmpFiles(path.join(process.cwd(), "data"), industrialLog);

  const app = express();
  const PORT = resolvePort();
  setCurrentPort(PORT);

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

  // Settings, work uploads and model submissions legitimately carry large
  // documents; every other JSON route (commands, login, relays) gets a small
  // body cap.
  const largeJson = express.json({ limit: "50mb" });
  const smallJson = express.json({ limit: "1mb" });
  const LARGE_BODY_ROUTES = new Set(["/api/settings", "/api/upload-work", "/api/models/submit"]);
  app.use((req, res, next) => (LARGE_BODY_ROUTES.has(req.path) ? largeJson : smallJson)(req, res, next));

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

  // The audit record (data/audit.jsonl); its copies travel with the settings backups.
  const audit = new AuditLog(dataPath, { ...auditOptionsFromEnv(process.env), log: industrialLog });
  const storeOptions = settingsStoreOptionsFromEnv(process.env);
  const store = createSettingsStore(dataPath, {
    ...storeOptions,
    log: industrialLog,
    onBackup: (copy) => audit.backupTo(path.dirname(copy), path.basename(copy).replace(/^settings-/, "").replace(/\.json$/, ""), storeOptions.backups ?? 10),
  });
  const { loadFullSettingsFromDisk, queueSettingsWrite, getSettings, setSettings } = store;

  const supervisor = createCameraSupervisor();
  const { cameraProcesses, stopCameraProcess, reconcileCameraProcesses, reapOrphanedCameraProcesses } = supervisor;

  const hub = createWsHub({ setSettings });
  const { wsClients, broadcastSettings, broadcastRobotDelta } = hub;

  const playback = createPlayback({ getSettings, queueSettingsWrite, broadcastRobotDelta });
  const {
    findRobotById, findControllerIdForRobot, isReservationActive, appendReservationHistory,
    startServerPlayback, stopServerPlayback, DEFAULT_RESERVATION_TTL_MS, MAX_RESERVATION_TTL_MS,
  } = playback;

  // The one real hook point both settings-write paths (REST POST and
  // the WS "settings" message, see their own two call sites below) were
  // already calling in the exact same 2-step sequence
  // (queueSettingsWrite then broadcastSettings) - folded into one
  // function that also reconciles camera processes, so both paths stay
  // in sync by construction instead of by remembering to update two
  // call sites identically.
  // The limits every client is held to (data/safety-limits.json) and the arming of the jog (memory only).
  const safety = new SafetyLimits(dataPath, industrialLog);
  const arming = new JogArming();
  audit.setEnabled(safety.get().audit.enabled);
  // Tells the clients that opted in (schema 2) who controls which robot, after a claim, a release or an arming changed.
  const onClaimsChanged = () => hub.broadcastClaims(listClaims(getSettings(), isReservationActive, (id) => arming.expiresAt(id)));

  async function applySettingsUpdate(payload: any, originatorWs?: WebSocket): Promise<{ robotId: unknown; requested: number; applied: number }[]> {
    // A heated-bed target above the limit of its model is lowered to the limit before it is stored or broadcast.
    const clamped = safety.clampTemperatures(payload);
    await queueSettingsWrite(payload);
    broadcastSettings(payload, false, originatorWs);
    reconcileCameraProcesses(payload);
    return clamped;
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
  reconcileCameraProcesses(getSettings());

  registerStaticRoutes(app, { dataPath });

  registerAuthRoutes(app);

  // Who may use the local AI relay, whether the host information asks for a sign-in, and TLS: the
  // environment of the deployment wins, then what an administrator saved from the control app.
  const startupTls = resolveTls(securityEnvFrom(process.env), loadServerConfig());
  const security = new SecurityConfig({
    env: securityEnvFrom(process.env),
    load: loadServerConfig,
    save: (file) => {
      const { aiAccess, infoAuth, tls } = file;
      saveServerConfig({ ...loadServerConfig(), aiAccess, infoAuth, tls });
    },
    tlsActive: startupTls.enabled,
    log: industrialLog,
  });

  registerAdminRoutes(app, {
    authenticate, requireAdmin, asyncHandler, industrialLog, wsClients,
    logFile: LOG_FILE, getCurrentPort, loadServerConfig, saveServerConfig, security,
  });

  registerSettingsRoutes(app, { authenticate, requireAdmin, loadFullSettingsFromDisk, applySettingsUpdate });

  registerAssistantRoutes(app, { authenticate, getSettings });

  registerCommandRoutes(app, {
    authenticate,
    getSettings,
    industrialLog,
    isReservationActive,
    queueSettingsWrite,
    broadcastRobotDelta,
    startServerPlayback,
    stopServerPlayback,
    stopAllRateLimiter,
    safety,
    arming,
    audit,
    onClaimsChanged,
  });

  registerRobotRoutes(app, {
    authenticate,
    getSettings,
    findRobotById,
    findControllerIdForRobot,
    isReservationActive,
    appendReservationHistory,
    queueSettingsWrite,
    broadcastRobotDelta,
    DEFAULT_RESERVATION_TTL_MS,
    MAX_RESERVATION_TTL_MS,
    safety,
    arming,
    audit,
    onClaimsChanged,
  });

  registerSafetyRoutes(app, { authenticate, requireAdmin, getSettings, findRobotById, isReservationActive, safety, arming, audit, onClaimsChanged });

  // The live pictures and the saved photos and recordings ask for a ticket (POST /api/camera/ticket) or a signed-in client unless the installation opts out with
  // HYDRA_UMC_CAMERA_AUTH=open, for the clients that do not ask for tickets yet.
  // The read-only host and project information (metrics, the process supervisor, the ecosystem status, the model catalogue) used to answer anybody on the LAN. HYDRA_UMC_INFO_AUTH=required
  // makes it ask for a signed-in client, once every client sends its token on those requests; until then it stays as it was, and a production start says so.
  if (!security.infoAuthRequired() && NODE_ENV === "production") {
    console.warn("[SECURITY] Host metrics, the process supervisor and the ecosystem status are readable by the whole LAN. Set HYDRA_UMC_INFO_AUTH=required once every client sends its token on them.");
  }
  const infoAccess = (req: express.Request, res: express.Response, next: express.NextFunction) => (security.infoAuthRequired() ? authenticate(req, res, next) : next());
  const MEDIA_KEY = mediaTicketKey(JWT_SECRET);
  const CAMERA_AUTH_REQUIRED = cameraAuthRequiredByDefault(process.env.HYDRA_UMC_CAMERA_AUTH);
  if (!CAMERA_AUTH_REQUIRED) {
    console.warn("[SECURITY] HYDRA_UMC_CAMERA_AUTH=open: the camera pictures are open to the whole LAN. Remove the opt-out once every client asks for a ticket (POST /api/camera/ticket).");
  }
  const WS_QUERY_TOKEN_ALLOWED = wsQueryTokenAllowed(process.env.HYDRA_UMC_WS_QUERY_TOKEN);
  if (WS_QUERY_TOKEN_ALLOWED) {
    console.warn("[SECURITY] HYDRA_UMC_WS_QUERY_TOKEN=allow: /ws?token= is accepted, so the token is recorded in proxy and server logs. Remove the opt-out once every client sends the hydra.bearer subprotocol.");
  }
  const mediaAccess = (req: express.Request, res: express.Response, next: express.NextFunction) => {
    if (!CAMERA_AUTH_REQUIRED) return next();
    if (verifyMediaTicket(MEDIA_KEY, req.query.ticket, Date.now()) !== null) return next();
    return authenticate(req, res, next);
  };
  const issueMediaTicketFor = (username: string) => issueMediaTicket(MEDIA_KEY, username, Date.now());
  const { resolveWithinDataDir } = registerWorksRoutes(app, { authenticate, requireAdmin, infoAccess, dataPath, getSettings });

  registerCameraRoutes(app, { authenticate, requireAdmin, mediaAccess, issueMediaTicket: issueMediaTicketFor, dataPath, resolveWithinDataDir, cameraProcesses });

  if (security.aiAdminOnly()) console.log("[SECURITY] The local AI relay (/api/ai/*) answers administrators only.");
  registerLocalAiRoutes(app, { authenticate, requireAdmin, adminOnly: () => security.aiAdminOnly() });

  registerSystemRoutes(app, { authenticate, requireAdmin, industrialLog, infoAccess });

  registerBluetoothRoutes(app, { authenticate, requireAdmin, industrialLog });

  registerUpstreamRoutes(app, {
    authenticate, requireAdmin, industrialLog, wsClients, DATALAKE_URL, DATALAKE_TIMEOUT_MS, CONNECTOR_HUB_URL,
    CONNECTOR_HUB_TIMEOUT_MS, SPI_BRIDGE_URL, SPI_BRIDGE_VERSION_TIMEOUT_MS, SPI_BRIDGE_FLASH_TIMEOUT_MS,
  });

  registerInfoRoutes(app, { infoAccess, getSettings, REMOTE_API_VERSION });

  registerPowerRoutes(app);

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
  // The paths come from the environment or, when an administrator turned TLS on from the control
  // app, from data/server-config.json (see src/securityConfig.ts).
  const TLS_CERT_PATH = startupTls.certPath ?? undefined;
  const TLS_KEY_PATH = startupTls.keyPath ?? undefined;
  const tlsEnabled = startupTls.enabled;
  const httpServer: http.Server = tlsEnabled
    ? https.createServer(
        { cert: fs.readFileSync(TLS_CERT_PATH!), key: fs.readFileSync(TLS_KEY_PATH!) },
        app
      ) as unknown as http.Server
    : http.createServer(app);
  if (tlsEnabled) {
    console.log(`[TLS] HTTPS/WSS enabled - cert: ${TLS_CERT_PATH}, key: ${TLS_KEY_PATH}, SHA-256 fingerprint: ${certFingerprint(TLS_CERT_PATH ?? null) ?? "unknown"}`);
  }

  attachWebSocketServer(httpServer, { wsClients, getSettings, applySettingsUpdate, WS_QUERY_TOKEN_ALLOWED });

  httpServer.listen(PORT, "0.0.0.0", () => {
    const serverName = realSettings(getSettings())?.serverName || "HYDRA-UMC STUDIO";
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
    closeLog();
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
