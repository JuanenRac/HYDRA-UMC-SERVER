// =============================================================================
// HYDRA-UMC-SERVER - src/tableCommand.ts
// Copyright (C) 2026 JuanenRac (Electro Hobby 3D) <electrohobby3d@gmail.com>
// GPL-3.0-or-later - see LICENSE
// =============================================================================
// The "table" command: one move of the XY table of a robot in one request, instead of one jog per
// axis. params = { x, y, rz?, mode: "absolute" | "relative" } (mode defaults to "absolute"). The
// whole move is checked before anything is changed, against the same limits as a jog: a relative
// move may not exceed the largest jog of the model, and the position the move ends in may not
// exceed the largest absolute position. Either all of it is applied or none of it.

export interface TableLimits {
  maxAmount: number;
  maxAbsolute: number;
}

export type TablePlan =
  | { ok: true; mode: "absolute" | "relative"; x: number; y: number; rz?: number }
  | { ok: false; error: string; code: "table-invalid" | "table-out-of-limit" | "table-missing" };

const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

/** Checks a table move against the robot and the limits; gives the position the table ends in. */
export function planTableMove(robot: any, params: any, limits: TableLimits): TablePlan {
  if (!robot?.hasXYTable || !robot?.xyTable?.pos) {
    return { ok: false, error: "the table command requires a configured XY table", code: "table-missing" };
  }
  const mode = params?.mode === undefined ? "absolute" : params.mode;
  if (mode !== "absolute" && mode !== "relative") {
    return { ok: false, error: "mode must be \"absolute\" or \"relative\"", code: "table-invalid" };
  }
  if (!finite(params?.x) || !finite(params?.y)) {
    return { ok: false, error: "x and y must be finite numbers", code: "table-invalid" };
  }
  if (params.rz !== undefined && !finite(params.rz)) {
    return { ok: false, error: "rz must be a finite number", code: "table-invalid" };
  }
  const requested: Record<string, number> = { x: params.x, y: params.y };
  if (params.rz !== undefined) requested.rz = params.rz;
  const largestStep = mode === "relative" ? limits.maxAmount : limits.maxAbsolute;
  for (const [axis, value] of Object.entries(requested)) {
    if (Math.abs(value) > largestStep) {
      return { ok: false, error: `${axis} ${value} is outside +-${largestStep} for a ${mode} table move on this model`, code: "table-out-of-limit" };
    }
  }
  const currentX = finite(robot.xyTable.pos.x) ? robot.xyTable.pos.x : 0;
  const currentY = finite(robot.xyTable.pos.y) ? robot.xyTable.pos.y : 0;
  const currentRz = finite(robot.pos?.trz) ? robot.pos.trz : 0;
  const x = mode === "relative" ? currentX + params.x : params.x;
  const y = mode === "relative" ? currentY + params.y : params.y;
  const rz = params.rz === undefined ? undefined : (mode === "relative" ? currentRz + params.rz : params.rz);
  for (const [axis, value] of [["x", x], ["y", y], ["rz", rz]] as const) {
    if (value !== undefined && Math.abs(value) > limits.maxAbsolute) {
      return { ok: false, error: `the table would end at ${axis} ${value}, outside +-${limits.maxAbsolute} for this model`, code: "table-out-of-limit" };
    }
  }
  return { ok: true, mode, x, y, ...(rz !== undefined ? { rz } : {}) };
}

/** Applies a plan produced by planTableMove to the robot (in place); gives the patch to broadcast. */
export function applyTableMove(robot: any, plan: Extract<TablePlan, { ok: true }>): Record<string, unknown> {
  robot.xyTable.pos = { ...robot.xyTable.pos, x: plan.x, y: plan.y };
  robot.pos = { ...(robot.pos ?? {}), tx: plan.x, ty: plan.y, ...(plan.rz !== undefined ? { trz: plan.rz } : {}) };
  return { xyTable: robot.xyTable, pos: robot.pos };
}
