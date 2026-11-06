// =============================================================================
// HYDRA-UMC-SERVER - src/routes/ingestRoutes.ts
// Copyright (C) 2026 JuanenRac (Electro Hobby 3D) <electrohobby3d@gmail.com>
// GPL-3.0-or-later - see LICENSE
// =============================================================================
// Where the sibling services hand their state to this server (see src/ingestFeeds.ts). Every route is off (404) until its switch is
// "1" in the environment. Writes are validated against the shared contract, stored in a signed hash-chained record with a retention,
// and audited. Reads need a signed-in account. The developer node signs in with the token of that node (never a user account).
import express from "express";
import type { AuditLog } from "../auditLog";
import { apiRateLimiter } from "../auth";
import {
  ALLOW_PLAIN_HTTP, MAX_BODY_BYTES, SWITCH_DEVELOPER_NODE, SWITCH_FAULT_FEED, SWITCH_SCENARIO,
  developerNodeStatusProblem, nodeIdForToken, scenarioOutcomeProblem, switchOn, transportAcceptable, type Ingest,
} from "../ingestFeeds";

type Middleware = (req: any, res: any, next: any) => unknown;

export interface IngestDeps {
  authenticate: Middleware;
  requireOperator: Middleware;
  ingest: () => Ingest;
  audit?: Pick<AuditLog, "record">;
  /** The environment the switches are read from, or a function that gives it each time (the saved switches of Server Admin are put in it). */
  env?: Record<string, string | undefined> | (() => Record<string, string | undefined>);
}

const limitOf = (value: unknown, fallback = 100): number => {
  const n = Number(value);
  return Number.isInteger(n) && n >= 1 ? Math.min(n, 1000) : fallback;
};

export function registerIngestRoutes(app: express.Express, deps: IngestDeps): void {
  const { authenticate, requireOperator, ingest, audit } = deps;
  const env = () => (typeof deps.env === "function" ? deps.env() : deps.env ?? process.env);
  const off = (name: string) => (_req: any, res: any, next: any) => (switchOn(name, env()) ? next() : res.status(404).json({ error: "not available" }));
  const scenarioOn = off(SWITCH_SCENARIO);
  const developerOn = off(SWITCH_DEVELOPER_NODE);
  const faultsOn = off(SWITCH_FAULT_FEED);
  const tooBig = (body: unknown) => JSON.stringify(body ?? null).length > MAX_BODY_BYTES;

  // The token of a developer node: 401 with no token or one that no node owns (also while the feature is off, so the answer does not
  // tell a stranger whether it is on); 403 over plain HTTP; the id of the node is put on the request.
  const nodeToken: Middleware = (req, res, next) => {
    const header = String(req.headers?.authorization ?? "");
    const token = header.toLowerCase().startsWith("bearer ") ? header.slice(7).trim() : "";
    const node = token ? nodeIdForToken(token, env()) : null;
    if (!node || !switchOn(SWITCH_DEVELOPER_NODE, env())) return res.status(401).json({ error: "a valid node token is required" });
    const claimed = String(req.headers?.["x-node-id"] ?? "").trim();
    if (claimed && claimed !== node) return res.status(401).json({ error: "the token does not belong to that node" });
    if (!transportAcceptable(req, env())) return res.status(403).json({ error: `HTTPS is required (${ALLOW_PLAIN_HTTP}=1 allows plain HTTP on a bench)` });
    req.nodeId = node;
    return next();
  };

  app.post("/api/ingest/scenario-outcome", apiRateLimiter, authenticate, requireOperator, scenarioOn, (req: any, res) => {
    const problem = tooBig(req.body) ? "the body is too large" : scenarioOutcomeProblem(req.body);
    if (problem) {
      audit?.record({ type: "ingest-scenario", outcome: "refused", username: req.user?.username, detail: { problem } });
      return res.status(400).json({ error: problem });
    }
    try {
      const record = ingest().scenario.append("scenario-outcome", req.body);
      audit?.record({ type: "ingest-scenario", outcome: "ok", username: req.user?.username, detail: { seq: record.seq, scenario_id: req.body.scenario_id, run_id: req.body.run_id } });
      return res.status(201).json({ seq: record.seq, hash: record.hash });
    } catch (error) {
      audit?.record({ type: "ingest-scenario", outcome: "failed", username: req.user?.username });
      return res.status(503).json({ error: "the record is not available: the signing key of this server is not usable" });
    }
  });

  app.get("/api/ingest/scenario-outcomes", apiRateLimiter, authenticate, scenarioOn, (req: any, res) => {
    const store = ingest().scenario;
    const scenario = typeof req.query.scenario_id === "string" ? req.query.scenario_id : "";
    let items = store.list(limitOf(req.query.limit), "scenario-outcome");
    if (scenario) items = items.filter((r) => (r.payload as any)?.scenario_id === scenario);
    res.json({ items, chain: req.query.verify === "1" ? store.verify() : undefined });
  });

  app.post("/api/ingest/developer-node/status", apiRateLimiter, nodeToken, developerOn, (req: any, res) => {
    const problem = tooBig(req.body) ? "the body is too large" : developerNodeStatusProblem(req.body);
    if (problem) return res.status(400).json({ error: problem });
    try {
      const record = ingest().developerNode.append("developer-node-status", { node_id: req.nodeId, status: req.body });
      return res.status(201).json({ node_id: req.nodeId, seq: record.seq });
    } catch (error) {
      return res.status(503).json({ error: "the record is not available: the signing key of this server is not usable" });
    }
  });

  app.get("/api/developer-node/status", apiRateLimiter, authenticate, developerOn, (req: any, res) => {
    const store = ingest().developerNode;
    const latest = new Map<string, { at: number; seq: number; status: unknown }>();
    for (const r of store.list(Number.MAX_SAFE_INTEGER, "developer-node-status")) {
      const p = r.payload as { node_id: string; status: unknown };
      if (!latest.has(p.node_id)) latest.set(p.node_id, { at: r.at, seq: r.seq, status: p.status });
    }
    res.json({ nodes: Object.fromEntries(latest), chain: req.query.verify === "1" ? store.verify() : undefined });
  });

  app.get("/api/faults", apiRateLimiter, authenticate, faultsOn, (req: any, res) => {
    const feed = ingest().faults;
    res.json({ active: feed.activeFaults(), recent: req.query.active === "1" ? undefined : feed.recent(limitOf(req.query.limit)), chain: req.query.verify === "1" ? feed.log.verify() : undefined });
  });
}
