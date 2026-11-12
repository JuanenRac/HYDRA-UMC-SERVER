// =============================================================================
// HYDRA-UMC-SERVER - src/securityConfig.ts
// Copyright (C) 2026 JuanenRac (Electro Hobby 3D) <electrohobby3d@gmail.com>
// GPL-3.0-or-later - see LICENSE
// =============================================================================
// The three access options an administrator can change from the Server Admin screen of the
// control app instead of an environment variable: who may use the local AI relay, whether the
// read-only host information asks for a signed-in client, and TLS (with the fingerprint of the
// certificate in use). The order is always: the environment of the deployment wins, then what
// the administrator saved in data/server-config.json, then the built-in default (the behaviour
// the server always had: AI relay open to any signed-in user, host information open, plain HTTP, no
// Bluetooth).
import { DEFAULT_LIVE_ACTIVITY_LEVEL, LIVE_ACTIVITY_LEVELS, MAX_LIVE_ACTIVITY_LEVEL, isLevel as isLiveLevel, raisesExposure, type LiveActivityLevel } from "./liveActivity";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import tls from "node:tls";
import { DispatcherConfigError, readReplanOptions, validTimeout, writeReplanOptions, DEFAULT_STOP_ACK_TIMEOUT_SECONDS } from "./dispatcherConfigFile";
import { applyBridgesPatch, resolveBridgeSettings, type BridgesFile, type BridgesSnapshot } from "./bridgeSettings";
import { DEFAULT_KEY_OVERLAP_SECONDS, JWT_ALGORITHMS, MAX_KEY_OVERLAP_SECONDS, MIN_KEY_OVERLAP_SECONDS, type JwtAlgorithm } from "./jwtKeys";
import { MQTT_MODES, mqttEnvFrom, resolveMqttMode, resolveMqttSettings, validMqttPrefix, validMqttUrl, type MqttEnv, type MqttFile, type MqttMode, type MqttSettings } from "./mqttBridge";

export type AiAccess = "open" | "admin";
export type Source = "env" | "config" | "default";
/** What the Bluetooth LE service of the server does: nothing, only publish the state, or also take commands. */
export type BleMode = "off" | "state" | "commands";

export interface BleFile {
  mode?: BleMode;
  /** The COMMAND characteristic is written, and the state read, only over an encrypted link (default: yes). */
  requireEncryption?: boolean;
  /** The name the device advertises. */
  name?: string;
  /** The least time between two state notifications, the pause between two frames and the commands per second one phone may send. */
  minStateIntervalMs?: number;
  frameDelayMs?: number;
  commandsPerSecond?: number;
  /** The D-Bus path of the adapter (the first one that can advertise when empty) and the program that speaks to BlueZ. */
  adapter?: string;
  helperCommand?: string;
}

export interface TlsFile {
  enabled?: boolean;
  certPath?: string;
  keyPath?: string;
}

/** What the voice relay asks of the voice service on every turn (src/routes/assistantRoutes.ts). */
export interface VoiceFile {
  /** Whether a reply carries the transcript it was made from (default: no; it is personal data). */
  includeHeardText?: boolean;
  /** How sure the speech recognizer must be (0 to 1) before a request that starts a movement is accepted; 0 switches the check off (default 0.6). */
  minConfidence?: number;
  /** Whether a confirmed spoken request must carry a verified signature; with no key shared with the voice service it is then refused (default: no). */
  requireSignature?: boolean;
}

/** What the MAVLink bridge to the vehicle reads from this same file when it starts (HYDRA-UMC-BRIDGE-UAV). */
export interface MavlinkFile {
  /** The file holding the 32-byte MAVLink 2 signing key (never the key itself); empty or absent: no signing. */
  signingKeyFile?: string;
  /** With a key, still accept messages that are not signed (default: no). */
  signingAllowUnsigned?: boolean;
}

/** What the robots may be asked to do from a client. */
export interface RobotsFile {
  /** Whether a disabled robot may be enabled again by the `enable` command (default: no; only the administrator can then do it from the settings). */
  allowEnable?: boolean;
}

/** The settings of a production flash (the controller boards of HYDRA-UMC). */
export interface ProductionFile {
  /** The read-out protection level a production flash sets: 0 = off (the default; nothing is protected), 1 = on. Level 2 is permanent and never offered. */
  rdpLevel?: number;
}

/**
 * The switches of what the sibling services hand to this server and what it keeps of it. Every one is OFF by default; an environment
 * variable of the same name as before (INGEST_SWITCH_VARIABLES) still decides and locks it.
 */
export const INGEST_SWITCH_KEYS = ["faultFeed", "scenario", "developerNode", "anomalyFeed", "anomalyVoiceRelay", "voiceChain", "proposalVerify"] as const;
export type IngestSwitchKey = (typeof INGEST_SWITCH_KEYS)[number];
export const INGEST_SWITCH_VARIABLES: Record<IngestSwitchKey, string> = {
  faultFeed: "HYDRA_UMC_FAULT_FEED",
  scenario: "HYDRA_UMC_INGEST_SCENARIO",
  developerNode: "HYDRA_UMC_INGEST_DEVELOPER_NODE",
  anomalyFeed: "HYDRA_UMC_ANOMALY_FEED",
  anomalyVoiceRelay: "HYDRA_UMC_ANOMALY_VOICE_RELAY",
  voiceChain: "HYDRA_UMC_VOICE_CHAIN",
  proposalVerify: "HYDRA_UMC_PROPOSAL_VERIFY",
};
export const PROPOSAL_KEYS_VARIABLE = "HYDRA_UMC_PROPOSAL_KEYS_FILE";
/** A file name inside the data folder (no folder, no dots in front); the environment variable takes any path. */
export const PROPOSAL_KEYS_FILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export interface IngestFile {
  faultFeed?: boolean;
  scenario?: boolean;
  developerNode?: boolean;
  anomalyFeed?: boolean;
  anomalyVoiceRelay?: boolean;
  voiceChain?: boolean;
  proposalVerify?: boolean;
  /** The file, in the data folder, that lists the public keys of the operators that sign trajectory proposals. */
  proposalKeysFile?: string;
}

/** What the history of connections keeps about a client (src/connections.ts). */
export interface ConnectionsFile {
  /** Whether the address and user agent of a client are written in the history (default: no; they are personal data, and only an administrator is ever shown them). */
  recordAddress?: boolean;
}

/** The unauthenticated health route of the server (GET /health, src/routes/infoRoutes.ts). */
export interface HealthFile {
  /** Whether GET /health answers without a sign-in (default: no; the route then looks as if it did not exist). */
  open?: boolean;
}

/**
 * Push notifications to the phones that registered a device token (src/pushNotifications.ts). The credentials of the
 * Apple push service (key, key id, team id, bundle) are NEVER read from this file: only from the environment of the
 * deployment (HYDRA_UMC_APNS_*), or from a key file outside the repository named there.
 */
export interface PushFile {
  /** Whether the server sends push notifications at all (default: no). */
  enabled?: boolean;
  /** Use the sandbox host of the Apple push service (default: no). Not a security switch: read from the file only. */
  sandbox?: boolean;
  /** Tell the phones that a job finished (default: yes once push is on). Read from the file only. */
  notifyJobFinished?: boolean;
  /** Tell the phones that a global stop was issued (default: yes once push is on). Read from the file only. */
  notifyGlobalStop?: boolean;
  /** Tell the phones that the heartbeat of an operator was lost (default: yes once push is on). Read from the file only. */
  notifyPresenceLost?: boolean;
  /** How many device tokens the server keeps (1 to 10000; 500 by default). Read from the file only. */
  maxDevices?: number;
  /** The Live Activity (the card of a robot on the lock screen, src/liveActivity.ts): off by default, and its level is the most it may show. */
  liveActivity?: LiveActivityFile;
}

/** What the card of a robot on the lock screen may show: only the state (the default), the state and the progress, or everything of the panel. */
export interface LiveActivityFile {
  /** Whether the server sends Live Activities at all (default: no; push.enabled has to be on as well). */
  enabled?: boolean;
  /** "status", "progress" or "full" (default: "status"). "full" is the most there is. */
  level?: string;
}

/** The relay of the live state of the twin (WebSocket /api/twin/ws, src/twinRelay.ts). */
export interface TwinRelayFile {
  /** Whether the relay accepts panels (default: no). It also needs the address of the twin (HYDRA_UMC_TWIN_WS_URL). */
  enabled?: boolean;
}

/** The health of the ecosystem in one answer (GET /api/ecosystem/health, src/ecosystemHealth.ts). */
export interface EcosystemHealthFile {
  /** Whether the route answers (default: no; a signed-in client then gets 404). */
  enabled?: boolean;
  /** Days before the expiry of the TLS certificate from which it is reported as expiring (1 to 365; 30 by default). Not a security switch: read from the file only. */
  certWarnDays?: number;
  /** How long to wait for each service, in milliseconds (100 to 10000; 1500 by default). Read from the file only. */
  probeTimeoutMs?: number;
  /** How many services the stored last-contact times may hold (1 to 1024; 256 by default). Read from the file only. */
  lastSeenMaxEntries?: number;
  /** At most one write of the stored last-contact times per this many seconds (1 to 3600; 30 by default). Read from the file only. */
  lastSeenSaveIntervalS?: number;
}

/** The gateway to the machine bridges (GET /api/bridges, POST /api/bridges/:name/cmd/:verb, src/bridgeGateway.ts). */
import type { BridgeGatewayFile } from "./bridgeGateway";
import { resolveTrustedNetworks, type TrustedNetworksFile, type TrustedNetworksSettings } from "./trustedNetworks";
export type { TrustedNetworksFile };
export type { BridgeGatewayFile };

/** The remaining-useful-life relay (POST /api/ai/anomaly-detector/rul, src/routes/localAiRoutes.ts). */
export interface RulFile {
  /** Whether an operator may ask the anomaly detector for a remaining-useful-life estimate through the relay (default: no; only an administrator may then). */
  enabled?: boolean;
  /** Largest request body in bytes (1024 to 1048576; 262144 by default). Read from the file only. */
  maxBodyBytes?: number;
  /** Largest number of points in one request (8 to 100000; 5000 by default). Read from the file only. */
  maxPoints?: number;
  /** How long to wait for the detector, in milliseconds (500 to 60000; 8000 by default). Read from the file only. */
  timeoutMs?: number;
}

/** How the sign-in tokens are signed (src/jwtKeys.ts). */
export interface AuthFile {
  /** "HS256" (default: the shared JWT_SECRET) or "EdDSA" (Ed25519; the public keys are published at GET /.well-known/jwks.json). */
  jwtAlgorithm?: JwtAlgorithm;
  /** While signing with EdDSA, whether HS256 tokens still around are accepted (default: yes, so nobody is signed out; turn it off when the transition is over). */
  acceptHs256?: boolean;
  /** Seconds a retired signing key stays published and accepted after a rotation (60 to 31622400; 2592000 by default). Read from the file only. */
  keyOverlapSeconds?: number;
  /** The identity the server presents to the services it calls (src/serviceIdentity.ts). Off by default. */
  serviceIdentity?: { enabled?: boolean };
}

/** The signed tickets that let a client without a bearer token read the information routes (POST /api/info/ticket, src/infoTickets.ts). */
export interface InfoTicketsFile {
  /** Whether the tickets are issued and accepted (default: no; the route then answers 404 and a ticket in an address is ignored). */
  enabled?: boolean;
  /** Life of a ticket in seconds when the client does not ask for another (30 to 2592000; 300 by default). Not a security switch: read from the file only. */
  ttlSeconds?: number;
  /** The longest life a ticket may be asked for, in seconds (30 to 2592000; 300 by default). Read from the file only. */
  maxTtlSeconds?: number;
}

/** The signed tokens of one device (POST /api/admin/device-tokens and POST /api/device/login, src/deviceTokens.ts). */
export interface DeviceTokensFile {
  /** Whether device tokens can be issued and used (default: no; the routes then answer 404 and a device session cannot be renewed). */
  enabled?: boolean;
  /** Life of a token in days when the request does not ask for another (1 to maxTtlDays; 30 by default). Read from the file only. */
  ttlDays?: number;
  /** The longest life a token may be asked for, in days (1 to 365; 90 by default). Read from the file only. */
  maxTtlDays?: number;
  /** How many tokens may be active at once (1 to 500; 20 by default). Read from the file only. */
  maxDevices?: number;
  /** Life of the sign-in a device gets, in minutes (5 to 1440; 15 by default): the longest a revoked device keeps working. Read from the file only. */
  accessMinutes?: number;
}

/** The look at the newest published version of each program of the ecosystem (GET /api/admin/updates, src/updateCheck.ts). */
export interface UpdateCheckFile {
  /** Whether the server asks GitHub for the newest release of each program (default: no; the route then answers 404 and nothing leaves the server). */
  enabled?: boolean;
  /** The GitHub account the programs are looked up under (letters, digits and dashes; JuanenRac by default). Read from the file only. */
  owner?: string;
  /** How long an answer is kept before the next look, in minutes (10 to 10080; 360 by default). Read from the file only. */
  cacheMinutes?: number;
}

/** The maintenance routes that install, go back, prune and list the releases of the programs installed here (/api/admin/maintenance, src/maintenance.ts). */
export interface MaintenanceFile {
  /** Whether the maintenance routes answer (default: no; they then answer 404 and nothing is run). */
  enabled?: boolean;
  /** The folder that holds the components, as the deploy tool wants it (/opt/hydra-umc by default). Read from the file only. */
  root?: string;
  /** The only folder a package may be read from (data/packages by default); a package is named, never given as a path. Read from the file only. */
  packagesDir?: string;
  /** The deploy tool of the operating system image (tools/deploy_release.py under the root by default). Read from the file only. */
  tool?: string;
  /** The interpreter that runs the tool (python3 by default). Read from the file only. */
  python?: string;
  /** How long one run may take, in seconds (10 to 1800; 300 by default). Read from the file only. */
  timeoutSeconds?: number;
}

/** The settings file of the loaded-model reports of HYDRA-UMC-DETECTION-HEF, which this server writes and that service re-reads while it runs. */
export interface DetectionHefFile {
  /** Whether the service accepts the reports of loaded models (default: no). Writing it here also writes `settingsFile`. */
  acceptLoadedReports?: boolean;
  /** Where the settings file is written (data/detection-hef-settings.json by default): the same path goes to the service as HYDRA_UMC_DETECTION_HEF_SETTINGS_FILE. Read from the file only. */
  settingsFile?: string;
}

/** The reset of the arm state of one URTC tool changer (POST /api/tool-arms/reset, src/atcReset.ts). */
export interface AtcFile {
  /** Whether the reset route answers (default: no; it then answers 404 and nothing is forwarded). */
  resetEnabled?: boolean;
}

/** What GET /api/hydra-info tells a client that is not signed in. */
export interface DiscoveryFile {
  /** Whether the answer lists the addresses of this server on the local network (default: no; it then carries no address). */
  advertiseAddress?: boolean;
}

/** The dead-man of the presence of the operator (POST /api/operator/presence, src/operatorPresence.ts). */
export interface PresenceFile {
  /** Whether the heartbeat route answers and a lost heartbeat acts on the robots of the operator (default: no; the route then answers 404). */
  enabled?: boolean;
  /** What a lost heartbeat does to the robots that operator holds: "slow" (default), "pause", "notify" or "stop". */
  action?: "slow" | "pause" | "notify" | "stop";
  /** Seconds without a heartbeat before it counts as lost (3 to 600; 15 by default). Read from the file only. */
  timeoutSeconds?: number;
  /** The share of the speed kept while the heartbeat is lost (0.05 to 0.9; 0.3 by default). Read from the file only. */
  slowFactor?: number;
  /** How many heartbeats in a row bring the operator back (1 to 20; 3 by default). Read from the file only. */
  recoverBeats?: number;
  /** Seconds the speed takes to return to what it was (0 to 120; 5 by default). Read from the file only. */
  rampSeconds?: number;
  /** Whether a heartbeat that says the operator LEFT on purpose acts at once instead of after the timeout (default: yes). Read from the file only. */
  leftImmediate?: boolean;
}

/** The live pictures and saved photos and recordings of the cameras (src/mediaTickets.ts). */
export interface CameraFile {
  /** Whether the pictures answer without a ticket or a signed-in client (default: no; they then need one). */
  open?: boolean;
  /** Whether the password of an IP camera is handed to its stream process through the environment instead of its command line (default: yes; with "no" it shows in the process table). */
  credentialsViaEnv?: boolean;
}

/** What a first start of a new installation does by itself (src/newInstallTls.ts). */
export interface InstallFile {
  /** Whether a new installation that has the certificates of its own authority starts with TLS on (default: yes). It is only read at the very first start. */
  newInstallTls?: boolean;
}

/** The live WebSocket of the control apps (src/ws.ts). */
export interface WebsocketFile {
  /** Whether a token in the address (/ws?token=) is accepted; it is then written in the logs of proxies and servers (default: no). */
  allowQueryToken?: boolean;
}

/** The log of the server (src/runtime.ts). */
export interface LoggingFile {
  /** Whether secrets are blanked out of every log line (default: yes). Turning it off is for a bench only. */
  redactSecrets?: boolean;
}

/** What the global stop does beyond stopping the robots of this server. */
export interface SafetyFile {
  /** Whether a global stop is also announced on the MQTT bridge as a retained SafetyState (default: no). */
  publishGlobalStop?: boolean;
  /** Whether the erase and the self-test of the F-RAM of the kinematic brain are offered (default: no). Also needs the bridge started with --enable-fram-erase and a firmware built for it. */
  framErase?: boolean;
  /** Every how many milliseconds the physical emergency stop is read from the SPI bridge: 0 (off, the default) or 500 to 60000. */
  estopWatchMs?: number;
}

/** The job dispatcher: the delivery of its stop requests (src/jobStopRelay.ts) and the options of its replanning (src/dispatcherConfigFile.ts). */
export interface JobDispatcherFile {
  /** The JSON configuration file the dispatcher reads when it starts. Set by the deployment; no request can change it. */
  configFile?: string;
  stopRelay?: {
    enabled?: boolean;
    /** The robot id the dispatcher uses -> the numeric id of the robot in this server. Other keys of this section (times, address) are kept as they are. */
    robotMap?: Record<string, number>;
    [other: string]: unknown;
  };
  replan?: {
    allowUnconfirmed?: boolean;
    stopAckTimeoutSeconds?: number;
  };
}

/** The request limits per address (src/auth.ts). The switch and every number can be changed from Server Admin; each number keeps the range of RATE_LIMIT_BOUNDS. */
export interface RateLimitsFile {
  /** Whether the limiters answer 429 when a budget is used up (default: yes; with "no" none of them limits, which only a bench should want). */
  enabled?: boolean;
  /** Failed sign-ins allowed per address in the sign-in window. */
  loginMax?: number;
  /** The sign-in window, in seconds (the refresh route shares it). */
  loginWindowSeconds?: number;
  /** Token renewals allowed per address in the sign-in window. */
  refreshMax?: number;
  /** Requests of the read and write API routes allowed per address in the API window. */
  apiMax?: number;
  /** Requests of the code and service routes allowed per address in the API window. */
  sensitiveMax?: number;
  /** The API window, in seconds. */
  apiWindowSeconds?: number;
  /** Global stop requests allowed per address in the global stop window. */
  stopAllMax?: number;
  /** The global stop window, in seconds. */
  stopAllWindowSeconds?: number;
}

export const RATE_LIMIT_KEYS = ["loginMax", "loginWindowSeconds", "refreshMax", "apiMax", "sensitiveMax", "apiWindowSeconds", "stopAllMax", "stopAllWindowSeconds"] as const;
export type RateLimitKey = (typeof RATE_LIMIT_KEYS)[number];
/** Default and whole-number range of every number: the lowest values cannot lock an administrator out for good, the highest cannot turn a limiter into a formality. */
export const RATE_LIMIT_BOUNDS: Record<RateLimitKey, { def: number; min: number; max: number }> = {
  loginMax: { def: 5, min: 3, max: 100 },
  loginWindowSeconds: { def: 900, min: 60, max: 86400 },
  refreshMax: { def: 120, min: 10, max: 10000 },
  apiMax: { def: 600, min: 60, max: 100000 },
  sensitiveMax: { def: 30, min: 5, max: 10000 },
  apiWindowSeconds: { def: 60, min: 10, max: 3600 },
  stopAllMax: { def: 60, min: 10, max: 10000 },
  stopAllWindowSeconds: { def: 60, min: 10, max: 3600 },
};
/** The environment variable that still fixes each number (the names the server has always read) and the switch. */
export const RATE_LIMIT_ENV_NAMES: Record<RateLimitKey, string> = {
  loginMax: "LOGIN_RATE_LIMIT_MAX",
  loginWindowSeconds: "LOGIN_RATE_LIMIT_WINDOW_MS",
  refreshMax: "REFRESH_RATE_LIMIT_MAX",
  apiMax: "API_RATE_LIMIT_MAX",
  sensitiveMax: "SENSITIVE_RATE_LIMIT_MAX",
  apiWindowSeconds: "API_RATE_LIMIT_WINDOW_MS",
  stopAllMax: "STOP_ALL_RATE_LIMIT_MAX",
  stopAllWindowSeconds: "STOP_ALL_RATE_LIMIT_WINDOW_MS",
};
export const RATE_LIMITS_ENV_SWITCH = "HYDRA_UMC_RATE_LIMITS";

export const MAX_ROBOT_MAP_ENTRIES = 1000;
const ROBOT_MAP_KEY = /^[A-Za-z0-9._:-]{1,64}$/;

export const DEFAULT_VOICE_MIN_CONFIDENCE = 0.6;
export const MAVLINK_SIGNING_KEY_BYTES = 32;

export interface SecurityFile {
  aiAccess?: AiAccess;
  infoAuth?: boolean;
  tls?: TlsFile;
  ble?: BleFile;
  /** The bridge to the MQTT broker (src/mqttBridge.ts). */
  mqtt?: MqttFile;
  voice?: VoiceFile;
  mavlink?: MavlinkFile;
  robots?: RobotsFile;
  connections?: ConnectionsFile;
  production?: ProductionFile;
  ingest?: IngestFile;
  health?: HealthFile;
  ecosystemHealth?: EcosystemHealthFile;
  twinRelay?: TwinRelayFile;
  infoTickets?: InfoTicketsFile;
  deviceTokens?: DeviceTokensFile;
  updateCheck?: UpdateCheckFile;
  discovery?: DiscoveryFile;
  maintenance?: MaintenanceFile;
  atc?: AtcFile;
  detectionHef?: DetectionHefFile;
  auth?: AuthFile;
  presence?: PresenceFile;
  bridgeGateway?: BridgeGatewayFile;
  push?: PushFile;
  /** Where a request comes from and what is asked of it (src/trustedNetworks.ts). */
  trustedNetworks?: TrustedNetworksFile;
  rul?: RulFile;
  safety?: SafetyFile;
  jobDispatcher?: JobDispatcherFile;
  camera?: CameraFile;
  install?: InstallFile;
  websocket?: WebsocketFile;
  logging?: LoggingFile;
  rateLimits?: RateLimitsFile;
  /** The switches of the machine bridges (src/bridgeSettings.ts); announced to the bridges while the gateway is on. */
  bridges?: BridgesFile;
}

export interface SecurityEnv {
  aiAccess?: string;
  infoAuth?: string;
  tlsCertPath?: string;
  tlsKeyPath?: string;
  bleGatt?: string;
  bleEncryption?: string;
  mqtt?: MqttEnv;
  voiceHeardText?: string;
  voiceMinConfidence?: string;
  mavlinkKeyFile?: string;
  mavlinkAllowUnsigned?: string;
  robotAllowEnable?: string;
  connectionRecordAddress?: string;
  healthOpen?: string;
  productionRdpLevel?: string;
  /** The ingest switches (INGEST_SWITCH_VARIABLES) and the keys file of the proposals, as written. */
  ingest?: Partial<Record<IngestSwitchKey | "proposalKeysFile", string>>;
  ecosystemHealth?: string;
  twinRelay?: string;
  infoTickets?: string;
  deviceTokens?: string;
  updateCheck?: string;
  advertiseAddress?: string;
  maintenance?: string;
  atcReset?: string;
  jwtAlgorithm?: string;
  jwtAcceptHs256?: string;
  /** HYDRA_UMC_SERVICE_IDENTITY: "1" on, "0" off, as written. */
  serviceIdentity?: string;
  presence?: string;
  presenceAction?: string;
  bridgeGateway?: string;
  push?: string;
  trustedNetworks?: string;
  rul?: string;
  safetyPublishStop?: string;
  framErase?: string;
  estopWatch?: string;
  cameraAuth?: string;
  wsQueryToken?: string;
  logRedaction?: string;
  voiceRequireSignature?: string;
  cameraCredentialsViaEnv?: string;
  newInstallTls?: string;
  /** HYDRA_UMC_RATE_LIMITS ("off" switches the limiters off) and the variables of the numbers (RATE_LIMIT_ENV_NAMES), as written. */
  rateLimits?: string;
  rateLimitNumbers?: Partial<Record<RateLimitKey, string>>;
  jobStopRelay?: string;
  jobDispatcherConfig?: string;
}

export function securityEnvFrom(env: NodeJS.ProcessEnv): SecurityEnv {
  return {
    aiAccess: env.HYDRA_UMC_AI_ACCESS,
    infoAuth: env.HYDRA_UMC_INFO_AUTH,
    tlsCertPath: env.TLS_CERT_PATH,
    tlsKeyPath: env.TLS_KEY_PATH,
    bleGatt: env.HYDRA_UMC_BLE_GATT,
    bleEncryption: env.HYDRA_UMC_BLE_ENCRYPTION,
    mqtt: mqttEnvFrom(env),
    voiceHeardText: env.HYDRA_UMC_VOICE_UI_INCLUDE_HEARD_TEXT,
    voiceMinConfidence: env.HYDRA_UMC_VOICE_UI_MIN_CONFIDENCE,
    mavlinkKeyFile: env.HYDRA_UMC_BRIDGE_UAV_SIGNING_KEY_FILE,
    mavlinkAllowUnsigned: env.HYDRA_UMC_BRIDGE_UAV_SIGNING_ALLOW_UNSIGNED,
    robotAllowEnable: env.HYDRA_UMC_ROBOT_ALLOW_ENABLE,
    connectionRecordAddress: env.HYDRA_UMC_CONNECTION_RECORD_ADDRESS,
    healthOpen: env.HYDRA_UMC_HEALTH_OPEN,
    productionRdpLevel: env.HYDRA_UMC_PRODUCTION_RDP_LEVEL,
    ingest: { ...Object.fromEntries(INGEST_SWITCH_KEYS.map((key) => [key, env[INGEST_SWITCH_VARIABLES[key]]])), proposalKeysFile: env[PROPOSAL_KEYS_VARIABLE] },
    ecosystemHealth: env.HYDRA_UMC_ECOSYSTEM_HEALTH,
    twinRelay: env.HYDRA_UMC_TWIN_RELAY,
    infoTickets: env.HYDRA_UMC_INFO_TICKETS,
    deviceTokens: env.HYDRA_UMC_DEVICE_TOKENS,
    updateCheck: env.HYDRA_UMC_UPDATE_CHECK,
    advertiseAddress: env.HYDRA_UMC_ADVERTISE_ADDRESS,
    maintenance: env.HYDRA_UMC_MAINTENANCE,
    atcReset: env.HYDRA_UMC_ATC_RESET,
    jwtAlgorithm: env.HYDRA_UMC_JWT_ALGORITHM,
    jwtAcceptHs256: env.HYDRA_UMC_JWT_ACCEPT_HS256,
    serviceIdentity: env.HYDRA_UMC_SERVICE_IDENTITY,
    presence: env.HYDRA_UMC_PRESENCE,
    presenceAction: env.HYDRA_UMC_PRESENCE_ACTION,
    bridgeGateway: env.HYDRA_UMC_BRIDGE_GATEWAY,
    push: env.HYDRA_UMC_PUSH,
    trustedNetworks: env.HYDRA_UMC_TRUSTED_NETWORKS,
    rul: env.HYDRA_UMC_RUL,
    safetyPublishStop: env.HYDRA_UMC_SAFETY_PUBLISH_STOP,
    framErase: env.HYDRA_UMC_FRAM_ERASE,
    estopWatch: env.HYDRA_UMC_ESTOP_WATCH_MS,
    cameraAuth: env.HYDRA_UMC_CAMERA_AUTH,
    wsQueryToken: env.HYDRA_UMC_WS_QUERY_TOKEN,
    logRedaction: env.HYDRA_UMC_LOG_REDACTION,
    voiceRequireSignature: env.HYDRA_UMC_VOICE_CONFIRM_REQUIRE_SIGNATURE,
    cameraCredentialsViaEnv: env.HYDRA_UMC_CAMERA_CREDENTIALS_VIA_ENV,
    newInstallTls: env.HYDRA_UMC_NEW_INSTALL_TLS,
    rateLimits: env[RATE_LIMITS_ENV_SWITCH],
    rateLimitNumbers: Object.fromEntries(RATE_LIMIT_KEYS.map((key) => [key, env[RATE_LIMIT_ENV_NAMES[key]]])) as Partial<Record<RateLimitKey, string>>,
    jobStopRelay: env.HYDRA_UMC_JOB_STOP_RELAY,
    jobDispatcherConfig: env.HYDRA_UMC_JOB_DISPATCHER_CONFIG,
  };
}

const isSet = (value: string | undefined): value is string => (value ?? "").trim() !== "";

export function resolveAiAccess(env: string | undefined, file: SecurityFile): { value: AiAccess; source: Source } {
  if (isSet(env)) return { value: env.trim().toLowerCase() === "admin" ? "admin" : "open", source: "env" };
  if (file.aiAccess === "admin" || file.aiAccess === "open") return { value: file.aiAccess, source: "config" };
  return { value: "open", source: "default" };
}

export function resolveInfoAuth(env: string | undefined, file: SecurityFile): { value: boolean; source: Source } {
  if (isSet(env)) return { value: env.trim().toLowerCase() === "required", source: "env" };
  if (typeof file.infoAuth === "boolean") return { value: file.infoAuth, source: "config" };
  return { value: false, source: "default" };
}

const BLE_MODES: readonly BleMode[] = ["off", "state", "commands"];

export function resolveBleMode(env: string | undefined, file: SecurityFile): { value: BleMode; source: Source } {
  if (isSet(env)) {
    const wanted = env.trim().toLowerCase();
    // An unknown word is the safe answer: no Bluetooth.
    return { value: (BLE_MODES as readonly string[]).includes(wanted) ? (wanted as BleMode) : "off", source: "env" };
  }
  if (file.ble?.mode && BLE_MODES.includes(file.ble.mode)) return { value: file.ble.mode, source: "config" };
  return { value: "off", source: "default" };
}

export function resolveBleEncryption(env: string | undefined, file: SecurityFile): { value: boolean; source: Source } {
  if (isSet(env)) return { value: env.trim().toLowerCase() !== "off", source: "env" };
  if (typeof file.ble?.requireEncryption === "boolean") return { value: file.ble.requireEncryption, source: "config" };
  return { value: true, source: "default" };
}

/** A confidence is a finite number from 0 to 1. */
export function validConfidence(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

/** Transcript in the reply: only the exact word "1" in the environment switches it on (same rule as the voice service). */
export function resolveVoiceHeardText(env: string | undefined, file: SecurityFile): { value: boolean; source: Source } {
  if (isSet(env)) return { value: env.trim() === "1", source: "env" };
  if (typeof file.voice?.includeHeardText === "boolean") return { value: file.voice.includeHeardText, source: "config" };
  return { value: false, source: "default" };
}

/** A typing mistake in the environment never silently opens the check: a bad number is ignored, as the voice service does. */
export function resolveVoiceMinConfidence(env: string | undefined, file: SecurityFile): { value: number; source: Source } {
  if (isSet(env)) {
    const parsed = Number(env.trim());
    if (validConfidence(parsed)) return { value: parsed, source: "env" };
  }
  if (validConfidence(file.voice?.minConfidence)) return { value: file.voice.minConfidence, source: "config" };
  return { value: DEFAULT_VOICE_MIN_CONFIDENCE, source: "default" };
}

/** Enabling a disabled robot from a client: only the exact word "1" in the environment switches it on; the default is off. */
export function resolveRobotAllowEnable(env: string | undefined, file: SecurityFile): { value: boolean; source: Source } {
  if (isSet(env)) return { value: env.trim() === "1", source: "env" };
  if (typeof file.robots?.allowEnable === "boolean") return { value: file.robots.allowEnable, source: "config" };
  return { value: false, source: "default" };
}

/** Keeping the address and user agent of the clients in the history: only the exact word "1" in the environment switches it on; the default is off. */
export function resolveConnectionRecordAddress(env: string | undefined, file: SecurityFile): { value: boolean; source: Source } {
  if (isSet(env)) return { value: env.trim() === "1", source: "env" };
  if (typeof file.connections?.recordAddress === "boolean") return { value: file.connections.recordAddress, source: "config" };
  return { value: false, source: "default" };
}

/** The read-out protection level of a production flash: only the exact words "0" and "1" in the environment count; anything else is ignored and the file or the default (0, off) applies. */
export function resolveProductionRdpLevel(env: string | undefined, file: SecurityFile): { value: 0 | 1; source: Source } {
  if (isSet(env) && (env.trim() === "0" || env.trim() === "1")) return { value: env.trim() === "1" ? 1 : 0, source: "env" };
  if (file.production?.rdpLevel === 0 || file.production?.rdpLevel === 1) return { value: file.production.rdpLevel, source: "config" };
  return { value: 0, source: "default" };
}

/** One ingest switch: the exact words "1" (on) and "0" (off) in the environment decide and lock it; otherwise the file; the default is off. */
export function resolveIngestSwitch(key: IngestSwitchKey, env: string | undefined, file: SecurityFile): { value: boolean; source: Source } {
  const word = (env ?? "").trim();
  if (word === "1" || word === "0") return { value: word === "1", source: "env" };
  if (typeof file.ingest?.[key] === "boolean") return { value: file.ingest[key] as boolean, source: "config" };
  return { value: false, source: "default" };
}

/** The file of the operators' public keys: a path in the environment (which locks it), else a name in the data folder from the file, else none. */
export function resolveProposalKeysFile(env: string | undefined, file: SecurityFile): { value: string; source: Source } {
  if (isSet(env)) return { value: env.trim(), source: "env" };
  const name = file.ingest?.proposalKeysFile;
  if (typeof name === "string" && PROPOSAL_KEYS_FILE_NAME.test(name) && !name.includes("..")) return { value: name, source: "config" };
  return { value: "", source: "default" };
}

/** The unauthenticated GET /health: only the exact word "1" in the environment switches it on; the default is off. */
export function resolveHealthOpen(env: string | undefined, file: SecurityFile): { value: boolean; source: Source } {
  if (isSet(env)) return { value: env.trim() === "1", source: "env" };
  if (typeof file.health?.open === "boolean") return { value: file.health.open, source: "config" };
  return { value: false, source: "default" };
}

/** The health of the ecosystem (GET /api/ecosystem/health): only the exact word "1" in the environment switches it on; the default is off. */
export function resolveEcosystemHealth(env: string | undefined, file: SecurityFile): { value: boolean; source: Source } {
  if (isSet(env)) return { value: env.trim() === "1", source: "env" };
  if (typeof file.ecosystemHealth?.enabled === "boolean") return { value: file.ecosystemHealth.enabled, source: "config" };
  return { value: false, source: "default" };
}

/** The relay of the live state of the twin (WebSocket /api/twin/ws): only the exact word "1" in the environment switches it on; the default is off. */
export function resolveTwinRelay(env: string | undefined, file: SecurityFile): { value: boolean; source: Source } {
  if (isSet(env)) return { value: env.trim() === "1", source: "env" };
  if (typeof file.twinRelay?.enabled === "boolean") return { value: file.twinRelay.enabled, source: "config" };
  return { value: false, source: "default" };
}

const clampNumber = (value: unknown, min: number, max: number, fallback: number): number => (typeof value === "number" && Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback);

/** The times of the dead-man of the presence, with the limits applied (src/operatorPresence.ts reads the same numbers). */
export function presenceTimes(file: PresenceFile | undefined): { timeoutSeconds: number; slowFactor: number; recoverBeats: number; rampSeconds: number; leftImmediate: boolean } {
  return {
    timeoutSeconds: clampNumber(file?.timeoutSeconds, 3, 600, 15),
    slowFactor: clampNumber(file?.slowFactor, 0.05, 0.9, 0.3),
    recoverBeats: Math.round(clampNumber(file?.recoverBeats, 1, 20, 3)),
    rampSeconds: clampNumber(file?.rampSeconds, 0, 120, 5),
    leftImmediate: file?.leftImmediate !== false,
  };
}

/** The signed tickets of the information routes (POST /api/info/ticket): only the exact word "1" in the environment switches them on; the default is off. */
export function resolveInfoTickets(env: string | undefined, file: SecurityFile): { value: boolean; source: Source } {
  if (isSet(env)) return { value: env.trim() === "1", source: "env" };
  if (typeof file.infoTickets?.enabled === "boolean") return { value: file.infoTickets.enabled, source: "config" };
  return { value: false, source: "default" };
}

/** The device tokens: only the exact word "1" in the environment switches them on; the default is off. */
export function resolveDeviceTokens(env: string | undefined, file: SecurityFile): { value: boolean; source: Source } {
  if (isSet(env)) return { value: env.trim() === "1", source: "env" };
  if (typeof file.deviceTokens?.enabled === "boolean") return { value: file.deviceTokens.enabled, source: "config" };
  return { value: false, source: "default" };
}

/** The look at the newest published versions (GET /api/admin/updates): only the exact word "1" in the environment switches it on; the default is off. */
export function resolveUpdateCheck(env: string | undefined, file: SecurityFile): { value: boolean; source: Source } {
  if (isSet(env)) return { value: env.trim() === "1", source: "env" };
  if (typeof file.updateCheck?.enabled === "boolean") return { value: file.updateCheck.enabled, source: "config" };
  return { value: false, source: "default" };
}

/** The maintenance routes: only the exact word "1" in the environment switches them on; the default is off. */
export function resolveMaintenance(env: string | undefined, file: SecurityFile): { value: boolean; source: Source } {
  if (isSet(env)) return { value: env.trim() === "1", source: "env" };
  if (typeof file.maintenance?.enabled === "boolean") return { value: file.maintenance.enabled, source: "config" };
  return { value: false, source: "default" };
}

/** The reset of the arm state of a tool changer: only the exact word "1" in the environment switches it on; the default is off. */
export function resolveAtcReset(env: string | undefined, file: SecurityFile): { value: boolean; source: Source } {
  if (isSet(env)) return { value: env.trim() === "1", source: "env" };
  if (typeof file.atc?.resetEnabled === "boolean") return { value: file.atc.resetEnabled, source: "config" };
  return { value: false, source: "default" };
}

/** The reports of loaded models of DETECTION-HEF: only what the file holds decides (there is no environment word: the service has its own flag); the default is off. */
export function resolveDetectionHefReports(file: SecurityFile): { value: boolean; source: Source } {
  if (typeof file.detectionHef?.acceptLoadedReports === "boolean") return { value: file.detectionHef.acceptLoadedReports, source: "config" };
  return { value: false, source: "default" };
}

/** The addresses in the answer of GET /api/hydra-info: only the exact word "1" in the environment switches them on; the default is off. */
export function resolveAdvertiseAddress(env: string | undefined, file: SecurityFile): { value: boolean; source: Source } {
  if (isSet(env)) return { value: env.trim() === "1", source: "env" };
  if (typeof file.discovery?.advertiseAddress === "boolean") return { value: file.discovery.advertiseAddress, source: "config" };
  return { value: false, source: "default" };
}

/** Does the server present its identity to the services? Only the exact words "1" (on) and "0" (off) in the environment decide and lock it; otherwise the file; the default is off. */
export function resolveServiceIdentity(env: string | undefined, file: SecurityFile): { value: boolean; source: Source } {
  const word = (env ?? "").trim();
  if (word === "1" || word === "0") return { value: word === "1", source: "env" };
  if (typeof file.auth?.serviceIdentity?.enabled === "boolean") return { value: file.auth.serviceIdentity.enabled, source: "config" };
  return { value: false, source: "default" };
}

const isJwtAlgorithm = (value: unknown): value is JwtAlgorithm => typeof value === "string" && (JWT_ALGORITHMS as readonly string[]).includes(value);

/** What new sign-in tokens are signed with: the environment first (HS256 or EdDSA, any case; anything else is ignored), then the file, then HS256 (the shared secret, as always). */
export function resolveJwtAlgorithm(env: string | undefined, file: SecurityFile): { value: JwtAlgorithm; source: Source } {
  if (isSet(env)) {
    const wanted = JWT_ALGORITHMS.find((name) => name.toLowerCase() === env.trim().toLowerCase());
    if (wanted) return { value: wanted, source: "env" };
  }
  if (isJwtAlgorithm(file.auth?.jwtAlgorithm)) return { value: file.auth.jwtAlgorithm, source: "config" };
  return { value: "HS256", source: "default" };
}

/** Whether HS256 tokens are still accepted while EdDSA is in use: only the exact word "0" in the environment switches it off; the default is yes (a transition must not sign anybody out). */
export function resolveJwtAcceptHs256(env: string | undefined, file: SecurityFile): { value: boolean; source: Source } {
  if (isSet(env) && (env.trim() === "0" || env.trim() === "1")) return { value: env.trim() === "1", source: "env" };
  if (typeof file.auth?.acceptHs256 === "boolean") return { value: file.auth.acceptHs256, source: "config" };
  return { value: true, source: "default" };
}

export function resolveKeyOverlapSeconds(file: SecurityFile): number {
  const value = file.auth?.keyOverlapSeconds;
  return typeof value === "number" && Number.isFinite(value) && value >= MIN_KEY_OVERLAP_SECONDS && value <= MAX_KEY_OVERLAP_SECONDS ? Math.floor(value) : DEFAULT_KEY_OVERLAP_SECONDS;
}

/** The dead-man of the presence of the operator (POST /api/operator/presence): only the exact word "1" in the environment switches it on; the default is off. */
export function resolvePresence(env: string | undefined, file: SecurityFile): { value: boolean; source: Source } {
  if (isSet(env)) return { value: env.trim() === "1", source: "env" };
  if (typeof file.presence?.enabled === "boolean") return { value: file.presence.enabled, source: "config" };
  return { value: false, source: "default" };
}

export const PRESENCE_ACTION_VALUES = ["slow", "pause", "notify", "stop"] as const;
export type PresenceActionValue = (typeof PRESENCE_ACTION_VALUES)[number];
const isPresenceAction = (value: unknown): value is PresenceActionValue => typeof value === "string" && (PRESENCE_ACTION_VALUES as readonly string[]).includes(value);

/** What a lost heartbeat does: the environment first (a word that is not one of the four is ignored), then the file, then "slow". */
export function resolvePresenceAction(env: string | undefined, file: SecurityFile): { value: PresenceActionValue; source: Source } {
  if (isSet(env) && isPresenceAction(env.trim().toLowerCase())) return { value: env.trim().toLowerCase() as PresenceActionValue, source: "env" };
  if (isPresenceAction(file.presence?.action)) return { value: file.presence.action, source: "config" };
  return { value: "slow", source: "default" };
}

/** The gateway to the machine bridges: only the exact word "1" in the environment switches it on; the default is off. */
export function resolveBridgeGateway(env: string | undefined, file: SecurityFile): { value: boolean; source: Source } {
  if (isSet(env)) return { value: env.trim() === "1", source: "env" };
  if (typeof file.bridgeGateway?.enabled === "boolean") return { value: file.bridgeGateway.enabled, source: "config" };
  return { value: false, source: "default" };
}

/** Push notifications: only the exact word "1" in the environment switches them on; the default is off. */
/** The Live Activity: only the file decides (there is no environment word); off by default, and the level is the conservative one unless an administrator raised it. */
export function resolveLiveActivity(file: SecurityFile): { enabled: { value: boolean; source: Source }; level: { value: LiveActivityLevel; source: Source } } {
  const enabled = typeof file.push?.liveActivity?.enabled === "boolean" ? { value: file.push.liveActivity.enabled, source: "config" as Source } : { value: false, source: "default" as Source };
  const raw = file.push?.liveActivity?.level;
  const level = isLiveLevel(raw) ? { value: raw, source: "config" as Source } : { value: DEFAULT_LIVE_ACTIVITY_LEVEL, source: "default" as Source };
  return { enabled, level };
}

export function resolvePush(env: string | undefined, file: SecurityFile): { value: boolean; source: Source } {
  if (isSet(env)) return { value: env.trim() === "1", source: "env" };
  if (typeof file.push?.enabled === "boolean") return { value: file.push.enabled, source: "config" };
  return { value: false, source: "default" };
}

/** Trusted networks (administering only from the house or the VPN): only the exact word "1" in the environment switches it on; the default is off. */
export function resolveTrustedNetworksEnabled(env: string | undefined, file: SecurityFile): { value: boolean; source: Source } {
  if (isSet(env)) return { value: env.trim() === "1", source: "env" };
  if (typeof file.trustedNetworks?.enabled === "boolean") return { value: file.trustedNetworks.enabled, source: "config" };
  return { value: false, source: "default" };
}

/** The remaining-useful-life relay for operators: only the exact word "1" in the environment switches it on; the default is off. */
export function resolveRul(env: string | undefined, file: SecurityFile): { value: boolean; source: Source } {
  if (isSet(env)) return { value: env.trim() === "1", source: "env" };
  if (typeof file.rul?.enabled === "boolean") return { value: file.rul.enabled, source: "config" };
  return { value: false, source: "default" };
}

/** The delivery of the stop requests of the job dispatcher: only the exact word "1" in the environment switches it on; the default is off. */
export function resolveJobStopRelay(env: string | undefined, file: SecurityFile): { value: boolean; source: Source } {
  if (isSet(env)) return { value: env.trim() === "1", source: "env" };
  if (typeof file.jobDispatcher?.stopRelay?.enabled === "boolean") return { value: file.jobDispatcher.stopRelay.enabled, source: "config" };
  return { value: false, source: "default" };
}

/** The configuration file of the dispatcher, from the deployment only (environment first, then the settings file). Empty: none. */
export function resolveDispatcherConfigFile(env: string | undefined, file: SecurityFile): string {
  if (isSet(env)) return env.trim();
  return typeof file.jobDispatcher?.configFile === "string" ? file.jobDispatcher.configFile.trim() : "";
}

/** The F-RAM erase and self-test of the brain: only the exact word "1" in the environment switches it on; the default is off. */
export function resolveFramErase(env: string | undefined, file: SecurityFile): { value: boolean; source: Source } {
  if (isSet(env)) return { value: env.trim() === "1", source: "env" };
  if (typeof file.safety?.framErase === "boolean") return { value: file.safety.framErase, source: "config" };
  return { value: false, source: "default" };
}

/** Whether a value is a valid interval of the emergency stop watch: 0 (off) or a whole number of milliseconds from 500 to 60000. */
export function validEstopWatchMs(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && (value === 0 || (value >= 500 && value <= 60000));
}

/** The interval of the emergency stop watch in milliseconds: the environment decides and locks it (anything but a valid whole number leaves it off), then the file; the default is 0 (off). */
export function resolveEstopWatchMs(env: string | undefined, file: SecurityFile): { value: number; source: Source } {
  if (isSet(env)) {
    const text = env.trim();
    const value = /^\d+$/.test(text) ? Number(text) : 0;
    return { value: validEstopWatchMs(value) ? value : 0, source: "env" };
  }
  const stored = file.safety?.estopWatchMs;
  if (validEstopWatchMs(stored)) return { value: stored, source: "config" };
  return { value: 0, source: "default" };
}

/** Announcing a global stop on the MQTT bridge: only the exact word "1" in the environment switches it on; the default is off. */
export function resolveSafetyPublishStop(env: string | undefined, file: SecurityFile): { value: boolean; source: Source } {
  if (isSet(env)) return { value: env.trim() === "1", source: "env" };
  if (typeof file.safety?.publishGlobalStop === "boolean") return { value: file.safety.publishGlobalStop, source: "config" };
  return { value: false, source: "default" };
}

/** Do the camera pictures need a ticket or a signed-in client? Yes, unless the environment says open/off/false/0/no/allow or an administrator opened them. */
export function resolveCameraOpen(env: string | undefined, file: SecurityFile): { value: boolean; source: Source } {
  if (isSet(env)) return { value: ["open", "off", "false", "0", "no", "allow"].includes(env.trim().toLowerCase()), source: "env" };
  if (typeof file.camera?.open === "boolean") return { value: file.camera.open, source: "config" };
  return { value: false, source: "default" };
}

/** Is /ws?token= accepted? No, unless the environment says allow/true/1/yes/on or an administrator allowed it. */
export function resolveWsQueryToken(env: string | undefined, file: SecurityFile): { value: boolean; source: Source } {
  if (isSet(env)) return { value: ["allow", "true", "1", "yes", "on"].includes(env.trim().toLowerCase()), source: "env" };
  if (typeof file.websocket?.allowQueryToken === "boolean") return { value: file.websocket.allowQueryToken, source: "config" };
  return { value: false, source: "default" };
}

/** Are secrets blanked out of the log? Yes, unless the environment says "off" or an administrator turned it off. */
export function resolveLogRedaction(env: string | undefined, file: SecurityFile): { value: boolean; source: Source } {
  if (isSet(env)) return { value: env.trim().toLowerCase() !== "off", source: "env" };
  if (typeof file.logging?.redactSecrets === "boolean") return { value: file.logging.redactSecrets, source: "config" };
  return { value: true, source: "default" };
}

/** Must a confirmed spoken request be signed? Only the exact word "1" in the environment, or an administrator, switches it on; the default is off. */
export function resolveVoiceRequireSignature(env: string | undefined, file: SecurityFile): { value: boolean; source: Source } {
  if (isSet(env)) return { value: env.trim() === "1", source: "env" };
  if (typeof file.voice?.requireSignature === "boolean") return { value: file.voice.requireSignature, source: "config" };
  return { value: false, source: "default" };
}

/** Is the password of an IP camera handed over through the environment of its process? Yes, unless the environment says "off" or an administrator turned it off. */
export function resolveCameraCredentialsViaEnv(env: string | undefined, file: SecurityFile): { value: boolean; source: Source } {
  if (isSet(env)) return { value: env.trim().toLowerCase() !== "off", source: "env" };
  if (typeof file.camera?.credentialsViaEnv === "boolean") return { value: file.camera.credentialsViaEnv, source: "config" };
  return { value: true, source: "default" };
}

/** Does a new installation start with TLS on? Yes, unless the environment says "off" or the saved configuration says no. */
export function resolveNewInstallTls(env: string | undefined, file: SecurityFile): { value: boolean; source: Source } {
  if (isSet(env)) return { value: env.trim().toLowerCase() !== "off", source: "env" };
  if (typeof file.install?.newInstallTls === "boolean") return { value: file.install.newInstallTls, source: "config" };
  return { value: true, source: "default" };
}

export function resolveMavlinkKeyFile(env: string | undefined, file: SecurityFile): { value: string; source: Source } {
  if (isSet(env)) return { value: env.trim(), source: "env" };
  if (isSet(file.mavlink?.signingKeyFile)) return { value: file.mavlink.signingKeyFile.trim(), source: "config" };
  return { value: "", source: "default" };
}

export function resolveMavlinkAllowUnsigned(env: string | undefined, file: SecurityFile): { value: boolean; source: Source } {
  if (isSet(env)) return { value: env.trim() === "1", source: "env" };
  if (typeof file.mavlink?.signingAllowUnsigned === "boolean") return { value: file.mavlink.signingAllowUnsigned, source: "config" };
  return { value: false, source: "default" };
}

/** Why a MAVLink signing key file cannot be used (null when it can): 32 raw bytes or 64 hexadecimal characters, like the bridge reads it. */
export function mavlinkKeyFileProblem(keyPath: string): string | null {
  let data: Buffer;
  try {
    data = fs.readFileSync(keyPath);
  } catch (error) {
    return `cannot read the signing key file: ${(error as NodeJS.ErrnoException).code ?? (error as Error).message}`;
  }
  const text = data.toString("latin1").trim();
  if (text.length === MAVLINK_SIGNING_KEY_BYTES * 2 && /^[0-9a-fA-F]+$/.test(text)) return null;
  if (data.length === MAVLINK_SIGNING_KEY_BYTES) return null;
  return `the signing key file must hold ${MAVLINK_SIGNING_KEY_BYTES} bytes or ${MAVLINK_SIGNING_KEY_BYTES * 2} hexadecimal characters`;
}

export function resolveTls(env: SecurityEnv, file: SecurityFile): { enabled: boolean; certPath: string | null; keyPath: string | null; source: Source } {
  if (isSet(env.tlsCertPath) && isSet(env.tlsKeyPath)) {
    return { enabled: true, certPath: env.tlsCertPath, keyPath: env.tlsKeyPath, source: "env" };
  }
  const tls = file.tls;
  if (tls && tls.enabled === true && isSet(tls.certPath) && isSet(tls.keyPath)) {
    return { enabled: true, certPath: tls.certPath, keyPath: tls.keyPath, source: "config" };
  }
  return { enabled: false, certPath: tls?.certPath ?? null, keyPath: tls?.keyPath ?? null, source: tls ? "config" : "default" };
}

/** SHA-256 fingerprint of a PEM certificate file (the value a client pins), or null when it cannot be read. */
export function certFingerprint(certPath: string | null): string | null {
  if (!certPath) return null;
  try {
    return new crypto.X509Certificate(fs.readFileSync(certPath)).fingerprint256;
  } catch {
    return null;
  }
}

/** Why a certificate and key cannot be used together (null when they can). */
export function tlsFilesProblem(certPath: string, keyPath: string): string | null {
  let cert: Buffer;
  let key: Buffer;
  try {
    cert = fs.readFileSync(certPath);
  } catch (error) {
    return `cannot read the certificate file: ${(error as Error).message}`;
  }
  try {
    key = fs.readFileSync(keyPath);
  } catch (error) {
    return `cannot read the key file: ${(error as Error).message}`;
  }
  try {
    tls.createSecureContext({ cert, key });
  } catch (error) {
    return `the certificate and the key cannot be used together: ${(error as Error).message}`;
  }
  return null;
}

export class SecurityConfigError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

/** Are the request limiters on? Yes, unless the environment says "off" (or false/0/no) or an administrator turned them off. */
export function resolveRateLimitsEnabled(env: string | undefined, file: SecurityFile): { value: boolean; source: Source } {
  if (isSet(env)) return { value: !["off", "false", "0", "no"].includes(env.trim().toLowerCase()), source: "env" };
  if (typeof file.rateLimits?.enabled === "boolean") return { value: file.rateLimits.enabled, source: "config" };
  return { value: true, source: "default" };
}

/** Is `value` a whole number inside the range of this limiter number? */
export function validRateLimitNumber(key: RateLimitKey, value: unknown): value is number {
  const bounds = RATE_LIMIT_BOUNDS[key];
  return typeof value === "number" && Number.isInteger(value) && value >= bounds.min && value <= bounds.max;
}

/**
 * One limiter number: the environment first (the window variables keep their old unit, milliseconds; the deployment may set any positive number, the
 * ranges bind what is saved from Server Admin), then the saved file, then the default.
 */
export function resolveRateLimitNumber(key: RateLimitKey, env: SecurityEnv, file: SecurityFile): { value: number; source: Source } {
  const raw = env.rateLimitNumbers?.[key];
  if (isSet(raw)) {
    const parsed = Number(raw.trim());
    const value = key.endsWith("WindowSeconds") ? parsed / 1000 : parsed;
    if (Number.isFinite(value) && value > 0 && value <= 2_147_483) return { value, source: "env" };
  }
  const saved = file.rateLimits?.[key];
  if (validRateLimitNumber(key, saved)) return { value: saved, source: "config" };
  return { value: RATE_LIMIT_BOUNDS[key].def, source: "default" };
}

export interface RateLimitSettings {
  enabled: boolean;
  loginMax: number;
  loginWindowMs: number;
  refreshMax: number;
  apiMax: number;
  sensitiveMax: number;
  apiWindowMs: number;
  stopAllMax: number;
  stopAllWindowMs: number;
}

/** The limiter settings in force (the window in milliseconds, as express-rate-limit takes it). */
export function rateLimitSettings(env: SecurityEnv, file: SecurityFile): RateLimitSettings {
  const n = (key: RateLimitKey) => resolveRateLimitNumber(key, env, file).value;
  return {
    enabled: resolveRateLimitsEnabled(env.rateLimits, file).value,
    loginMax: n("loginMax"),
    loginWindowMs: n("loginWindowSeconds") * 1000,
    refreshMax: n("refreshMax"),
    apiMax: n("apiMax"),
    sensitiveMax: n("sensitiveMax"),
    apiWindowMs: n("apiWindowSeconds") * 1000,
    stopAllMax: n("stopAllMax"),
    stopAllWindowMs: n("stopAllWindowSeconds") * 1000,
  };
}

export interface SecuritySnapshot {
  aiAccess: { value: AiAccess; source: Source };
  infoAuth: { value: boolean; source: Source };
  tls: { enabled: boolean; source: Source; certPath: string | null; keyPath: string | null; fingerprint256: string | null; active: boolean; appliesOnRestart: boolean };
  ble: { mode: { value: BleMode; source: Source }; requireEncryption: { value: boolean; source: Source }; activeMode: BleMode; appliesOnRestart: boolean };
  mqtt: { mode: { value: MqttMode; source: Source }; url: string; prefix: string; username: string | null; commandUser: string | null; activeMode: MqttMode; appliesOnRestart: boolean; homeAssistant: { enabled: { value: boolean; source: Source }; discoveryPrefix: string } };
  voice: { includeHeardText: { value: boolean; source: Source }; minConfidence: { value: number; source: Source }; requireSignature: { value: boolean; source: Source } };
  robots: { allowEnable: { value: boolean; source: Source } };
  connections: { recordAddress: { value: boolean; source: Source } };
  production: { rdpLevel: { value: 0 | 1; source: Source } };
  ingest: Record<IngestSwitchKey, { value: boolean; source: Source }> & { proposalKeysFile: { value: string; source: Source }; appliesOnRestart: boolean };
  health: { open: { value: boolean; source: Source } };
  ecosystemHealth: { enabled: { value: boolean; source: Source } };
  twinRelay: { enabled: { value: boolean; source: Source } };
  infoTickets: { enabled: { value: boolean; source: Source } };
  deviceTokens: { enabled: { value: boolean; source: Source } };
  updateCheck: { enabled: { value: boolean; source: Source } };
  discovery: { advertiseAddress: { value: boolean; source: Source } };
  maintenance: { enabled: { value: boolean; source: Source } };
  atc: { resetEnabled: { value: boolean; source: Source } };
  detectionHef: { acceptLoadedReports: { value: boolean; source: Source } };
  /** How the sign-in tokens are signed; the overlap of a rotation is edited in the configuration file. */
  auth: { jwtAlgorithm: { value: JwtAlgorithm; source: Source }; acceptHs256: { value: boolean; source: Source }; keyOverlapSeconds: number; serviceIdentity: { enabled: { value: boolean; source: Source } } };
  /** The switch and the action of the dead-man of the presence of the operator; the times are edited in the configuration file. */
  presence: { enabled: { value: boolean; source: Source }; action: { value: PresenceActionValue; source: Source }; timeoutSeconds: number; slowFactor: number; recoverBeats: number; rampSeconds: number; leftImmediate: boolean };
  bridgeGateway: { enabled: { value: boolean; source: Source } };
  push: { enabled: { value: boolean; source: Source }; liveActivity: { enabled: { value: boolean; source: Source }; level: { value: LiveActivityLevel; source: Source }; maxLevel: LiveActivityLevel } };
  /** The switch, and what the configuration file says about the rest (read only here: the ranges are edited in the file). */
  trustedNetworks: { enabled: { value: boolean; source: Source }; outside: "operate" | "view"; outsideRequiresSecondFactor: boolean; localRanges: number; vpnRanges: number; invalidEntries: number };
  rul: { enabled: { value: boolean; source: Source } };
  safety: { publishGlobalStop: { value: boolean; source: Source }; framErase: { value: boolean; source: Source }; estopWatchMs: { value: number; source: Source } };
  jobDispatcher: {
    stopRelay: { enabled: { value: boolean; source: Source }; robotMap: Record<string, number>; activeEnabled: boolean; appliesOnRestart: boolean };
    replan: {
      allowUnconfirmed: { value: boolean; source: Source };
      stopAckTimeoutSeconds: { value: number; source: Source };
      /** Whether the deployment named the configuration file of the dispatcher; without it these two options cannot be changed here. */
      editable: boolean;
      /**
       * Whether the dispatcher has taken the file: "not_configured" (no address of the dispatcher, so it is asked nothing), "none" (nothing
       * written since this server started), "pending" (asked, no answer yet), "applied" or "failed" (it did not take it: its previous values
       * stay in force and it reads the file the next time it starts).
       */
      reload: "not_configured" | "none" | "pending" | "applied" | "failed";
      /** True while the dispatcher has not taken the file: the change then reaches it on its next start. */
      appliesOnDispatcherRestart: boolean;
    };
  };
  camera: { open: { value: boolean; source: Source }; credentialsViaEnv: { value: boolean; source: Source } };
  install: { newInstallTls: { value: boolean; source: Source } };
  websocket: { allowQueryToken: { value: boolean; source: Source } };
  logging: { redactSecrets: { value: boolean; source: Source } };
  /** The request limiters per address: the switch and every number, each with where it comes from. A change reaches the limiters at once (their counters start again). */
  rateLimits: { enabled: { value: boolean; source: Source } } & Record<RateLimitKey, { value: number; source: Source; min: number; max: number }>;
  /** The switches of the machine bridges, each with its value, where it comes from, its default and whether turning it on asks for a confirmation. Off by default for everything that moves hardware. */
  bridges: BridgesSnapshot & { delivery: "gateway_on" | "gateway_off" };
  /** Whether the settings message of each bridge can be signed: where its key file is (never the key), its state, when a message was last signed and its counter. */
  bridgeSigning: Record<string, { keyFile: string; key: "present" | "missing" | "unusable"; lastSignedAt: string | null; seq: number }>;
  /** The signing key itself is never part of this; only where its file is. */
  mavlink: { signingKeyFile: { value: string; source: Source }; signingAllowUnsigned: { value: boolean; source: Source }; signing: boolean; appliesOnRestart: boolean };
}

export interface SecurityConfigOptions {
  env: SecurityEnv;
  /** Called once the switches of the bridges are saved, so the gateway can announce them (src/bridgeGateway.ts). */
  afterBridgesWritten?: () => void;
  /** Writes the settings file that DETECTION-HEF re-reads (src/detectionHefSettings.ts); called once the value is saved. */
  writeDetectionHefSettings?: (acceptLoadedReports: boolean, settingsFile: string | undefined) => void;
  /** The state of the keys that sign the settings of the bridges (src/bridgeSettingsSigning.ts). */
  bridgeSigningStatus?: () => Record<string, { keyFile: string; key: "present" | "missing" | "unusable"; lastSignedAt: string | null; seq: number }>;
  load: () => SecurityFile;
  /** Writes the whole saved file (this class passes the stored object with its own fields merged in). */
  save: (file: SecurityFile) => void;
  /** Whether the listener that is running right now uses TLS. */
  tlsActive: boolean;
  /** The mode the Bluetooth service started with (it changes only on a restart). */
  bleActiveMode?: BleMode;
  /** The mode the MQTT bridge started with (it changes only on a restart). */
  mqttActiveMode?: MqttMode;
  /** Whether the delivery of the stop requests started with this server (it changes only on a restart). */
  jobStopRelayActive?: boolean;
  /** Asks the job dispatcher to read its configuration file again (called after the two replanning options were written). */
  afterReplanWritten?: () => void;
  /** What came of the last request to reload it. */
  dispatcherReload?: () => "not_configured" | "none" | "pending" | "applied" | "failed";
  log?: (message: string) => void;
}

export class SecurityConfig {
  private file: SecurityFile;
  /** A MAVLink signing option was saved since this server started: the bridge picks it up on its next start. */
  private mavlinkTouched = false;

  constructor(private options: SecurityConfigOptions) {
    this.file = options.load();
  }

  /** The limiter settings in force right now (read by src/auth.ts on every request, so a change applies at once). */
  rateLimits(): RateLimitSettings {
    return rateLimitSettings(this.options.env, this.file);
  }

  aiAdminOnly(): boolean {
    return resolveAiAccess(this.options.env.aiAccess, this.file).value === "admin";
  }

  infoAuthRequired(): boolean {
    return resolveInfoAuth(this.options.env.infoAuth, this.file).value;
  }

  tls() {
    return resolveTls(this.options.env, this.file);
  }

  ble(): { mode: BleMode; requireEncryption: boolean; file: BleFile } {
    return {
      mode: resolveBleMode(this.options.env.bleGatt, this.file).value,
      requireEncryption: resolveBleEncryption(this.options.env.bleEncryption, this.file).value,
      file: this.file.ble ?? {},
    };
  }

  mqtt(): MqttSettings {
    return resolveMqttSettings(this.options.env.mqtt ?? {}, this.file);
  }

  /** Is the ingest switch on (environment first, then the file; off by default)? */
  ingestSwitch(key: IngestSwitchKey): boolean {
    return resolveIngestSwitch(key, this.options.env.ingest?.[key], this.file).value;
  }

  /**
   * The environment the ingest code reads: `base` with the switches and the keys file that an administrator saved put in where the
   * environment of the server does not already say (it always wins). `dataDir` is the data folder, where the keys file lives.
   */
  ingestEnv(base: Record<string, string | undefined>, dataDir: string): Record<string, string | undefined> {
    const out: Record<string, string | undefined> = { ...base };
    for (const key of INGEST_SWITCH_KEYS) {
      const resolved = resolveIngestSwitch(key, this.options.env.ingest?.[key], this.file);
      if (resolved.source === "config") out[INGEST_SWITCH_VARIABLES[key]] = resolved.value ? "1" : "0";
    }
    const keys = resolveProposalKeysFile(this.options.env.ingest?.proposalKeysFile, this.file);
    if (keys.source === "config") out[PROPOSAL_KEYS_VARIABLE] = path.join(dataDir, keys.value);
    return out;
  }

  /** The feeds that read the broker (and the relay to the voice interface) start with the server: true when the saved switches differ from the ones it started with. */
  private ingestRestartPending(): boolean {
    const started = this.ingestStarted;
    if (!started) return false;
    return (["faultFeed", "anomalyFeed", "anomalyVoiceRelay"] as const).some((key) => this.ingestSwitch(key) !== started[key]);
  }

  /** The server tells which feeds it started with, so that the screen can say when a restart is needed. */
  noteIngestStarted(): void {
    this.ingestStarted = { faultFeed: this.ingestSwitch("faultFeed"), anomalyFeed: this.ingestSwitch("anomalyFeed"), anomalyVoiceRelay: this.ingestSwitch("anomalyVoiceRelay") };
  }

  private ingestStarted?: { faultFeed: boolean; anomalyFeed: boolean; anomalyVoiceRelay: boolean };

  /** The read-out protection level a production flash sets (0 = off unless an administrator chose 1). */
  productionRdpLevel(): 0 | 1 {
    return resolveProductionRdpLevel(this.options.env.productionRdpLevel, this.file).value;
  }

  /** Whether the history of connections may keep the address and user agent of a client (off unless an administrator turned it on). */
  connectionAddressRecorded(): boolean {
    return resolveConnectionRecordAddress(this.options.env.connectionRecordAddress, this.file).value;
  }

  /** Whether GET /health answers without a sign-in (off unless an administrator turned it on). */
  healthOpen(): boolean {
    return resolveHealthOpen(this.options.env.healthOpen, this.file).value;
  }

  /** Whether the gateway to the machine bridges answers (off unless an administrator turned it on). */
  bridgeGatewayEnabled(): boolean {
    return resolveBridgeGateway(this.options.env.bridgeGateway, this.file).value;
  }

  /** The trusted networks in force (the option is off unless an administrator turned it on). */
  trustedNetworks(): TrustedNetworksSettings {
    return resolveTrustedNetworks(resolveTrustedNetworksEnabled(this.options.env.trustedNetworks, this.file).value, this.file.trustedNetworks);
  }

  /** Whether the server sends push notifications (off unless an administrator turned it on). */
  /** Whether the Live Activities are sent (off unless an administrator turned them on, and push as well). */
  liveActivityEnabled(): boolean {
    return this.pushEnabled() && resolveLiveActivity(this.file).enabled.value;
  }

  /** The most the card of a robot may show on the lock screen. */
  liveActivityLevel(): LiveActivityLevel {
    return resolveLiveActivity(this.file).level.value;
  }

  pushEnabled(): boolean {
    return resolvePush(this.options.env.push, this.file).value;
  }

  /** Does this server present its identity to the services it calls (auth.serviceIdentity.enabled)? */
  serviceIdentityEnabled(): boolean {
    return resolveServiceIdentity(this.options.env.serviceIdentity, this.file).value;
  }

  /** What new sign-in tokens are signed with, and whether HS256 tokens are still accepted (HS256 unless an administrator chose EdDSA). */
  jwtPolicy(): { algorithm: JwtAlgorithm; acceptHs256: boolean } {
    return { algorithm: resolveJwtAlgorithm(this.options.env.jwtAlgorithm, this.file).value, acceptHs256: resolveJwtAcceptHs256(this.options.env.jwtAcceptHs256, this.file).value };
  }

  /** Seconds a retired signing key stays published and accepted. */
  keyOverlapSeconds(): number {
    return resolveKeyOverlapSeconds(this.file);
  }

  /** Whether GET /api/ecosystem/health answers (off unless an administrator turned it on). */
  infoTicketsEnabled(): boolean {
    return resolveInfoTickets(this.options.env.infoTickets, this.file).value;
  }

  /** Whether device tokens can be issued and used (off unless an administrator turned it on). */
  deviceTokensEnabled(): boolean {
    return resolveDeviceTokens(this.options.env.deviceTokens, this.file).value;
  }

  /** Whether the server looks up the newest published versions (off unless an administrator turned it on). */
  updateCheckEnabled(): boolean {
    return resolveUpdateCheck(this.options.env.updateCheck, this.file).value;
  }

  /** Whether the reset of the arm state of a tool changer answers (off unless an administrator turned it on). */
  atcResetEnabled(): boolean {
    return resolveAtcReset(this.options.env.atcReset, this.file).value;
  }

  /** Whether the maintenance routes answer (off unless an administrator turned it on). */
  maintenanceEnabled(): boolean {
    return resolveMaintenance(this.options.env.maintenance, this.file).value;
  }

  /** Whether GET /api/hydra-info lists the addresses of this server (off unless an administrator turned it on). */
  advertiseAddressEnabled(): boolean {
    return resolveAdvertiseAddress(this.options.env.advertiseAddress, this.file).value;
  }

  /** Whether the dead-man of the presence of the operator is on (off unless an administrator turned it on). */
  presenceEnabled(): boolean {
    return resolvePresence(this.options.env.presence, this.file).value;
  }

  /** What a lost heartbeat does to the robots of the operator (slow down unless an administrator chose another action). */
  presenceAction(): PresenceActionValue {
    return resolvePresenceAction(this.options.env.presenceAction, this.file).value;
  }

  /** Whether GET /api/ecosystem/health answers (off unless an administrator turned it on). */
  ecosystemHealthEnabled(): boolean {
    return resolveEcosystemHealth(this.options.env.ecosystemHealth, this.file).value;
  }

  /** Whether the relay of the live state of the twin accepts panels (off unless an administrator turned it on). */
  twinRelayEnabled(): boolean {
    return resolveTwinRelay(this.options.env.twinRelay, this.file).value;
  }

  /** Whether an operator may use the remaining-useful-life relay (off unless an administrator turned it on). */
  rulEnabled(): boolean {
    return resolveRul(this.options.env.rul, this.file).value;
  }

  /** Whether the camera pictures answer without a ticket (off unless an administrator opened them). */
  cameraOpen(): boolean {
    return resolveCameraOpen(this.options.env.cameraAuth, this.file).value;
  }

  /** Whether the password of an IP camera goes to its process through the environment (on unless an administrator turned it off). */
  cameraCredentialsViaEnv(): boolean {
    return resolveCameraCredentialsViaEnv(this.options.env.cameraCredentialsViaEnv, this.file).value;
  }

  /** Whether /ws?token= is accepted (off unless an administrator allowed it). */
  wsQueryTokenAllowed(): boolean {
    return resolveWsQueryToken(this.options.env.wsQueryToken, this.file).value;
  }

  /** Whether secrets are blanked out of the log (on unless an administrator turned it off). */
  logRedactionOn(): boolean {
    return resolveLogRedaction(this.options.env.logRedaction, this.file).value;
  }

  /** Whether a confirmed spoken request must be signed (off unless an administrator turned it on). */
  voiceSignatureRequired(): boolean {
    return resolveVoiceRequireSignature(this.options.env.voiceRequireSignature, this.file).value;
  }

  /** The map of robots of the delivery of the stop requests (read at every pass of the relay, so a change needs no restart). */
  jobStopRobotMap(): Record<string, number> {
    return { ...(this.file.jobDispatcher?.stopRelay?.robotMap ?? {}) };
  }

  private jobDispatcherSnapshot(): SecuritySnapshot["jobDispatcher"] {
    const relay = resolveJobStopRelay(this.options.env.jobStopRelay, this.file);
    const configFile = resolveDispatcherConfigFile(this.options.env.jobDispatcherConfig, this.file);
    let allow = this.file.jobDispatcher?.replan?.allowUnconfirmed;
    let timeout = this.file.jobDispatcher?.replan?.stopAckTimeoutSeconds;
    if (configFile !== "") {
      try {
        const current = readReplanOptions(configFile);
        allow = current.allowUnconfirmed;
        timeout = current.stopAckTimeoutSeconds;
      } catch {
        // an unreadable file shows what this server last saved, and a write is refused until the file is fixed
      }
    }
    const stored = typeof allow === "boolean" || validTimeout(timeout);
    return {
      stopRelay: {
        enabled: relay,
        robotMap: this.jobStopRobotMap(),
        activeEnabled: this.options.jobStopRelayActive ?? false,
        appliesOnRestart: relay.value !== (this.options.jobStopRelayActive ?? false),
      },
      replan: {
        allowUnconfirmed: { value: allow === true, source: stored ? "config" : "default" },
        stopAckTimeoutSeconds: { value: validTimeout(timeout) ? timeout : DEFAULT_STOP_ACK_TIMEOUT_SECONDS, source: stored ? "config" : "default" },
        editable: configFile !== "",
        reload: this.options.dispatcherReload?.() ?? "not_configured",
        appliesOnDispatcherRestart: (this.options.dispatcherReload?.() ?? "not_configured") !== "applied",
      },
    };
  }

  /** Whether a global stop is also announced on the MQTT bridge (off unless an administrator turned it on). */
  globalStopPublished(): boolean {
    return resolveSafetyPublishStop(this.options.env.safetyPublishStop, this.file).value;
  }

  /** Whether the erase and the self-test of the F-RAM of the brain are offered (off unless an administrator turned it on). */
  framEraseEnabled(): boolean {
    return resolveFramErase(this.options.env.framErase, this.file).value;
  }

  /** The interval in milliseconds of the watch of the physical emergency stop (0: off). */
  estopWatchMs(): number {
    return resolveEstopWatchMs(this.options.env.estopWatch, this.file).value;
  }

  /** Whether the `enable` command may bring a disabled robot back (off unless an administrator turned it on). */
  robotEnableAllowed(): boolean {
    return resolveRobotAllowEnable(this.options.env.robotAllowEnable, this.file).value;
  }

  /** What the voice relay sends the voice service with every turn. */
  voiceOptions(): { includeHeardText: boolean; minConfidence: number } {
    return {
      includeHeardText: resolveVoiceHeardText(this.options.env.voiceHeardText, this.file).value,
      minConfidence: resolveVoiceMinConfidence(this.options.env.voiceMinConfidence, this.file).value,
    };
  }

  snapshot(): SecuritySnapshot {
    const tls = this.tls();
    return {
      aiAccess: resolveAiAccess(this.options.env.aiAccess, this.file),
      infoAuth: resolveInfoAuth(this.options.env.infoAuth, this.file),
      tls: {
        enabled: tls.enabled,
        source: tls.source,
        certPath: tls.certPath,
        keyPath: tls.keyPath,
        fingerprint256: tls.enabled ? certFingerprint(tls.certPath) : null,
        active: this.options.tlsActive,
        appliesOnRestart: tls.enabled !== this.options.tlsActive,
      },
      ble: {
        mode: resolveBleMode(this.options.env.bleGatt, this.file),
        requireEncryption: resolveBleEncryption(this.options.env.bleEncryption, this.file),
        activeMode: this.options.bleActiveMode ?? "off",
        appliesOnRestart: resolveBleMode(this.options.env.bleGatt, this.file).value !== (this.options.bleActiveMode ?? "off"),
      },
      robots: { allowEnable: resolveRobotAllowEnable(this.options.env.robotAllowEnable, this.file) },
      connections: { recordAddress: resolveConnectionRecordAddress(this.options.env.connectionRecordAddress, this.file) },
      production: { rdpLevel: resolveProductionRdpLevel(this.options.env.productionRdpLevel, this.file) },
      ingest: {
        ...(Object.fromEntries(INGEST_SWITCH_KEYS.map((key) => [key, resolveIngestSwitch(key, this.options.env.ingest?.[key], this.file)])) as Record<IngestSwitchKey, { value: boolean; source: Source }>),
        proposalKeysFile: resolveProposalKeysFile(this.options.env.ingest?.proposalKeysFile, this.file),
        // the two feeds that read the broker and the relay to the voice interface start with the server
        appliesOnRestart: this.ingestRestartPending(),
      },
      health: { open: resolveHealthOpen(this.options.env.healthOpen, this.file) },
      ecosystemHealth: { enabled: resolveEcosystemHealth(this.options.env.ecosystemHealth, this.file) },
      twinRelay: { enabled: resolveTwinRelay(this.options.env.twinRelay, this.file) },
      infoTickets: { enabled: resolveInfoTickets(this.options.env.infoTickets, this.file) },
      deviceTokens: { enabled: resolveDeviceTokens(this.options.env.deviceTokens, this.file) },
      updateCheck: { enabled: resolveUpdateCheck(this.options.env.updateCheck, this.file) },
      discovery: { advertiseAddress: resolveAdvertiseAddress(this.options.env.advertiseAddress, this.file) },
      maintenance: { enabled: resolveMaintenance(this.options.env.maintenance, this.file) },
      atc: { resetEnabled: resolveAtcReset(this.options.env.atcReset, this.file) },
      detectionHef: { acceptLoadedReports: resolveDetectionHefReports(this.file) },
      auth: { jwtAlgorithm: resolveJwtAlgorithm(this.options.env.jwtAlgorithm, this.file), acceptHs256: resolveJwtAcceptHs256(this.options.env.jwtAcceptHs256, this.file), keyOverlapSeconds: resolveKeyOverlapSeconds(this.file), serviceIdentity: { enabled: resolveServiceIdentity(this.options.env.serviceIdentity, this.file) } },
      presence: (() => {
        const p = presenceTimes(this.file.presence);
        return { enabled: resolvePresence(this.options.env.presence, this.file), action: resolvePresenceAction(this.options.env.presenceAction, this.file), ...p };
      })(),
      bridgeGateway: { enabled: resolveBridgeGateway(this.options.env.bridgeGateway, this.file) },
      push: { enabled: resolvePush(this.options.env.push, this.file), liveActivity: { ...resolveLiveActivity(this.file), maxLevel: MAX_LIVE_ACTIVITY_LEVEL } },
      trustedNetworks: (() => {
        const settings = this.trustedNetworks();
        return {
          enabled: resolveTrustedNetworksEnabled(this.options.env.trustedNetworks, this.file),
          outside: settings.outside,
          outsideRequiresSecondFactor: settings.outsideRequiresSecondFactor,
          localRanges: settings.local.length,
          vpnRanges: settings.vpn.length,
          invalidEntries: settings.invalid.length,
        };
      })(),
      rul: { enabled: resolveRul(this.options.env.rul, this.file) },
      safety: {
        publishGlobalStop: resolveSafetyPublishStop(this.options.env.safetyPublishStop, this.file),
        framErase: resolveFramErase(this.options.env.framErase, this.file),
        estopWatchMs: resolveEstopWatchMs(this.options.env.estopWatch, this.file),
      },
      jobDispatcher: this.jobDispatcherSnapshot(),
      camera: { open: resolveCameraOpen(this.options.env.cameraAuth, this.file), credentialsViaEnv: resolveCameraCredentialsViaEnv(this.options.env.cameraCredentialsViaEnv, this.file) },
      install: { newInstallTls: resolveNewInstallTls(this.options.env.newInstallTls, this.file) },
      websocket: { allowQueryToken: resolveWsQueryToken(this.options.env.wsQueryToken, this.file) },
      logging: { redactSecrets: resolveLogRedaction(this.options.env.logRedaction, this.file) },
      bridges: { ...resolveBridgeSettings(this.file.bridges), delivery: resolveBridgeGateway(this.options.env.bridgeGateway, this.file).value ? "gateway_on" : "gateway_off" },
      bridgeSigning: this.options.bridgeSigningStatus?.() ?? {},
      rateLimits: {
        enabled: resolveRateLimitsEnabled(this.options.env.rateLimits, this.file),
        ...(Object.fromEntries(RATE_LIMIT_KEYS.map((key) => [key, { ...resolveRateLimitNumber(key, this.options.env, this.file), min: RATE_LIMIT_BOUNDS[key].min, max: RATE_LIMIT_BOUNDS[key].max }])) as Record<RateLimitKey, { value: number; source: Source; min: number; max: number }>),
      },
      voice: {
        includeHeardText: resolveVoiceHeardText(this.options.env.voiceHeardText, this.file),
        minConfidence: resolveVoiceMinConfidence(this.options.env.voiceMinConfidence, this.file),
        requireSignature: resolveVoiceRequireSignature(this.options.env.voiceRequireSignature, this.file),
      },
      mavlink: (() => {
        const keyFile = resolveMavlinkKeyFile(this.options.env.mavlinkKeyFile, this.file);
        return {
          signingKeyFile: keyFile,
          signingAllowUnsigned: resolveMavlinkAllowUnsigned(this.options.env.mavlinkAllowUnsigned, this.file),
          signing: keyFile.value !== "",
          // the bridge reads the file once, when it starts
          appliesOnRestart: this.mavlinkTouched,
        };
      })(),
      mqtt: (() => {
        const settings = this.mqtt();
        return {
          mode: { value: settings.mode, source: settings.modeSource },
          url: redactMqttUrl(settings.url),
          prefix: settings.prefix,
          username: settings.username ?? null,
          commandUser: settings.commandUser ?? null,
          activeMode: this.options.mqttActiveMode ?? "off",
          appliesOnRestart: settings.mode !== (this.options.mqttActiveMode ?? "off"),
          homeAssistant: { enabled: { value: settings.homeAssistant, source: settings.homeAssistantSource }, discoveryPrefix: settings.discoveryPrefix },
        };
      })(),
    };
  }

  /** Applies a change asked for by an administrator; returns the new state and the warnings to show. */
  update(patch: any, actor: string): { snapshot: SecuritySnapshot; warnings: string[]; appliesOnRestart: boolean } {
    const warnings: string[] = [];
    const next: SecurityFile = { ...this.file, tls: this.file.tls ? { ...this.file.tls } : undefined, ble: this.file.ble ? { ...this.file.ble } : undefined, mqtt: this.file.mqtt ? { ...this.file.mqtt } : undefined, voice: this.file.voice ? { ...this.file.voice } : undefined, mavlink: this.file.mavlink ? { ...this.file.mavlink } : undefined, robots: this.file.robots ? { ...this.file.robots } : undefined, connections: this.file.connections ? { ...this.file.connections } : undefined, ingest: this.file.ingest ? { ...this.file.ingest } : undefined, health: this.file.health ? { ...this.file.health } : undefined, ecosystemHealth: this.file.ecosystemHealth ? { ...this.file.ecosystemHealth } : undefined, twinRelay: this.file.twinRelay ? { ...this.file.twinRelay } : undefined, infoTickets: this.file.infoTickets ? { ...this.file.infoTickets } : undefined, deviceTokens: this.file.deviceTokens ? { ...this.file.deviceTokens } : undefined, updateCheck: this.file.updateCheck ? { ...this.file.updateCheck } : undefined, discovery: this.file.discovery ? { ...this.file.discovery } : undefined, maintenance: this.file.maintenance ? { ...this.file.maintenance } : undefined, atc: this.file.atc ? { ...this.file.atc } : undefined, detectionHef: this.file.detectionHef ? { ...this.file.detectionHef } : undefined, presence: this.file.presence ? { ...this.file.presence } : undefined, bridgeGateway: this.file.bridgeGateway ? { ...this.file.bridgeGateway } : undefined, push: this.file.push ? { ...this.file.push } : undefined, trustedNetworks: this.file.trustedNetworks ? { ...this.file.trustedNetworks } : undefined, rul: this.file.rul ? { ...this.file.rul } : undefined, safety: this.file.safety ? { ...this.file.safety } : undefined, jobDispatcher: this.file.jobDispatcher ? { ...this.file.jobDispatcher } : undefined };
    let appliesOnRestart = false;
    const log = this.options.log ?? (() => undefined);
    const lockedBy = (name: string) => new SecurityConfigError(409, `${name} is set in the environment of this server; remove it there to change it here`);

    if (patch.aiAccess !== undefined) {
      if (patch.aiAccess !== "open" && patch.aiAccess !== "admin") throw new SecurityConfigError(400, 'aiAccess must be "open" or "admin"');
      if (resolveAiAccess(this.options.env.aiAccess, this.file).source === "env") throw lockedBy("HYDRA_UMC_AI_ACCESS");
      next.aiAccess = patch.aiAccess;
    }
    if (patch.infoAuth !== undefined) {
      if (typeof patch.infoAuth !== "boolean") throw new SecurityConfigError(400, "infoAuth must be true or false");
      if (resolveInfoAuth(this.options.env.infoAuth, this.file).source === "env") throw lockedBy("HYDRA_UMC_INFO_AUTH");
      next.infoAuth = patch.infoAuth;
      if (!patch.infoAuth) {
        warnings.push("info_auth_off");
      }
    }
    if (patch.tls !== undefined) {
      const tlsPatch = patch.tls;
      if (typeof tlsPatch !== "object" || tlsPatch === null || Array.isArray(tlsPatch)) throw new SecurityConfigError(400, "tls must be an object");
      if (this.tls().source === "env") throw lockedBy("TLS_CERT_PATH and TLS_KEY_PATH");
      const merged: TlsFile = { ...(next.tls ?? {}) };
      for (const field of ["certPath", "keyPath"] as const) {
        if (tlsPatch[field] !== undefined) {
          if (typeof tlsPatch[field] !== "string") throw new SecurityConfigError(400, `tls.${field} must be a text`);
          merged[field] = tlsPatch[field].trim();
        }
      }
      if (tlsPatch.enabled !== undefined) {
        if (typeof tlsPatch.enabled !== "boolean") throw new SecurityConfigError(400, "tls.enabled must be true or false");
        merged.enabled = tlsPatch.enabled;
      }
      if (merged.enabled === true) {
        if (!isSet(merged.certPath) || !isSet(merged.keyPath)) throw new SecurityConfigError(400, "tls needs both certPath and keyPath to be enabled");
        const problem = tlsFilesProblem(merged.certPath, merged.keyPath);
        if (problem) throw new SecurityConfigError(400, problem);
      }
      next.tls = merged;
      appliesOnRestart = true;
    }

    if (patch.ble !== undefined) {
      const blePatch = patch.ble;
      if (typeof blePatch !== "object" || blePatch === null || Array.isArray(blePatch)) throw new SecurityConfigError(400, "ble must be an object");
      const merged: BleFile = { ...(next.ble ?? {}) };
      if (blePatch.mode !== undefined) {
        if (!(BLE_MODES as readonly unknown[]).includes(blePatch.mode)) throw new SecurityConfigError(400, 'ble.mode must be "off", "state" or "commands"');
        if (resolveBleMode(this.options.env.bleGatt, this.file).source === "env") throw lockedBy("HYDRA_UMC_BLE_GATT");
        merged.mode = blePatch.mode;
      }
      if (blePatch.requireEncryption !== undefined) {
        if (typeof blePatch.requireEncryption !== "boolean") throw new SecurityConfigError(400, "ble.requireEncryption must be true or false");
        if (resolveBleEncryption(this.options.env.bleEncryption, this.file).source === "env") throw lockedBy("HYDRA_UMC_BLE_ENCRYPTION");
        merged.requireEncryption = blePatch.requireEncryption;
      }
      next.ble = merged;
      appliesOnRestart = true;
      const mode = resolveBleMode(this.options.env.bleGatt, { ble: merged }).value;
      const encrypted = resolveBleEncryption(this.options.env.bleEncryption, { ble: merged }).value;
      if (mode === "commands" && !encrypted) warnings.push("ble_commands_unencrypted");
    }

    if (patch.mqtt !== undefined) {
      const mqttPatch = patch.mqtt;
      if (typeof mqttPatch !== "object" || mqttPatch === null || Array.isArray(mqttPatch)) throw new SecurityConfigError(400, "mqtt must be an object");
      const merged: MqttFile = { ...(next.mqtt ?? {}) };
      const envOf = this.options.env.mqtt ?? {};
      if (mqttPatch.mode !== undefined) {
        if (!(MQTT_MODES as readonly unknown[]).includes(mqttPatch.mode)) throw new SecurityConfigError(400, 'mqtt.mode must be "off", "state" or "commands"');
        if (resolveMqttMode(envOf.mode, this.file).source === "env") throw lockedBy("HYDRA_UMC_MQTT_BRIDGE");
        merged.mode = mqttPatch.mode;
      }
      if (mqttPatch.url !== undefined) {
        const url = validMqttUrl(mqttPatch.url);
        if (!url) throw new SecurityConfigError(400, "mqtt.url must be an mqtt://, mqtts://, ws:// or wss:// address");
        if (isSet(envOf.url)) throw lockedBy("HYDRA_UMC_MQTT_URL");
        merged.url = url;
      }
      if (mqttPatch.prefix !== undefined) {
        const prefix = validMqttPrefix(mqttPatch.prefix);
        if (!prefix) throw new SecurityConfigError(400, "mqtt.prefix must be topic levels of letters, digits, . _ - separated by /");
        if (isSet(envOf.prefix)) throw lockedBy("HYDRA_UMC_MQTT_PREFIX");
        merged.prefix = prefix;
      }
      for (const field of ["username", "commandUser"] as const) {
        if (mqttPatch[field] !== undefined) {
          if (typeof mqttPatch[field] !== "string" || mqttPatch[field].length > 128 || /[ -]/.test(mqttPatch[field])) throw new SecurityConfigError(400, `mqtt.${field} must be a short text`);
          merged[field] = mqttPatch[field].trim();
        }
      }
      if (mqttPatch.homeAssistant !== undefined) {
        const haPatch = mqttPatch.homeAssistant;
        if (typeof haPatch !== "object" || haPatch === null || Array.isArray(haPatch)) throw new SecurityConfigError(400, "mqtt.homeAssistant must be an object");
        const mergedHa: NonNullable<MqttFile["homeAssistant"]> = { ...(merged.homeAssistant ?? {}) };
        if (haPatch.enabled !== undefined) {
          if (typeof haPatch.enabled !== "boolean") throw new SecurityConfigError(400, "mqtt.homeAssistant.enabled must be true or false");
          if (resolveMqttSettings(envOf, { mqtt: merged }).homeAssistantSource === "env") throw lockedBy("HYDRA_UMC_MQTT_HOME_ASSISTANT");
          mergedHa.enabled = haPatch.enabled;
          if (haPatch.enabled === true) warnings.push("mqtt_home_assistant_on");
        }
        if (haPatch.discoveryPrefix !== undefined) {
          const dp = validMqttPrefix(haPatch.discoveryPrefix);
          if (!dp) throw new SecurityConfigError(400, "mqtt.homeAssistant.discoveryPrefix must be topic levels of letters, digits, . _ - separated by /");
          mergedHa.discoveryPrefix = dp;
        }
        merged.homeAssistant = mergedHa;
      }
      next.mqtt = merged;
      appliesOnRestart = true;
      const resolved = resolveMqttSettings(envOf, { mqtt: merged });
      if (resolved.mode === "commands") {
        if (!resolved.commandUser) throw new SecurityConfigError(400, "mqtt commands need an account to carry them out (mqtt.commandUser, and its password in HYDRA_UMC_MQTT_COMMAND_PASSWORD or HYDRA_UMC_MQTT_COMMAND_PASSWORD_FILE)");
        warnings.push("mqtt_commands_on");
      }
    }

    if (patch.voice !== undefined) {
      const voicePatch = patch.voice;
      if (typeof voicePatch !== "object" || voicePatch === null || Array.isArray(voicePatch)) throw new SecurityConfigError(400, "voice must be an object");
      const merged: VoiceFile = { ...(next.voice ?? {}) };
      if (voicePatch.includeHeardText !== undefined) {
        if (typeof voicePatch.includeHeardText !== "boolean") throw new SecurityConfigError(400, "voice.includeHeardText must be true or false");
        if (resolveVoiceHeardText(this.options.env.voiceHeardText, this.file).source === "env") throw lockedBy("HYDRA_UMC_VOICE_UI_INCLUDE_HEARD_TEXT");
        merged.includeHeardText = voicePatch.includeHeardText;
      }
      if (voicePatch.minConfidence !== undefined) {
        if (!validConfidence(voicePatch.minConfidence)) throw new SecurityConfigError(400, "voice.minConfidence must be a number from 0 to 1");
        if (resolveVoiceMinConfidence(this.options.env.voiceMinConfidence, this.file).source === "env") throw lockedBy("HYDRA_UMC_VOICE_UI_MIN_CONFIDENCE");
        merged.minConfidence = voicePatch.minConfidence;
      }
      if (voicePatch.requireSignature !== undefined) {
        if (typeof voicePatch.requireSignature !== "boolean") throw new SecurityConfigError(400, "voice.requireSignature must be true or false");
        if (resolveVoiceRequireSignature(this.options.env.voiceRequireSignature, this.file).source === "env") throw lockedBy("HYDRA_UMC_VOICE_CONFIRM_REQUIRE_SIGNATURE");
        merged.requireSignature = voicePatch.requireSignature;
      }
      next.voice = merged;
      if (voicePatch.includeHeardText === true) warnings.push("voice_heard_text_on");
      if (voicePatch.minConfidence === 0) warnings.push("voice_confidence_off");
    }

    if (patch.robots !== undefined) {
      const robotsPatch = patch.robots;
      if (typeof robotsPatch !== "object" || robotsPatch === null || Array.isArray(robotsPatch)) throw new SecurityConfigError(400, "robots must be an object");
      const merged: RobotsFile = { ...(next.robots ?? {}) };
      if (robotsPatch.allowEnable !== undefined) {
        if (typeof robotsPatch.allowEnable !== "boolean") throw new SecurityConfigError(400, "robots.allowEnable must be true or false");
        if (resolveRobotAllowEnable(this.options.env.robotAllowEnable, this.file).source === "env") throw lockedBy("HYDRA_UMC_ROBOT_ALLOW_ENABLE");
        merged.allowEnable = robotsPatch.allowEnable;
      }
      next.robots = merged;
      if (robotsPatch.allowEnable === true) warnings.push("robot_enable_allowed");
    }

    if (patch.production !== undefined) {
      const productionPatch = patch.production;
      if (typeof productionPatch !== "object" || productionPatch === null || Array.isArray(productionPatch)) throw new SecurityConfigError(400, "production must be an object");
      const merged: ProductionFile = { ...(next.production ?? {}) };
      if (productionPatch.rdpLevel !== undefined) {
        if (productionPatch.rdpLevel !== 0 && productionPatch.rdpLevel !== 1) throw new SecurityConfigError(400, "production.rdpLevel must be 0 (off) or 1; level 2 is permanent and is not offered");
        if (this.options.env.productionRdpLevel !== undefined && resolveProductionRdpLevel(this.options.env.productionRdpLevel, this.file).source === "env") throw lockedBy("HYDRA_UMC_PRODUCTION_RDP_LEVEL");
        merged.rdpLevel = productionPatch.rdpLevel;
      }
      next.production = merged;
    }

    if (patch.ingest !== undefined) {
      const ingestPatch = patch.ingest;
      if (typeof ingestPatch !== "object" || ingestPatch === null || Array.isArray(ingestPatch)) throw new SecurityConfigError(400, "ingest must be an object");
      for (const key of Object.keys(ingestPatch)) {
        if (key !== "confirm" && key !== "proposalKeysFile" && !(INGEST_SWITCH_KEYS as readonly string[]).includes(key)) throw new SecurityConfigError(400, `ingest.${key} cannot be changed here`);
      }
      if (ingestPatch.confirm !== undefined && typeof ingestPatch.confirm !== "boolean") throw new SecurityConfigError(400, "ingest.confirm must be true or false");
      const merged: IngestFile = { ...(next.ingest ?? {}) };
      let turnsOn = false;
      for (const key of INGEST_SWITCH_KEYS) {
        if (ingestPatch[key] === undefined) continue;
        if (typeof ingestPatch[key] !== "boolean") throw new SecurityConfigError(400, `ingest.${key} must be true or false`);
        if (resolveIngestSwitch(key, this.options.env.ingest?.[key], this.file).source === "env") throw lockedBy(INGEST_SWITCH_VARIABLES[key]);
        if (ingestPatch[key] === true && resolveIngestSwitch(key, this.options.env.ingest?.[key], this.file).value !== true) turnsOn = true;
        merged[key] = ingestPatch[key];
      }
      if (ingestPatch.proposalKeysFile !== undefined) {
        const name = ingestPatch.proposalKeysFile;
        if (typeof name !== "string" || (name !== "" && (!PROPOSAL_KEYS_FILE_NAME.test(name) || name.includes("..")))) throw new SecurityConfigError(400, "ingest.proposalKeysFile must be the name of a file in the data folder of the server (letters, digits, dot, dash and underscore), or empty");
        if (resolveProposalKeysFile(this.options.env.ingest?.proposalKeysFile, this.file).source === "env") throw lockedBy(PROPOSAL_KEYS_VARIABLE);
        if (name === "") delete merged.proposalKeysFile;
        else {
          if (name !== this.file.ingest?.proposalKeysFile) turnsOn = true;
          merged.proposalKeysFile = name;
        }
      }
      if (turnsOn && ingestPatch.confirm !== true) throw new SecurityConfigError(400, "Turning on what this server accepts and keeps from the services, or changing the keys that vouch for trajectory proposals, needs confirm: true");
      next.ingest = merged;
      if (turnsOn) warnings.push("ingest_on");
      if (INGEST_SWITCH_KEYS.some((key) => ingestPatch[key] !== undefined && ["faultFeed", "anomalyFeed", "anomalyVoiceRelay"].includes(key))) appliesOnRestart = true;
    }

    if (patch.connections !== undefined) {
      const connectionsPatch = patch.connections;
      if (typeof connectionsPatch !== "object" || connectionsPatch === null || Array.isArray(connectionsPatch)) throw new SecurityConfigError(400, "connections must be an object");
      const merged: ConnectionsFile = { ...(next.connections ?? {}) };
      if (connectionsPatch.recordAddress !== undefined) {
        if (typeof connectionsPatch.recordAddress !== "boolean") throw new SecurityConfigError(400, "connections.recordAddress must be true or false");
        if (resolveConnectionRecordAddress(this.options.env.connectionRecordAddress, this.file).source === "env") throw lockedBy("HYDRA_UMC_CONNECTION_RECORD_ADDRESS");
        merged.recordAddress = connectionsPatch.recordAddress;
      }
      next.connections = merged;
      if (connectionsPatch.recordAddress === true) warnings.push("connection_address_recorded");
    }

    if (patch.health !== undefined) {
      const healthPatch = patch.health;
      if (typeof healthPatch !== "object" || healthPatch === null || Array.isArray(healthPatch)) throw new SecurityConfigError(400, "health must be an object");
      const merged: HealthFile = { ...(next.health ?? {}) };
      if (healthPatch.open !== undefined) {
        if (typeof healthPatch.open !== "boolean") throw new SecurityConfigError(400, "health.open must be true or false");
        if (resolveHealthOpen(this.options.env.healthOpen, this.file).source === "env") throw lockedBy("HYDRA_UMC_HEALTH_OPEN");
        merged.open = healthPatch.open;
      }
      next.health = merged;
      if (healthPatch.open === true) warnings.push("health_open");
    }

    if (patch.ecosystemHealth !== undefined) {
      const ecoPatch = patch.ecosystemHealth;
      if (typeof ecoPatch !== "object" || ecoPatch === null || Array.isArray(ecoPatch)) throw new SecurityConfigError(400, "ecosystemHealth must be an object");
      const merged: EcosystemHealthFile = { ...(next.ecosystemHealth ?? {}) };
      if (ecoPatch.enabled !== undefined) {
        if (typeof ecoPatch.enabled !== "boolean") throw new SecurityConfigError(400, "ecosystemHealth.enabled must be true or false");
        if (resolveEcosystemHealth(this.options.env.ecosystemHealth, this.file).source === "env") throw lockedBy("HYDRA_UMC_ECOSYSTEM_HEALTH");
        merged.enabled = ecoPatch.enabled;
      }
      next.ecosystemHealth = merged;
    }

    if (patch.twinRelay !== undefined) {
      const relayPatch = patch.twinRelay;
      if (typeof relayPatch !== "object" || relayPatch === null || Array.isArray(relayPatch)) throw new SecurityConfigError(400, "twinRelay must be an object");
      const merged: TwinRelayFile = { ...(next.twinRelay ?? {}) };
      if (relayPatch.enabled !== undefined) {
        if (typeof relayPatch.enabled !== "boolean") throw new SecurityConfigError(400, "twinRelay.enabled must be true or false");
        if (resolveTwinRelay(this.options.env.twinRelay, this.file).source === "env") throw lockedBy("HYDRA_UMC_TWIN_RELAY");
        merged.enabled = relayPatch.enabled;
      }
      next.twinRelay = merged;
    }

    if (patch.infoTickets !== undefined) {
      const ticketsPatch = patch.infoTickets;
      if (typeof ticketsPatch !== "object" || ticketsPatch === null || Array.isArray(ticketsPatch)) throw new SecurityConfigError(400, "infoTickets must be an object");
      const merged: InfoTicketsFile = { ...(next.infoTickets ?? {}) };
      if (ticketsPatch.enabled !== undefined) {
        if (typeof ticketsPatch.enabled !== "boolean") throw new SecurityConfigError(400, "infoTickets.enabled must be true or false");
        if (resolveInfoTickets(this.options.env.infoTickets, this.file).source === "env") throw lockedBy("HYDRA_UMC_INFO_TICKETS");
        merged.enabled = ticketsPatch.enabled;
        if (ticketsPatch.enabled === true) warnings.push("info_tickets_on");
      }
      next.infoTickets = merged;
    }

    if (patch.deviceTokens !== undefined) {
      const devicesPatch = patch.deviceTokens;
      if (typeof devicesPatch !== "object" || devicesPatch === null || Array.isArray(devicesPatch)) throw new SecurityConfigError(400, "deviceTokens must be an object");
      if (devicesPatch.confirm !== undefined && typeof devicesPatch.confirm !== "boolean") throw new SecurityConfigError(400, "deviceTokens.confirm must be true or false");
      const merged: DeviceTokensFile = { ...(next.deviceTokens ?? {}) };
      if (devicesPatch.enabled !== undefined) {
        if (typeof devicesPatch.enabled !== "boolean") throw new SecurityConfigError(400, "deviceTokens.enabled must be true or false");
        if (resolveDeviceTokens(this.options.env.deviceTokens, this.file).source === "env") throw lockedBy("HYDRA_UMC_DEVICE_TOKENS");
        // A device token signs a screen in without a person: turning that on needs the confirmation. Turning it off needs nothing and ends the sessions at their next renewal.
        if (devicesPatch.enabled === true && resolveDeviceTokens(this.options.env.deviceTokens, this.file).value !== true) {
          if (devicesPatch.confirm !== true) throw new SecurityConfigError(400, "Turning on the device tokens needs confirm: true");
          warnings.push("device_tokens_on");
        }
        merged.enabled = devicesPatch.enabled;
      }
      next.deviceTokens = merged;
    }

    if (patch.updateCheck !== undefined) {
      const updatePatch = patch.updateCheck;
      if (typeof updatePatch !== "object" || updatePatch === null || Array.isArray(updatePatch)) throw new SecurityConfigError(400, "updateCheck must be an object");
      const merged: UpdateCheckFile = { ...(next.updateCheck ?? {}) };
      if (updatePatch.enabled !== undefined) {
        if (typeof updatePatch.enabled !== "boolean") throw new SecurityConfigError(400, "updateCheck.enabled must be true or false");
        if (resolveUpdateCheck(this.options.env.updateCheck, this.file).source === "env") throw lockedBy("HYDRA_UMC_UPDATE_CHECK");
        merged.enabled = updatePatch.enabled;
        if (updatePatch.enabled === true) warnings.push("update_check_on");
      }
      next.updateCheck = merged;
    }

    if (patch.discovery !== undefined) {
      const discoveryPatch = patch.discovery;
      if (typeof discoveryPatch !== "object" || discoveryPatch === null || Array.isArray(discoveryPatch)) throw new SecurityConfigError(400, "discovery must be an object");
      const merged: DiscoveryFile = { ...(next.discovery ?? {}) };
      if (discoveryPatch.advertiseAddress !== undefined) {
        if (typeof discoveryPatch.advertiseAddress !== "boolean") throw new SecurityConfigError(400, "discovery.advertiseAddress must be true or false");
        if (resolveAdvertiseAddress(this.options.env.advertiseAddress, this.file).source === "env") throw lockedBy("HYDRA_UMC_ADVERTISE_ADDRESS");
        merged.advertiseAddress = discoveryPatch.advertiseAddress;
        if (discoveryPatch.advertiseAddress === true) warnings.push("discovery_address_on");
      }
      next.discovery = merged;
    }

    if (patch.maintenance !== undefined) {
      const maintenancePatch = patch.maintenance;
      if (typeof maintenancePatch !== "object" || maintenancePatch === null || Array.isArray(maintenancePatch)) throw new SecurityConfigError(400, "maintenance must be an object");
      if (maintenancePatch.confirm !== undefined && typeof maintenancePatch.confirm !== "boolean") throw new SecurityConfigError(400, "maintenance.confirm must be true or false");
      const merged: MaintenanceFile = { ...(next.maintenance ?? {}) };
      if (maintenancePatch.enabled !== undefined) {
        if (typeof maintenancePatch.enabled !== "boolean") throw new SecurityConfigError(400, "maintenance.enabled must be true or false");
        if (resolveMaintenance(this.options.env.maintenance, this.file).source === "env") throw lockedBy("HYDRA_UMC_MAINTENANCE");
        // The routes install and replace the programs of this machine: turning them on needs the confirmation. Turning them off needs nothing.
        if (maintenancePatch.enabled === true && resolveMaintenance(this.options.env.maintenance, this.file).value !== true) {
          if (maintenancePatch.confirm !== true) throw new SecurityConfigError(400, "Turning on the maintenance routes needs confirm: true");
          warnings.push("maintenance_on");
        }
        merged.enabled = maintenancePatch.enabled;
      }
      next.maintenance = merged;
    }

    if (patch.atc !== undefined) {
      const atcPatch = patch.atc;
      if (typeof atcPatch !== "object" || atcPatch === null || Array.isArray(atcPatch)) throw new SecurityConfigError(400, "atc must be an object");
      if (atcPatch.confirm !== undefined && typeof atcPatch.confirm !== "boolean") throw new SecurityConfigError(400, "atc.confirm must be true or false");
      const merged: AtcFile = { ...(next.atc ?? {}) };
      if (atcPatch.resetEnabled !== undefined) {
        if (typeof atcPatch.resetEnabled !== "boolean") throw new SecurityConfigError(400, "atc.resetEnabled must be true or false");
        if (resolveAtcReset(this.options.env.atcReset, this.file).source === "env") throw lockedBy("HYDRA_UMC_ATC_RESET");
        // The route puts back the arm state of a tool changer, so turning it on needs the confirmation. Turning it off needs nothing.
        if (atcPatch.resetEnabled === true && resolveAtcReset(this.options.env.atcReset, this.file).value !== true) {
          if (atcPatch.confirm !== true) throw new SecurityConfigError(400, "Turning on the reset of the tool changer needs confirm: true");
          warnings.push("atc_reset_on");
        }
        merged.resetEnabled = atcPatch.resetEnabled;
      }
      next.atc = merged;
    }

    if (patch.detectionHef !== undefined) {
      const hefPatch = patch.detectionHef;
      if (typeof hefPatch !== "object" || hefPatch === null || Array.isArray(hefPatch)) throw new SecurityConfigError(400, "detectionHef must be an object");
      if (hefPatch.confirm !== undefined && typeof hefPatch.confirm !== "boolean") throw new SecurityConfigError(400, "detectionHef.confirm must be true or false");
      const merged: DetectionHefFile = { ...(next.detectionHef ?? {}) };
      if (hefPatch.acceptLoadedReports !== undefined) {
        if (typeof hefPatch.acceptLoadedReports !== "boolean") throw new SecurityConfigError(400, "detectionHef.acceptLoadedReports must be true or false");
        // Accepting the reports of a loaded model lets the model be taken as seen by the safety chain: turning it on needs the confirmation.
        if (hefPatch.acceptLoadedReports === true && resolveDetectionHefReports(this.file).value !== true) {
          if (hefPatch.confirm !== true) throw new SecurityConfigError(400, "Turning on the reports of loaded models needs confirm: true");
          warnings.push("detection_hef_reports_on");
        }
        merged.acceptLoadedReports = hefPatch.acceptLoadedReports;
      }
      next.detectionHef = merged;
    }

    if (patch.auth !== undefined) {
      const authPatch = patch.auth;
      if (typeof authPatch !== "object" || authPatch === null || Array.isArray(authPatch)) throw new SecurityConfigError(400, "auth must be an object");
      const merged: AuthFile = { ...(next.auth ?? {}) };
      if (authPatch.jwtAlgorithm !== undefined) {
        if (!isJwtAlgorithm(authPatch.jwtAlgorithm)) throw new SecurityConfigError(400, 'auth.jwtAlgorithm must be "HS256" or "EdDSA"');
        if (resolveJwtAlgorithm(this.options.env.jwtAlgorithm, this.file).source === "env") throw lockedBy("HYDRA_UMC_JWT_ALGORITHM");
        merged.jwtAlgorithm = authPatch.jwtAlgorithm;
        if (authPatch.jwtAlgorithm === "EdDSA") warnings.push("jwt_eddsa_on");
      }
      if (authPatch.acceptHs256 !== undefined) {
        if (typeof authPatch.acceptHs256 !== "boolean") throw new SecurityConfigError(400, "auth.acceptHs256 must be true or false");
        if (resolveJwtAcceptHs256(this.options.env.jwtAcceptHs256, this.file).source === "env") throw lockedBy("HYDRA_UMC_JWT_ACCEPT_HS256");
        merged.acceptHs256 = authPatch.acceptHs256;
        if (authPatch.acceptHs256 === false) warnings.push("jwt_hs256_refused");
      }
      if (authPatch.serviceIdentity !== undefined) {
        const si = authPatch.serviceIdentity;
        if (typeof si !== "object" || si === null || Array.isArray(si)) throw new SecurityConfigError(400, "auth.serviceIdentity must be an object");
        for (const key of Object.keys(si)) if (key !== "enabled" && key !== "confirm") throw new SecurityConfigError(400, `auth.serviceIdentity.${key} cannot be changed here`);
        if (si.enabled === undefined) throw new SecurityConfigError(400, "auth.serviceIdentity.enabled must be true or false");
        if (typeof si.enabled !== "boolean") throw new SecurityConfigError(400, "auth.serviceIdentity.enabled must be true or false");
        if (si.confirm !== undefined && typeof si.confirm !== "boolean") throw new SecurityConfigError(400, "auth.serviceIdentity.confirm must be true or false");
        if (resolveServiceIdentity(this.options.env.serviceIdentity, this.file).source === "env") throw lockedBy("HYDRA_UMC_SERVICE_IDENTITY");
        if (si.enabled === true && si.confirm !== true) throw new SecurityConfigError(400, "Turning on the identity of the server in its calls to the services needs confirm: true (turn the key on in a service only after this)");
        merged.serviceIdentity = { enabled: si.enabled };
        warnings.push(si.enabled ? "service_identity_on" : "service_identity_off");
      }
      next.auth = merged;
    }

    if (patch.presence !== undefined) {
      const presencePatch = patch.presence;
      if (typeof presencePatch !== "object" || presencePatch === null || Array.isArray(presencePatch)) throw new SecurityConfigError(400, "presence must be an object");
      const merged: PresenceFile = { ...(next.presence ?? {}) };
      if (presencePatch.enabled !== undefined) {
        if (typeof presencePatch.enabled !== "boolean") throw new SecurityConfigError(400, "presence.enabled must be true or false");
        if (resolvePresence(this.options.env.presence, this.file).source === "env") throw lockedBy("HYDRA_UMC_PRESENCE");
        merged.enabled = presencePatch.enabled;
        if (presencePatch.enabled === true) warnings.push("presence_on");
      }
      if (presencePatch.action !== undefined) {
        if (!isPresenceAction(presencePatch.action)) throw new SecurityConfigError(400, "presence.action must be slow, pause, notify or stop");
        if (resolvePresenceAction(this.options.env.presenceAction, this.file).source === "env") throw lockedBy("HYDRA_UMC_PRESENCE_ACTION");
        merged.action = presencePatch.action;
        if (presencePatch.action === "notify") warnings.push("presence_action_notify");
      }
      next.presence = merged;
    }

    if (patch.bridgeGateway !== undefined) {
      const gatewayPatch = patch.bridgeGateway;
      if (typeof gatewayPatch !== "object" || gatewayPatch === null || Array.isArray(gatewayPatch)) throw new SecurityConfigError(400, "bridgeGateway must be an object");
      const merged: BridgeGatewayFile = { ...(next.bridgeGateway ?? {}) };
      if (gatewayPatch.enabled !== undefined) {
        if (typeof gatewayPatch.enabled !== "boolean") throw new SecurityConfigError(400, "bridgeGateway.enabled must be true or false");
        if (resolveBridgeGateway(this.options.env.bridgeGateway, this.file).source === "env") throw lockedBy("HYDRA_UMC_BRIDGE_GATEWAY");
        merged.enabled = gatewayPatch.enabled;
      }
      next.bridgeGateway = merged;
      if (gatewayPatch.enabled === true) warnings.push("bridge_gateway_on");
    }

    if (patch.push !== undefined) {
      const pushPatch = patch.push;
      if (typeof pushPatch !== "object" || pushPatch === null || Array.isArray(pushPatch)) throw new SecurityConfigError(400, "push must be an object");
      const merged: PushFile = { ...(next.push ?? {}) };
      if (pushPatch.enabled !== undefined) {
        if (typeof pushPatch.enabled !== "boolean") throw new SecurityConfigError(400, "push.enabled must be true or false");
        if (resolvePush(this.options.env.push, this.file).source === "env") throw lockedBy("HYDRA_UMC_PUSH");
        merged.enabled = pushPatch.enabled;
      }
      if (pushPatch.liveActivity !== undefined) {
        const live = pushPatch.liveActivity;
        if (typeof live !== "object" || live === null || Array.isArray(live)) throw new SecurityConfigError(400, "push.liveActivity must be an object");
        if (live.confirm !== undefined && typeof live.confirm !== "boolean") throw new SecurityConfigError(400, "push.liveActivity.confirm must be true or false");
        const before = resolveLiveActivity(this.file);
        const mergedLive: LiveActivityFile = { ...(merged.liveActivity ?? {}) };
        let exposes = false;
        if (live.enabled !== undefined) {
          if (typeof live.enabled !== "boolean") throw new SecurityConfigError(400, "push.liveActivity.enabled must be true or false");
          if (live.enabled === true && before.enabled.value !== true) exposes = true;
          mergedLive.enabled = live.enabled;
        }
        if (live.level !== undefined) {
          if (!isLiveLevel(live.level)) throw new SecurityConfigError(400, `push.liveActivity.level must be one of ${LIVE_ACTIVITY_LEVELS.join(", ")}`);
          if (raisesExposure(before.level.value, live.level)) exposes = true;
          mergedLive.level = live.level;
        }
        // more on a lock screen, or the card on at all, is what a person who only holds the phone can read: it asks for the confirmation. Less never does.
        if (exposes) {
          if (live.confirm !== true) throw new SecurityConfigError(400, "Turning on the Live Activity or raising its level needs confirm: true");
          warnings.push("live_activity_exposure_raised");
        }
        merged.liveActivity = mergedLive;
      }
      next.push = merged;
      if (pushPatch.enabled === true) warnings.push("push_enabled");
    }

    if (patch.trustedNetworks !== undefined) {
      const netPatch = patch.trustedNetworks;
      if (typeof netPatch !== "object" || netPatch === null || Array.isArray(netPatch)) throw new SecurityConfigError(400, "trustedNetworks must be an object");
      const merged: TrustedNetworksFile = { ...(next.trustedNetworks ?? {}) };
      if (netPatch.enabled !== undefined) {
        if (typeof netPatch.enabled !== "boolean") throw new SecurityConfigError(400, "trustedNetworks.enabled must be true or false");
        if (resolveTrustedNetworksEnabled(this.options.env.trustedNetworks, this.file).source === "env") throw lockedBy("HYDRA_UMC_TRUSTED_NETWORKS");
        merged.enabled = netPatch.enabled;
      }
      next.trustedNetworks = merged;
      if (netPatch.enabled === true) warnings.push("trusted_networks_on");
    }

    if (patch.rul !== undefined) {
      const rulPatch = patch.rul;
      if (typeof rulPatch !== "object" || rulPatch === null || Array.isArray(rulPatch)) throw new SecurityConfigError(400, "rul must be an object");
      const merged: RulFile = { ...(next.rul ?? {}) };
      if (rulPatch.enabled !== undefined) {
        if (typeof rulPatch.enabled !== "boolean") throw new SecurityConfigError(400, "rul.enabled must be true or false");
        if (resolveRul(this.options.env.rul, this.file).source === "env") throw lockedBy("HYDRA_UMC_RUL");
        merged.enabled = rulPatch.enabled;
      }
      next.rul = merged;
    }

    if (patch.camera !== undefined) {
      const cameraPatch = patch.camera;
      if (typeof cameraPatch !== "object" || cameraPatch === null || Array.isArray(cameraPatch)) throw new SecurityConfigError(400, "camera must be an object");
      const merged: CameraFile = { ...(next.camera ?? {}) };
      if (cameraPatch.open !== undefined) {
        if (typeof cameraPatch.open !== "boolean") throw new SecurityConfigError(400, "camera.open must be true or false");
        if (resolveCameraOpen(this.options.env.cameraAuth, this.file).source === "env") throw lockedBy("HYDRA_UMC_CAMERA_AUTH");
        merged.open = cameraPatch.open;
      }
      if (cameraPatch.credentialsViaEnv !== undefined) {
        if (typeof cameraPatch.credentialsViaEnv !== "boolean") throw new SecurityConfigError(400, "camera.credentialsViaEnv must be true or false");
        if (resolveCameraCredentialsViaEnv(this.options.env.cameraCredentialsViaEnv, this.file).source === "env") throw lockedBy("HYDRA_UMC_CAMERA_CREDENTIALS_VIA_ENV");
        merged.credentialsViaEnv = cameraPatch.credentialsViaEnv;
      }
      next.camera = merged;
      if (cameraPatch.open === true) warnings.push("camera_open");
      if (cameraPatch.credentialsViaEnv === false) warnings.push("camera_credentials_in_arguments");
    }

    if (patch.install !== undefined) {
      const installPatch = patch.install;
      if (typeof installPatch !== "object" || installPatch === null || Array.isArray(installPatch)) throw new SecurityConfigError(400, "install must be an object");
      const merged: InstallFile = { ...(next.install ?? {}) };
      if (installPatch.newInstallTls !== undefined) {
        if (typeof installPatch.newInstallTls !== "boolean") throw new SecurityConfigError(400, "install.newInstallTls must be true or false");
        if (resolveNewInstallTls(this.options.env.newInstallTls, this.file).source === "env") throw lockedBy("HYDRA_UMC_NEW_INSTALL_TLS");
        merged.newInstallTls = installPatch.newInstallTls;
      }
      next.install = merged;
      if (installPatch.newInstallTls === false) warnings.push("new_install_tls_off");
    }

    if (patch.websocket !== undefined) {
      const websocketPatch = patch.websocket;
      if (typeof websocketPatch !== "object" || websocketPatch === null || Array.isArray(websocketPatch)) throw new SecurityConfigError(400, "websocket must be an object");
      const merged: WebsocketFile = { ...(next.websocket ?? {}) };
      if (websocketPatch.allowQueryToken !== undefined) {
        if (typeof websocketPatch.allowQueryToken !== "boolean") throw new SecurityConfigError(400, "websocket.allowQueryToken must be true or false");
        if (resolveWsQueryToken(this.options.env.wsQueryToken, this.file).source === "env") throw lockedBy("HYDRA_UMC_WS_QUERY_TOKEN");
        merged.allowQueryToken = websocketPatch.allowQueryToken;
      }
      next.websocket = merged;
      if (websocketPatch.allowQueryToken === true) warnings.push("ws_query_token_allowed");
    }

    if (patch.logging !== undefined) {
      const loggingPatch = patch.logging;
      if (typeof loggingPatch !== "object" || loggingPatch === null || Array.isArray(loggingPatch)) throw new SecurityConfigError(400, "logging must be an object");
      const merged: LoggingFile = { ...(next.logging ?? {}) };
      if (loggingPatch.redactSecrets !== undefined) {
        if (typeof loggingPatch.redactSecrets !== "boolean") throw new SecurityConfigError(400, "logging.redactSecrets must be true or false");
        if (resolveLogRedaction(this.options.env.logRedaction, this.file).source === "env") throw lockedBy("HYDRA_UMC_LOG_REDACTION");
        merged.redactSecrets = loggingPatch.redactSecrets;
      }
      next.logging = merged;
      if (loggingPatch.redactSecrets === false) warnings.push("log_redaction_off");
    }

    if (patch.safety !== undefined) {
      const safetyPatch = patch.safety;
      if (typeof safetyPatch !== "object" || safetyPatch === null || Array.isArray(safetyPatch)) throw new SecurityConfigError(400, "safety must be an object");
      const merged: SafetyFile = { ...(next.safety ?? {}) };
      if (safetyPatch.publishGlobalStop !== undefined) {
        if (typeof safetyPatch.publishGlobalStop !== "boolean") throw new SecurityConfigError(400, "safety.publishGlobalStop must be true or false");
        if (resolveSafetyPublishStop(this.options.env.safetyPublishStop, this.file).source === "env") throw lockedBy("HYDRA_UMC_SAFETY_PUBLISH_STOP");
        merged.publishGlobalStop = safetyPatch.publishGlobalStop;
      }
      if (safetyPatch.framErase !== undefined) {
        if (typeof safetyPatch.framErase !== "boolean") throw new SecurityConfigError(400, "safety.framErase must be true or false");
        if (resolveFramErase(this.options.env.framErase, this.file).source === "env") throw lockedBy("HYDRA_UMC_FRAM_ERASE");
        if (safetyPatch.framErase === true && patch.safety.confirm !== true) throw new SecurityConfigError(400, "turning the F-RAM erase on needs confirm: true");
        merged.framErase = safetyPatch.framErase;
      }
      if (safetyPatch.estopWatchMs !== undefined) {
        if (!validEstopWatchMs(safetyPatch.estopWatchMs)) throw new SecurityConfigError(400, "safety.estopWatchMs must be 0 (off) or a whole number of milliseconds from 500 to 60000");
        if (resolveEstopWatchMs(this.options.env.estopWatch, this.file).source === "env") throw lockedBy("HYDRA_UMC_ESTOP_WATCH_MS");
        merged.estopWatchMs = safetyPatch.estopWatchMs;
        appliesOnRestart = true;
      }
      next.safety = merged;
      if (safetyPatch.publishGlobalStop === true) warnings.push("global_stop_published");
      if (safetyPatch.framErase === true) warnings.push("fram_erase_on");
    }

    let replanWritten = false;
    if (patch.jobDispatcher !== undefined) {
      const jd = patch.jobDispatcher;
      if (typeof jd !== "object" || jd === null || Array.isArray(jd)) throw new SecurityConfigError(400, "jobDispatcher must be an object");
      for (const key of Object.keys(jd)) if (key !== "stopRelay" && key !== "replan") throw new SecurityConfigError(400, `jobDispatcher.${key} cannot be changed here`);
      const merged: JobDispatcherFile = { ...(next.jobDispatcher ?? {}) };
      if (jd.stopRelay !== undefined) {
        const sr = jd.stopRelay;
        if (typeof sr !== "object" || sr === null || Array.isArray(sr)) throw new SecurityConfigError(400, "jobDispatcher.stopRelay must be an object");
        for (const key of Object.keys(sr)) if (key !== "enabled" && key !== "robotMap") throw new SecurityConfigError(400, `jobDispatcher.stopRelay.${key} cannot be changed here`);
        const relay = { ...(merged.stopRelay ?? {}) };
        if (sr.enabled !== undefined) {
          if (typeof sr.enabled !== "boolean") throw new SecurityConfigError(400, "jobDispatcher.stopRelay.enabled must be true or false");
          if (resolveJobStopRelay(this.options.env.jobStopRelay, this.file).source === "env") throw lockedBy("HYDRA_UMC_JOB_STOP_RELAY");
          relay.enabled = sr.enabled;
          appliesOnRestart = true;
          if (sr.enabled) warnings.push("job_stop_relay_on");
        }
        if (sr.robotMap !== undefined) {
          const map = sr.robotMap;
          if (typeof map !== "object" || map === null || Array.isArray(map)) throw new SecurityConfigError(400, "jobDispatcher.stopRelay.robotMap must be an object");
          const entries = Object.entries(map);
          if (entries.length > MAX_ROBOT_MAP_ENTRIES) throw new SecurityConfigError(400, `jobDispatcher.stopRelay.robotMap has at most ${MAX_ROBOT_MAP_ENTRIES} entries`);
          const clean: Record<string, number> = {};
          for (const [dispatcherId, serverId] of entries) {
            if (!ROBOT_MAP_KEY.test(dispatcherId)) throw new SecurityConfigError(400, `jobDispatcher.stopRelay.robotMap: "${dispatcherId.slice(0, 64)}" is not a robot id of the dispatcher (1 to 64 characters: letters, digits, . _ : -)`);
            if (typeof serverId !== "number" || !Number.isInteger(serverId) || serverId < 0) throw new SecurityConfigError(400, `jobDispatcher.stopRelay.robotMap: "${dispatcherId}" must map to a robot id of this server (a whole number, 0 or more)`);
            clean[dispatcherId] = serverId;
          }
          relay.robotMap = clean;
        }
        merged.stopRelay = relay;
      }
      if (jd.replan !== undefined) {
        const rp = jd.replan;
        if (typeof rp !== "object" || rp === null || Array.isArray(rp)) throw new SecurityConfigError(400, "jobDispatcher.replan must be an object");
        for (const key of Object.keys(rp)) if (key !== "allowUnconfirmed" && key !== "stopAckTimeoutSeconds") throw new SecurityConfigError(400, `jobDispatcher.replan.${key} cannot be changed here`);
        if (rp.allowUnconfirmed !== undefined && typeof rp.allowUnconfirmed !== "boolean") throw new SecurityConfigError(400, "jobDispatcher.replan.allowUnconfirmed must be true or false");
        if (rp.stopAckTimeoutSeconds !== undefined && !validTimeout(rp.stopAckTimeoutSeconds)) throw new SecurityConfigError(400, "jobDispatcher.replan.stopAckTimeoutSeconds must be a number greater than 0 and at most 86400");
        const configFile = resolveDispatcherConfigFile(this.options.env.jobDispatcherConfig, this.file);
        if (configFile === "") throw new SecurityConfigError(409, "the configuration file of the dispatcher is not set on this server (HYDRA_UMC_JOB_DISPATCHER_CONFIG or jobDispatcher.configFile); the replanning options cannot be changed here");
        // The current values are those of the file the dispatcher will read; a field the request leaves out keeps them.
        let current;
        try {
          current = readReplanOptions(configFile);
        } catch (error) {
          throw new SecurityConfigError(409, error instanceof DispatcherConfigError ? error.message : "the configuration file of the dispatcher cannot be read");
        }
        const wanted = {
          allowUnconfirmed: rp.allowUnconfirmed ?? current.allowUnconfirmed,
          stopAckTimeoutSeconds: rp.stopAckTimeoutSeconds ?? current.stopAckTimeoutSeconds,
        };
        // The file first: if it cannot be written nothing is saved here, so the two never disagree about a change that was refused.
        try {
          writeReplanOptions(configFile, wanted);
        } catch (error) {
          throw new SecurityConfigError(409, error instanceof DispatcherConfigError ? error.message : "the configuration file of the dispatcher could not be written");
        }
        merged.replan = { ...wanted };
        replanWritten = true;
        if (wanted.allowUnconfirmed) warnings.push("replan_unconfirmed_allowed");
      }
      next.jobDispatcher = merged;
    }

    if (patch.mavlink !== undefined) {
      const mavPatch = patch.mavlink;
      if (typeof mavPatch !== "object" || mavPatch === null || Array.isArray(mavPatch)) throw new SecurityConfigError(400, "mavlink must be an object");
      const merged: MavlinkFile = { ...(next.mavlink ?? {}) };
      if (mavPatch.signingKeyFile !== undefined) {
        if (typeof mavPatch.signingKeyFile !== "string" || mavPatch.signingKeyFile.length > 1024 || /[\u0000-\u001f]/.test(mavPatch.signingKeyFile)) {
          throw new SecurityConfigError(400, "mavlink.signingKeyFile must be a file path (or empty for no signing)");
        }
        if (resolveMavlinkKeyFile(this.options.env.mavlinkKeyFile, this.file).source === "env") throw lockedBy("HYDRA_UMC_BRIDGE_UAV_SIGNING_KEY_FILE");
        const keyPath = mavPatch.signingKeyFile.trim();
        if (keyPath !== "") {
          const problem = mavlinkKeyFileProblem(keyPath);
          if (problem) throw new SecurityConfigError(400, problem);
        }
        merged.signingKeyFile = keyPath;
      }
      if (mavPatch.signingAllowUnsigned !== undefined) {
        if (typeof mavPatch.signingAllowUnsigned !== "boolean") throw new SecurityConfigError(400, "mavlink.signingAllowUnsigned must be true or false");
        if (resolveMavlinkAllowUnsigned(this.options.env.mavlinkAllowUnsigned, this.file).source === "env") throw lockedBy("HYDRA_UMC_BRIDGE_UAV_SIGNING_ALLOW_UNSIGNED");
        merged.signingAllowUnsigned = mavPatch.signingAllowUnsigned;
      }
      next.mavlink = merged;
      appliesOnRestart = true;
      const signing = resolveMavlinkKeyFile(this.options.env.mavlinkKeyFile, { mavlink: merged }).value !== "";
      const unsigned = resolveMavlinkAllowUnsigned(this.options.env.mavlinkAllowUnsigned, { mavlink: merged }).value;
      if (signing && unsigned) warnings.push("mavlink_unsigned_allowed");
      if (!signing) warnings.push("mavlink_signing_off");
    }

    if (patch.rateLimits !== undefined) {
      const limitsPatch = patch.rateLimits;
      if (typeof limitsPatch !== "object" || limitsPatch === null || Array.isArray(limitsPatch)) throw new SecurityConfigError(400, "rateLimits must be an object");
      const known = new Set<string>(["enabled", ...RATE_LIMIT_KEYS]);
      for (const field of Object.keys(limitsPatch)) if (!known.has(field)) throw new SecurityConfigError(400, `rateLimits.${field} is not a known option`);
      const merged: RateLimitsFile = { ...(next.rateLimits ?? {}) };
      if (limitsPatch.enabled !== undefined) {
        if (typeof limitsPatch.enabled !== "boolean") throw new SecurityConfigError(400, "rateLimits.enabled must be true or false");
        if (resolveRateLimitsEnabled(this.options.env.rateLimits, this.file).source === "env") throw lockedBy(RATE_LIMITS_ENV_SWITCH);
        merged.enabled = limitsPatch.enabled;
        if (limitsPatch.enabled === false) warnings.push("rate_limits_off");
      }
      for (const key of RATE_LIMIT_KEYS) {
        if (limitsPatch[key] === undefined) continue;
        const bounds = RATE_LIMIT_BOUNDS[key];
        if (!validRateLimitNumber(key, limitsPatch[key])) throw new SecurityConfigError(400, `rateLimits.${key} must be a whole number from ${bounds.min} to ${bounds.max}`);
        if (resolveRateLimitNumber(key, this.options.env, this.file).source === "env") throw lockedBy(RATE_LIMIT_ENV_NAMES[key]);
        merged[key] = limitsPatch[key];
      }
      next.rateLimits = merged;
      const effective = rateLimitSettings(this.options.env, { ...next, rateLimits: merged });
      if (effective.enabled && (effective.loginMax > 20 || effective.sensitiveMax > 300)) warnings.push("rate_limits_loose");
    }

    if (patch.bridges !== undefined) {
      try {
        const result = applyBridgesPatch(this.file.bridges, patch.bridges);
        next.bridges = result.next;
        warnings.push(...result.warnings);
      } catch (error) {
        throw new SecurityConfigError(400, error instanceof Error ? error.message : "bridges is not valid");
      }
    }

    this.options.save(next);
    this.file = next;
    // the file is on disk and the settings are saved: now the dispatcher is asked to read it (the answer comes later)
    if (replanWritten) this.options.afterReplanWritten?.();
    if (patch.bridges !== undefined) this.options.afterBridgesWritten?.();
    // the settings file of DETECTION-HEF follows the saved value; a failed write is told, never hidden
    if (patch.detectionHef?.acceptLoadedReports !== undefined) {
      try {
        this.options.writeDetectionHefSettings?.(resolveDetectionHefReports(next).value, next.detectionHef?.settingsFile);
      } catch (error) {
        warnings.push("detection_hef_settings_file_not_written");
        log(`[SECURITY] The settings file of DETECTION-HEF could not be written: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    if (patch.mavlink !== undefined) this.mavlinkTouched = true;
    const snapshot = this.snapshot();
    if (patch.aiAccess !== undefined) log(`[SECURITY] ${actor} set the local AI relay access to ${snapshot.aiAccess.value}.`);
    if (patch.infoAuth !== undefined) {
      log(
        snapshot.infoAuth.value
          ? `[SECURITY] ${actor} made the host information (metrics, supervisor, ecosystem status) ask for a signed-in client.`
          : `[SECURITY] ${actor} turned the sign-in requirement for the host information OFF: it is readable by the whole network.`,
      );
    }
    if (patch.ble !== undefined) {
      log(`[SECURITY] ${actor} set Bluetooth to ${snapshot.ble.mode.value}${snapshot.ble.requireEncryption.value ? "" : " WITHOUT link encryption"}; it applies on the next start.`);
    }
    if (patch.mqtt !== undefined) {
      log(`[SECURITY] ${actor} set the MQTT bridge to ${snapshot.mqtt.mode.value}${snapshot.mqtt.mode.value === "commands" ? ` (commands carried out as ${snapshot.mqtt.commandUser})` : ""}; it applies on the next start.`);
    }
    if (patch.voice !== undefined) {
      log(`[SECURITY] ${actor} set the voice options: transcript in replies ${snapshot.voice.includeHeardText.value ? "ON" : "off"}, minimum confidence ${snapshot.voice.minConfidence.value}, signature of a confirmed request ${snapshot.voice.requireSignature.value ? "required" : "not required"}.`);
    }
    if (patch.robots !== undefined) {
      log(`[SECURITY] ${actor} ${snapshot.robots.allowEnable.value ? "allowed" : "forbade"} bringing a disabled robot back with the enable command (an administrator only).`);
    }
    if (patch.production !== undefined) {
      log(`[SECURITY] ${actor} set the read-out protection level of a production flash to ${snapshot.production.rdpLevel.value} (${snapshot.production.rdpLevel.value === 1 ? "on" : "off"}).`);
    }

    if (patch.ingest !== undefined) {
      const state = snapshot.ingest;
      const listed = INGEST_SWITCH_KEYS.filter((key) => state[key].value).join(", ") || "none";
      log(`[SECURITY] ${actor} set what this server accepts and keeps from the services; on now: ${listed}; keys file of the proposals: ${state.proposalKeysFile.value ? "set" : "none"}. The feeds that read the broker apply on the next start.`);
    }
    if (patch.connections !== undefined) {
      log(`[SECURITY] ${actor} ${snapshot.connections.recordAddress.value ? "allowed" : "forbade"} keeping the address and user agent of the clients in the history of connections.`);
    }
    if (patch.camera !== undefined) {
      log(`[SECURITY] ${actor} ${snapshot.camera.open.value ? "OPENED the camera pictures to the whole network (no ticket needed)" : "made the camera pictures ask for a ticket or a signed-in client"}; the password of an IP camera ${snapshot.camera.credentialsViaEnv.value ? "goes to its process through the environment" : "is on the command line of its process (visible in the process table)"}.`);
    }
    if (patch.install !== undefined) {
      log(`[SECURITY] ${actor} ${snapshot.install.newInstallTls.value ? "allowed" : "forbade"} a new installation to start with TLS on by itself.`);
    }
    if (patch.websocket !== undefined) {
      log(`[SECURITY] ${actor} ${snapshot.websocket.allowQueryToken.value ? "allowed a token in the address of the WebSocket (it is recorded in proxy and server logs)" : "forbade a token in the address of the WebSocket"}.`);
    }
    if (patch.rateLimits !== undefined) {
      const r = snapshot.rateLimits;
      log(`[SECURITY] ${actor} set the request limits per address: ${r.enabled.value ? "ON" : "OFF"}; sign-in ${r.loginMax.value} failed per ${r.loginWindowSeconds.value} s, renewals ${r.refreshMax.value}, API ${r.apiMax.value} and code/service routes ${r.sensitiveMax.value} per ${r.apiWindowSeconds.value} s, global stop ${r.stopAllMax.value} per ${r.stopAllWindowSeconds.value} s.`);
    }
    if (patch.bridges !== undefined) {
      const changed = Object.entries(patch.bridges as Record<string, Record<string, unknown>>).flatMap(([b, o]) => Object.entries(o).map(([k, v]) => `${b}.${k}=${String(v)}`));
      log(`[SECURITY] ${actor} set the switches of the machine bridges (${changed.join(", ")}); ${snapshot.bridges.delivery === "gateway_on" ? "they are announced to the bridges" : "the bridge gateway is off, so nothing is announced"}.`);
    }
    if (patch.logging !== undefined) {
      log(`[SECURITY] ${actor} turned the blanking of secrets in the log ${snapshot.logging.redactSecrets.value ? "on" : "OFF"}.`);
    }
    if (patch.health !== undefined) {
      log(`[SECURITY] ${actor} ${snapshot.health.open.value ? "opened" : "closed"} GET /health to clients that are not signed in.`);
    }
    if (patch.push !== undefined) {
      if (patch.push.enabled !== undefined) log(`[SECURITY] ${actor} turned the push notifications to the registered phones ${snapshot.push.enabled.value ? "on" : "off"}.`);
      if (patch.push.liveActivity !== undefined) log(`[SECURITY] ${actor} set the Live Activity on the lock screen to ${snapshot.push.liveActivity.enabled.value ? "on" : "off"}, showing ${snapshot.push.liveActivity.level.value}.`);
    }
    if (patch.ecosystemHealth !== undefined) {
      log(`[SECURITY] ${actor} turned the health of the ecosystem (GET /api/ecosystem/health) ${snapshot.ecosystemHealth.enabled.value ? "on" : "off"}.`);
    }
    if (patch.twinRelay !== undefined) {
      log(`[SECURITY] ${actor} turned the relay of the live state of the twin (WebSocket /api/twin/ws) ${snapshot.twinRelay.enabled.value ? "on" : "off"}.`);
    }
    if (patch.infoTickets !== undefined) {
      log(`[SECURITY] ${actor} turned the signed tickets of the information routes (POST /api/info/ticket) ${snapshot.infoTickets.enabled.value ? "on" : "off"}.`);
    }
    if (patch.deviceTokens !== undefined) {
      log(`[SECURITY] ${actor} turned the device tokens (POST /api/admin/device-tokens, POST /api/device/login) ${snapshot.deviceTokens.enabled.value ? "on" : "off"}.`);
    }
    if (patch.updateCheck !== undefined) {
      log(`[SECURITY] ${actor} turned the look at the newest published versions (GET /api/admin/updates) ${snapshot.updateCheck.enabled.value ? "on (this server now asks GitHub)" : "off"}.`);
    }
    if (patch.maintenance !== undefined) {
      log(`[SECURITY] ${actor} turned the maintenance routes (/api/admin/maintenance) ${snapshot.maintenance.enabled.value ? "on (an administrator can now install, go back and prune releases)" : "off"}.`);
    }
    if (patch.atc !== undefined) {
      log(`[SECURITY] ${actor} turned the reset of the arm state of the tool changers (POST /api/tool-arms/reset) ${snapshot.atc.resetEnabled.value ? "on (an administrator can now put back the arm state of a stopped, disarmed robot)" : "off"}.`);
    }
    if (patch.detectionHef?.acceptLoadedReports !== undefined) {
      log(`[SECURITY] ${actor} turned the reports of loaded models of DETECTION-HEF ${snapshot.detectionHef.acceptLoadedReports.value ? "on" : "off"}.`);
    }
    if (patch.discovery !== undefined) {
      log(`[SECURITY] ${actor} ${snapshot.discovery.advertiseAddress.value ? "let" : "stopped"} GET /api/hydra-info list${snapshot.discovery.advertiseAddress.value ? "" : "ing"} the addresses of this server to clients that are not signed in.`);
    }
    if (patch.auth?.serviceIdentity !== undefined) {
      log(`[SECURITY] ${actor} turned the identity of this server in its calls to the services ${snapshot.auth.serviceIdentity.enabled.value ? "ON (a service with its identity key on now receives a signed token)" : "off (a service with its identity key on will refuse this server)"}.`);
    }
    if (patch.auth?.jwtAlgorithm !== undefined || patch.auth?.acceptHs256 !== undefined) {
      log(`[SECURITY] ${actor} set the sign-in tokens: signed with ${snapshot.auth.jwtAlgorithm.value}${snapshot.auth.jwtAlgorithm.value === "EdDSA" ? ` (public keys at /.well-known/jwks.json), HS256 tokens ${snapshot.auth.acceptHs256.value ? "still accepted" : "REFUSED"}` : ""}.`);
    }
    if (patch.presence !== undefined) {
      log(`[SECURITY] ${actor} set the dead-man of the presence of the operator (POST /api/operator/presence): ${snapshot.presence.enabled.value ? "on" : "off"}, a lost heartbeat will ${snapshot.presence.action.value === "slow" ? "slow the robots down" : snapshot.presence.action.value === "pause" ? "pause the robots" : snapshot.presence.action.value === "stop" ? "stop the robots" : "only warn (no robot is touched)"}.`);
    }
    if (patch.bridgeGateway !== undefined) {
      log(`[SECURITY] ${actor} turned the gateway to the machine bridges (GET /api/bridges, POST /api/bridges/:name/cmd/:verb) ${snapshot.bridgeGateway.enabled.value ? "on" : "off"}.`);
    }
    if (patch.trustedNetworks !== undefined) {
      log(`[SECURITY] ${actor} turned the trusted networks ${snapshot.trustedNetworks.enabled.value ? "ON (administering the server and signing in without the second factor are refused from outside the listed networks)" : "off"}.`);
    }
    if (patch.rul !== undefined) {
      log(`[SECURITY] ${actor} turned the remaining-useful-life relay for operators (POST /api/ai/anomaly-detector/rul) ${snapshot.rul.enabled.value ? "on" : "off"}.`);
    }
    if (patch.safety !== undefined) {
      log(`[SECURITY] ${actor} ${snapshot.safety.publishGlobalStop.value ? "allowed" : "forbade"} announcing a global stop on the MQTT bridge; the F-RAM erase of the brain is ${snapshot.safety.framErase.value ? "on" : "off"}; the emergency stop watch is ${snapshot.safety.estopWatchMs.value ? `every ${snapshot.safety.estopWatchMs.value} ms` : "off"}.`);
    }
    if (patch.jobDispatcher !== undefined) {
      const jd = snapshot.jobDispatcher;
      log(`[SECURITY] ${actor} set the job dispatcher options: delivery of its stop requests ${jd.stopRelay.enabled.value ? "ON" : "off"} (${Object.keys(jd.stopRelay.robotMap).length} robot(s) mapped; it applies on the next start), replanning without a confirmed stop ${jd.replan.allowUnconfirmed.value ? "ALLOWED" : "not allowed"}, wait for the confirmation ${jd.replan.stopAckTimeoutSeconds.value} s (the dispatcher reads this on its next start).`);
    }
    if (patch.mavlink !== undefined) {
      log(`[SECURITY] ${actor} set MAVLink signing ${snapshot.mavlink.signing ? "on" : "OFF"}${snapshot.mavlink.signing && snapshot.mavlink.signingAllowUnsigned.value ? " (unsigned messages still accepted)" : ""}; the bridge applies it on its next start.`);
    }
    if (patch.tls !== undefined) log(`[SECURITY] ${actor} set TLS to ${snapshot.tls.enabled ? "enabled" : "disabled"}; it applies on the next start.`);
    return { snapshot, warnings, appliesOnRestart };
  }
}

/** The address of the broker without a user name or password typed into it. */
function redactMqttUrl(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.username = "";
    parsed.password = "";
    return parsed.toString();
  } catch {
    return "";
  }
}
