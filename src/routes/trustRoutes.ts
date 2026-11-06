// =============================================================================
// HYDRA-UMC-SERVER - src/routes/trustRoutes.ts
// Copyright (C) 2026 JuanenRac (Electro Hobby 3D) <electrohobby3d@gmail.com>
// GPL-3.0-or-later - see LICENSE
// =============================================================================
// Three read/verify routes, each off (404) until its switch is "1": the verdicts of the anomaly detector, the signed record of the voice
// commands, and the check of a trajectory proposal signed with Ed25519. None of them moves hardware.
import express from "express";
import type { AuditLog } from "../auditLog";
import { apiRateLimiter } from "../auth";
import { switchOn, type Ingest } from "../ingestFeeds";
import { SWITCH_ANOMALY_FEED, VERDICTS, type VerdictName } from "../anomalyFeed";
import { SWITCH_VOICE_CHAIN } from "../voiceChain";
import { SWITCH_PROPOSAL_VERIFY, loadOperatorKeys, verifyProposal } from "../proposalVerify";

type Middleware = (req: any, res: any, next: any) => unknown;

export interface TrustDeps {
  authenticate: Middleware;
  requireAdmin: Middleware;
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

const MAX_BODY_BYTES = 16 * 1024;

export function registerTrustRoutes(app: express.Express, deps: TrustDeps): void {
  const { authenticate, requireAdmin, requireOperator, ingest, audit } = deps;
  const env = () => (typeof deps.env === "function" ? deps.env() : deps.env ?? process.env);
  const off = (name: string) => (_req: any, res: any, next: any) => (switchOn(name, env()) ? next() : res.status(404).json({ error: "not available" }));

  // The latest verdict of every series of the anomaly detector; `verdict=` narrows to one; `verify=1` checks the record of the changes.
  app.get("/api/anomaly/verdicts", apiRateLimiter, authenticate, off(SWITCH_ANOMALY_FEED), (req: any, res) => {
    const feed = ingest().anomaly;
    const only = typeof req.query.verdict === "string" ? req.query.verdict : "";
    if (only && !(VERDICTS as readonly string[]).includes(only)) return res.status(400).json({ error: `verdict must be one of ${VERDICTS.join(", ")}` });
    res.json({ verdicts: feed.verdicts((only || undefined) as VerdictName | undefined), chain: req.query.verify === "1" ? feed.log.verify() : undefined });
  });

  // The voice commands this server vouches for (administrator: the entries carry a hash of the person).
  app.get("/api/voice/chain", apiRateLimiter, authenticate, requireAdmin, off(SWITCH_VOICE_CHAIN), (req: any, res) => {
    const store = ingest().voice;
    res.json({ items: store.list(limitOf(req.query.limit), "voice"), chain: req.query.verify === "1" ? store.verify() : undefined });
  });

  // Is this proposal genuine, current and for this robot? The answer is a fact about the proposal, never an order.
  app.post("/api/trajectory/proposals/verify", apiRateLimiter, authenticate, requireOperator, off(SWITCH_PROPOSAL_VERIFY), (req: any, res) => {
    const body = req.body;
    if (!body || typeof body !== "object" || Array.isArray(body) || JSON.stringify(body).length > MAX_BODY_BYTES) {
      return res.status(400).json({ error: "the body must be a JSON object of at most 16 KiB" });
    }
    const robotId = body.expected_robot_id;
    if (typeof robotId !== "string" || !robotId.trim()) return res.status(400).json({ error: "expected_robot_id must be the id of the robot the proposal is for" });
    for (const name of ["expected_model_version", "expected_instruction_sha256"]) {
      if (body[name] !== undefined && typeof body[name] !== "string") return res.status(400).json({ error: `${name} must be a text` });
    }
    const keys = loadOperatorKeys(env());
    if (keys.size === 0) return res.status(503).json({ error: "no operator public key is listed on this server" });
    const result = verifyProposal(keys, body.proposal, {
      robotId, modelVersion: body.expected_model_version, instructionSha256: body.expected_instruction_sha256,
    });
    audit?.record({ type: "proposal-verify", outcome: result.valid ? "ok" : "refused", username: req.user?.username, detail: { robot_id: robotId, key_id: result.keyId, reason: result.reason || undefined } });
    return res.json({ valid: result.valid, reason: result.reason, key_id: result.keyId });
  });
}
