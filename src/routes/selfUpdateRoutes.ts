// =============================================================================
// HYDRA-UMC-SERVER - src/routes/selfUpdateRoutes.ts
// Copyright (C) 2026 JuanenRac (Electro Hobby 3D) <electrohobby3d@gmail.com>
// GPL-3.0-or-later - see LICENSE
// =============================================================================
// /api/admin/self-update: the programs of this machine against the newest signed release of each, and the update of one of them, step by step (src/selfUpdate.ts).
// Two switches, both off by default and both answering 404 while off: the look at GitHub is `updateCheck.enabled` (reading only), and applying or going back is
// `maintenance.enabled` (the same switch as the maintenance routes, which run the same deploy tool). Applying and going back are for an administrator, need
// `confirm: true`, take one job at a time and are written to the audit log whatever their result.
import express from "express";
import type { AuditEvent } from "../auditLog";
import { apiRateLimiter } from "../auth";
import { SelfUpdate, SelfUpdateError, type SelfUpdateAction } from "../selfUpdate";

type Middleware = (req: any, res: any, next: any) => unknown;

export interface SelfUpdateRouteDeps {
  authenticate: Middleware;
  requireAdmin: Middleware;
  /** Whether the look at the newest releases is on (updateCheck.enabled). */
  lookEnabled: () => boolean;
  /** Whether applying and going back are on (maintenance.enabled). */
  applyEnabled: () => boolean;
  selfUpdate: SelfUpdate;
  audit?: { record: (event: AuditEvent) => unknown };
}

export function registerSelfUpdateRoutes(app: express.Express, deps: SelfUpdateRouteDeps): void {
  const { authenticate, requireAdmin, selfUpdate, audit } = deps;
  const lookGate: Middleware = (_req, res, next) => (deps.lookEnabled() ? next() : res.status(404).json({ error: "Not found" }));
  const applyGate: Middleware = (_req, res, next) => (deps.applyEnabled() ? next() : res.status(404).json({ error: "Not found" }));
  const bodyOf = (req: any): Record<string, unknown> => (req.body && typeof req.body === "object" && !Array.isArray(req.body) ? req.body : {});

  // What is installed against the newest signed release of each program, whether applying is switched on, and the job that is going on or the last one.
  // `refresh=1` looks again (never more than once a minute: the answer is the kept one until then).
  app.get("/api/admin/self-update", apiRateLimiter, authenticate, requireAdmin, lookGate, (req: any, res) => {
    Promise.all([selfUpdate.report(req.query.refresh === "1"), selfUpdate.current()]).then(
      ([report, job]) => res.json({ ...report, applyEnabled: deps.applyEnabled(), job }),
      () => res.status(503).json({ error: "The newest versions could not be looked up" }),
    );
  });

  // The progress of a job. The server may restart in the middle of an update: the job is on disk and this answers again as soon as the new process is up.
  app.get("/api/admin/self-update/jobs/:id", apiRateLimiter, authenticate, requireAdmin, lookGate, (req: any, res) => {
    selfUpdate.current(String(req.params.id)).then(
      (job) => (job ? res.json(job) : res.status(404).json({ error: "No such job" })),
      () => res.status(503).json({ error: "The job could not be read" }),
    );
  });

  // One answer for the two routes: 200 with the job that has just started, 400 for a request without the confirmation or with a program that is not one of the three, 409 for a second job at a time or no earlier release.
  const begin = async (action: SelfUpdateAction, req: any, res: express.Response) => {
    const body = bodyOf(req);
    const detail = { action, component: typeof body.component === "string" ? body.component : undefined };
    if (body.confirm !== true) return res.status(400).json({ error: `${action} needs confirm: true` });
    try {
      const job = await selfUpdate.start(action, body.component, String(req.user?.username ?? ""));
      audit?.record({ type: "self-update", outcome: "ok", userId: req.user?.id, username: req.user?.username, ip: req.ip, detail: { ...detail, job: job.id } });
      return res.json(job);
    } catch (error) {
      if (error instanceof SelfUpdateError) {
        audit?.record({ type: "self-update", outcome: "refused", userId: req.user?.id, username: req.user?.username, ip: req.ip, detail: { ...detail, reason: error.message } });
        return res.status(error.status).json({ error: error.message });
      }
      throw error;
    }
  };

  app.post("/api/admin/self-update/apply", apiRateLimiter, authenticate, requireAdmin, applyGate, (req: any, res) => {
    return begin("apply", req, res);
  });
  app.post("/api/admin/self-update/rollback", apiRateLimiter, authenticate, requireAdmin, applyGate, (req: any, res) => {
    return begin("rollback", req, res);
  });
}
