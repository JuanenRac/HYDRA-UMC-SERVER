// =============================================================================
// HYDRA-UMC-SERVER - src/routes/updateRoutes.ts
// Copyright (C) 2026 JuanenRac (Electro Hobby 3D) <electrohobby3d@gmail.com>
// GPL-3.0-or-later - see LICENSE
// =============================================================================
// GET /api/admin/updates: what is installed here set against the newest published version of each program (src/updateCheck.ts). An
// administrator only, and off by default (updateCheck.enabled): while it is off the route answers 404 and the server asks GitHub for nothing.
import express from "express";
import { apiRateLimiter } from "../auth";
import type { EcosystemProjectStatus } from "../ecosystemStatus";
import { UpdateChecker, type FetchLike, type UpdateCheckSettings } from "../updateCheck";

type Middleware = (req: any, res: any, next: any) => unknown;

export interface UpdateRouteDeps {
  authenticate: Middleware;
  requireAdmin: Middleware;
  enabled: () => boolean;
  getStatus: () => Promise<{ available: boolean; projects: EcosystemProjectStatus[] }>;
  config: () => UpdateCheckSettings | undefined;
  /** For tests: the way GitHub is asked. */
  fetch?: FetchLike;
  now?: () => number;
}

export function registerUpdateRoutes(app: express.Express, deps: UpdateRouteDeps): void {
  const { authenticate, requireAdmin } = deps;
  const checker = new UpdateChecker({
    projects: async () => (await deps.getStatus()).projects,
    settings: deps.config,
    fetch: deps.fetch,
    now: deps.now,
  });

  // `refresh=1` asks for a new look instead of the kept one (never more often than every ten minutes: the answer is the kept one until then).
  app.get("/api/admin/updates", apiRateLimiter, authenticate, requireAdmin, (req: any, res) => {
    if (!deps.enabled()) return res.status(404).json({ error: "Not found" });
    checker.report(req.query.refresh === "1").then(
      (report) => res.json(report),
      () => res.status(503).json({ error: "The newest versions could not be looked up" }),
    );
  });
}
