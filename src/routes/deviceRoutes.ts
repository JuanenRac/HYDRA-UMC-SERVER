// =============================================================================
// HYDRA-UMC-SERVER - src/routes/deviceRoutes.ts
// Copyright (C) 2026 JuanenRac (Electro Hobby 3D) <electrohobby3d@gmail.com>
// GPL-3.0-or-later - see LICENSE
// =============================================================================
// The device tokens an administrator issues, lists and revokes (src/deviceTokens.ts). The device itself signs in with its token on
// POST /api/device/login (src/routes/auth.ts). While the switch deviceTokens.enabled is off, every route here answers 404, as if it did not exist.
import express from "express";
import type { AuditEvent } from "../auditLog";
import { apiRateLimiter } from "../auth";
import { findUser, effectiveId } from "../users";
import { revokeRefreshTokensOfDevice } from "../refresh_tokens";
import { DeviceTokenError, deviceTokenDays, deviceTokenMaxDevices, validDeviceTokenId, type DeviceTokenLimits, type DeviceTokenStore } from "../deviceTokens";

type Middleware = (req: any, res: any, next: any) => unknown;

export interface DeviceRouteDeps {
  authenticate: Middleware;
  requireAdmin: Middleware;
  enabled: () => boolean;
  store: DeviceTokenStore;
  limits: () => DeviceTokenLimits | undefined;
  audit?: { record: (event: AuditEvent) => unknown };
}

const NAME_PATTERN = /^[^\u0000-\u001f\u007f]{1,64}$/u;

export function registerDeviceRoutes(app: express.Express, deps: DeviceRouteDeps): void {
  const { authenticate, requireAdmin, store, audit } = deps;
  const gate: Middleware = (_req, res, next) => (deps.enabled() ? next() : res.status(404).json({ error: "Not found" }));

  // The token is shown once, in this answer, and is not kept: the server keeps its record (id, account, dates) only. Issuing needs the confirmation.
  app.post("/api/admin/device-tokens", apiRateLimiter, authenticate, requireAdmin, gate, (req: any, res) => {
    const { name, username, ttlDays, confirm } = req.body || {};
    if (typeof name !== "string" || !NAME_PATTERN.test(name.trim())) return res.status(400).json({ error: "name must be the name of the device, 1 to 64 characters" });
    if (typeof username !== "string" || !username) return res.status(400).json({ error: "username must be the account the device signs in as" });
    if (ttlDays !== undefined && (typeof ttlDays !== "number" || !Number.isFinite(ttlDays) || ttlDays < 1)) return res.status(400).json({ error: "ttlDays must be a number of days, 1 or more" });
    if (confirm !== true) return res.status(400).json({ error: "Issuing a device token needs confirm: true" });
    const user = findUser(username);
    if (!user) return res.status(404).json({ error: "There is no such account" });
    // The token opens whatever its account may do: never an administrator account.
    if (user.role === "admin") return res.status(400).json({ error: "A device token cannot be issued for an administrator account: use an operator or viewer account made for the device" });
    const limits = deps.limits();
    try {
      const { token, view } = store.issue({
        name: name.trim(), username: user.username, accountId: effectiveId(user), days: deviceTokenDays(limits, ttlDays),
        createdBy: String(req.user?.username ?? ""), maxDevices: deviceTokenMaxDevices(limits),
      });
      audit?.record({ type: "device-token-issued", outcome: "ok", userId: req.user?.id, username: req.user?.username, ip: req.ip, detail: { id: view.id, device: view.name, account: view.username, expires_at: view.expiresAt } });
      res.json({ ...view, token });
    } catch (error) {
      if (error instanceof DeviceTokenError) return res.status(error.status).json({ error: error.message });
      throw error;
    }
  });

  app.get("/api/admin/device-tokens", apiRateLimiter, authenticate, requireAdmin, gate, (req, res) => {
    res.json({ items: store.list() });
  });

  // Revoking ends the token and every session opened with it (a session also ends at its next renewal if this were missed).
  app.delete("/api/admin/device-tokens/:id", apiRateLimiter, authenticate, requireAdmin, gate, (req: any, res) => {
    const id = String(req.params.id ?? "");
    if (!validDeviceTokenId(id)) return res.status(400).json({ error: "id must be the id of a device token" });
    const revoked = store.revoke(id);
    if (!revoked) return res.status(404).json({ error: "There is no active device token with that id" });
    const sessions = revokeRefreshTokensOfDevice(id);
    audit?.record({ type: "device-token-revoked", outcome: "ok", userId: req.user?.id, username: req.user?.username, ip: req.ip, detail: { id, sessions_ended: sessions } });
    res.json({ revoked: true, sessionsEnded: sessions });
  });
}
