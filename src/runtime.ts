// =============================================================================
// HYDRA-UMC-SERVER - src/runtime.ts
// Copyright (C) 2026 JuanenRac (Electro Hobby 3D) <electrohobby3d@gmail.com>
// GPL-3.0 - see LICENSE
// =============================================================================
// The process-level runtime: mDNS advertisement, the saved server config, the port and the
// rotating log file, moved out of server.ts unchanged.
import { redactSecrets } from "./redaction";
import path from "path";
import fs from "fs";
import Bonjour from "bonjour-service";
import { resolveLogKeep, resolveLogMaxBytes, rotateLogFiles } from "./logRotation";

// Bonjour/mDNS service for instant discovery
export const bonjour = new Bonjour();
let mdnsService: any = null;
// Set once in startServer() below, from resolvePort() - module-scoped
// (rather than threaded as a parameter through every setupDiscovery() call
// site, including the one inside broadcastSettings() reacting to a
// serverName change) so the mDNS advertisement always matches whatever
// port this process is actually listening on, even after an admin-UI
// config change (see resolvePort()'s own comment - takes effect on the
// next restart, same as the HTTP listener itself).
let currentPort = 3000;
export function setCurrentPort(port: number): void { currentPort = port; }
export function getCurrentPort(): number { return currentPort; }
export function closeLog(): void { logStream.end(); }

export function setupDiscovery(serverName: string) {
  if (mdnsService) mdnsService.stop();
  mdnsService = bonjour.publish({ name: serverName, type: 'hydra', port: currentPort });
  console.log(`[mDNS] Advertising as ${serverName}.local (_hydra._tcp)`);
}

// Log rotation utility
export const LOG_FILE = path.join(process.cwd(), "data", "logs", "server.log");
if (!fs.existsSync(path.dirname(LOG_FILE))) fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });

// Admin-UI-editable server config (currently just the listen port) -
// separate from data/settings.json (robot/controller state, a much larger
// and more frequently-written file) since this is small, rarely changes,
// and is read once at startup rather than kept live in memory throughout.
const SERVER_CONFIG_FILE = path.join(process.cwd(), "data", "server-config.json");

import type { BleFile } from "./securityConfig";
import type { MqttFile } from "./mqttBridge";
import type { MavlinkFile, VoiceFile } from "./securityConfig";

export interface ServerConfig {
  port?: number;
  aiAccess?: "open" | "admin";
  infoAuth?: boolean;
  tls?: { enabled?: boolean; certPath?: string; keyPath?: string };
  ble?: BleFile;
  mqtt?: MqttFile;
  voice?: VoiceFile;
  mavlink?: MavlinkFile;
}

export function loadServerConfig(): ServerConfig {
  try {
    return JSON.parse(fs.readFileSync(SERVER_CONFIG_FILE, "utf-8"));
  } catch {
    return {};
  }
}

export function saveServerConfig(config: ServerConfig) {
  fs.mkdirSync(path.dirname(SERVER_CONFIG_FILE), { recursive: true });
  // Written next to the real file and renamed over it, so a cut in the middle never leaves a half file.
  const tmp = `${SERVER_CONFIG_FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(config, null, 2));
  fs.renameSync(tmp, SERVER_CONFIG_FILE);
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
export function resolvePort(): number {
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
// HYDRA_UMC_LOG_KEEP raises the history to that many files (.1 .. .N) and
// HYDRA_UMC_LOG_MAX_BYTES moves the size at which the live file rotates; unset
// they keep one rotated file and 10 MB.
const MAX_LOG_BYTES = resolveLogMaxBytes(process.env.HYDRA_UMC_LOG_MAX_BYTES);
const LOG_KEEP = resolveLogKeep(process.env.HYDRA_UMC_LOG_KEEP);

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
    rotateLogFiles(LOG_FILE, LOG_KEEP);
  } catch (err) {
    console.error("[industrialLog] log rotation failed", err);
  }
  logStream = fs.createWriteStream(LOG_FILE, { flags: "a" });
  logStream.on("error", (err) => console.error("[industrialLog] log stream error", err));
}

// Every log line goes through the shared secret redaction; the option exists
// for debugging on a bench only (HYDRA_UMC_LOG_REDACTION=off).
const LOG_REDACTION_ON = (process.env.HYDRA_UMC_LOG_REDACTION ?? "").trim().toLowerCase() !== "off";

export function industrialLog(rawMsg: string) {
  const msg = LOG_REDACTION_ON ? redactSecrets(rawMsg) : rawMsg;
  const entry = `[${new Date().toISOString()}] ${msg}\n`;
  console.log(msg);
  rotateLogIfNeeded();
  logStream.write(entry);
}
