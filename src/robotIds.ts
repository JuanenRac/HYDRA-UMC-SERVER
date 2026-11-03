// =============================================================================
// HYDRA-UMC-SERVER - src/robotIds.ts
// Copyright (C) 2026 JuanenRac (Electro Hobby 3D) <electrohobby3d@gmail.com>
// GPL-3.0 - see LICENSE
// =============================================================================
// Robot ids are global: /api/robot/:id names ONE robot of the whole installation, whatever controller holds it. A configuration that
// puts the same id on two robots (in two controllers, or twice in one) is ambiguous. This module finds those ids, refuses to register
// new ones, and says which controllers are involved (their ids only, never names, addresses or credentials).

export interface RobotIdConflict {
  robotId: number | string;
  /** The ids of the controllers that hold a robot with this id (one entry per robot, so a controller can appear twice). */
  controllers: string[];
}

export const ROBOT_ID_DUPLICATED = "robot_id_duplicated";
export const ROBOT_ID_AMBIGUOUS = "robot_id_ambiguous";

/** Every robot id used by more than one robot of the settings tree, in the order the ids first appear. */
export function robotIdConflicts(settings: any): RobotIdConflict[] {
  const seen = new Map<string, RobotIdConflict>();
  const controllers = Array.isArray(settings?.controllers) ? settings.controllers : [];
  for (const controller of controllers) {
    const robots = Array.isArray(controller?.robots) ? controller.robots : [];
    for (const robot of robots) {
      if (robot === null || typeof robot !== "object" || robot.id === undefined || robot.id === null) continue;
      const key = String(robot.id);
      let entry = seen.get(key);
      if (!entry) {
        entry = { robotId: robot.id, controllers: [] };
        seen.set(key, entry);
      }
      entry.controllers.push(String(controller?.id ?? ""));
    }
  }
  return [...seen.values()].filter((entry) => entry.controllers.length > 1);
}

/** The conflicts of `payload` that `current` did not already have: what a registration would ADD. An old duplicate may stay while an administrator repairs it; a new one is refused. */
export function newRobotIdConflicts(current: any, payload: any): RobotIdConflict[] {
  const already = new Set(robotIdConflicts(current).map((c) => String(c.robotId)));
  return robotIdConflicts(payload).filter((c) => !already.has(String(c.robotId)));
}

export function isRobotIdAmbiguous(settings: any, robotId: unknown): boolean {
  return robotIdConflicts(settings).some((c) => String(c.robotId) === String(robotId));
}

/** The body of the 409 answer for an ambiguous id, or null when the id is not ambiguous. */
export function ambiguousRobotBody(settings: any, robotId: unknown): { error: string; code: string; robotId: unknown; controllers: string[] } | null {
  const hit = robotIdConflicts(settings).find((c) => String(c.robotId) === String(robotId));
  if (!hit) return null;
  return {
    error: `robot id ${hit.robotId} is used by more than one robot (controllers: ${hit.controllers.join(", ")}); fix the configuration so every robot id is unique`,
    code: ROBOT_ID_AMBIGUOUS,
    robotId: hit.robotId,
    controllers: hit.controllers,
  };
}

/** The body of the 409 answer for a registration that would duplicate ids. */
export function duplicatedRobotBody(conflicts: RobotIdConflict[]): { error: string; code: string; conflicts: RobotIdConflict[] } {
  const list = conflicts.map((c) => `${c.robotId} (controllers: ${c.controllers.join(", ")})`).join("; ");
  return {
    error: `robot ids must be unique across all controllers; already used or repeated: ${list}`,
    code: ROBOT_ID_DUPLICATED,
    conflicts,
  };
}

/** Thrown by the settings write when the tree would add a duplicated robot id; the routes turn it into a 409. */
export class RobotIdDuplicatedError extends Error {
  readonly conflicts: RobotIdConflict[];
  constructor(conflicts: RobotIdConflict[]) {
    super(duplicatedRobotBody(conflicts).error);
    this.name = "RobotIdDuplicatedError";
    this.conflicts = conflicts;
  }
}

/** The log lines of the start: one per ambiguous id, empty when the roster is clean. */
export function ambiguousRobotLogLines(settings: any): string[] {
  return robotIdConflicts(settings).map(
    (c) => `[ROBOT-IDS] robot id ${c.robotId} is used by ${c.controllers.length} robots (controllers: ${c.controllers.join(", ")}); the routes by that id answer 409 ${ROBOT_ID_AMBIGUOUS} until the configuration is fixed.`,
  );
}
