// =============================================================================
// HYDRA-UMC-SERVER - src/routes/maintenanceRoutes.ts
// Copyright (C) 2026 JuanenRac (Electro Hobby 3D) <electrohobby3d@gmail.com>
// GPL-3.0-or-later - see LICENSE
// =============================================================================
// /api/admin/maintenance: status, install, rollback and prune of the releases of the programs installed here (src/maintenance.ts). An administrator
// only; off by default (maintenance.enabled): while it is off every route answers 404 and nothing is run. Install, rollback and prune change the
// machine, so each needs `confirm: true` and each is written to the audit log whatever its result.
import express from "express";
import type { AuditEvent } from "../auditLog";
import { apiRateLimiter } from "../auth";
import { Maintenance, MaintenanceError, type MaintenanceAction } from "../maintenance";

type Middleware = (req: any, res: any, next: any) => unknown;

export interface MaintenanceRouteDeps {
  authenticate: Middleware;
  requireAdmin: Middleware;
  enabled: () => boolean;
  maintenance: Maintenance;
  audit?: { record: (event: AuditEvent) => unknown };
}

export function registerMaintenanceRoutes(app: express.Express, deps: MaintenanceRouteDeps): void {
  const { authenticate, requireAdmin, maintenance, audit } = deps;
  const gate: Middleware = (_req, res, next) => (deps.enabled() ? next() : res.status(404).json({ error: "Not found" }));

  // One answer for the four routes: 200 with what the tool printed, 502 when the tool ran and failed, 400/404/409 when the request was refused before it ran.
  const respond = async (action: MaintenanceAction, body: Record<string, unknown>, req: any, res: express.Response) => {
    const changes = action !== "status";
    if (changes && body.confirm !== true) return res.status(400).json({ error: `${action} needs confirm: true` });
    const detail = { action, component: typeof body.component === "string" ? body.component : undefined, package: typeof body.package === "string" ? body.package : undefined };
    try {
      const outcome = await maintenance.run(action, body);
      if (changes) audit?.record({ type: "maintenance-run", outcome: outcome.ok ? "ok" : "failed", userId: req.user?.id, username: req.user?.username, ip: req.ip, detail: { ...detail, exit_code: outcome.exitCode, timed_out: outcome.timedOut } });
      return res.status(outcome.ok ? 200 : 502).json(outcome);
    } catch (error) {
      if (error instanceof MaintenanceError) {
        if (changes) audit?.record({ type: "maintenance-run", outcome: "refused", userId: req.user?.id, username: req.user?.username, ip: req.ip, detail: { ...detail, reason: error.message } });
        return res.status(error.status).json({ error: error.message });
      }
      throw error;
    }
  };
  const bodyOf = (req: any): Record<string, unknown> => (req.body && typeof req.body === "object" && !Array.isArray(req.body) ? req.body : {});

  app.get("/api/admin/maintenance/status", apiRateLimiter, authenticate, requireAdmin, gate, (req: any, res) => {
    return respond("status", req.query.component === undefined ? {} : { component: req.query.component }, req, res);
  });
  app.post("/api/admin/maintenance/install", apiRateLimiter, authenticate, requireAdmin, gate, (req: any, res) => {
    return respond("install", bodyOf(req), req, res);
  });
  app.post("/api/admin/maintenance/rollback", apiRateLimiter, authenticate, requireAdmin, gate, (req: any, res) => {
    return respond("rollback", bodyOf(req), req, res);
  });
  app.post("/api/admin/maintenance/prune", apiRateLimiter, authenticate, requireAdmin, gate, (req: any, res) => {
    return respond("prune", bodyOf(req), req, res);
  });
}
