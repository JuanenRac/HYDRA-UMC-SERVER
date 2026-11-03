// =============================================================================
// HYDRA-UMC-SERVER - src/jwtKeys.ts
// Copyright (C) 2026 JuanenRac (Electro Hobby 3D) <electrohobby3d@gmail.com>
// GPL-3.0-or-later - see LICENSE
// =============================================================================
// Optional asymmetric (EdDSA / Ed25519) sign-in tokens and the key set that is published as a JWKS.
//
// Default: nothing here is used and the server keeps signing HS256 with JWT_SECRET. When an administrator chooses EdDSA
// (auth.jwtAlgorithm), the server signs every new token with the ACTIVE private key and publishes the public keys at
// GET /.well-known/jwks.json, so another service can verify a token without ever holding a secret that could forge one.
//
// The private keys live in ONE file outside the repository (HYDRA_UMC_JWT_KEYS_FILE, by default
// ~/.hydra-umc-keys/server-jwt-keys.json), written with mode 0600 in a directory of mode 0700 through a temporary file and a
// rename. Rotation makes a new key the active one and keeps the previous one published (and accepted) for auth.keyOverlapSeconds,
// so tokens already issued stay valid during the transition; afterwards the old key is dropped from the file.
//
// The verifier is strict on purpose: the header must be exactly alg EdDSA with a kid of a published key, "none" and every other
// algorithm (including the HS/RS confusion family) are refused, exp is required, nbf and iat may not lie in the future.
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import jwt from "jsonwebtoken";

export type JwtAlgorithm = "HS256" | "EdDSA";
export const JWT_ALGORITHMS: readonly JwtAlgorithm[] = ["HS256", "EdDSA"];

/** What the verifier accepts right now (read on every token, so a change in the administration screen applies at once). */
export interface JwtPolicy {
  /** What new tokens are signed with. */
  algorithm: JwtAlgorithm;
  /** While signing with EdDSA, whether HS256 tokens that are still around are accepted (a transition switch). */
  acceptHs256: boolean;
}

const CONSERVATIVE_POLICY: JwtPolicy = { algorithm: "HS256", acceptHs256: true };
let policyProvider: () => JwtPolicy = () => CONSERVATIVE_POLICY;

export function setJwtPolicyProvider(provider: () => JwtPolicy): void {
  policyProvider = provider;
}

export function currentJwtPolicy(): JwtPolicy {
  try {
    return policyProvider();
  } catch {
    return CONSERVATIVE_POLICY;
  }
}

export const DEFAULT_KEY_OVERLAP_SECONDS = 30 * 24 * 3600;
export const MIN_KEY_OVERLAP_SECONDS = 60;
export const MAX_KEY_OVERLAP_SECONDS = 366 * 24 * 3600;
/** Seconds a clock may disagree before nbf / iat in the future are refused. */
const CLOCK_TOLERANCE_SECONDS = 5;

/** "30d", "24h", "90m", "45s", "2w" or a bare number of seconds (the forms JWT_EXPIRES_IN has always accepted). */
export function parseLifetimeSeconds(value: string | number): number {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) return Math.floor(value);
  const text = String(value).trim();
  if (/^\d+$/.test(text) && Number(text) > 0) return Number(text);
  const match = /^(\d+)\s*(s|m|h|d|w)$/.exec(text);
  if (!match || Number(match[1]) <= 0) throw new Error(`JWT_EXPIRES_IN "${text}" is not a lifetime like 24h, 7d or a number of seconds`);
  const unit: Record<string, number> = { s: 1, m: 60, h: 3600, d: 86400, w: 604800 };
  return Number(match[1]) * unit[match[2]];
}

export interface StoredKey {
  kid: string;
  alg: "EdDSA";
  /** PKCS8 PEM of the private key. Never leaves this file and never appears in an answer. */
  privateKeyPem: string;
  /** Unix seconds. */
  createdAt: number;
  /** Unix seconds; present once a newer key took over. */
  retiredAt?: number;
}

interface KeyFile {
  version: 1;
  keys: StoredKey[];
}

export interface PublicKeyInfo {
  kid: string;
  createdAt: number;
  retiredAt: number | null;
  active: boolean;
  /** Unix seconds at which a retired key stops being accepted; null for the active one. */
  acceptedUntil: number | null;
}

export interface Jwk {
  kty: "OKP";
  crv: "Ed25519";
  x: string;
  kid: string;
  use: "sig";
  alg: "EdDSA";
}

export type VerifyResult = { ok: true; payload: Record<string, any> } | { ok: false; expired: boolean };

const b64u = (buffer: Buffer): string => buffer.toString("base64url");
const B64U = /^[A-Za-z0-9_-]+$/;

function publicJwkOf(key: crypto.KeyObject): { x: string } {
  const jwk = key.export({ format: "jwk" }) as { x?: string };
  if (!jwk.x) throw new Error("the public key has no x coordinate");
  return { x: jwk.x };
}

/** kid = base64url of the first 16 bytes of the SHA-256 of the RFC 7638 thumbprint of the public key. */
export function thumbprintKid(x: string): string {
  const canonical = `{"crv":"Ed25519","kty":"OKP","x":"${x}"}`;
  return b64u(crypto.createHash("sha256").update(canonical).digest().subarray(0, 16));
}

export interface KeyStoreOptions {
  file: string;
  /** Seconds a retired key stays published and accepted. */
  overlapSeconds: () => number;
  now?: () => number;
}

export class JwtKeyStore {
  private keys: StoredKey[] | null = null;
  private readonly parsed = new Map<string, { privateKey: crypto.KeyObject; publicKey: crypto.KeyObject }>();
  private readonly now: () => number;

  constructor(private readonly options: KeyStoreOptions) {
    this.now = options.now ?? (() => Math.floor(Date.now() / 1000));
  }

  get file(): string {
    return this.options.file;
  }

  private objectsOf(key: StoredKey): { privateKey: crypto.KeyObject; publicKey: crypto.KeyObject } {
    let entry = this.parsed.get(key.kid);
    if (!entry) {
      const privateKey = crypto.createPrivateKey(key.privateKeyPem);
      entry = { privateKey, publicKey: crypto.createPublicKey(privateKey) };
      this.parsed.set(key.kid, entry);
    }
    return entry;
  }

  private overlap(): number {
    const value = this.options.overlapSeconds();
    return Number.isFinite(value) ? Math.min(MAX_KEY_OVERLAP_SECONDS, Math.max(MIN_KEY_OVERLAP_SECONDS, Math.floor(value))) : DEFAULT_KEY_OVERLAP_SECONDS;
  }

  private load(): StoredKey[] {
    if (this.keys) return this.keys;
    let raw: string;
    try {
      raw = fs.readFileSync(this.options.file, "utf8");
    } catch (error: any) {
      if (error?.code === "ENOENT") return (this.keys = []);
      throw error;
    }
    if (process.platform !== "win32") {
      const mode = fs.statSync(this.options.file).mode & 0o777;
      if (mode & 0o077) {
        fs.chmodSync(this.options.file, 0o600);
        if (fs.statSync(this.options.file).mode & 0o077) throw new Error("the JWT key file is readable by other accounts and its mode could not be fixed");
      }
    }
    const parsed = JSON.parse(raw) as Partial<KeyFile>;
    if (parsed.version !== 1 || !Array.isArray(parsed.keys)) throw new Error("the JWT key file has an unknown format");
    const keys: StoredKey[] = [];
    for (const entry of parsed.keys) {
      if (!entry || typeof entry.kid !== "string" || typeof entry.privateKeyPem !== "string" || typeof entry.createdAt !== "number") throw new Error("the JWT key file has a malformed key");
      const publicKey = crypto.createPublicKey(crypto.createPrivateKey(entry.privateKeyPem));
      if (publicKey.asymmetricKeyType !== "ed25519") throw new Error("the JWT key file holds a key that is not Ed25519");
      if (thumbprintKid(publicJwkOf(publicKey).x) !== entry.kid) throw new Error("a kid in the JWT key file does not match its key");
      keys.push({ kid: entry.kid, alg: "EdDSA", privateKeyPem: entry.privateKeyPem, createdAt: entry.createdAt, ...(typeof entry.retiredAt === "number" ? { retiredAt: entry.retiredAt } : {}) });
    }
    return (this.keys = keys);
  }

  private persist(keys: StoredKey[]): void {
    const dir = path.dirname(this.options.file);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const body: KeyFile = { version: 1, keys };
    const temporary = `${this.options.file}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, `${JSON.stringify(body, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(temporary, this.options.file);
    if (process.platform !== "win32") fs.chmodSync(this.options.file, 0o600);
    this.keys = keys;
  }

  /** Drops the retired keys whose overlap is over (they are no longer accepted nor published). */
  private live(): StoredKey[] {
    const now = this.now();
    const overlap = this.overlap();
    return this.load().filter((key) => key.retiredAt === undefined || now < key.retiredAt + overlap);
  }

  private generate(): StoredKey {
    const { privateKey, publicKey } = crypto.generateKeyPairSync("ed25519");
    return {
      kid: thumbprintKid(publicJwkOf(publicKey).x),
      alg: "EdDSA",
      privateKeyPem: privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
      createdAt: this.now(),
    };
  }

  private activeOf(keys: StoredKey[]): StoredKey | undefined {
    return keys.filter((key) => key.retiredAt === undefined).sort((a, b) => b.createdAt - a.createdAt)[0];
  }

  /** Creates the first key when there is none (and drops the keys whose overlap is over). Returns the kid of the active key. */
  ensureActive(): string {
    const live = this.live();
    let keys = live;
    if (!this.activeOf(keys)) keys = [...keys, this.generate()];
    if (keys.length !== this.load().length || keys !== live) this.persist(keys);
    return this.activeOf(keys)!.kid;
  }

  /** A new key becomes the active one; the previous one is retired and stays accepted for the overlap. Returns the new kid. */
  rotate(): string {
    const now = this.now();
    const keys = this.live().map((key) => (key.retiredAt === undefined ? { ...key, retiredAt: now } : key));
    const fresh = this.generate();
    // A rotation in the same second as the creation of the previous key must still leave the new one the newest.
    const newest = Math.max(0, ...keys.map((key) => key.createdAt));
    if (fresh.createdAt <= newest) fresh.createdAt = newest + 1;
    this.persist([...keys, fresh]);
    return fresh.kid;
  }

  /** The keys with their state, without any private material. Reads the file only; creates nothing. */
  list(): PublicKeyInfo[] {
    const overlap = this.overlap();
    return this.live()
      .map((key) => ({
        kid: key.kid,
        createdAt: key.createdAt,
        retiredAt: key.retiredAt ?? null,
        active: key.retiredAt === undefined,
        acceptedUntil: key.retiredAt === undefined ? null : key.retiredAt + overlap,
      }))
      .sort((a, b) => b.createdAt - a.createdAt);
  }

  /** The public keys (active and still-accepted retired ones) as a JWK Set. Nothing but public parameters. */
  jwks(): { keys: Jwk[] } {
    return {
      keys: this.live()
        .sort((a, b) => b.createdAt - a.createdAt)
        .map((key) => ({
          kty: "OKP" as const,
          crv: "Ed25519" as const,
          x: publicJwkOf(this.objectsOf(key).publicKey).x,
          kid: key.kid,
          use: "sig" as const,
          alg: "EdDSA" as const,
        })),
    };
  }

  /** Signs claims with the active key (creating it on first use). iat, nbf and exp are added here. */
  sign(claims: Record<string, unknown>, lifetime: string | number): string {
    const kid = this.ensureActive();
    const key = this.load().find((entry) => entry.kid === kid)!;
    const iat = this.now();
    const header = { alg: "EdDSA", typ: "JWT", kid };
    const payload = { ...claims, iat, nbf: iat, exp: iat + parseLifetimeSeconds(lifetime) };
    const signingInput = `${b64u(Buffer.from(JSON.stringify(header)))}.${b64u(Buffer.from(JSON.stringify(payload)))}`;
    const signature = crypto.sign(null, Buffer.from(signingInput), this.objectsOf(key).privateKey);
    return `${signingInput}.${b64u(signature)}`;
  }

  /** Verifies an EdDSA token against the published keys. Never throws. */
  verify(token: string): VerifyResult {
    const invalid: VerifyResult = { ok: false, expired: false };
    try {
      const parts = token.split(".");
      if (parts.length !== 3 || !parts.every((part) => part.length > 0 && B64U.test(part))) return invalid;
      const header = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8"));
      if (!header || typeof header !== "object" || header.alg !== "EdDSA") return invalid;
      if (header.typ !== undefined && header.typ !== "JWT") return invalid;
      if (typeof header.kid !== "string" || header.kid.length === 0 || header.kid.length > 64) return invalid;
      const stored = this.live().find((key) => key.kid === header.kid);
      if (!stored) return invalid;
      const signature = Buffer.from(parts[2], "base64url");
      if (signature.length !== 64) return invalid;
      if (!crypto.verify(null, Buffer.from(`${parts[0]}.${parts[1]}`), this.objectsOf(stored).publicKey, signature)) return invalid;
      const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
      if (!payload || typeof payload !== "object" || Array.isArray(payload)) return invalid;
      const now = this.now();
      if (typeof payload.exp !== "number" || !Number.isFinite(payload.exp)) return invalid;
      if (payload.exp <= now) return { ok: false, expired: true };
      if (payload.nbf !== undefined && (typeof payload.nbf !== "number" || payload.nbf > now + CLOCK_TOLERANCE_SECONDS)) return invalid;
      if (payload.iat !== undefined && (typeof payload.iat !== "number" || payload.iat > now + CLOCK_TOLERANCE_SECONDS)) return invalid;
      return { ok: true, payload };
    } catch {
      return invalid;
    }
  }
}

/** Where the key file lives: outside the repository, in the home directory of the account that runs the server. */
export function defaultKeysFile(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.HYDRA_UMC_JWT_KEYS_FILE?.trim();
  if (configured) return path.resolve(configured);
  return path.join(os.homedir(), ".hydra-umc-keys", "server-jwt-keys.json");
}

let singleton: JwtKeyStore | null = null;
let overlapProvider: () => number = () => DEFAULT_KEY_OVERLAP_SECONDS;

export function setKeyOverlapProvider(provider: () => number): void {
  overlapProvider = provider;
}

export function jwtKeyStore(): JwtKeyStore {
  if (!singleton) singleton = new JwtKeyStore({ file: defaultKeysFile(), overlapSeconds: () => overlapProvider() });
  return singleton;
}

/** For tests: replaces (or clears) the process-wide store. */
export function setJwtKeyStoreForTests(store: JwtKeyStore | null): void {
  singleton = store;
}

/** The header of a token, decoded without trusting it; null when it is not a JWT header. */
function peekHeader(token: string): { alg?: unknown } | null {
  const first = token.split(".")[0];
  if (!first || !B64U.test(first)) return null;
  try {
    const header = JSON.parse(Buffer.from(first, "base64url").toString("utf8"));
    return header && typeof header === "object" && !Array.isArray(header) ? header : null;
  } catch {
    return null;
  }
}

/**
 * The one place a bearer token is checked, for HTTP and WebSocket alike. The algorithm is chosen from the policy, never from
 * the token: an EdDSA token is checked only against the published public keys, an HS256 token only against the shared secret,
 * and every other algorithm (none, RS*, ES*, HS384...) is refused. Calls back synchronously with the shape jsonwebtoken uses.
 */
export function verifyAccessToken(token: string, secret: string, callback: (err: { name: string } | null, payload?: any) => void): void {
  const policy = currentJwtPolicy();
  const header = peekHeader(token);
  const alg = header?.alg;
  if (alg === "EdDSA" && policy.algorithm === "EdDSA") {
    const result = jwtKeyStore().verify(token);
    if (result.ok) return callback(null, result.payload);
    return callback({ name: result.expired ? "TokenExpiredError" : "JsonWebTokenError" });
  }
  if (alg === "HS256" && (policy.algorithm === "HS256" || policy.acceptHs256)) {
    return jwt.verify(token, secret, { algorithms: ["HS256"] }, (err: any, payload: any) => callback(err, payload));
  }
  return callback({ name: "JsonWebTokenError" });
}

/** Signs a login token with whatever the policy says (HS256 with the shared secret unless EdDSA was chosen). */
export function signAccessToken(claims: Record<string, unknown>, secret: string, lifetime: string): string {
  if (currentJwtPolicy().algorithm === "EdDSA") return jwtKeyStore().sign(claims, lifetime);
  return jwt.sign(claims, secret, { expiresIn: lifetime as any });
}
