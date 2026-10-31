// =============================================================================
// HYDRA-UMC-SERVER - Unit tests for src/connections.ts
// Copyright (C) 2026 JuanenRac (Electro Hobby 3D) <electrohobby3d@gmail.com>
// GPL-3.0-or-later - see LICENSE
// =============================================================================
// The history of connections: the closed shape of the two contracts of the SDK, no secret anywhere, the address only when the
// option is on and only for an administrator, and the bounds that keep it from growing without limit.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ConnectionTracker, agentFamily, clientIdOf, identify, originOf } from "../src/connections";

const here = path.dirname(fileURLToPath(import.meta.url));

// A small reader of the JSON Schema words that the two contracts use, so the shapes are checked against the schemas of the SDK
// themselves when a checkout of the SDK is next to this one (HYDRA_UMC_SDK_DIR names another place).
function sdkSchema(name: string): any | undefined {
  const dirs = [process.env.HYDRA_UMC_SDK_DIR, path.resolve(here, "..", "..", "HYDRA-UMC-SDK")].filter(Boolean) as string[];
  for (const dir of dirs) {
    const file = path.join(dir, "contracts", "json-schema", "v1", `${name}.schema.json`);
    if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, "utf8"));
  }
  return undefined;
}

function check(schema: any, value: any, where = "value"): string[] {
  const problems: string[] = [];
  if ("const" in schema && value !== schema.const) problems.push(`${where}: not ${schema.const}`);
  if (schema.enum && !schema.enum.includes(value)) problems.push(`${where}: ${value} not in the enum`);
  if (schema.type === "string") {
    if (typeof value !== "string") return [...problems, `${where}: not a string`];
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) problems.push(`${where}: does not match the pattern`);
    if (schema.minLength !== undefined && value.length < schema.minLength) problems.push(`${where}: too short`);
    if (schema.maxLength !== undefined && value.length > schema.maxLength) problems.push(`${where}: too long`);
    if (schema.format === "date-time" && Number.isNaN(Date.parse(value))) problems.push(`${where}: not a date`);
  }
  if (schema.type === "integer" && (!Number.isInteger(value) || (schema.minimum !== undefined && value < schema.minimum))) problems.push(`${where}: not a valid integer`);
  if (schema.type === "boolean" && typeof value !== "boolean") problems.push(`${where}: not a boolean`);
  if (schema.type === "object") {
    for (const key of schema.required ?? []) if (!(key in value)) problems.push(`${where}: ${key} is missing`);
    for (const [key, item] of Object.entries(value)) {
      if (schema.properties?.[key]) problems.push(...check(schema.properties[key], item, `${where}.${key}`));
      else if (schema.additionalProperties === false) problems.push(`${where}: ${key} is not allowed`);
    }
  }
  return problems;
}

const PASSWORD = "correct horse battery staple";
const CHROME = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130.0 Safari/537.36";

function make(options: { recordAddress?: boolean; now?: { t: number }; eventCapacity?: number; clientCapacity?: number; file?: string } = {}) {
  const clock = options.now ?? { t: Date.parse("2026-01-01T00:00:00Z") };
  const tracker = new ConnectionTracker({ file: options.file, now: () => clock.t, recordAddress: () => options.recordAddress ?? false, eventCapacity: options.eventCapacity, clientCapacity: options.clientCapacity });
  return { tracker, clock };
}

const studio = { kind: "studio" as const, user: "root", version: "0.8.1", agent: CHROME, ip: "203.0.113.9", origin: "remote" as const };

test("a sign-in writes first_seen and login, and the client counts it", () => {
  const { tracker } = make();
  const id = tracker.login(studio, false);
  assert.equal(id, clientIdOf(studio));
  assert.deepEqual(tracker.events(true).map(e => e.action), ["login", "first_seen"]);
  const [client] = tracker.clients(() => 2, true);
  assert.equal(client.logins_ok, 1);
  assert.equal(client.logins_failed, 0);
  assert.equal(client.active_sessions, 2);
  assert.equal(client.kind, "studio");
});

test("the events and clients keep the closed shape of the SDK contracts", () => {
  const { tracker } = make({ recordAddress: true });
  tracker.login(studio, true);
  tracker.refused({ ...studio }, "login_failed", true);
  tracker.refused({ ...studio }, "second_factor_failed", true);
  tracker.endedClient(clientIdOf(studio), "logout", { ip: "203.0.113.9", origin: "remote" });
  const eventSchema = sdkSchema("connection-event");
  const clientSchema = sdkSchema("connection-client");
  if (!eventSchema || !clientSchema) return; // no SDK checkout next to this one
  assert.ok(tracker.events(true).length >= 4);
  for (const event of tracker.events(true)) assert.deepEqual(check(eventSchema, event), [], JSON.stringify(event));
  for (const client of tracker.clients(() => 1, true)) assert.deepEqual(check(clientSchema, client), [], JSON.stringify(client));
});

test("nothing secret can be in the history: not what was typed in the user box when it is not an account", () => {
  const { tracker } = make({ recordAddress: true });
  // A person who typed the password in the user box leaves nothing of it.
  tracker.refused({ ...studio, user: PASSWORD }, "login_failed", false);
  tracker.login(studio, false);
  const everything = JSON.stringify([tracker.events(true), tracker.clients(() => 0, true)]);
  assert.ok(!everything.includes(PASSWORD));
  assert.ok(!/token|cookie|password|secret/i.test(everything));
});

test("the address and user agent are written only when the option is on, and shown only to an administrator", () => {
  const off = make().tracker;
  off.login(studio, false);
  assert.equal(off.events(true)[0].ip, undefined);
  assert.equal(off.clients(() => 0, true)[0].agent, undefined);

  const on = make({ recordAddress: true }).tracker;
  on.login(studio, false);
  assert.equal(on.events(true)[0].ip, "203.0.113.9");
  assert.ok(on.events(true)[0].agent);
  assert.equal(on.events(false)[0].ip, undefined);
  assert.equal(on.events(false)[0].agent, undefined);
  assert.equal(on.clients(() => 0, false)[0].ip, undefined);
  assert.equal(on.clients(() => 0, true)[0].ip, "203.0.113.9");
});

test("a refused sign-in counts as a failure and keeps the name only for a real account", () => {
  const { tracker } = make();
  tracker.refused({ ...studio, user: "root" }, "login_failed", true);
  tracker.refused({ ...studio, user: "intruder" }, "login_failed", false);
  const names = tracker.events(true).map(e => e.user);
  assert.ok(names.includes("root"));
  assert.ok(!names.includes("intruder"));
  const failed = tracker.clients(() => 0, true);
  assert.equal(failed.reduce((n, c) => n + c.logins_failed, 0), 2);
  assert.ok(failed.some(c => c.last_failure_utc));
});

test("events come newest first, can be paged with before and filtered", () => {
  const { tracker, clock } = make();
  for (let n = 0; n < 5; n++) { clock.t += 1000; tracker.login({ ...studio, user: `user${n}` }, false); }
  const all = tracker.events(true, { limit: 1000 });
  assert.ok(all.length >= 10);
  assert.ok(all.every((e, i) => i === 0 || e.id < all[i - 1].id));
  const older = tracker.events(true, { before: all[3].id, limit: 2 });
  assert.deepEqual(older.map(e => e.id), [all[4].id, all[5].id]);
  assert.equal(tracker.events(true, { action: "login" }).every(e => e.action === "login"), true);
  assert.deepEqual(tracker.events(true, { user: "USER2", action: "login" }).map(e => e.user), ["user2"]);
  assert.equal(tracker.events(true, { kind: "android" }).length, 0);
});

test("the history and the table of clients are bounded", () => {
  const { tracker } = make({ eventCapacity: 20, clientCapacity: 5 });
  for (let n = 0; n < 40; n++) tracker.login({ ...studio, user: `user${n}` }, false);
  assert.ok(tracker.events(true, { limit: 1000 }).length <= 20);
  assert.ok(tracker.clients(() => 0, true).length <= 5);
});

test("it is kept in a file, survives a restart and keeps counting event numbers", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hydra-connections-"));
  try {
    const file = path.join(dir, "data", "connections.json");
    const first = make({ file, recordAddress: true });
    first.tracker.login(studio, false);
    first.tracker.flush();
    assert.ok(!fs.readFileSync(file, "utf8").includes(PASSWORD));
    const second = make({ file, recordAddress: true, now: first.clock });
    assert.deepEqual(second.tracker.events(true), first.tracker.events(true));
    second.tracker.login(studio, false);
    const ids = second.tracker.events(true).map(e => e.id);
    assert.equal(new Set(ids).size, ids.length);
    fs.writeFileSync(file, "not json at all");
    assert.equal(make({ file }).tracker.events(true).length, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});

test("clients not seen for a long time are forgotten when it loads", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hydra-connections-"));
  try {
    const file = path.join(dir, "connections.json");
    const first = make({ file });
    first.tracker.login(studio, false);
    first.tracker.flush();
    const later = make({ file, now: { t: first.clock.t + 200 * 86_400_000 } });
    assert.equal(later.tracker.clients(() => 0, true).length, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});

test("a session that ends is told by the client it belonged to; an unknown client says nothing", () => {
  const { tracker } = make();
  const id = tracker.login(studio, false);
  tracker.endedClient(id, "session_expired");
  assert.equal(tracker.events(true)[0].action, "session_expired");
  assert.equal(tracker.events(true)[0].user, "root");
  const before = tracker.events(true).length;
  tracker.endedClient("0123456789abcdef", "logout");
  assert.equal(tracker.events(true).length, before);
});

test("the kind of a client is what it says, else what its user agent shows", () => {
  const headers = (h: Record<string, string>) => ({ header: (name: string) => h[name.toLowerCase()] });
  assert.equal(identify(headers({ "x-hydra-client": "android/0.7.4", "user-agent": "okhttp/4.12" })).kind, "android");
  assert.equal(identify(headers({ "x-hydra-client": "android/0.7.4" })).version, "0.7.4");
  // The clients that already name themselves with the bare kind (the remote-access gate reads it exactly like this).
  assert.deepEqual(identify(headers({ "x-hydra-client": "suite", "user-agent": "python-requests/2.32" })).kind, "suite");
  assert.equal(identify(headers({ "x-hydra-client": "dsi" })).version, undefined);
  assert.equal(identify(headers({ "x-hydra-client": "watch/" })).kind, "other");
  assert.equal(identify(headers({ "x-hydra-client": "admin/1.0" })).kind, "other");
  assert.equal(identify(headers({ "user-agent": "okhttp/4.12.0" })).kind, "android");
  assert.equal(identify(headers({ "user-agent": "HYDRA-UMC-WATCH/0.2.7" })).kind, "watch");
  assert.equal(identify(headers({ "user-agent": CHROME })).kind, "other");
  assert.equal(identify(headers({})).kind, "other");
});

test("the identifier does not change with the version of the browser, and tells two users apart", () => {
  assert.equal(agentFamily(CHROME), "chrome/windows");
  assert.equal(clientIdOf({ kind: "studio", user: "root", agent: CHROME }), clientIdOf({ kind: "studio", user: "ROOT", agent: CHROME.replace("130.0", "131.0") }));
  assert.notEqual(clientIdOf({ kind: "studio", user: "root", agent: CHROME }), clientIdOf({ kind: "studio", user: "ana", agent: CHROME }));
  assert.match(clientIdOf({ kind: "studio" }), /^[0-9a-f]{16}$/);
});

test("the origin is local for loopback and private addresses and remote for the rest", () => {
  for (const ip of ["127.0.0.1", "::1", "::ffff:192.168.0.5", "10.1.2.3", "172.16.0.1", "172.31.255.1", "169.254.1.1", "fd00::1", "fe80::1"]) assert.equal(originOf(ip), "local", ip);
  for (const ip of ["8.8.8.8", "172.32.0.1", "203.0.113.9", "2001:db8::1"]) assert.equal(originOf(ip), "remote", ip);
  assert.equal(originOf(undefined), undefined);
});
