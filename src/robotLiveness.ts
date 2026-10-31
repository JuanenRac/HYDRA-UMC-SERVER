// =============================================================================
// HYDRA-UMC-SERVER - src/robotLiveness.ts
// Copyright (C) 2026 JuanenRac (Electro Hobby 3D) <electrohobby3d@gmail.com>
// GPL-3.0-or-later - see LICENSE
// =============================================================================
// A signal of life per robot that is calculated here and is not a button of the interface. The flag `online` of a
// robot in the settings only says what an operator switched on; this module says when the server last had news of
// the robot: a command it carried out, a change of its state that went out to the clients, or a heartbeat that a
// bridge or controller sent (POST /api/robot/:id/heartbeat). A robot of the roster that has had no news since the
// server started is "unknown", never "live", and one whose last news is older than the stale limit is "stale".
//
// The stale limit is a parameter, not a constant of the code: `liveness.staleAfterS` in data/server-config.json
// (default 30, from 1 to 3600).
export type LivenessState = "live" | "stale" | "unknown";
export type LivenessSource = "state" | "heartbeat";

export const DEFAULT_STALE_AFTER_S = 30;
export const MIN_STALE_AFTER_S = 1;
export const MAX_STALE_AFTER_S = 3600;

/** The configured limit when it is a whole number in range; the default for anything else (a typing mistake never disables the check). */
export function staleAfterFrom(value: unknown): number {
  return typeof value === "number" && Number.isInteger(value) && value >= MIN_STALE_AFTER_S && value <= MAX_STALE_AFTER_S ? value : DEFAULT_STALE_AFTER_S;
}

export interface RobotLiveness {
  controller_id: string;
  robot_id: number;
  state: LivenessState;
  /** Absent while the state is "unknown". */
  last_update_utc?: string;
  age_s?: number;
  source?: LivenessSource;
}

export interface LivenessReport {
  schema_version: "1.0";
  stale_after_s: number;
  robots: RobotLiveness[];
}

interface Touch {
  at: number;
  source: LivenessSource;
}

export class RobotLivenessTracker {
  readonly #touches = new Map<number, Touch>();
  readonly #now: () => number;

  constructor(now: () => number = Date.now) {
    this.#now = now;
  }

  /** News of a robot. A robot id the roster does not know is kept too (the roster is checked when the report is made). */
  touch(robotId: number, source: LivenessSource): void {
    if (!Number.isInteger(robotId)) return;
    this.#touches.set(robotId, { at: this.#now(), source });
  }

  /** The robots of the roster (controllers[].robots) with their state of life. */
  report(settings: any, staleAfterS: number): LivenessReport {
    const now = this.#now();
    const robots: RobotLiveness[] = [];
    for (const controller of Array.isArray(settings?.controllers) ? settings.controllers : []) {
      for (const robot of Array.isArray(controller?.robots) ? controller.robots : []) {
        if (typeof robot?.id !== "number") continue;
        const entry: RobotLiveness = { controller_id: String(controller?.id ?? ""), robot_id: robot.id, state: "unknown" };
        const touch = this.#touches.get(robot.id);
        if (touch) {
          const ageS = Math.max(0, Math.round((now - touch.at) / 1000));
          entry.state = ageS <= staleAfterS ? "live" : "stale";
          entry.last_update_utc = new Date(touch.at).toISOString();
          entry.age_s = ageS;
          entry.source = touch.source;
        }
        robots.push(entry);
      }
    }
    return { schema_version: "1.0", stale_after_s: staleAfterS, robots };
  }
}
