// =============================================================================
// HYDRA-UMC-SERVER - src/routes/localAiRoutes.ts
// Copyright (C) 2026 JuanenRac (Electro Hobby 3D) <electrohobby3d@gmail.com>
// GPL-3.0 - see LICENSE
// =============================================================================
// The passthrough to the local AI services, moved out of server.ts unchanged.
import express from "express";
import { upstreamHeaders } from "../upstreamAuth";

type Middleware = (req: any, res: any, next: any) => unknown;

/** Does the installation limit the local AI relay to administrators? Off unless `admin` (the relay then answers any signed-in user, as before). */
export function aiAccessAdminOnly(value: string | undefined): boolean {
  return (value ?? "").trim().toLowerCase() === "admin";
}

/** Does this request change something in the service (not just ask it)? Used to keep the writes that shape a model for administrators. */
export function isWriteToModel(service: string, method: string, upstreamPath: string): boolean {
  // The anomaly detector scores any window an operator sends (POST /detect) but its baseline and drift state are shared: fitting
  // or initialising them from any other POST would let one operator change what every other client is told is normal.
  if (service !== "anomaly-detector") return false;
  if (["GET", "HEAD", "OPTIONS"].includes(method)) return false;
  return upstreamPath !== "/detect";
}

export function registerLocalAiRoutes(app: express.Express, deps: { authenticate: Middleware; requireAdmin?: Middleware; requireOperator?: Middleware; adminOnly?: boolean | (() => boolean); env?: NodeJS.ProcessEnv }): void {
  const { authenticate, requireAdmin, requireOperator } = deps;
  const isAdminOnly = () => (typeof deps.adminOnly === "function" ? deps.adminOnly() : deps.adminOnly === true);
  // HYDRA_UMC_AI_ACCESS=admin: only administrators may use the relay (it reaches services that can move robots or run models).
  // Whatever that setting says, the session must be an administrator or an operator: any other role is refused before a request
  // is forwarded, and the services hold their own Bearer token that only this server presents (see upstreamAuth.ts).
  const aiAccess: Middleware = (req, res, next) => {
    const afterRole: Middleware = (rq, rs, nx) => (isAdminOnly() && requireAdmin ? requireAdmin(rq, rs, nx) : nx());
    return requireOperator ? requireOperator(req, res, () => afterRole(req, res, next)) : afterRole(req, res, next);
  };
  // Real proxy to this cell's own local Hailo-accelerated AI services -
  // each one already runs as its own real systemd unit
  // (hydra-umc-<service>.service), bound to 127.0.0.1 only by design
  // (same loopback-only posture DATALAKE/ANOMALY-DETECTOR already use),
  // so nothing outside this host could ever reach them directly. Before
  // this route, that was true even for a legitimate development/control
  // machine on the same LAN or over the same remote-access path already
  // used for everything else this server exposes - there was no real
  // path in, at all, to a service's own real endpoints (only
  // /api/ecosystem/status's generic start/stop/health check, which
  // never relays an actual request). Real passthrough, not a
  // reimplementation: the upstream's own path, method, query string,
  // JSON body and status code all pass through unchanged, so this
  // route's own behavior can never drift from what each service's own
  // api.py actually does. Every one of these still honestly reports
  // "not ready" for real inference until a Hailo module and a loaded
  // model exist - this only carries that answer through the network,
  // it doesn't change it.
  const LOCAL_AI_SERVICE_PORTS: Record<string, number> = {
    "cognitive-node": 8096,
    "detection-hef": 8093,
    "visual-servoing-api": 8116,
    "vla-engine": 8098,
    "vision-node": 8094,
    "anomaly-detector": 8097,
  };

  app.all("/api/ai/:service/*rest", authenticate, aiAccess, async (req, res) => {
    const port = LOCAL_AI_SERVICE_PORTS[req.params.service];
    if (port === undefined) {
      return res.status(404).json({
        error: `Unknown local AI service '${req.params.service}' - known services: ${Object.keys(LOCAL_AI_SERVICE_PORTS).join(", ")}`,
      });
    }
    const restSegments = req.params.rest;
    const upstreamPath = "/" + (Array.isArray(restSegments) ? restSegments.join("/") : String(restSegments ?? ""));
    if (isWriteToModel(req.params.service, req.method, upstreamPath) && (req as any).user?.role !== "admin") {
      return res.status(403).json({ error: "Access denied: changing the baseline of the anomaly detector needs administrator privileges" });
    }
    const queryString = req.url.includes("?") ? req.url.slice(req.url.indexOf("?")) : "";
    const url = `http://127.0.0.1:${port}${upstreamPath}${queryString}`;

    const hasBody = !["GET", "HEAD"].includes(req.method);
    const controller = new AbortController();
    const connectTimeout = setTimeout(() => controller.abort(), 10000);
    let upstream: Response;
    // the Bearer token of this service, when it has one: only this server holds it, a client never sees it
    const headers: Record<string, string> = { ...upstreamHeaders(req.params.service, deps.env ?? process.env), ...(hasBody ? { "Content-Type": "application/json" } : {}) };
    try {
      upstream = await fetch(url, {
        method: req.method,
        headers: Object.keys(headers).length > 0 ? headers : undefined,
        body: hasBody ? JSON.stringify(req.body ?? {}) : undefined,
        signal: controller.signal,
      });
    } catch {
      return res.status(503).json({
        error: `Local AI service '${req.params.service}' is not reachable on 127.0.0.1:${port} - is hydra-umc-${req.params.service}.service running?`,
        available: false,
      });
    } finally {
      clearTimeout(connectTimeout);
    }
    const text = await upstream.text();
    res.status(upstream.status);
    res.setHeader("Content-Type", upstream.headers.get("content-type") || "application/json");
    res.send(text);
  });
}
