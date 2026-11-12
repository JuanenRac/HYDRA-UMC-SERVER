// =============================================================================
// HYDRA-UMC-SERVER - src/stopState.ts
// Copyright (C) 2026 JuanenRac (Electro Hobby 3D) <electrohobby3d@gmail.com>
// GPL-3.0-or-later - see LICENSE
// =============================================================================
// One stop state for the apps: the physical emergency stop (the frame on identifier 0x001 of the stack bus, as the kinematic brain holds it and the SPI bridge of the CM5
// publishes it) together with the global stop of the server. The server asks the bridge every few seconds and tells every client only when something changed.
// Off unless HYDRA_UMC_ESTOP_WATCH_MS is set (it is 0 by default): without it the physical part is `unknown` and the state follows the software stop alone. The server
// reads the bridge and never writes to it, so this module can not release a stop or cause one.

export type PhysicalStop = "latched" | "ready" | "unknown";
export type SoftwareStop = "stopped" | "ready";
export type StopStateName = "STOPPED" | "READY" | "UNKNOWN";

export interface StopStateSnapshot {
  schema: 1;
  /** STOPPED when either stop is on; READY when the physical stop is known to be released and the global stop is not on; UNKNOWN when the physical stop is not known. */
  state: StopStateName;
  physical: PhysicalStop;
  software: SoftwareStop;
  /** The state of the CAN link as the brain reports it; null when it is not known. */
  physicalLinkOk: boolean | null;
  /** Where the physical part comes from: the telemetry of the brain, or nothing. */
  source: "brain-telemetry" | "none";
  /** Milliseconds since the epoch of the last change of `state`, `physical` or `software`; 0 before the first. */
  changedAt: number;
}

export interface BridgeEstop {
  online: boolean;
  latched: boolean | null;
  linkOk: boolean | null;
}

/** What the bridge answered, or null for anything that is not a well-formed answer: nothing is guessed from a damaged one. */
export function parseBridgeEstop(body: unknown): BridgeEstop | null {
  if (!body || typeof body !== "object") return null;
  const b = body as Record<string, unknown>;
  if (typeof b.online !== "boolean") return null;
  if (!b.online) return { online: false, latched: null, linkOk: null };
  if (typeof b.latched !== "boolean") return null;
  return { online: true, latched: b.latched, linkOk: typeof b.link_ok === "boolean" ? b.link_ok : null };
}

/** The interval of the watch in milliseconds, 0 (off) unless the variable holds a whole number from 500 to 60000. Anything else leaves it off. */
export function stopWatchIntervalMs(env: Record<string, string | undefined>): number {
  const text = (env.HYDRA_UMC_ESTOP_WATCH_MS ?? "").trim();
  if (!/^\d+$/.test(text)) return 0;
  const value = Number(text);
  return value >= 500 && value <= 60000 ? value : 0;
}

export function unify(physical: PhysicalStop, software: SoftwareStop): StopStateName {
  if (physical === "latched" || software === "stopped") return "STOPPED";
  return physical === "ready" ? "READY" : "UNKNOWN";
}

export interface StopStateOptions {
  /** Asks the bridge; returns the parsed answer or null when it could not be asked or answered something unusable. */
  fetchPhysical: () => Promise<BridgeEstop | null>;
  /** Told after every change of the snapshot. A failure here never reaches the poll. */
  onChange: (snapshot: StopStateSnapshot) => void;
  now?: () => number;
}

export class StopState {
  private physical: PhysicalStop = "unknown";
  private software: SoftwareStop = "ready";
  private linkOk: boolean | null = null;
  private source: "brain-telemetry" | "none" = "none";
  private changedAt = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private polling = false;
  private readonly now: () => number;

  constructor(private readonly options: StopStateOptions) {
    this.now = options.now ?? Date.now;
  }

  snapshot(): StopStateSnapshot {
    return {
      schema: 1,
      state: unify(this.physical, this.software),
      physical: this.physical,
      software: this.software,
      physicalLinkOk: this.linkOk,
      source: this.source,
      changedAt: this.changedAt,
    };
  }

  /** The global stop of the server was applied (true) or released (false). */
  setSoftware(stopped: boolean): void {
    this.apply(this.physical, stopped ? "stopped" : "ready", this.linkOk, this.source);
  }

  /** One reading of the bridge. A reading that fails or is not understood turns the physical part to `unknown`: a silent bridge is never read as a released stop. */
  async poll(): Promise<void> {
    if (this.polling) return;
    this.polling = true;
    try {
      let answer: BridgeEstop | null = null;
      try {
        answer = await this.options.fetchPhysical();
      } catch {
        answer = null;
      }
      if (answer && answer.online && answer.latched !== null) {
        this.apply(answer.latched ? "latched" : "ready", this.software, answer.linkOk, "brain-telemetry");
      } else {
        this.apply("unknown", this.software, null, "none");
      }
    } finally {
      this.polling = false;
    }
  }

  start(intervalMs: number): void {
    this.stop();
    if (intervalMs <= 0) return;
    this.timer = setInterval(() => void this.poll(), intervalMs);
    this.timer.unref?.();
    void this.poll();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private apply(physical: PhysicalStop, software: SoftwareStop, linkOk: boolean | null, source: "brain-telemetry" | "none"): void {
    const changed = physical !== this.physical || software !== this.software;
    this.linkOk = linkOk;
    this.source = source;
    if (!changed) return;
    this.physical = physical;
    this.software = software;
    this.changedAt = this.now();
    try {
      this.options.onChange(this.snapshot());
    } catch {
      // telling the clients must never break the stop
    }
  }
}

/** The fetch of the bridge for the server: `GET <bridge>/estop` with the identity headers of the service, a short timeout, null on any failure. */
export function bridgeFetcher(baseUrl: string, headers: () => Record<string, string>, timeoutMs: number, fetchImpl: typeof fetch = fetch): () => Promise<BridgeEstop | null> {
  return async () => {
    if (!baseUrl) return null;
    try {
      const response = await fetchImpl(`${baseUrl.replace(/\/+$/, "")}/estop`, { headers: headers(), signal: AbortSignal.timeout(timeoutMs) });
      if (!response.ok) return null;
      return parseBridgeEstop(await response.json());
    } catch {
      return null;
    }
  };
}
