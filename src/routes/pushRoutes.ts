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
import { LiveActivityError, validActivityToken, validRobotId, type LiveActivities } from "../liveActivity";

type Middleware = (req: any, res: any, next: any) => unknown;

export interface PushRouteDeps {
  authenticate: Middleware;
  requireAdmin: Middleware;
  /** Answers 404 while the switch is off. */
  pushGate: Middleware;
  devices: PushDevices;
  status: () => PushStatus;
  audit?: { record: (event: AuditEvent) => unknown };
  /** The tokens of the Live Activities and the gate that answers 404 while the Live Activity switch (or push) is off. */
  liveActivities?: LiveActivities;
  liveActivityGate?: Middleware;
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

  // The Live Activity of a robot on the lock screen: the phone sends the token of the activity it started, and takes it back when the activity ends.
  // While the switch of the Live Activity is off these answer 404 as if they did not exist.
  const { liveActivities, liveActivityGate } = deps;
  if (liveActivities && liveActivityGate) {
    app.post("/api/push/live-activities", authenticate, liveActivityGate, (req: any, res) => {
      const { activityToken, robotId } = req.body || {};
      if (!validActivityToken(activityToken)) return res.status(400).json({ error: "activityToken must be the hexadecimal token of the Live Activity" });
      if (!validRobotId(robotId)) return res.status(400).json({ error: "robotId must be a robot id of letters, digits and . _ : - (1 to 64 characters)" });
      try {
        liveActivities.register(activityToken, String(req.user?.username ?? ""), robotId);
      } catch (error) {
        if (error instanceof LiveActivityError) return res.status(error.status).json({ error: error.message });
        throw error;
      }
      audit?.record({ type: "live-activity-registered", outcome: "ok", userId: req.user?.id, username: req.user?.username, ip: req.ip, detail: { robotId } });
      res.json({ registered: true });
    });

    app.delete("/api/push/live-activities/:token", authenticate, liveActivityGate, (req: any, res) => {
      const token = String(req.params.token ?? "");
      if (!validActivityToken(token)) return res.status(400).json({ error: "token must be the hexadecimal token of the Live Activity" });
      const removed = liveActivities.remove(token, req.user?.role === "admin" ? null : String(req.user?.username ?? ""));
      if (removed) audit?.record({ type: "live-activity-removed", outcome: "ok", userId: req.user?.id, username: req.user?.username, ip: req.ip });
      res.json({ removed });
    });
  }

  app.get("/api/admin/push", authenticate, requireAdmin, (req, res) => {
    res.json(status());
  });
}
