// =============================================================================
// HYDRA-UMC-SERVER - src/connections.ts
// Copyright (C) 2026 JuanenRac (Electro Hobby 3D) <electrohobby3d@gmail.com>
// GPL-3.0-or-later - see LICENSE
// =============================================================================
// Who connects to the server: the clients (a Studio or Suite session, an app, the voice service, anything else) with
// when each was first and last seen, and a bounded history of what happened (first seen, sign-in, refused sign-in,
// sign-out, end of a session). Both have the closed shape of the ConnectionClient and ConnectionEvent contracts of the
// SDK. It never holds a password, a token, a cookie or a code: a client is described by its kind, the user it signed
// in as, the version it says it is and, only when the administrator allows it (connections.recordAddress), its address
// and user agent, which only an administrator is shown.
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const CLIENT_KINDS = ["studio", "suite", "android", "ios", "dsi", "watch", "voice", "other"] as const;
export type ClientKind = (typeof CLIENT_KINDS)[number];
export const CONNECTION_ACTIONS = ["first_seen", "login", "login_failed", "second_factor_failed", "logout", "session_ended", "session_expired"] as const;
export type ConnectionAction = (typeof CONNECTION_ACTIONS)[number];
export type Origin = "local" | "remote";

export const EVENT_CAPACITY = 500;
export const CLIENT_CAPACITY = 300;
const FORGET_AFTER_MS = 120 * 86_400_000;
const SAVE_EVERY_MS = 30_000;

/** The name a client gives itself: `X-Hydra-Client: android` or `X-Hydra-Client: studio/0.8.1` (the version is optional). Only informative (anybody can write it), so it never gives a client more rights. */
const CLIENT_HEADER = /^(studio|suite|android|ios|dsi|watch|voice)(?:\/([0-9A-Za-z._-]{1,24}))?$/;
const VERSION = /^[0-9A-Za-z._-]{1,24}$/;

export type Sighting = { kind: ClientKind; user?: string; version?: string; agent?: string; ip?: string; origin?: Origin; twoFactor?: boolean };

export type HeaderSource = { header(name: string): string | undefined };

/** Control characters out, a bound on the length. */
const clean = (value: string | undefined, max: number): string | undefined => {
  if (value === undefined) return undefined;
  const text = value.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, max);
  return text === "" ? undefined : text;
};

/** The coarse family of a user agent (browser and system, or the application name), so that an update of the browser is not "another device". */
export function agentFamily(agent: string | undefined): string {
  const text = agent ?? "";
  const browser = /Edg\//.test(text) ? "edge" : /OPR\/|Opera/.test(text) ? "opera" : /Firefox\//.test(text) ? "firefox" : /Chrome\/|CriOS\//.test(text) ? "chrome" : /Safari\//.test(text) ? "safari" : "";
  const system = /Windows/.test(text) ? "windows" : /Android/.test(text) ? "android" : /iPhone|iPad|iOS/.test(text) ? "ios" : /Mac OS X|Macintosh/.test(text) ? "mac" : /Linux|X11/.test(text) ? "linux" : "";
  if (browser) return `${browser}/${system}`;
  return (text.split(/[\s/]/)[0] ?? "").toLowerCase().slice(0, 24);
}

/** What kind of client a request comes from: what it says (`X-Hydra-Client`), else what its user agent shows. */
export function identify(request: HeaderSource): Pick<Sighting, "kind" | "version" | "agent"> {
  const agent = clean(request.header("user-agent"), 120);
  const said = CLIENT_HEADER.exec(request.header("x-hydra-client") ?? "");
  if (said) return { kind: said[1] as ClientKind, version: said[2], agent };
  const text = agent ?? "";
  const app = /^HYDRA-UMC-(ANDROID|IOS|WATCH|DSI|VOICE|SUITE|STUDIO)(?:-[A-Z]+)?\/([0-9A-Za-z._-]{1,24})/i.exec(text);
  if (app) return { kind: app[1].toLowerCase() as ClientKind, version: app[2], agent };
  if (/^HYDRA-UMC-VOICE/i.test(text)) return { kind: "voice", agent };
  if (/Dalvik|okhttp/i.test(text)) return { kind: "android", agent };
  if (/CFNetwork|Darwin/i.test(text)) return { kind: "ios", agent };
  return { kind: "other", agent };
}

/** Whether an address is on the same machine or network (loopback, private, link-local) or comes from outside. */
export function originOf(ip: string | undefined): Origin | undefined {
  if (!ip) return undefined;
  const text = ip.replace(/^::ffff:/i, "").toLowerCase();
  if (text === "::1" || /^127\./.test(text) || /^10\./.test(text) || /^192\.168\./.test(text) || /^169\.254\./.test(text)) return "local";
  const octet = /^172\.(\d{1,3})\./.exec(text);
  if (octet && Number(octet[1]) >= 16 && Number(octet[1]) <= 31) return "local";
  if (/^f[cd][0-9a-f]{2}:/.test(text) || /^fe80:/.test(text)) return "local";
  return "remote";
}

/** The identifier of a client: a hash of its kind, the user and the family of its agent. Not a secret, and it cannot be turned back into the user agent. */
export function clientIdOf(sighting: Pick<Sighting, "kind" | "user" | "agent">): string {
  return createHash("sha256").update(`${sighting.kind}|${(sighting.user ?? "").toLowerCase()}|${agentFamily(sighting.agent)}`).digest("hex").slice(0, 16);
}

type ClientRecord = {
  id: string; kind: ClientKind; user?: string; app_version?: string; origin?: Origin; two_factor?: boolean;
  first_seen: number; last_seen: number; last_failure?: number; logins_ok: number; logins_failed: number; ip?: string; agent?: string;
};

/** The ConnectionClient contract. */
export type ConnectionClientView = {
  schema_version: "1.0"; id: string; kind: ClientKind; user?: string; app_version?: string; origin?: Origin; two_factor?: boolean;
  first_seen_utc: string; last_seen_utc: string; last_failure_utc?: string; active_sessions: number; logins_ok: number; logins_failed: number; ip?: string; agent?: string;
};

/** The ConnectionEvent contract. */
export type ConnectionEventView = {
  schema_version: "1.0"; id: number; at_utc: string; action: ConnectionAction; client_kind: ClientKind; client_id: string;
  user?: string; origin?: Origin; two_factor?: boolean; app_version?: string; ip?: string; agent?: string;
};

type StoredEvent = { id: number; at: number; action: ConnectionAction; client_kind: ClientKind; client_id: string; user?: string; origin?: Origin; two_factor?: boolean; app_version?: string; ip?: string; agent?: string };

export type TrackerOptions = {
  /** Where the history is kept; without a file it lives in memory only. */
  file?: string;
  now?: () => number;
  /** Whether the address and user agent are written at all (connections.recordAddress; false by default). */
  recordAddress?: () => boolean;
  eventCapacity?: number;
  clientCapacity?: number;
};

export type ListFilter = { kind?: ClientKind; user?: string; active?: boolean };
export type EventFilter = { kind?: ClientKind; action?: ConnectionAction; user?: string; before?: number; limit?: number };

const isKind = (value: unknown): value is ClientKind => typeof value === "string" && (CLIENT_KINDS as readonly string[]).includes(value);
const isAction = (value: unknown): value is ConnectionAction => typeof value === "string" && (CONNECTION_ACTIONS as readonly string[]).includes(value);
const naturalNumber = (value: unknown): number | undefined => (typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined);

/** The clients the server has seen and the history of what they did, both bounded and kept in a file so that a restart does not forget them. */
export class ConnectionTracker {
  readonly #file?: string;
  readonly #now: () => number;
  readonly #recordAddress: () => boolean;
  readonly #eventCapacity: number;
  readonly #clientCapacity: number;
  readonly #clients = new Map<string, ClientRecord>();
  #events: StoredEvent[] = [];
  #nextId = 1;
  #lastSave = 0;
  #dirty = false;

  constructor(options: TrackerOptions = {}) {
    this.#file = options.file;
    this.#now = options.now ?? Date.now;
    this.#recordAddress = options.recordAddress ?? (() => false);
    this.#eventCapacity = options.eventCapacity ?? EVENT_CAPACITY;
    this.#clientCapacity = options.clientCapacity ?? CLIENT_CAPACITY;
    this.#lastSave = this.#now();
    this.#load();
  }

  #load(): void {
    if (!this.#file) return;
    try {
      const saved = JSON.parse(fs.readFileSync(this.#file, "utf8")) as { clients?: unknown; events?: unknown; nextId?: unknown };
      const cutoff = this.#now() - FORGET_AFTER_MS;
      for (const item of Array.isArray(saved.clients) ? saved.clients.slice(0, this.#clientCapacity) : []) {
        const record = ConnectionTracker.#parseClient(item);
        if (record && record.last_seen >= cutoff) this.#clients.set(record.id, record);
      }
      for (const item of Array.isArray(saved.events) ? saved.events.slice(-this.#eventCapacity) : []) {
        const event = ConnectionTracker.#parseEvent(item);
        if (event) this.#events.push(event);
      }
      const last = this.#events.reduce((high, event) => Math.max(high, event.id), 0);
      this.#nextId = Math.max(last + 1, Math.trunc(naturalNumber(saved.nextId) ?? 1));
    } catch { /* nothing remembered yet */ }
  }

  static #text(value: unknown, max: number): string | undefined { return typeof value === "string" ? clean(value, max) : undefined; }

  static #parseClient(item: unknown): ClientRecord | undefined {
    if (typeof item !== "object" || item === null) return undefined;
    const r = item as Record<string, unknown>;
    if (typeof r.id !== "string" || !/^[0-9a-f]{16}$/.test(r.id) || !isKind(r.kind)) return undefined;
    const first = naturalNumber(r.first_seen), last = naturalNumber(r.last_seen);
    if (first === undefined || last === undefined) return undefined;
    const version = typeof r.app_version === "string" && VERSION.test(r.app_version) ? r.app_version : undefined;
    const user = ConnectionTracker.#text(r.user, 60), ip = ConnectionTracker.#text(r.ip, 64), agent = ConnectionTracker.#text(r.agent, 120);
    const failure = naturalNumber(r.last_failure);
    return {
      id: r.id, kind: r.kind, first_seen: first, last_seen: last, logins_ok: Math.trunc(naturalNumber(r.logins_ok) ?? 0), logins_failed: Math.trunc(naturalNumber(r.logins_failed) ?? 0),
      ...(user ? { user } : {}), ...(version ? { app_version: version } : {}), ...(r.origin === "local" || r.origin === "remote" ? { origin: r.origin } : {}),
      ...(typeof r.two_factor === "boolean" ? { two_factor: r.two_factor } : {}), ...(failure !== undefined ? { last_failure: failure } : {}), ...(ip ? { ip } : {}), ...(agent ? { agent } : {}),
    };
  }

  static #parseEvent(item: unknown): StoredEvent | undefined {
    if (typeof item !== "object" || item === null) return undefined;
    const r = item as Record<string, unknown>;
    const id = naturalNumber(r.id), at = naturalNumber(r.at);
    if (id === undefined || id < 1 || at === undefined || !isAction(r.action) || !isKind(r.client_kind) || typeof r.client_id !== "string" || !/^[0-9a-f]{16}$/.test(r.client_id)) return undefined;
    const version = typeof r.app_version === "string" && VERSION.test(r.app_version) ? r.app_version : undefined;
    const user = ConnectionTracker.#text(r.user, 60), ip = ConnectionTracker.#text(r.ip, 64), agent = ConnectionTracker.#text(r.agent, 120);
    return {
      id: Math.trunc(id), at, action: r.action, client_kind: r.client_kind, client_id: r.client_id,
      ...(user ? { user } : {}), ...(r.origin === "local" || r.origin === "remote" ? { origin: r.origin } : {}), ...(typeof r.two_factor === "boolean" ? { two_factor: r.two_factor } : {}),
      ...(version ? { app_version: version } : {}), ...(ip ? { ip } : {}), ...(agent ? { agent } : {}),
    };
  }

  /** The client is seen now (a new one is made). */
  #touch(sighting: Sighting, change: { ok?: boolean; failed?: boolean }, known?: string): { record: ClientRecord; isNew: boolean } {
    const now = this.#now();
    const id = known ?? clientIdOf(sighting);
    let record = this.#clients.get(id);
    const isNew = record === undefined;
    if (!record) {
      if (this.#clients.size >= this.#clientCapacity) this.#evict();
      record = { id, kind: sighting.kind, first_seen: now, last_seen: now, logins_ok: 0, logins_failed: 0 };
      this.#clients.set(id, record);
    }
    record.last_seen = now;
    const user = clean(sighting.user, 60);
    if (user) record.user = user;
    if (this.#recordAddress()) {
      const ip = clean(sighting.ip, 64), agent = clean(sighting.agent, 120);
      if (ip) record.ip = ip;
      if (agent) record.agent = agent;
    } else {
      delete record.ip;
      delete record.agent;
    }
    if (sighting.version && VERSION.test(sighting.version)) record.app_version = sighting.version;
    if (sighting.origin) record.origin = sighting.origin;
    if (sighting.twoFactor !== undefined) record.two_factor = sighting.twoFactor;
    if (change.ok) record.logins_ok += 1;
    if (change.failed) { record.logins_failed += 1; record.last_failure = now; }
    this.#dirty = true;
    return { record, isNew };
  }

  /** The least recently seen client goes when the table is full, so a flood of different clients cannot grow it without limit. */
  #evict(): void {
    let oldest: ClientRecord | undefined;
    for (const record of this.#clients.values()) if (!oldest || record.last_seen < oldest.last_seen) oldest = record;
    if (oldest) this.#clients.delete(oldest.id);
  }

  #write(sighting: Sighting, action: ConnectionAction, twoFactor?: boolean, known?: string): string {
    // The first time a client shows up, one event says so before the event of what it did.
    if ((action === "login" || action === "login_failed" || action === "second_factor_failed") && !this.#clients.has(known ?? clientIdOf(sighting))) this.#write({ ...sighting, twoFactor: undefined }, "first_seen");
    const { record } = this.#touch(sighting, { ok: action === "login", failed: action === "login_failed" || action === "second_factor_failed" }, known);
    const user = clean(sighting.user, 60);
    const withAddress = this.#recordAddress();
    const ip = withAddress ? clean(sighting.ip, 64) : undefined, agent = withAddress ? clean(sighting.agent, 120) : undefined;
    this.#events.push({
      id: this.#nextId++, at: this.#now(), action, client_kind: record.kind, client_id: record.id,
      ...(user ? { user } : {}), ...(sighting.origin ? { origin: sighting.origin } : {}), ...(twoFactor !== undefined ? { two_factor: twoFactor } : {}),
      ...(sighting.version && VERSION.test(sighting.version) ? { app_version: sighting.version } : {}), ...(ip ? { ip } : {}), ...(agent ? { agent } : {}),
    });
    if (this.#events.length > this.#eventCapacity) this.#events.splice(0, this.#events.length - this.#eventCapacity);
    this.tick();
    return record.id;
  }

  /** A sign-in worked. Returns the identifier of the client, to remember it with the session. */
  login(sighting: Sighting, twoFactor: boolean): string { return this.#write({ ...sighting, twoFactor }, "login", twoFactor); }

  /**
   * A sign-in was refused. The name that was typed is kept only when it is the name of a real account: a person who types the password in the user box,
   * or a stranger who guesses, leaves nothing of what they typed in the history.
   */
  refused(sighting: Sighting, action: "login_failed" | "second_factor_failed", knownUser: boolean): void {
    this.#write(knownUser ? sighting : { ...sighting, user: undefined }, action);
  }

  /** A session of a person ended: they signed out, an administrator ended it, or its time ran out. */
  ended(sighting: Sighting, action: "logout" | "session_ended" | "session_expired"): void { this.#write(sighting, action); }

  /** A session ended and only the identifier of its client is known (it was kept with the session). A client that is no longer remembered says nothing. */
  endedClient(clientId: string, action: "logout" | "session_ended" | "session_expired", at?: Pick<Sighting, "ip" | "origin" | "agent">): void {
    const record = this.#clients.get(clientId);
    if (!record) return;
    this.#write({ kind: record.kind, user: record.user, version: record.app_version, ip: at?.ip, origin: at?.origin, agent: at?.agent }, action, undefined, clientId);
  }

  /** The client made a request: it is remembered, and the first time a client is seen one event says so. */
  seen(sighting: Sighting): void {
    const existing = this.#clients.get(clientIdOf(sighting));
    if (existing && this.#now() - existing.last_seen < SAVE_EVERY_MS) return;
    if (existing) { this.#touch(sighting, {}); this.tick(); return; }
    this.#write(sighting, "first_seen");
  }

  /** Newest first; `sessions` tells how many sessions a client has open (they live in the refresh-token store). Only an administrator is shown the address and user agent. */
  clients(sessions: (id: string) => number, admin: boolean, filter: ListFilter = {}): ConnectionClientView[] {
    const wanted = filter.user?.toLowerCase();
    return [...this.#clients.values()]
      .filter(record => (!filter.kind || record.kind === filter.kind) && (!wanted || record.user?.toLowerCase() === wanted))
      .map(record => ({ record, active: sessions(record.id) }))
      .filter(item => !filter.active || item.active > 0)
      .sort((a, b) => b.record.last_seen - a.record.last_seen)
      .map(({ record, active }) => ({
        schema_version: "1.0" as const, id: record.id, kind: record.kind,
        ...(record.user ? { user: record.user } : {}), ...(record.app_version ? { app_version: record.app_version } : {}), ...(record.origin ? { origin: record.origin } : {}),
        ...(record.two_factor !== undefined ? { two_factor: record.two_factor } : {}),
        first_seen_utc: new Date(record.first_seen).toISOString(), last_seen_utc: new Date(record.last_seen).toISOString(),
        ...(record.last_failure !== undefined ? { last_failure_utc: new Date(record.last_failure).toISOString() } : {}),
        active_sessions: active, logins_ok: record.logins_ok, logins_failed: record.logins_failed,
        ...(admin && record.ip ? { ip: record.ip } : {}), ...(admin && record.agent ? { agent: record.agent } : {}),
      }));
  }

  /** Newest first. `before` is an event number: only older events are returned (for paging). */
  events(admin: boolean, filter: EventFilter = {}): ConnectionEventView[] {
    const limit = Math.min(Math.max(Math.trunc(filter.limit ?? 100), 1), this.#eventCapacity);
    const wanted = filter.user?.toLowerCase();
    const found: ConnectionEventView[] = [];
    for (let index = this.#events.length - 1; index >= 0 && found.length < limit; index--) {
      const event = this.#events[index];
      if (filter.before !== undefined && event.id >= filter.before) continue;
      if (filter.kind && event.client_kind !== filter.kind) continue;
      if (filter.action && event.action !== filter.action) continue;
      if (wanted && event.user?.toLowerCase() !== wanted) continue;
      found.push({
        schema_version: "1.0", id: event.id, at_utc: new Date(event.at).toISOString(), action: event.action, client_kind: event.client_kind, client_id: event.client_id,
        ...(event.user ? { user: event.user } : {}), ...(event.origin ? { origin: event.origin } : {}), ...(event.two_factor !== undefined ? { two_factor: event.two_factor } : {}),
        ...(event.app_version ? { app_version: event.app_version } : {}), ...(admin && event.ip ? { ip: event.ip } : {}), ...(admin && event.agent ? { agent: event.agent } : {}),
      });
    }
    return found;
  }

  /** Written when something changed and the last write was a while ago (called often by the server). */
  tick(): void { if (this.#dirty && this.#now() - this.#lastSave >= SAVE_EVERY_MS) this.flush(); }

  flush(): void {
    this.#lastSave = this.#now();
    if (!this.#dirty || !this.#file) { this.#dirty = false; return; }
    this.#dirty = false;
    try {
      fs.mkdirSync(path.dirname(this.#file), { recursive: true });
      const temporary = `${this.#file}.${process.pid}.tmp`;
      fs.writeFileSync(temporary, JSON.stringify({ schema: 1, nextId: this.#nextId, clients: [...this.#clients.values()], events: this.#events }), { encoding: "utf8", mode: 0o600 });
      fs.renameSync(temporary, this.#file);
    } catch { this.#dirty = true; /* the history of connections is a convenience: it never breaks the request it describes */ }
  }
}

let shared: ConnectionTracker | undefined;
let sharedRecordAddress: () => boolean = () => false;

/** The history of the running server (data/connections.json); `recordAddress` is set once from the security options. */
export function connectionTracker(): ConnectionTracker {
  shared ??= new ConnectionTracker({ file: path.join(process.cwd(), "data", "connections.json"), recordAddress: () => sharedRecordAddress() });
  return shared;
}

export function setRecordAddress(read: () => boolean): void { sharedRecordAddress = read; }

/** For tests: forget the shared tracker (the next call makes a new one in the current directory). */
export function resetConnectionTracker(): void { shared = undefined; sharedRecordAddress = () => false; }
