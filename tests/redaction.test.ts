import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { redactSecrets, redactJson, redactLines } from "../src/redaction.ts";

const vectors = JSON.parse(fs.readFileSync(new URL("./fixtures/redaction_vectors.json", import.meta.url), "utf-8"));

test("text vectors shared by every implementation", async (t) => {
  for (const c of vectors.text) {
    await t.test(c.name, () => assert.equal(redactSecrets(c.input), c.expected));
  }
});
test("json vectors shared by every implementation", async (t) => {
  for (const c of vectors.json) {
    await t.test(c.name, () => assert.deepEqual(redactJson(c.input), c.expected));
  }
});
test("lines vectors shared by every implementation", async (t) => {
  for (const c of vectors.lines) {
    await t.test(c.name, () => assert.deepEqual(redactLines(c.input), c.expected));
  }
});
