// =============================================================================
// HYDRA-UMC-SERVER - src/routes/localAiRoutes.ts
// Copyright (C) 2026 JuanenRac (Electro Hobby 3D) <electrohobby3d@gmail.com>
// GPL-3.0 - see LICENSE
// =============================================================================
// The passthrough to the local AI services, moved out of server.ts unchanged.
import express from "express";
import { upstreamHeaders } from "../upstreamAuth";
import { roleForMethod } from "../serviceIdentity";

type Middleware = (req: any, res: any, next: any) => unknown;

/** Does the installation limit the local AI relay to administrators? Off unless `admin` (the relay then answers any signed-in user, as before). */
export function aiAccessAdminOnly(value: string | undefined): boolean {
  return (value ?? "").trim().toLowerCase() === "admin";
}

/** Does this request change something in the service (not just ask it)? Used to keep the writes that shape a model for administrators. */
export function isWriteToModel(service: string, method: string, upstreamPath: string, rulOpen = false): boolean {
  // The anomaly detector scores any window an operator sends (POST /detect) but its baseline and drift state are shared: fitting
  // or initialising them from any other POST would let one operator change what every other client is told is normal.
  if (service !== "anomaly-detector") return false;
  if (["GET", "HEAD", "OPTIONS"].includes(method)) return false;
  // The remaining-useful-life estimate only reads the points that come with the request; it is open to operators once the option is on.
  if (rulOpen && method === "POST" && upstreamPath === "/rul") return false;
  return upstreamPath !== "/detect";
}

/** What the remaining-useful-life relay is allowed (see RulFile in securityConfig.ts). */
export interface RulSettings { enabled: boolean; maxBodyBytes: number; maxPoints: number; timeoutMs: number }

function boundedInt(value: unknown, min: number, max: number, fallback: number): number {
  return typeof value === "number" && Number.isInteger(value) && value >= min && value <= max ? value : fallback;
}

/** The switch and the limits of the remaining-useful-life relay; a limit that is missing or invalid gives its default. */
export function rulSettings(enabled: boolean, file: unknown): RulSettings {
  const f = (typeof file === "object" && file !== null ? file : {}) as Record<string, unknown>;
  return {
    enabled,
    maxBodyBytes: boundedInt(f.maxBodyBytes, 1024, 1048576, 262144),
    maxPoints: boundedInt(f.maxPoints, 8, 100000, 5000),
    timeoutMs: boundedInt(f.timeoutMs, 500, 60000, 8000),
  };
}

/** What a client may read of the relay: the switch and the two limits it needs to size a request (nothing else). */
export interface RulConfigAnswer { enabled: boolean; maxPoints: number; timeoutMs: number }

/** The answer when the configuration is missing, damaged or cannot be read: closed, with the default limits. */
export const RUL_CONFIG_CLOSED: Readonly<RulConfigAnswer> = Object.freeze({ enabled: false, maxPoints: 5000, timeoutMs: 8000 });

/** The public part of the relay settings. Fail-closed: only a real `true` opens it, and anything unreadable gives the closed default. */
export function rulConfigAnswer(read: (() => RulSettings) | undefined): RulConfigAnswer {
  try {
    const settings = read?.();
    if (!settings) return { ...RUL_CONFIG_CLOSED };
    return {
      enabled: settings.enabled === true,
      maxPoints: boundedInt(settings.maxPoints, 8, 100000, RUL_CONFIG_CLOSED.maxPoints),
      timeoutMs: boundedInt(settings.timeoutMs, 500, 60000, RUL_CONFIG_CLOSED.timeoutMs),
    };
  } catch {
    return { ...RUL_CONFIG_CLOSED };
  }
}

/** GET /api/rul/config: read only, for any signed-in account (a viewer too); no secret, no path, nothing but the three fields. */
export function registerRulConfigRoute(app: express.Express, deps: { authenticate: Middleware; rul?: () => RulSettings }): void {
  app.get("/api/rul/config", deps.authenticate, (req, res) => {
    res.set("Cache-Control", "no-store");
    res.json(rulConfigAnswer(deps.rul));
  });
}

/** Is this the remaining-useful-life request the option opens? Only the exact POST /rul of the anomaly detector. */
export function isRulRequest(service: string, method: string, upstreamPath: string): boolean {
  return service === "anomaly-detector" && method === "POST" && upstreamPath === "/rul";
}

/** Checks the body of a remaining-useful-life request before it is forwarded; returns the error to answer, or null. */
export function rulBodyError(body: unknown, serialized: string, settings: RulSettings): { status: number; error: string } | null {
  if (Buffer.byteLength(serialized, "utf8") > settings.maxBodyBytes) return { status: 413, error: `the request is larger than ${settings.maxBodyBytes} bytes` };
  if (typeof body !== "object" || body === null || Array.isArray(body)) return { status: 400, error: "the body must be a JSON object with a list of points" };
  const points = (body as { points?: unknown }).points;
  if (!Array.isArray(points)) return { status: 400, error: "the body must be a JSON object with a list of points" };
  if (points.length > settings.maxPoints) return { status: 413, error: `more than ${settings.maxPoints} points` };
  return null;
}

/**
 * The services that are reached read-only, and the paths a client may ask of them. The data lake also takes writes and deletions
 * (ingest, retention) from the services that feed it; a signed-in user of the dashboard has no business sending those through
 * this relay, so everything but a read of the listed paths is refused before it is forwarded.
 */
export const READ_ONLY_SERVICE_PATHS: Readonly<Record<string, readonly string[]>> = {
  // "/windows" is there so that a client can tell whether the window statistics are switched on (the data lake answers 404 when they are not)
  datalake: ["/health", "/query", "/aggregate", "/stats", "/stats/range", "/series", "/windows"],
};

/**
 * The services of which a client may reach only a few exact requests (method and path), because the rest of what they offer moves things or
 * changes their state. The plan simulation of the semantic planner never executes anything (its answer says so); the dispatcher is read
 * for its estimates only. Whatever else is asked of them is refused here before it is forwarded.
 */
export const EXACT_SERVICE_REQUESTS: Readonly<Record<string, readonly string[]>> = {
  "semantic-planner": ["GET /health", "POST /plan/simulate", "POST /plan/trajectory-check"],
  "job-dispatcher": ["GET /health", "GET /dispatch/eta"],
};

/** Is this request allowed to go to the service? Services not in READ_ONLY_SERVICE_PATHS are forwarded as they always were. */
export function isForwardable(service: string, method: string, upstreamPath: string): boolean {
  const exact = EXACT_SERVICE_REQUESTS[service];
  if (exact) return exact.includes(`${method} ${upstreamPath}`);
  const allowed = READ_ONLY_SERVICE_PATHS[service];
  if (!allowed) return true;
  return (method === "GET" || method === "HEAD") && allowed.includes(upstreamPath);
}

/** The ports of the local AI services this server relays to, on 127.0.0.1. The registry of the SDK can correct them (HYDRA_UMC_AI_PORTS_FROM_REGISTRY=1, src/portsRegistry.ts). */
export const LOCAL_AI_SERVICE_PORTS: Record<string, number> = {
  "cognitive-node": 8096,
  "detection-hef": 8093,
  "visual-servoing-api": 8116,
  "vla-engine": 8098,
  "vision-node": 8094,
  "anomaly-detector": 8097,
  // the data lake behind the dashboard of the AI summaries: reads only (see READ_ONLY_SERVICE_PATHS)
  datalake: 8095,
  // the dry run of a plan (off in the planner until its own switch is on) and the estimates of the dispatcher (off until its own -eta): only the exact requests of EXACT_SERVICE_REQUESTS
  "semantic-planner": 8109,
  "job-dispatcher": 8090,
};

export function registerLocalAiRoutes(app: express.Express, deps: { authenticate: Middleware; requireAdmin?: Middleware; requireOperator?: Middleware; adminOnly?: boolean | (() => boolean); rul?: () => RulSettings; env?: NodeJS.ProcessEnv; aiPorts?: (defaults: Record<string, number>) => Record<string, number> }): void {
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

  app.all("/api/ai/:service/*rest", authenticate, aiAccess, async (req, res) => {
    const ports = deps.aiPorts ? deps.aiPorts(LOCAL_AI_SERVICE_PORTS) : LOCAL_AI_SERVICE_PORTS;
    const port = ports[req.params.service];
    if (port === undefined) {
      return res.status(404).json({
        error: `Unknown local AI service '${req.params.service}' - known services: ${Object.keys(ports).join(", ")}`,
      });
    }
    const restSegments = req.params.rest;
    const upstreamPath = "/" + (Array.isArray(restSegments) ? restSegments.join("/") : String(restSegments ?? ""));
    if (!isForwardable(req.params.service, req.method, upstreamPath)) {
      const offered = EXACT_SERVICE_REQUESTS[req.params.service] ?? READ_ONLY_SERVICE_PATHS[req.params.service];
      return res.status(403).json({ error: `Access denied: '${req.params.service}' is reached through this server only for ${offered.join(", ")}` });
    }
    const rul = deps.rul?.();
    const rulOpen = rul?.enabled === true;
    const isRul = rulOpen && isRulRequest(req.params.service, req.method, upstreamPath);
    if (isWriteToModel(req.params.service, req.method, upstreamPath, rulOpen) && (req as any).user?.role !== "admin") {
      return res.status(403).json({ error: "Access denied: changing the baseline of the anomaly detector needs administrator privileges" });
    }
    const queryString = req.url.includes("?") ? req.url.slice(req.url.indexOf("?")) : "";
    const url = `http://127.0.0.1:${port}${upstreamPath}${queryString}`;

    const hasBody = !["GET", "HEAD"].includes(req.method);
    const payload = hasBody ? JSON.stringify(req.body ?? {}) : undefined;
    if (isRul && rul) {
      const problem = rulBodyError(req.body, payload ?? "", rul);
      if (problem) return res.status(problem.status).json({ error: problem.error });
    }
    const controller = new AbortController();
    const connectTimeout = setTimeout(() => controller.abort(), isRul && rul ? rul.timeoutMs : 10000);
    let upstream: Response;
    // the Bearer token of this service, when it has one: only this server holds it, a client never sees it
    const headers: Record<string, string> = { ...upstreamHeaders(req.params.service, deps.env ?? process.env, undefined, roleForMethod(req.method)), ...(hasBody ? { "Content-Type": "application/json" } : {}) };
    try {
      upstream = await fetch(url, {
        method: req.method,
        headers: Object.keys(headers).length > 0 ? headers : undefined,
        body: payload,
        signal: controller.signal,
      });
    } catch {
      return res.status(503).json({
        error: `Local AI service '${req.params.service}' is not reachable on 127.0.0.1:${port} - is hydra-umc-${req.params.service}.service running?`,
        available: false,
      });
    } finally {
      if (!isRul) clearTimeout(connectTimeout);
    }
    // the estimate keeps its deadline while the answer is read, so a detector that stalls cannot hold the connection
    let text: string;
    try {
      text = await upstream.text();
    } catch (error) {
      if (!isRul) throw error;
      return res.status(503).json({ error: `Local AI service '${req.params.service}' did not answer in time`, available: false });
    } finally {
      clearTimeout(connectTimeout);
    }
    res.status(upstream.status);
    res.setHeader("Content-Type", upstream.headers.get("content-type") || "application/json");
    res.send(text);
  });
}
