import assert from "node:assert/strict";
import { createServer, type Server } from "node:net";
import { test } from "node:test";
import { Aedes } from "aedes";
import { connect as mqttConnect, type MqttClient } from "mqtt";
import {
  MqttBridge, loopbackAccount, parseCommandTopic, resolveMqttSettings, summarizeRobot, validMqttPrefix, validMqttUrl, readSecret,
  type CommandAccount,
} from "../src/mqttBridge.ts";
import { ROBOT_COMMANDS } from "../src/routes/commandRoutes.ts";

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check: () => boolean, message: string, ms = 5000) {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error(`timed out: ${message}`);
    await wait(15);
  }
}

async function startBroker() {
  const broker = new Aedes();
  await broker.listen();
  const server: Server = createServer(broker.handle);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const port = (server.address() as { port: number }).port;
  return {
    url: `mqtt://127.0.0.1:${port}`,
    async close() {
      await new Promise<void>((resolve) => broker.close(() => resolve()));
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

function watcher(url: string, filter: string) {
  const messages: { topic: string; text: string; retain: boolean }[] = [];
  const client: MqttClient = mqttConnect(url, { reconnectPeriod: 0 });
  client.on("message", (topic, payload, packet) => messages.push({ topic, text: payload.toString("utf8"), retain: packet.retain }));
  const ready = new Promise<void>((resolve) => client.on("connect", () => client.subscribe(filter, { qos: 1 }, () => resolve())));
  return { messages, ready, client, close: () => new Promise<void>((resolve) => client.end(true, () => resolve())) };
}

const tree = () => ({
  controllers: [{
    id: "c1",
    robots: [{
      id: 1, name: "A1", online: true, model: "Parol6 (6-DOF)", role: "Idle", tool: "None", pos: { x: 1, y: 2, z: 3 },
      joints: { j1: 1, j2: 2, j3: 3, j4: 4, j5: 5, j6: 6 }, recordedPoints: [{ j1: 1 }, { j1: 2 }, { j1: 3 }],
      reservation: { ownerId: "secret-id", ownerUsername: "bob", expiresAt: 123, history: ["x"] },
      camera: { password: "must-not-leak" },
    }],
  }],
});

const settings = (extra: Record<string, unknown> = {}) => ({ ...resolveMqttSettings({}, {}), minStateIntervalMs: 50, ...extra });

test("the prefix, the address and the topics are checked", () => {
  assert.equal(validMqttPrefix("hydra/swarm/"), "hydra/swarm");
  assert.equal(validMqttPrefix("/a/b"), "a/b");
  for (const bad of ["", "a/#", "a/+/b", "a b", "a//b", 5, "../x"]) assert.equal(validMqttPrefix(bad), null, String(bad));
  assert.equal(validMqttUrl("mqtt://10.0.0.5:1883"), "mqtt://10.0.0.5:1883");
  assert.equal(validMqttUrl("wss://broker.example/mqtt"), "wss://broker.example/mqtt");
  for (const bad of ["http://x", "mqtt://", "file:///etc/passwd", "ftp://h", 7, "", "mqtt://" + "h".repeat(400)]) assert.equal(validMqttUrl(bad), null, String(bad));
  assert.deepEqual(parseCommandTopic("hydra/swarm", "hydra/swarm/robot_12/cmd/jog"), { robotId: 12, command: "jog" });
  for (const bad of ["hydra/swarm/robot_12/cmd/jog/result", "hydra/swarm/robot_12/state", "other/robot_1/cmd/stop", "hydra/swarm/robot_x/cmd/stop", "hydra/swarm/robot_1/cmd/1x", "hydra/swarm/robot_1/cmd/"]) {
    assert.equal(parseCommandTopic("hydra/swarm", bad), null, bad);
  }
});

test("the mode comes from the environment first, an unknown word is off, and the defaults are the conservative ones", () => {
  assert.equal(resolveMqttSettings({}, {}).mode, "off");
  assert.equal(resolveMqttSettings({ mode: "commands" }, {}).mode, "commands");
  assert.equal(resolveMqttSettings({ mode: "banana" }, { mqtt: { mode: "commands" } }).mode, "off", "an unknown word in the environment is off, not the file");
  assert.equal(resolveMqttSettings({}, { mqtt: { mode: "state", url: "mqtts://b:8883", prefix: "plant/a" } }).url, "mqtts://b:8883");
  assert.equal(resolveMqttSettings({ url: "http://bad" }, {}).url, "mqtt://127.0.0.1:1883");
  assert.equal(resolveMqttSettings({}, { mqtt: { commandsPerSecond: 1e9 } }).commandsPerSecond, 100);
});

test("a robot summary holds no recorded points, no camera credentials and no reservation history", () => {
  const summary = summarizeRobot("c1", tree().controllers[0].robots[0]);
  const text = JSON.stringify(summary);
  assert.equal(summary.pointsCount, 3);
  assert.ok(!text.includes("must-not-leak") && !text.includes("secret-id") && !text.includes("history"));
  assert.deepEqual(summary.reservation, { ownerUsername: "bob", expiresAt: 123 });
});

test("readSecret prefers the file and gives nothing for a missing one", async () => {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const file = path.join(os.tmpdir(), `mqtt-secret-${process.pid}.txt`);
  fs.writeFileSync(file, "from-file\n");
  try {
    assert.equal(readSecret("direct", file), "from-file");
    assert.equal(readSecret("direct", undefined), "direct");
    assert.equal(readSecret(undefined, undefined), undefined);
    assert.equal(readSecret("direct", file + ".missing"), undefined);
  } finally {
    fs.unlinkSync(file);
  }
});

test("the state goes out retained, only what changed is sent again, and a clean stop says offline", async () => {
  const broker = await startBroker();
  const sub = watcher(broker.url, "hydra/swarm/#");
  await sub.ready;
  const current: any = tree();
  const bridge = new MqttBridge({ settings: settings({ url: broker.url }), getSettings: () => current, allowedCommands: ROBOT_COMMANDS, log: () => undefined });
  bridge.start();
  await until(() => sub.messages.some((m) => m.topic === "hydra/swarm/robot_1/state"), "the first state");
  await until(() => sub.messages.some((m) => m.topic === "hydra/swarm/status" && m.text === "online"), "the online status");
  const first = sub.messages.find((m) => m.topic === "hydra/swarm/robot_1/state")!;
  assert.equal(JSON.parse(first.text).name, "A1");
  assert.equal(JSON.parse(first.text).pointsCount, 3);
  const before = sub.messages.length;
  bridge.publishState();
  await wait(200);
  assert.equal(sub.messages.length, before, "nothing changed, nothing is published");
  current.controllers[0].robots[0].joints.j1 = 99;
  bridge.publishState();
  await until(() => sub.messages.some((m) => m.topic === "hydra/swarm/robot_1/joints" && JSON.parse(m.text).j1 === 99), "the new joints");
  assert.ok(!sub.messages.slice(before).some((m) => m.topic.endsWith("/tool")), "the tool did not change");
  // a late subscriber gets the retained copies at once
  const late = watcher(broker.url, "hydra/swarm/robot_1/#");
  await late.ready;
  await until(() => late.messages.some((m) => m.topic.endsWith("/state") && m.retain), "the retained state for a late subscriber");
  await bridge.stop();
  await until(() => sub.messages.some((m) => m.topic === "hydra/swarm/status" && m.text === "offline"), "offline on a clean stop");
  await late.close();
  await sub.close();
  await broker.close();
});

function commandRig() {
  const calls: any[] = [];
  let answer: { status: number; body: any } = { status: 200, body: { success: true, revision: "r1" } };
  const account: CommandAccount = { token: async () => "token-1", invalidate: () => { account.token = async () => "token-2"; } };
  return { calls, setAnswer: (a: typeof answer) => { answer = a; }, account, execute: async (request: any) => { calls.push(request); return answer; } };
}

test("a command is carried out through the route with the token of the account and answered on its result topic", async () => {
  const broker = await startBroker();
  const sub = watcher(broker.url, "hydra/swarm/+/cmd/+/result");
  await sub.ready;
  const rig = commandRig();
  const bridge = new MqttBridge({ settings: settings({ mode: "commands", url: broker.url }), getSettings: () => tree(), allowedCommands: ROBOT_COMMANDS, account: rig.account, execute: rig.execute, log: () => undefined });
  bridge.start();
  await wait(300);
  const pub = mqttConnect(broker.url, { reconnectPeriod: 0 });
  await new Promise<void>((resolve) => pub.on("connect", () => resolve()));
  pub.publish("hydra/swarm/robot_1/cmd/jog", JSON.stringify({ axis: "x", amount: 2, controllerId: "spoofed" }), { qos: 1 });
  await until(() => sub.messages.length >= 1, "the result of the jog");
  assert.deepEqual(JSON.parse(sub.messages[0].text), { success: true, status: 200, code: "ok", revision: "r1" });
  assert.equal(sub.messages[0].topic, "hydra/swarm/robot_1/cmd/jog/result");
  assert.equal(rig.calls[0].token, "token-1");
  assert.equal(rig.calls[0].robotId, 1);
  assert.equal(rig.calls[0].controllerId, "mqtt", "the client name of the reservation rule is the bridge's, not the message's");
  assert.deepEqual(rig.calls[0].params, { axis: "x", amount: 2 });

  // a refusal of the route is reported with its code
  rig.setAnswer({ status: 409, body: { error: "claimed by bob", code: "claimed-by-other" } });
  pub.publish("hydra/swarm/robot_1/cmd/play", "", { qos: 1 });
  await until(() => sub.messages.length >= 2, "the refusal");
  assert.deepEqual(JSON.parse(sub.messages[1].text), { success: false, status: 409, code: "claimed-by-other", error: "claimed by bob" });

  // the edits of a robot's data and unknown words are refused before the route
  const callsBefore = rig.calls.length;
  pub.publish("hydra/swarm/robot_1/cmd/points", JSON.stringify({ points: [] }), { qos: 1 });
  pub.publish("hydra/swarm/robot_1/cmd/format", "{}", { qos: 1 });
  pub.publish("hydra/swarm/robot_1/cmd/jog", "not json", { qos: 1 });
  pub.publish("hydra/swarm/robot_1/cmd/jog", "[1]", { qos: 1 });
  await until(() => sub.messages.length >= 6, "the four refusals");
  assert.deepEqual(sub.messages.slice(2).map((m) => JSON.parse(m.text).code).sort(), ["invalid-payload", "invalid-payload", "unknown-command", "unknown-command"]);
  assert.equal(rig.calls.length, callsBefore, "none of them reached the route");

  // a 401 ends the session: the account signs in again and the command is tried once more
  rig.setAnswer({ status: 401, body: { code: "SESSION_REVOKED" } });
  pub.publish("hydra/swarm/robot_1/cmd/pause", "", { qos: 1 });
  await until(() => rig.calls.length >= callsBefore + 2, "the second try");
  assert.equal(rig.calls[rig.calls.length - 1].token, "token-2");
  await pub.endAsync(true);
  await bridge.stop();
  await sub.close();
  await broker.close();
});

test("the pace limit holds commands back but never a stop, and without an account nothing runs", async () => {
  const broker = await startBroker();
  const sub = watcher(broker.url, "hydra/swarm/+/cmd/+/result");
  await sub.ready;
  const rig = commandRig();
  let clock = 1_000_000;
  const bridge = new MqttBridge({ settings: settings({ mode: "commands", commandsPerSecond: 2 }), getSettings: () => tree(), allowedCommands: ROBOT_COMMANDS, account: rig.account, execute: rig.execute, log: () => undefined, now: () => clock });
  for (let i = 0; i < 4; i++) await bridge.onMessage("hydra/swarm/robot_1/cmd/jog", Buffer.from("{}"));
  assert.equal(bridge.counters.rateLimited, 2);
  await bridge.onMessage("hydra/swarm/robot_1/cmd/stop", Buffer.from(""));
  assert.equal(rig.calls.filter((c) => c.command === "stop").length, 1, "a stop is never held back");
  clock += 1500;
  await bridge.onMessage("hydra/swarm/robot_1/cmd/jog", Buffer.from("{}"));
  assert.equal(bridge.counters.rateLimited, 2, "a new second, a new budget");
  const noAccount = new MqttBridge({ settings: settings({ mode: "commands" }), getSettings: () => tree(), allowedCommands: ROBOT_COMMANDS, log: () => undefined });
  await noAccount.onMessage("hydra/swarm/robot_1/cmd/jog", Buffer.from("{}"));
  assert.equal(noAccount.counters.executed, 0);
  await sub.close();
  await broker.close();
});

test("in the state mode the bridge does not even subscribe to the commands", async () => {
  const broker = await startBroker();
  const rig = commandRig();
  const bridge = new MqttBridge({ settings: settings({ mode: "state", url: broker.url }), getSettings: () => tree(), allowedCommands: ROBOT_COMMANDS, account: rig.account, execute: rig.execute, log: () => undefined });
  bridge.start();
  await wait(300);
  const pub = mqttConnect(broker.url, { reconnectPeriod: 0 });
  await new Promise<void>((resolve) => pub.on("connect", () => resolve()));
  pub.publish("hydra/swarm/robot_1/cmd/stop", "", { qos: 1 });
  await wait(300);
  assert.equal(rig.calls.length, 0);
  await pub.endAsync(true);
  await bridge.stop();
  await broker.close();
});

test("the account signs in once, keeps the token and signs in again after invalidate", async () => {
  let logins = 0;
  const account = loopbackAccount("svc", "pw", async (u, p) => {
    logins++;
    assert.deepEqual([u, p], ["svc", "pw"]);
    return logins === 1 ? { status: 200, body: { token: "t1" } } : logins === 2 ? { status: 401, body: null } : { status: 200, body: { token: "t3" } };
  });
  assert.equal(await account.token(), "t1");
  assert.equal(await account.token(), "t1");
  assert.equal(logins, 1);
  account.invalidate();
  assert.equal(await account.token(), null, "a refused sign-in gives no token");
  assert.equal(await account.token(), "t3");
});
