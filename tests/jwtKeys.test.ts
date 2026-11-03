import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import jwt from "jsonwebtoken";
import { JwtKeyStore, parseLifetimeSeconds, setJwtKeyStoreForTests, setJwtPolicyProvider, signAccessToken, verifyAccessToken } from "../src/jwtKeys";
import { SecurityConfig, SecurityConfigError, resolveJwtAcceptHs256, resolveJwtAlgorithm, resolveKeyOverlapSeconds, type SecurityFile } from "../src/securityConfig";

const SECRET = "test-secret-with-enough-length-0123456789";

function makeStore(overlap = 3600) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hydra-jwt-"));
  let now = 1_800_000_000;
  const store = new JwtKeyStore({ file: path.join(dir, "keys", "k.json"), overlapSeconds: () => overlap, now: () => now });
  return { store, dir, file: path.join(dir, "keys", "k.json"), advance: (s: number) => { now += s; }, now: () => now };
}

const b64u = (value: unknown) => Buffer.from(typeof value === "string" ? value : JSON.stringify(value)).toString("base64url");

function check(token: string): { err: { name: string } | null; payload?: any } {
  let out: { err: { name: string } | null; payload?: any } = { err: { name: "never called" } };
  verifyAccessToken(token, SECRET, (err, payload) => { out = { err, payload }; });
  return out;
}

test("the lifetimes JWT_EXPIRES_IN has always accepted are understood", () => {
  assert.equal(parseLifetimeSeconds("30d"), 2592000);
  assert.equal(parseLifetimeSeconds("24h"), 86400);
  assert.equal(parseLifetimeSeconds("90m"), 5400);
  assert.equal(parseLifetimeSeconds("45"), 45);
  assert.equal(parseLifetimeSeconds(120), 120);
  assert.throws(() => parseLifetimeSeconds("soon"));
  assert.throws(() => parseLifetimeSeconds("0d"));
});

test("a token signed with the active key verifies and carries kid, iat, nbf and exp", () => {
  const { store } = makeStore();
  const token = store.sign({ username: "ana", role: "admin" }, "1h");
  const header = JSON.parse(Buffer.from(token.split(".")[0], "base64url").toString());
  assert.equal(header.alg, "EdDSA");
  assert.equal(header.typ, "JWT");
  assert.equal(header.kid, store.jwks().keys[0].kid);
  const result = store.verify(token);
  assert.ok(result.ok);
  if (result.ok) {
    assert.equal(result.payload.username, "ana");
    assert.equal(result.payload.exp - result.payload.iat, 3600);
    assert.equal(result.payload.nbf, result.payload.iat);
  }
});

test("the published key set holds public parameters only", () => {
  const { store } = makeStore();
  store.ensureActive();
  const jwks = store.jwks();
  assert.equal(jwks.keys.length, 1);
  assert.deepEqual(Object.keys(jwks.keys[0]).sort(), ["alg", "crv", "kid", "kty", "use", "x"]);
  assert.ok(!JSON.stringify(jwks).includes("PRIVATE"));
  assert.ok(!("d" in jwks.keys[0]));
  assert.ok(!JSON.stringify(store.list()).includes("PRIVATE"));
  // The published x really verifies what the store signs, as an external verifier would do it.
  const token = store.sign({ a: 1 }, 60);
  const [h, p, s] = token.split(".");
  const publicKey = crypto.createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: jwks.keys[0].x }, format: "jwk" });
  assert.equal(crypto.verify(null, Buffer.from(`${h}.${p}`), publicKey, Buffer.from(s, "base64url")), true);
});

test("the key file is created outside any repository with a restrictive mode", { skip: process.platform === "win32" }, () => {
  const { store, file } = makeStore();
  store.ensureActive();
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.dirname(file)).mode & 0o777, 0o700);
});

test("a key file that other accounts can read is fixed on load", { skip: process.platform === "win32" }, () => {
  const { store, file, dir } = makeStore();
  store.ensureActive();
  fs.chmodSync(file, 0o644);
  const again = new JwtKeyStore({ file, overlapSeconds: () => 3600 });
  again.list();
  assert.equal(fs.statSync(file).mode & 0o077, 0);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("rotation keeps two keys valid during the overlap and drops the old one afterwards", () => {
  const ctx = makeStore(3600);
  const { store } = ctx;
  const oldToken = store.sign({ n: "old" }, "1d");
  const oldKid = store.jwks().keys[0].kid;
  const newKid = store.rotate();
  assert.notEqual(oldKid, newKid);
  assert.equal(store.jwks().keys.length, 2);
  assert.equal(store.jwks().keys[0].kid, newKid, "the newest key is listed first");
  const newToken = store.sign({ n: "new" }, "1d");
  assert.equal(JSON.parse(Buffer.from(newToken.split(".")[0], "base64url").toString()).kid, newKid, "new tokens use the active key");
  assert.ok(store.verify(oldToken).ok);
  assert.ok(store.verify(newToken).ok);
  const states = store.list();
  assert.equal(states.filter((k) => k.active).length, 1);
  assert.equal(states.find((k) => k.kid === oldKid)?.acceptedUntil, ctx.now() + 3600);
  ctx.advance(3601);
  assert.equal(store.jwks().keys.length, 1);
  assert.equal(store.verify(oldToken).ok, false);
  // The next write drops it from the file too.
  store.ensureActive();
  assert.equal(JSON.parse(fs.readFileSync(ctx.file, "utf8")).keys.length, 1);
});

test("two rotations in a row still leave the newest key active", () => {
  const { store } = makeStore();
  store.ensureActive();
  store.rotate();
  const kid = store.rotate();
  assert.equal(store.list().find((k) => k.active)?.kid, kid);
});

test("the key survives a restart: a new store over the same file verifies the old tokens", () => {
  const { store, file } = makeStore();
  const token = store.sign({ x: 1 }, "1h");
  const again = new JwtKeyStore({ file, overlapSeconds: () => 3600, now: () => 1_800_000_010 });
  assert.ok(again.verify(token).ok);
});

test("alg none, algorithm confusion and every other algorithm are refused", () => {
  const { store } = makeStore();
  setJwtKeyStoreForTests(store);
  setJwtPolicyProvider(() => ({ algorithm: "EdDSA", acceptHs256: false }));
  try {
    const good = store.sign({ username: "u" }, "1h");
    assert.equal(check(good).err, null);
    const [, p] = good.split(".");
    const kid = store.jwks().keys[0].kid;
    // alg none, with and without a signature part
    assert.ok(check(`${b64u({ alg: "none", typ: "JWT" })}.${p}.`).err);
    assert.ok(check(`${b64u({ alg: "none", typ: "JWT", kid })}.${p}.${b64u("x")}`).err);
    assert.ok(check(`${b64u({ alg: "None", typ: "JWT" })}.${p}.${b64u("x")}`).err);
    // HS256 signed with the public key x as the secret (the classic confusion) and with the real secret while HS256 is not accepted
    const x = store.jwks().keys[0].x;
    const confused = jwt.sign({ username: "u", exp: Math.floor(Date.now() / 1000) + 60 }, x, { algorithm: "HS256", keyid: kid });
    assert.ok(check(confused).err);
    const hs = jwt.sign({ username: "u" }, SECRET, { algorithm: "HS256", expiresIn: 60 });
    assert.ok(check(hs).err, "HS256 refused once acceptHs256 is off");
    // RS256 and HS384 headers, even with a plausible signature part
    assert.ok(check(`${b64u({ alg: "RS256", typ: "JWT", kid })}.${p}.${b64u(Buffer.alloc(64))}`).err);
    assert.ok(check(`${b64u({ alg: "HS384", typ: "JWT", kid })}.${p}.${b64u(Buffer.alloc(48))}`).err);
    // an EdDSA header whose signature belongs to a different key set
    const other = makeStore().store.sign({ username: "u" }, "1h");
    assert.ok(check(other).err);
  } finally {
    setJwtPolicyProvider(() => ({ algorithm: "HS256", acceptHs256: true }));
    setJwtKeyStoreForTests(null);
  }
});

test("kid, exp, nbf and iat are checked strictly", () => {
  const ctx = makeStore();
  const { store } = ctx;
  const kid = store.jwks().keys[0]?.kid ?? (store.ensureActive(), store.jwks().keys[0].kid);
  const priv = crypto.createPrivateKey(JSON.parse(fs.readFileSync(ctx.file, "utf8")).keys[0].privateKeyPem);
  const make = (header: any, payload: any) => {
    const input = `${b64u(header)}.${b64u(payload)}`;
    return `${input}.${crypto.sign(null, Buffer.from(input), priv).toString("base64url")}`;
  };
  const now = ctx.now();
  const h = { alg: "EdDSA", typ: "JWT", kid };
  assert.ok(store.verify(make(h, { exp: now + 60 })).ok);
  assert.equal(store.verify(make({ alg: "EdDSA", typ: "JWT" }, { exp: now + 60 })).ok, false, "no kid");
  assert.equal(store.verify(make({ ...h, kid: "unknown" }, { exp: now + 60 })).ok, false, "unknown kid");
  assert.equal(store.verify(make({ ...h, typ: "other" }, { exp: now + 60 })).ok, false, "typ");
  assert.equal(store.verify(make(h, { username: "no exp" })).ok, false, "exp is required");
  assert.equal(store.verify(make(h, { exp: "tomorrow" })).ok, false, "exp must be a number");
  assert.deepEqual(store.verify(make(h, { exp: now - 1 })), { ok: false, expired: true });
  assert.equal(store.verify(make(h, { exp: now + 600, nbf: now + 120 })).ok, false, "nbf in the future");
  assert.ok(store.verify(make(h, { exp: now + 600, nbf: now + 3 })).ok, "a few seconds of clock difference are tolerated");
  assert.equal(store.verify(make(h, { exp: now + 600, iat: now + 3600 })).ok, false, "iat in the future");
  assert.equal(store.verify(make(h, { exp: now + 600, nbf: "now" })).ok, false);
  // tampering and malformed input
  const good = store.sign({ role: "operator" }, "1h");
  const [gh, , gs] = good.split(".");
  assert.equal(store.verify(`${gh}.${b64u({ role: "admin", exp: now + 3600 })}.${gs}`).ok, false);
  assert.equal(store.verify("a.b").ok, false);
  assert.equal(store.verify("a.b.c.d").ok, false);
  assert.equal(store.verify("").ok, false);
  assert.equal(store.verify(`${gh}.${b64u("[]")}.${gs}`).ok, false);
  assert.equal(store.verify(`${gh}.%%%.${gs}`).ok, false);
});

test("the policy decides: HS256 by default, EdDSA when chosen, HS256 only while it is still accepted", () => {
  const { store } = makeStore();
  setJwtKeyStoreForTests(store);
  try {
    setJwtPolicyProvider(() => ({ algorithm: "HS256", acceptHs256: true }));
    const hs = signAccessToken({ username: "u" }, SECRET, "1h");
    assert.equal(JSON.parse(Buffer.from(hs.split(".")[0], "base64url").toString()).alg, "HS256");
    assert.equal(check(hs).err, null);
    // an EdDSA token is not accepted while the server signs HS256
    const ed = store.sign({ username: "u" }, "1h");
    assert.ok(check(ed).err);

    setJwtPolicyProvider(() => ({ algorithm: "EdDSA", acceptHs256: true }));
    const signed = signAccessToken({ username: "u" }, SECRET, "1h");
    assert.equal(JSON.parse(Buffer.from(signed.split(".")[0], "base64url").toString()).alg, "EdDSA");
    assert.equal(check(signed).err, null);
    assert.equal(check(hs).err, null, "the transition: HS256 tokens still work");

    setJwtPolicyProvider(() => ({ algorithm: "EdDSA", acceptHs256: false }));
    assert.ok(check(hs).err, "and stop working when the switch is turned off");
    assert.equal(check(signed).err, null);
    // an expired token is reported as such by both algorithms
    const expired = jwt.sign({ username: "u" }, SECRET, { algorithm: "HS256", expiresIn: -10 });
    setJwtPolicyProvider(() => ({ algorithm: "HS256", acceptHs256: true }));
    assert.equal(check(expired).err?.name, "TokenExpiredError");
  } finally {
    setJwtPolicyProvider(() => ({ algorithm: "HS256", acceptHs256: true }));
    setJwtKeyStoreForTests(null);
  }
});

test("a key file with a key that does not match its kid is refused", () => {
  const { store, file } = makeStore();
  store.ensureActive();
  const body = JSON.parse(fs.readFileSync(file, "utf8"));
  body.keys[0].kid = "AAAAAAAAAAAAAAAAAAAAAA";
  fs.writeFileSync(file, JSON.stringify(body));
  const again = new JwtKeyStore({ file, overlapSeconds: () => 3600 });
  assert.throws(() => again.list());
});

test("the security options: HS256 by default, the environment wins, bad values are refused", () => {
  assert.deepEqual(resolveJwtAlgorithm(undefined, {}), { value: "HS256", source: "default" });
  assert.deepEqual(resolveJwtAlgorithm("eddsa", { auth: { jwtAlgorithm: "HS256" } }), { value: "EdDSA", source: "env" });
  assert.deepEqual(resolveJwtAlgorithm("RS256", { auth: { jwtAlgorithm: "EdDSA" } }), { value: "EdDSA", source: "config" }, "an unknown word in the environment is ignored");
  assert.deepEqual(resolveJwtAcceptHs256(undefined, {}), { value: true, source: "default" });
  assert.deepEqual(resolveJwtAcceptHs256("0", { auth: { acceptHs256: true } }), { value: false, source: "env" });
  assert.equal(resolveKeyOverlapSeconds({}), 2592000);
  assert.equal(resolveKeyOverlapSeconds({ auth: { keyOverlapSeconds: 5 } }), 2592000);
  assert.equal(resolveKeyOverlapSeconds({ auth: { keyOverlapSeconds: 7200 } }), 7200);

  let stored: SecurityFile = {};
  const logs: string[] = [];
  const config = new SecurityConfig({ env: {}, load: () => ({ ...stored }), save: (f) => { stored = { ...f }; }, tlsActive: false, log: (m) => logs.push(m) });
  assert.deepEqual(config.jwtPolicy(), { algorithm: "HS256", acceptHs256: true });
  assert.equal(config.snapshot().auth.jwtAlgorithm.value, "HS256");
  assert.throws(() => config.update({ auth: { jwtAlgorithm: "none" } }, "root"), SecurityConfigError);
  assert.throws(() => config.update({ auth: { jwtAlgorithm: "RS256" } }, "root"), SecurityConfigError);
  assert.throws(() => config.update({ auth: { acceptHs256: "no" } }, "root"), SecurityConfigError);
  assert.throws(() => config.update({ auth: [] }, "root"), SecurityConfigError);
  const result = config.update({ auth: { jwtAlgorithm: "EdDSA" } }, "root");
  assert.ok(result.warnings.includes("jwt_eddsa_on"));
  assert.deepEqual(config.jwtPolicy(), { algorithm: "EdDSA", acceptHs256: true });
  assert.equal(stored.auth?.jwtAlgorithm, "EdDSA");
  assert.ok(config.update({ auth: { acceptHs256: false } }, "root").warnings.includes("jwt_hs256_refused"));
  assert.deepEqual(config.jwtPolicy(), { algorithm: "EdDSA", acceptHs256: false });
  assert.ok(logs.some((l) => l.includes("EdDSA") && l.includes("REFUSED")));

  const locked = new SecurityConfig({ env: { jwtAlgorithm: "HS256" }, load: () => ({}), save: () => undefined, tlsActive: false });
  assert.throws(() => locked.update({ auth: { jwtAlgorithm: "EdDSA" } }, "root"), /HYDRA_UMC_JWT_ALGORITHM/);
});
