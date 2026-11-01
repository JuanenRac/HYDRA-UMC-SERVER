// =============================================================================
// HYDRA-UMC-SERVER - src/pushNotifications.ts
// Copyright (C) 2026 JuanenRac (Electro Hobby 3D) <electrohobby3d@gmail.com>
// GPL-3.0-or-later - see LICENSE
// =============================================================================
// Push notifications to the iPhones that registered their device token: a job that finished and a global stop. OFF by default
// (push.enabled, a switch of Server Admin, or HYDRA_UMC_PUSH=1) and a no-op until the credentials of the Apple push service
// are present. The credentials - the .p8 key, its key id, the team id and the bundle id (the topic) - come ONLY from the
// environment of the deployment (HYDRA_UMC_APNS_KEY_FILE, HYDRA_UMC_APNS_KEY_ID, HYDRA_UMC_APNS_TEAM_ID, HYDRA_UMC_APNS_TOPIC);
// the key file must live outside the directory the server runs from, and nothing of it is ever logged, audited or returned
// by a route. A device token is not a secret of the account but identifies a phone, so it is never logged either.
import crypto from "node:crypto";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import http2 from "node:http2";
import path from "node:path";
import type { PushFile } from "./securityConfig";

export type PushEvent = "job-finished" | "global-stop";

/** What the rest of the server says to the push service: it never imports it, it only emits here. */
export const pushBus = new EventEmitter();
pushBus.setMaxListeners(4);
export function emitPush(event: PushEvent, detail: { robotName?: string } = {}): void {
  try {
    pushBus.emit("event", event, detail);
  } catch {
    // A push problem never reaches the code that raised the event.
  }
}

export const LOCALES = ["en", "es", "de", "fr", "it", "ja", "zh", "pt"] as const;
export type PushLocale = (typeof LOCALES)[number];

/** The sentences of each notification in the eight languages of the apps (pt is the Portuguese of Portugal). */
const TEXTS: Record<PushEvent, Record<PushLocale, { title: string; body: (robot?: string) => string }>> = {
  "job-finished": {
    en: { title: "HYDRA-UMC", body: (r) => (r ? `Robot ${r}: the job sequence finished.` : "A job sequence finished.") },
    es: { title: "HYDRA-UMC", body: (r) => (r ? `Robot ${r}: la secuencia de trabajo ha terminado.` : "Ha terminado una secuencia de trabajo.") },
    de: { title: "HYDRA-UMC", body: (r) => (r ? `Roboter ${r}: Die Arbeitssequenz ist beendet.` : "Eine Arbeitssequenz ist beendet.") },
    fr: { title: "HYDRA-UMC", body: (r) => (r ? `Robot ${r} : la séquence de travail est terminée.` : "Une séquence de travail est terminée.") },
    it: { title: "HYDRA-UMC", body: (r) => (r ? `Robot ${r}: la sequenza di lavoro è terminata.` : "Una sequenza di lavoro è terminata.") },
    ja: { title: "HYDRA-UMC", body: (r) => (r ? `ロボット ${r}：作業シーケンスが完了しました。` : "作業シーケンスが完了しました。") },
    zh: { title: "HYDRA-UMC", body: (r) => (r ? `机器人 ${r}：作业序列已完成。` : "一个作业序列已完成。") },
    pt: { title: "HYDRA-UMC", body: (r) => (r ? `Robô ${r}: a sequência de trabalho terminou.` : "Terminou uma sequência de trabalho.") },
  },
  "global-stop": {
    en: { title: "HYDRA-UMC", body: () => "A global stop was issued: every robot was stopped." },
    es: { title: "HYDRA-UMC", body: () => "Se ha dado una parada global: todos los robots se han detenido." },
    de: { title: "HYDRA-UMC", body: () => "Ein globaler Stopp wurde ausgelöst: Alle Roboter wurden angehalten." },
    fr: { title: "HYDRA-UMC", body: () => "Un arrêt global a été émis : tous les robots ont été arrêtés." },
    it: { title: "HYDRA-UMC", body: () => "È stato dato un arresto globale: tutti i robot sono stati fermati." },
    ja: { title: "HYDRA-UMC", body: () => "グローバル停止が実行されました。すべてのロボットが停止しました。" },
    zh: { title: "HYDRA-UMC", body: () => "已发出全局停止：所有机器人均已停止。" },
    pt: { title: "HYDRA-UMC", body: () => "Foi dada uma paragem global: todos os robôs foram parados." },
  },
};

export function pushText(event: PushEvent, locale: string, robot?: string): { title: string; body: string } {
  const l = (LOCALES as readonly string[]).includes(locale) ? (locale as PushLocale) : "en";
  const t = TEXTS[event][l];
  return { title: t.title, body: t.body(robot) };
}

// ---- The registry of device tokens -------------------------------------------------------------------------------------

export interface PushDevice {
  token: string;
  platform: "ios";
  username: string;
  locale: PushLocale;
  registeredAt: string;
}

export class PushRegistryError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

/** An APNs device token is a hexadecimal string (32 bytes today; the length is allowed to grow). */
export function validDeviceToken(token: unknown): token is string {
  return typeof token === "string" && /^[0-9a-fA-F]{32,200}$/.test(token);
}

export class PushDevices {
  private devices: PushDevice[] = [];

  constructor(private readonly options: { file: string; maxDevices: () => number }) {
    this.load();
  }

  private load(): void {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.options.file, "utf8"));
      if (Array.isArray(parsed?.devices)) {
        this.devices = parsed.devices.filter(
          (d: any) => validDeviceToken(d?.token) && typeof d?.username === "string" && d?.platform === "ios",
        ).map((d: any) => ({ token: d.token.toLowerCase(), platform: "ios" as const, username: d.username, locale: (LOCALES as readonly string[]).includes(d.locale) ? d.locale : "en", registeredAt: String(d.registeredAt ?? "") }));
      }
    } catch {
      this.devices = [];
    }
  }

  private save(): void {
    fs.mkdirSync(path.dirname(this.options.file), { recursive: true });
    const tmp = `${this.options.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ devices: this.devices }, null, 2) + "\n", { mode: 0o600 });
    fs.renameSync(tmp, this.options.file);
  }

  count(): number {
    return this.devices.length;
  }

  list(): readonly PushDevice[] {
    return this.devices;
  }

  /** Registers (or refreshes) a token for an account; a token seen again moves to the account that registered it last. */
  register(token: string, username: string, locale: string, now = new Date()): void {
    const lowered = token.toLowerCase();
    const known = this.devices.findIndex((d) => d.token === lowered);
    const entry: PushDevice = { token: lowered, platform: "ios", username, locale: (LOCALES as readonly string[]).includes(locale) ? (locale as PushLocale) : "en", registeredAt: now.toISOString() };
    if (known >= 0) {
      this.devices[known] = entry;
    } else {
      if (this.devices.length >= this.options.maxDevices()) throw new PushRegistryError(409, "too many devices are registered for push notifications");
      this.devices.push(entry);
    }
    this.save();
  }

  /** Removes a token; an account can remove only its own unless [anyAccount]. True when something was removed. */
  remove(token: string, username: string | null): boolean {
    const lowered = token.toLowerCase();
    const before = this.devices.length;
    this.devices = this.devices.filter((d) => !(d.token === lowered && (username === null || d.username === username)));
    const removed = this.devices.length !== before;
    if (removed) this.save();
    return removed;
  }

  /** Forgets the tokens of an account (it signed out everywhere or was deleted). */
  removeAccount(username: string): number {
    const before = this.devices.length;
    this.devices = this.devices.filter((d) => d.username !== username);
    if (this.devices.length !== before) this.save();
    return before - this.devices.length;
  }
}

// ---- The credentials (environment only) --------------------------------------------------------------------------------

export interface ApnsCredentials {
  keyPem: string;
  keyId: string;
  teamId: string;
  topic: string;
}

export type CredentialsProblem = "missing" | "key-in-repo" | "key-unreadable" | "invalid";

/**
 * Reads the credentials from the environment. Returns the problem (never the values) when they are not usable: the key file must
 * not be inside the directory the server runs from, so that it can never be committed or served by accident.
 */
export function readApnsCredentials(env: NodeJS.ProcessEnv, cwd = process.cwd()): { credentials: ApnsCredentials } | { problem: CredentialsProblem } {
  const keyFile = env.HYDRA_UMC_APNS_KEY_FILE?.trim();
  const keyId = env.HYDRA_UMC_APNS_KEY_ID?.trim();
  const teamId = env.HYDRA_UMC_APNS_TEAM_ID?.trim();
  const topic = env.HYDRA_UMC_APNS_TOPIC?.trim();
  if (!keyFile || !keyId || !teamId || !topic) return { problem: "missing" };
  if (!/^[A-Z0-9]{10}$/.test(keyId) || !/^[A-Z0-9]{10}$/.test(teamId) || !/^[A-Za-z0-9.-]{3,155}$/.test(topic)) return { problem: "invalid" };
  const resolved = path.resolve(keyFile);
  const root = path.resolve(cwd);
  if (resolved === root || resolved.startsWith(root + path.sep)) return { problem: "key-in-repo" };
  let keyPem: string;
  try {
    keyPem = fs.readFileSync(resolved, "utf8");
    crypto.createPrivateKey(keyPem);
  } catch {
    return { problem: "key-unreadable" };
  }
  return { credentials: { keyPem, keyId, teamId, topic } };
}

// ---- The Apple push service --------------------------------------------------------------------------------------------

export interface ApnsResult {
  status: number;
  reason?: string;
}

export interface ApnsSender {
  send(token: string, payload: Record<string, unknown>, options: { collapseId?: string; expiresInSeconds: number }): Promise<ApnsResult>;
  close(): void;
}

const APNS_PRODUCTION = "https://api.push.apple.com";
const APNS_SANDBOX = "https://api.sandbox.push.apple.com";

/** The provider token of the Apple push service is valid for an hour and must not be renewed more often than every 20 minutes. */
const JWT_LIFETIME_MS = 45 * 60 * 1000;

export class ApnsClient implements ApnsSender {
  private session: http2.ClientHttp2Session | null = null;
  private jwt: { value: string; at: number } | null = null;

  constructor(
    private readonly credentials: ApnsCredentials,
    private readonly options: { sandbox: boolean; baseUrl?: string; timeoutMs?: number; now?: () => number },
  ) {}

  private baseUrl(): string {
    return this.options.baseUrl ?? (this.options.sandbox ? APNS_SANDBOX : APNS_PRODUCTION);
  }

  /** The signed provider token (ES256), cached. */
  providerToken(): string {
    const now = (this.options.now ?? Date.now)();
    if (this.jwt && now - this.jwt.at < JWT_LIFETIME_MS) return this.jwt.value;
    const b64 = (v: object) => Buffer.from(JSON.stringify(v)).toString("base64url");
    const input = `${b64({ alg: "ES256", kid: this.credentials.keyId })}.${b64({ iss: this.credentials.teamId, iat: Math.floor(now / 1000) })}`;
    const signature = crypto.sign("sha256", Buffer.from(input), { key: this.credentials.keyPem, dsaEncoding: "ieee-p1363" }).toString("base64url");
    this.jwt = { value: `${input}.${signature}`, at: now };
    return this.jwt.value;
  }

  private connect(): http2.ClientHttp2Session {
    if (this.session && !this.session.closed && !this.session.destroyed) return this.session;
    const session = http2.connect(this.baseUrl());
    session.on("error", () => {
      if (this.session === session) this.session = null;
    });
    session.on("close", () => {
      if (this.session === session) this.session = null;
    });
    session.unref();
    this.session = session;
    return session;
  }

  send(token: string, payload: Record<string, unknown>, options: { collapseId?: string; expiresInSeconds: number }): Promise<ApnsResult> {
    return new Promise((resolve) => {
      let settled = false;
      const done = (r: ApnsResult) => {
        if (settled) return;
        settled = true;
        resolve(r);
      };
      try {
        const session = this.connect();
        const body = JSON.stringify(payload);
        const request = session.request({
          ":method": "POST",
          ":path": `/3/device/${token}`,
          authorization: `bearer ${this.providerToken()}`,
          "apns-topic": this.credentials.topic,
          "apns-push-type": "alert",
          "apns-priority": "10",
          "apns-expiration": String(Math.floor(Date.now() / 1000) + options.expiresInSeconds),
          ...(options.collapseId ? { "apns-collapse-id": options.collapseId.slice(0, 64) } : {}),
          "content-type": "application/json",
          "content-length": String(Buffer.byteLength(body)),
        });
        let status = 0;
        const chunks: Buffer[] = [];
        request.setTimeout(this.options.timeoutMs ?? 5000, () => {
          request.close(http2.constants.NGHTTP2_CANCEL);
          done({ status: 0, reason: "timeout" });
        });
        request.on("response", (headers) => {
          status = Number(headers[":status"] ?? 0);
        });
        request.on("data", (c) => chunks.push(Buffer.from(c)));
        request.on("end", () => {
          let reason: string | undefined;
          try {
            reason = JSON.parse(Buffer.concat(chunks).toString("utf8"))?.reason;
          } catch {
            reason = undefined;
          }
          done({ status, reason: typeof reason === "string" ? reason : undefined });
        });
        request.on("error", () => done({ status: 0, reason: "network" }));
        request.end(body);
      } catch {
        done({ status: 0, reason: "network" });
      }
    });
  }

  close(): void {
    this.session?.close();
    this.session = null;
  }
}

// ---- The service ---------------------------------------------------------------------------------------------------------

/** Reasons after which the token is no longer worth keeping. */
const DEAD_TOKEN_REASONS = new Set(["BadDeviceToken", "Unregistered", "DeviceTokenNotForTopic"]);

export interface PushStatus {
  enabled: boolean;
  /** Whether the credentials are present and usable. Never the credentials themselves. */
  configured: boolean;
  problem: CredentialsProblem | null;
  devices: number;
  sandbox: boolean;
  events: { jobFinished: boolean; globalStop: boolean };
}

export class PushService {
  private sender: ApnsSender | null = null;
  private credentialsState: { credentials: ApnsCredentials } | { problem: CredentialsProblem } | null = null;

  constructor(
    private readonly deps: {
      enabled: () => boolean;
      config: () => PushFile | undefined;
      devices: PushDevices;
      env: () => NodeJS.ProcessEnv;
      /** Tests plug in a simulated Apple service here. */
      makeSender?: (credentials: ApnsCredentials, sandbox: boolean) => ApnsSender;
      log: (line: string) => void;
    },
  ) {
    pushBus.on("event", this.onEvent);
  }

  private readonly onEvent = (event: PushEvent, detail: { robotName?: string }): void => {
    void this.notify(event, detail);
  };

  private sandbox(): boolean {
    return this.deps.config()?.sandbox === true;
  }

  private credentials(): { credentials: ApnsCredentials } | { problem: CredentialsProblem } {
    if (!this.credentialsState || "problem" in this.credentialsState) this.credentialsState = readApnsCredentials(this.deps.env());
    return this.credentialsState;
  }

  status(): PushStatus {
    const c = this.credentials();
    const config = this.deps.config();
    return {
      enabled: this.deps.enabled(),
      configured: "credentials" in c,
      problem: "problem" in c ? c.problem : null,
      devices: this.deps.devices.count(),
      sandbox: this.sandbox(),
      events: { jobFinished: config?.notifyJobFinished !== false, globalStop: config?.notifyGlobalStop !== false },
    };
  }

  private eventAllowed(event: PushEvent): boolean {
    const config = this.deps.config();
    return event === "job-finished" ? config?.notifyJobFinished !== false : config?.notifyGlobalStop !== false;
  }

  /** Sends the notification of [event] to every registered phone. Never throws. Returns how many were accepted. */
  async notify(event: PushEvent, detail: { robotName?: string } = {}): Promise<number> {
    try {
      if (!this.deps.enabled() || !this.eventAllowed(event)) return 0;
      const state = this.credentials();
      if (!("credentials" in state)) return 0;
      if (!this.sender) this.sender = (this.deps.makeSender ?? ((c, sandbox) => new ApnsClient(c, { sandbox, baseUrl: this.deps.env().HYDRA_UMC_APNS_URL?.trim() || undefined })))(state.credentials, this.sandbox());
      const sender = this.sender;
      let accepted = 0;
      for (const device of [...this.deps.devices.list()]) {
        const text = pushText(event, device.locale, detail.robotName);
        const result = await sender.send(
          device.token,
          { aps: { alert: { title: text.title, body: text.body }, sound: "default" }, kind: event },
          { collapseId: event === "job-finished" ? `job-${detail.robotName ?? "any"}` : "global-stop", expiresInSeconds: event === "global-stop" ? 3600 : 24 * 3600 },
        );
        if (result.status === 200) accepted++;
        else if (result.status === 410 || DEAD_TOKEN_REASONS.has(result.reason ?? "")) this.deps.devices.remove(device.token, null);
        else this.deps.log(`[PUSH] the push service refused a notification: ${result.status} ${result.reason ?? ""}`.trim());
      }
      return accepted;
    } catch {
      this.deps.log("[PUSH] a notification could not be sent.");
      return 0;
    }
  }

  close(): void {
    pushBus.off("event", this.onEvent);
    this.sender?.close();
    this.sender = null;
  }
}
