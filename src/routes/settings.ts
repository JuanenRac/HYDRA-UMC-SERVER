// =============================================================================
// HYDRA-UMC-SERVER - src/routes/settings.ts
// Copyright (C) 2026 JuanenRac (Electro Hobby 3D) <electrohobby3d@gmail.com>
// GPL-3.0 - see LICENSE
// =============================================================================
// Reading and writing the settings tree, moved out of server.ts unchanged.
import express from "express";
import { ifMatchAgrees, settingsRevision, redactSettingsSecrets } from "../serverPolicy";

type Middleware = (req: any, res: any, next: any) => unknown;

export interface SettingsRouteDeps {
  authenticate: Middleware;
  requireAdmin: Middleware;
  loadFullSettingsFromDisk: () => any;
  applySettingsUpdate: (payload: any) => Promise<{ robotId: unknown; requested: number; applied: number }[] | void>;
}

export function registerSettingsRoutes(app: express.Express, deps: SettingsRouteDeps): void {
  const { authenticate, requireAdmin, loadFullSettingsFromDisk, applySettingsUpdate } = deps;
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

  app.post("/api/settings", authenticate, requireAdmin, async (req, res) => {
    try {
      const payload = req.body;
      // The tree changed since this client read it (another administrator's tab, a command that moved a robot): refuse instead of overwriting what the other one wrote.
      const currentRevision = settingsRevision(loadFullSettingsFromDisk());
      if (!ifMatchAgrees(req.headers["if-match"] as string | undefined, currentRevision)) {
        return res.status(409).json({ error: "The settings changed since you read them: reload and apply your change again.", revision: currentRevision });
      }
      const clamped = (await applySettingsUpdate(payload)) || [];
      res.json({ success: true, revision: settingsRevision(loadFullSettingsFromDisk()), ...(clamped.length ? { warnings: clamped.map((c) => ({ robotId: c.robotId, field: "heatedBed.targetTemp", requested: c.requested, applied: c.applied, code: "temperature-limit" })) } : {}) });
    } catch (e) {
      console.error("Error writing settings", e);
      res.status(500).json({ error: "Failed to save settings" });
    }
  });
}
