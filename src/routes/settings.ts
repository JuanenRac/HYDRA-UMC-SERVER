// =============================================================================
// HYDRA-UMC-SERVER - src/routes/settings.ts
// Copyright (C) 2026 JuanenRac (Electro Hobby 3D) <electrohobby3d@gmail.com>
// GPL-3.0 - see LICENSE
// =============================================================================
// Reading and writing the settings tree, moved out of server.ts unchanged.
import express from "express";
import { ifMatchAgrees, settingsRevision, redactSettingsSecrets } from "../serverPolicy";
import { RobotIdDuplicatedError, duplicatedRobotBody, robotIdConflicts } from "../robotIds";

type Middleware = (req: any, res: any, next: any) => unknown;

export interface SettingsRouteDeps {
  authenticate: Middleware;
  requireAdmin: Middleware;
  loadFullSettingsFromDisk: () => any;
  applySettingsUpdate: (payload: any) => Promise<{ robotId: unknown; requested: number; applied: number }[] | void>;
  /** The settings as the server holds them; without it the robot id report is empty. */
  getSettings?: () => any;
}

export function registerSettingsRoutes(app: express.Express, deps: SettingsRouteDeps): void {
  const { authenticate, requireAdmin, loadFullSettingsFromDisk, applySettingsUpdate, getSettings } = deps;
  // API routes FIRST
  // This had no auth middleware at all - any unauthenticated
  // caller could GET the full settings object (controller IPs,
  // CAN-OTA config, complete per-robot state - see the comment on
  // RESERVED_DATA_FILENAMES above for exactly what this file holds),
  // confirmed live (200 with no Authorization header at all). `authenticate`
  // only (not `requireAdmin`, unlike the POST just below) - every logged-in
  // STUDIO operator legitimately reads this today, not only an admin;
  // writing it already correctly requires admin.
  app.get("/api/settings", authenticate, (req, res) => {
    try {
      const settings = loadFullSettingsFromDisk();
      res.setHeader("ETag", `"${settingsRevision(settings)}"`);   // see ifMatchAgrees(): a client sends it back as If-Match when it saves
      res.json((req as any).user?.role === "admin" ? settings : redactSettingsSecrets(settings));
    } catch (e) {
      console.error("Error reading settings", e);
      res.status(500).json({ error: "Failed to read settings" });
    }
  });

  // The robot ids that more than one robot uses (a configuration of an older version can still hold them): the routes by those ids answer 409
  // robot_id_ambiguous. Controller ids only, never names, addresses or credentials.
  app.get("/api/admin/robot-ids", authenticate, requireAdmin, (req, res) => {
    const conflicts = robotIdConflicts(getSettings ? getSettings() : {}).map((c) => ({ robotId: c.robotId, controllers: c.controllers }));
    res.json({ ok: conflicts.length === 0, ambiguousCount: conflicts.length, ambiguous: conflicts });
  });

  async function save(req: any, res: any) {
    try {
      const payload = req.body;
      const clamped = (await applySettingsUpdate(payload)) || [];
      const revision = settingsRevision(loadFullSettingsFromDisk());
      res.setHeader("ETag", `"${revision}"`);
      res.json({ success: true, revision, ...(clamped.length ? { warnings: clamped.map((c) => ({ robotId: c.robotId, field: "heatedBed.targetTemp", requested: c.requested, applied: c.applied, code: "temperature-limit" })) } : {}) });
    } catch (e) {
      if (e instanceof RobotIdDuplicatedError) return res.status(409).json(duplicatedRobotBody(e.conflicts));
      console.error("Error writing settings", e);
      res.status(500).json({ error: "Failed to save settings" });
    }
  }

  app.post("/api/settings", authenticate, requireAdmin, async (req, res) => {
    // The tree changed since this client read it (another administrator's tab, a command that moved a robot): refuse instead of overwriting what the other one wrote.
    const currentRevision = settingsRevision(loadFullSettingsFromDisk());
    if (!ifMatchAgrees(req.headers["if-match"] as string | undefined, currentRevision)) {
      return res.status(409).json({ error: "The settings changed since you read them: reload and apply your change again.", revision: currentRevision });
    }
    return save(req, res);
  });

  // The same save with the condition mandatory (optimistic concurrency): the body is the whole tree, as in the POST above, and the caller must say which version it read.
  //   428 - no If-Match (or only `*`, which would turn the check off): read GET /api/settings and send its ETag back.
  //   412 - the settings are not the version the caller read: the body carries the current revision; read again and apply the change again.
  app.put("/api/settings", authenticate, requireAdmin, async (req, res) => {
    const currentRevision = settingsRevision(loadFullSettingsFromDisk());
    const header = typeof req.headers["if-match"] === "string" ? (req.headers["if-match"] as string) : undefined;
    if (header === undefined || header.trim() === "" || header.trim() === "*") {
      return res.status(428).json({ error: "PUT /api/settings needs an If-Match header with the ETag of GET /api/settings (a bare * is not accepted).", code: "if_match_required", revision: currentRevision });
    }
    if (!ifMatchAgrees(header, currentRevision)) {
      return res.status(412).json({ error: "The settings changed since you read them (If-Match does not match): read them again and apply your change again.", code: "settings_changed", revision: currentRevision });
    }
    return save(req, res);
  });
}
