import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { SecurityConfig, SecurityConfigError, securityEnvFrom, type SecurityFile } from "../src/securityConfig.ts";
import { switchOn, SWITCH_FAULT_FEED, SWITCH_SCENARIO } from "../src/ingestFeeds.ts";
import { SWITCH_VOICE_CHAIN } from "../src/voiceChain.ts";
import { PROPOSAL_KEYS_FILE } from "../src/proposalVerify.ts";

// The `ingest` block of the server settings: what the sibling services hand to this server and what it keeps. Off by default, a
// confirmation to turn anything on, and the environment variable of each switch still decides and locks it.

function makeConfig(env: any = {}, initial: SecurityFile = {}) {
  let stored: SecurityFile = { ...initial };
  const logs: string[] = [];
  const config = new SecurityConfig({ env, load: () => ({ ...stored }), save: (file) => { stored = { ...file }; }, tlsActive: false, log: (m) => logs.push(m) });
  return { config, logs, stored: () => stored };
}
const status = (e: unknown, code: number) => e instanceof SecurityConfigError && e.status === code;
const KEYS = ["faultFeed", "scenario", "developerNode", "anomalyFeed", "anomalyVoiceRelay", "voiceChain", "proposalVerify"] as const;

test("everything starts off and with no keys file", () => {
  const { config } = makeConfig();
  const s = config.snapshot().ingest;
  for (const key of KEYS) assert.deepEqual(s[key], { value: false, source: "default" }, key);
  assert.deepEqual(s.proposalKeysFile, { value: "", source: "default" });
  assert.equal(s.appliesOnRestart, false);
  const env = config.ingestEnv({}, "/data");
  for (const name of ["HYDRA_UMC_FAULT_FEED", "HYDRA_UMC_INGEST_SCENARIO", "HYDRA_UMC_VOICE_CHAIN"]) assert.equal(env[name], undefined);
});

test("turning a switch on needs the confirmation, is saved, warned about and logged", () => {
  const { config, logs, stored } = makeConfig();
  assert.throws(() => config.update({ ingest: { scenario: true } }, "root"), (e) => status(e, 400) && /confirm: true/.test((e as Error).message));
  assert.throws(() => config.update({ ingest: { scenario: true, confirm: false } }, "root"), (e) => status(e, 400));
  assert.equal(config.ingestSwitch("scenario"), false);
  const on = config.update({ ingest: { scenario: true, voiceChain: true, confirm: true } }, "root");
  assert.deepEqual(on.warnings, ["ingest_on"]);
  assert.equal(on.appliesOnRestart, false);
  assert.deepEqual(stored().ingest, { scenario: true, voiceChain: true });
  assert.equal(config.ingestSwitch("scenario"), true);
  assert.match(logs.join("\n"), /root set what this server accepts and keeps.*scenario, voiceChain/);
  const off = config.update({ ingest: { scenario: false } }, "root");
  assert.deepEqual(off.warnings, []);
  assert.equal(config.ingestSwitch("scenario"), false);
  assert.equal(config.ingestSwitch("voiceChain"), true);
});

test("the feeds that read the broker ask for a restart, the routes do not", () => {
  const { config } = makeConfig();
  assert.equal(config.update({ ingest: { faultFeed: true, confirm: true } }, "root").appliesOnRestart, true);
  assert.equal(config.update({ ingest: { developerNode: true, confirm: true } }, "root").appliesOnRestart, false);
  config.noteIngestStarted();
  assert.equal(config.snapshot().ingest.appliesOnRestart, false);
  config.update({ ingest: { anomalyFeed: true, confirm: true } }, "root");
  assert.equal(config.snapshot().ingest.appliesOnRestart, true);
});

test("the environment decides and locks each switch: 1 on, 0 off, any other word says nothing", () => {
  const env = securityEnvFrom({ HYDRA_UMC_FAULT_FEED: "1", HYDRA_UMC_VOICE_CHAIN: "0", HYDRA_UMC_INGEST_SCENARIO: "yes" } as any);
  const { config } = makeConfig(env, { ingest: { voiceChain: true, scenario: true } });
  const s = config.snapshot().ingest;
  assert.deepEqual(s.faultFeed, { value: true, source: "env" });
  assert.deepEqual(s.voiceChain, { value: false, source: "env" });
  assert.deepEqual(s.scenario, { value: true, source: "config" });
  assert.throws(() => config.update({ ingest: { faultFeed: false } }, "root"), (e) => status(e, 409) && /HYDRA_UMC_FAULT_FEED/.test((e as Error).message));
  assert.throws(() => config.update({ ingest: { voiceChain: true, confirm: true } }, "root"), (e) => status(e, 409));
  const effective = config.ingestEnv({ HYDRA_UMC_FAULT_FEED: "1", HYDRA_UMC_VOICE_CHAIN: "0", HYDRA_UMC_INGEST_SCENARIO: "yes" }, "/data");
  assert.equal(switchOn(SWITCH_FAULT_FEED, effective), true);
  assert.equal(switchOn(SWITCH_VOICE_CHAIN, effective), false);
  assert.equal(switchOn(SWITCH_SCENARIO, effective), true, "the saved switch fills in where the environment says nothing useful");
});

test("the saved switches reach the code that reads the environment, and the base environment is left alone", () => {
  const { config } = makeConfig();
  config.update({ ingest: { faultFeed: true, confirm: true } }, "root");
  const base: Record<string, string | undefined> = { OTHER: "x" };
  const effective = config.ingestEnv(base, "/data");
  assert.equal(effective.HYDRA_UMC_FAULT_FEED, "1");
  assert.equal(effective.OTHER, "x");
  assert.equal(base.HYDRA_UMC_FAULT_FEED, undefined);
  assert.equal(switchOn(SWITCH_FAULT_FEED, effective), true);
  assert.equal(effective.HYDRA_UMC_ANOMALY_FEED, undefined, "a switch nobody saved stays unset");
  config.update({ ingest: { scenario: false } }, "root");
  assert.equal(config.ingestEnv(base, "/data").HYDRA_UMC_INGEST_SCENARIO, "0", "a saved switch that is off is written off too");
});

test("the keys file is a name in the data folder; a change needs the confirmation; the environment path wins", () => {
  const { config, stored } = makeConfig();
  for (const bad of ["../keys.json", "a/b.json", "C:\\keys.json", ".hidden", "a..b", "x".repeat(65), 7]) {
    assert.throws(() => config.update({ ingest: { proposalKeysFile: bad, confirm: true } } as any, "root"), (e) => status(e, 400), String(bad));
  }
  assert.throws(() => config.update({ ingest: { proposalKeysFile: "operators.json" } }, "root"), (e) => status(e, 400));
  config.update({ ingest: { proposalKeysFile: "operators.json", confirm: true } }, "root");
  assert.equal(stored().ingest?.proposalKeysFile, "operators.json");
  assert.deepEqual(config.snapshot().ingest.proposalKeysFile, { value: "operators.json", source: "config" });
  assert.equal(config.ingestEnv({}, path.join("/data")).HYDRA_UMC_PROPOSAL_KEYS_FILE, path.join("/data", "operators.json"));
  config.update({ ingest: { proposalKeysFile: "" } }, "root");
  assert.equal(stored().ingest?.proposalKeysFile, undefined);

  const locked = makeConfig(securityEnvFrom({ HYDRA_UMC_PROPOSAL_KEYS_FILE: "/etc/keys.json" } as any), { ingest: { proposalKeysFile: "operators.json" } });
  assert.deepEqual(locked.config.snapshot().ingest.proposalKeysFile, { value: "/etc/keys.json", source: "env" });
  assert.throws(() => locked.config.update({ ingest: { proposalKeysFile: "other.json", confirm: true } }, "root"), (e) => status(e, 409));
  assert.equal(locked.config.ingestEnv({ HYDRA_UMC_PROPOSAL_KEYS_FILE: "/etc/keys.json" }, "/data")[PROPOSAL_KEYS_FILE], "/etc/keys.json");
});

test("an invalid file value is ignored when read; the shape of the change is checked and other options are left as they were", () => {
  const { config } = makeConfig({}, { ingest: { proposalKeysFile: "../../etc/passwd", faultFeed: "yes" as any } });
  assert.deepEqual(config.snapshot().ingest.proposalKeysFile, { value: "", source: "default" });
  assert.deepEqual(config.snapshot().ingest.faultFeed, { value: false, source: "default" });
  for (const bad of [true, "on", [], { unknown: true }, { scenario: "yes" }, { confirm: "y" }, { faultFeed: 1, confirm: true }]) {
    assert.throws(() => config.update({ ingest: bad } as any, "root"), (e) => status(e, 400), JSON.stringify(bad));
  }
  config.update({ production: { rdpLevel: 1 } }, "root");
  config.update({ ingest: { scenario: true, confirm: true } }, "root");
  assert.equal(config.snapshot().production.rdpLevel.value, 1);
  assert.equal(config.snapshot().ingest.scenario.value, true);
});
