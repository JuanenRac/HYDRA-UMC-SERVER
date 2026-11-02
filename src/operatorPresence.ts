// =============================================================================
// HYDRA-UMC-SERVER - src/operatorPresence.ts
// Copyright (C) 2026 JuanenRac (Electro Hobby 3D) <electrohobby3d@gmail.com>
// GPL-3.0-or-later - see LICENSE
// =============================================================================
// The dead-man of the presence of the operator. A client (the watch, through the phone) tells the server every few seconds that the person who
// drives the robots is still there (POST /api/operator/presence). When the heartbeats stop, or the person says they LEFT, the server acts on the
// robots that person holds a claim on, with the action an administrator chose:
//
//   slow    (default) lowers the speed of those robots to a share of what it was (slowFactor) and keeps it there
//   pause   pauses the ones that are running; they are NOT resumed by themselves
//   notify  only warns (log, audit record, push); no robot is touched
//   stop    stops them (the same playback state as a stop); they are NOT started again by themselves
//
// The whole function is off by default (presence.enabled). When the heartbeats come back, the operator is trusted again only after
// presence.recoverBeats heartbeats in a row (hysteresis), and a lowered speed then returns to what it was along presence.rampSeconds, without a jump.
// A speed that the operator changes during the return is left as they set it. The global stop always wins: nothing here starts, resumes or
// un-stops a robot, and the stop never waits for this code (it only changes numbers in memory, never awaits).
// Every number lives in data/server-config.json (see PresenceFile in src/securityConfig.ts).
// =============================================================================

import { presenceTimes, type PresenceActionValue, type PresenceFile } from "./securityConfig";

/** present; left (said LEFT, not acting yet because leftImmediate is off); lost (acting); recovering (back, counting heartbeats). */
export type PresenceState = "present" | "lost" | "left" | "recovering";

export interface PresenceBeat {
  sequence: number;
  intervalSeconds: number;
  state: "PRESENT" | "LEFT";
}

export type BeatParse = { ok: true; beat: PresenceBeat } | { ok: false; error: string };

/** Checks the body of the heartbeat (the message of the watch: protocolVersion 1, sequence, intervalSeconds 1 to 60, state PRESENT or LEFT). */
export function parsePresenceBeat(body: unknown): BeatParse {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return { ok: false, error: "the body must be an object" };
  const b = body as Record<string, unknown>;
  if (b.type !== undefined && b.type !== "presence_heartbeat") return { ok: false, error: "type must be presence_heartbeat" };
  if (b.protocolVersion !== undefined && b.protocolVersion !== 1) return { ok: false, error: "protocolVersion must be 1" };
  const sequence = b.sequence;
  if (typeof sequence !== "number" || !Number.isSafeInteger(sequence) || sequence < 0) return { ok: false, error: "sequence must be a whole number of 0 or more" };
  const interval = b.intervalSeconds;
  if (typeof interval !== "number" || !Number.isFinite(interval) || interval < 1 || interval > 60) return { ok: false, error: "intervalSeconds must be from 1 to 60" };
  if (b.state !== "PRESENT" && b.state !== "LEFT") return { ok: false, error: "state must be PRESENT or LEFT" };
  return { ok: true, beat: { sequence, intervalSeconds: interval, state: b.state } };
}

export interface PresenceSettings {
  action: PresenceActionValue;
  timeoutMs: number;
  slowFactor: number;
  recoverBeats: number;
  rampMs: number;
  leftImmediate: boolean;
}

export function presenceSettings(file: PresenceFile | undefined, action: PresenceActionValue): PresenceSettings {
  const t = presenceTimes(file);
  return { action, timeoutMs: t.timeoutSeconds * 1000, slowFactor: t.slowFactor, recoverBeats: t.recoverBeats, rampMs: t.rampSeconds * 1000, leftImmediate: t.leftImmediate };
}

export type BeatResult = "accepted" | "duplicate" | "stale";

interface Operator {
  userId: unknown;
  username: string;
  lastSequence: number;
  lastBeatAt: number;
  intervalMs: number;
  state: PresenceState;
  goodBeats: number;
}

type Delta = { controllerId: string; robotId: number; patch: Record<string, unknown> };

/** What was done to one robot, kept to give it back. */
interface Degraded {
  userId: unknown;
  originalSpeed: number;
  cap: number;
  /** The speed this code set last; a different value means somebody changed it. */
  last: number;
}

export interface PresenceDeps {
  enabled: () => boolean;
  settings: () => PresenceSettings;
  now: () => number;
  getSettings: () => any;
  isReservationActive: (reservation: any) => boolean;
  /** The playback state of a stopped robot (shared with the stop of the commands). */
  stoppedPlaybackState: (previous: any) => Record<string, unknown>;
  stopServerPlayback: (robotId: number) => void;
  disarm?: (robotId: number) => void;
  broadcastRobotDelta: (deltas: { controllerId: string; robotId: number; patch: Record<string, unknown> }[], fullPayload: any) => void;
  /** Saves the settings; called only when something changed that has to last. Failures are caught here. */
  persist: () => Promise<void>;
  log: (line: string) => void;
  audit?: (event: { type: string; outcome: "ok" | "failed"; userId?: unknown; username?: string; detail: Record<string, unknown> }) => void;
  /** The warning to the phones. */
  warn?: (robotNames: string[]) => void;
}

const MIN_SPEED = 10;

export interface PresenceStatus {
  state: PresenceState | "unknown";
  lastSequence: number | null;
  secondsSinceBeat: number | null;
  action: PresenceActionValue;
  timeoutSeconds: number;
  degradedRobots: number[];
}

export class OperatorPresence {
  private readonly operators = new Map<string, Operator>();
  private readonly degraded = new Map<number, Degraded>();

  constructor(private readonly deps: PresenceDeps) {}

  private key(userId: unknown): string {
    return String(userId);
  }

  private effectiveTimeoutMs(op: Operator): number {
    return Math.max(this.deps.settings().timeoutMs, op.intervalMs * 2 + 1000);
  }

  /**
   * Takes one heartbeat. A heartbeat with the sequence already seen is a duplicate (the answer is the same, nothing changes); one with a lower
   * sequence while the last was recent is stale; after a silence longer than the timeout a lower sequence is a restart of the sender and counts.
   */
  beat(user: { id: unknown; username?: string }, beat: PresenceBeat): { result: BeatResult; state: PresenceState } {
    const now = this.deps.now();
    const key = this.key(user.id);
    let op = this.operators.get(key);
    if (!op) {
      op = { userId: user.id, username: String(user.username ?? ""), lastSequence: -1, lastBeatAt: now, intervalMs: beat.intervalSeconds * 1000, state: "present", goodBeats: 0 };
      this.operators.set(key, op);
    }
    if (op.lastSequence >= 0) {
      if (beat.sequence === op.lastSequence) return { result: "duplicate", state: op.state };
      if (beat.sequence < op.lastSequence && now - op.lastBeatAt < this.effectiveTimeoutMs(op)) return { result: "stale", state: op.state };
    }
    // Silence first: a heartbeat that arrives after the timeout is a return, not a continuation.
    this.evaluate(op, now);
    op.lastSequence = beat.sequence;
    op.lastBeatAt = now;
    op.intervalMs = beat.intervalSeconds * 1000;
    if (beat.state === "LEFT") {
      op.goodBeats = 0;
      if (op.state !== "lost") {
        op.state = "left";
        if (this.deps.settings().leftImmediate) this.lose(op, "left");
      }
      return { result: "accepted", state: op.state };
    }
    if (op.state === "left") op.state = "present";
    else if (op.state === "lost" || op.state === "recovering") {
      op.goodBeats += 1;
      if (op.goodBeats >= this.deps.settings().recoverBeats) this.recover(op);
      else op.state = "recovering";
    }
    return { result: "accepted", state: op.state };
  }

  /** The state of one account, for the account itself. */
  status(userId: unknown): PresenceStatus {
    const op = this.operators.get(this.key(userId));
    const s = this.deps.settings();
    return {
      state: op ? op.state : "unknown",
      lastSequence: op && op.lastSequence >= 0 ? op.lastSequence : null,
      secondsSinceBeat: op ? Math.max(0, Math.round((this.deps.now() - op.lastBeatAt) / 1000)) : null,
      action: s.action,
      timeoutSeconds: s.timeoutMs / 1000,
      degradedRobots: [...this.degraded.entries()].filter(([, d]) => this.key(d.userId) === this.key(userId)).map(([id]) => id),
    };
  }

  /** Called about once a second. */
  tick(): void {
    const now = this.deps.now();
    if (!this.deps.enabled()) {
      // Switched off while robots were held back: let them return to what they were and forget the operators.
      this.operators.clear();
      this.ramp(true);
      return;
    }
    for (const op of this.operators.values()) {
      this.evaluate(op, now);
      if (op.state === "lost") this.enforce(op);
    }
    this.ramp(false);
  }

  private evaluate(op: Operator, now: number): void {
    if (op.state !== "lost" && now - op.lastBeatAt > this.effectiveTimeoutMs(op)) this.lose(op, "timeout");
  }

  private ownedRobots(op: Operator): { controllerId: string; robot: any }[] {
    const out: { controllerId: string; robot: any }[] = [];
    for (const controller of this.deps.getSettings()?.controllers ?? []) {
      for (const robot of controller.robots ?? []) {
        if (this.deps.isReservationActive(robot.reservation) && this.key(robot.reservation.ownerId) === this.key(op.userId)) out.push({ controllerId: String(controller.id), robot });
      }
    }
    return out;
  }

  private lose(op: Operator, why: "timeout" | "left"): void {
    op.state = "lost";
    op.goodBeats = 0;
    const action = this.deps.settings().action;
    const deltas: Delta[] = [];
    const affected: { id: number; name: string }[] = [];
    let persistNeeded = false;
    for (const { controllerId, robot } of this.ownedRobots(op)) {
      const changed = this.hold(op, controllerId, robot, true);
      if (changed) { deltas.push(changed); persistNeeded = true; }
      affected.push({ id: Number(robot.id), name: String(robot.name ?? robot.id) });
    }
    this.push(deltas, persistNeeded);
    this.deps.log(`[PRESENCE] ${op.username || "an operator"} ${why === "left" ? "LEFT on purpose" : "lost the heartbeat"}: action ${action}, ${affected.length} robot(s) held.`);
    this.deps.audit?.({ type: "operator-presence-lost", outcome: "ok", userId: op.userId, username: op.username, detail: { reason: why, action, robotIds: affected.map((a) => a.id) } });
    try {
      this.deps.warn?.(affected.map((a) => a.name));
    } catch {
      // A warning that cannot go out never changes what is done to the robots.
    }
  }

  /** While the heartbeat is lost: a speed raised again goes back to the cap, and a robot the operator took since is held too. */
  private enforce(op: Operator): void {
    const deltas: Delta[] = [];
    let persistNeeded = false;
    for (const { controllerId, robot } of this.ownedRobots(op)) {
      const changed = this.hold(op, controllerId, robot, false);
      if (changed) { deltas.push(changed); persistNeeded = true; }
    }
    this.push(deltas, persistNeeded);
  }

  /** Applies the action to one robot; returns the change to broadcast, or null when nothing changed. `first` is the moment of the loss. */
  private hold(op: Operator, controllerId: string, robot: any, first: boolean): Delta | null {
    const s = this.deps.settings();
    const ps = robot.playbackState ?? (robot.playbackState = { isPlaying: false, activeStep: 0, speed: 100 });
    if (s.action === "slow") {
      const current = Number(ps.speed);
      const existing = this.degraded.get(robot.id);
      const mine = existing !== undefined && this.key(existing.userId) === this.key(op.userId);
      if (mine && Number.isFinite(current) && current <= existing.cap) return null;
      const base = mine ? existing.originalSpeed : Number.isFinite(current) && current > 0 ? current : 100;
      const cap = Math.max(Math.min(MIN_SPEED, base), Math.round(base * s.slowFactor));
      const next = Number.isFinite(current) ? Math.min(current, cap) : cap;
      this.degraded.set(robot.id, { userId: op.userId, originalSpeed: base, cap, last: next });
      if (!first) this.deps.log(`[PRESENCE] robot ${robot.id}: speed held at ${next} while the heartbeat of ${op.username || "its operator"} is lost.`);
      if (next === current) return null;
      ps.speed = next;
      return { controllerId, robotId: robot.id, patch: { playbackState: ps } };
    }
    if (s.action === "pause") {
      if (ps.isPlaying && !ps.isPaused && !ps.requestStop) {
        robot.playbackState = { ...ps, isPlaying: true, playing: true, isPaused: true, paused: true, requestPause: true, requestStop: false };
        return { controllerId, robotId: robot.id, patch: { playbackState: robot.playbackState } };
      }
      return null;
    }
    if (s.action === "stop") {
      if (!first && !ps.isPlaying) return null;
      this.deps.disarm?.(robot.id);
      robot.playbackState = this.deps.stoppedPlaybackState(ps);
      this.deps.stopServerPlayback(robot.id);
      return { controllerId, robotId: robot.id, patch: { playbackState: robot.playbackState } };
    }
    return null;
  }

  private recover(op: Operator): void {
    op.state = "present";
    op.goodBeats = 0;
    const s = this.deps.settings();
    const held = [...this.degraded.entries()].filter(([, d]) => this.key(d.userId) === this.key(op.userId)).map(([id]) => id);
    this.deps.log(`[PRESENCE] ${op.username || "an operator"} is back (${s.recoverBeats} heartbeat(s) in a row); ${held.length} robot(s) return to their speed${s.action === "pause" || s.action === "stop" ? "; paused or stopped robots stay as they are until the operator resumes them" : ""}.`);
    this.deps.audit?.({ type: "operator-presence-restored", outcome: "ok", userId: op.userId, username: op.username, detail: { robotIds: held, rampSeconds: s.rampMs / 1000 } });
  }

  /** Brings the lowered speeds back to what they were, a little at a time. `all` ignores who is present (the function was switched off). */
  private ramp(all: boolean): void {
    if (this.degraded.size === 0) return;
    const rampMs = this.deps.settings().rampMs;
    const deltas: Delta[] = [];
    let finished = false;
    for (const [robotId, d] of [...this.degraded.entries()]) {
      const op = this.operators.get(this.key(d.userId));
      if (!all && op !== undefined && (op.state === "lost" || op.state === "recovering")) continue;
      const found = this.findRobot(robotId);
      if (!found) { this.degraded.delete(robotId); continue; }
      const ps = found.robot.playbackState;
      if (!ps || Number(ps.speed) !== d.last) {
        // The operator set the speed meanwhile: it stays as they set it.
        this.degraded.delete(robotId);
        finished = true;
        continue;
      }
      if (!this.deps.isReservationActive(found.robot.reservation) || this.key(found.robot.reservation.ownerId) !== this.key(d.userId)) {
        // Another account holds the robot now (or nobody): its speed is not touched from here.
        this.degraded.delete(robotId);
        this.deps.log(`[PRESENCE] robot ${robotId} changed hands while held back; its speed is left as it is.`);
        continue;
      }
      const step = rampMs <= 0 ? d.originalSpeed - d.last : Math.max(1, Math.ceil(((d.originalSpeed - d.cap) * 1000) / rampMs));
      const next = Math.min(d.originalSpeed, d.last + step);
      ps.speed = next;
      d.last = next;
      deltas.push({ controllerId: found.controllerId, robotId, patch: { playbackState: ps } });
      if (next >= d.originalSpeed) { this.degraded.delete(robotId); finished = true; }
    }
    this.push(deltas, finished);
  }

  private findRobot(robotId: number): { controllerId: string; robot: any } | null {
    for (const controller of this.deps.getSettings()?.controllers ?? []) {
      for (const robot of controller.robots ?? []) if (robot.id === robotId) return { controllerId: String(controller.id), robot };
    }
    return null;
  }

  private push(deltas: Delta[], persistNeeded: boolean): void {
    if (deltas.length > 0) {
      try {
        this.deps.broadcastRobotDelta(deltas, this.deps.getSettings());
      } catch (error) {
        this.deps.log(`[PRESENCE] the broadcast failed (${error instanceof Error ? error.message : "unknown error"}).`);
      }
    }
    if (persistNeeded) void this.deps.persist().catch(() => this.deps.log("[PRESENCE] the settings could not be saved; the change is applied in memory."));
  }
}
