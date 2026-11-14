// =============================================================================
// HYDRA-UMC-SERVER - src/routes/nodeHealthRoutes.ts
// Copyright (C) 2026 JuanenRac (Electro Hobby 3D) <electrohobby3d@gmail.com>
// GPL-3.0-or-later - see LICENSE
// =============================================================================
// GET /api/ecosystem/node-health?slot=N: the last health frame that the kinematic brain heard from the controller board in slot N (0 to 7), read from the SPI bridge of the
// CM5 (src/nodeHealth.ts). Read only, for an operator or an administrator, and behind the switch nodeHealth.enabled (off by default: a signed-in client then gets
// 404, as if the route did not exist). 400 for a slot that is not 0 to 7, 503 when the bridge is not configured or did not answer.
import type express from "express";
import type { NodeHealth } from "../nodeHealth";
import { parseSlot } from "../nodeHealth";

type Middleware = (req: any, res: any, next: any) => void;

export interface NodeHealthRouteDeps {
  authenticate: Middleware;
  requireOperator: Middleware;
  nodeHealthGate: Middleware;
  /** Reads one slot from the bridge; null when it could not. */
  fetchSlot: (slot: number) => Promise<NodeHealth | null>;
}

export function makeNodeHealthGate(isEnabled: () => boolean): Middleware {
  return (_req, res, next) => {
    if (!isEnabled()) {
      res.status(404).end();
      return;
    }
    next();
  };
}

export function registerNodeHealthRoutes(app: express.Express, deps: NodeHealthRouteDeps): void {
  const { authenticate, requireOperator, nodeHealthGate, fetchSlot } = deps;
  app.get("/api/ecosystem/node-health", authenticate, nodeHealthGate, requireOperator, async (req: any, res: any) => {
    const slot = parseSlot(req.query?.slot);
    if (slot === null) {
      res.status(400).json({ error: "slot must be a whole number from 0 to 7" });
      return;
    }
    const health = await fetchSlot(slot);
    if (health === null) {
      res.status(503).json({ error: "The health of the board could not be read from the SPI bridge." });
      return;
    }
    res.json(health);
  });
}
