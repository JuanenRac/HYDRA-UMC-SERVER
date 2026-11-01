// =============================================================================
// HYDRA-UMC-SERVER - src/routes/pushRoutes.ts
// Copyright (C) 2026 JuanenRac (Electro Hobby 3D) <electrohobby3d@gmail.com>
// GPL-3.0-or-later - see LICENSE
// =============================================================================
// The device tokens of the phones that want push notifications (src/pushNotifications.ts): a signed-in account registers and removes
// its own, and an administrator reads the state of the service (never the credentials or the tokens). While the switch push.enabled
// is off, registering answers 404 as if the route did not exist.
import express from "express";
import type { AuditEvent } from "../auditLog";
import { LOCALES, PushRegistryError, validDeviceToken, type PushDevices, type PushStatus } from "../pushNotifications";

type Middleware = (req: any, res: any, next: any) => unknown;

export interface PushRouteDeps {
  authenticate: Middleware;
  requireAdmin: Middleware;
  /** Answers 404 while the switch is off. */
  pushGate: Middleware;
  devices: PushDevices;
  status: () => PushStatus;
  audit?: { record: (event: AuditEvent) => unknown };
}

export function makePushGate(isEnabled: () => boolean): Middleware {
  return (_req, res, next) => {
    if (!isEnabled()) {
      res.status(404).end();
      return;
    }
    next();
  };
}

export function registerPushRoutes(app: express.Express, deps: PushRouteDeps): void {
  const { authenticate, requireAdmin, pushGate, devices, status, audit } = deps;

  app.post("/api/push/devices", authenticate, pushGate, (req: any, res) => {
    const { token, platform, locale } = req.body || {};
    if (!validDeviceToken(token)) return res.status(400).json({ error: "token must be the hexadecimal device token of the phone" });
    if (platform !== "ios") return res.status(400).json({ error: "platform must be ios" });
    if (locale !== undefined && !(typeof locale === "string" && (LOCALES as readonly string[]).includes(locale))) {
      return res.status(400).json({ error: `locale must be one of ${LOCALES.join(", ")}` });
    }
    try {
      devices.register(token, String(req.user?.username ?? ""), typeof locale === "string" ? locale : "en");
    } catch (error) {
      if (error instanceof PushRegistryError) return res.status(error.status).json({ error: error.message });
      throw error;
    }
    audit?.record({ type: "push-device-registered", outcome: "ok", userId: req.user?.id, username: req.user?.username, ip: req.ip });
    res.json({ registered: true });
  });

  app.delete("/api/push/devices/:token", authenticate, pushGate, (req: any, res) => {
    const token = String(req.params.token ?? "");
    if (!validDeviceToken(token)) return res.status(400).json({ error: "token must be the hexadecimal device token of the phone" });
    const admin = req.user?.role === "admin";
    const removed = devices.remove(token, admin ? null : String(req.user?.username ?? ""));
    if (removed) audit?.record({ type: "push-device-removed", outcome: "ok", userId: req.user?.id, username: req.user?.username, ip: req.ip });
    res.json({ removed });
  });

  app.get("/api/admin/push", authenticate, requireAdmin, (req, res) => {
    res.json(status());
  });
}
