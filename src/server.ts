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
import { registerCommandRoutes, ROBOT_COMMANDS, stoppedPlaybackState } from "./routes/commandRoutes";
import { JobStopRelay, resolveStopRelay, type StopRelayFile } from "./jobStopRelay";
import { OrchestratorTakeover, resolveTakeover, type TakeoverFile } from "./orchestratorTakeover";
import { reloadDispatcher, resolveReload, type ReloadFile } from "./dispatcherReload";
import { registerUpstreamRoutes } from "./routes/upstreamRoutes";
import { channelFromEnv, type OpsAgentChannel } from "./opsAgentChannel";
import { realSettings, redactSettingsSecrets, setCameraCredentialsViaEnv } from "./serverPolicy";
import { ensureSeedUser, findUser, verifyPassword } from "./users";
import { pruneExpiredRefreshTokens } from "./refresh_tokens";
import { SafetyLimits, JogArming } from "./safetyLimits";
import { registerSafetyRoutes } from "./routes/safetyRoutes";
import { makePresenceGate, registerPresenceRoutes } from "./routes/presenceRoutes";
import { OperatorPresence, presenceSettings } from "./operatorPresence";
import { listClaims } from "./claimPolicy";
import { RobotIdDuplicatedError, ambiguousRobotLogLines, newRobotIdConflicts } from "./robotIds";
import { AuditLog, auditOptionsFromEnv } from "./auditLog";
import { SecurityConfig, certFingerprint, resolveBleMode, resolveTls, securityEnvFrom } from "./securityConfig";
import { applyNewInstallTlsDefault } from "./newInstallTls";
import { resolveMqttMode, type MqttBridge } from "./mqttBridge";
import { startMqttBridge } from "./mqttStart";
import { readSecret } from "./mqttBridge";
import { startBle } from "./ble/start";
import type { BleGateway } from "./ble/bleGateway";
import { issueMediaTicket, mediaTicketKey, verifyMediaTicket } from "./mediaTickets";
import { infoTicketKey, verifyInfoTicket, type InfoTicketLimits } from "./infoTickets";
import { registerAuthRoutes } from "./routes/auth";
import { DeviceTokenStore, deviceTokenKey, type DeviceTokenLimits } from "./deviceTokens";
import { registerDeviceRoutes } from "./routes/deviceRoutes";
import { registerUpdateRoutes } from "./routes/updateRoutes";
import { robotMotionOf } from "./atcReset";
import { registerMaintenanceRoutes } from "./routes/maintenanceRoutes";
import { Maintenance, maintenanceSettings } from "./maintenance";
import { writeDetectionHefSettings } from "./detectionHefSettings";
import type { MaintenanceFile } from "./securityConfig";
import { advertisedAddresses } from "./advertisedAddresses";
import { getEcosystemStatus } from "./ecosystemStatus";
import type { UpdateCheckSettings } from "./updateCheck";
import { jwtKeyStore, setJwtPolicyProvider, setKeyOverlapProvider } from "./jwtKeys";
import { setServiceIdentitySwitch, identityHeader } from "./serviceIdentity";
import { classify as classifyAddress, makeTrustedNetworksGate } from "./trustedNetworks";
import { registerConnectionRoutes } from "./routes/connectionRoutes";
import { registerLivenessRoutes } from "./routes/livenessRoutes";
import { makeBridgeGatewayGate, registerBridgeRoutes } from "./routes/bridgeRoutes";
import { BridgeGateway, resolveGatewaySettings } from "./bridgeGateway";
import { allSettingsMessages, BRIDGE_NAMES, type BridgesFile } from "./bridgeSettings";
import { BridgeSettingsSigner } from "./bridgeSettingsSigning";
import { makeEcosystemHealthGate, registerEcosystemHealthRoutes } from "./routes/ecosystemHealthRoutes";
import { makePushGate, registerPushRoutes } from "./routes/pushRoutes";
import { PushDevices, PushService, emitPush } from "./pushNotifications";
import type { PushFile } from "./securityConfig";
import { LastSeenMemory, collectEcosystemHealth } from "./ecosystemHealth";
import { RobotLivenessTracker } from "./robotLiveness";
import { connectionTracker, setRecordAddress } from "./connections";
import { registerTotpRoutes } from "./routes/totpRoutes";
import { registerSettingsRoutes } from "./routes/settings";
import { registerStaticRoutes } from "./routes/staticRoutes";
import { registerAssistantRoutes } from "./routes/assistantRoutes";
import { registerLocalAiRoutes, registerRulConfigRoute, rulSettings } from "./routes/localAiRoutes";
import { registerInfoRoutes } from "./routes/infoRoutes";
import { registerPowerRoutes } from "./routes/powerRoutes";
import { registerIngestRoutes } from "./routes/ingestRoutes";
import { registerTrustRoutes } from "./routes/trustRoutes";
import { recordVoiceEvent } from "./voiceChain";
import { SWITCH_ANOMALY_FEED, SWITCH_ANOMALY_VOICE_RELAY, anomalyTopicFromEnv } from "./anomalyFeed";
import { startAnomalyFeed, type AnomalyFeedClient, type VoiceRelay } from "./anomalyFeedBroker";
import { makeIngest, switchOn, SWITCH_FAULT_FEED, faultTopicFromEnv, type Ingest } from "./ingestFeeds";
import { startFaultFeed, type FaultFeedClient } from "./faultFeedBroker";
import { registerWorksRoutes } from "./routes/worksRoutes";
import { createSettingsStore, settingsStoreOptionsFromEnv, sweepOrphanedTmpFiles } from "./settingsStore";
import { createCameraSupervisor } from "./cameraSupervisor";
import { createPlayback } from "./playback";
import { createWsHub, attachWebSocketServer } from "./ws";
import { createTelemetryProducer } from "./telemetryProducer";
import { NODE_ENV, JWT_SECRET, authenticate, asyncHandler, requireAdmin, requireOperator, stopAllRateLimiter, setRateLimitSettingsProvider } from "./auth";
import { VOICE_UI_URL, VOICE_UI_TOKEN, VOICE_UI_TIMEOUT_MS, DATALAKE_URL, DATALAKE_TIMEOUT_MS, CONNECTOR_HUB_URL, CONNECTOR_HUB_GATE_URL, SEMANTIC_PLANNER_URL, HIL_BRIDGE_URL, SAFETY_ZONES_URL, ATC_URL, CONNECTOR_HUB_TIMEOUT_MS, SPI_BRIDGE_URL, SPI_BRIDGE_VERSION_TIMEOUT_MS, SPI_BRIDGE_FLASH_TIMEOUT_MS } from "./upstreamConfig";
import { LOG_FILE, bonjour, setupDiscovery, loadServerConfig, saveServerConfig, resolvePort, industrialLog, setCurrentPort, getCurrentPort, closeLog, setLogRedaction } from "./runtime";
import { setSignatureRequirement } from "./voiceConfirm";

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
  // TLS is the default of a new installation only (src/newInstallTls.ts); an existing one is left as it is.
  applyNewInstallTlsDefault({ env: process.env, dataDir: path.join(process.cwd(), "data"), load: loadServerConfig, save: saveServerConfig, log: industrialLog });
  sweepOrphanedTmpFiles(path.join(process.cwd(), "data"), industrialLog);

  const app = express();
  app.disable("x-powered-by"); // no header names the framework (the public key set and every other answer)
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

  // Trusted networks (off unless an administrator turned them on, see src/trustedNetworks.ts): from outside the house and its VPN the
  // server refuses to be administered. The settings and the audit log are read when a request arrives, so a change applies at once.
  app.use(makeTrustedNetworksGate(() => security.trustedNetworks(), { record: (entry) => { audit.record(entry as any); } }));

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
  const prunedAtStartup = pruneExpiredRefreshTokens(clientId => connectionTracker().endedClient(clientId, "session_expired"));
  if (prunedAtStartup > 0) industrialLog(`[STARTUP] Removed ${prunedAtStartup} expired refresh token(s).`);
  setInterval(() => {
    const pruned = pruneExpiredRefreshTokens(clientId => connectionTracker().endedClient(clientId, "session_expired"));
    if (pruned > 0) industrialLog(`[MAINTENANCE] Removed ${pruned} expired refresh token(s).`);
  }, 6 * 60 * 60 * 1000).unref();
  // The history of connections is written when something changed and the last write was a while ago.
  setInterval(() => connectionTracker().tick(), 30_000).unref();

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

  // Off unless HYDRA_UMC_TELEMETRY_COLLECTOR_URL is set: then every robot delta also becomes a sample for the telemetry collector.
  const telemetryProducer = createTelemetryProducer();
  if (telemetryProducer) {
    telemetryProducer.start();
    console.log("[STARTUP] Sending robot telemetry to the collector (HYDRA_UMC_TELEMETRY_COLLECTOR_URL)");
  }
  // Off unless an administrator (or HYDRA_UMC_BLE_GATT) turns the Bluetooth LE service on: then the phones near the CM5 get the state and, in "commands" mode, may send commands.
  let bleGateway: BleGateway | null = null;
  // Off unless an administrator (or HYDRA_UMC_MQTT_BRIDGE) turns the MQTT bridge on: then the robots' state goes to the broker of the cell and, in "commands" mode, a command published there is carried out.
  let mqttBridge: MqttBridge | null = null;
  let jobStopRelay: JobStopRelay | null = null;
  let orchestratorTakeover: OrchestratorTakeover | null = null;
  const livenessTracker = new RobotLivenessTracker();
  const hub = createWsHub({
    setSettings,
    onRobotDelta: (deltas) => {
      for (const delta of deltas) livenessTracker.touch(delta.robotId, "state");
      telemetryProducer?.record(deltas);
    },
    onStateChanged: () => { bleGateway?.publishState(); mqttBridge?.publishState(); },
  });
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
    // Robot ids are global: a tree that would repeat an id (one that was not already repeated) is refused before anything is stored or broadcast.
    const added = newRobotIdConflicts(getSettings(), payload);
    if (added.length > 0) {
      industrialLog(`[ROBOT-IDS] settings refused: robot id(s) ${added.map((c) => `${c.robotId} (controllers: ${c.controllers.join(", ")})`).join("; ")} would be used by more than one robot.`);
      throw new RobotIdDuplicatedError(added);
    }
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

  // Ids repeated by a configuration of an older version: the server starts, the routes by those ids answer 409 (see src/robotIds.ts) and the log says so.
  for (const line of ambiguousRobotLogLines(getSettings())) industrialLog(line);

  registerStaticRoutes(app, { dataPath });

  // The signed tokens of one device (off by default: deviceTokens.enabled). The sign-in of a device and the renewal of its session live with the other sign-in routes.
  const deviceTokens = new DeviceTokenStore({ file: path.join(dataPath, "device-tokens.json"), key: deviceTokenKey(JWT_SECRET) });
  const deviceTokenLimits = () => (loadServerConfig() as { deviceTokens?: DeviceTokenLimits }).deviceTokens;
  registerAuthRoutes(app, { trustedNetworks: () => security.trustedNetworks(), devices: { enabled: () => security.deviceTokensEnabled(), store: deviceTokens, limits: deviceTokenLimits } });
  registerDeviceRoutes(app, { authenticate, requireAdmin, enabled: () => security.deviceTokensEnabled(), store: deviceTokens, limits: deviceTokenLimits, audit });
  registerConnectionRoutes(app);
  registerTotpRoutes(app);

  // Who may use the local AI relay, whether the host information asks for a sign-in, and TLS: the
  // environment of the deployment wins, then what an administrator saved from the control app.
  const startupTls = resolveTls(securityEnvFrom(process.env), loadServerConfig());
  // After the two replanning options are written into the file of the job dispatcher, it is asked to read the file again: see src/dispatcherReload.ts.
  let dispatcherReloadState: "none" | "pending" | "applied" | "failed" = "none";
  const dispatcherReloadSettings = () => {
    const jd = (loadServerConfig() as { jobDispatcher?: { reload?: ReloadFile; stopRelay?: { url?: unknown } } }).jobDispatcher;
    return resolveReload(process.env, jd?.reload, jd?.stopRelay?.url);
  };
  // The settings of the machine bridges are announced SIGNED; one key per bridge, in a file (src/bridgeSettingsSigning.ts).
  const bridgeSettingsSigner = new BridgeSettingsSigner({ log: industrialLog });
  const security = new SecurityConfig({
    env: securityEnvFrom(process.env),
    load: loadServerConfig,
    save: (file) => {
      const { aiAccess, infoAuth, tls, ble, mqtt, voice, mavlink, robots, connections, health, ecosystemHealth, infoTickets, deviceTokens, updateCheck, discovery, maintenance, atc, detectionHef, auth, presence, bridgeGateway, push, trustedNetworks, rul, safety, jobDispatcher, camera, install, websocket, logging, rateLimits, bridges } = file;
      saveServerConfig({ ...loadServerConfig(), aiAccess, infoAuth, tls, ble, mqtt, voice, mavlink, robots, connections, health, ecosystemHealth, infoTickets, deviceTokens, updateCheck, discovery, maintenance, atc, detectionHef, auth, presence, bridgeGateway, push, trustedNetworks, rul, safety, jobDispatcher, camera, install, websocket, logging, rateLimits, bridges });
    },
    bridgeSigningStatus: () => bridgeSettingsSigner.status(BRIDGE_NAMES),
    writeDetectionHefSettings: (value, file) => { const written = writeDetectionHefSettings(dataPath, value, file); industrialLog(`[SECURITY] DETECTION-HEF settings file written: ${written}`); },
    afterBridgesWritten: () => { if (security.bridgeGatewayEnabled()) { bridgeGateway.ensureStarted(); bridgeGateway.announceSettings(); } },
    tlsActive: startupTls.enabled,
    bleActiveMode: resolveBleMode(securityEnvFrom(process.env).bleGatt, loadServerConfig()).value,
    mqttActiveMode: resolveMqttMode(securityEnvFrom(process.env).mqtt?.mode, loadServerConfig()).value,
    dispatcherReload: () => {
      const resolved = dispatcherReloadSettings();
      return !resolved.ok || resolved.settings.url === "" ? "not_configured" : dispatcherReloadState;
    },
    afterReplanWritten: () => {
      const resolved = dispatcherReloadSettings();
      if (!resolved.ok || resolved.settings.url === "") return;
      dispatcherReloadState = "pending";
      void reloadDispatcher({ settings: resolved.settings, fetch: (url, init) => fetch(url, init) }).then((outcome) => {
        dispatcherReloadState = outcome.ok ? "applied" : "failed";
        industrialLog(outcome.ok ? "[dispatcher] the job dispatcher read its configuration file again." : `[dispatcher] the job dispatcher did not take the new configuration (${outcome.reason}); it reads the file when it starts.`);
        audit.record({ type: "job-dispatcher-reload", outcome: outcome.ok ? "ok" : "failed", detail: outcome.ok ? {} : { reason: outcome.reason } });
      });
    },
    jobStopRelayActive: (() => { const r = resolveStopRelay(process.env, (loadServerConfig() as { jobDispatcher?: { stopRelay?: StopRelayFile } }).jobDispatcher?.stopRelay); return r.ok && r.settings.enabled; })(),
    log: industrialLog,
  });
  // Whether the history of connections keeps the address and user agent of a client (off unless an administrator turned it on).
  setRecordAddress(() => security.connectionAddressRecorded());
  // The request limiters read the switch and their numbers from the security options on every request, so a change in Server Admin applies at once.
  setRateLimitSettingsProvider(() => security.rateLimits());

  // Which algorithm signs the login tokens and which ones the verifier accepts is read from the security options on every token.
  setJwtPolicyProvider(() => security.jwtPolicy());
  // Whether the calls of this server to the services carry its signed token (auth.serviceIdentity.enabled, HYDRA_UMC_SERVICE_IDENTITY).
  setServiceIdentitySwitch(() => security.serviceIdentityEnabled());
  // What the ingest code reads: the environment of the server with the switches saved in Server Admin put in where it does not say (it wins).
  const ingestEnv = () => security.ingestEnv(process.env, dataPath);
  setKeyOverlapProvider(() => security.keyOverlapSeconds());
  if (security.jwtPolicy().algorithm === "EdDSA") {
    try { jwtKeyStore().ensureActive(); } catch (error) { throw new Error(`auth.jwtAlgorithm is EdDSA but the key file (${jwtKeyStore().file}) cannot be used: ${(error as Error).message}`); }
  }
  registerAdminRoutes(app, {
    authenticate, requireAdmin, asyncHandler, industrialLog, wsClients,
    logFile: LOG_FILE, getCurrentPort, loadServerConfig, saveServerConfig, security, audit,
  });

  registerSettingsRoutes(app, { authenticate, requireAdmin, loadFullSettingsFromDisk, applySettingsUpdate, getSettings });

  registerAssistantRoutes(app, { authenticate, getSettings, security, onVoiceEvent: (event) => { recordVoiceEvent(ingest().voice, event, ingestEnv(), industrialLog); }, nodeState: (node) => (switchOn(SWITCH_ANOMALY_FEED, ingestEnv()) ? ingest().anomaly.stateOfNode(node) : "off") });

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
    broadcastCommandLifecycle: (event) => hub.broadcastCommandLifecycle(event),
    robotEnableAllowed: () => security.robotEnableAllowed(),
    // A global stop is also announced on the MQTT bridge only when an administrator allowed it (safety.publishGlobalStop, off by default).
    announceGlobalStop: () => (security.globalStopPublished() ? mqttBridge?.publishSafety("SAFE_STOP", "global stop") ?? false : undefined),
    announceGlobalStopReleased: () => (security.globalStopPublished() ? mqttBridge?.publishSafety("READY", "global stop released") ?? false : false),
    requireAdmin,
  });

  registerLivenessRoutes(app, {
    authenticate, requireOperator, getSettings, tracker: livenessTracker,
    staleAfterS: () => (loadServerConfig() as { liveness?: { staleAfterS?: unknown } }).liveness?.staleAfterS,
  });

  // The gateway to the machine bridges: off unless an administrator turned it on (bridgeGateway.enabled); it connects to the broker of the MQTT
  // settings the first time a client asks, and says nothing about a bridge that has not announced itself.
  const bridgeGatewayEnv = securityEnvFrom(process.env).mqtt ?? {};
  const bridgeGateway = new BridgeGateway({
    getSettings: () => resolveGatewaySettings((loadServerConfig() as { bridgeGateway?: import("./bridgeGateway").BridgeGatewayFile }).bridgeGateway),
    url: security.mqtt().url,
    username: security.mqtt().username,
    password: readSecret(bridgeGatewayEnv.password, bridgeGatewayEnv.passwordFile),
    getBridgeSettings: (prefix) => allSettingsMessages((loadServerConfig() as { bridges?: BridgesFile }).bridges, bridgeSettingsSigner, prefix),
    log: industrialLog,
  });
  registerBridgeRoutes(app, {
    authenticate, requireOperator, bridgeGatewayGate: makeBridgeGatewayGate(() => security.bridgeGatewayEnabled()), gateway: bridgeGateway, audit,
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

  // The dead-man of the presence of the operator (POST /api/operator/presence), behind the switch presence.enabled (off by default: 404). The action of a lost
  // heartbeat (slow down by default) and the times come from Server Admin and data/server-config.json; the global stop is never held back by it.
  const operatorPresence = new OperatorPresence({
    enabled: () => security.presenceEnabled(),
    settings: () => presenceSettings((loadServerConfig() as { presence?: import("./securityConfig").PresenceFile }).presence, security.presenceAction()),
    now: () => Date.now(),
    getSettings,
    isReservationActive,
    stoppedPlaybackState,
    stopServerPlayback,
    disarm: (robotId) => arming.disarm(robotId),
    broadcastRobotDelta,
    persist: () => queueSettingsWrite(getSettings()),
    log: industrialLog,
    audit: (event) => { audit.record(event); },
    warn: (robotNames) => emitPush("presence-lost", { robotName: robotNames.join(", ") }),
  });
  registerPresenceRoutes(app, { authenticate, requireOperator, presenceGate: makePresenceGate(() => security.presenceEnabled()), presence: operatorPresence });
  setInterval(() => { try { operatorPresence.tick(); } catch (error) { industrialLog(`[PRESENCE] the check failed (${error instanceof Error ? error.message : "unknown error"}).`); } }, 1000).unref();

  // The live pictures and the saved photos and recordings ask for a ticket (POST /api/camera/ticket) or a signed-in client unless the installation opts out with
  // HYDRA_UMC_CAMERA_AUTH=open, for the clients that do not ask for tickets yet.
  // The read-only host and project information (metrics, the process supervisor, the ecosystem status, the model catalogue) used to answer anybody on the LAN. HYDRA_UMC_INFO_AUTH=required
  // makes it ask for a signed-in client, once every client sends its token on those requests; until then it stays as it was, and a production start says so.
  if (!security.infoAuthRequired() && NODE_ENV === "production") {
    console.warn("[SECURITY] Host metrics, the process supervisor and the ecosystem status are readable by the whole LAN. Set HYDRA_UMC_INFO_AUTH=required once every client sends its token on them.");
  }
  // With the signed tickets of the information routes on (infoTickets.enabled, off by default) a valid `?ticket=` from POST /api/info/ticket also opens them,
  // for a dashboard or a scraper that cannot send a bearer token; a ticket never opens anything else.
  const INFO_KEY = infoTicketKey(JWT_SECRET);
  const infoAccess = (req: express.Request, res: express.Response, next: express.NextFunction) => {
    if (!security.infoAuthRequired()) return next();
    if (security.infoTicketsEnabled() && verifyInfoTicket(INFO_KEY, req.query.ticket, Date.now()) !== null) return next();
    return authenticate(req, res, next);
  };
  const MEDIA_KEY = mediaTicketKey(JWT_SECRET);
  // Each of the three options below comes from the environment of the deployment first, then from what an administrator saved in Server Admin; read on every request.
  if (security.cameraOpen()) {
    console.warn("[SECURITY] The camera pictures are open to the whole LAN (HYDRA_UMC_CAMERA_AUTH=open or Server Admin). Close them once every client asks for a ticket (POST /api/camera/ticket).");
  }
  const WS_QUERY_TOKEN_ALLOWED = () => security.wsQueryTokenAllowed();
  if (WS_QUERY_TOKEN_ALLOWED()) {
    console.warn("[SECURITY] /ws?token= is accepted (HYDRA_UMC_WS_QUERY_TOKEN=allow or Server Admin), so the token is recorded in proxy and server logs. Forbid it once every client sends the hydra.bearer subprotocol.");
  }
  setLogRedaction(() => security.logRedactionOn());
  setCameraCredentialsViaEnv(() => security.cameraCredentialsViaEnv());
  setSignatureRequirement(() => security.voiceSignatureRequired());
  const mediaAccess = (req: express.Request, res: express.Response, next: express.NextFunction) => {
    if (security.cameraOpen()) return next();
    if (verifyMediaTicket(MEDIA_KEY, req.query.ticket, Date.now()) !== null) return next();
    return authenticate(req, res, next);
  };
  const issueMediaTicketFor = (username: string) => issueMediaTicket(MEDIA_KEY, username, Date.now());
  const { resolveWithinDataDir } = registerWorksRoutes(app, { authenticate, requireAdmin, infoAccess, dataPath, getSettings, audit });

  registerCameraRoutes(app, { authenticate, requireAdmin, mediaAccess, issueMediaTicket: issueMediaTicketFor, dataPath, resolveWithinDataDir, cameraProcesses });

  if (security.aiAdminOnly()) console.log("[SECURITY] The local AI relay (/api/ai/*) answers administrators only.");
  const rulNow = () => rulSettings(security.rulEnabled(), (loadServerConfig() as { rul?: unknown }).rul);
  registerLocalAiRoutes(app, { authenticate, requireAdmin, requireOperator, adminOnly: () => security.aiAdminOnly(), rul: rulNow });
  // What the dashboard of the AI summaries reads to know whether to show its remaining-useful-life card: any signed-in account, read only.
  registerRulConfigRoute(app, { authenticate, rul: rulNow });

  registerSystemRoutes(app, {
    authenticate, requireAdmin, industrialLog, infoAccess,
    infoTickets: { enabled: () => security.infoTicketsEnabled(), key: INFO_KEY, limits: () => (loadServerConfig() as { infoTickets?: InfoTicketLimits }).infoTickets },
  });

  // The health of the services of the ecosystem in one answer, behind a switch of Server Admin (off by default: 404).
  const ecosystemHealthMemory = new LastSeenMemory({ file: path.join(process.cwd(), "data", "ecosystem-health-last-seen.json") });
  const ecosystemHealthConfig = () => (loadServerConfig() as { ecosystemHealth?: { certWarnDays?: unknown; probeTimeoutMs?: unknown; lastSeenMaxEntries?: unknown; lastSeenSaveIntervalS?: unknown } }).ecosystemHealth;
  // Push notifications to the phones that registered a device token: off by default; the credentials of the Apple push service come
  // from the environment only (src/pushNotifications.ts).
  const pushConfig = () => (loadServerConfig() as { push?: PushFile }).push;
  const pushDevices = new PushDevices({
    file: path.join(process.cwd(), "data", "push-devices.json"),
    maxDevices: () => { const n = Number(pushConfig()?.maxDevices); return Number.isInteger(n) && n >= 1 && n <= 10000 ? n : 500; },
  });
  const pushService = new PushService({ enabled: () => security.pushEnabled(), config: pushConfig, devices: pushDevices, env: () => process.env, log: industrialLog });
  registerPushRoutes(app, { authenticate, requireAdmin, pushGate: makePushGate(() => security.pushEnabled()), devices: pushDevices, status: () => pushService.status(), audit });
  registerEcosystemHealthRoutes(app, {
    authenticate, requireOperator,
    ecosystemHealthGate: makeEcosystemHealthGate(() => security.ecosystemHealthEnabled()),
    collect: (admin) => collectEcosystemHealth({
      memory: ecosystemHealthMemory,
      certificatePath: () => (startupTls.enabled ? startupTls.certPath : null),
      certWarnDays: () => ecosystemHealthConfig()?.certWarnDays,
      probeTimeoutMs: () => ecosystemHealthConfig()?.probeTimeoutMs,
      lastSeenMaxEntries: () => ecosystemHealthConfig()?.lastSeenMaxEntries,
      lastSeenSaveIntervalS: () => ecosystemHealthConfig()?.lastSeenSaveIntervalS,
    }, admin),
  });

  registerBluetoothRoutes(app, { authenticate, requireAdmin, industrialLog });

  // the signed channel to the node watchdog: built on the first use (a registry file fixed later is picked up) and then kept, so the
  // nonces of the replies it has seen are kept too
  let opsAgentChannelCache: OpsAgentChannel | null | undefined;
  const opsAgentChannel = (): OpsAgentChannel | null => (opsAgentChannelCache === undefined ? (opsAgentChannelCache = channelFromEnv()) : opsAgentChannelCache);

  registerUpstreamRoutes(app, {
    authenticate, requireAdmin, industrialLog, wsClients, DATALAKE_URL, DATALAKE_TIMEOUT_MS, CONNECTOR_HUB_URL,
    CONNECTOR_HUB_TIMEOUT_MS, SPI_BRIDGE_URL, SPI_BRIDGE_VERSION_TIMEOUT_MS, SPI_BRIDGE_FLASH_TIMEOUT_MS,
    CONNECTOR_HUB_GATE_URL, SEMANTIC_PLANNER_URL, HIL_BRIDGE_URL, SAFETY_ZONES_URL, ATC_URL, requireOperator, audit, opsAgentChannel,
    atcResetEnabled: () => security.atcResetEnabled(), robotMotion: robotMotionOf(getSettings),
  });

  registerInfoRoutes(app, {
    infoAccess, getSettings, REMOTE_API_VERSION, healthOpen: () => security.healthOpen(),
    // The addresses of this server on the local network, only while an administrator allowed it (discovery.advertiseAddress, off by default).
    addresses: () => (security.advertiseAddressEnabled() ? advertisedAddresses({ port: PORT, tls: startupTls.enabled }) : []),
  });

  // The newest published version of each program, behind a switch of Server Admin (updateCheck.enabled, off by default: 404). It asks GitHub; nothing else leaves the server.
  registerUpdateRoutes(app, { authenticate, requireAdmin, enabled: () => security.updateCheckEnabled(), getStatus: () => getEcosystemStatus(), config: () => (loadServerConfig() as { updateCheck?: UpdateCheckSettings }).updateCheck });

  // Install, go back and prune the releases of the programs installed here, behind a switch of Server Admin (maintenance.enabled, off by default: 404).
  registerMaintenanceRoutes(app, { authenticate, requireAdmin, enabled: () => security.maintenanceEnabled(), audit, maintenance: new Maintenance({ settings: () => maintenanceSettings((loadServerConfig() as { maintenance?: MaintenanceFile }).maintenance, dataPath) }) });

  registerPowerRoutes(app, { audit });

  // What the sibling services hand to this server (scenario outcomes, the status of the developer node, the faults of the machines):
  // each one is off until its switch is "1", and the stores are built on the first use
  let ingestCache: Ingest | undefined;
  const ingest = (): Ingest => (ingestCache ??= makeIngest(path.join(dataPath, "ingest")));
  registerIngestRoutes(app, { authenticate, requireOperator, ingest, audit, env: ingestEnv });
  registerTrustRoutes(app, { authenticate, requireAdmin, requireOperator, ingest, audit, env: ingestEnv });

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

  attachWebSocketServer(httpServer, {
    wsClients, getSettings, applySettingsUpdate, WS_QUERY_TOKEN_ALLOWED,
    adminWriteAllowed: (address) => { const networks = security.trustedNetworks(); return !networks.enabled || classifyAddress(address, networks) === "local"; },
  });

  httpServer.listen(PORT, "0.0.0.0", () => {
    const serverName = realSettings(getSettings())?.serverName || "HYDRA-UMC STUDIO";
    setupDiscovery(serverName);
    industrialLog(`=================================================`);
    industrialLog(` HYDRA-UMC SERVER: ${serverName}`);
    industrialLog(` STATUS: Running on port ${PORT} (${tlsEnabled ? "HTTPS/WSS" : "HTTP/WS"})`);
    industrialLog(` DISCOVERY: Active (mDNS + ${tlsEnabled ? "HTTPS + WSS" : "HTTP + WS"})`);
    industrialLog(`=================================================`);
    const ble = security.ble();
    void startBle({
      mode: ble.mode,
      requireEncryption: ble.requireEncryption,
      file: ble.file,
      port: PORT,
      tls: tlsEnabled,
      getState: () => redactSettingsSecrets(getSettings()),
      allowedCommands: ROBOT_COMMANDS,
      log: industrialLog,
    }).then((gateway) => {
      bleGateway = gateway;
    });
    // The hand-over of the missions to a standby orchestrator, with the proofs of the stops (off unless jobDispatcher.takeover.enabled or HYDRA_UMC_ORCH_TAKEOVER=1): see src/orchestratorTakeover.ts.
    const takeoverResolution = resolveTakeover(process.env, (loadServerConfig() as { jobDispatcher?: { takeover?: TakeoverFile } }).jobDispatcher?.takeover);
    if (!takeoverResolution.ok) {
      industrialLog(`[takeover] NOT STARTED: ${takeoverResolution.error}`);
    } else if (takeoverResolution.settings.enabled) {
      orchestratorTakeover = new OrchestratorTakeover({
        settings: takeoverResolution.settings,
        fetch: (url, init) => fetch(url, init),
        now: () => Date.now(),
        log: industrialLog,
        audit: (event) => audit.record({ type: event.type, outcome: event.outcome, detail: event.detail }),
      });
      orchestratorTakeover.start({ set: (fn, ms) => setTimeout(fn, ms), clear: (handle) => clearTimeout(handle as NodeJS.Timeout) });
      industrialLog(`[takeover] ON: watching ${takeoverResolution.settings.primaryUrl}; the standby is ${takeoverResolution.settings.standbyUrl}`);
    }
    // The delivery of the stop that the job dispatcher asks for (off unless jobDispatcher.stopRelay.enabled or HYDRA_UMC_JOB_STOP_RELAY=1): see src/jobStopRelay.ts.
    const relayResolution = resolveStopRelay(process.env, (loadServerConfig() as { jobDispatcher?: { stopRelay?: StopRelayFile } }).jobDispatcher?.stopRelay);
    if (!relayResolution.ok) {
      industrialLog(`[stop-relay] NOT STARTED: ${relayResolution.error}`);
    } else if (relayResolution.settings.enabled) {
      // The map of robots is edited in Server Admin: it is read again at every pass, so a change needs no restart.
      const relaySettings = relayResolution.settings;
      Object.defineProperty(relaySettings, "robotMap", { get: () => security.jobStopRobotMap(), enumerable: true });
      jobStopRelay = new JobStopRelay({
        settings: relaySettings,
        fetch: (url, init) => fetch(url, init),
        now: () => Date.now(),
        log: industrialLog,
        audit: (event) => audit.record({ type: event.type, outcome: event.outcome, robotId: event.robotId, detail: event.detail }),
        onAcknowledged: (jobId, robotId) => orchestratorTakeover?.recordProof(jobId, robotId),
        stopRobot: (robotId) => {
          // The same stop as the single-robot "stop" command: no claim holds it back.
          for (const controller of getSettings()?.controllers ?? []) {
            const robot = controller.robots?.find((r: any) => r.id === robotId);
            if (!robot) continue;
            robot.playbackState = stoppedPlaybackState(robot.playbackState);
            arming.disarm(robotId);
            stopServerPlayback(robotId);
            broadcastRobotDelta([{ controllerId: controller.id, robotId, patch: { playbackState: robot.playbackState } }], getSettings());
            void queueSettingsWrite(getSettings()).catch(() => undefined);
            onClaimsChanged();
            return true;
          }
          return false;
        },
      });
      jobStopRelay.start({ set: (fn, ms) => setTimeout(fn, ms), clear: (handle) => clearTimeout(handle as NodeJS.Timeout) });
      industrialLog(`[stop-relay] ON: delivering the stop requests of ${relayResolution.settings.url} every ${relayResolution.settings.pollSeconds} s`);
    }
    mqttBridge = startMqttBridge({
      settings: security.mqtt(),
      env: securityEnvFrom(process.env).mqtt ?? {},
      port: PORT,
      tls: tlsEnabled,
      getSettings: () => redactSettingsSecrets(getSettings()),
      allowedCommands: ROBOT_COMMANDS,
      log: industrialLog,
    });
  });

  let faultFeedClient: FaultFeedClient | null = null;
  security.noteIngestStarted();
  if (switchOn(SWITCH_FAULT_FEED, ingestEnv())) {
    const mqttSettings = security.mqtt();
    const mqttEnv = securityEnvFrom(process.env).mqtt ?? {};
    if (mqttSettings.url) {
      faultFeedClient = startFaultFeed(ingest().faults, { url: mqttSettings.url, username: mqttSettings.username, password: readSecret(mqttEnv.password, mqttEnv.passwordFile), topic: faultTopicFromEnv(), log: industrialLog });
    } else {
      industrialLog("[faults] the feed is on but there is no broker URL in the MQTT settings: it stays idle");
    }
  }

  // The verdicts of the anomaly detector, read from the broker (off until HYDRA_UMC_ANOMALY_FEED is "1"); with HYDRA_UMC_ANOMALY_VOICE_RELAY
  // also "1" and the voice interface configured, a verdict that changes to suspect or anomalous is told to it.
  let anomalyFeedClient: AnomalyFeedClient | null = null;
  if (switchOn(SWITCH_ANOMALY_FEED, ingestEnv())) {
    const mqttSettings = security.mqtt();
    const mqttEnv = securityEnvFrom(process.env).mqtt ?? {};
    if (mqttSettings.url) {
      const relay: VoiceRelay | null = switchOn(SWITCH_ANOMALY_VOICE_RELAY, ingestEnv()) && VOICE_UI_URL
        ? {
            locale: (process.env.HYDRA_UMC_ANOMALY_VOICE_LOCALE ?? "en").trim() || "en",
            send: async (body) => {
              const upstream = await fetch(`${VOICE_UI_URL}/v1/voice/alert`, {
                method: "POST",
                headers: { "content-type": "application/json", ...(VOICE_UI_TOKEN ? { authorization: `Bearer ${VOICE_UI_TOKEN}` } : identityHeader("operator")) },
                body: JSON.stringify(body),
                signal: AbortSignal.timeout(VOICE_UI_TIMEOUT_MS),
              });
              return upstream.ok ? ((await upstream.json().catch(() => null)) as Record<string, unknown> | null) : null;
            },
          }
        : null;
      anomalyFeedClient = startAnomalyFeed(ingest().anomaly, { url: mqttSettings.url, username: mqttSettings.username, password: readSecret(mqttEnv.password, mqttEnv.passwordFile), topic: anomalyTopicFromEnv(), log: industrialLog, relay });
    } else {
      industrialLog("[anomaly] the feed is on but there is no broker URL in the MQTT settings: it stays idle");
    }
  }

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
    void bleGateway?.stop().catch(() => undefined);
    void mqttBridge?.stop().catch(() => undefined);
    void faultFeedClient?.stop().catch(() => undefined);
    void anomalyFeedClient?.stop().catch(() => undefined);
    void bridgeGateway.stop().catch(() => undefined);
    jobStopRelay?.stop();
    orchestratorTakeover?.stop();
    try { connectionTracker().flush(); } catch { /* best-effort */ }
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
