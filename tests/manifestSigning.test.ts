// =============================================================================
// HYDRA-UMC-SERVER - Signature of the update manifest and the switch that requires an Ed25519 signature on a flash
// Copyright (C) 2026 JuanenRac (Electro Hobby 3D) <electrohobby3d@gmail.com>
// GPL-3.0-or-later - see LICENSE
// =============================================================================
// The conformance vectors of the SDK (a copy in tests/fixtures; test keys only) give the same verdicts here as in Python. production.requireAsymmetricSignature
// is off by default, an administrator can change it (logged, saved, locked by its environment variable) and, when on, a firmware flash without the Ed25519
// signature of its image is refused before anything is sent while the default still lets it go on as before. The spi_bridge is a stand-in.
import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import http from "node:http";
import { registerUpstreamRoutes } from "../src/routes/upstreamRoutes.ts";
import { KeyListError, ed25519Verify, keyIdOf, manifestKeysFromJson, verifyManifest, canonicalManifestMessage } from "../src/manifestSigning.ts";
import { SecurityConfig, SecurityConfigError, resolveProductionRequireAsymmetricSignature, type SecurityFile } from "../src/securityConfig.ts";

const VECTORS = JSON.parse(readFileSync(new URL("./fixtures/manifest-signing-vectors.json", import.meta.url), "utf8"));
const KEYS = manifestKeysFromJson(JSON.stringify(VECTORS.keys));
const GOOD = VECTORS.cases.find((c: any) => c.name === "a good signature passes with the switch off").manifest;

test("every conformance vector gives the verdict of the SDK", () => {
  assert.ok(VECTORS.cases.length >= 18);
  for (const c of VECTORS.cases) {
    const verdict = verifyManifest(c.manifest, KEYS, Date.parse(c.now), c.require_asymmetric_signature);
    assert.deepEqual([verdict.accepted, verdict.code], [c.accepted, c.code], c.name);
  }
});

test("the key id is the first eight bytes of the SHA-512 of the key, and the list refuses a key id that does not belong to its key", () => {
  for (const key of KEYS) assert.equal(key.keyId, keyIdOf(key.publicKey));
  const entry = VECTORS.keys.keys[0];
  assert.throws(() => manifestKeysFromJson(JSON.stringify({ schema: 1, keys: [{ ...entry, key_id: "0".repeat(16) }] })), KeyListError);
});

test("every fault refuses the whole list of keys", () => {
  const entry = VECTORS.keys.keys[0];
  const faults = ["not json", "[]", JSON.stringify({ schema: 2, keys: [] }), JSON.stringify({ schema: 1, keys: [{ ...entry, public: "zz" }] }),
    JSON.stringify({ schema: 1, keys: [{ ...entry, state: "trusted" }] }), JSON.stringify({ schema: 1, keys: [{ ...entry, not_before: "yesterday" }] }),
    JSON.stringify({ schema: 1, keys: [{ ...entry, extra: "x" }] }), JSON.stringify({ schema: 1, keys: [entry, entry] })];
  for (const text of faults) assert.throws(() => manifestKeysFromJson(text), KeyListError, text.slice(0, 40));
});

test("a signature that is present is checked with the switch off, and a changed field, a short signature or a foreign signature is refused", () => {
  const now = Date.parse("2030-03-01T00:00:00Z");
  assert.equal(verifyManifest({ ...GOOD, version: "9.9.9" }, KEYS, now, false).code, "bad_signature");
  assert.equal(verifyManifest({ ...GOOD, signature: GOOD.signature.slice(0, -2) }, KEYS, now, false).code, "malformed");
  assert.equal(verifyManifest(GOOD, [], now, false).code, "unknown_key");
  assert.equal(verifyManifest([], KEYS, now, false).code, "malformed");
});

test("the signed bytes are the canonical JSON without the signature, with sorted keys", () => {
  assert.equal(canonicalManifestMessage({ b: 1, a: { d: 2, c: [3, { z: 1, y: 2 }] }, signature: "x" }).toString("utf8"), '{"a":{"c":[3,{"y":2,"z":1}],"d":2},"b":1}');
  assert.equal(ed25519Verify(Buffer.alloc(31), Buffer.alloc(1), Buffer.alloc(64)), false);
  assert.equal(ed25519Verify(Buffer.alloc(32), Buffer.alloc(1), Buffer.alloc(63)), false);
});

test("the switch is off by default, the environment decides first, then the file", () => {
  assert.deepEqual(resolveProductionRequireAsymmetricSignature(undefined, {}), { value: false, source: "default" });
  assert.deepEqual(resolveProductionRequireAsymmetricSignature(undefined, { production: { requireAsymmetricSignature: true } }), { value: true, source: "config" });
  assert.deepEqual(resolveProductionRequireAsymmetricSignature("1", { production: { requireAsymmetricSignature: false } }), { value: true, source: "env" });
  assert.deepEqual(resolveProductionRequireAsymmetricSignature("0", { production: { requireAsymmetricSignature: true } }), { value: false, source: "env" });
  assert.equal(resolveProductionRequireAsymmetricSignature("yes", {}).value, false);
});

function makeConfig(env: Record<string, string | undefined> = {}) {
  let stored: SecurityFile = {};
  const logs: string[] = [];
  const config = new SecurityConfig({ env, load: () => ({ ...stored }), save: (file) => { stored = { ...file }; }, tlsActive: false, log: (m) => logs.push(m) } as any);
  return { config, logs, stored: () => stored };
}

test("an administrator can turn the switch on and off, it is logged and saved, bad values are refused and the environment locks it", () => {
  const { config, logs, stored } = makeConfig();
  assert.equal(config.productionRequireAsymmetricSignature(), false);
  config.update({ production: { requireAsymmetricSignature: true } }, "root");
  assert.equal(config.productionRequireAsymmetricSignature(), true);
  assert.deepEqual(stored().production, { requireAsymmetricSignature: true });
  assert.match(logs.at(-1)!, /now requires the Ed25519 signature/);
  config.update({ production: { requireAsymmetricSignature: false } }, "root");
  assert.match(logs.at(-1)!, /no longer requires/);
  for (const bad of [{ requireAsymmetricSignature: "1" }, { requireAsymmetricSignature: 1 }, { requireAsymmetricSignature: null }]) {
    assert.throws(() => config.update({ production: bad as any }, "root"), (e: unknown) => e instanceof SecurityConfigError && e.status === 400);
  }
  const fixed = makeConfig({ productionRequireAsymmetricSignature: "1" }).config;
  assert.throws(() => fixed.update({ production: { requireAsymmetricSignature: false } }, "root"), (e: unknown) => e instanceof SecurityConfigError && e.status === 409 && /REQUIRE_ASYMMETRIC_SIGNATURE/.test(e.message));
});

type Handler = (req: any, res: any, next?: any) => Promise<unknown> | unknown;

async function setup(required: boolean) {
  const routes: Record<string, Handler[]> = {};
  const app: any = { get(path: string, ...h: Handler[]) { routes[`GET ${path}`] = h; }, post(path: string, ...h: Handler[]) { routes[`POST ${path}`] = h; }, put() {}, delete() {}, patch() {} };
  const seen: string[] = [];
  const bridge = http.createServer((req, res) => {
    req.resume();
    req.on("end", () => { seen.push(req.url ?? ""); res.writeHead(200, { "content-type": "application/x-ndjson" }); res.end(JSON.stringify({ phase: "done", percent: 100 }) + "\n"); });
  });
  await new Promise<void>((resolve) => bridge.listen(0, "127.0.0.1", resolve));
  const pass: Handler = (req, _res, next) => { req.user = { id: "u1", username: "root", role: "admin" }; return next(); };
  registerUpstreamRoutes(app, {
    authenticate: pass as any, requireAdmin: pass as any, industrialLog: () => {}, wsClients: [],
    DATALAKE_URL: "", DATALAKE_TIMEOUT_MS: 1000, CONNECTOR_HUB_URL: "", CONNECTOR_HUB_TIMEOUT_MS: 2000,
    SPI_BRIDGE_URL: `http://127.0.0.1:${(bridge.address() as any).port}`, SPI_BRIDGE_VERSION_TIMEOUT_MS: 1000, SPI_BRIDGE_FLASH_TIMEOUT_MS: 1000,
    requireAsymmetricSignature: () => required, anyRobotMoving: () => false,
  } as any);
  const call = async (query: Record<string, string>) => {
    const res: any = new EventEmitter();
    res.statusCode = 200;
    const done = new Promise<void>((resolve) => { res.once("finish", resolve); });
    res.status = (code: number) => { res.statusCode = code; return res; };
    res.json = (payload: unknown) => { res.body = payload; queueMicrotask(() => res.emit("finish")); return res; };
    const handlers = routes["POST /api/hardware/canota/flash"];
    const run = async (index: number): Promise<unknown> => (index >= handlers.length ? undefined : handlers[index]({ query, body: Buffer.from([1, 2, 3, 4]), _body: true, headers: {} }, res, () => run(index + 1)));
    await run(0);
    await done;
    return res;
  };
  return { call, seen, stop: () => new Promise<void>((resolve) => bridge.close(() => resolve())) };
}

test("with the switch off a flash without the signature goes on as before; with it on it is refused before anything is sent, and a signed one goes on", async () => {
  const off = await setup(false);
  try {
    assert.equal((await off.call({ tier: "1", slot: "0" })).statusCode, 200);
    assert.equal(off.seen.length, 1);
  } finally { await off.stop(); }
  const on = await setup(true);
  try {
    const refused = await on.call({ tier: "1", slot: "0" });
    assert.equal(refused.statusCode, 400);
    assert.equal(refused.body.code, "flash-asymmetric-required");
    assert.equal(on.seen.length, 0);
    const accepted = await on.call({ tier: "1", slot: "0", signature: "ab".repeat(64) });
    assert.equal(accepted.statusCode, 200);
    assert.equal(on.seen.length, 1);
  } finally { await on.stop(); }
});
