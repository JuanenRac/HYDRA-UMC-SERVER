// =============================================================================
// HYDRA-UMC-SERVER - src/routes/ecosystemHealthRoutes.ts
// Copyright (C) 2026 JuanenRac (Electro Hobby 3D) <electrohobby3d@gmail.com>
// GPL-3.0-or-later - see LICENSE
// =============================================================================
// GET /api/ecosystem/health: the health of the services of the ecosystem (src/ecosystemHealth.ts). Read only, for an operator or an
// administrator, and behind the switch ecosystemHealth.enabled (off by default: a signed-in client then gets 404, as if the route did not
// exist). An administrator also sees the port, health path and unit of each service; an operator sees none of them.
import express from "express";
import type { EcosystemHealthReport } from "../ecosystemHealth";

type Middleware = (req: any, res: any, next: any) => unknown;

export interface EcosystemHealthRouteDeps {
  authenticate: Middleware;
  requireOperator: Middleware;
  /** Answers 404 while the switch is off. */
  ecosystemHealthGate: Middleware;
  collect: (admin: boolean) => Promise<EcosystemHealthReport>;
}

/** The gate for the switch: a signed-in client gets 404 while it is off. */
export function makeEcosystemHealthGate(isEnabled: () => boolean): Middleware {
  return (_req, res, next) => {
    if (!isEnabled()) {
      res.status(404).end();
      return;
    }
    next();
  };
}

export function registerEcosystemHealthRoutes(app: express.Express, deps: EcosystemHealthRouteDeps): void {
  const { authenticate, requireOperator, ecosystemHealthGate, collect } = deps;
  // Requests that arrive while a scan is running share it instead of probing every service again.
  const running = new Map<boolean, Promise<EcosystemHealthReport>>();

  app.get("/api/ecosystem/health", authenticate, ecosystemHealthGate, requireOperator, async (req: any, res: any) => {
    const admin = req.user?.role === "admin";
    let scan = running.get(admin);
    if (!scan) {
      scan = collect(admin).finally(() => running.delete(admin));
      running.set(admin, scan);
    }
    try {
      res.json(await scan);
    } catch {
      res.status(503).json({ error: "The health of the ecosystem could not be read." });
    }
  });
}
