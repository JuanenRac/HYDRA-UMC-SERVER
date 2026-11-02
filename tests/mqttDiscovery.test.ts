import assert from "node:assert/strict";
import { test } from "node:test";
import { MqttBridge, discoveryMessages, resolveHomeAssistant, resolveMqttSettings, type MqttClientLike, type MqttConnect } from "../src/mqttBridge.ts";
import { SecurityConfig, SecurityConfigError, type SecurityFile } from "../src/securityConfig.ts";

const robot = { id: 3, name: "Arm 3", model: "Parol6 (6-DOF)", online: true, tool: "None", joints: { j1: 1, j2: 2, j3: 3, j4: 4, j5: 5, j6: 6 }, playbackState: "idle" };

test("Home Assistant discovery is off by default and only the exact word 1 turns it on from the environment", () => {
  assert.equal(resolveMqttSettings({}, {}).homeAssistant, false);
  assert.deepEqual(resolveHomeAssistant(undefined, {}), { value: false, source: "default" });
  assert.deepEqual(resolveHomeAssistant("1", {}), { value: true, source: "env" });
  for (const word of ["true", "yes", "on", "0", " "]) assert.equal(resolveHomeAssistant(word, {}).value, false, word);
  assert.deepEqual(resolveHomeAssistant(undefined, { mqtt: { homeAssistant: { enabled: true } } }), { value: true, source: "config" });
  assert.equal(resolveHomeAssistant("0", { mqtt: { homeAssistant: { enabled: true } } }).value, false, "the environment wins");
  assert.equal(resolveMqttSettings({}, { mqtt: { homeAssistant: { discoveryPrefix: "ha/custom" } } }).discoveryPrefix, "ha/custom");
  assert.equal(resolveMqttSettings({}, { mqtt: { homeAssistant: { discoveryPrefix: "bad prefix#" } } }).discoveryPrefix, "homeassistant");
});

test("a robot is described to Home Assistant as one device with its entities, and a stop button only when commands are on", () => {
  const state = discoveryMessages("hydra/swarm", "homeassistant", "c1", robot, false);
  assert.deepEqual(state.map((m) => m.topic), [
    "homeassistant/binary_sensor/hydra_umc_c1_robot_3/online/config",
    "homeassistant/sensor/hydra_umc_c1_robot_3/tool/config",
    "homeassistant/sensor/hydra_umc_c1_robot_3/playback/config",
    ...[1, 2, 3, 4, 5, 6].map((n) => `homeassistant/sensor/hydra_umc_c1_robot_3/j${n}/config`),
  ]);
  const online = JSON.parse(state[0].payload);
  assert.equal(online.state_topic, "hydra/swarm/robot_3/state");
  assert.equal(online.availability_topic, "hydra/swarm/status");
  assert.equal(online.unique_id, "hydra_umc_c1_robot_3_online");
  assert.deepEqual(online.device, { identifiers: ["hydra_umc_c1_robot_3"], name: "Arm 3", manufacturer: "HYDRA-UMC", model: "Parol6 (6-DOF)" });
  assert.ok(!state.some((m) => m.topic.includes("/button/")), "no command entity without commands");
  const withCommands = discoveryMessages("hydra/swarm", "homeassistant", "c1", robot, true);
  const stop = withCommands.find((m) => m.topic.includes("/button/"));
  assert.ok(stop);
  assert.equal(JSON.parse(stop.payload).command_topic, "hydra/swarm/robot_3/cmd/stop");
  assert.deepEqual(discoveryMessages("p", "homeassistant", "c1", { name: "no id" }, false), []);
});

test("a controller id with odd characters cannot break the topic of the discovery config", () => {
  const [first] = discoveryMessages("p", "homeassistant", "c 1/../#+", robot, false);
  assert.ok(!/[#+ ]/.test(first.topic), first.topic);
  assert.equal(first.topic.split("/").length, 5);
});

function fakeClient() {
  const published: { topic: string; payload: string; retain: boolean }[] = [];
  const handlers = new Map<string, (...args: any[]) => void>();
  const client: MqttClientLike = {
    publish: (topic, payload, options) => { published.push({ topic, payload, retain: options.retain }); return undefined; },
    subscribe: () => undefined,
    on: (event, listener) => { handlers.set(event, listener); return undefined; },
    end: (_force, cb) => { cb?.(); return undefined; },
  };
  const connect: MqttConnect = () => client;
  return { published, handlers, connect };
}
const tree = () => ({ controllers: [{ id: "c1", robots: [robot] }] });

test("the bridge publishes the discovery configs, retained and once, only when Home Assistant discovery is on", () => {
  for (const enabled of [false, true]) {
    const rig = fakeClient();
    const settings = { ...resolveMqttSettings({}, { mqtt: { mode: "state", homeAssistant: { enabled } } }), minStateIntervalMs: 50 };
    const bridge = new MqttBridge({ settings, getSettings: tree, allowedCommands: new Set(), connect: rig.connect, log: () => undefined });
    bridge.start();
    rig.handlers.get("connect")!();
    const configs = rig.published.filter((m) => m.topic.startsWith("homeassistant/"));
    if (!enabled) { assert.equal(configs.length, 0); continue; }
    assert.equal(configs.length, 9);
    assert.ok(configs.every((m) => m.retain));
    bridge.publishNow();
    assert.equal(rig.published.filter((m) => m.topic.startsWith("homeassistant/")).length, 9, "unchanged configs are not published again");
  }
});

function makeConfig(env: any = {}, initial: SecurityFile = {}) {
  let stored: SecurityFile = { ...initial };
  const config = new SecurityConfig({ env, load: () => ({ ...stored }), save: (file) => { stored = { ...file }; }, tlsActive: false });
  return { config, stored: () => stored };
}

test("an administrator turns the discovery on and off keeping the rest of the bridge, and the environment locks the switch", () => {
  const { config, stored } = makeConfig({}, { mqtt: { mode: "state", prefix: "plant/a" } });
  assert.deepEqual(config.snapshot().mqtt.homeAssistant, { enabled: { value: false, source: "default" }, discoveryPrefix: "homeassistant" });
  const on = config.update({ mqtt: { homeAssistant: { enabled: true, discoveryPrefix: "ha" } } }, "root");
  assert.ok(on.warnings.includes("mqtt_home_assistant_on"));
  assert.deepEqual(stored().mqtt, { mode: "state", prefix: "plant/a", homeAssistant: { enabled: true, discoveryPrefix: "ha" } });
  assert.deepEqual(on.snapshot.mqtt.homeAssistant, { enabled: { value: true, source: "config" }, discoveryPrefix: "ha" });
  const bad400 = (e: unknown) => e instanceof SecurityConfigError && e.status === 400;
  assert.throws(() => config.update({ mqtt: { homeAssistant: { enabled: "yes" } } }, "root"), bad400);
  assert.throws(() => config.update({ mqtt: { homeAssistant: { discoveryPrefix: "a b" } } }, "root"), bad400);
  assert.throws(() => config.update({ mqtt: { homeAssistant: [] } }, "root"), bad400);
  const locked = makeConfig({ mqtt: { homeAssistant: "1" } });
  assert.throws(() => locked.config.update({ mqtt: { homeAssistant: { enabled: false } } }, "root"), (e: unknown) => e instanceof SecurityConfigError && e.status === 409);
});
