import assert from "node:assert/strict";
import { test } from "node:test";
import { SecurityConfig, type SecurityFile } from "../src/securityConfig.ts";
import { LANGUAGES, MESSAGES, detectLanguage, translate } from "../admin-ui/src/i18n.ts";
import {
  SWITCHES, PRESENCE_ACTIONS, isLocked, jobDispatcherNeedsConfirmation, jobDispatcherPatch, needsConfirmation, parseRobotMapText, presenceActionPatch, readJobDispatcher, readPresenceAction, readSwitches,
  robotMapToText, switchPatch, warningKeys,
} from "../admin-ui/src/securityModel.ts";

// The Security tab of the admin UI: what it reads from GET /api/admin/server-config, what it sends and what it says, checked against the real SecurityConfig.

function makeConfig(env: any = {}, initial: SecurityFile = {}) {
  let stored: SecurityFile = { ...initial };
  const config = new SecurityConfig({ env, load: () => ({ ...stored }), save: (file) => { stored = { ...file }; }, tlsActive: false });
  return { config, stored: () => stored };
}

test("the twelve switches are exactly the ones the server reports, each on its conservative value by default", () => {
  const states = readSwitches(makeConfig().config.snapshot());
  assert.equal(states.length, 12);
  assert.deepEqual(states.map((s) => s.def.id), SWITCHES.map((s) => s.id));
  for (const state of states) {
    assert.equal(state.source, "default", state.def.id);
    // the default is the protective one: never the value that the tab asks to confirm
    if (state.def.riskyWhen !== null) assert.notEqual(state.value, state.def.riskyWhen, state.def.id);
  }
});

test("every switch is sent as the server expects it, and the server accepts and reports it", () => {
  for (const def of SWITCHES) {
    const { config } = makeConfig();
    const before = readSwitches(config.snapshot()).find((s) => s.def.id === def.id)!;
    const result = config.update(switchPatch(def, !before.value), "root");
    const after = readSwitches(result.snapshot).find((s) => s.def.id === def.id)!;
    assert.equal(after.value, !before.value, def.id);
    assert.equal(after.source, "config", def.id);
    // only what changed is sent
    assert.deepEqual(Object.keys(switchPatch(def, true)), [def.section]);
    assert.deepEqual(Object.keys(switchPatch(def, true)[def.section]), [def.key]);
  }
});

test("a value fixed by the environment is locked", () => {
  const states = readSwitches(makeConfig({ healthOpen: "1" }).config.snapshot());
  const health = states.find((s) => s.def.id === "health.open")!;
  assert.equal(health.value, true);
  assert.equal(isLocked(health.source), true);
  assert.equal(isLocked("config"), false);
});

test("only the move toward the unprotected value asks for a confirmation", () => {
  const byId = (id: string) => SWITCHES.find((s) => s.id === id)!;
  assert.equal(needsConfirmation(byId("health.open"), false, true), true);
  assert.equal(needsConfirmation(byId("health.open"), true, false), false);
  assert.equal(needsConfirmation(byId("logging.redactSecrets"), true, false), true);
  assert.equal(needsConfirmation(byId("logging.redactSecrets"), false, true), false);
  assert.equal(needsConfirmation(byId("safety.publishGlobalStop"), false, true), false, "announcing a stop lowers nothing");
  assert.equal(needsConfirmation(byId("health.open"), true, true), false);
  for (const def of SWITCHES) {
    if (def.riskyWhen !== null) assert.ok(def.confirm, `${def.id} has a question to ask`);
  }
});

test("the warnings of the server become the sentences of the tab", () => {
  const saved = makeConfig().config.update({ health: { open: true }, logging: { redactSecrets: false }, jobDispatcher: { stopRelay: { enabled: true } } }, "root");
  const keys = warningKeys(saved.warnings);
  assert.ok(keys.includes("warn_health_open") && keys.includes("warn_log_redaction") && keys.includes("jd_warning_relay"), keys.join(","));
  assert.deepEqual(warningKeys("x"), []);
  assert.deepEqual(warningKeys(["nothing_known"]), []);
});

test("the job dispatcher section is read as the server reports it, and a damaged one is left out", () => {
  const { config } = makeConfig({}, { jobDispatcher: { stopRelay: { enabled: true, robotMap: { "arm-2": 2, "arm-1": 1 } } } });
  const jd = readJobDispatcher(config.snapshot())!;
  assert.equal(jd.relayEnabled, true);
  assert.deepEqual(jd.robotMap, { "arm-1": 1, "arm-2": 2 });
  assert.equal(jd.replanEditable, false);
  assert.equal(readJobDispatcher({}), null);
  assert.equal(readJobDispatcher({ jobDispatcher: { stopRelay: {}, replan: {} } }), null);
  assert.equal(readJobDispatcher(null), null);
});

test("the robot map as text and back, with the same limits as the server", () => {
  assert.equal(robotMapToText({ "arm-2": 2, "arm-1": 1 }), "arm-1 = 1\narm-2 = 2");
  assert.deepEqual(parseRobotMapText("arm-1 = 1\n\n arm-2=2 \r\n"), { "arm-1": 1, "arm-2": 2 });
  for (const bad of ["arm-1", "arm-1 = x", "arm-1 = -1", "bad id = 1", "= 1", "a = 1\na = 2", `${"x".repeat(65)} = 1`]) assert.equal(parseRobotMapText(bad), null, bad);
  // what the tab accepts, the server accepts
  const { config } = makeConfig();
  const patch = jobDispatcherPatch({ relayEnabled: true, robotMapText: "arm-1 = 1\nlaser:2 = 7", replanEditable: false, allowUnconfirmed: false, timeoutText: "" })!;
  assert.doesNotThrow(() => config.update(patch, "root"));
  assert.deepEqual(config.jobStopRobotMap(), { "arm-1": 1, "laser:2": 7 });
});

test("the request for the dispatcher leaves the replanning out when the server cannot write its file, and validates the wait otherwise", () => {
  const input = { relayEnabled: true, robotMapText: "arm-1 = 1", replanEditable: true, allowUnconfirmed: true, timeoutText: "45,5" };
  assert.deepEqual(jobDispatcherPatch(input), { jobDispatcher: { stopRelay: { enabled: true, robotMap: { "arm-1": 1 } }, replan: { allowUnconfirmed: true, stopAckTimeoutSeconds: 45.5 } } });
  assert.deepEqual(jobDispatcherPatch({ ...input, replanEditable: false, timeoutText: "nonsense" }), { jobDispatcher: { stopRelay: { enabled: true, robotMap: { "arm-1": 1 } } } });
  for (const timeoutText of ["", "0", "-1", "86401", "abc", "1e3"]) assert.equal(jobDispatcherPatch({ ...input, timeoutText }), null, timeoutText);
  assert.notEqual(jobDispatcherPatch({ ...input, timeoutText: "86400" }), null);
  assert.equal(jobDispatcherPatch({ ...input, robotMapText: "nonsense" }), null);
});

test("it asks first when the delivery is switched on or a job may move without a confirmed stop", () => {
  const { config } = makeConfig();
  const current = readJobDispatcher(config.snapshot())!;
  const base = { relayEnabled: false, robotMapText: "", replanEditable: true, allowUnconfirmed: false, timeoutText: "30" };
  assert.equal(jobDispatcherNeedsConfirmation(current, jobDispatcherPatch(base)!), false);
  assert.equal(jobDispatcherNeedsConfirmation(current, jobDispatcherPatch({ ...base, relayEnabled: true })!), true);
  assert.equal(jobDispatcherNeedsConfirmation(current, jobDispatcherPatch({ ...base, allowUnconfirmed: true })!), true);
  assert.equal(jobDispatcherNeedsConfirmation(current, jobDispatcherPatch({ ...base, timeoutText: "60" })!), false);
});

test("every sentence the tab uses exists in the eight languages, with no placeholder left over", () => {
  assert.deepEqual([...LANGUAGES], ["en", "es", "de", "fr", "it", "ja", "zh", "pt"]);
  const used = new Set<string>(["tab", "intro", "admin_only", "save", "saved", "load_error", "switches_title", "source_env", "source_config", "source_default"]);
  for (const def of SWITCHES) {
    used.add(def.label);
    if (def.warning) used.add(def.warning);
    if (def.confirm) used.add(def.confirm);
  }
  for (const key of ["presence_action_title", "presence_action_slow", "presence_action_pause", "presence_action_notify", "presence_action_stop", "warn_presence_notify", "jd_title", "jd_relay_label", "jd_relay_help", "jd_map_label", "jd_map_placeholder", "jd_map_help", "jd_map_invalid", "jd_replan_title", "jd_allow_label", "jd_timeout_label", "jd_timeout_invalid", "jd_replan_help", "jd_not_editable", "jd_save", "jd_confirm", "jd_warning_relay", "jd_warning_replan"]) used.add(key);
  for (const language of LANGUAGES) {
    for (const key of used) {
      const text = MESSAGES[language][key];
      assert.ok(typeof text === "string" && text.trim() !== "", `${language}.${key}`);
      assert.ok(!/\{\{|\}\}|undefined/.test(text), `${language}.${key}`);
    }
    assert.deepEqual(Object.keys(MESSAGES[language]), Object.keys(MESSAGES.en), `${language} has the keys of English, in the same order`);
  }
});

test("the language is the saved one, else the browser's, else English", () => {
  assert.equal(detectLanguage("de", "es-ES"), "de");
  assert.equal(detectLanguage(null, "pt-PT"), "pt");
  assert.equal(detectLanguage(undefined, "ja"), "ja");
  assert.equal(detectLanguage("xx", "ru-RU"), "en");
  assert.equal(detectLanguage(null, null), "en");
  assert.equal(translate("fr", "tab"), "Sécurité");
  assert.equal(translate("en", "no_such_key"), "no_such_key");
});

test("the action of a lost heartbeat is read as the server reports it, chosen on its own, and the environment locks it", () => {
  const { config } = makeConfig();
  assert.deepEqual(readPresenceAction(config.snapshot()), { action: "slow", source: "default" });
  assert.deepEqual([...PRESENCE_ACTIONS], ["slow", "pause", "notify", "stop"]);
  for (const action of PRESENCE_ACTIONS) {
    const saved = makeConfig().config.update(presenceActionPatch(action), "root");
    assert.deepEqual(readPresenceAction(saved.snapshot), { action, source: "config" });
  }
  assert.deepEqual(presenceActionPatch("pause"), { presence: { action: "pause" } });
  assert.equal(isLocked(readPresenceAction(makeConfig({ presenceAction: "stop" }).config.snapshot())!.source), true);
  assert.equal(readPresenceAction({}), null);
  assert.equal(readPresenceAction({ presence: { action: { value: "explode", source: "config" } } }), null);
  assert.ok(warningKeys(makeConfig().config.update({ presence: { action: "notify" } }, "root").warnings).includes("warn_presence_notify"));
});
