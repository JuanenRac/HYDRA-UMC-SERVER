import assert from "node:assert/strict";
import { test } from "node:test";
import {
  canonicalJson,
  judgeConfirmationResult,
  requireSignature,
  signResult,
  subjectOf,
  validateConfirmRequest,
  verifyResultSignature,
  voiceResultKey,
} from "../src/voiceConfirm.ts";

const KEY = "result-key-shared-with-the-server";
// the result and the signature HYDRA-UMC-VOICE-UI computes for it (its tests/test_subject_and_signature.py holds the same vector)
const RESULT = {
  type: "confirmation_result",
  status: "confirmed",
  requestId: "req-vector-1",
  intent: { name: "start_mission", entities: { mission_id: "alpha" } },
  subject: "alice",
  confirmedAtUtc: "2026-01-05T10:00:00+00:00",
  nonce: "0123456789abcdef",
};
const SIGNATURE = "18cc5ac19df813f96a4412eba10d979b3e9fe440e83d672544db5c9cecb6c4f7";

test("the signature is the one the Voice UI computes", () => {
  assert.equal(signResult(RESULT, KEY), SIGNATURE);
  assert.equal(verifyResultSignature({ ...RESULT, signature: SIGNATURE, reason: "free text", ageSeconds: 4.2 }, KEY), true);
});

test("anything that states the confirmation, or another key, breaks the signature", () => {
  const signed = { ...RESULT, signature: SIGNATURE };
  for (const change of [{ subject: "mallory" }, { requestId: "other" }, { nonce: "f".repeat(16) }, { confirmedAtUtc: "2030-01-01T00:00:00+00:00" }, { intent: { name: "go_home", entities: {} } }]) {
    assert.equal(verifyResultSignature({ ...signed, ...change }, KEY), false, JSON.stringify(change));
  }
  assert.equal(verifyResultSignature(signed, "another-key-of-sixteen-chars"), false);
  for (const bad of [undefined, "", "xyz", "A".repeat(64), SIGNATURE.slice(1), 7]) {
    assert.equal(verifyResultSignature({ ...RESULT, signature: bad }, KEY), false, String(bad));
  }
});

test("the canonical JSON sorts every level and has no spaces", () => {
  assert.equal(canonicalJson({ b: 1, a: { d: [3, { z: 1, y: 2 }], c: "é" } }), '{"a":{"c":"é","d":[3,{"y":2,"z":1}]},"b":1}');
});

test("a confirmed result is believed only for the subject that asked and, with a key, when it is signed", () => {
  const env = { HYDRA_UMC_VOICE_UI_RESULT_KEY: KEY };
  const good = { ...RESULT, signature: SIGNATURE };
  const ok = judgeConfirmationResult(good, "alice", env);
  assert.equal(ok.ok && ok.verified, true);
  // another subject
  assert.deepEqual(judgeConfirmationResult(good, "bob", env), { ok: false, status: 502, error: "HYDRA-UMC-VOICE-UI confirmed a result for another subject" });
  // unsigned or wrongly signed
  assert.equal(judgeConfirmationResult(RESULT, "alice", env).ok, false);
  assert.equal(judgeConfirmationResult({ ...good, nonce: "1".repeat(16) }, "alice", env).ok, false);
  // not even a result
  for (const junk of [null, "x", [], {}, { type: "confirmation_result", status: "maybe" }, { type: "assistant_reply", status: "confirmed" }]) {
    assert.equal(judgeConfirmationResult(junk, "alice", env).ok, false, JSON.stringify(junk));
  }
  assert.equal(judgeConfirmationResult({ ...good, requestId: "bad id!" }, "alice", env).ok, false);
  assert.equal(judgeConfirmationResult({ ...good, intent: {} }, "alice", env).ok, false);
});

test("without a key a confirmed result passes unverified, and is refused when a signature is required", () => {
  const unsigned = judgeConfirmationResult(RESULT, "alice", {});
  assert.equal(unsigned.ok && unsigned.verified, false);
  const required = judgeConfirmationResult(RESULT, "alice", { HYDRA_UMC_VOICE_CONFIRM_REQUIRE_SIGNATURE: "1" });
  assert.equal(required.ok, false);
  assert.equal(!required.ok && required.status, 503);
  assert.equal(requireSignature({ HYDRA_UMC_VOICE_CONFIRM_REQUIRE_SIGNATURE: "1" }), true);
  assert.equal(requireSignature({ HYDRA_UMC_VOICE_CONFIRM_REQUIRE_SIGNATURE: "true" }), false);
  assert.equal(requireSignature({}), false);
});

test("results that are not confirmed are relayed as they are", () => {
  for (const status of ["expired", "invalid"]) {
    const verdict = judgeConfirmationResult({ type: "confirmation_result", status, reason: "x" }, "alice", { HYDRA_UMC_VOICE_UI_RESULT_KEY: KEY });
    assert.equal(verdict.ok && verdict.verified, false);
  }
});

test("the key is read from the variable or its file and must be long enough", () => {
  assert.equal(voiceResultKey({ HYDRA_UMC_VOICE_UI_RESULT_KEY: KEY }), KEY);
  assert.equal(voiceResultKey({ HYDRA_UMC_VOICE_UI_RESULT_KEY: "short" }), "");
  assert.equal(voiceResultKey({}), "");
});

test("the subject of a session is its username, and only a safe one", () => {
  assert.equal(subjectOf({ username: "alice", role: "operator" }), "alice");
  for (const bad of [null, undefined, {}, { username: "" }, { username: "a b" }, { username: "x".repeat(129) }, { username: 5 }, "alice"]) {
    assert.equal(subjectOf(bad), "", JSON.stringify(bad));
  }
});

test("a confirmation request needs a token of a sensible size", () => {
  assert.equal(validateConfirmRequest({ confirmationToken: "abc.def" }), null);
  for (const bad of [null, [], {}, { confirmationToken: "" }, { confirmationToken: 7 }, { confirmationToken: "x".repeat(2049) }]) {
    assert.notEqual(validateConfirmRequest(bad), null, JSON.stringify(bad));
  }
});
