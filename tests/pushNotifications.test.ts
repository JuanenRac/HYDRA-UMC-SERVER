import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import http2 from "node:http2";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import express from "express";
import { SecurityConfig, SecurityConfigError, type SecurityFile } from "../src/securityConfig.ts";
import { registerPushRoutes, makePushGate } from "../src/routes/pushRoutes.ts";
import {
  ApnsClient,
  LOCALES,
  PushDevices,
  PushService,
  emitPush,
  pushText,
  readApnsCredentials,
  validDeviceToken,
  type ApnsCredentials,
  type ApnsSender,
} from "../src/pushNotifications.ts";

const TOKEN = "a".repeat(64);
const TOKEN2 = "b".repeat(64);

function keyPair() {
  return crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
}

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "hydra-push-"));
}

function writeKey(dir: string) {
  const { privateKey, publicKey } = keyPair();
  const file = path.join(dir, "AuthKey_TEST.p8");
  fs.writeFileSync(file, privateKey.export({ type: "pkcs8", format: "pem" }));
  return { file, publicKey };
}

function env(file: string, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return { HYDRA_UMC_APNS_KEY_FILE: file, HYDRA_UMC_APNS_KEY_ID: "ABC1234567", HYDRA_UMC_APNS_TEAM_ID: "TEAM123456", HYDRA_UMC_APNS_TOPIC: "com.example.hydra", ...extra };
}

class FakeSender implements ApnsSender {
  sent: { token: string; payload: any; collapseId?: string; expires: number }[] = [];
  answers = new Map<string, { status: number; reason?: string }>();
  closed = false;
  async send(token: string, payload: Record<string, unknown>, options: { collapseId?: string; expiresInSeconds: number }) {
    this.sent.push({ token, payload, collapseId: options.collapseId, expires: options.expiresInSeconds });
    return this.answers.get(token) ?? { status: 200 };
  }
  close() {
    this.closed = true;
  }
}

function makeService(opts: { enabled?: boolean; config?: any; environment?: NodeJS.ProcessEnv } = {}) {
  const dir = tempDir();
  const devices = new PushDevices({ file: path.join(dir, "devices.json"), maxDevices: () => 3 });
  const sender = new FakeSender();
  const logs: string[] = [];
  const key = writeKey(dir);
  const service = new PushService({
    enabled: () => opts.enabled ?? true,
    config: () => opts.config,
    devices,
    env: () => opts.environment ?? env(key.file),
    makeSender: () => sender,
    log: (l) => logs.push(l),
  });
  return { service, devices, sender, logs, dir, key };
}

// ---- credentials ---------------------------------------------------------------------------------------------------------------------------------

test("the credentials are read from the environment and a key inside the working directory is refused", () => {
  const dir = tempDir();
  const { file } = writeKey(dir);
  const ok = readApnsCredentials(env(file));
  assert.ok("credentials" in ok);
  assert.equal((ok as any).credentials.topic, "com.example.hydra");

  assert.deepEqual(readApnsCredentials({}), { problem: "missing" });
  assert.deepEqual(readApnsCredentials(env(file, { HYDRA_UMC_APNS_KEY_ID: "short" })), { problem: "invalid" });
  assert.deepEqual(readApnsCredentials(env(file, { HYDRA_UMC_APNS_TOPIC: "has space" })), { problem: "invalid" });
  assert.deepEqual(readApnsCredentials(env(path.join(dir, "missing.p8"))), { problem: "key-unreadable" });
  assert.deepEqual(readApnsCredentials(env(file), dir), { problem: "key-in-repo" });
  const junk = path.join(dir, "junk.p8");
  fs.writeFileSync(junk, "not a key");
  assert.deepEqual(readApnsCredentials(env(junk)), { problem: "key-unreadable" });
});

// ---- the registry ---------------------------------------------------------------------------------------------------------------------------------

test("device tokens are registered, refreshed, limited, persisted and removed only by their owner", () => {
  const dir = tempDir();
  const file = path.join(dir, "devices.json");
  const devices = new PushDevices({ file, maxDevices: () => 2 });
  assert.equal(validDeviceToken(TOKEN), true);
  for (const bad of ["", "xyz", "a".repeat(10), 5, null, "g".repeat(64), "a".repeat(201)]) assert.equal(validDeviceToken(bad), false, String(bad));

  devices.register(TOKEN.toUpperCase(), "ana", "es");
  devices.register(TOKEN2, "ben", "ja");
  assert.equal(devices.count(), 2);
  assert.throws(() => devices.register("c".repeat(64), "cy", "en"), /too many/);
  // the same token again moves to the account that registered it last and does not count twice
  devices.register(TOKEN, "cy", "xx");
  assert.equal(devices.count(), 2);
  assert.equal(devices.list().find((d) => d.token === TOKEN)!.username, "cy");
  assert.equal(devices.list().find((d) => d.token === TOKEN)!.locale, "en", "an unknown language falls back to English");

  assert.equal(devices.remove(TOKEN, "ana"), false, "another account cannot remove it");
  assert.equal(devices.remove(TOKEN, "cy"), true);
  const again = new PushDevices({ file, maxDevices: () => 2 });
  assert.deepEqual(again.list().map((d) => d.token), [TOKEN2]);
  assert.equal(again.removeAccount("ben"), 1);
  assert.equal(again.count(), 0);
  assert.ok((fs.statSync(file).mode & 0o077) === 0 || process.platform === "win32", "the file is private");
});

// ---- texts ----------------------------------------------------------------------------------------------------------------------------------------

test("every notification reads in the eight languages and names the robot only when it is known", () => {
  const seen = new Set<string>();
  for (const locale of LOCALES) {
    const a = pushText("job-finished", locale, "A1");
    assert.ok(a.body.includes("A1"), locale);
    assert.ok(pushText("job-finished", locale).body.length > 0);
    const b = pushText("global-stop", locale);
    assert.ok(b.body.length > 0 && !/undefined|null/.test(b.body), locale);
    seen.add(a.body);
  }
  assert.equal(seen.size, 8, "no two languages share the same sentence");
  assert.equal(pushText("global-stop", "xx").body, pushText("global-stop", "en").body);
});

// ---- the service -----------------------------------------------------------------------------------------------------------------------------------

test("nothing is sent while the switch is off, the credentials are missing or the event is turned off", async () => {
  const off = makeService({ enabled: false });
  off.devices.register(TOKEN, "ana", "en");
  assert.equal(await off.service.notify("job-finished", { robotName: "A1" }), 0);
  assert.equal(off.sender.sent.length, 0);

  const noKey = makeService({ environment: {} });
  noKey.devices.register(TOKEN, "ana", "en");
  assert.equal(await noKey.service.notify("global-stop"), 0);
  assert.equal(noKey.service.status().configured, false);
  assert.equal(noKey.service.status().problem, "missing");

  const muted = makeService({ config: { notifyJobFinished: false } });
  muted.devices.register(TOKEN, "ana", "en");
  assert.equal(await muted.service.notify("job-finished"), 0);
  assert.equal(await muted.service.notify("global-stop"), 1);
});

test("a notification goes to every phone in its language, a dead token is forgotten and the status holds no secret", async () => {
  const t = makeService();
  t.devices.register(TOKEN, "ana", "es");
  t.devices.register(TOKEN2, "ben", "de");
  t.sender.answers.set(TOKEN2, { status: 410, reason: "Unregistered" });
  assert.equal(await t.service.notify("job-finished", { robotName: "A1" }), 1);
  assert.equal(t.sender.sent.length, 2);
  assert.match(t.sender.sent[0].payload.aps.alert.body, /secuencia de trabajo/);
  assert.equal(t.sender.sent[0].payload.kind, "job-finished");
  assert.equal(t.sender.sent[0].collapseId, "job-A1");
  assert.deepEqual(t.devices.list().map((d) => d.token), [TOKEN]);

  t.sender.answers.set(TOKEN, { status: 500, reason: "InternalServerError" });
  assert.equal(await t.service.notify("global-stop"), 0);
  assert.equal(t.sender.sent.at(-1)!.expires, 3600);
  assert.ok(t.logs.some((l) => /refused a notification: 500/.test(l)));

  const status = JSON.stringify(t.service.status());
  assert.ok(!status.includes("BEGIN"), "no key text");
  assert.ok(!status.includes("ABC1234567") && !status.includes("TEAM123456") && !status.includes("com.example"), "no key id, team or bundle");
  assert.ok(!t.logs.join("\n").includes(TOKEN), "no device token in the log");
  t.service.close();
});

test("the events of the rest of the server reach the service and stop reaching it once closed", async () => {
  const t = makeService();
  t.devices.register(TOKEN, "ana", "en");
  emitPush("global-stop");
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(t.sender.sent.length, 1);
  t.service.close();
  emitPush("global-stop");
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(t.sender.sent.length, 1);
  assert.equal(t.sender.closed, true);
});

// ---- the Apple service, simulated ------------------------------------------------------------------------------------------------------------------

test("the client signs a provider token the Apple service can verify and sends the documented request", async () => {
  const dir = tempDir();
  const { file, publicKey } = writeKey(dir);
  const credentials = (readApnsCredentials(env(file)) as { credentials: ApnsCredentials }).credentials;

  const seen: { headers: http2.IncomingHttpHeaders; body: string }[] = [];
  const server = http2.createServer();
  server.on("stream", (stream, headers) => {
    let body = "";
    stream.on("data", (c) => (body += c));
    stream.on("end", () => {
      seen.push({ headers, body });
      const bad = String(headers[":path"]).endsWith("/" + "f".repeat(64));
      stream.respond({ ":status": bad ? 400 : 200, "content-type": "application/json" });
      stream.end(bad ? JSON.stringify({ reason: "BadDeviceToken" }) : "");
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as any).port;
  const client = new ApnsClient(credentials, { sandbox: false, baseUrl: `http://127.0.0.1:${port}` });
  try {
    const ok = await client.send(TOKEN, { aps: { alert: { title: "t", body: "b" } } }, { collapseId: "x", expiresInSeconds: 60 });
    assert.deepEqual(ok, { status: 200, reason: undefined });
    const bad = await client.send("f".repeat(64), { aps: {} }, { expiresInSeconds: 60 });
    assert.deepEqual(bad, { status: 400, reason: "BadDeviceToken" });

    const first = seen[0];
    assert.equal(first.headers[":method"], "POST");
    assert.equal(first.headers[":path"], `/3/device/${TOKEN}`);
    assert.equal(first.headers["apns-topic"], "com.example.hydra");
    assert.equal(first.headers["apns-push-type"], "alert");
    assert.equal(first.headers["apns-collapse-id"], "x");
    assert.equal(JSON.parse(first.body).aps.alert.body, "b");

    const jwt = String(first.headers.authorization).replace(/^bearer /, "");
    const [h, p, s] = jwt.split(".");
    assert.deepEqual(JSON.parse(Buffer.from(h, "base64url").toString()), { alg: "ES256", kid: "ABC1234567" });
    assert.equal(JSON.parse(Buffer.from(p, "base64url").toString()).iss, "TEAM123456");
    assert.equal(crypto.verify("sha256", Buffer.from(`${h}.${p}`), { key: publicKey, dsaEncoding: "ieee-p1363" }, Buffer.from(s, "base64url")), true);
    assert.equal(seen[1].headers.authorization, first.headers.authorization, "the provider token is reused");
  } finally {
    client.close();
    await new Promise((r) => server.close(r));
  }
});

test("an unreachable service answers status 0 and never throws", async () => {
  const dir = tempDir();
  const { file } = writeKey(dir);
  const credentials = (readApnsCredentials(env(file)) as { credentials: ApnsCredentials }).credentials;
  const client = new ApnsClient(credentials, { sandbox: true, baseUrl: "http://127.0.0.1:1", timeoutMs: 500 });
  const r = await client.send(TOKEN, {}, { expiresInSeconds: 1 });
  assert.equal(r.status, 0);
  client.close();
});

// ---- the routes -------------------------------------------------------------------------------------------------------------------------------------

async function withApp(enabled: boolean, run: (call: (method: string, url: string, user: string | null, body?: any) => Promise<{ status: number; json: any }>, devices: PushDevices) => Promise<void>) {
  const dir = tempDir();
  const devices = new PushDevices({ file: path.join(dir, "d.json"), maxDevices: () => 5 });
  const app = express();
  app.use(express.json());
  const authenticate = (req: any, res: any, next: any) => {
    const who = req.headers["x-user"];
    if (!who) return res.status(401).json({ error: "no" });
    req.user = { username: String(who), role: String(who) === "root" ? "admin" : "operator" };
    next();
  };
  const requireAdmin = (req: any, res: any, next: any) => (req.user.role === "admin" ? next() : res.status(403).json({ error: "admin" }));
  const audits: any[] = [];
  registerPushRoutes(app, {
    authenticate,
    requireAdmin,
    pushGate: makePushGate(() => enabled),
    devices,
    status: () => ({ enabled, configured: false, problem: "missing", devices: devices.count(), sandbox: false, events: { jobFinished: true, globalStop: true } }),
    audit: { record: (e) => audits.push(e) },
  });
  const server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as any).port;
  const call = async (method: string, url: string, user: string | null, body?: any) => {
    const res = await fetch(`http://127.0.0.1:${port}${url}`, { method, headers: { "content-type": "application/json", ...(user ? { "x-user": user } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const text = await res.text();
    return { status: res.status, json: text ? JSON.parse(text) : null };
  };
  try {
    await run(call, devices);
  } finally {
    await new Promise((r) => server.close(r));
  }
}

test("a signed-in account registers and removes its own device; bad input is refused", async () => {
  await withApp(true, async (call, devices) => {
    assert.equal((await call("POST", "/api/push/devices", null, { token: TOKEN, platform: "ios" })).status, 401);
    assert.equal((await call("POST", "/api/push/devices", "ana", { token: "nope", platform: "ios" })).status, 400);
    assert.equal((await call("POST", "/api/push/devices", "ana", { token: TOKEN, platform: "android" })).status, 400);
    assert.equal((await call("POST", "/api/push/devices", "ana", { token: TOKEN, platform: "ios", locale: "xx" })).status, 400);
    const ok = await call("POST", "/api/push/devices", "ana", { token: TOKEN, platform: "ios", locale: "pt" });
    assert.deepEqual(ok, { status: 200, json: { registered: true } });
    assert.equal(devices.list()[0].locale, "pt");
    assert.deepEqual((await call("DELETE", `/api/push/devices/${TOKEN}`, "ben")).json, { removed: false });
    assert.deepEqual((await call("DELETE", `/api/push/devices/${TOKEN}`, "ana")).json, { removed: true });
    assert.equal((await call("DELETE", "/api/push/devices/zz", "ana")).status, 400);
    await call("POST", "/api/push/devices", "ana", { token: TOKEN, platform: "ios" });
    assert.deepEqual((await call("DELETE", `/api/push/devices/${TOKEN}`, "root")).json, { removed: true }, "an administrator can remove any");
  });
});

test("while the switch is off registering answers 404, and only an administrator reads the status", async () => {
  await withApp(false, async (call) => {
    assert.equal((await call("POST", "/api/push/devices", "ana", { token: TOKEN, platform: "ios" })).status, 404);
    assert.equal((await call("DELETE", `/api/push/devices/${TOKEN}`, "ana")).status, 404);
    assert.equal((await call("GET", "/api/admin/push", "ana")).status, 403);
    const status = await call("GET", "/api/admin/push", "root");
    assert.equal(status.status, 200);
    assert.equal(status.json.enabled, false);
    assert.deepEqual(Object.keys(status.json).sort(), ["configured", "devices", "enabled", "events", "problem", "sandbox"]);
  });
});

// ---- the switch ----------------------------------------------------------------------------------------------------------------------------------------

function makeConfig(envMap: any = {}, initial: SecurityFile = {}) {
  let stored: SecurityFile = { ...initial };
  const logs: string[] = [];
  const config = new SecurityConfig({ env: envMap, load: () => ({ ...stored }), save: (file) => { stored = { ...file }; }, tlsActive: false, log: (m) => logs.push(m) });
  return { config, logs, stored: () => stored };
}

test("push is off by default, only the exact word 1 switches it on from the environment, and an administrator can change it", () => {
  assert.equal(makeConfig().config.pushEnabled(), false);
  assert.deepEqual(makeConfig().config.snapshot().push.enabled, { value: false, source: "default" });
  assert.equal(makeConfig({ push: "1" }).config.pushEnabled(), true);
  for (const word of ["true", "yes", "on", "0", ""]) assert.equal(makeConfig({ push: word }).config.pushEnabled(), false, word);

  const { config, logs, stored } = makeConfig();
  const on = config.update({ push: { enabled: true } }, "root");
  assert.deepEqual(on.warnings, ["push_enabled"]);
  assert.equal(config.pushEnabled(), true);
  assert.deepEqual(stored().push, { enabled: true });
  assert.match(logs.at(-1)!, /push notifications .* on/);
  config.update({ push: { enabled: false } }, "root");
  assert.equal(config.pushEnabled(), false);
  assert.throws(() => config.update({ push: { enabled: "yes" } }, "root"), SecurityConfigError);
  assert.throws(() => config.update({ push: 3 }, "root"), SecurityConfigError);
});

test("a value fixed by the environment cannot be changed from the screen", () => {
  const { config } = makeConfig({ push: "0" });
  assert.deepEqual(config.snapshot().push.enabled, { value: false, source: "env" });
  assert.throws(() => config.update({ push: { enabled: true } }, "root"), /HYDRA_UMC_PUSH/);
});
