import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  DEVICE_TOKEN_DEFAULT_DAYS, DEVICE_TOKEN_LIMIT_DAYS, DEVICE_TOKEN_DEFAULT_MAX_DAYS, DEVICE_SESSION_DEFAULT_MINUTES, DEVICE_SESSION_MIN_MINUTES,
  DeviceTokenError, DeviceTokenStore, DeviceTokensFileError, deviceSessionMinutes, deviceTokenDays, deviceTokenKey, deviceTokenMaxDevices,
} from "../src/deviceTokens.ts";
import { infoTicketKey } from "../src/infoTickets.ts";
import { SecurityConfig, SecurityConfigError, resolveDeviceTokens, type SecurityFile } from "../src/securityConfig.ts";

const secret = "a-long-random-server-secret-for-the-tests-0123456789";
const DAY = 86_400_000;

function makeStore(clock: { now: number }, key = deviceTokenKey(secret)) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hydra-device-tokens-"));
  const file = path.join(dir, "data", "device-tokens.json");
  return { dir, file, store: new DeviceTokenStore({ file, key, now: () => clock.now }) };
}

const issue = (store: DeviceTokenStore, over: Partial<Parameters<DeviceTokenStore["issue"]>[0]> = {}) =>
  store.issue({ name: "Bench screen", username: "panel", accountId: "acc-1", days: 30, createdBy: "root", maxDevices: 20, ...over });

test("a token signs one device in until it expires, and the record never holds the token", () => {
  const clock = { now: 1_800_000_000_000 };
  const { store, file } = makeStore(clock);
  const { token, view } = issue(store);
  assert.match(token, /^hdt1\.[A-Za-z0-9_-]{22}\.\d+\.[A-Za-z0-9_-]{43}$/);
  assert.equal(view.state, "active");
  assert.equal(view.username, "panel");
  const ok = store.verify(token);
  assert.equal(ok.ok, true);
  if (ok.ok) assert.equal(ok.record.accountId, "acc-1");
  assert.ok(!fs.readFileSync(file, "utf-8").includes(token.split(".")[3]), "the signature is not stored");
  assert.ok(!fs.readFileSync(file, "utf-8").includes(token), "the token is not stored");
  clock.now += 29 * DAY;
  assert.equal(store.verify(token).ok, true);
  clock.now += 2 * DAY;
  assert.deepEqual(store.verify(token), { ok: false, reason: "expired" });
  assert.equal(store.list()[0].state, "expired");
});

test("a token that was changed, cut or signed with another key is refused, and so is one for a record that does not exist", () => {
  const clock = { now: 1_800_000_000_000 };
  const { store, file } = makeStore(clock);
  const { token } = issue(store);
  const [prefix, id, expiry, sig] = token.split(".");
  const reasons = (t: unknown) => { const r = store.verify(t); return r.ok ? "ok" : r.reason; };
  assert.equal(reasons(`${prefix}.${id}.${Number(expiry) + 86400}.${sig}`), "signature");
  assert.equal(reasons(`${prefix}.${id}.${expiry}.${sig.slice(0, -2)}xx`), "signature");
  assert.equal(reasons(`${prefix}.${"A".repeat(22)}.${expiry}.${sig}`), "unknown");
  for (const bad of ["", "hdt1", `${prefix}.${id}.${expiry}`, `other.${id}.${expiry}.${sig}`, `${prefix}.short.${expiry}.${sig}`, `${prefix}.${id}.abc.${sig}`, 7, null, undefined, "x".repeat(300)]) {
    assert.equal(reasons(bad), "malformed", String(bad));
  }
  const other = new DeviceTokenStore({ file, key: deviceTokenKey("another-secret-of-the-same-length-0123456789012"), now: () => clock.now });
  assert.equal(other.verify(token).ok, false);
  // editing the record (the account) breaks the signature: the token is bound to the account it was issued for
  const records = JSON.parse(fs.readFileSync(file, "utf-8"));
  records[0].username = "admin";
  fs.writeFileSync(file, JSON.stringify(records));
  assert.deepEqual(store.verify(token), { ok: false, reason: "signature" });
});

test("a token from the key of another ticket is not a device token", () => {
  assert.notDeepEqual(deviceTokenKey(secret), infoTicketKey(secret));
});

test("revoking a token ends it for good, once, and the list says so", () => {
  const clock = { now: 1_800_000_000_000 };
  const { store } = makeStore(clock);
  const first = issue(store, { name: "A" });
  clock.now += 1000;
  const second = issue(store, { name: "B" });
  assert.equal(store.isActive(first.view.id), true);
  assert.equal(store.revoke(first.view.id), true);
  assert.equal(store.revoke(first.view.id), false, "a second revocation changes nothing");
  assert.equal(store.revoke("B".repeat(22)), false);
  assert.equal(store.isActive(first.view.id), false);
  assert.deepEqual(store.verify(first.token), { ok: false, reason: "revoked" });
  assert.equal(store.verify(second.token).ok, true);
  const list = store.list();
  assert.deepEqual(list.map((item) => [item.name, item.state]), [["B", "active"], ["A", "revoked"]], "newest first");
  assert.ok(list[1].revokedAt);
  assert.ok(list[0].lastUsedAt, "a use is noted");
});

test("only so many tokens can be active at once; an expired or revoked one does not count and old records are forgotten", () => {
  const clock = { now: 1_800_000_000_000 };
  const { store } = makeStore(clock);
  const a = issue(store, { maxDevices: 2 });
  issue(store, { maxDevices: 2 });
  assert.throws(() => issue(store, { maxDevices: 2 }), (e: unknown) => e instanceof DeviceTokenError && e.status === 409);
  store.revoke(a.view.id);
  issue(store, { maxDevices: 2 });
  assert.equal(store.activeCount(), 2);
  clock.now += 400 * DAY;
  issue(store, { maxDevices: 2, days: 1 });
  assert.equal(store.list().length, 1, "everything that ended long ago is forgotten");
});

test("a damaged file is an error, never an empty list that would forget a revocation", () => {
  const clock = { now: 1_800_000_000_000 };
  const { store, file } = makeStore(clock);
  issue(store);
  fs.writeFileSync(file, "{not json");
  assert.throws(() => store.list(), DeviceTokensFileError);
  fs.writeFileSync(file, "{}");
  assert.throws(() => store.list(), DeviceTokensFileError);
});

test("the life of a token, the number of devices and the life of a device session come from the file within their limits", () => {
  assert.equal(deviceTokenDays(undefined, undefined), DEVICE_TOKEN_DEFAULT_DAYS);
  assert.equal(deviceTokenDays({}, "abc"), DEVICE_TOKEN_DEFAULT_DAYS);
  assert.equal(deviceTokenDays({ maxTtlDays: 400 }, 1e9), DEVICE_TOKEN_LIMIT_DAYS);
  assert.equal(deviceTokenDays({}, 1e9), DEVICE_TOKEN_DEFAULT_MAX_DAYS, "nothing lives longer than the default maximum until an administrator allows it");
  assert.equal(deviceTokenDays({ maxTtlDays: 10 }, 5), 5);
  assert.equal(deviceTokenDays({ maxTtlDays: 10 }, 0), 1);
  assert.equal(deviceTokenDays({ maxTtlDays: 10, ttlDays: 60 }, undefined), 10, "the default life never beats the maximum");
  assert.equal(deviceTokenMaxDevices(undefined), 20);
  assert.equal(deviceTokenMaxDevices({ maxDevices: 0 }), 1);
  assert.equal(deviceTokenMaxDevices({ maxDevices: 1e9 }), 500);
  assert.equal(deviceSessionMinutes(undefined), DEVICE_SESSION_DEFAULT_MINUTES);
  assert.equal(deviceSessionMinutes({ accessMinutes: 1 }), DEVICE_SESSION_MIN_MINUTES);
  assert.equal(deviceSessionMinutes({ accessMinutes: 60 }), 60);
  assert.equal(deviceSessionMinutes({ accessMinutes: "no" }), DEVICE_SESSION_DEFAULT_MINUTES);
});

// ---- the switch -----------------------------------------------------------------------------------------------------------------------------

function makeConfig(env: any = {}, initial: SecurityFile = {}) {
  let stored: SecurityFile = { ...initial };
  const logs: string[] = [];
  const config = new SecurityConfig({ env, load: () => ({ ...stored }), save: (file) => { stored = { ...file }; }, tlsActive: false, log: (m) => logs.push(m) });
  return { config, logs, stored: () => stored };
}
const bad400 = (e: unknown) => e instanceof SecurityConfigError && e.status === 400;

test("the device tokens are off by default and only the exact word 1 turns them on from the environment", () => {
  const { config } = makeConfig();
  assert.equal(config.deviceTokensEnabled(), false);
  assert.deepEqual(config.snapshot().deviceTokens.enabled, { value: false, source: "default" });
  assert.equal(makeConfig({ deviceTokens: "1" }).config.deviceTokensEnabled(), true);
  for (const word of ["true", "yes", "on", "0", ""]) assert.equal(makeConfig({ deviceTokens: word }).config.deviceTokensEnabled(), false, word);
  assert.deepEqual(resolveDeviceTokens(undefined, { deviceTokens: { enabled: true } }), { value: true, source: "config" });
});

test("turning the device tokens on needs the confirmation, off does not, the limits of the file are kept and the environment locks the switch", () => {
  const { config, logs, stored } = makeConfig({}, { deviceTokens: { maxTtlDays: 10 } });
  assert.throws(() => config.update({ deviceTokens: { enabled: true } }, "root"), bad400);
  assert.throws(() => config.update({ deviceTokens: { enabled: true, confirm: "yes" } }, "root"), bad400);
  assert.equal(config.deviceTokensEnabled(), false);
  const on = config.update({ deviceTokens: { enabled: true, confirm: true } }, "root");
  assert.ok(on.warnings.includes("device_tokens_on"));
  assert.equal(config.deviceTokensEnabled(), true);
  assert.deepEqual(stored().deviceTokens, { enabled: true, maxTtlDays: 10 });
  assert.ok(logs.some((line) => line.includes("device tokens") && line.includes("on")));
  const off = config.update({ deviceTokens: { enabled: false } }, "root");
  assert.deepEqual(off.warnings, []);
  assert.equal(config.deviceTokensEnabled(), false);
  for (const value of ["yes", 1, null]) assert.throws(() => config.update({ deviceTokens: { enabled: value } }, "root"), bad400);
  assert.throws(() => config.update({ deviceTokens: [] }, "root"), bad400);
  assert.throws(() => makeConfig({ deviceTokens: "1" }).config.update({ deviceTokens: { enabled: false } }, "root"), (e: unknown) => e instanceof SecurityConfigError && e.status === 409 && /DEVICE_TOKENS/.test(e.message));
});

// ---- over HTTP ------------------------------------------------------------------------------------------------------------------------------

test("a device signs in with its token, renews its session, and stops when the token is revoked, expires or the switch goes off", async () => {
  // this test refuses a device token several times from one address: the limit of failed sign-ins must not stop it
  process.env.LOGIN_RATE_LIMIT_MAX = "100";
  const { default: express } = await import("express");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hydra-device-http-"));
  const originalCwd = process.cwd();
  process.chdir(dir);
  let server: import("node:http").Server | undefined;
  try {
    const { createUser, findUser, effectiveId } = await import("../src/users.ts");
    const { registerAuthRoutes } = await import("../src/routes/auth.ts");
    const { registerDeviceRoutes } = await import("../src/routes/deviceRoutes.ts");
    const { authenticate, requireAdmin } = await import("../src/auth.ts");
    await createUser("root", "correct-horse-battery", "admin");
    await createUser("panel", "another-long-password-1", "operator");
    const clock = { now: Date.now() };
    const store = new DeviceTokenStore({ file: path.join(dir, "data", "device-tokens.json"), key: deviceTokenKey(secret), now: () => clock.now });
    let enabled = true;
    let limits: any = { accessMinutes: 5 };
    const audit: any[] = [];
    const app = express();
    app.use(express.json());
    registerAuthRoutes(app, { devices: { enabled: () => enabled, store, limits: () => limits } });
    registerDeviceRoutes(app, { authenticate, requireAdmin, enabled: () => enabled, store, limits: () => limits, audit: { record: (event) => audit.push(event) } });
    server = app.listen(0, "127.0.0.1");
    await new Promise((resolve) => server!.once("listening", resolve));
    const base = "http://127.0.0.1:" + (server.address() as import("node:net").AddressInfo).port;
    const call = async (method: string, url: string, body?: unknown, token?: string) => {
      const response = await fetch(base + url, { method, headers: { "content-type": "application/json", ...(token ? { authorization: "Bearer " + token } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
      return { status: response.status, body: (await response.json().catch(() => ({}))) as any };
    };
    const admin = (await call("POST", "/api/login", { username: "root", password: "correct-horse-battery" })).body.token as string;
    const asDevice = { name: "Bench screen", username: "panel", confirm: true };

    // the issuing needs an administrator, a name, an account that is not an administrator, and the confirmation
    assert.equal((await call("POST", "/api/admin/device-tokens", asDevice)).status, 401);
    const operator = (await call("POST", "/api/login", { username: "panel", password: "another-long-password-1" })).body.token as string;
    assert.equal((await call("POST", "/api/admin/device-tokens", asDevice, operator)).status, 403);
    assert.equal((await call("POST", "/api/admin/device-tokens", { ...asDevice, confirm: undefined }, admin)).status, 400);
    assert.equal((await call("POST", "/api/admin/device-tokens", { ...asDevice, name: "" }, admin)).status, 400);
    assert.equal((await call("POST", "/api/admin/device-tokens", { ...asDevice, ttlDays: -3 }, admin)).status, 400);
    assert.equal((await call("POST", "/api/admin/device-tokens", { ...asDevice, username: "nobody" }, admin)).status, 404);
    assert.equal((await call("POST", "/api/admin/device-tokens", { ...asDevice, username: "root" }, admin)).status, 400, "never for an administrator");

    const issued = await call("POST", "/api/admin/device-tokens", asDevice, admin);
    assert.equal(issued.status, 200);
    assert.match(issued.body.token, /^hdt1\./);
    assert.equal(issued.body.username, "panel");
    assert.equal(audit.at(-1).type, "device-token-issued");
    assert.ok(!JSON.stringify(audit).includes(issued.body.token), "the audit record never holds the token");
    const listed = await call("GET", "/api/admin/device-tokens", undefined, admin);
    assert.equal(listed.status, 200);
    assert.equal(listed.body.items.length, 1);
    assert.equal(listed.body.items[0].token, undefined, "the list never shows a token");

    // the device signs in: the same answer as a login, with a short access token
    assert.equal((await call("POST", "/api/device/login", { token: "hdt1.nonsense" })).status, 401);
    assert.equal((await call("POST", "/api/device/login", {})).status, 401);
    const signed = await call("POST", "/api/device/login", { token: issued.body.token });
    assert.equal(signed.status, 200);
    assert.equal(signed.body.role, "operator");
    assert.ok(signed.body.refreshToken);
    const payload = JSON.parse(Buffer.from(signed.body.token.split(".")[1], "base64url").toString());
    assert.equal(payload.username, "panel");
    assert.ok(payload.exp - payload.iat <= 5 * 60, "the access token lives minutes, not days");
    // what the device holds is the operator's rights, not an administrator's
    assert.equal((await call("GET", "/api/admin/device-tokens", undefined, signed.body.token)).status, 403);

    // renewal rotates the refresh token and keeps the short life
    const renewed = await call("POST", "/api/refresh", { refreshToken: signed.body.refreshToken });
    assert.equal(renewed.status, 200);
    const renewedPayload = JSON.parse(Buffer.from(renewed.body.token.split(".")[1], "base64url").toString());
    assert.ok(renewedPayload.exp - renewedPayload.iat <= 5 * 60);

    // an account deleted and created again under the same name does not inherit the token
    const { deleteUser } = await import("../src/users.ts");
    const before = effectiveId(findUser("panel")!);
    await deleteUser("panel");
    await createUser("panel", "another-long-password-1", "operator");
    assert.notEqual(effectiveId(findUser("panel")!), before);
    assert.equal((await call("POST", "/api/device/login", { token: issued.body.token })).status, 401);
    assert.equal((await call("POST", "/api/device/login", { token: (await call("POST", "/api/admin/device-tokens", asDevice, admin)).body.token })).status, 200);

    // the switch off: 404 everywhere and a session cannot be renewed
    const again = await call("POST", "/api/admin/device-tokens", asDevice, admin);
    const second = await call("POST", "/api/device/login", { token: again.body.token });
    enabled = false;
    assert.equal((await call("POST", "/api/device/login", { token: again.body.token })).status, 404);
    assert.equal((await call("GET", "/api/admin/device-tokens", undefined, admin)).status, 404);
    assert.equal((await call("POST", "/api/admin/device-tokens", asDevice, admin)).status, 404);
    assert.equal((await call("POST", "/api/refresh", { refreshToken: second.body.refreshToken })).status, 401);
    enabled = true;

    // revoking ends the token and the sessions opened with it
    const third = await call("POST", "/api/admin/device-tokens", asDevice, admin);
    const session = await call("POST", "/api/device/login", { token: third.body.token });
    assert.equal((await call("DELETE", "/api/admin/device-tokens/not-an-id", undefined, admin)).status, 400);
    assert.equal((await call("DELETE", "/api/admin/device-tokens/" + "C".repeat(22), undefined, admin)).status, 404);
    const gone = await call("DELETE", "/api/admin/device-tokens/" + third.body.id, undefined, admin);
    assert.equal(gone.status, 200);
    assert.equal(gone.body.revoked, true);
    assert.equal(gone.body.sessionsEnded, 1);
    assert.equal(audit.at(-1).type, "device-token-revoked");
    assert.equal((await call("POST", "/api/refresh", { refreshToken: session.body.refreshToken })).status, 401);
    assert.equal((await call("POST", "/api/device/login", { token: third.body.token })).status, 401);

    // an expired token: the device can no longer sign in
    const last = await call("POST", "/api/admin/device-tokens", { ...asDevice, ttlDays: 1 }, admin);
    clock.now += 2 * DAY;
    assert.equal((await call("POST", "/api/device/login", { token: last.body.token })).status, 401);
  } finally {
    await new Promise((resolve) => (server ? server.close(resolve) : resolve(undefined)));
    process.chdir(originalCwd);
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});
