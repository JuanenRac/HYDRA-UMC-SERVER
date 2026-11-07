// =============================================================================
// HYDRA-UMC-SERVER - src/atcReset.ts
// Copyright (C) 2026 JuanenRac (Electro Hobby 3D) <electrohobby3d@gmail.com>
// GPL-3.0-or-later - see LICENSE
// =============================================================================
// The reset of the arm state of one URTC tool changer (POST /api/tool-arms/reset). The reset puts back the arm state the tool changer reports and moves
// nothing mechanical, and it is accepted only while the robot is stopped and disarmed. This module holds the two pure checks: the shape of the request
// (the robot, the tool and the robot id typed again as the confirmation) and the decision from the arm state of the tools and the motion of the robot.
// A state that cannot be read, a stale report and a robot that cannot be matched are all a refusal: the reset never goes ahead on a guess.

export const ROBOT_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
export const MAX_TOOL_ID = 24;

export interface ResetRequest {
  robot: string;
  toolId: number;
}

export type ResetRequestResult = { ok: true; request: ResetRequest } | { ok: false; status: 400; error: string; code?: "CONFIRMATION_MISMATCH" };

/** The request: exactly `robot`, `toolId` and `confirm`, where `confirm` repeats the robot id as typed by the person. */
export function parseResetRequest(body: unknown): ResetRequestResult {
  if (!body || typeof body !== "object" || Array.isArray(body)) return { ok: false, status: 400, error: "The body must be a JSON object with robot, toolId and confirm" };
  const input = body as Record<string, unknown>;
  const keys = Object.keys(input);
  if (keys.some((key) => key !== "robot" && key !== "toolId" && key !== "confirm") || keys.length !== 3) {
    return { ok: false, status: 400, error: "The body must have exactly robot, toolId and confirm" };
  }
  if (typeof input.robot !== "string" || !ROBOT_ID.test(input.robot)) return { ok: false, status: 400, error: "robot must be a robot id of letters, digits and . _ : - (1 to 64 characters)" };
  if (typeof input.toolId !== "number" || !Number.isInteger(input.toolId) || input.toolId < 0 || input.toolId > MAX_TOOL_ID) return { ok: false, status: 400, error: `toolId must be a whole number from 0 to ${MAX_TOOL_ID}` };
  if (typeof input.confirm !== "string" || input.confirm !== input.robot) {
    return { ok: false, status: 400, error: "confirm must repeat the robot id exactly as typed", code: "CONFIRMATION_MISMATCH" };
  }
  return { ok: true, request: { robot: input.robot, toolId: input.toolId } };
}

export type RobotMotion = "stopped" | "moving" | "unknown";

export interface ArmEntry { robot: string; toolId: number; armed: boolean; stale: boolean }

export type ResetDecision = { ok: true } | { ok: false; reason: "no_report" | "tool_not_reported" | "report_stale" | "armed" | "moving" | "motion_unknown" };

/**
 * May the reset go ahead? Only when the safety zones service has a fresh report for that tool saying it is disarmed, no other tool of the same robot
 * is armed or reported stale (an old report is never taken as safe), and the robot is known to be stopped.
 */
export function decideReset(arms: ArmEntry[] | null, request: ResetRequest, motion: RobotMotion): ResetDecision {
  if (arms === null) return { ok: false, reason: "no_report" };
  const ofRobot = arms.filter((arm) => arm.robot === request.robot);
  const tool = ofRobot.find((arm) => arm.toolId === request.toolId);
  if (!tool) return { ok: false, reason: "tool_not_reported" };
  if (ofRobot.some((arm) => arm.armed && !arm.stale)) return { ok: false, reason: "armed" };
  if (ofRobot.some((arm) => arm.stale)) return { ok: false, reason: ofRobot.some((arm) => arm.armed) ? "armed" : "report_stale" };
  if (motion === "moving") return { ok: false, reason: "moving" };
  if (motion !== "stopped") return { ok: false, reason: "motion_unknown" };
  return { ok: true };
}

const REASON_TEXT: Record<Exclude<ResetDecision, { ok: true }>["reason"], string> = {
  no_report: "The arm state of the tools could not be read, so nothing was reset",
  tool_not_reported: "That tool has not reported its arm state, so nothing was reset",
  report_stale: "A report of this robot is out of date, so nothing was reset",
  armed: "A tool of this robot is armed (or reported armed and is now out of date); disarm it first",
  moving: "The robot is moving; stop it first",
  motion_unknown: "It could not be told whether the robot is stopped, so nothing was reset",
};

export const resetRefusalText = (reason: keyof typeof REASON_TEXT): string => REASON_TEXT[reason];

/** The arm state in the answer of the safety zones service, keeping only what the check reads; null when the answer does not have the shape. */
export function armEntriesFrom(payload: unknown): ArmEntry[] | null {
  if (!payload || typeof payload !== "object") return null;
  const arms = (payload as { arms?: unknown }).arms;
  if (!Array.isArray(arms)) return null;
  const entries: ArmEntry[] = [];
  for (const item of arms) {
    if (!item || typeof item !== "object") return null;
    const arm = item as Record<string, unknown>;
    if (typeof arm.robot !== "string" || typeof arm.toolId !== "number" || typeof arm.armed !== "boolean" || typeof arm.stale !== "boolean") return null;
    entries.push({ robot: arm.robot, toolId: arm.toolId, armed: arm.armed, stale: arm.stale });
  }
  return entries;
}

/** The motion of a robot as the server knows it, looked up by the robot id of the arm report (the number of the robot or its name). */
export function robotMotionOf(getSettings: () => any): (robot: string) => RobotMotion {
  return (robot) => {
    const matches: any[] = [];
    for (const controller of getSettings()?.controllers ?? []) {
      for (const candidate of controller?.robots ?? []) {
        if (candidate && (String(candidate.id) === robot || (typeof candidate.name === "string" && candidate.name === robot))) matches.push(candidate);
      }
    }
    if (matches.length !== 1) return "unknown"; // no robot of that id, or two: never a guess
    const playback = matches[0].playbackState ?? {};
    // a running or a paused trajectory is a robot that is not stopped
    return playback.isPlaying === true || playback.playing === true || playback.isPaused === true || playback.paused === true ? "moving" : "stopped";
  };
}
