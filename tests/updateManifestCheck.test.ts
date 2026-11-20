// =============================================================================
// HYDRA-UMC-SERVER - Check of an update manifest: POST /api/admin/updates/manifest/check
// Copyright (C) 2026 JuanenRac (Electro Hobby 3D) <electrohobby3d@gmail.com>
// GPL-3.0-or-later - see LICENSE
// =============================================================================
// The route answers the verdict of the signature rule (the conformance vectors of the SDK, test keys only) against the list of trusted keys named by the
// configuration: 200 with `accepted` and `code` (a refusal is an answer), 400 for a body that is not an object, 503 when no usable list is configured, and
// the switch (off by default) turns a manifest without a signature from `legacy` into `downgrade_refused`. Nothing is installed or kept.
import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { registerUpdateRoutes, readManifestKeys } from "../src/routes/updateRoutes.ts";

const VECTORS = JSON.parse(readFileSync(new URL("./fixtures/manifest-signing-vectors.json", import.meta.url), "utf8"));
const GOOD = VECTORS.cases.find((c: any) => c.name === "a good signature passes with the switch off").manifest;
const NOW = Date.parse(VECTORS.cases.find((c: any) => c.name === "a good signature passes with the switch off").now);
const dir = mkdtempSync(path.join(os.tmpdir(), "manifest-check-"));
const keysFile = path.join(dir, "keys.json");
writeFileSync(keysFile, JSON.stringify(VECTORS.keys));

type Handler = (req: any, res: any, next?: any) => unknown;
function setup(file: string | undefined, require = false) {
  const routes: Record<string, Handler[]> = {};
  const app: any = { get() {}, put() {}, delete() {}, patch() {}, post: (p: string, ...h: Handler[]) => { routes[`POST ${p}`] = h; } };
  registerUpdateRoutes(app, {
    authenticate: (req: any, _r: any, next: any) => next(),
    requireAdmin: (req: any, res: any, next: any) => (req.role === "admin" ? next() : res.status(403).json({ error: "admin" })),
    enabled: () => false, getStatus: async () => ({ available: false, projects: [] }), config: () => undefined, now: () => NOW,
    manifestKeysFile: () => file, requireAsymmetricSignature: () => require,
  });
  return (body: unknown, role = "admin") => {
    const res: any = new EventEmitter();
    res.statusCode = 200;
    res.status = (c: number) => { res.statusCode = c; return res; };
    res.json = (b: unknown) => { res.body = b; return res; };
    const chain = routes["POST /api/admin/updates/manifest/check"];
    assert.ok(chain);
    const req = { body, role, headers: {}, query: {} };
    const run = (i: number): unknown => (i >= chain.length ? undefined : chain[i](req, res, () => run(i + 1)));
    // the first handler is the rate limiter of the sensitive routes, which needs a real request: skip it, the rest is the chain under test
    run(1);
    return res;
  };
}

test("a good signature is accepted and names its key; the switch is reported as it was", () => {
  const answer = setup(keysFile)(GOOD);
  assert.equal(answer.statusCode, 200);
  assert.equal(answer.body.accepted, true);
  assert.equal(answer.body.code, "ok");
  assert.match(answer.body.key_id, /^[0-9a-f]{16}$/);
  assert.equal(answer.body.require_asymmetric_signature, false);
});

test("a refused manifest is still a 200 with accepted false and the code of the refusal", () => {
  const answer = setup(keysFile)({ ...GOOD, version: "9.9.9" });
  assert.equal(answer.statusCode, 200);
  assert.deepEqual([answer.body.accepted, answer.body.code], [false, "bad_signature"]);
});

test("a manifest without a signature is legacy while the switch is off and a refused downgrade when it is on", () => {
  const { signature, signature_alg, key_id, ...legacy } = GOOD;
  void signature; void signature_alg; void key_id;
  const off = setup(keysFile, false)(legacy);
  assert.deepEqual([off.body.accepted, off.body.code, off.body.key_id, off.body.require_asymmetric_signature], [true, "legacy", null, false]);
  const on = setup(keysFile, true)(legacy);
  assert.deepEqual([on.body.accepted, on.body.code, on.body.require_asymmetric_signature], [false, "downgrade_refused", true]);
});

test("a body that is not an object is a 400, and only an administrator may ask", () => {
  for (const body of [undefined, null, [], "x", 5]) assert.equal(setup(keysFile)(body).statusCode, 400);
  assert.equal(setup(keysFile)(GOOD, "viewer").statusCode, 403);
});

test("no configured list, an unreadable one and a list that is not valid answer 503 without naming the path", () => {
  const bad = path.join(dir, "bad.json");
  writeFileSync(bad, JSON.stringify({ schema: 1, keys: [{ ...VECTORS.keys.keys[0], key_id: "0".repeat(16) }] }));
  for (const file of [undefined, "", path.join(dir, "missing.json"), bad]) {
    const answer = setup(file)(GOOD);
    assert.equal(answer.statusCode, 503, String(file));
    assert.ok(!JSON.stringify(answer.body).includes(dir));
  }
  assert.ok("error" in readManifestKeys(path.join(dir, "missing.json")));
  assert.ok("keys" in readManifestKeys(keysFile));
});
