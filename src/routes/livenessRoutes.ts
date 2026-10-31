// =============================================================================
// HYDRA-UMC-SERVER - src/routes/livenessRoutes.ts
// Copyright (C) 2026 JuanenRac (Electro Hobby 3D) <electrohobby3d@gmail.com>
// GPL-3.0-or-later - see LICENSE
// =============================================================================
// The signal of life of each robot of the roster (src/robotLiveness.ts): GET /api/robots/liveness for any signed-in account, and
// POST /api/robot/:id/heartbeat for the bridge or controller that has real news of a robot (operator or administrator).
import express from "express";
import { RobotLivenessTracker, staleAfterFrom } from "../robotLiveness";

type Middleware = (req: any, res: any, next: any) => unknown;

export interface LivenessRouteDeps {
  authenticate: Middleware;
  requireOperator: Middleware;
  getSettings: () => any;
  tracker: RobotLivenessTracker;
  /** The configured stale limit in seconds (data/server-config.json, liveness.staleAfterS); anything invalid gives the default. */
  staleAfterS: () => unknown;
}

export function registerLivenessRoutes(app: express.Express, deps: LivenessRouteDeps): void {
  const { authenticate, requireOperator, getSettings, tracker } = deps;

  app.get("/api/robots/liveness", authenticate, (req: any, res: any) => {
    res.json(tracker.report(getSettings(), staleAfterFrom(deps.staleAfterS())));
  });

  app.post("/api/robot/:id/heartbeat", authenticate, requireOperator, (req: any, res: any) => {
    const robotId = Number(req.params.id);
    const known = (Array.isArray(getSettings()?.controllers) ? getSettings().controllers : []).some(
      (controller: any) => Array.isArray(controller?.robots) && controller.robots.some((robot: any) => robot?.id === robotId),
    );
    if (!Number.isInteger(robotId) || !known) return res.status(404).json({ error: "Robot not found" });
    tracker.touch(robotId, "heartbeat");
    res.json({ success: true });
  });
}
