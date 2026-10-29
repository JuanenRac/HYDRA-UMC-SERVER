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
import crypto from "node:crypto";
import fs from "node:fs";
import tls from "node:tls";
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
}

/** What the MAVLink bridge to the vehicle reads from this same file when it starts (HYDRA-UMC-BRIDGE-UAV). */
export interface MavlinkFile {
  /** The file holding the 32-byte MAVLink 2 signing key (never the key itself); empty or absent: no signing. */
  signingKeyFile?: string;
  /** With a key, still accept messages that are not signed (default: no). */
  signingAllowUnsigned?: boolean;
}

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

export interface SecuritySnapshot {
  aiAccess: { value: AiAccess; source: Source };
  infoAuth: { value: boolean; source: Source };
  tls: { enabled: boolean; source: Source; certPath: string | null; keyPath: string | null; fingerprint256: string | null; active: boolean; appliesOnRestart: boolean };
  ble: { mode: { value: BleMode; source: Source }; requireEncryption: { value: boolean; source: Source }; activeMode: BleMode; appliesOnRestart: boolean };
  mqtt: { mode: { value: MqttMode; source: Source }; url: string; prefix: string; username: string | null; commandUser: string | null; activeMode: MqttMode; appliesOnRestart: boolean };
  voice: { includeHeardText: { value: boolean; source: Source }; minConfidence: { value: number; source: Source } };
  /** The signing key itself is never part of this; only where its file is. */
  mavlink: { signingKeyFile: { value: string; source: Source }; signingAllowUnsigned: { value: boolean; source: Source }; signing: boolean; appliesOnRestart: boolean };
}

export interface SecurityConfigOptions {
  env: SecurityEnv;
  load: () => SecurityFile;
  /** Writes the whole saved file (this class passes the stored object with its own fields merged in). */
  save: (file: SecurityFile) => void;
  /** Whether the listener that is running right now uses TLS. */
  tlsActive: boolean;
  /** The mode the Bluetooth service started with (it changes only on a restart). */
  bleActiveMode?: BleMode;
  /** The mode the MQTT bridge started with (it changes only on a restart). */
  mqttActiveMode?: MqttMode;
  log?: (message: string) => void;
}

export class SecurityConfig {
  private file: SecurityFile;
  /** A MAVLink signing option was saved since this server started: the bridge picks it up on its next start. */
  private mavlinkTouched = false;

  constructor(private options: SecurityConfigOptions) {
    this.file = options.load();
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
      voice: {
        includeHeardText: resolveVoiceHeardText(this.options.env.voiceHeardText, this.file),
        minConfidence: resolveVoiceMinConfidence(this.options.env.voiceMinConfidence, this.file),
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
        };
      })(),
    };
  }

  /** Applies a change asked for by an administrator; returns the new state and the warnings to show. */
  update(patch: any, actor: string): { snapshot: SecuritySnapshot; warnings: string[]; appliesOnRestart: boolean } {
    const warnings: string[] = [];
    const next: SecurityFile = { ...this.file, tls: this.file.tls ? { ...this.file.tls } : undefined, ble: this.file.ble ? { ...this.file.ble } : undefined, mqtt: this.file.mqtt ? { ...this.file.mqtt } : undefined, voice: this.file.voice ? { ...this.file.voice } : undefined, mavlink: this.file.mavlink ? { ...this.file.mavlink } : undefined };
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
      next.voice = merged;
      if (voicePatch.includeHeardText === true) warnings.push("voice_heard_text_on");
      if (voicePatch.minConfidence === 0) warnings.push("voice_confidence_off");
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

    this.options.save(next);
    this.file = next;
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
      log(`[SECURITY] ${actor} set the voice options: transcript in replies ${snapshot.voice.includeHeardText.value ? "ON" : "off"}, minimum confidence ${snapshot.voice.minConfidence.value}.`);
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
