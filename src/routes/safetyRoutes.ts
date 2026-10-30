// =============================================================================
// HYDRA-UMC-SERVER - src/routes/safetyRoutes.ts
// Copyright (C) 2026 JuanenRac (Electro Hobby 3D) <electrohobby3d@gmail.com>
// GPL-3.0-or-later - see LICENSE
// =============================================================================
// The safety limits every client is held to (read by any signed-in client, changed by an
// administrator), the explicit arming of the jog, and the list of who controls which robot.
import express from "express";
import { readControllerId, claimConflict, listClaims } from "../claimPolicy";
import type { AuditLog } from "../auditLog";
import { HARD_LIMITS, SafetyLimitsError, defaultSafetyConfig, type JogArming, type SafetyLimits } from "../safetyLimits";

type Middleware = (req: any, res: any, next: any) => unknown;

export interface SafetyRouteDeps {
  authenticate: Middleware;
  requireAdmin: Middleware;
  getSettings: () => any;
  findRobotById: (robotId: number) => any;
  isReservationActive: (reservation: any) => boolean;
  safety: SafetyLimits;
  arming: JogArming;
  /** The audit record; without it nothing is recorded. */
  audit?: AuditLog;
  /** Called after a claim or an arming changed (pushes the `claims` message of the WebSocket). */
  onClaimsChanged?: () => void;
}

export function registerSafetyRoutes(app: express.Express, deps: SafetyRouteDeps): void {
  const { authenticate, requireAdmin, getSettings, findRobotById, isReservationActive, safety, arming, audit, onClaimsChanged } = deps;

  const view = (robotId?: number) => {
    const robot = robotId !== undefined ? findRobotById(robotId) : null;
    return {
      limits: safety.get(),
      defaults: defaultSafetyConfig(),
      hardLimits: HARD_LIMITS,
      ...(robot ? { robot: { id: robot.id, model: robot.model ?? null, jog: safety.jogFor(robot.model), temperature: safety.temperatureFor(robot.model), jogArmedUntil: arming.expiresAt(robot.id) } } : {}),
    };
  };

  // Every client reads the same limits here instead of keeping its own copy.
  app.get("/api/safety-limits", authenticate, (req, res) => {
    const raw = req.query.robotId;
    const robotId = raw === undefined ? undefined : parseInt(String(raw), 10);
    if (robotId !== undefined && !Number.isInteger(robotId)) return res.status(400).json({ error: "robotId must be an integer" });
    if (robotId !== undefined && !findRobotById(robotId)) return res.status(404).json({ error: "Robot not found" });
    res.json(view(robotId));
  });

  app.put("/api/admin/safety-limits", authenticate, requireAdmin, async (req, res) => {
    try {
      await safety.update(req.body, String((req as any).user?.username ?? "admin"));
    } catch (error) {
      if (error instanceof SafetyLimitsError) {
        audit?.record({ type: "safety-limits", outcome: "refused", userId: (req as any).user?.id, username: (req as any).user?.username, ip: req.ip, detail: { reason: error.message } });
        return res.status(400).json({ error: error.message });
      }
      throw error;
    }
    audit?.setEnabled(safety.get().audit.enabled);
    audit?.record({ type: "safety-limits", outcome: "ok", userId: (req as any).user?.id, username: (req as any).user?.username, ip: req.ip, detail: { patch: req.body } });
    res.json({ success: true, ...view() });
  });

  // The explicit arming of the jog. It is always available; it is only demanded while jog.armRequired is on.
  app.post("/api/robot/:id/jog-arm", authenticate, (req, res) => {
    const robotId = parseInt(req.params.id, 10);
    const robot = findRobotById(robotId);
    if (!robot) return res.status(404).json({ error: "Robot not found" });
    const user = (req as any).user;
    const controllerId = readControllerId(req.headers?.["x-controller-id"], req.body?.controllerId);
    if (controllerId === null) return res.status(400).json({ error: "controllerId must be 1 to 64 characters: letters, digits, . _ : -", code: "invalid-controller-id" });
    if (typeof req.body?.armed !== "boolean") return res.status(400).json({ error: "armed must be true or false" });
    const who = { userId: user?.id, username: user?.username, controllerId, ip: req.ip, robotId };
    if (!req.body.armed) {
      arming.disarm(robotId);
      audit?.record({ type: "jog-arm", outcome: "ok", ...who, detail: { armed: false } });
      onClaimsChanged?.();
      return res.json({ success: true, armed: false });
    }
    if (robot.enabled === false) return res.status(423).json({ error: `robot ${robotId} is disabled (safe mode): enable it first`, code: "robot-disabled", robotId });
    const conflict = claimConflict(robot.reservation, user, controllerId, isReservationActive);
    if (conflict) audit?.record({ type: "jog-arm", outcome: "refused", ...who, detail: { reason: conflict.reason } });
    if (conflict) return res.status(409).json({ error: conflict.message, code: conflict.reason, reservation: robot.reservation });
    const limits = safety.get().jog;
    const requested = typeof req.body.ttlMs === "number" && Number.isFinite(req.body.ttlMs) ? req.body.ttlMs : limits.armTtlMs;
    const ttlMs = Math.min(Math.max(requested, HARD_LIMITS.armTtlMs.min), limits.armTtlMs);
    const expiresAt = arming.arm(robotId, user.id, controllerId, ttlMs);
    audit?.record({ type: "jog-arm", outcome: "ok", ...who, detail: { armed: true, ttlMs } });
    onClaimsChanged?.();
    res.json({ success: true, armed: true, expiresAt, ttlMs });
  });

  // Who controls which robot, for every robot that has an active claim.
  app.get("/api/claims", authenticate, (req, res) => {
    res.json({ claims: listClaims(getSettings(), isReservationActive, (id) => arming.expiresAt(id)) });
  });

  // The audit record (administrators only): the newest entries, oldest first. ?limit= (1-1000, default 100), ?afterSeq=, ?type=, ?robotId=,
  // ?verify=1 checks the hash chain, ?format=jsonl downloads the lines as they are stored.
  app.get("/api/audit", authenticate, requireAdmin, (req, res) => {
    if (!audit) return res.status(404).json({ error: "the audit record is not available", code: "audit-unavailable" });
    const num = (value: unknown): number | undefined => {
      if (value === undefined) return undefined;
      const n = Number(value);
      return Number.isFinite(n) ? n : undefined;
    };
    const entries = audit.read({
      limit: num(req.query.limit),
      afterSeq: num(req.query.afterSeq),
      type: typeof req.query.type === "string" ? req.query.type : undefined,
      robotId: num(req.query.robotId),
    });
    if (req.query.format === "jsonl") {
      res.setHeader("Content-Type", "application/x-ndjson");
      res.setHeader("Content-Disposition", "attachment; filename=\"audit.jsonl\"");
      return res.send(entries.map((e) => JSON.stringify(e)).join("\n") + (entries.length ? "\n" : ""));
    }
    res.json({
      enabled: audit.enabled,
      lockedOff: audit.lockedOff,
      entries,
      ...(req.query.verify === "1" || req.query.verify === "true" ? { verification: audit.verify() } : {}),
    });
  });
}
