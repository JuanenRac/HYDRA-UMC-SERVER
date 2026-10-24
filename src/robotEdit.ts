// =============================================================================
// HYDRA-UMC-SERVER - src/robotEdit.ts
// Copyright (C) 2026 JuanenRac (Electro Hobby 3D) <electrohobby3d@gmail.com>
// GPL-3.0-or-later - see LICENSE
// =============================================================================
// The edits an operator makes on one robot that used to travel inside the whole settings tree (which only an administrator may write): the list of
// recorded points, the repeat flag, the model and the role of the robot, the robots it is combined with, the joint values of the sliders and the
// layout of its XY table. Each one is a robot command of its own (POST /api/robot/:id/command), checked here as a whole before anything changes, so a
// bad value changes nothing; the route then applies the claim, If-Match and arming rules that every other command already goes through.

export const EDIT_COMMANDS: ReadonlySet<string> = new Set(["points", "loop", "model", "role", "combine", "joints", "xyTableConfig"]);

export const MAX_RECORDED_POINTS = 10000;
const POINT_NUMBER_FIELDS = ["j1", "j2", "j3", "j4", "j5", "j6", "x", "y", "z", "a", "b", "c", "tx", "ty", "trz"] as const;
const JOINT_KEYS = ["j1", "j2", "j3", "j4", "j5", "j6"] as const;

/** The roles a robot can be given (the list the control apps offer). */
export const ROBOT_ROLES: readonly string[] = ["Idle", "CNC", "Laser", "Pnp", "3D printing", "Inspection"];

const MODEL_NAME = /^[\p{L}\p{N} ._()+\-/]{1,64}$/u;
/** A joint value in degrees; the widest any robot of the family turns is far inside this. */
export const MAX_JOINT_ABS = 720;
export const MAX_COMBINED = 8;

export type EditFailure = { ok: false; status: number; error: string; code: string };
export type EditPlan = { ok: true; patch: Record<string, unknown> };

const fail = (error: string, code: string, status = 400): EditFailure => ({ ok: false, status, error, code });
const isObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

/** One recorded point reduced to the fields a point may carry; throws a sentence naming what is wrong. */
export function cleanPoint(rawPoint: unknown): Record<string, number | string> {
  if (!isObject(rawPoint)) throw new Error("each trajectory point must be an object");
  const clean: Record<string, number | string> = {};
  for (const field of POINT_NUMBER_FIELDS) {
    if (rawPoint[field] === undefined) continue;
    if (!finite(rawPoint[field])) throw new Error(`trajectory ${field} must be finite`);
    clean[field] = rawPoint[field] as number;
  }
  if (rawPoint.motionType !== undefined) {
    if (rawPoint.motionType !== "model-joints") throw new Error("unsupported trajectory motionType");
    clean.motionType = "model-joints";
  }
  const hasNativeJoints = JOINT_KEYS.every((field) => typeof clean[field] === "number");
  const hasCartesianPose = ["x", "y", "z"].every((field) => typeof clean[field] === "number");
  if (!hasNativeJoints && !hasCartesianPose) throw new Error("trajectory point requires native joints or x/y/z");
  return clean;
}

export function cleanPoints(rawPoints: unknown, minimum: number): Record<string, number | string>[] {
  if (!Array.isArray(rawPoints) || rawPoints.length < minimum || rawPoints.length > MAX_RECORDED_POINTS) {
    throw new Error(minimum > 0 ? `trajectory requires between ${minimum} and ${MAX_RECORDED_POINTS} points` : `points holds at most ${MAX_RECORDED_POINTS} points`);
  }
  return rawPoints.map(cleanPoint);
}

/** Whether the robot is running a playback right now (its points must not change under it). */
export function isPlaying(robot: any): boolean {
  const state = robot?.playbackState;
  return state?.isPlaying === true || state?.playing === true;
}

const numberIn = (value: unknown, min: number, max: number): value is number => finite(value) && value >= min && value <= max;

export interface EditContext {
  /** The robot the command is for. */
  robot: any;
  /** The ids of every robot of the same controller (a combination only holds robots that exist). */
  siblingIds: readonly number[];
}

/**
 * Checks one edit command against the robot and says what it would change, without changing anything.
 * The caller applies `patch` (a shallow top-level replacement, the shape every client merges) to the robot.
 */
export function planRobotEdit(command: string, params: unknown, ctx: EditContext): EditPlan | EditFailure {
  const p = isObject(params) ? params : {};
  const { robot } = ctx;
  switch (command) {
    case "points": {
      if (isPlaying(robot)) return fail("the robot is playing: stop it before changing its points", "robot-running", 409);
      let points: Record<string, number | string>[];
      try {
        points = cleanPoints(p.points, 0);
      } catch (error) {
        return fail(error instanceof Error ? error.message : "invalid points", "invalid-points");
      }
      return { ok: true, patch: { recordedPoints: points } };
    }
    case "loop": {
      if (typeof p.value !== "boolean") return fail("loop needs value: true or false", "invalid-loop");
      return { ok: true, patch: { playbackState: { ...(robot.playbackState ?? { isPlaying: false, activeStep: 0, speed: 100 }), isLooping: p.value } } };
    }
    case "model": {
      if (typeof p.model !== "string" || !MODEL_NAME.test(p.model.trim())) return fail("model must be a name of 1 to 64 letters, digits, spaces and . _ ( ) + - /", "invalid-model");
      if (isPlaying(robot)) return fail("the robot is playing: stop it before changing its model", "robot-running", 409);
      return { ok: true, patch: { model: p.model.trim() } };
    }
    case "role": {
      if (typeof p.role !== "string" || !ROBOT_ROLES.includes(p.role)) return fail(`role must be one of: ${ROBOT_ROLES.join(", ")}`, "invalid-role");
      return { ok: true, patch: { role: p.role } };
    }
    case "combine": {
      const ids = p.with;
      if (!Array.isArray(ids) || ids.length > MAX_COMBINED || !ids.every((id) => typeof id === "number" && Number.isInteger(id))) {
        return fail(`combine needs with: a list of at most ${MAX_COMBINED} robot ids`, "invalid-combine");
      }
      const unique = Array.from(new Set(ids as number[]));
      if (unique.includes(robot.id)) return fail("a robot cannot be combined with itself", "invalid-combine");
      const missing = unique.filter((id) => !ctx.siblingIds.includes(id));
      if (missing.length > 0) return fail(`robot(s) ${missing.join(", ")} do not exist in this controller`, "invalid-combine");
      return { ok: true, patch: { combinedWith: unique } };
    }
    case "joints": {
      const j = p.joints;
      if (!isObject(j) || !JOINT_KEYS.every((key) => numberIn(j[key], -MAX_JOINT_ABS, MAX_JOINT_ABS))) {
        return fail(`joints needs j1 to j6, each a finite number within +-${MAX_JOINT_ABS}`, "invalid-joints");
      }
      return { ok: true, patch: { joints: { j1: j.j1, j2: j.j2, j3: j.j3, j4: j.j4, j5: j.j5, j6: j.j6 } } };
    }
    case "xyTableConfig": {
      const next: Record<string, unknown> = { ...(isObject(robot.xyTable) ? robot.xyTable : {}) };
      const patch: Record<string, unknown> = {};
      let touched = false;
      if (p.enabled !== undefined) {
        if (typeof p.enabled !== "boolean") return fail("enabled must be true or false", "invalid-table");
        patch.hasXYTable = p.enabled;
        touched = true;
      }
      if (p.tableSize !== undefined) {
        const s = p.tableSize;
        if (!isObject(s) || !numberIn(s.width, 1, 5000) || !numberIn(s.length, 1, 5000)) return fail("tableSize needs width and length between 1 and 5000", "invalid-table");
        next.tableSize = { width: s.width, length: s.length };
        touched = true;
      }
      if (p.worldPos !== undefined) {
        const w = p.worldPos;
        if (!isObject(w) || !numberIn(w.x, -100000, 100000) || !numberIn(w.y, -100000, 100000)) return fail("worldPos needs x and y within +-100000", "invalid-table");
        next.worldPos = { x: w.x, y: w.y };
        touched = true;
      }
      if (p.worldRot !== undefined) {
        if (!numberIn(p.worldRot, -3600, 3600)) return fail("worldRot must be a number within +-3600", "invalid-table");
        next.worldRot = p.worldRot;
        touched = true;
      }
      if (p.renderScale !== undefined) {
        if (!numberIn(p.renderScale, 0.01, 100)) return fail("renderScale must be between 0.01 and 100", "invalid-table");
        next.renderScale = p.renderScale;
        touched = true;
      }
      if (!touched) return fail("xyTableConfig needs at least one of enabled, tableSize, worldPos, worldRot, renderScale", "invalid-table");
      if (!isObject(next.pos)) next.pos = { x: 0, y: 0 };
      // The full object, never a part of it: a client merges a patch one level deep and would lose the rest.
      patch.xyTable = next;
      return { ok: true, patch };
    }
    default:
      return fail("unknown command", "unknown-command");
  }
}

/** The ids a command touches beyond its own robot: a combination is checked against the old and the new group. */
export function editAffectedIds(command: string, robot: any, params: unknown): number[] {
  if (command !== "combine") return [robot.id];
  const next = isObject(params) && Array.isArray(params.with) ? (params.with as unknown[]).filter((id): id is number => typeof id === "number") : [];
  return Array.from(new Set([robot.id, ...(robot.combinedWith ?? []), ...next]));
}
