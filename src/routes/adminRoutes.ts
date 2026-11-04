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
import { apiRateLimiter } from "../auth";
import fs from "fs";
import { WebSocket } from "ws";
import { SecurityConfig, SecurityConfigError } from "../securityConfig";
import type { AuditLog } from "../auditLog";
import { jwtKeyStore } from "../jwtKeys";
import { listUsers, createUser, updateUser, deleteUser, isUserRole, type UserRole } from "../users";

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
  /** The access options an administrator can change from the control app (AI relay, host information, TLS). */
  security: SecurityConfig;
  /** The audit record: a change of the job dispatcher options (delivery of its stop requests, replanning) is written to it. */
  audit?: Pick<AuditLog, "record">;
}

export function registerAdminRoutes(app: express.Express, deps: AdminRouteDeps): void {
  const { authenticate, requireAdmin, asyncHandler, industrialLog, wsClients, logFile, getCurrentPort, loadServerConfig, saveServerConfig, security, audit } = deps;

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
    const safeRole: UserRole = role === "operator" || role === "viewer" ? role : "admin";
    if (typeof username !== "string" || typeof password !== "string") {
      return res.status(400).json({ error: "username and password required" });
    }
    const result = await createUser(username, password, safeRole);
    if (!result.ok) return res.status(400).json({ error: result.error });
    res.json({ success: true });
  }));

  app.put("/api/users/:username", authenticate, requireAdmin, asyncHandler(async (req, res) => {
    const { newUsername, password, role } = req.body || {};
    const safeRole: UserRole | undefined = isUserRole(role) ? role : undefined;
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
  app.get("/api/admin/logs", apiRateLimiter, authenticate, requireAdmin, (req, res) => {
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
    res.json({ port: getCurrentPort(), pendingPort: loadServerConfig().port ?? null, ...security.snapshot() });
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
    let security_result: ReturnType<SecurityConfig["update"]> | undefined;
    // Choosing EdDSA creates the signing key now, so a key file that cannot be written refuses the change instead of breaking the next sign-in.
    if (req.body?.auth?.jwtAlgorithm === "EdDSA") {
      try { jwtKeyStore().ensureActive(); } catch (error) {
        return res.status(500).json({ error: "The key file for EdDSA cannot be created or read; nothing was changed", code: "JWT_KEY_FILE_UNUSABLE" });
      }
    }
    const wantsSecurity = req.body && (req.body.aiAccess !== undefined || req.body.infoAuth !== undefined || req.body.tls !== undefined || req.body.ble !== undefined || req.body.mqtt !== undefined || req.body.voice !== undefined || req.body.mavlink !== undefined || req.body.robots !== undefined || req.body.connections !== undefined || req.body.health !== undefined || req.body.ecosystemHealth !== undefined || req.body.infoTickets !== undefined || req.body.auth !== undefined || req.body.presence !== undefined || req.body.push !== undefined || req.body.trustedNetworks !== undefined || req.body.rul !== undefined || req.body.safety !== undefined || req.body.camera !== undefined || req.body.install !== undefined || req.body.websocket !== undefined || req.body.logging !== undefined || req.body.rateLimits !== undefined || req.body.bridges !== undefined || req.body.jobDispatcher !== undefined);
    if (wantsSecurity) {
      try {
        security_result = security.update(req.body, String((req as any).user?.username ?? "admin"));
      } catch (error) {
        if (error instanceof SecurityConfigError) {
          if (req.body.bridges !== undefined) audit?.record({ type: "bridge-options", outcome: "refused", userId: (req as any).user?.id, username: (req as any).user?.username, ip: req.ip, detail: { reason: error.message } });
          if (req.body.rateLimits !== undefined) audit?.record({ type: "rate-limits-options", outcome: "refused", userId: (req as any).user?.id, username: (req as any).user?.username, ip: req.ip, detail: { reason: error.message } });
          if (req.body.jobDispatcher !== undefined) audit?.record({ type: "job-dispatcher-options", outcome: "refused", userId: (req as any).user?.id, username: (req as any).user?.username, ip: req.ip, detail: { status: error.status, reason: error.message } });
          return res.status(error.status).json({ error: error.message });
        }
        throw error;
      }
    }
    if (security_result && req.body.rateLimits !== undefined) {
      const r = security_result.snapshot.rateLimits;
      audit?.record({
        type: "rate-limits-options", outcome: "ok", userId: (req as any).user?.id, username: (req as any).user?.username, ip: req.ip,
        detail: Object.fromEntries([["enabled", r.enabled.value], ...Object.entries(r).filter(([k]) => k !== "enabled").map(([k, v]) => [k, (v as { value: number }).value])]),
      });
    }
    if (security_result && req.body.bridges !== undefined) {
      // only the switches that were sent are recorded, with the value now in force
      const view = security_result.snapshot.bridges as unknown as Record<string, Record<string, { value: unknown }>>;
      audit?.record({
        type: "bridge-options", outcome: "ok", userId: (req as any).user?.id, username: (req as any).user?.username, ip: req.ip,
        detail: Object.fromEntries(Object.entries(req.body.bridges as Record<string, Record<string, unknown>>).flatMap(([b, o]) => Object.keys(o).map((k) => [`${b}.${k}`, view[b]?.[k]?.value]))),
      });
    }
    if (security_result && req.body.jobDispatcher !== undefined) {
      const jd = security_result.snapshot.jobDispatcher;
      audit?.record({
        type: "job-dispatcher-options", outcome: "ok", userId: (req as any).user?.id, username: (req as any).user?.username, ip: req.ip,
        detail: {
          stopRelayEnabled: jd.stopRelay.enabled.value,
          robotsMapped: Object.keys(jd.stopRelay.robotMap).length,
          allowUnconfirmed: jd.replan.allowUnconfirmed.value,
          stopAckTimeoutSeconds: jd.replan.stopAckTimeoutSeconds.value,
        },
      });
    }
    res.json({
      success: true,
      appliesOnRestart: !wantsSecurity || (port !== undefined && port !== null) || (security_result?.appliesOnRestart ?? false),
      warnings: security_result?.warnings ?? [],
      ...(security_result ? security_result.snapshot : {}),
    });
  });

  // The signing keys of the EdDSA sign-in tokens: their state (never the private part) and the rotation. Rotation is refused
  // while HS256 is the algorithm, since there is nothing asymmetric to rotate.
  const keysAnswer = () => ({ algorithm: security.jwtPolicy().algorithm, keys: jwtKeyStore().list(), jwksPath: "/.well-known/jwks.json" });
  app.get("/api/admin/jwt-keys", authenticate, requireAdmin, (req, res) => {
    try { res.json(keysAnswer()); } catch { res.status(500).json({ error: "The key file cannot be read", code: "JWT_KEY_FILE_UNUSABLE" }); }
  });
  app.post("/api/admin/jwt-keys/rotate", authenticate, requireAdmin, (req, res) => {
    if (security.jwtPolicy().algorithm !== "EdDSA") return res.status(409).json({ error: "Asymmetric signing is off (auth.jwtAlgorithm is HS256): there is no key to rotate", code: "JWT_ASYMMETRIC_OFF" });
    try {
      const kid = jwtKeyStore().rotate();
      industrialLog(`[SECURITY] ${String((req as any).user?.username ?? "admin")} rotated the token signing key; the new key is ${kid}, the previous one stays published for the overlap.`);
      res.json({ success: true, kid, ...keysAnswer() });
    } catch { res.status(500).json({ error: "The key file cannot be written; nothing was rotated", code: "JWT_KEY_FILE_UNUSABLE" }); }
  });

  // Graceful self-restart - only meaningful behind a process supervisor
  // that auto-restarts on exit (systemd Restart=always, pm2, Docker
  // --restart, the CM5 deployment this whole feature targets) - documented
  // as such in the admin UI itself rather than silently doing nothing
  // useful under `npm run dev`. Responds BEFORE exiting so the admin UI's
  // own fetch() doesn't see a connection-reset instead of a clean 200.
  app.post("/api/admin/restart", authenticate, requireAdmin, (req, res) => {
    res.json({ success: true });
    audit?.record({ type: "server-restart", outcome: "ok", userId: (req as any).user?.id, username: (req as any).user?.username, ip: req.ip });
    industrialLog("[ADMIN] Restart requested via admin UI - exiting for the process supervisor to restart.");
    setTimeout(() => process.exit(0), 250);
  });
}
