// =============================================================================
// HYDRA-UMC-SERVER - tests/pushFcm.test.ts
// Copyright (C) 2026 JuanenRac (Electro Hobby 3D) <electrohobby3d@gmail.com>
// GPL-3.0-or-later - see LICENSE
// =============================================================================
// The push notifications through Firebase, against a simulated Firebase: where the service account may be, the signed request
// for the access token, the message of each platform, the tokens that are forgotten and the choice between Apple and Firebase.
import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { FcmClient, fcmAssertion, fcmMessage, readFcmServiceAccount, FCM_ANDROID_CHANNEL, type FcmNotification, type FcmServiceAccount } from "../src/pushFcm";
import { PushDevices, PushService, providerOf, validPushToken, type ApnsSender } from "../src/pushNotifications";

const APPLE = "a".repeat(64);
const ANDROID = "fid-android:APA91b" + "x".repeat(40);
const IPHONE_FCM = "fid-iphone:APA91b" + "Y".repeat(40);

const pair = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
const PEM = pair.privateKey.export({ type: "pkcs8", format: "pem" }).toString();

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "hydra-fcm-"));
}

function writeAccount(dir: string, extra: Record<string, unknown> = {}): string {
  const file = path.join(dir, "service-account.json");
  fs.writeFileSync(file, JSON.stringify({ project_id: "demo-project", client_email: "push@demo-project.iam.gserviceaccount.com", private_key: PEM, token_uri: "https://tokens.invalid/token", ...extra }));
  return file;
}

const ACCOUNT: FcmServiceAccount = { projectId: "demo-project", clientEmail: "push@demo-project.iam.gserviceaccount.com", privateKey: PEM, tokenUri: "https://tokens.invalid/token" };

const NOTICE: FcmNotification = { platform: "android", title: "HYDRA-UMC", body: "A job sequence finished.", kind: "job-finished", collapseId: "job-A1", expiresInSeconds: 3600 };

test("the service account is taken from the environment or the configuration, never from inside the server directory", () => {
  const dir = tempDir();
  const file = writeAccount(dir);
  assert.deepEqual(readFcmServiceAccount({}, undefined), { problem: "missing" });
  assert.ok("account" in readFcmServiceAccount({ HYDRA_UMC_FCM_SERVICE_ACCOUNT: file }, undefined));
  assert.ok("account" in readFcmServiceAccount({}, file));
  assert.deepEqual(readFcmServiceAccount({ HYDRA_UMC_FCM_SERVICE_ACCOUNT: path.join(dir, "none.json") }, file), { problem: "key-unreadable" }, "the environment wins");
  assert.deepEqual(readFcmServiceAccount({}, file, dir), { problem: "key-in-repo" });
  const junk = path.join(dir, "junk.json");
  fs.writeFileSync(junk, "{ not json");
  assert.deepEqual(readFcmServiceAccount({}, junk), { problem: "invalid" });
  assert.deepEqual(readFcmServiceAccount({}, writeAccount(dir, { private_key: "not a key" })), { problem: "invalid" });
  assert.deepEqual(readFcmServiceAccount({}, writeAccount(dir, { token_uri: "http://tokens.invalid/token" })), { problem: "invalid" });
  assert.deepEqual(readFcmServiceAccount({}, writeAccount(dir, { project_id: "../x" })), { problem: "invalid" });
});

test("the request for the access token is signed with the key of the service account", () => {
  const [head, claim, signature] = fcmAssertion(ACCOUNT, 1000).split(".");
  assert.ok(crypto.verify("sha256", Buffer.from(`${head}.${claim}`), pair.publicKey, Buffer.from(signature, "base64url")));
  const claims = JSON.parse(Buffer.from(claim, "base64url").toString("utf8"));
  assert.equal(claims.scope, "https://www.googleapis.com/auth/firebase.messaging");
  assert.equal(claims.exp - claims.iat, 3600);
});

test("a message only informs: no click action, no buttons, the channel of the app on Android", () => {
  for (const platform of ["android", "ios"] as const) {
    const text = JSON.stringify(fcmMessage(ANDROID, { ...NOTICE, platform }, 1000));
    assert.ok(!/click_action|actions|category|mutable-content|content-available/.test(text), platform);
  }
  const android: any = fcmMessage(ANDROID, NOTICE, 1000);
  assert.equal(android.message.android.notification.channel_id, FCM_ANDROID_CHANNEL);
  assert.deepEqual(android.message.data, { kind: "job-finished" });
  const apple: any = fcmMessage(IPHONE_FCM, { ...NOTICE, platform: "ios" }, 1000);
  assert.equal(apple.message.apns.headers["apns-expiration"], "4600");
  assert.equal(apple.message.android, undefined);
});

function simulatedFirebase(answers: Array<{ status: number; body?: string }> = []) {
  const calls: Array<{ url: string; init: any }> = [];
  const request = async (url: string, init: RequestInit): Promise<Response> => {
    calls.push({ url, init });
    if (url === ACCOUNT.tokenUri) return new Response(JSON.stringify({ access_token: "access-1", expires_in: 3600 }), { status: 200 });
    const next = answers.shift() ?? { status: 200 };
    return new Response(next.body ?? "{}", { status: next.status });
  };
  return { calls, request };
}

test("the client asks for one access token and keeps it, and reads which tokens are gone", async () => {
  const firebase = simulatedFirebase([{ status: 200 }, { status: 404 }, { status: 400, body: "The registration token is not a valid FCM registration token" }, { status: 400, body: "bad ttl" }, { status: 500 }]);
  const client = new FcmClient(ACCOUNT, { request: firebase.request });
  assert.deepEqual(await client.send(ANDROID, NOTICE), { status: 200 });
  assert.deepEqual(await client.send(ANDROID, NOTICE), { status: 404, reason: "Unregistered" });
  assert.deepEqual(await client.send(ANDROID, NOTICE), { status: 400, reason: "Unregistered" });
  assert.deepEqual(await client.send(ANDROID, NOTICE), { status: 400, reason: undefined });
  assert.deepEqual(await client.send(ANDROID, NOTICE), { status: 500, reason: undefined });
  assert.equal(firebase.calls.filter((c) => c.url === ACCOUNT.tokenUri).length, 1);
  const sent = firebase.calls[1];
  assert.equal(sent.url, "https://fcm.googleapis.com/v1/projects/demo-project/messages:send");
  assert.equal(sent.init.headers.authorization, "Bearer access-1");
  assert.equal(sent.init.redirect, "error");
});

test("a failing network or token address never throws", async () => {
  const client = new FcmClient(ACCOUNT, { request: async () => { throw new Error("offline"); } });
  assert.deepEqual(await client.send(ANDROID, NOTICE), { status: 0, reason: "network" });
  const refused = new FcmClient(ACCOUNT, { request: async () => new Response("no", { status: 403 }) });
  assert.deepEqual(await refused.send(ANDROID, NOTICE), { status: 0, reason: "no-access-token" });
});

test("each platform has its tokens and its push service", () => {
  assert.equal(validPushToken(APPLE, "ios"), true);
  assert.equal(validPushToken(IPHONE_FCM, "ios"), true);
  assert.equal(validPushToken("g".repeat(64), "ios"), false);
  assert.equal(validPushToken(ANDROID, "android"), true);
  assert.equal(validPushToken("short", "android"), false);
  assert.equal(validPushToken("has a space ".repeat(4), "android"), false);
  assert.equal(providerOf({ platform: "ios", token: APPLE }), "apns");
  assert.equal(providerOf({ platform: "ios", token: IPHONE_FCM }), "fcm");
  assert.equal(providerOf({ platform: "android", token: APPLE }), "fcm");
});

test("a Firebase token keeps its case, survives a restart and is removed only by its owner", () => {
  const file = path.join(tempDir(), "devices.json");
  const devices = new PushDevices({ file, maxDevices: () => 5 });
  devices.register(IPHONE_FCM, "ana", "es", new Date(), "ios");
  devices.register(ANDROID, "ben", "en", new Date(), "android");
  const again = new PushDevices({ file, maxDevices: () => 5 });
  assert.deepEqual(again.list().map((d) => [d.platform, d.token]), [["ios", IPHONE_FCM], ["android", ANDROID]]);
  assert.equal(again.remove(ANDROID, "ana"), false);
  assert.equal(again.remove(ANDROID, "ben"), true);
});

function service(options: { enabled?: boolean; environment?: NodeJS.ProcessEnv; config?: any; answers?: Array<{ status: number }> } = {}) {
  const dir = tempDir();
  const devices = new PushDevices({ file: path.join(dir, "devices.json"), maxDevices: () => 5 });
  const firebase = simulatedFirebase(options.answers);
  const apple: string[] = [];
  const appleSender: ApnsSender = { send: async (token) => { apple.push(token); return { status: 200 }; }, close: () => {} };
  const logs: string[] = [];
  const push = new PushService({
    enabled: () => options.enabled ?? true,
    config: () => options.config,
    devices,
    env: () => options.environment ?? { HYDRA_UMC_FCM_SERVICE_ACCOUNT: writeAccount(dir) },
    makeSender: () => appleSender,
    makeFcmSender: (account) => new FcmClient({ ...account, tokenUri: ACCOUNT.tokenUri }, { request: firebase.request }),
    log: (line) => logs.push(line),
  });
  return { push, devices, firebase, apple, logs, dir };
}

test("with only Firebase configured the Firebase phones are told, the Apple one is left alone and a dead token is forgotten", async () => {
  const s = service({ answers: [{ status: 200 }, { status: 404 }] });
  try {
    s.devices.register(ANDROID, "ana", "es", new Date(), "android");
    s.devices.register(IPHONE_FCM, "ben", "de", new Date(), "ios");
    s.devices.register(APPLE, "cy", "en");
    assert.equal(s.push.status().configured, true);
    assert.equal(s.push.status().problem, null);
    assert.equal(await s.push.notify("global-stop"), 1);
    assert.deepEqual(s.devices.list().map((d) => d.token), [ANDROID, APPLE]);
    assert.deepEqual(s.apple, []);
    const sent = JSON.parse(s.firebase.calls[1].init.body).message;
    assert.equal(sent.token, ANDROID);
    assert.match(sent.notification.body, /parada global/);
  } finally {
    s.push.close();
  }
});

test("switched off, or without a service account, nothing leaves the server", async () => {
  const off = service({ enabled: false });
  const none = service({ environment: {} });
  const inside = service({ environment: { HYDRA_UMC_FCM_SERVICE_ACCOUNT: path.join(process.cwd(), "service-account.json") } });
  try {
    for (const s of [off, none, inside]) {
      s.devices.register(ANDROID, "ana", "es", new Date(), "android");
      assert.equal(await s.push.notify("job-finished"), 0);
      assert.equal(await s.push.notify("job-finished"), 0);
      assert.equal(s.firebase.calls.length, 0);
    }
    assert.equal(none.push.status().configured, false);
    assert.equal(none.push.status().problem, "missing");
    assert.deepEqual(none.logs, []);
    assert.equal(inside.push.status().problem, "key-in-repo");
    assert.deepEqual(inside.logs, ["[PUSH] the Firebase service account is not usable: key-in-repo"], "said once, and without a path");
  } finally {
    off.push.close();
    none.push.close();
    inside.push.close();
  }
});
