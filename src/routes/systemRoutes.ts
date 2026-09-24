// =============================================================================
// HYDRA-UMC-SERVER - src/routes/systemRoutes.ts
// Copyright (C) 2026 JuanenRac (Electro Hobby 3D) <electrohobby3d@gmail.com>
// GPL-3.0 - see LICENSE
// =============================================================================
// The /api/system/{metrics,supervisor} and /api/ecosystem/* routes, moved out
// of server.ts unchanged. They need only the app, the two auth middlewares and
// the log function, so they are registered through a small function.
import express from "express";
import { execFile } from "child_process";
import { promisify } from "util";
import { getSupervisorSnapshot, getSystemMetrics } from "../systemMetrics";
import { getEcosystemStatus } from "../ecosystemStatus";

const execFileAsync = promisify(execFile);

type Middleware = (req: any, res: any, next: any) => unknown;

export function registerSystemRoutes(app: express.Express, auth: { authenticate: Middleware; requireAdmin: Middleware; industrialLog: (msg: string) => void }): void {
  const { authenticate, requireAdmin, industrialLog } = auth;

  // System Metrics API for industrial monitoring - powers the Overview
  // footer's CPU/memory/temp/network readout (Dashboard.tsx StatusFooter).
  // The actual read now lives in the module-level getSystemMetrics() above
  // (shared with GET /metrics's own hydra_system_* gauges below) - this
  // route is just that function's own JSON wire shape, unchanged.
  app.get("/api/system/metrics", async (req, res) => {
    res.json(await getSystemMetrics());
  });

  // Netdata-style deep-dive - powers STUDIO's own Supervisor panel
  // (System.tsx, under the HYDRA-UMC admin menu). Same "no auth" trust
  // tier as /api/system/metrics right above (read-only host introspection;
  // see getSupervisorSnapshot's own header comment for the full field
  // list and what's real vs. honestly null on a non-Linux host).
  app.get("/api/system/supervisor", async (req, res) => {
    res.json(await getSupervisorSnapshot());
  });

  // Real, honest V0 of ecosystem-wide status - see getEcosystemStatus()'s
  // own header comment for what this actually is and isn't. Same trust
  // tier as /api/system/metrics right above (read-only host introspection,
  // no auth) - this exposes local directory names and per-project manifest
  // fields, nothing about running robots/credentials.
  app.get("/api/ecosystem/status", async (req, res) => {
    res.json(await getEcosystemStatus());
  });

  // Real start/stop/restart per project, admin-only - the Ecosystem >
  // Services panel's per-card controls. Two layers keep this from being a
  // generic "run any systemctl command" hole:
  //
  // 1. `:unit` is NEVER trusted as-is (an admin session's own request body
  //    is still an untrusted boundary, same reasoning as everywhere else
  //    in this file) - it must match one of the systemdUnit values a
  //    FRESH getEcosystemStatus() scan actually returns right now, i.e. a
  //    real project's own opt-in manifest field, not an arbitrary string
  //    that merely looks like a hydra-umc-*.service name. HYDRA-UMC-SERVER's
  //    own unit is explicitly refused too - a self-restart already has its
  //    own, more controlled path (POST /api/admin/restart above).
  // 2. Even a validated unit only actually WORKS because of a real,
  //    narrowly-scoped polkit rule (HYDRA-UMC-OS's own
  //    provisioning/polkit/50-hydra-umc-server-service-control.rules) -
  //    without it, systemd's own D-Bus API refuses the unprivileged
  //    hydra-umc-server account regardless of what this route allows.
  //    Everywhere this route ISN'T installed with that rule (a plain dev
  //    checkout, a deployment that never ran install_server.sh's polkit
  //    step), `systemctl` itself fails and this returns a clean, honest
  //    503 rather than a silent no-op or a hung request.
  const SYSTEMD_UNIT_ACTIONS = ["start", "stop", "restart"] as const;
  type SystemdUnitAction = (typeof SYSTEMD_UNIT_ACTIONS)[number];

  app.post("/api/ecosystem/service/:unit/:action", authenticate, requireAdmin, async (req, res) => {
    const { unit, action } = req.params;
    if (!SYSTEMD_UNIT_ACTIONS.includes(action as SystemdUnitAction)) {
      return res.status(400).json({ error: `action must be one of: ${SYSTEMD_UNIT_ACTIONS.join(", ")}` });
    }
    if (unit === "hydra-umc-server.service") {
      return res.status(403).json({ error: "This server's own unit is not controllable here - use POST /api/admin/restart." });
    }
    const status = await getEcosystemStatus();
    const known = status.projects.some((p) => p.systemdUnit === unit);
    if (!known) {
      return res.status(404).json({ error: `${unit} is not a currently known project unit.` });
    }
    try {
      await execFileAsync("systemctl", [action, unit], { timeout: 15000 });
      industrialLog(`[ADMIN] systemctl ${action} ${unit} requested via Ecosystem > Services.`);
      res.json({ success: true });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      industrialLog(`[ADMIN] systemctl ${action} ${unit} failed: ${message}`);
      res.status(503).json({ error: `systemctl ${action} ${unit} failed - see this server's own logs for the real reason (commonly: the polkit rule above isn't installed on this host, or systemctl itself is unavailable).` });
    }
  });
}
