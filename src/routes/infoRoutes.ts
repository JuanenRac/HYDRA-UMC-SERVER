// =============================================================================
// HYDRA-UMC-SERVER - src/routes/infoRoutes.ts
// Copyright (C) 2026 JuanenRac (Electro Hobby 3D) <electrohobby3d@gmail.com>
// GPL-3.0 - see LICENSE
// =============================================================================
// The metrics scrape endpoint and the discovery endpoint, moved out of server.ts unchanged.
import express from "express";
import os from "os";
import path from "path";
import fs from "fs";
import { realSettings, remoteAccessAllowed } from "../serverPolicy";
import { registry as metricsRegistry } from "../metrics";

export function registerInfoRoutes(app: express.Express, deps: { infoAccess: express.RequestHandler; getSettings: () => any; REMOTE_API_VERSION: number }): void {
  const { infoAccess, getSettings, REMOTE_API_VERSION } = deps;
  let pkgVersion = "0.0.0";
  try {
    pkgVersion = JSON.parse(fs.readFileSync(path.join(process.cwd(), "package.json"), "utf-8")).version || pkgVersion;
  } catch {
    // package.json missing/unreadable - keep the placeholder version rather than fail startup over it
  }

  // Prometheus scrape endpoint - text exposition format via `prom-client`
  // (src/metrics.ts owns every metric definition; this route only renders
  // the registry). Deliberately unauthenticated, same posture as GET
  // /api/system/metrics right above and the wide-open cors() at the top of
  // this file: this is a LAN industrial controller, and a Prometheus
  // scrape config is one more trusted-LAN caller, not a public one. If this
  // server is ever exposed beyond a fully trusted LAN, put it behind the
  // same reverse-proxy/network boundary you'd already need for the rest of
  // this API (see README.md's own security notes) rather than gating it
  // with the bearer-token scheme every other write route uses - Prometheus
  // itself supports a bearer_token in its scrape config if that's ever
  // wanted, but nothing here requires it today.
  app.get("/metrics", infoAccess, async (req, res) => {
    try {
      res.set("Content-Type", metricsRegistry.contentType);
      res.end(await metricsRegistry.metrics());
    } catch (e) {
      console.error("Error collecting Prometheus metrics", e);
      res.status(500).end("Error collecting metrics");
    }
  });

  // Discovery/identity endpoint - what a remote client (HYDRA-UMC SUITE
  // scanning a subnet for controllers, or one of the mobile control apps)
  // hits first to confirm a given host/IP is actually running HYDRA-UMC
  // STUDIO before trying to talk the real API to it. Deliberately cheap
  // (no settings.json read) so a swarm scan across many IPs stays fast -
  // robot/controller counts come from the same in-memory cache the
  // WebSocket broadcast path already maintains, not a fresh disk read
  // per request.
  app.get("/api/hydra-info", (req, res) => {
    // Real enable/disable gate (Config > Remote Access in the browser UI,
    // src/store.tsx's own SystemSettings.remoteAccess) - per-client (see
    // remoteAccessAllowed()'s own header comment above for
    // the X-Hydra-Client header each real client sends). When disabled for
    // that client, this endpoint responds 404 - the same as a plain "not
    // running HYDRA-UMC STUDIO" host looks like to a scanning client (each
    // client's own discovery code already treats a non-200 as "not
    // found", no client-side change needed beyond sending the header) -
    // the server becomes undiscoverable/unidentifiable to THAT app's own
    // scan, without touching GET/POST /api/settings or /ws (this SAME
    // browser tab's own connection to its own server also goes through
    // those, so gating them would break the core web UI, not just remote
    // apps - see that settings field's own comment in store.tsx).
    if (!remoteAccessAllowed(realSettings(getSettings()), req.headers["x-hydra-client"] as string | undefined)) {
      res.status(404).end();
      return;
    }
    const s = getSettings();
    res.json({
      schema_version: "1.0",
      product: realSettings(getSettings())?.serverName || "HYDRA-UMC STUDIO",
      remoteApiVersion: REMOTE_API_VERSION,
      appVersion: pkgVersion,
      hostname: os.hostname(),
      controllerCount: Array.isArray(s?.controllers) ? s.controllers.length : 0,
      robotCount: Array.isArray(s?.controllers)
        ? s.controllers.reduce((n: number, c: any) => n + (Array.isArray(c.robots) ? c.robots.length : 0), 0)
        : 0,
      uptimeSeconds: Math.round(process.uptime()),
    });
  });
}
