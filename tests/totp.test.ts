// =============================================================================
// HYDRA-UMC-SERVER - tests for src/totp.ts and the second factor of the sign-in
// Copyright (C) 2026 JuanenRac (Electro Hobby 3D) <electrohobby3d@gmail.com>
// GPL-3.0 - see LICENSE
// =============================================================================
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import express from "express";
import { TotpStore, base32, fromBase32, totpCode, stepOf, RECOVERY_CODES } from "../src/totp";

const RFC_SECRET = Buffer.from("12345678901234567890");

test("RFC 4226 HOTP values and RFC 6238 TOTP values (SHA-1)", () => {
  const hotp = ["755224", "287082", "359152", "969429", "338314"];
  hotp.forEach((expected, counter) => assert.equal(totpCode(RFC_SECRET, counter), expected));
  // RFC 6238 appendix B, the last six digits of the 8-digit values
  const vectors: Array<[number, string]> = [[59, "287082"], [1111111109, "081804"], [1111111111, "050471"], [1234567890, "005924"], [2000000000, "279037"]];
  for (const [seconds, expected] of vectors) assert.equal(totpCode(RFC_SECRET, stepOf(seconds * 1000)), expected);
});

test("base32 round trip and rejection of other characters", () => {
  for (const size of [1, 5, 10, 20, 33]) {
    const bytes = Buffer.from(Array.from({ length: size }, (_, i) => (i * 37 + 11) & 255));
    assert.deepEqual(fromBase32(base32(bytes)), bytes);
  }
  assert.equal(base32(Buffer.from("foobar")), "MZXW6YTBOI");
  assert.throws(() => fromBase32("MZXW1"), /base32/);
});

function newStore(now: { t: number }): { store: TotpStore; file: string; dir: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hydra-umc-totp-"));
  const file = path.join(dir, "data", "totp.json");
  return { store: new TotpStore({ file, secret: "test-secret", now: () => now.t }), file, dir };
}

test("enrolment: not in force until confirmed, recovery codes once, replay refused", () => {
  const clock = { t: 1_700_000_000_000 };
  const { store, file, dir } = newStore(clock);
  try {
    const { secret, uri } = store.begin("u1", "ana");
    assert.match(uri, /^otpauth:\/\/totp\/HYDRA-UMC:ana\?secret=[A-Z2-7]+&issuer=HYDRA-UMC/);
    assert.equal(store.enabled("u1"), false);
    assert.equal(store.confirm("u1", "000000"), undefined);
    const key = fromBase32(secret);
    const code = totpCode(key, stepOf(clock.t));
    const recovery = store.confirm("u1", code);
    assert.ok(recovery && recovery.length === RECOVERY_CODES);
    assert.equal(store.enabled("u1"), true);
    // the code that confirmed is spent
    assert.equal(store.verify("u1", code), false);
    clock.t += 30_000;
    assert.equal(store.verify("u1", totpCode(key, stepOf(clock.t))), true);
    // a recovery code works once
    assert.equal(store.verify("u1", recovery![0]!), true);
    assert.equal(store.verify("u1", recovery![0]!), false);
    assert.equal(store.recoveryLeft("u1"), RECOVERY_CODES - 1);
    // the secret is not in the file in the clear
    const text = fs.readFileSync(file, "utf8");
    assert.ok(!text.includes(secret));
    // a new store reads it back
    const again = new TotpStore({ file, secret: "test-secret", now: () => clock.t });
    assert.equal(again.enabled("u1"), true);
    // another key cannot open it
    const wrong = new TotpStore({ file, secret: "other", now: () => clock.t });
    clock.t += 30_000;
    assert.equal(wrong.verify("u1", totpCode(key, stepOf(clock.t))), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("five wrong codes make the next tries wait", () => {
  const clock = { t: 1_700_000_000_000 };
  const { store, dir } = newStore(clock);
  try {
    const { secret } = store.begin("u2", "bob");
    const key = fromBase32(secret);
    assert.ok(store.confirm("u2", totpCode(key, stepOf(clock.t))));
    clock.t += 30_000;
    for (let i = 0; i < 5; i += 1) assert.equal(store.verify("u2", "123456"), false);
    assert.ok(store.waitFor("u2") > 0);
    assert.equal(store.verify("u2", totpCode(key, stepOf(clock.t))), false, "even the right code waits");
    clock.t += 40_000;
    assert.equal(store.waitFor("u2"), 0);
    assert.equal(store.verify("u2", totpCode(key, stepOf(clock.t))), true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("disable removes the factor", () => {
  const clock = { t: 1_700_000_000_000 };
  const { store, dir } = newStore(clock);
  try {
    const { secret } = store.begin("u3", "eva");
    store.confirm("u3", totpCode(fromBase32(secret), stepOf(clock.t)));
    store.disable("u3");
    assert.equal(store.enabled("u3"), false);
    assert.equal(store.verify("u3", "123456"), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("sign-in over HTTP: an account without the factor signs in as before, one with it needs a code", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hydra-umc-totp-http-"));
  const originalCwd = process.cwd();
  process.chdir(dir);
  let server: import("node:http").Server | undefined;
  try {
    const { createUser } = await import("../src/users");
    const { registerAuthRoutes } = await import("../src/routes/auth");
    const { registerTotpRoutes } = await import("../src/routes/totpRoutes");
    assert.deepEqual(await createUser("ana", "correct-horse-battery", "operator"), { ok: true });
    assert.deepEqual(await createUser("root", "another-long-password", "admin"), { ok: true });
    const app = express();
    app.use(express.json());
    registerAuthRoutes(app);
    registerTotpRoutes(app);
    server = app.listen(0, "127.0.0.1");
    await new Promise((resolve) => server!.once("listening", resolve));
    const base = "http://127.0.0.1:" + (server.address() as AddressInfo).port;
    const call = async (method: string, url: string, body?: unknown, token?: string) => {
      const response = await fetch(base + url, { method, headers: { "content-type": "application/json", ...(token ? { authorization: "Bearer " + token } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
      return { status: response.status, body: (await response.json().catch(() => ({}))) as any };
    };

    const plain = await call("POST", "/api/login", { username: "ana", password: "correct-horse-battery" });
    assert.equal(plain.status, 200);
    const token = plain.body.token as string;
    assert.equal((await call("GET", "/api/totp/status", undefined, token)).body.enabled, false);
    assert.equal((await call("GET", "/api/totp/status")).status, 401);

    // enrolment needs the password again
    assert.equal((await call("POST", "/api/totp/begin", { password: "wrong" }, token)).status, 401);
    const begun = await call("POST", "/api/totp/begin", { password: "correct-horse-battery" }, token);
    assert.equal(begun.status, 200);
    const key = fromBase32(begun.body.secret);
    assert.equal((await call("POST", "/api/totp/confirm", { code: "000000" }, token)).status, 400);
    const confirmed = await call("POST", "/api/totp/confirm", { code: totpCode(key, stepOf(Date.now())) }, token);
    assert.equal(confirmed.status, 200);
    const recovery = confirmed.body.recoveryCodes as string[];
    assert.equal(recovery.length, RECOVERY_CODES);

    // now the password alone is not enough
    const missing = await call("POST", "/api/login", { username: "ana", password: "correct-horse-battery" });
    assert.equal(missing.status, 401);
    assert.equal(missing.body.totpRequired, true);
    assert.equal(missing.body.token, undefined);
    const bad = await call("POST", "/api/login", { username: "ana", password: "correct-horse-battery", totp: "111111" });
    assert.equal(bad.status, 401);
    const viaRecovery = await call("POST", "/api/login", { username: "ana", password: "correct-horse-battery", totp: recovery[0] });
    assert.equal(viaRecovery.status, 200);
    assert.ok(viaRecovery.body.token);
    // the recovery code is spent
    assert.equal((await call("POST", "/api/login", { username: "ana", password: "correct-horse-battery", totp: recovery[0] })).status, 401);

    // turning it off needs the password and a code; an operator cannot reset someone else's
    assert.equal((await call("POST", "/api/totp/disable", { password: "correct-horse-battery" }, token)).status, 401);
    assert.equal((await call("DELETE", "/api/users/ana/totp", undefined, token)).status, 403);
    const admin = (await call("POST", "/api/login", { username: "root", password: "another-long-password" })).body.token as string;
    assert.equal((await call("DELETE", "/api/users/ana/totp", undefined, admin)).status, 200);
    assert.equal((await call("DELETE", "/api/users/nobody/totp", undefined, admin)).status, 404);
    assert.equal((await call("POST", "/api/login", { username: "ana", password: "correct-horse-battery" })).status, 200);
  } finally {
    server?.close();
    process.chdir(originalCwd);
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});
