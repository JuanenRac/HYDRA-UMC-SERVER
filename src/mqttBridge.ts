// =============================================================================
// HYDRA-UMC-SERVER - src/mqttBridge.ts
// Copyright (C) 2026 JuanenRac (Electro Hobby 3D) <electrohobby3d@gmail.com>
// GPL-3.0-or-later - see LICENSE
// =============================================================================
// The bridge between this server and the MQTT broker of the cell (HYDRA-UMC-MQTT-BROKER): the state of every
// robot goes out on retained topics, and, only when an administrator turns it on, a command published on a
// robot's topic is carried out. It is off by default.
//
// Topics (the prefix is "hydra/swarm" unless changed):
//   <prefix>/status                       retained "online" / "offline" (the "offline" is the last will of the connection)
//   <prefix>/robot_<id>/state             retained JSON: a summary of the robot (never its recorded points, only how many)
//   <prefix>/robot_<id>/joints            retained JSON: j1..j6
//   <prefix>/robot_<id>/tool              retained JSON string: the tool in use
//   <prefix>/robot_<id>/cmd/<command>     in (mode "commands"): the JSON parameters of the command (empty payload = {})
//   <prefix>/robot_<id>/cmd/<command>/result   out: {"success","status","code","error"} once the route has answered
//
// A command that arrives here gets no privilege of its own. It is presented to POST /api/robot/:id/command on this
// same server, over the loopback address, with the access token of a dedicated account (HYDRA_UMC_MQTT_COMMAND_USER
// and its password), so the role of that account, the reservations of the robots, the If-Match rule and the limits of
// the jog all apply exactly as they do to a client of the network; an account with the read-only role makes the
// bridge state-only whatever the mode says. Only the control commands are accepted: the edits of a robot's data
// (points, model, role...) stay on the network API.
import fs from "node:fs";
import { connect as mqttConnect } from "mqtt";
import type { BleCommandRequest, BleExecuteResult } from "./ble/bleGateway";

export type MqttMode = "off" | "state" | "commands";
export const MQTT_MODES: readonly MqttMode[] = ["off", "state", "commands"];
export type Source = "env" | "config" | "default";

/** What data/server-config.json may hold for the bridge (no secret: the passwords come from the environment or a file named there). */
export interface MqttFile {
  mode?: MqttMode;
  url?: string;
  prefix?: string;
  username?: string;
  commandUser?: string;
  minStateIntervalMs?: number;
  commandsPerSecond?: number;
}

export interface MqttEnv {
  mode?: string;
  url?: string;
  prefix?: string;
  username?: string;
  password?: string;
  passwordFile?: string;
  commandUser?: string;
  commandPassword?: string;
  commandPasswordFile?: string;
}

export function mqttEnvFrom(env: NodeJS.ProcessEnv): MqttEnv {
  return {
    mode: env.HYDRA_UMC_MQTT_BRIDGE,
    url: env.HYDRA_UMC_MQTT_URL,
    prefix: env.HYDRA_UMC_MQTT_PREFIX,
    username: env.HYDRA_UMC_MQTT_USERNAME,
    password: env.HYDRA_UMC_MQTT_PASSWORD,
    passwordFile: env.HYDRA_UMC_MQTT_PASSWORD_FILE,
    commandUser: env.HYDRA_UMC_MQTT_COMMAND_USER,
    commandPassword: env.HYDRA_UMC_MQTT_COMMAND_PASSWORD,
    commandPasswordFile: env.HYDRA_UMC_MQTT_COMMAND_PASSWORD_FILE,
  };
}

const isSet = (value: string | undefined): value is string => (value ?? "").trim() !== "";

export const DEFAULT_MQTT_URL = "mqtt://127.0.0.1:1883";
export const DEFAULT_MQTT_PREFIX = "hydra/swarm";

export function resolveMqttMode(env: string | undefined, file: { mqtt?: MqttFile }): { value: MqttMode; source: Source } {
  if (isSet(env)) {
    const wanted = env.trim().toLowerCase();
    // An unknown word is the safe answer: no bridge.
    return { value: (MQTT_MODES as readonly string[]).includes(wanted) ? (wanted as MqttMode) : "off", source: "env" };
  }
  if (file.mqtt?.mode && MQTT_MODES.includes(file.mqtt.mode)) return { value: file.mqtt.mode, source: "config" };
  return { value: "off", source: "default" };
}

/** A broker address the bridge may connect to: mqtt, mqtts, ws or wss with a host; null for anything else. */
export function validMqttUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (text.length === 0 || text.length > 300) return null;
  try {
    const url = new URL(text);
    if (!["mqtt:", "mqtts:", "ws:", "wss:"].includes(url.protocol) || !url.hostname) return null;
    return text;
  } catch {
    return null;
  }
}

/** A topic prefix: levels of letters, digits and . _ - joined by "/", no wildcards, no leading or trailing slash. */
export function validMqttPrefix(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const text = value.trim().replace(/^\/+|\/+$/g, "");
  if (text.length === 0 || text.length > 120) return null;
  if (!/^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/.test(text)) return null;
  return text.split("/").some((level) => /^\.+$/.test(level)) ? null : text;
}

export function resolveMqttSettings(env: MqttEnv, file: { mqtt?: MqttFile }) {
  const resolved = resolveMqttMode(env.mode, file);
  const url = validMqttUrl(env.url) ?? validMqttUrl(file.mqtt?.url) ?? DEFAULT_MQTT_URL;
  const prefix = validMqttPrefix(env.prefix) ?? validMqttPrefix(file.mqtt?.prefix) ?? DEFAULT_MQTT_PREFIX;
  return {
    mode: resolved.value,
    modeSource: resolved.source,
    url,
    prefix,
    username: isSet(env.username) ? env.username.trim() : file.mqtt?.username?.trim() || undefined,
    commandUser: isSet(env.commandUser) ? env.commandUser.trim() : file.mqtt?.commandUser?.trim() || undefined,
    minStateIntervalMs: clamp(file.mqtt?.minStateIntervalMs, 250, 50, 60000),
    commandsPerSecond: clamp(file.mqtt?.commandsPerSecond, 10, 1, 100),
  };
}

export type MqttSettings = ReturnType<typeof resolveMqttSettings>;

function clamp(value: unknown, fallback: number, min: number, max: number): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback;
}

/** A secret from its variable, or from the file the other variable names (the file wins: it keeps the value out of the process environment). */
export function readSecret(direct: string | undefined, filePath: string | undefined): string | undefined {
  if (isSet(filePath)) {
    try {
      return fs.readFileSync(filePath.trim(), "utf8").replace(/\r?\n$/, "");
    } catch {
      return undefined;
    }
  }
  return isSet(direct) ? direct : undefined;
}

// ---- topics and payloads ---------------------------------------------------------------------------------------

export const robotTopic = (prefix: string, robotId: number): string => `${prefix}/robot_${robotId}`;
/** The topic of the retained safety state of the installation (global stop). */
export const safetyTopic = (prefix: string): string => `${prefix}/safety/estop`;

/** The commands a message on the broker may carry out: the control commands of the route, never the edits of a robot's data. */
export function mqttCommandAllowed(command: string, allowed: ReadonlySet<string>): boolean {
  return allowed.has(command);
}

export interface ParsedCommandTopic {
  robotId: number;
  command: string;
}

/** `<prefix>/robot_<id>/cmd/<command>` -> its parts; null for anything else (a result topic, a state topic, another prefix). */
export function parseCommandTopic(prefix: string, topic: string): ParsedCommandTopic | null {
  if (!topic.startsWith(`${prefix}/`)) return null;
  const parts = topic.slice(prefix.length + 1).split("/");
  if (parts.length !== 3 || parts[1] !== "cmd") return null;
  const match = /^robot_(\d{1,9})$/.exec(parts[0]);
  if (!match || !/^[A-Za-z][A-Za-z0-9]{0,31}$/.test(parts[2])) return null;
  return { robotId: Number(match[1]), command: parts[2] };
}

const isObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);

/** A robot reduced to what a subscriber needs: no recorded points (only their number), no camera credentials, a reservation without history. */
export function summarizeRobot(controllerId: string, robot: any): Record<string, unknown> {
  const reservation = isObject(robot?.reservation) ? robot.reservation : null;
  return {
    id: robot?.id,
    controllerId,
    name: robot?.name,
    online: robot?.online,
    model: robot?.model,
    role: robot?.role,
    tool: robot?.tool,
    pos: robot?.pos,
    joints: robot?.joints,
    valves: robot?.valves,
    pumps: robot?.pumps,
    endstops: robot?.endstops,
    playbackState: robot?.playbackState,
    visionEnabled: robot?.visionEnabled,
    combinedWith: robot?.combinedWith,
    hasXYTable: robot?.hasXYTable,
    xyTablePos: robot?.xyTable?.pos,
    selectedWorkFile: robot?.selectedWorkFile,
    pointsCount: Array.isArray(robot?.recordedPoints) ? robot.recordedPoints.length : 0,
    reservation: reservation ? { ownerUsername: reservation.ownerUsername, expiresAt: reservation.expiresAt } : null,
  };
}

// ---- the client ------------------------------------------------------------------------------------------------

/** The part of an MQTT client the bridge uses (the mqtt package's client, or a stand-in in the checks). */
export interface MqttClientLike {
  publish(topic: string, payload: string, options: { qos: 0 | 1; retain: boolean }, callback?: (error?: Error | null) => void): unknown;
  subscribe(topic: string, options: { qos: 0 | 1 }, callback?: (error: Error | null) => void): unknown;
  on(event: string, listener: (...args: any[]) => void): unknown;
  end(force?: boolean, callback?: () => void): unknown;
}

export interface MqttConnectOptions {
  clientId: string;
  username?: string;
  password?: string;
  will: { topic: string; payload: string; qos: 0 | 1; retain: boolean };
  reconnectPeriod: number;
}

export type MqttConnect = (url: string, options: MqttConnectOptions) => MqttClientLike;

export const defaultMqttConnect: MqttConnect = (url, options) => mqttConnect(url, options as any) as unknown as MqttClientLike;

export interface CommandAccount {
  /** A valid access token of the account that carries the commands out, or null when it cannot sign in. */
  token(): Promise<string | null>;
  /** Forget the token (the route answered 401: the session ended). */
  invalidate(): void;
}

export interface MqttBridgeOptions {
  settings: MqttSettings;
  getSettings: () => any;
  /** Control commands a message may carry (the route's ROBOT_COMMANDS). */
  allowedCommands: ReadonlySet<string>;
  password?: string;
  /** Present when the mode is "commands": the account whose token the commands travel with. */
  account?: CommandAccount;
  execute?: (request: BleCommandRequest) => Promise<BleExecuteResult>;
  connect?: MqttConnect;
  log: (message: string) => void;
  now?: () => number;
}

export class MqttBridge {
  private client: MqttClientLike | null = null;
  private lastPublished = new Map<string, string>();
  private dirty = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private lastFlush = 0;
  private connected = false;
  private stopped = false;
  private windowStart = 0;
  private windowCount = 0;
  private readonly now: () => number;
  /** For the checks: how many commands were carried out, refused for the rate and refused as unknown. */
  readonly counters = { executed: 0, rateLimited: 0, refused: 0 };

  constructor(private readonly options: MqttBridgeOptions) {
    this.now = options.now ?? Date.now;
  }

  get prefix(): string {
    return this.options.settings.prefix;
  }

  isConnected(): boolean {
    return this.connected;
  }

  start(): void {
    const { settings } = this.options;
    const connect = this.options.connect ?? defaultMqttConnect;
    const commands = settings.mode === "commands";
    const client = connect(settings.url, {
      clientId: `hydra-umc-server-${Math.random().toString(16).slice(2, 10)}`,
      username: settings.username,
      password: this.options.password,
      will: { topic: `${settings.prefix}/status`, payload: "offline", qos: 1, retain: true },
      reconnectPeriod: 5000,
    });
    this.client = client;
    client.on("connect", () => {
      this.connected = true;
      this.options.log(`[MQTT] connected to ${redactUrl(settings.url)}: ${commands ? "state and commands" : "state only"}, prefix ${settings.prefix}`);
      client.publish(`${settings.prefix}/status`, "online", { qos: 1, retain: true });
      // After a reconnect the broker may have lost the retained copies: publish everything again.
      this.lastPublished.clear();
      this.publishNow();
      if (commands) {
        client.subscribe(`${settings.prefix}/+/cmd/+`, { qos: 1 }, (error) => {
          if (error) this.options.log(`[MQTT] could not subscribe to the commands: ${error.message}`);
        });
      }
    });
    client.on("close", () => {
      if (this.connected) this.options.log("[MQTT] the connection to the broker was lost; it retries by itself");
      this.connected = false;
    });
    client.on("error", (error: Error) => this.options.log(`[MQTT] ${error.message}`));
    if (commands) client.on("message", (topic: string, payload: Buffer) => void this.onMessage(topic, payload));
  }

  /** The state changed: publish what differs, at most once per interval. */
  publishState(): void {
    if (!this.connected || this.stopped) return;
    this.dirty = true;
    if (this.timer) return;
    const wait = Math.max(0, this.options.settings.minStateIntervalMs - (this.now() - this.lastFlush));
    this.timer = setTimeout(() => {
      this.timer = null;
      this.publishNow();
    }, wait);
    this.timer.unref?.();
  }

  /** Publishes now every robot whose summary differs from the last one that went out. */
  publishNow(): void {
    if (!this.client || !this.connected || this.stopped) return;
    this.dirty = false;
    this.lastFlush = this.now();
    const tree = this.options.getSettings();
    const seen = new Set<string>();
    for (const controller of Array.isArray(tree?.controllers) ? tree.controllers : []) {
      for (const robot of Array.isArray(controller?.robots) ? controller.robots : []) {
        if (typeof robot?.id !== "number") continue;
        const base = robotTopic(this.prefix, robot.id);
        seen.add(base);
        this.publishIfChanged(`${base}/state`, JSON.stringify(summarizeRobot(String(controller?.id ?? ""), robot)));
        this.publishIfChanged(`${base}/joints`, JSON.stringify(robot.joints ?? null));
        this.publishIfChanged(`${base}/tool`, JSON.stringify(robot.tool ?? null));
      }
    }
  }

  /**
   * Announces the safety state of the whole installation on `<prefix>/safety/estop`: a retained message, QoS 1, in the closed
   * shape of the SafetyState contract of the SDK (`SAFE_STOP` after a global stop, `READY` once an administrator released it).
   * Returns false when the broker is not connected, so the caller can say the announcement did not go out.
   */
  publishSafety(state: "SAFE_STOP" | "READY", reason: string): boolean {
    if (!this.client || !this.connected || this.stopped) return false;
    const payload = JSON.stringify({
      schema_version: "1.0",
      state,
      source: "hydra-umc-server",
      timestamp_utc: new Date(this.now()).toISOString(),
      reason: reason.slice(0, 120),
    });
    this.client.publish(safetyTopic(this.prefix), payload, { qos: 1, retain: true });
    return true;
  }

  private publishIfChanged(topic: string, payload: string): void {
    if (this.lastPublished.get(topic) === payload) return;
    this.lastPublished.set(topic, payload);
    this.client?.publish(topic, payload, { qos: 0, retain: true });
  }

  private resultTopic(parsed: ParsedCommandTopic): string {
    return `${robotTopic(this.prefix, parsed.robotId)}/cmd/${parsed.command}/result`;
  }

  private reply(parsed: ParsedCommandTopic, body: Record<string, unknown>): void {
    this.client?.publish(this.resultTopic(parsed), JSON.stringify(body), { qos: 1, retain: false });
  }

  /** One message on a command topic. Never throws: a bad message is answered, not allowed to stop the bridge. */
  async onMessage(topic: string, payload: Buffer): Promise<void> {
    const parsed = parseCommandTopic(this.prefix, topic);
    if (!parsed) return;
    if (!mqttCommandAllowed(parsed.command, this.options.allowedCommands)) {
      this.counters.refused++;
      this.reply(parsed, { success: false, status: 400, code: "unknown-command", error: "this command cannot be sent over MQTT" });
      return;
    }
    if (payload.length > 8192) {
      this.counters.refused++;
      this.reply(parsed, { success: false, status: 400, code: "payload-too-large", error: "the parameters are too large" });
      return;
    }
    let params: Record<string, unknown> = {};
    if (payload.length > 0) {
      try {
        const parsedPayload = JSON.parse(payload.toString("utf8"));
        if (!isObject(parsedPayload)) throw new Error("not an object");
        params = parsedPayload;
      } catch {
        this.counters.refused++;
        this.reply(parsed, { success: false, status: 400, code: "invalid-payload", error: "the payload must be a JSON object or empty" });
        return;
      }
    }
    // A stop is never held back by the pace limit.
    if (parsed.command !== "stop" && !this.withinPace()) {
      this.counters.rateLimited++;
      this.reply(parsed, { success: false, status: 429, code: "rate-limited", error: "too many commands per second" });
      return;
    }
    const { account, execute } = this.options;
    if (!account || !execute) {
      this.reply(parsed, { success: false, status: 503, code: "unavailable", error: "the bridge has no account to carry commands out" });
      return;
    }
    // The reservation rule sees this client as "mqtt", whatever the message says.
    const { controllerId: _ignored, ...rest } = params;
    let token = await account.token();
    if (!token) {
      this.reply(parsed, { success: false, status: 401, code: "session-expired", error: "the account of the bridge cannot sign in" });
      return;
    }
    let result = await execute({ id: `${parsed.robotId}:${parsed.command}`, robotId: parsed.robotId, command: parsed.command, params: rest, controllerId: "mqtt", token });
    if (result.status === 401) {
      account.invalidate();
      token = await account.token();
      if (token) result = await execute({ id: `${parsed.robotId}:${parsed.command}`, robotId: parsed.robotId, command: parsed.command, params: rest, controllerId: "mqtt", token });
    }
    this.counters.executed++;
    const ok = result.status >= 200 && result.status < 300;
    this.reply(parsed, {
      success: ok,
      status: result.status,
      code: ok ? "ok" : typeof result.body?.code === "string" ? result.body.code : result.status === 0 ? "unreachable" : "rejected",
      ...(ok ? { revision: result.body?.revision } : { error: typeof result.body?.error === "string" ? result.body.error.slice(0, 300) : undefined }),
    });
  }

  private withinPace(): boolean {
    const now = this.now();
    if (now - this.windowStart >= 1000) {
      this.windowStart = now;
      this.windowCount = 0;
    }
    this.windowCount++;
    return this.windowCount <= this.options.settings.commandsPerSecond;
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    const client = this.client;
    this.client = null;
    if (!client) return;
    await new Promise<void>((resolve) => {
      try {
        // A clean goodbye: say "offline" ourselves because a clean disconnect does not send the last will.
        client.publish(`${this.prefix}/status`, "offline", { qos: 1, retain: true }, () => client.end(false, () => resolve()));
        setTimeout(resolve, 1500).unref?.();
      } catch {
        resolve();
      }
    });
  }
}

/** The address without the credentials a user may have typed into it. */
export function redactUrl(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.username = "";
    parsed.password = "";
    return parsed.toString();
  } catch {
    return "(invalid address)";
  }
}

/** The account the commands travel with: signs in on this server over the loopback address, keeps the token until the route says it ended. */
export function loopbackAccount(
  username: string,
  password: string,
  login: (username: string, password: string) => Promise<{ status: number; body: any }>,
): CommandAccount {
  let cached: string | null = null;
  return {
    async token() {
      if (cached) return cached;
      const answer = await login(username, password);
      cached = answer.status === 200 && typeof answer.body?.token === "string" ? answer.body.token : null;
      return cached;
    },
    invalidate() {
      cached = null;
    },
  };
}
