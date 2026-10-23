// =============================================================================
// HYDRA-UMC-SERVER - src/routes/robotRoutes.ts
// Copyright (C) 2026 JuanenRac (Electro Hobby 3D) <electrohobby3d@gmail.com>
// GPL-3.0 - see LICENSE
// =============================================================================
// The /api/robot/:id/claim and /api/robot/:id/release routes, moved out of
// server.ts unchanged. The settings object is reassigned inside startServer(),
// so it is passed as a getter that is read at the moment of use, exactly as
// the inline version read the variable.
import express from "express";
import { claimConflict, readControllerId } from "../claimPolicy";
import type { JogArming, SafetyLimits } from "../safetyLimits";
import type { AuditLog } from "../auditLog";
import { ifMatchAgrees, robotRevision, redactSettingsSecrets } from "../serverPolicy";

type Middleware = (req: any, res: any, next: any) => unknown;

export interface RobotRouteDeps {
  authenticate: Middleware;
  getSettings: () => any;
  findRobotById: (robotId: number) => any;
  findControllerIdForRobot: (robotId: number) => string | null;
  isReservationActive: (reservation: any) => boolean;
  appendReservationHistory: (
    robot: any,
    action: "claimed" | "renewed" | "force-claimed" | "released" | "force-released" | "expired",
    byUserId: unknown,
    byUsername: unknown,
    reason?: string,
  ) => void;
  queueSettingsWrite: (payload: any) => Promise<void>;
  broadcastRobotDelta: (
    deltas: { controllerId: string; robotId: number; patch: Record<string, unknown>; cameraId?: number; cameraPatch?: Record<string, unknown> }[],
    fullPayload: any,
  ) => void;
  DEFAULT_RESERVATION_TTL_MS: number;
  MAX_RESERVATION_TTL_MS: number;
  /** The limits of the installation (claims may be required to name their controller). Optional so the routes work without them. */
  safety?: SafetyLimits;
  /** Releasing a robot also disarms its jog. */
  arming?: JogArming;
  /** The audit record of claims, releases and forced takeovers. */
  audit?: AuditLog;
  /** Called after a claim or a release changed who controls which robot (pushes the `claims` message of the WebSocket). */
  onClaimsChanged?: () => void;
}

export function registerRobotRoutes(app: express.Express, deps: RobotRouteDeps): void {
  const {
    authenticate,
    getSettings,
    findRobotById,
    findControllerIdForRobot,
    isReservationActive,
    appendReservationHistory,
    queueSettingsWrite,
    broadcastRobotDelta,
    DEFAULT_RESERVATION_TTL_MS,
    MAX_RESERVATION_TTL_MS,
    safety,
    arming,
    audit,
    onClaimsChanged,
  } = deps;

  /** 412 when the caller's If-Match does not agree with the robot as it is now; null when it may go on. */
  const staleRevision = (req: any, robot: any): { error: string; code: string; revision: string } | null => {
    const revision = robotRevision(robot);
    const header = typeof req.headers?.["if-match"] === "string" ? req.headers["if-match"] : undefined;
    return ifMatchAgrees(header, revision)
      ? null
      : { error: "the robot changed since you read it; read it again (GET /api/robot/:id) and retry", code: "revision-mismatch", revision };
  };

  // One robot with its revision (the ETag), so a client does not have to read the whole tree. The credentials of the cameras are an administrator's.
  app.get("/api/robot/:id", authenticate, (req, res) => {
    const robotId = parseInt(req.params.id, 10);
    const robot = findRobotById(robotId);
    if (!robot) return res.status(404).json({ error: "Robot not found" });
    const revision = robotRevision(robot);
    res.setHeader("ETag", `"${revision}"`);
    res.json({ robot: (req as any).user?.role === "admin" ? robot : redactSettingsSecrets(robot), revision, cellId: findControllerIdForRobot(robotId) });
  });

  // P06: claim exclusive command ownership of a robot. Real rules:
  // - No existing active claim, or the caller already holds it -> grant/
  //   refresh it (a caller re-claiming its own robot is how a real
  //   client renews its own TTL before it expires, not an error).
  // - An active claim held by someone else -> 409, unless the caller is
  //   an admin explicitly passing `force: true` (a real, deliberate
  //   override for "the previous operator walked away and left a robot
  //   locked" - never the default, and never available to a plain
  //   operator role).
  app.post("/api/robot/:id/claim", authenticate, async (req, res) => {
    const robotId = parseInt(req.params.id);
    const robot = findRobotById(robotId);
    if (!robot) {
      return res.status(404).json({ error: "Robot not found" });
    }
    const user = (req as any).user;
    const requestedTtlMs = typeof req.body?.ttlMs === "number" ? req.body.ttlMs : DEFAULT_RESERVATION_TTL_MS;
    const ttlMs = Math.min(Math.max(requestedTtlMs, 1000), MAX_RESERVATION_TTL_MS);
    const force = req.body?.force === true;
    // An optional, real reason recorded alongside who/when - never
    // required (every existing caller that never sends one still works
    // exactly as before), capped so one caller can't grow the bounded
    // history's stored payload unreasonably.
    const reason = typeof req.body?.reason === "string" && req.body.reason.trim() ? req.body.reason.trim().slice(0, 200) : undefined;

    // The controller (one client of the account) that claims; see src/claimPolicy.ts.
    const presented = readControllerId(req.headers?.["x-controller-id"], req.body?.controllerId);
    if (presented === null) {
      return res.status(400).json({ error: "controllerId must be 1 to 64 characters: letters, digits, . _ : -", code: "invalid-controller-id" });
    }
    if (presented === undefined && safety?.get().claims.requireControllerId) {
      return res.status(400).json({ error: "this server requires a controllerId to claim a robot", code: "controller-id-required" });
    }

    const stale = staleRevision(req, robot);
    if (stale) return res.status(412).json(stale);

    const existing = robot.reservation;
    const conflict = claimConflict(existing, user, presented, isReservationActive);
    const heldByAnother = conflict !== null;
    const who = { userId: user.id, username: user.username, controllerId: presented, ip: req.ip, robotId };
    if (conflict && !(force && user.role === "admin")) {
      audit?.record({ type: "claim", outcome: "refused", ...who, detail: { reason: conflict.reason, force } });
      return res.status(409).json({ error: conflict.message, code: conflict.reason, reservation: existing });
    }

    // Which kind of transition this really is depends on the
    // PREVIOUS state, not just the new claim being written below.
    let action: "claimed" | "renewed" | "force-claimed";
    if (heldByAnother) {
      // Only reachable via the admin force-override path above - someone
      // else's still-active claim is being forcibly superseded.
      action = "force-claimed";
    } else if (isReservationActive(existing) && existing.ownerId === user.id) {
      action = "renewed";
    } else {
      // No active claim right now - either genuinely never claimed, or a
      // previous one lapsed unnoticed. Record that lapse explicitly
      // before it's overwritten below, so the history can tell "nobody
      // ever claimed this" apart from "someone had it and let it expire",
      // not just show a fresh claim appearing out of nowhere.
      if (existing && !isReservationActive(existing)) {
        appendReservationHistory(robot, "expired", existing.ownerId, existing.ownerUsername);
      }
      action = "claimed";
    }

    robot.reservation = {
      ownerId: user.id,
      ownerUsername: user.username,
      claimedAt: Date.now(),
      expiresAt: Date.now() + ttlMs,
      ...(presented !== undefined ? { controllerId: presented } : {}),
    };
    appendReservationHistory(robot, action, user.id, user.username, reason);
    audit?.record({ type: action === "force-claimed" ? "force-claim" : "claim", outcome: "ok", ...who, detail: { action, ttlMs, ...(reason ? { reason } : {}), ...(heldByAnother ? { tookFrom: existing?.ownerUsername } : {}) } });
    const controllerId = findControllerIdForRobot(robotId);
    await queueSettingsWrite(getSettings());
    if (controllerId) {
      broadcastRobotDelta(
        [{ controllerId, robotId, patch: { reservation: robot.reservation, reservationHistory: robot.reservationHistory } }],
        getSettings(),
      );
    }
    onClaimsChanged?.();
    const revision = robotRevision(robot);
    res.setHeader("ETag", `"${revision}"`);
    res.json({ success: true, reservation: robot.reservation, reservationHistory: robot.reservationHistory, revision });
  });

  // P06: release a claim - only the current holder or an admin may do
  // this. Releasing an already-unclaimed (or expired) robot is a
  // successful no-op, not an error, matching this codebase's own
  // idempotent-mutation convention elsewhere (see e.g. mission.rs's
  // cancel() in HYDRA-UMC-ORCHESTRATOR for the same real reasoning).
  app.post("/api/robot/:id/release", authenticate, async (req, res) => {
    const robotId = parseInt(req.params.id);
    const robot = findRobotById(robotId);
    if (!robot) {
      return res.status(404).json({ error: "Robot not found" });
    }
    const user = (req as any).user;
    const presented = readControllerId(req.headers?.["x-controller-id"], req.body?.controllerId);
    if (presented === null) {
      return res.status(400).json({ error: "controllerId must be 1 to 64 characters: letters, digits, . _ : -", code: "invalid-controller-id" });
    }
    const stale = staleRevision(req, robot);
    if (stale) return res.status(412).json(stale);
    const conflict = claimConflict(robot.reservation, user, presented, isReservationActive);
    const who = { userId: user.id, username: user.username, controllerId: presented, ip: req.ip, robotId };
    if (conflict && user.role !== "admin") {
      audit?.record({ type: "release", outcome: "refused", ...who, detail: { reason: conflict.reason } });
      return res.status(409).json({ error: conflict.message, code: conflict.reason, reservation: robot.reservation });
    }
    const reason = typeof req.body?.reason === "string" && req.body.reason.trim() ? req.body.reason.trim().slice(0, 200) : undefined;
    if (robot.reservation) {
      if (isReservationActive(robot.reservation)) {
        // A real active claim is genuinely being released here -
        // distinguish the holder releasing their own claim from an admin
        // force-releasing someone else's, same real distinction claim
        // already makes for "claimed" vs "force-claimed".
        const releasedByOwner = robot.reservation.ownerId === user.id && !conflict;
        appendReservationHistory(robot, releasedByOwner ? "released" : "force-released", user.id, user.username, reason);
        audit?.record({
          type: releasedByOwner ? "release" : "force-release", outcome: "ok", ...who,
          detail: { ...(reason ? { reason } : {}), ...(releasedByOwner ? {} : { releasedFrom: robot.reservation.ownerUsername }) },
        });
      } else {
        // Idempotent cleanup of an already-lapsed reservation - nobody's
        // active claim was actually released, so this is really the same
        // "expired" transition claim's own lazy-expiry detection records,
        // not a new released/force-released event.
        appendReservationHistory(robot, "expired", robot.reservation.ownerId, robot.reservation.ownerUsername);
      }
    }
    robot.reservation = null;
    arming?.disarm(robotId);
    const controllerId = findControllerIdForRobot(robotId);
    await queueSettingsWrite(getSettings());
    if (controllerId) {
      broadcastRobotDelta(
        [{ controllerId, robotId, patch: { reservation: null, reservationHistory: robot.reservationHistory } }],
        getSettings(),
      );
    }
    onClaimsChanged?.();
    const revision = robotRevision(robot);
    res.setHeader("ETag", `"${revision}"`);
    res.json({ success: true, reservationHistory: robot.reservationHistory, revision });
  });
}
