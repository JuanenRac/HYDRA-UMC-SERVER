// =============================================================================
// HYDRA-UMC-SERVER - src/routes/safetyRoutes.ts
// Copyright (C) 2026 JuanenRac (Electro Hobby 3D) <electrohobby3d@gmail.com>
// GPL-3.0-or-later - see LICENSE
// =============================================================================
// The safety limits every client is held to (read by any signed-in client, changed by an
// administrator), the explicit arming of the jog, and the list of who controls which robot.
import express from "express";
import { readControllerId, claimConflict } from "../claimPolicy";
import { HARD_LIMITS, SafetyLimitsError, defaultSafetyConfig, type JogArming, type SafetyLimits } from "../safetyLimits";

type Middleware = (req: any, res: any, next: any) => unknown;

export interface SafetyRouteDeps {
  authenticate: Middleware;
  requireAdmin: Middleware;
  getSettings: () => any;
  findRobotById: (robotId: number) => any;
  isReservationActive: (reservation: any) => boolean;
  safety: SafetyLimits;
  arming: JogArming;
}

export function registerSafetyRoutes(app: express.Express, deps: SafetyRouteDeps): void {
  const { authenticate, requireAdmin, getSettings, findRobotById, isReservationActive, safety, arming } = deps;

  const view = (robotId?: number) => {
    const robot = robotId !== undefined ? findRobotById(robotId) : null;
    return {
      limits: safety.get(),
      defaults: defaultSafetyConfig(),
      hardLimits: HARD_LIMITS,
      ...(robot ? { robot: { id: robot.id, model: robot.model ?? null, jog: safety.jogFor(robot.model), temperature: safety.temperatureFor(robot.model), jogArmedUntil: arming.expiresAt(robot.id) } } : {}),
    };
  };

  // Every client reads the same limits here instead of keeping its own copy.
  app.get("/api/safety-limits", authenticate, (req, res) => {
    const raw = req.query.robotId;
    const robotId = raw === undefined ? undefined : parseInt(String(raw), 10);
    if (robotId !== undefined && !Number.isInteger(robotId)) return res.status(400).json({ error: "robotId must be an integer" });
    if (robotId !== undefined && !findRobotById(robotId)) return res.status(404).json({ error: "Robot not found" });
    res.json(view(robotId));
  });

  app.put("/api/admin/safety-limits", authenticate, requireAdmin, async (req, res) => {
    try {
      await safety.update(req.body, String((req as any).user?.username ?? "admin"));
    } catch (error) {
      if (error instanceof SafetyLimitsError) return res.status(400).json({ error: error.message });
      throw error;
    }
    res.json({ success: true, ...view() });
  });

  // The explicit arming of the jog. It is always available; it is only demanded while jog.armRequired is on.
  app.post("/api/robot/:id/jog-arm", authenticate, (req, res) => {
    const robotId = parseInt(req.params.id, 10);
    const robot = findRobotById(robotId);
    if (!robot) return res.status(404).json({ error: "Robot not found" });
    const user = (req as any).user;
    const controllerId = readControllerId(req.headers?.["x-controller-id"], req.body?.controllerId);
    if (controllerId === null) return res.status(400).json({ error: "controllerId must be 1 to 64 characters: letters, digits, . _ : -", code: "invalid-controller-id" });
    if (typeof req.body?.armed !== "boolean") return res.status(400).json({ error: "armed must be true or false" });
    if (!req.body.armed) {
      arming.disarm(robotId);
      return res.json({ success: true, armed: false });
    }
    const conflict = claimConflict(robot.reservation, user, controllerId, isReservationActive);
    if (conflict) return res.status(409).json({ error: conflict.message, code: conflict.reason, reservation: robot.reservation });
    const limits = safety.get().jog;
    const requested = typeof req.body.ttlMs === "number" && Number.isFinite(req.body.ttlMs) ? req.body.ttlMs : limits.armTtlMs;
    const ttlMs = Math.min(Math.max(requested, HARD_LIMITS.armTtlMs.min), limits.armTtlMs);
    const expiresAt = arming.arm(robotId, user.id, controllerId, ttlMs);
    res.json({ success: true, armed: true, expiresAt, ttlMs });
  });

  // Who controls which robot, for every robot that has an active claim.
  app.get("/api/claims", authenticate, (req, res) => {
    const claims: unknown[] = [];
    for (const cell of getSettings().controllers ?? []) {
      for (const robot of cell.robots ?? []) {
        if (!isReservationActive(robot.reservation)) continue;
        claims.push({
          robotId: robot.id,
          robotName: robot.name ?? null,
          cellId: cell.id,
          ownerId: robot.reservation.ownerId,
          ownerUsername: robot.reservation.ownerUsername,
          controllerId: robot.reservation.controllerId ?? null,
          claimedAt: robot.reservation.claimedAt,
          expiresAt: robot.reservation.expiresAt,
        });
      }
    }
    res.json({ claims });
  });
}
