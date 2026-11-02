import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import express from "express";
import { BridgeGateway, resolveGatewaySettings, validBridgeName, validBridgeVerb, type BridgeGatewayFile } from "../src/bridgeGateway.ts";
import { makeBridgeGatewayGate, registerBridgeRoutes } from "../src/routes/bridgeRoutes.ts";
import { SecurityConfig, SecurityConfigError, type SecurityFile } from "../src/securityConfig.ts";

function makeConfig(env: any = {}, initial: SecurityFile = {}) {
  let stored: SecurityFile = { ...initial };
  const logs: string[] = [];
  const config = new SecurityConfig({ env, load: () => ({ ...stored }), save: (file) => { stored = { ...file }; }, tlsActive: false, log: (m) => logs.push(m) });
  return { config, logs, stored: () => stored };
}

// A broker client that records what the gateway publishes and lets the test deliver messages.
class FakeClient extends EventEmitter {
  published: { topic: string; payload: string; options: any }[] = [];
  subscribed: string[] = [];
  publish(topic: string, payload: string, options: any, callback?: (error?: Error | null) => void) {
    this.published.push({ topic, payload, options });
    callback?.(null);
  }
  subscribe(topic: string, _options: any, callback?: (error: Error | null) => void) {
    this.subscribed.push(topic);
    callback?.(null);
  }
  end(_force?: boolean, callback?: () => void) { callback?.(); }
  deliver(topic: string, payload: unknown) {
    this.emit("message", topic, Buffer.from(typeof payload === "string" ? payload : JSON.stringify(payload)), { retain: true });
  }
}

function makeGateway(file: BridgeGatewayFile = {}, now = () => Date.now()) {
  const client = new FakeClient();
  const logs: string[] = [];
  const gateway = new BridgeGateway({
    getSettings: () => resolveGatewaySettings(file),
    url: "mqtt://user:secret@127.0.0.1:1883",
    connect: () => client as any,
    log: (m) => logs.push(m),
    now,
  });
  gateway.ensureStarted();
  client.emit("connect");
  return { gateway, client, logs };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

// ---- the switch ----------------------------------------------------------------------------------------------------------------------

test("the gateway is off by default and only the exact word 1 switches it on", () => {
  assert.equal(makeConfig().config.bridgeGatewayEnabled(), false);
  assert.deepEqual(makeConfig().config.snapshot().bridgeGateway.enabled, { value: false, source: "default" });
  assert.equal(makeConfig({ bridgeGateway: "1" }).config.bridgeGatewayEnabled(), true);
  for (const word of ["true", "yes", "on", "0", ""]) assert.equal(makeConfig({ bridgeGateway: word }).config.bridgeGatewayEnabled(), false, word);
});

test("an administrator turns the gateway on and off; it is saved, logged and warned about, and an environment word locks it", () => {
  const { config, logs, stored } = makeConfig();
  const on = config.update({ bridgeGateway: { enabled: true } }, "root");
  assert.deepEqual(on.warnings, ["bridge_gateway_on"]);
  assert.equal(config.bridgeGatewayEnabled(), true);
  assert.deepEqual(stored().bridgeGateway, { enabled: true });
  assert.match(logs.at(-1)!, /gateway to the machine bridges.* on\./);
  const off = config.update({ bridgeGateway: { enabled: false } }, "root");
  assert.deepEqual(off.warnings, []);
  assert.equal(config.bridgeGatewayEnabled(), false);
  assert.throws(() => config.update({ bridgeGateway: { enabled: "yes" } }, "root"), (e: any) => e instanceof SecurityConfigError && e.status === 400);
  assert.throws(() => config.update({ bridgeGateway: [] }, "root"), (e: any) => e instanceof SecurityConfigError && e.status === 400);
  const locked = makeConfig({ bridgeGateway: "1" });
  assert.throws(() => locked.config.update({ bridgeGateway: { enabled: false } }, "root"), (e: any) => e instanceof SecurityConfigError && e.status === 409);
});

test("the other options of the file are kept when the gateway is switched", () => {
  const { config, stored } = makeConfig({}, { rul: { enabled: true } });
  config.update({ bridgeGateway: { enabled: true } }, "root");
  assert.deepEqual(stored().rul, { enabled: true });
});

// ---- the settings --------------------------------------------------------------------------------------------------------------------

test("the settings start conservative and an invalid value falls back", () => {
  const defaults = resolveGatewaySettings(undefined);
  assert.equal(defaults.prefix, "hydra/bridges");
  assert.deepEqual([...defaults.allowedVerbs].sort(), ["pause", "resume", "status", "stop"]);
  assert.equal(defaults.commandTimeoutMs, 5000);
  assert.equal(defaults.commandsPerSecond, 5);
  const odd = resolveGatewaySettings({ prefix: "a b", allowedVerbs: ["Stop", "job", "ok_verb", "x".repeat(40)], commandTimeoutMs: 5, commandsPerSecond: 999 } as any);
  assert.equal(odd.prefix, "hydra/bridges");
  assert.deepEqual([...odd.allowedVerbs], ["ok_verb"]);
  assert.equal(odd.commandTimeoutMs, 100);
  assert.equal(odd.commandsPerSecond, 50);
  assert.equal(resolveGatewaySettings({ prefix: "/cell/one/" }).prefix, "cell/one");
  assert.ok(validBridgeName("openpnp") && !validBridgeName("Cnc") && !validBridgeName("a/b") && !validBridgeName(""));
  assert.ok(validBridgeVerb("stop") && !validBridgeVerb("job") && !validBridgeVerb("a/b"));
});

// ---- what it knows and what it sends ---------------------------------------------------------------------------------------------

test("it subscribes to the retained topics and the results, and never logs the password of the address", () => {
  const { client, logs } = makeGateway();
  assert.deepEqual(client.subscribed.sort(), ["hydra/bridges/+/availability", "hydra/bridges/+/cmd/+/result", "hydra/bridges/+/health", "hydra/bridges/+/state"]);
  assert.ok(logs.every((line) => !line.includes("secret")));
});

test("it keeps the last state, availability and health of each bridge", () => {
  const { gateway, client } = makeGateway({}, () => Date.parse("2026-01-01T00:00:00Z"));
  assert.deepEqual(gateway.list(), []);
  client.deliver("hydra/bridges/cnc/availability", "online");
  client.deliver("hydra/bridges/cnc/state", { pos: [1, 2, 3] });
  client.deliver("hydra/bridges/laser/health", { schema_version: "1.0", state: "FAULT", timestamp_utc: "x", checks: {} });
  client.deliver("hydra/bridges/Bad Name/state", {});
  client.deliver("other/prefix/cnc/state", { no: true });
  client.deliver("hydra/bridges/cnc/unknown", "x");
  assert.deepEqual(gateway.list().map((b) => b.name), ["cnc", "laser"]);
  assert.deepEqual(gateway.get("cnc"), { name: "cnc", available: true, state: { pos: [1, 2, 3] }, health: null, updatedAt: "2026-01-01T00:00:00.000Z" });
  assert.equal(gateway.get("laser")!.available, false);
  assert.equal(gateway.get("nothing"), null);
  client.deliver("hydra/bridges/cnc/availability", "offline");
  assert.equal(gateway.get("cnc")!.available, false);
});

test("a command is published on the topic of the bridge and returns the answer it publishes", async () => {
  const { gateway, client } = makeGateway();
  client.deliver("hydra/bridges/cnc/availability", "online");
  const pending = gateway.command("cnc", "pause", { reason: "operator" });
  await flush();
  assert.deepEqual(client.published.map((p) => [p.topic, p.payload, p.options]), [["hydra/bridges/cnc/cmd/pause", '{"reason":"operator"}', { qos: 1, retain: false }]]);
  client.deliver("hydra/bridges/cnc/cmd/pause/result", { allowed: true });
  assert.deepEqual(await pending, { status: 200, body: { accepted: true, result: { allowed: true } } });
});

test("a bridge that does not answer in time gives result null, and the slot is free again", async () => {
  const { gateway, client } = makeGateway({ commandTimeoutMs: 100 });
  client.deliver("hydra/bridges/cnc/state", {});
  assert.deepEqual(await gateway.command("cnc", "status", undefined), { status: 200, body: { accepted: true, result: null } });
  const again = gateway.command("cnc", "status", undefined);
  await flush();
  client.deliver("hydra/bridges/cnc/cmd/status/result", "ok");
  assert.equal((await again).body.result, "ok");
});

test("refusals: unknown bridge, verb not on the list, job, a payload that is not an object or is too large, a second one waiting", async () => {
  const { gateway, client } = makeGateway({ allowedVerbs: ["stop", "go"], commandTimeoutMs: 5000 });
  client.deliver("hydra/bridges/cnc/state", {});
  assert.equal((await gateway.command("nothing", "stop", undefined)).status, 404);
  assert.equal((await gateway.command("cnc", "format", undefined)).status, 403);
  assert.equal((await gateway.command("cnc", "job", {})).status, 403);
  assert.equal((await gateway.command("Cnc!", "stop", undefined)).status, 400);
  assert.equal((await gateway.command("cnc", "go", [1] as any)).status, 400);
  assert.equal((await gateway.command("cnc", "go", { text: "x".repeat(9000) })).status, 413);
  assert.deepEqual(client.published, []);
  const first = gateway.command("cnc", "go", {});
  await flush();
  assert.equal((await gateway.command("cnc", "go", {})).status, 409);
  client.deliver("hydra/bridges/cnc/cmd/go/result", {});
  await first;
});

test("the pace is limited but a stop is never held back", async () => {
  const { gateway, client } = makeGateway({ commandsPerSecond: 2, commandTimeoutMs: 100, allowedVerbs: ["status", "stop"] }, () => 1000);
  client.deliver("hydra/bridges/cnc/state", {});
  const statuses: number[] = [];
  for (let i = 0; i < 4; i++) statuses.push((await gateway.command("cnc", "status", undefined)).status);
  assert.deepEqual(statuses, [200, 200, 429, 429]);
  assert.equal((await gateway.command("cnc", "stop", undefined)).status, 200);
});

test("without a connection nothing is published", async () => {
  const { gateway, client } = makeGateway();
  client.deliver("hydra/bridges/cnc/state", {});
  client.emit("close");
  assert.equal((await gateway.command("cnc", "stop", undefined)).status, 503);
  assert.deepEqual(client.published, []);
});

// ---- the routes ----------------------------------------------------------------------------------------------------------------------

async function serve(enabled: () => boolean, role = "operator") {
  const { gateway, client } = makeGateway({ commandTimeoutMs: 3000 });
  client.deliver("hydra/bridges/cnc/availability", "online");
  client.deliver("hydra/bridges/cnc/state", { pos: 1 });
  const audits: any[] = [];
  const app = express();
  app.use(express.json());
  const authenticate = (req: any, res: any, next: any) => (req.headers.authorization ? ((req.user = { id: 1, username: "ana", role }), next()) : res.status(401).json({ error: "no" }));
  const requireOperator = (req: any, res: any, next: any) => (req.user.role === "viewer" ? res.status(403).json({ error: "viewer" }) : next());
  registerBridgeRoutes(app, { authenticate, requireOperator, bridgeGatewayGate: makeBridgeGatewayGate(enabled), gateway, audit: { record: (event: any) => audits.push(event) } });
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = (path: string, init: RequestInit = {}) => fetch(base + path, { ...init, headers: { authorization: "Bearer x", "content-type": "application/json", ...(init.headers ?? {}) } });
  return { call, base, audits, client, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

test("with the switch off every route is a bare 404 for a signed-in client and 401 for the others", async () => {
  const s = await serve(() => false);
  try {
    for (const [method, path] of [["GET", "/api/bridges"], ["GET", "/api/bridges/cnc/state"], ["POST", "/api/bridges/cnc/cmd/stop"]]) {
      const answer = await s.call(path, { method });
      assert.equal(answer.status, 404, path);
      assert.equal(await answer.text(), "");
    }
    assert.equal((await fetch(s.base + "/api/bridges")).status, 401);
    assert.deepEqual(s.client.published, []);
    assert.deepEqual(s.audits, []);
  } finally {
    await s.close();
  }
});

test("with the switch on a signed-in client lists the bridges and reads one state, and a viewer cannot send", async () => {
  const s = await serve(() => true, "viewer");
  try {
    const list = await (await s.call("/api/bridges")).json();
    assert.equal(list.connected, true);
    assert.deepEqual(list.bridges.map((b: any) => b.name), ["cnc"]);
    const one = await (await s.call("/api/bridges/cnc/state")).json();
    assert.deepEqual([one.name, one.available, one.state], ["cnc", true, { pos: 1 }]);
    assert.equal((await s.call("/api/bridges/laser/state")).status, 404);
    assert.equal((await s.call("/api/bridges/BAD/state")).status, 400);
    assert.equal((await s.call("/api/bridges/cnc/cmd/stop", { method: "POST", body: "{}" })).status, 403);
  } finally {
    await s.close();
  }
});

test("an operator sends a command; it is audited with the bridge and the verb and never the parameters", async () => {
  const s = await serve(() => true);
  try {
    const sent = s.call("/api/bridges/cnc/cmd/pause", { method: "POST", body: JSON.stringify({ secret: "hunter2" }) });
    for (let i = 0; i < 200 && s.client.published.length === 0; i++) await new Promise((resolve) => setTimeout(resolve, 5));
    s.client.deliver("hydra/bridges/cnc/cmd/pause/result", { allowed: true });
    const answer = await sent;
    assert.equal(answer.status, 200);
    assert.deepEqual(await answer.json(), { accepted: true, result: { allowed: true } });
    assert.equal(s.audits.length, 1);
    assert.equal(s.audits[0].type, "bridge-command");
    assert.equal(s.audits[0].outcome, "ok");
    assert.equal(s.audits[0].username, "ana");
    assert.deepEqual(s.audits[0].detail, { bridge: "cnc", verb: "pause", status: 200 });
    assert.ok(!JSON.stringify(s.audits).includes("hunter2"));
    const refused = await s.call("/api/bridges/cnc/cmd/format", { method: "POST", body: "{}" });
    assert.equal(refused.status, 403);
    assert.equal(s.audits.at(-1).outcome, "refused");
  } finally {
    await s.close();
  }
});
