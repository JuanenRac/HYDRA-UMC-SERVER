// =============================================================================
// HYDRA-UMC-SERVER - src/routes/presenceRoutes.ts
// Copyright (C) 2026 JuanenRac (Electro Hobby 3D) <electrohobby3d@gmail.com>
// GPL-3.0-or-later - see LICENSE
// =============================================================================
// POST /api/operator/presence: the heartbeat of the person who drives the robots (src/operatorPresence.ts). GET /api/operator/presence: how the
// server sees the signed-in account (its own state only). For an operator or an administrator, behind the switch presence.enabled (off by default:
// a signed-in client then gets 404, as if the route did not exist). The heartbeat is idempotent by its sequence number.
import express from "express";
import { parsePresenceBeat, type OperatorPresence } from "../operatorPresence";

type Middleware = (req: any, res: any, next: any) => unknown;

export interface PresenceRouteDeps {
  authenticate: Middleware;
  requireOperator: Middleware;
  /** Answers 404 while the switch is off. */
  presenceGate: Middleware;
  presence: OperatorPresence;
}

/** The gate for the switch: a signed-in client gets 404 while it is off. */
export function makePresenceGate(isEnabled: () => boolean): Middleware {
  return (_req, res, next) => {
    if (!isEnabled()) {
      res.status(404).end();
      return;
    }
    next();
  };
}

export function registerPresenceRoutes(app: express.Express, deps: PresenceRouteDeps): void {
  const { authenticate, requireOperator, presenceGate, presence } = deps;

  app.post("/api/operator/presence", authenticate, presenceGate, requireOperator, (req: any, res: any) => {
    const parsed = parsePresenceBeat(req.body);
    if (!parsed.ok) return res.status(400).json({ error: parsed.error, code: "invalid-presence-heartbeat" });
    const { result, state } = presence.beat({ id: req.user?.id, username: req.user?.username }, parsed.beat);
    const status = presence.status(req.user?.id);
    res.json({ accepted: result === "accepted", duplicate: result === "duplicate", stale: result === "stale", state, sequence: parsed.beat.sequence, action: status.action, timeoutSeconds: status.timeoutSeconds });
  });

  app.get("/api/operator/presence", authenticate, presenceGate, requireOperator, (req: any, res: any) => {
    res.json(presence.status(req.user?.id));
  });
}
