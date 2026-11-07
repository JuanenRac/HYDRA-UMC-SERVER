// =============================================================================
// HYDRA-UMC-SERVER - src/liveActivity.ts
// Copyright (C) 2026 JuanenRac (Electro Hobby 3D) <electrohobby3d@gmail.com>
// GPL-3.0-or-later - see LICENSE
// =============================================================================
// The Live Activity of the iPhone: the card of a robot on the lock screen, updated by the Apple push service. OFF by default (push.liveActivity.enabled, a
// switch of Server Admin) and a no-op until push itself is on and the credentials of the push service are present (they come only from the environment,
// src/pushNotifications.ts). What the card may show is a level that an administrator chooses in Server Admin:
//   status    only the state of the robot (running, idle, stopped, error, finished)   <- the default
//   progress  the state and the progress of the job (percent and step)
//   full      everything of the panel of the robot (the name, the job, the position of the joints, the tool, the temperatures)
// "full" is the most the server will ever put on a lock screen; the level is applied here, on the server, before anything leaves it: a phone cannot ask for
// more than the level says. A lock screen is seen by whoever holds the phone, so raising the level asks for a confirmation.
import fs from "node:fs";
import path from "node:path";
import { pushBus, type ApnsSender } from "./pushNotifications";

export const LIVE_ACTIVITY_LEVELS = ["status", "progress", "full"] as const;
export type LiveActivityLevel = (typeof LIVE_ACTIVITY_LEVELS)[number];
export const DEFAULT_LIVE_ACTIVITY_LEVEL: LiveActivityLevel = "status";
/** The most a lock screen can ever be shown. There is no level above it. */
export const MAX_LIVE_ACTIVITY_LEVEL: LiveActivityLevel = "full";

export const ROBOT_STATES = ["running", "idle", "stopped", "error", "finished"] as const;
export type RobotState = (typeof ROBOT_STATES)[number];

export const MAX_ACTIVITIES_PER_ACCOUNT = 8;
export const MAX_ACTIVITIES = 200;
/** The Apple push service refuses a Live Activity payload above 4 KB. */
export const MAX_PAYLOAD_BYTES = 4096;
export const MAX_PANEL_FIELDS = 24;
const MAX_TEXT = 64;

export const levelRank = (level: LiveActivityLevel): number => LIVE_ACTIVITY_LEVELS.indexOf(level);
export const isLevel = (value: unknown): value is LiveActivityLevel => typeof value === "string" && (LIVE_ACTIVITY_LEVELS as readonly string[]).includes(value);
/** A level that is not one of the three (a typing mistake in the file) is the conservative one, never a higher one. */
export const levelOrDefault = (value: unknown): LiveActivityLevel => (isLevel(value) ? value : DEFAULT_LIVE_ACTIVITY_LEVEL);
/** Raising the level (or turning the card on) shows more on a lock screen and needs the confirmation; lowering it never does. */
export const raisesExposure = (from: LiveActivityLevel, to: LiveActivityLevel): boolean => levelRank(to) > levelRank(from);

/** What the server knows of one robot at one moment. Everything but the state is optional. */
export interface RobotSnapshot {
  robotId: string;
  state: RobotState;
  progressPercent?: number;
  step?: number;
  totalSteps?: number;
  /** The panel of the robot: name, job, joints, tool, temperatures... plain values only. */
  panel?: Record<string, string | number | boolean>;
}

export type ContentState = Record<string, string | number | boolean | Record<string, string | number | boolean>>;

const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

/** The fields of the card for a level; nothing above the level is ever copied, whatever the snapshot holds. */
export function contentStateFor(level: LiveActivityLevel, snapshot: RobotSnapshot): ContentState {
  const state: ContentState = { state: ROBOT_STATES.includes(snapshot.state) ? snapshot.state : "error" };
  if (levelRank(level) >= levelRank("progress")) {
    if (finite(snapshot.progressPercent)) state.progressPercent = Math.max(0, Math.min(100, Math.round(snapshot.progressPercent)));
    if (finite(snapshot.step) && snapshot.step >= 0) state.step = Math.floor(snapshot.step);
    if (finite(snapshot.totalSteps) && snapshot.totalSteps >= 0) state.totalSteps = Math.floor(snapshot.totalSteps);
  }
  if (levelRank(level) >= levelRank("full") && snapshot.panel && typeof snapshot.panel === "object") {
    const panel: Record<string, string | number | boolean> = {};
    for (const [key, value] of Object.entries(snapshot.panel)) {
      if (Object.keys(panel).length >= MAX_PANEL_FIELDS) break;
      if (!/^[A-Za-z][A-Za-z0-9_]{0,31}$/.test(key)) continue;
      if (typeof value === "string") panel[key] = value.slice(0, MAX_TEXT);
      else if (typeof value === "boolean") panel[key] = value;
      else if (finite(value)) panel[key] = Math.round(value * 1000) / 1000;
    }
    if (Object.keys(panel).length > 0) state.panel = panel;
  }
  return state;
}

export type LiveActivityEvent = "update" | "end";

/** The payload of the Apple push service for a Live Activity (apns-push-type liveactivity). Returns null when it would not fit in 4 KB. */
export function livePayload(level: LiveActivityLevel, event: LiveActivityEvent, snapshot: RobotSnapshot, nowSeconds: number): Record<string, unknown> | null {
  const aps: Record<string, unknown> = { timestamp: Math.floor(nowSeconds), event, "content-state": contentStateFor(level, snapshot) };
  if (event === "end") aps["dismissal-date"] = Math.floor(nowSeconds) + 300;
  const payload = { aps };
  return Buffer.byteLength(JSON.stringify(payload)) <= MAX_PAYLOAD_BYTES ? payload : null;
}

/** An activity token is hexadecimal like a device token (and may be longer). */
export const validActivityToken = (token: unknown): token is string => typeof token === "string" && /^[0-9a-fA-F]{32,400}$/.test(token);
export const validRobotId = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/.test(value);

export interface LiveActivityRecord { token: string; username: string; robotId: string; registeredAt: string }

export class LiveActivityError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

/** The tokens of the Live Activities that phones started, kept in a file only its owner reads. */
export class LiveActivities {
  private records: LiveActivityRecord[] = [];

  constructor(private readonly file: string) {
    try {
      const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
      if (Array.isArray(parsed?.activities)) {
        this.records = parsed.activities.filter((r: any) => validActivityToken(r?.token) && typeof r?.username === "string" && validRobotId(r?.robotId))
          .map((r: any) => ({ token: r.token.toLowerCase(), username: r.username, robotId: r.robotId, registeredAt: typeof r.registeredAt === "string" ? r.registeredAt : "" }));
      }
    } catch {
      this.records = [];
    }
  }

  private save(): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ activities: this.records }, null, 2) + "\n", { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }

  count(): number { return this.records.length; }
  list(): readonly LiveActivityRecord[] { return this.records; }
  forRobot(robotId: string): LiveActivityRecord[] { return this.records.filter((r) => r.robotId === robotId); }

  /** Registers (or refreshes) the token of an activity; a token seen again moves to the account and robot that registered it last. */
  register(token: string, username: string, robotId: string, now = new Date()): void {
    const lowered = token.toLowerCase();
    const known = this.records.findIndex((r) => r.token === lowered);
    const entry = { token: lowered, username, robotId, registeredAt: now.toISOString() };
    if (known >= 0) {
      this.records[known] = entry;
    } else {
      if (this.records.length >= MAX_ACTIVITIES) throw new LiveActivityError(409, "too many Live Activities are registered");
      if (this.records.filter((r) => r.username === username).length >= MAX_ACTIVITIES_PER_ACCOUNT) throw new LiveActivityError(409, "this account has too many Live Activities");
      this.records.push(entry);
    }
    this.save();
  }

  remove(token: string, username: string | null): boolean {
    const lowered = token.toLowerCase();
    const before = this.records.length;
    this.records = this.records.filter((r) => !(r.token === lowered && (username === null || r.username === username)));
    if (this.records.length === before) return false;
    this.save();
    return true;
  }

  removeAccount(username: string): number {
    const before = this.records.length;
    this.records = this.records.filter((r) => r.username !== username);
    if (this.records.length !== before) this.save();
    return before - this.records.length;
  }
}

const DEAD = new Set(["BadDeviceToken", "Unregistered", "DeviceTokenNotForTopic", "ExpiredToken"]);

/** Sends the cards. Never throws, never sends while the switch is off, and never puts on a lock screen more than the level says. */
export class LiveActivityService {
  constructor(private readonly deps: {
    enabled: () => boolean;
    level: () => LiveActivityLevel;
    activities: LiveActivities;
    sender: () => ApnsSender | null;
    now?: () => number;
    log: (line: string) => void;
  }) {}

  async push(event: LiveActivityEvent, snapshot: RobotSnapshot): Promise<number> {
    try {
      if (!this.deps.enabled()) return 0;
      const sender = this.deps.sender();
      if (!sender) return 0;
      const payload = livePayload(levelOrDefault(this.deps.level()), event, snapshot, (this.deps.now ?? Date.now)() / 1000);
      if (!payload) {
        this.deps.log("[PUSH] a Live Activity update was too large and was not sent.");
        return 0;
      }
      let accepted = 0;
      for (const record of [...this.deps.activities.forRobot(snapshot.robotId)]) {
        const result = await sender.send(record.token, payload, { collapseId: `live-${snapshot.robotId}`.slice(0, 64), expiresInSeconds: 3600, pushType: "liveactivity" });
        if (result.status === 200) accepted++;
        else if (result.status === 410 || DEAD.has(result.reason ?? "")) this.deps.activities.remove(record.token, null);
        else this.deps.log(`[PUSH] the push service refused a Live Activity: ${result.status} ${result.reason ?? ""}`.trim());
      }
      return accepted;
    } catch {
      this.deps.log("[PUSH] a Live Activity could not be sent.");
      return 0;
    }
  }
}

/** What the rest of the server says to the Live Activity: it never imports the service, it only emits here. */
export const liveBus = pushBus;
export function emitRobotSnapshot(snapshot: RobotSnapshot, event: LiveActivityEvent = "update"): void {
  try {
    liveBus.emit("live", event, snapshot);
  } catch {
    // A push problem never reaches the code that raised the event.
  }
}

const PANEL_KEYS = ["name", "model", "tool", "j1", "j2", "j3", "j4", "j5", "j6", "x", "y", "z"] as const;

/** The snapshot of a robot from the settings of the server and the delta that changed it; null when the robot cannot be found. The id of a robot is its controller and number. */
export function snapshotFromRobot(settings: any, delta: { controllerId: string; robotId: number }): RobotSnapshot | null {
  const controller = (settings?.controllers ?? []).find((c: any) => c?.id === delta.controllerId);
  const robot = (controller?.robots ?? []).find((r: any) => r?.id === delta.robotId);
  if (!robot) return null;
  const playback = robot.playbackState ?? {};
  const points = Array.isArray(robot.recordedPoints) ? robot.recordedPoints.length : 0;
  const step = typeof playback.activeStep === "number" && playback.activeStep >= 0 ? playback.activeStep : undefined;
  let state: RobotState = "idle";
  if (playback.isPlaying === true || playback.playing === true) state = "running";
  else if (playback.isFinished === true || playback.finished === true) state = "finished";
  else if (playback.requestStop === true) state = "stopped";
  const snapshot: RobotSnapshot = { robotId: `${delta.controllerId}:${delta.robotId}`, state };
  if (points > 0 && step !== undefined) {
    snapshot.step = step;
    snapshot.totalSteps = points;
    snapshot.progressPercent = (step / points) * 100;
  } else if (state === "finished") {
    snapshot.progressPercent = 100;
  }
  const panel: Record<string, string | number | boolean> = {};
  for (const key of PANEL_KEYS) {
    const value = robot[key];
    if (typeof value === "string" || typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value))) panel[key] = value;
  }
  if (Object.keys(panel).length > 0) snapshot.panel = panel;
  return snapshot;
}
