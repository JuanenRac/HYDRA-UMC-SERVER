// =============================================================================
// HYDRA-UMC-SERVER - Asymmetric signature of the update manifest
// Copyright (C) 2026 JuanenRac (Electro Hobby 3D) <electrohobby3d@gmail.com>
// GPL-3.0-or-later - see LICENSE
// =============================================================================
// The rule of `hydra_umc_sdk.manifest_signing` (docs/MANIFEST_SIGNING.md of the SDK) in TypeScript: the Ed25519 signature of an UpdateManifest is made over the
// canonical JSON of the manifest without `signature` (keys sorted, no spaces, UTF-8). A list of PUBLIC keys says which signatures count: each key is current,
// next, retired or revoked and has an optional validity window, which is how a key is rotated. A signature that is present is always checked, whatever the
// switch; a manifest without one is `legacy` and passes only while the switch (production.requireAsymmetricSignature) is off. The tests run the conformance
// vectors of the SDK, so both languages give the same verdict for every case. Only public keys are read here; nothing in this module can sign.
import { createHash, createPublicKey, verify } from "node:crypto";

export const MANIFEST_SIGNATURE_ALG = "ed25519";
export type KeyState = "current" | "next" | "retired" | "revoked";
export type ManifestCode =
  | "ok" | "legacy" | "downgrade_refused" | "malformed" | "bad_signature" | "unknown_key" | "key_revoked" | "key_not_yet_valid" | "key_expired";

export interface TrustedManifestKey { keyId: string; publicKey: Buffer; state: KeyState; notBefore: number | null; notAfter: number | null }
export interface ManifestVerdict { accepted: boolean; code: ManifestCode; keyId: string | null }

export class KeyListError extends Error {}

const STATES: readonly string[] = ["current", "next", "retired", "revoked"];
const HEX_SIGNATURE = /^[0-9a-f]{128}$/;
const HEX_KEY = /^[0-9a-f]{64}$/;
const HEX_KEY_ID = /^[0-9a-f]{16}$/;
const TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
// DER prefix of an Ed25519 SubjectPublicKeyInfo; the 32 raw bytes of the key follow
const SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

/** The `key_id` of a public key: the first eight bytes of its SHA-512, as 16 lowercase hexadecimal digits. */
export function keyIdOf(publicKey: Buffer): string {
  return createHash("sha512").update(publicKey).digest().subarray(0, 8).toString("hex");
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

/** What a manifest signature is made over: the manifest without `signature`, as canonical JSON. */
export function canonicalManifestMessage(manifest: Record<string, unknown>): Buffer {
  const { signature: _signature, ...body } = manifest;
  return Buffer.from(canonical(body), "utf8");
}

function moment(value: unknown, name: string): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string" || !TIME.test(value)) throw new KeyListError(`${name} must be null or a UTC time such as 2030-01-01T00:00:00Z`);
  return Date.parse(value);
}

/** Reads the list of trusted keys. Any fault refuses the whole list: nothing is trusted from a damaged one. */
export function manifestKeysFromJson(text: string): TrustedManifestKey[] {
  let data: unknown;
  try { data = JSON.parse(text); } catch { throw new KeyListError("the list of keys is not valid JSON"); }
  const list = data as { schema?: unknown; keys?: unknown } | null;
  if (typeof list !== "object" || list === null || Array.isArray(list) || list.schema !== 1 || !Array.isArray(list.keys)) throw new KeyListError("the list of keys must be an object with schema 1 and a keys array");
  const seen = new Set<string>();
  return list.keys.map((entry: unknown) => {
    const item = entry as Record<string, unknown> | null;
    if (typeof item !== "object" || item === null || Array.isArray(item) || Object.keys(item).some((k) => !["key_id", "public", "state", "not_before", "not_after", "label"].includes(k))) throw new KeyListError("a key entry has a field that is not part of the list format");
    if (typeof item.public !== "string" || !HEX_KEY.test(item.public)) throw new KeyListError("public must be 64 lowercase hexadecimal digits");
    const publicKey = Buffer.from(item.public, "hex");
    if (typeof item.key_id !== "string" || !HEX_KEY_ID.test(item.key_id) || item.key_id !== keyIdOf(publicKey)) throw new KeyListError("key_id does not belong to the public key");
    if (typeof item.state !== "string" || !STATES.includes(item.state)) throw new KeyListError("state must be current, next, retired or revoked");
    if (seen.has(item.key_id)) throw new KeyListError("a key_id appears twice");
    seen.add(item.key_id);
    return { keyId: item.key_id, publicKey, state: item.state as KeyState, notBefore: moment(item.not_before, "not_before"), notAfter: moment(item.not_after, "not_after") };
  });
}

/** True when `signature` is a valid Ed25519 signature of `message` under the raw 32-byte `publicKey`; any wrong length or unusable key is false. */
export function ed25519Verify(publicKey: Buffer, message: Buffer, signature: Buffer): boolean {
  if (publicKey.length !== 32 || signature.length !== 64) return false;
  try {
    const key = createPublicKey({ key: Buffer.concat([SPKI_PREFIX, publicKey]), format: "der", type: "spki" });
    return verify(null, message, key, signature);
  } catch {
    return false;
  }
}

const refuse = (code: ManifestCode, keyId: string | null = null): ManifestVerdict => ({ accepted: false, code, keyId });

/** Decides whether a manifest passes (see the top of the file). `now` is in milliseconds since the epoch. */
export function verifyManifest(manifest: unknown, keys: readonly TrustedManifestKey[], now: number, requireAsymmetricSignature = false): ManifestVerdict {
  if (typeof manifest !== "object" || manifest === null || Array.isArray(manifest)) return refuse("malformed");
  const body = manifest as Record<string, unknown>;
  if (!("signature" in body)) {
    // A legacy manifest never names a signature algorithm or a key either: one that does is damaged.
    if ((body.signature_alg !== undefined && body.signature_alg !== null) || (body.key_id !== undefined && body.key_id !== null)) return refuse("malformed");
    return requireAsymmetricSignature ? refuse("downgrade_refused") : { accepted: true, code: "legacy", keyId: null };
  }
  const { signature, key_id: keyId, signature_alg: alg } = body;
  if (alg !== MANIFEST_SIGNATURE_ALG || typeof signature !== "string" || !HEX_SIGNATURE.test(signature)) return refuse("malformed");
  if (typeof keyId !== "string" || !HEX_KEY_ID.test(keyId)) return refuse("malformed");
  const key = keys.find((candidate) => candidate.keyId === keyId);
  if (key === undefined) return refuse("unknown_key", keyId);
  if (key.state === "revoked") return refuse("key_revoked", keyId);
  if (key.notBefore !== null && now < key.notBefore) return refuse("key_not_yet_valid", keyId);
  if (key.notAfter !== null && now >= key.notAfter) return refuse("key_expired", keyId);
  if (!ed25519Verify(key.publicKey, canonicalManifestMessage(body), Buffer.from(signature, "hex"))) return refuse("bad_signature", keyId);
  return { accepted: true, code: "ok", keyId };
}
