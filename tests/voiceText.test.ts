import assert from "node:assert/strict";
import { test } from "node:test";
import { VOICE_LANGUAGES, voiceLanguageOf, voiceStatusText } from "../src/voiceText.ts";

const FACTS = { controllerCount: 2, robotCount: 1, cpuLoad: 12, memoryUsage: 40, uptime: 3600 };

test("the language follows the locale of the client and falls back to English", () => {
  const cases: [unknown, string][] = [
    ["en-US", "en"], ["es-ES", "es"], ["de", "de"], ["fr_CA", "fr"], ["it-IT", "it"], ["ja-JP", "ja"],
    ["zh-Hant-TW", "zh"], ["pt-PT", "pt"], ["sv-SE", "en"], ["", "en"], [undefined, "en"], [42, "en"],
  ];
  for (const [locale, language] of cases) assert.equal(voiceLanguageOf(locale), language, String(locale));
});

test("the status is written in each of the eight languages with every number in it", () => {
  const texts = new Set<string>();
  for (const language of VOICE_LANGUAGES) {
    const text = voiceStatusText(FACTS, language);
    texts.add(text);
    for (const value of ["2", "1", "12", "40", "3600"]) assert.ok(text.includes(value), `${language}: ${value}`);
    const asked = voiceStatusText({ ...FACTS, robotId: 7, robotRegistered: false }, language);
    assert.ok(asked.includes("7") && asked.length > text.length, language);
    assert.notEqual(asked, voiceStatusText({ ...FACTS, robotId: 7, robotRegistered: true }, language), language);
  }
  assert.equal(texts.size, VOICE_LANGUAGES.length, "every language has its own text");
});

test("English keeps the sentences the server always spoke", () => {
  assert.equal(
    voiceStatusText({ ...FACTS, controllerCount: 1, robotCount: 1 }, "en-US"),
    "1 controller, 1 robot configured. CPU load 12%, memory 40%, uptime 3600s.",
  );
  assert.equal(
    voiceStatusText({ ...FACTS, robotId: 3, robotRegistered: true }, undefined),
    "Robot 3 is registered on this Server. 2 controllers, 1 robot configured. CPU load 12%, memory 40%, uptime 3600s.",
  );
});

test("a registered robot's last news is told in each language, and an unregistered one gets none", () => {
  for (const language of VOICE_LANGUAGES) {
    const base = voiceStatusText({ ...FACTS, robotId: 7, robotRegistered: true }, language);
    const live = voiceStatusText({ ...FACTS, robotId: 7, robotRegistered: true, robotNews: { state: "live", ageS: 12 } }, language);
    const stale = voiceStatusText({ ...FACTS, robotId: 7, robotRegistered: true, robotNews: { state: "stale", ageS: 95 } }, language);
    const unknown = voiceStatusText({ ...FACTS, robotId: 7, robotRegistered: true, robotNews: { state: "unknown" } }, language);
    assert.ok(live.includes("12") && !live.includes("95"), language);
    assert.ok(stale.includes("95"), language);
    assert.equal(new Set([base, live, stale, unknown]).size, 4, `${language}: each state has its own sentence`);
    assert.ok(live.length > base.length && unknown.length > base.length, language);
    // the news of a robot the server does not have is never told
    assert.equal(
      voiceStatusText({ ...FACTS, robotId: 7, robotRegistered: false, robotNews: { state: "live", ageS: 1 } }, language),
      voiceStatusText({ ...FACTS, robotId: 7, robotRegistered: false }, language),
      language,
    );
  }
  assert.equal(
    voiceStatusText({ ...FACTS, robotId: 3, robotRegistered: true, robotNews: { state: "stale", ageS: 40 } }, "en"),
    "Robot 3 is registered on this Server. It has been silent for 40s. 2 controllers, 1 robot configured. CPU load 12%, memory 40%, uptime 3600s.",
  );
  // no news given: the sentence is what it always was
  assert.equal(
    voiceStatusText({ ...FACTS, robotId: 3, robotRegistered: true }, "en"),
    "Robot 3 is registered on this Server. 2 controllers, 1 robot configured. CPU load 12%, memory 40%, uptime 3600s.",
  );
});
