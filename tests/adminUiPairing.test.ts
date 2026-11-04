import assert from "node:assert/strict";
import { test } from "node:test";
import { LANGUAGES, MESSAGES } from "../admin-ui/src/i18n.ts";
import { PAIRING, buildPairingLink, normalizeFingerprint, readTlsFingerprint } from "../admin-ui/src/pairingModel.ts";

// The pairing code of the Security tab: the text it carries is the one the control apps read, with the limits of their command contract.

const HEX = "ab".repeat(32);
const COLONS = Array.from({ length: 32 }, () => "AB").join(":");

test("a link with address, port, fingerprint and name has the shape the apps read", () => {
  const result = buildPairingLink({ host: "192.168.0.180", port: 3000, fingerprint: COLONS, name: "Workshop 1" });
  assert.deepEqual(result, { ok: true, link: `hydra-umc://pair?host=192.168.0.180&port=3000&fp=${HEX}&name=Workshop%201` });
});

test("a server without TLS gives a link without fingerprint, and a name is optional", () => {
  assert.deepEqual(buildPairingLink({ host: "hydra.local", port: 80, fingerprint: null, name: "" }), { ok: true, link: "hydra-umc://pair?host=hydra.local&port=80" });
});

test("what the apps would refuse is not built", () => {
  const base = { host: "192.168.0.180", port: 3000, fingerprint: HEX, name: "x" };
  const problem = (change: object) => {
    const r = buildPairingLink({ ...base, ...change });
    return r.ok ? null : r.problem;
  };
  assert.equal(problem({ host: "" }), "host");
  assert.equal(problem({ host: "300.1.1.1" }), "host");
  assert.equal(problem({ host: "bad host" }), "host");
  assert.equal(problem({ port: 0 }), "port");
  assert.equal(problem({ port: 65536 }), "port");
  assert.equal(problem({ port: 3000.5 }), "port");
  assert.equal(problem({ fingerprint: "abc" }), "fingerprint");
  assert.equal(problem({ name: "n".repeat(PAIRING.nameMax + 1) }), "name");
  assert.equal(problem({ name: "a\nb" }), "name");
  assert.equal(problem({ name: "日".repeat(64) }), "too_long");
});

test("an IPv6 address loses its brackets, and a fingerprint is read in any usual spelling", () => {
  const r = buildPairingLink({ host: "[fe80::1]", port: 3000, fingerprint: HEX, name: "" });
  assert.equal(r.ok && r.link.includes("host=fe80%3A%3A1"), true);
  assert.equal(normalizeFingerprint(COLONS), HEX);
  assert.equal(normalizeFingerprint(HEX.toUpperCase()), HEX);
  assert.equal(normalizeFingerprint("ab"), null);
});

test("the fingerprint comes from the server configuration only while TLS is on", () => {
  assert.equal(readTlsFingerprint({ tls: { enabled: true, fingerprint256: COLONS } }), HEX);
  assert.equal(readTlsFingerprint({ tls: { enabled: false, fingerprint256: COLONS } }), null);
  assert.equal(readTlsFingerprint({ tls: { enabled: true, fingerprint256: null } }), null);
  assert.equal(readTlsFingerprint(null), null);
});

test("the sentences of the pairing card exist in the eight languages", () => {
  const keys = Object.keys(MESSAGES.en).filter((k) => k.startsWith("pair_"));
  assert.equal(keys.length, 12);
  for (const language of LANGUAGES) {
    for (const key of keys) assert.ok(MESSAGES[language][key]?.length > 0, `${language}.${key}`);
  }
});
