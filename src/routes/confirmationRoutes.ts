// =============================================================================
// HYDRA-UMC-SERVER - src/routes/confirmationRoutes.ts
// Copyright (C) 2026 JuanenRac (Electro Hobby 3D) <electrohobby3d@gmail.com>
// GPL-3.0-or-later - see LICENSE
// =============================================================================
// POST /api/operator/confirmations: issues the one-use token of the confirmation of a person (src/humanConfirmation.ts) for one action and one job, after the
// person confirmed on a screen. For an operator or an administrator; off by default (HYDRA_UMC_HUMAN_CONFIRMATION=1): a signed-in client gets 404 while it is off.
// With no usable key the route answers 503 and issues nothing. Every issue and every refusal is written to the audit record; the token itself never is.
import type express from "express";
import { issueConfirmation, parseConfirmationRequest } from "../humanConfirmation";

type Middleware = (req: any, res: any, next: any) => unknown;

export interface ConfirmationRouteDeps {
  authenticate: Middleware;
  requireOperator: Middleware;
  /** Whether the route is on (read on every request). */
  enabled: () => boolean;
  /** The key, or null while there is no usable one. */
  key: () => Buffer | null;
  audit?: { record(entry: { type: string; outcome: string; userId?: unknown; username?: string; ip?: string; detail?: unknown }): void };
  now?: () => number;
}

export function registerConfirmationRoutes(app: express.Express, deps: ConfirmationRouteDeps): void {
  const { authenticate, requireOperator } = deps;
  const gate: Middleware = (_req, res, next) => {
    if (!deps.enabled()) {
      res.status(404).end();
      return;
    }
    next();
  };
  const record = (req: any, outcome: string, detail: unknown): void => {
    try {
      deps.audit?.record({ type: "human-confirmation", outcome, userId: req.user?.id, username: req.user?.username, ip: req.ip, detail });
    } catch { /* an audit that cannot be written never turns a refusal into an issue */ }
  };

  app.post("/api/operator/confirmations", authenticate, gate, requireOperator, (req: any, res: any) => {
    const parsed = parseConfirmationRequest(req.body);
    if (!parsed.ok) {
      record(req, "refused", { code: parsed.code });
      return res.status(400).json({ error: parsed.error, code: parsed.code });
    }
    const key = deps.key();
    if (key === null) {
      record(req, "refused", { code: "confirmation-key-missing" });
      return res.status(503).json({ error: "no usable confirmation key is configured on this server", code: "confirmation-key-missing" });
    }
    const who = { username: String(req.user?.username ?? ""), role: req.user?.role === "admin" ? "administrator" : "operator" };
    const issued = issueConfirmation(key, who, parsed.request, deps.now ? deps.now() : Date.now());
    record(req, "ok", { action: issued.action, job_id: issued.job_id, expires_at: issued.expires_at });
    res.setHeader("Cache-Control", "no-store");
    res.json(issued);
  });
}
