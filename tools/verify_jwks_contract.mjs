// =============================================================================
// HYDRA-UMC-SERVER - Asymmetric sign-in tokens and the JWKS: contract check
// Copyright (C) 2026 JuanenRac (Electro Hobby 3D) <electrohobby3d@gmail.com>
// GPL-3.0-or-later - see LICENSE
// =============================================================================
// Against a real running server: by default tokens are HS256 and GET /.well-known/jwks.json looks as if it did not exist. An administrator
// can choose EdDSA (auth.jwtAlgorithm): new tokens carry the kid of a published Ed25519 key, the key set is public and holds no private part,
// a rotation keeps two keys valid during the overlap, HS256 tokens are accepted only while auth.acceptHs256 is on, and a token with
// alg none or an HS256 signature made with the public key is refused.

import assert from "node:assert/strict";
import crypto from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import jwt from "jsonwebtoken";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TSX_CLI = path.join(ROOT, "node_modules", "tsx", "dist", "cli.mjs");
const SERVER_SOURCE = path.join(ROOT, "src", "server.ts");
const ADMIN = { username: "jwks-admin", password: "jwks-admin-password" };
const OPERATOR = { username: "jwks-operator", password: "jwks-operator-password" };

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitUntil(fn, message) {
  const deadline = Date.now() + 90000;
  for (;;) {
    if (await fn()) return;
    if (Date.now() > deadline) throw new Error(`timed out waiting for: ${message}`);
    await wait(100);
  }
}
const reservePort = () => new Promise((resolve, reject) => {
  const server = createServer();
  server.once("error", reject);
  server.listen(0, "127.0.0.1", () => { const { port } = server.address(); server.close(() => resolve(port)); });
});
async function request(port, route, options = {}) {
  const response = await fetch(`http://127.0.0.1:${port}${route}`, { ...options, headers: { "content-type": "application/json", ...(options.headers ?? {}) } });
  return { response, body: await response.json().catch(() => null) };
}

async function withServer(env, run) {
  const directory = await mkdtemp(path.join(tmpdir(), "hydra-umc-server-jwks-"));
  const port = await reservePort();
  let child;
  try {
    await mkdir(path.join(directory, "data"), { recursive: true });
    await writeFile(path.join(directory, "data", "settings.json"), JSON.stringify({ settings: { serverName: "HYDRA-UMC jwks contract" }, controllers: [] }));
    child = spawn(process.execPath, [TSX_CLI, SERVER_SOURCE], {
      cwd: directory,
      env: {
        ...process.env, PORT: String(port), NODE_ENV: "test", JWT_SECRET: "local-jwks-contract-verification-only-not-for-deployment",
        HYDRA_UMC_BOOTSTRAP_ADMIN_USERNAME: ADMIN.username, HYDRA_UMC_BOOTSTRAP_ADMIN_PASSWORD: ADMIN.password, LOGIN_RATE_LIMIT_MAX: "100",
        HYDRA_UMC_PORTS_REGISTRY: "off", HYDRA_UMC_JWT_KEYS_FILE: path.join(directory, "keys", "jwt-keys.json"), ...env,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.on("data", () => undefined);
    child.stderr.on("data", () => undefined);
    await waitUntil(async () => { try { return (await fetch(`http://127.0.0.1:${port}/api/hydra-info`)).ok; } catch { return false; } }, "server to accept connections");
    await run(port);
  } finally {
    if (child && child.exitCode === null) { child.kill(); await new Promise((resolve) => child.once("exit", resolve)); }
    await rm(directory, { recursive: true, force: true, maxRetries: 15, retryDelay: 200 }).catch(() => undefined);
  }
}

const put = (port, headers, patch) => request(port, "/api/admin/server-config", { method: "PUT", headers, body: JSON.stringify(patch) });
const bearer = (token) => ({ authorization: `Bearer ${token}` });
const headerOf = (token) => JSON.parse(Buffer.from(token.split(".")[0], "base64url").toString());
const b64u = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
const login = async (port, credentials) => (await request(port, "/api/login", { method: "POST", body: JSON.stringify(credentials) })).body.token;
const whoami = async (port, token) => (await request(port, "/api/admin/jwt-keys", { headers: bearer(token) })).response.status;

async function createOperator(port, admin) {
  const created = await request(port, "/api/users", { method: "POST", headers: admin, body: JSON.stringify({ ...OPERATOR, role: "operator" }) });
  assert.equal(created.response.status, 200);
  return login(port, OPERATOR);
}

async function main() {
  await withServer({}, async (port) => {
    const hsToken = await login(port, ADMIN);
    assert.equal(headerOf(hsToken).alg, "HS256", "HS256 is the default");
    const admin = bearer(hsToken);

    // --- default: nothing is published and there is nothing to rotate
    const closed = await fetch(`http://127.0.0.1:${port}/.well-known/jwks.json`);
    assert.equal(closed.status, 404);
    assert.equal(closed.headers.get("cache-control"), "no-store");
    const config = (await request(port, "/api/admin/server-config", { headers: admin })).body;
    assert.deepEqual(config.auth.jwtAlgorithm, { value: "HS256", source: "default" });
    assert.deepEqual(config.auth.acceptHs256, { value: true, source: "default" });
    const idle = await request(port, "/api/admin/jwt-keys", { headers: admin });
    assert.equal(idle.response.status, 200);
    assert.deepEqual(idle.body, { algorithm: "HS256", keys: [], jwksPath: "/.well-known/jwks.json" });
    assert.equal((await request(port, "/api/admin/jwt-keys/rotate", { method: "POST", headers: admin })).response.status, 409);
    assert.equal((await request(port, "/api/admin/jwt-keys")).response.status, 401);

    // --- who may change it, and what is refused
    assert.equal((await put(port, bearer(await createOperator(port, admin)), { auth: { jwtAlgorithm: "EdDSA" } })).response.status, 403);
    for (const bad of ["RS256", "none", "hs256 ", 7]) assert.equal((await put(port, admin, { auth: { jwtAlgorithm: bad } })).response.status, 400, `refuses ${bad}`);
    assert.equal((await put(port, admin, { auth: { acceptHs256: "no" } })).response.status, 400);

    // --- EdDSA on: the key set is public and carries no private part
    const on = await put(port, admin, { auth: { jwtAlgorithm: "EdDSA" } });
    assert.equal(on.response.status, 200, JSON.stringify(on.body));
    assert.ok(on.body.warnings.includes("jwt_eddsa_on"));
    const published = await fetch(`http://127.0.0.1:${port}/.well-known/jwks.json`);
    assert.equal(published.status, 200);
    assert.match(published.headers.get("cache-control"), /public, max-age=300/);
    assert.match(published.headers.get("content-type"), /application\/jwk-set\+json/);
    assert.equal(published.headers.get("x-powered-by"), null);
    assert.equal(published.headers.get("x-content-type-options"), "nosniff");
    const text = await published.text();
    assert.ok(!/PRIVATE|"d"/.test(text));
    const jwks = JSON.parse(text);
    assert.equal(jwks.keys.length, 1);
    assert.deepEqual(Object.keys(jwks.keys[0]).sort(), ["alg", "crv", "kid", "kty", "use", "x"]);

    const edToken = await login(port, ADMIN);
    assert.equal(headerOf(edToken).alg, "EdDSA");
    assert.equal(headerOf(edToken).kid, jwks.keys[0].kid);
    assert.equal(await whoami(port, edToken), 200);
    assert.equal(await whoami(port, hsToken), 200, "the HS256 token of before still works during the transition");
    const publicKey = crypto.createPublicKey({ key: jwks.keys[0], format: "jwk" });
    const [h, p, s] = edToken.split(".");
    assert.equal(crypto.verify(null, Buffer.from(`${h}.${p}`), publicKey, Buffer.from(s, "base64url")), true, "an outside verifier can check the token with the published key");

    // --- rotation: two keys valid, the new one signs
    const rotated = await request(port, "/api/admin/jwt-keys/rotate", { method: "POST", headers: bearer(edToken) });
    assert.equal(rotated.response.status, 200, JSON.stringify(rotated.body));
    assert.equal(rotated.body.keys.length, 2);
    assert.notEqual(rotated.body.kid, jwks.keys[0].kid);
    assert.ok(!JSON.stringify(rotated.body).includes("PRIVATE"));
    assert.equal((await (await fetch(`http://127.0.0.1:${port}/.well-known/jwks.json`)).json()).keys.length, 2);
    assert.equal(await whoami(port, edToken), 200, "a token of the old key still works during the overlap");
    const newToken = await login(port, ADMIN);
    assert.equal(headerOf(newToken).kid, rotated.body.kid);

    // --- forged tokens
    const claims = Buffer.from(edToken.split(".")[1], "base64url").toString();
    const none = `${b64u({ alg: "none", typ: "JWT" })}.${Buffer.from(claims).toString("base64url")}.`;
    assert.equal(await whoami(port, none), 403);
    const confused = jwt.sign(JSON.parse(claims), jwks.keys[0].x, { algorithm: "HS256", keyid: jwks.keys[0].kid, noTimestamp: true });
    assert.equal(await whoami(port, confused), 403);
    assert.equal(await whoami(port, `${edToken.slice(0, -4)}AAAA`), 403, "a tampered signature");

    // --- HS256 refused once the transition is over
    const strict = await put(port, admin, { auth: { acceptHs256: false } });
    assert.equal(strict.response.status, 200);
    assert.ok(strict.body.warnings.includes("jwt_hs256_refused"));
    const refused = await request(port, "/api/admin/jwt-keys", { headers: admin });
    assert.equal(refused.response.status, 403);
    assert.equal(refused.body.code, "TOKEN_INVALID");
    assert.equal(await whoami(port, newToken), 200);

    // --- back to the default: nothing published, EdDSA tokens refused
    assert.equal((await put(port, bearer(newToken), { auth: { jwtAlgorithm: "HS256" } })).response.status, 200);
    assert.equal((await fetch(`http://127.0.0.1:${port}/.well-known/jwks.json`)).status, 404);
    assert.equal(await whoami(port, newToken), 403);
    assert.equal(headerOf(await login(port, ADMIN)).alg, "HS256");
  });

  // --- the environment wins and locks the option
  await withServer({ HYDRA_UMC_JWT_ALGORITHM: "HS256" }, async (port) => {
    const admin = bearer(await login(port, ADMIN));
    const locked = await put(port, admin, { auth: { jwtAlgorithm: "EdDSA" } });
    assert.equal(locked.response.status, 409);
    assert.match(locked.body.error, /HYDRA_UMC_JWT_ALGORITHM/);
  });
  await withServer({ HYDRA_UMC_JWT_ALGORITHM: "EdDSA" }, async (port) => {
    assert.equal((await fetch(`http://127.0.0.1:${port}/.well-known/jwks.json`)).status, 200, "chosen by the environment: on from the first start");
    assert.equal(headerOf(await login(port, ADMIN)).alg, "EdDSA");
  });
  console.log("SERVER_JWKS_CONTRACT=PASS");
}

main().catch((error) => { console.error(error); process.exit(1); });
