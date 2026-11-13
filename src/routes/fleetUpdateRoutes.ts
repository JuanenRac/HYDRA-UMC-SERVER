// =============================================================================
// HYDRA-UMC-SERVER - src/routes/fleetUpdateRoutes.ts
// Copyright (C) 2026 JuanenRac (Electro Hobby 3D) <electrohobby3d@gmail.com>
// GPL-3.0-or-later - see LICENSE
// =============================================================================
// /api/admin/fleet-update: every program installed on the device against its newest release, and their update one after the other with the progress of each
// (src/fleetUpdate.ts, tools/fleet_update.py of HYDRA-UMC-OS). Two switches, both off by default and both answering 404 while off: the look is `updateCheck.enabled`
// (reading only) and applying or taking up a program is `maintenance.enabled`. Applying needs `confirm: true`, an administrator, one run at a time, and is written to the
// audit log whatever its result.
import express from "express";
import type { AuditEvent } from "../auditLog";
import { apiRateLimiter } from "../auth";
import { FleetUpdate, FleetUpdateError } from "../fleetUpdate";

type Middleware = (req: any, res: any, next: any) => unknown;

export interface FleetRouteDeps {
  authenticate: Middleware;
  requireAdmin: Middleware;
  lookEnabled: () => boolean;
  applyEnabled: () => boolean;
  fleet: FleetUpdate;
  audit?: { record: (event: AuditEvent) => unknown };
}

export function registerFleetUpdateRoutes(app: express.Express, deps: FleetRouteDeps): void {
  const { authenticate, requireAdmin, fleet, audit } = deps;
  const lookGate: Middleware = (_req, res, next) => (deps.lookEnabled() ? next() : res.status(404).json({ error: "Not found" }));
  const applyGate: Middleware = (_req, res, next) => (deps.applyEnabled() ? next() : res.status(404).json({ error: "Not found" }));
  const bodyOf = (req: any): Record<string, unknown> => (req.body && typeof req.body === "object" && !Array.isArray(req.body) ? req.body : {});
  const refuse = (req: any, res: express.Response, error: unknown, detail: Record<string, unknown>, fallback: string) => {
    const known = error instanceof FleetUpdateError;
    audit?.record({ type: "fleet-update", outcome: known ? "refused" : "failed", userId: req.user?.id, username: req.user?.username, ip: req.ip, detail: { ...detail, reason: known ? error.message : "start failed" } });
    return res.status(known ? error.status : 502).json({ error: known ? error.message : fallback });
  };

  // The progress file of the tool (null before the first look), with a run that stopped writing marked as interrupted.
  app.get("/api/admin/fleet-update", apiRateLimiter, authenticate, requireAdmin, lookGate, (req: any, res) => {
    res.json({ applyEnabled: deps.applyEnabled(), busy: fleet.busy, report: fleet.read() });
  });

  // A look at the device and at the newest releases. Nothing is changed.
  app.post("/api/admin/fleet-update/plan", apiRateLimiter, authenticate, requireAdmin, lookGate, (req: any, res) => {
    fleet.plan().then(
      (report) => res.json({ applyEnabled: deps.applyEnabled(), busy: fleet.busy, report }),
      (error) => (error instanceof FleetUpdateError ? res.status(error.status).json({ error: error.message }) : res.status(502).json({ error: "The look failed" })),
    );
  });

  // Starts the update of the programs named (all the ones the plan marks to update when none is named). Answers at once; the progress is in GET.
  app.post("/api/admin/fleet-update/apply", apiRateLimiter, authenticate, requireAdmin, applyGate, (req: any, res) => {
    const body = bodyOf(req);
    if (body.confirm !== true) return res.status(400).json({ error: "apply needs confirm: true" });
    const detail = { action: "apply", services: Array.isArray(body.services) ? body.services.slice(0, 60) : "all" };
    fleet.apply(body.services).then(
      (report) => {
        audit?.record({ type: "fleet-update", outcome: "ok", userId: req.user?.id, username: req.user?.username, ip: req.ip, detail });
        res.json({ applyEnabled: true, busy: true, report });
      },
      (error) => refuse(req, res, error, detail, "The update could not be started"),
    );
  });

  // Takes up one program whose step was cut (or that failed), from its first step.
  app.post("/api/admin/fleet-update/resume", apiRateLimiter, authenticate, requireAdmin, applyGate, (req: any, res) => {
    const body = bodyOf(req);
    if (body.confirm !== true) return res.status(400).json({ error: "resume needs confirm: true" });
    const detail = { action: "resume", service: typeof body.service === "string" ? body.service.slice(0, 41) : undefined };
    fleet.resume(body.service).then(
      (report) => {
        audit?.record({ type: "fleet-update", outcome: "ok", userId: req.user?.id, username: req.user?.username, ip: req.ip, detail });
        res.json({ applyEnabled: true, busy: true, report });
      },
      (error) => refuse(req, res, error, detail, "The program could not be taken up"),
    );
  });
}
