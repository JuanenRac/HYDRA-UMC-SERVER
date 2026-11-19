// =============================================================================
// HYDRA-UMC-SERVER - src/routes/updateRoutes.ts
// Copyright (C) 2026 JuanenRac (Electro Hobby 3D) <electrohobby3d@gmail.com>
// GPL-3.0-or-later - see LICENSE
// =============================================================================
// GET /api/admin/updates: what is installed here set against the newest published version of each program (src/updateCheck.ts). An
// administrator only, and off by default (updateCheck.enabled): while it is off the route answers 404 and the server asks GitHub for nothing.
// POST /api/admin/updates/manifest/check: whether an UpdateManifest would pass the signature rule (src/manifestSigning.ts) against the list of public keys named by
// `updateManifest.trustedKeysFile` of the server configuration. It reads the list on every call, installs nothing and keeps nothing; the verdict also says whether
// the switch `production.requireAsymmetricSignature` (off by default) was on, which decides whether a manifest without a signature passes as `legacy`.
import express from "express";
import fs from "node:fs";
import { apiRateLimiter } from "../auth";
import { KeyListError, manifestKeysFromJson, verifyManifest, type TrustedManifestKey } from "../manifestSigning";
import type { EcosystemProjectStatus } from "../ecosystemStatus";
import { UpdateChecker, type FetchLike, type UpdateCheckSettings } from "../updateCheck";

type Middleware = (req: any, res: any, next: any) => unknown;

export interface UpdateRouteDeps {
  authenticate: Middleware;
  requireAdmin: Middleware;
  enabled: () => boolean;
  getStatus: () => Promise<{ available: boolean; projects: EcosystemProjectStatus[] }>;
  config: () => UpdateCheckSettings | undefined;
  /** For tests: the way GitHub is asked. */
  fetch?: FetchLike;
  now?: () => number;
  /** The file with the trusted public keys (`updateManifest.trustedKeysFile`); empty or absent: the manifest check answers 503. */
  manifestKeysFile?: () => string | undefined;
  /** Whether a manifest without an Ed25519 signature is refused (production.requireAsymmetricSignature, off by default). */
  requireAsymmetricSignature?: () => boolean;
}

/** The trusted keys of the file, or why they cannot be used (the reason never names the path or the content). */
export function readManifestKeys(file: string | undefined): { keys: TrustedManifestKey[] } | { error: string } {
  if (typeof file !== "string" || file.trim() === "") return { error: "No list of trusted keys is configured (updateManifest.trustedKeysFile)" };
  let text: string;
  try { text = fs.readFileSync(file, "utf-8"); } catch { return { error: "The list of trusted keys cannot be read" }; }
  try { return { keys: manifestKeysFromJson(text) }; } catch (error) {
    return { error: error instanceof KeyListError ? `The list of trusted keys is not valid: ${error.message}` : "The list of trusted keys is not valid" };
  }
}

export function registerUpdateRoutes(app: express.Express, deps: UpdateRouteDeps): void {
  const { authenticate, requireAdmin } = deps;
  const checker = new UpdateChecker({
    projects: async () => (await deps.getStatus()).projects,
    settings: deps.config,
    fetch: deps.fetch,
    now: deps.now,
  });

  // `refresh=1` asks for a new look instead of the kept one (never more often than every ten minutes: the answer is the kept one until then).
  app.get("/api/admin/updates", apiRateLimiter, authenticate, requireAdmin, (req: any, res) => {
    if (!deps.enabled()) return res.status(404).json({ error: "Not found" });
    checker.report(req.query.refresh === "1").then(
      (report) => res.json(report),
      () => res.status(503).json({ error: "The newest versions could not be looked up" }),
    );
  });

  // The verdict is always 200: a manifest that is refused is an answer, not a failure of the request (`accepted` and `code` say it).
  app.post("/api/admin/updates/manifest/check", apiRateLimiter, authenticate, requireAdmin, (req: any, res) => {
    const body = req.body;
    if (typeof body !== "object" || body === null || Array.isArray(body)) return res.status(400).json({ error: "The body must be an UpdateManifest object" });
    const list = readManifestKeys(deps.manifestKeysFile?.());
    if ("error" in list) return res.status(503).json({ error: list.error });
    const required = deps.requireAsymmetricSignature?.() ?? false;
    const verdict = verifyManifest(body, list.keys, (deps.now ?? Date.now)(), required);
    return res.json({ accepted: verdict.accepted, code: verdict.code, key_id: verdict.keyId, require_asymmetric_signature: required });
  });
}
