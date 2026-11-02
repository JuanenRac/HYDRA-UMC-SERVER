// =============================================================================
// HYDRA-UMC-SERVER - src/modelHome.ts
// Copyright (C) 2026 JuanenRac (Electro Hobby 3D) <electrohobby3d@gmail.com>
// GPL-3.0-or-later - see LICENSE
// =============================================================================
// The home pose of each robot model and the range of each of its joints, from the one table the
// control programs share (src/data/kinematicData.json: the same file as the one of HYDRA-UMC-STUDIO
// and HYDRA-UMC-SUITE). The HOME / RESET command of a robot goes to the pose of ITS model, never to
// a formula that fits only the generic robot, and is refused when that pose, or one a client asks
// for, lies outside the range of the joints.
import kinematicData from "./data/kinematicData.json";
import type { Joints } from "./kinematics";

export const JOINT_NAMES = ["j1", "j2", "j3", "j4", "j5", "j6"] as const;
type JointName = (typeof JOINT_NAMES)[number];

/** The pose of a model not listed in the table (the same one the control programs use). */
export const GENERIC_HOME: Joints = { j1: 0, j2: -45, j3: 45, j4: 0, j5: 90, j6: 0 };
const GENERIC_RANGE: [number, number] = [-180, 180];

interface Entry { limits: Record<JointName, [number, number]>; home: Joints }
const MODELS = (kinematicData as unknown as { models: Record<string, Entry> }).models;

/** "Parol6 (6-DOF)" and "parol6 (6-dof)" name the same model. */
const key = (model: unknown): string => String(model ?? "").trim().toLowerCase();
const BY_KEY = new Map<string, Entry>(Object.entries(MODELS).map(([name, entry]) => [key(name), entry]));

export interface ModelHome {
  /** True when the model is in the shared table (false: the generic pose and range). */
  listed: boolean;
  joints: Joints;
  limits: Record<JointName, [number, number]>;
}

export function homeFor(model: unknown): ModelHome {
  const entry = BY_KEY.get(key(model));
  if (entry) return { listed: true, joints: { ...entry.home }, limits: entry.limits };
  const limits = Object.fromEntries(JOINT_NAMES.map((j) => [j, GENERIC_RANGE])) as Record<JointName, [number, number]>;
  return { listed: false, joints: { ...GENERIC_HOME }, limits };
}

/** The first joint of `joints` that is not a finite number inside its range (null when all are). */
export function jointOutOfRange(joints: Joints, limits: Record<JointName, [number, number]>): JointName | null {
  for (const name of JOINT_NAMES) {
    const value = joints[name];
    const [low, high] = limits[name];
    if (typeof value !== "number" || !Number.isFinite(value) || value < low || value > high) return name;
  }
  return null;
}

export type HomeVerdict =
  | { ok: true; joints: Joints }
  | { ok: false; status: 400 | 422; code: "home-pose-mismatch" | "home-out-of-limits"; error: string };

/**
 * What a reset of the arm may do for `model`: the joints are always those of the model's home pose.
 * A client that sends its own joints is only accepted when they are that pose (a client with another
 * table, or a damaged request, is told so instead of moving the robot somewhere else).
 */
export function resolveHome(model: unknown, sent: unknown): HomeVerdict {
  const home = homeFor(model);
  const bad = jointOutOfRange(home.joints, home.limits);
  if (bad) return { ok: false, status: 422, code: "home-out-of-limits", error: `the home pose of this model has ${bad} outside its range: the robot was not moved` };
  if (sent === undefined || sent === null) return { ok: true, joints: home.joints };
  if (typeof sent !== "object" || Array.isArray(sent)) return { ok: false, status: 400, code: "home-pose-mismatch", error: "joints must be an object with j1 to j6" };
  const asked = sent as Record<string, unknown>;
  for (const name of JOINT_NAMES) {
    const value = asked[name];
    if (typeof value !== "number" || !Number.isFinite(value)) return { ok: false, status: 400, code: "home-pose-mismatch", error: "joints must hold six finite numbers (j1 to j6)" };
  }
  const outside = jointOutOfRange(asked as unknown as Joints, home.limits);
  if (outside) return { ok: false, status: 422, code: "home-out-of-limits", error: `the pose asked for has ${outside} outside the range of this model: the robot was not moved` };
  for (const name of JOINT_NAMES) {
    if (Math.abs((asked[name] as number) - home.joints[name]) > 0.01) {
      return { ok: false, status: 400, code: "home-pose-mismatch", error: "the pose asked for is not the home pose of this model: the robot was not moved" };
    }
  }
  return { ok: true, joints: home.joints };
}
