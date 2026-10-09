// =============================================================================
// HYDRA-UMC-SERVER - src/routes/adminRoutes.ts
// Copyright (C) 2026 JuanenRac (Electro Hobby 3D) <electrohobby3d@gmail.com>
// GPL-3.0 - see LICENSE
// =============================================================================
// The /api/users and /api/admin/* routes, moved out of server.ts unchanged.
// They need the two auth middlewares, the users module, the list of open
// WebSocket connections, the log file, the listen port and the stored server
// config, all handed in through one small object so this file holds no state.
import express from "express";
import fs from "fs";
import { WebSocket } from "ws";
import { listUsers, createUser, updateUser, deleteUser, type UserRole } from "../users";

type Middleware = (req: any, res: any, next: any) => unknown;

export interface AdminRouteDeps {
  authenticate: Middleware;
  requireAdmin: Middleware;
  asyncHandler: (handler: (req: any, res: any) => Promise<any>) => (req: any, res: any, next: any) => unknown;
  industrialLog: (msg: string) => void;
  wsClients: Set<WebSocket>;
  logFile: string;
  getCurrentPort: () => number;
  loadServerConfig: () => { port?: number | null };
  saveServerConfig: (config: any) => void;
}

export function registerAdminRoutes(app: express.Express, deps: AdminRouteDeps): void {
  const { authenticate, requireAdmin, asyncHandler, industrialLog, wsClients, logFile, getCurrentPort, loadServerConfig, saveServerConfig } = deps;

  // Account management - admin-only (requireAdmin, chained after
  // authenticate), backed by the users.ts module - lets an admin
  // rename/re-password their own account from Config > Users
  // instead of the account being permanently stuck as "admin"/"admin", and
  // create additional lower-privilege "operator" accounts for day-to-day
  // robot operation without exposing settings writes or user management.
  app.get("/api/users", authenticate, requireAdmin, (req, res) => {
    res.json({ users: listUsers() });
  });

  app.post("/api/users", authenticate, requireAdmin, asyncHandler(async (req, res) => {
    const { username, password, role } = req.body || {};
    const safeRole: UserRole = role === "operator" ? "operator" : "admin";
    if (typeof username !== "string" || typeof password !== "string") {
      return res.status(400).json({ error: "username and password required" });
    }
    const result = await createUser(username, password, safeRole);
    if (!result.ok) return res.status(400).json({ error: result.error });
    res.json({ success: true });
  }));

  app.put("/api/users/:username", authenticate, requireAdmin, asyncHandler(async (req, res) => {
    const { newUsername, password, role } = req.body || {};
    const safeRole: UserRole | undefined = role === "operator" || role === "admin" ? role : undefined;
    const result = await updateUser(req.params.username, { newUsername, password, role: safeRole });
    if (!result.ok) return res.status(400).json({ error: result.error });
    res.json({ success: true });
  }));

  app.delete("/api/users/:username", authenticate, requireAdmin, asyncHandler(async (req, res) => {
    // deleteUser() is now async (see users.ts's own
    // withUsersLock()) - awaited here like createUser/updateUser already
    // are, through the same asyncHandler() wrapper.
    const result = await deleteUser(req.params.username);
    if (!result.ok) return res.status(400).json({ error: result.error });
    res.json({ success: true });
  }));

  // Admin UI backend (see admin-ui/ - a small separate Vite/React app this
  // server optionally serves at /admin, same opt-in pattern as STUDIO's
  // own frontend at "/", see build-frontend.sh's own header comment).
  // Every route here is admin-only - this is server/fleet administration,
  // not robot control (that stays STUDIO-only).

  // "Connected devices" list - every currently-open WebSocket connection,
  // with the per-connection metadata attached at connect time (see
  // wss.on("connection", ...) above). Purely informational: this is NOT
  // the robot roster (that's controllers[].robots in /api/settings) - it's
  // literally "who/what has a live socket open to this server right now"
  // (STUDIO tabs, mobile apps, HYDRA-UMC SUITE, ...).
  app.get("/api/admin/clients", authenticate, requireAdmin, (req, res) => {
    const clients = Array.from(wsClients).map((ws: any) => ({
      ...ws.meta,
      connected: ws.readyState === WebSocket.OPEN,
    }));
    res.json({ clients });
  });

  // Tail of the real on-disk log file (LOG_FILE, industrialLog()'s own
  // target) - admin-only for the same reason the static-file guard above
  // (BLOCKED_STATIC_FILES / the /logs path block) already refuses to ever
  // serve this file as a plain static asset: operational logs can contain
  // IPs, usernames, and command payloads, not something to leave reachable
  // without authentication. `lines` caps how much is read/returned (default
  // 300) - this is a full-file read on every call (simple, and LOG_FILE
  // stays small enough in practice that this is fine), not a byte-range
  // seek from the end - fine for a periodically-polled admin log viewer,
  // not meant for tailing a truly enormous file.
  app.get("/api/admin/logs", authenticate, requireAdmin, (req, res) => {
    const requested = parseInt(String(req.query.lines || ""), 10);
    const limit = Number.isFinite(requested) && requested > 0 ? Math.min(requested, 2000) : 300;
    try {
      const raw = fs.readFileSync(logFile, "utf-8");
      const allLines = raw.split("\n").filter(Boolean);
      res.json({ lines: allLines.slice(-limit) });
    } catch {
      res.json({ lines: [] }); // No log file yet (fresh install) - empty, not an error
    }
  });

  // Server config (currently just the listen port - serverName already
  // lives in /api/settings, reused as-is by the admin UI's Config screen
  // rather than duplicated here). See resolvePort()'s own comment for why
  // a port change here needs a restart to take effect, and why that's the
  // correct behavior rather than a limitation to work around.
  app.get("/api/admin/server-config", authenticate, requireAdmin, (req, res) => {
    res.json({ port: getCurrentPort(), pendingPort: loadServerConfig().port ?? null });
  });

  app.put("/api/admin/server-config", authenticate, requireAdmin, (req, res) => {
    const { port } = req.body || {};
    if (port !== undefined && port !== null) {
      const portNum = Number(port);
      if (!Number.isInteger(portNum) || portNum < 1 || portNum > 65535) {
        return res.status(400).json({ error: "port must be an integer between 1 and 65535" });
      }
      saveServerConfig({ ...loadServerConfig(), port: portNum });
    }
    res.json({ success: true, appliesOnRestart: true });
  });

  // Graceful self-restart - only meaningful behind a process supervisor
  // that auto-restarts on exit (systemd Restart=always, pm2, Docker
  // --restart, the CM5 deployment this whole feature targets) - documented
  // as such in the admin UI itself rather than silently doing nothing
  // useful under `npm run dev`. Responds BEFORE exiting so the admin UI's
  // own fetch() doesn't see a connection-reset instead of a clean 200.
  app.post("/api/admin/restart", authenticate, requireAdmin, (req, res) => {
    res.json({ success: true });
    industrialLog("[ADMIN] Restart requested via admin UI - exiting for the process supervisor to restart.");
    setTimeout(() => process.exit(0), 250);
  });
}
