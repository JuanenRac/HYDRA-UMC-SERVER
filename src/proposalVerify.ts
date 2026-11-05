// =============================================================================
// HYDRA-UMC-SERVER - src/proposalVerify.ts
// Copyright (C) 2026 JuanenRac (Electro Hobby 3D) <electrohobby3d@gmail.com>
// GPL-3.0-or-later - see LICENSE
// =============================================================================
// The check of a trajectory proposal signed with Ed25519 (the same rules as `verify_proposal` of HYDRA-UMC-VLA-ENGINE). The server holds
// only PUBLIC keys: the operators' keys are listed in a file of this installation, {"keys": {"<key id>": "<public key, 64 hex>"}}, where the
// key id is the first eight bytes of the SHA-512 of the public key (the same id the image keys of the firmware use). The verification uses
// the Ed25519 of Node itself, so no library is added. Nothing here moves hardware: it only says whether a proposal is genuine, current and
// meant for the robot and, when asked, for the model and the instruction.
import crypto from "node:crypto";
import fs from "node:fs";

export type Env = Record<string, string | undefined>;

export const SWITCH_PROPOSAL_VERIFY = "HYDRA_UMC_PROPOSAL_VERIFY";
export const PROPOSAL_KEYS_FILE = "HYDRA_UMC_PROPOSAL_KEYS_FILE";

export const MAX_VALIDITY_MS = 600_000;
export const CLOCK_SKEW_MS = 5_000;
export const MESSAGE_DOMAIN = "hydra-umc-vla-proposal-ed25519-v1";

const SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

/** The id of a public key: the first eight bytes of its SHA-512, in lowercase hex. */
export function keyIdOf(publicKey: Buffer): string {
  return crypto.createHash("sha512").update(publicKey).digest().subarray(0, 8).toString("hex");
}

/** The operators' public keys of this installation, by key id. Entries that are not a 32-byte key with its own id are left out; no file means no key. */
export function loadOperatorKeys(env: Env = process.env): Map<string, Buffer> {
  const keys = new Map<string, Buffer>();
  const file = (env[PROPOSAL_KEYS_FILE] ?? "").trim();
  if (!file) return keys;
  let doc: any;
  try { doc = JSON.parse(fs.readFileSync(file, "utf8")); } catch { return keys; }
  for (const [id, hex] of Object.entries(doc?.keys ?? {})) {
    if (typeof hex !== "string" || !/^[0-9a-fA-F]{64}$/.test(hex)) continue;
    const key = Buffer.from(hex, "hex");
    if (keyIdOf(key) === id.toLowerCase()) keys.set(id.toLowerCase(), key);
  }
  return keys;
}

/** The bytes that are signed; each part is written as its length in bytes, a colon and the part, so no two sets of parts give the same bytes. */
export function proposalMessage(p: { fingerprint: string; robot_id: string; issued_at_ms: number; expires_at_ms: number; model_version: string; instruction_sha256: string; key_id: string }): Buffer {
  const parts = [MESSAGE_DOMAIN, p.fingerprint, p.robot_id, String(p.issued_at_ms), String(p.expires_at_ms), p.model_version, p.instruction_sha256, p.key_id];
  return Buffer.concat(parts.map((part) => { const body = Buffer.from(part, "utf8"); return Buffer.concat([Buffer.from(`${body.length}:`, "ascii"), body]); }));
}

export interface ProposalCheck { valid: boolean; reason: string; keyId?: string }

export interface ProposalExpectations { robotId: string; modelVersion?: string; instructionSha256?: string; nowMs?: number }

const isTime = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v > 0;

/** `valid` is true when the proposal is signed by a listed key, is current, and is for the robot (and the model and instruction when they are given). `reason` says why not. */
export function verifyProposal(keys: Map<string, Buffer>, proposal: unknown, expected: ProposalExpectations): ProposalCheck {
  const no = (reason: string): ProposalCheck => ({ valid: false, reason });
  if (!proposal || typeof proposal !== "object" || Array.isArray(proposal)) return no("the proposal is not signed");
  const p = proposal as Record<string, unknown>;
  const { fingerprint, robot_id: robotId, signature, key_id: keyId } = p;
  const issued = p.issued_at_ms, expires = p.expires_at_ms;
  const modelVersion = p.model_version ?? "", instruction = p.instruction_sha256 ?? "";
  if (typeof fingerprint !== "string" || typeof robotId !== "string" || typeof signature !== "string" || typeof keyId !== "string"
      || typeof modelVersion !== "string" || typeof instruction !== "string") return no("the proposal is not signed");
  if (p.signature_alg !== "ed25519") return no("the proposal is not signed with ed25519");
  if (!isTime(issued) || !isTime(expires)) return no("the proposal has no valid time window");
  if (!/^[0-9a-f]{128}$/.test(signature)) return no("the signature of the proposal does not match");
  const key = keys.get(keyId);
  if (!key) return no("the proposal is signed by a key that is not listed");
  const publicKey = crypto.createPublicKey({ key: Buffer.concat([SPKI_PREFIX, key]), format: "der", type: "spki" });
  const message = proposalMessage({ fingerprint, robot_id: robotId, issued_at_ms: issued, expires_at_ms: expires, model_version: modelVersion, instruction_sha256: instruction, key_id: keyId });
  if (!crypto.verify(null, message, publicKey, Buffer.from(signature, "hex"))) return no("the signature of the proposal does not match");
  const now = expected.nowMs ?? Date.now();
  if (expires <= issued || expires - issued > MAX_VALIDITY_MS) return no("the validity window of the proposal is not acceptable");
  if (issued > now + CLOCK_SKEW_MS) return no("the proposal was issued in the future");
  if (now >= expires) return no("the proposal has expired");
  if (!expected.robotId || robotId !== expected.robotId) return no("the proposal is for a different robot");
  if (expected.modelVersion !== undefined && modelVersion !== expected.modelVersion) return no("the proposal was made by a different model version");
  if (expected.instructionSha256 !== undefined && instruction !== expected.instructionSha256) return no("the proposal answers a different instruction");
  return { valid: true, reason: "", keyId };
}
