// =============================================================================
// HYDRA-UMC-SERVER - src/bridgeGateway.ts
// Copyright (C) 2026 JuanenRac (Electro Hobby 3D) <electrohobby3d@gmail.com>
// GPL-3.0-or-later - see LICENSE
// =============================================================================
// The gateway from this server to the machine bridges (CNC, laser, OpenPnP, 3D printer, ...). A client of the network API reads the last state of a
// bridge and sends it a command without knowing MQTT: the server listens to the retained topics of the bridges
// (`<prefix>/<name>/state`, `availability`, `health`) and publishes on `<prefix>/<name>/cmd/<verb>`, then waits for `.../cmd/<verb>/result`.
//
// It is off by default (the switch bridgeGateway.enabled, HYDRA_UMC_BRIDGE_GATEWAY=1). With it on:
//  - only a bridge that has announced itself on the broker can be addressed (a name that was never seen is "not found"),
//  - only a verb of the list in the configuration file may be sent (a stop, a pause... by default; never `job`, which is signed and has its own path),
//  - a command carries at most a small JSON object, one command per bridge and verb waits for its answer at a time, and the pace is limited.
// The routes (src/routes/bridgeRoutes.ts) decide who may ask and write the audit entry; nothing here knows about users.
import { defaultMqttConnect, redactUrl, type MqttClientLike, type MqttConnect } from "./mqttBridge";
import { SETTINGS_REFRESH_MS } from "./bridgeSettingsSigning";

export const DEFAULT_BRIDGE_PREFIX = "hydra/bridges";
export const DEFAULT_ALLOWED_VERBS: readonly string[] = ["status", "stop", "pause", "resume"];
export const MAX_COMMAND_BYTES = 8192;

export interface BridgeGatewayFile {
  /** Whether the gateway answers at all (default: no; the routes then look as if they did not exist). */
  enabled?: boolean;
  /** Topic prefix of the bridges (default hydra/bridges). Read from the file only. */
  prefix?: string;
  /** The verbs a client may send (default status, stop, pause, resume). Read from the file only. */
  allowedVerbs?: string[];
  /** How long to wait for the answer of the bridge, in milliseconds (100 to 30000; 5000 by default). Read from the file only. */
  commandTimeoutMs?: number;
  /** How many commands per second the gateway forwards (1 to 50; 5 by default). A stop is never held back. Read from the file only. */
  commandsPerSecond?: number;
}

export interface BridgeGatewaySettings {
  prefix: string;
  allowedVerbs: ReadonlySet<string>;
  commandTimeoutMs: number;
  commandsPerSecond: number;
}

const NAME = /^[a-z][a-z0-9_-]{0,31}$/;
const VERB = /^[a-z][a-z0-9_]{0,31}$/;
export const validBridgeName = (value: unknown): value is string => typeof value === "string" && NAME.test(value);
export const validBridgeVerb = (value: unknown): value is string => typeof value === "string" && VERB.test(value) && value !== "job";

const clamp = (value: unknown, fallback: number, min: number, max: number): number =>
  typeof value === "number" && Number.isFinite(value) ? Math.min(max, Math.max(min, Math.round(value))) : fallback;

/** The settings of the file with every invalid value replaced by the conservative one. */
export function resolveGatewaySettings(file: BridgeGatewayFile | undefined): BridgeGatewaySettings {
  const verbs = Array.isArray(file?.allowedVerbs) ? file!.allowedVerbs.filter(validBridgeVerb) : [...DEFAULT_ALLOWED_VERBS];
  const prefix = typeof file?.prefix === "string" && /^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/.test(file.prefix.replace(/^\/+|\/+$/g, "")) ? file.prefix.replace(/^\/+|\/+$/g, "") : DEFAULT_BRIDGE_PREFIX;
  return {
    prefix,
    allowedVerbs: new Set(verbs),
    commandTimeoutMs: clamp(file?.commandTimeoutMs, 5000, 100, 30000),
    commandsPerSecond: clamp(file?.commandsPerSecond, 5, 1, 50),
  };
}

export interface BridgeView {
  name: string;
  available: boolean | null;
  state: unknown;
  health: unknown;
  updatedAt: string | null;
}

export interface GatewayCommandResult {
  status: number;
  body: Record<string, unknown>;
}

interface Seen {
  availability: boolean | null;
  state: unknown;
  health: unknown;
  updatedAt: number;
}

export interface BridgeGatewayOptions {
  getSettings: () => BridgeGatewaySettings;
  url: string;
  username?: string;
  password?: string;
  connect?: MqttConnect;
  log: (message: string) => void;
  now?: () => number;
  /** The signed switches of the bridges as retained messages, made each time they are announced (src/bridgeSettings.ts); the argument is the topic prefix. */
  getBridgeSettings?: (prefix: string) => Array<{ name: string; payload: string }>;
  /** How often the signed messages are made and published again (default 60000 ms): a message expires, a bridge that restarts must find a current one. 0 turns the repeat off. */
  settingsRefreshMs?: number;
}

export class BridgeGateway {
  private client: MqttClientLike | null = null;
  private connected = false;
  private refreshTimer: ReturnType<typeof setInterval> | null = null;
  private readonly seen = new Map<string, Seen>();
  private readonly pending = new Map<string, (answer: unknown) => void>();
  private windowStart = 0;
  private windowCount = 0;
  private readonly now: () => number;

  constructor(private readonly options: BridgeGatewayOptions) {
    this.now = options.now ?? Date.now;
  }

  isConnected(): boolean {
    return this.connected;
  }

  /** Connects the first time it is needed; the connection then stays. Never throws. */
  ensureStarted(): void {
    if (this.client) return;
    const prefix = this.options.getSettings().prefix;
    try {
      const client = (this.options.connect ?? defaultMqttConnect)(this.options.url, {
        clientId: `hydra-umc-gateway-${Math.random().toString(16).slice(2, 10)}`,
        username: this.options.username,
        password: this.options.password,
        will: { topic: `${prefix}/_gateway/status`, payload: "offline", qos: 0, retain: false },
        reconnectPeriod: 5000,
      });
      this.client = client;
      client.on("connect", () => {
        this.connected = true;
        this.options.log(`[GATEWAY] connected to ${redactUrl(this.options.url)}, bridges under ${prefix}`);
        this.announceSettings();
        this.startRefresh();
        for (const topic of [`${prefix}/+/state`, `${prefix}/+/availability`, `${prefix}/+/health`, `${prefix}/+/cmd/+/result`]) {
          client.subscribe(topic, { qos: 1 }, (error) => {
            if (error) this.options.log(`[GATEWAY] could not subscribe to ${topic}: ${error.message}`);
          });
        }
      });
      client.on("close", () => {
        this.connected = false;
        this.stopRefresh();
      });
      client.on("error", (error: Error) => this.options.log(`[GATEWAY] ${error.message}`));
      client.on("message", (topic: string, payload: Buffer, packet?: { retain?: boolean }) => this.onMessage(topic, payload, packet));
    } catch (error) {
      this.client = null;
      this.options.log(`[GATEWAY] could not start: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /** Publishes the switches of every bridge on `<prefix>/<bridge>/settings`, retained, so a bridge that starts later still reads them. Never throws; does nothing while not connected (it runs again on connect). */
  announceSettings(): void {
    const client = this.client;
    if (!client || !this.connected || !this.options.getBridgeSettings) return;
    const prefix = this.options.getSettings().prefix;
    try {
      for (const message of this.options.getBridgeSettings(prefix)) client.publish(`${prefix}/${message.name}/settings`, message.payload, { qos: 1, retain: true }, (error) => {
        if (error) this.options.log(`[GATEWAY] could not publish the settings of ${message.name}: ${error.message}`);
      });
    } catch (error) {
      this.options.log(`[GATEWAY] could not publish the settings: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private startRefresh(): void {
    this.stopRefresh();
    const every = this.options.settingsRefreshMs ?? SETTINGS_REFRESH_MS;
    if (!this.options.getBridgeSettings || every <= 0) return;
    this.refreshTimer = setInterval(() => this.announceSettings(), every);
    this.refreshTimer.unref?.();
  }

  private stopRefresh(): void {
    if (this.refreshTimer) clearInterval(this.refreshTimer);
    this.refreshTimer = null;
  }

  /** One message from the broker. Never throws. */
  onMessage(topic: string, payload: Buffer, _packet?: { retain?: boolean }): void {
    const prefix = this.options.getSettings().prefix;
    if (!topic.startsWith(`${prefix}/`)) return;
    const parts = topic.slice(prefix.length + 1).split("/");
    const name = parts[0];
    if (!validBridgeName(name)) return;
    let text = payload.toString("utf8");
    if (text.length > 65536) return;
    let value: unknown = text;
    try {
      value = JSON.parse(text);
    } catch {
      value = text;
    }
    if (parts.length === 4 && parts[1] === "cmd" && parts[3] === "result") {
      const key = `${name}/${parts[2]}`;
      const resolve = this.pending.get(key);
      if (resolve) {
        this.pending.delete(key);
        resolve(value);
      }
      return;
    }
    if (parts.length !== 2) return;
    const entry = this.seen.get(name) ?? { availability: null, state: null, health: null, updatedAt: 0 };
    if (parts[1] === "availability") entry.availability = text.trim() === "online";
    else if (parts[1] === "state") entry.state = value;
    else if (parts[1] === "health") entry.health = value;
    else return;
    entry.updatedAt = this.now();
    this.seen.set(name, entry);
  }

  private view(name: string, entry: Seen): BridgeView {
    // A bridge that publishes its health instead of `availability` is available while that report is not a FAULT.
    const health = entry.health as { state?: unknown } | null;
    const available = entry.availability ?? (health && typeof health === "object" && typeof health.state === "string" ? health.state !== "FAULT" : null);
    return { name, available, state: entry.state, health: entry.health, updatedAt: entry.updatedAt ? new Date(entry.updatedAt).toISOString() : null };
  }

  list(): BridgeView[] {
    return [...this.seen.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([name, entry]) => this.view(name, entry));
  }

  get(name: string): BridgeView | null {
    const entry = this.seen.get(name);
    return entry ? this.view(name, entry) : null;
  }

  private withinPace(): boolean {
    const now = this.now();
    if (now - this.windowStart >= 1000) {
      this.windowStart = now;
      this.windowCount = 0;
    }
    this.windowCount++;
    return this.windowCount <= this.options.getSettings().commandsPerSecond;
  }

  /** Sends one command and waits for its answer. Answers 200 with `result: null` when the bridge said nothing in time; never throws. */
  async command(name: string, verb: string, params: unknown): Promise<GatewayCommandResult> {
    const settings = this.options.getSettings();
    if (!validBridgeName(name)) return { status: 400, body: { error: "The name of the bridge is not valid.", code: "invalid-bridge" } };
    if (!validBridgeVerb(verb) || !settings.allowedVerbs.has(verb)) return { status: 403, body: { error: "This command cannot be sent through the gateway.", code: "verb-not-allowed" } };
    if (!this.seen.has(name)) return { status: 404, body: { error: "Bridge not found.", code: "unknown-bridge" } };
    if (params !== undefined && (typeof params !== "object" || params === null || Array.isArray(params))) {
      return { status: 400, body: { error: "The parameters must be a JSON object.", code: "invalid-payload" } };
    }
    const payload = JSON.stringify(params ?? {});
    if (Buffer.byteLength(payload) > MAX_COMMAND_BYTES) return { status: 413, body: { error: "The parameters are too large.", code: "payload-too-large" } };
    this.ensureStarted();
    const client = this.client;
    if (!client || !this.connected) return { status: 503, body: { error: "The broker is not connected.", code: "broker-unavailable" } };
    // A stop is never held back by the pace limit.
    if (verb !== "stop" && !this.withinPace()) return { status: 429, body: { error: "Too many commands per second.", code: "rate-limited" } };
    const key = `${name}/${verb}`;
    if (this.pending.has(key)) return { status: 409, body: { error: "This command is still waiting for its answer.", code: "busy" } };
    const answer = new Promise<{ timedOut: boolean; value?: unknown }>((resolve) => {
      const timer = setTimeout(() => {
        if (this.pending.get(key) === resolver) this.pending.delete(key);
        resolve({ timedOut: true });
      }, settings.commandTimeoutMs);
      const resolver = (value: unknown) => {
        clearTimeout(timer);
        resolve({ timedOut: false, value });
      };
      this.pending.set(key, resolver);
    });
    const published = await new Promise<boolean>((resolve) => {
      try {
        client.publish(`${settings.prefix}/${name}/cmd/${verb}`, payload, { qos: 1, retain: false }, (error) => resolve(!error));
      } catch {
        resolve(false);
      }
    });
    if (!published) {
      this.pending.delete(key);
      return { status: 502, body: { error: "The command could not be published.", code: "publish-failed" } };
    }
    const result = await answer;
    if (result.timedOut) return { status: 200, body: { accepted: true, result: null } };
    return { status: 200, body: { accepted: true, result: result.value ?? null } };
  }

  async stop(): Promise<void> {
    this.stopRefresh();
    const client = this.client;
    this.client = null;
    this.connected = false;
    if (!client) return;
    await new Promise<void>((resolve) => {
      try {
        client.end(false, () => resolve());
        setTimeout(resolve, 1000).unref?.();
      } catch {
        resolve();
      }
    });
  }
}
