// =============================================================================
// HYDRA-UMC-SERVER - src/routes/bridgeRoutes.ts
// Copyright (C) 2026 JuanenRac (Electro Hobby 3D) <electrohobby3d@gmail.com>
// GPL-3.0-or-later - see LICENSE
// =============================================================================
// The gateway to the machine bridges (src/bridgeGateway.ts): GET /api/bridges and GET /api/bridges/:name/state for any signed-in account, and
// POST /api/bridges/:name/cmd/:verb for an operator or an administrator, who is recorded in the audit log with the bridge and the verb (never
// with the parameters). Behind the switch bridgeGateway.enabled (off by default: a signed-in client then gets 404, as if the routes did not exist).
import express from "express";
import { validBridgeName, validBridgeVerb, type BridgeGateway } from "../bridgeGateway";

type Middleware = (req: any, res: any, next: any) => unknown;

export interface BridgeRouteDeps {
  authenticate: Middleware;
  requireOperator: Middleware;
  /** Answers 404 while the switch is off. */
  bridgeGatewayGate: Middleware;
  gateway: BridgeGateway;
  audit?: { record: (event: any) => unknown };
}

/** The gate for the switch: a signed-in client gets 404 while it is off. */
export function makeBridgeGatewayGate(isEnabled: () => boolean): Middleware {
  return (_req, res, next) => {
    if (!isEnabled()) {
      res.status(404).end();
      return;
    }
    next();
  };
}

export function registerBridgeRoutes(app: express.Express, deps: BridgeRouteDeps): void {
  const { authenticate, requireOperator, bridgeGatewayGate, gateway, audit } = deps;
  const ensure = (_req: any, _res: any, next: any) => {
    gateway.ensureStarted();
    next();
  };

  app.get("/api/bridges", authenticate, bridgeGatewayGate, ensure, (req: any, res: any) => {
    res.json({ connected: gateway.isConnected(), bridges: gateway.list() });
  });

  app.get("/api/bridges/:name/state", authenticate, bridgeGatewayGate, ensure, (req: any, res: any) => {
    const name = req.params.name;
    if (!validBridgeName(name)) return res.status(400).json({ error: "The name of the bridge is not valid." });
    const view = gateway.get(name);
    if (!view) return res.status(gateway.isConnected() ? 404 : 503).json({ error: gateway.isConnected() ? "Bridge not found." : "The broker is not connected." });
    res.json(view);
  });

  app.post("/api/bridges/:name/cmd/:verb", authenticate, bridgeGatewayGate, requireOperator, ensure, async (req: any, res: any) => {
    const { name, verb } = req.params;
    const who = { userId: req.user?.id, username: req.user?.username, ip: req.ip };
    if (!validBridgeName(name) || !validBridgeVerb(verb)) return res.status(400).json({ error: "The name of the bridge or the command is not valid." });
    const outcome = await gateway.command(name, verb, req.body && Object.keys(req.body).length > 0 ? req.body : undefined);
    audit?.record({ type: "bridge-command", outcome: outcome.status >= 200 && outcome.status < 300 ? "ok" : outcome.status >= 500 ? "failed" : "refused", ...who, detail: { bridge: name, verb, status: outcome.status } });
    res.status(outcome.status).json(outcome.body);
  });
}
