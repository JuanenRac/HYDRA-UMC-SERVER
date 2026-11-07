import assert from "node:assert/strict";
import { test } from "node:test";
import { advertisedAddresses } from "../src/advertisedAddresses.ts";
import {
  UPDATE_DEFAULT_CACHE_MINUTES, UPDATE_DEFAULT_OWNER, UpdateChecker, compareVersions, parseVersion, stateOf, updateCacheMinutes, updateOwner,
  type FetchLike, type UpdateCheckSettings,
} from "../src/updateCheck.ts";
import { SecurityConfig, SecurityConfigError, resolveAdvertiseAddress, resolveUpdateCheck, type SecurityFile } from "../src/securityConfig.ts";

const project = (name: string, version: string | null, family: string | null = "HYDRA-UMC") => ({ name, version, family }) as any;

test("versions of two to six numbers are compared as numbers, with a missing component counting as zero", () => {
  assert.deepEqual(parseVersion("v0.8.2.6"), [0, 8, 2, 6]);
  assert.deepEqual(parseVersion("1.2.3-rc1"), [1, 2, 3]);
  for (const bad of ["", "latest", "v", "1..2", null, undefined, "1.2.3.4.5.6.7"]) assert.equal(parseVersion(bad as any), null, String(bad));
  assert.equal(compareVersions("0.8.2.6", "0.8.2.10"), -1);
  assert.equal(compareVersions("0.9", "0.8.9.9"), 1);
  assert.equal(compareVersions("1.2", "1.2.0"), 0);
  assert.equal(compareVersions("1.2", "x"), null);
  assert.equal(stateOf("0.5.8", "0.5.9"), "behind");
  assert.equal(stateOf("0.5.9", "0.5.9"), "current");
  assert.equal(stateOf("0.6.0", "0.5.9"), "ahead");
  assert.equal(stateOf(null, "0.5.9"), "unknown");
  assert.equal(stateOf("0.5.9", null), "unknown");
});

test("the owner and the time a look is kept come from the file within their limits", () => {
  assert.equal(updateOwner(undefined), UPDATE_DEFAULT_OWNER);
  assert.equal(updateOwner({ owner: "SomeOne-1" }), "SomeOne-1");
  for (const bad of ["../x", "a/b", "", "-no", "no-", 7, "x".repeat(40)]) assert.equal(updateOwner({ owner: bad }), UPDATE_DEFAULT_OWNER, String(bad));
  assert.equal(updateCacheMinutes(undefined), UPDATE_DEFAULT_CACHE_MINUTES);
  assert.equal(updateCacheMinutes({ cacheMinutes: 1 }), 10);
  assert.equal(updateCacheMinutes({ cacheMinutes: 1e9 }), 10080);
  assert.equal(updateCacheMinutes({ cacheMinutes: 60 }), 60);
  assert.equal(updateCacheMinutes({ cacheMinutes: "no" }), UPDATE_DEFAULT_CACHE_MINUTES);
});

function checker(answers: Record<string, { status: number; tag?: string } | "throw">, settings: UpdateCheckSettings | undefined = undefined) {
  const clock = { now: 1_800_000_000_000 };
  const asked: string[] = [];
  const fetchLike: FetchLike = async (url) => {
    asked.push(url);
    const name = url.split("/")[5];
    const answer = answers[name] ?? { status: 404 };
    if (answer === "throw") throw new Error("offline");
    return { status: answer.status, ok: answer.status >= 200 && answer.status < 300, json: async () => ({ tag_name: answer.tag }) };
  };
  const projects = [project("B-PROGRAM", "0.2.0"), project("A-PROGRAM", "1.0.0"), project("C-PROGRAM", "0.1.0"), project("D PROGRAM WITH SPACES", "1.0.0"), project("E-PROGRAM", null)];
  const instance = new UpdateChecker({ fetch: fetchLike, now: () => clock.now, projects: async () => projects, settings: () => settings });
  return { instance, clock, asked };
}

test("the report sets the installed version against the newest release, sorted by name, and skips names that are not repository names", async () => {
  const { instance, asked } = checker({ "A-PROGRAM": { status: 200, tag: "v1.0.0" }, "B-PROGRAM": { status: 200, tag: "v0.3.0" }, "C-PROGRAM": { status: 404 }, "E-PROGRAM": { status: 200, tag: "v2.0.0" } });
  const report = await instance.report();
  assert.equal(report.owner, "JuanenRac");
  assert.equal(report.rateLimited, false);
  assert.deepEqual(report.items.map((i) => [i.name, i.installed, i.latest, i.state]), [
    ["A-PROGRAM", "1.0.0", "1.0.0", "current"],
    ["B-PROGRAM", "0.2.0", "0.3.0", "behind"],
    ["C-PROGRAM", "0.1.0", null, "unknown"],
    ["E-PROGRAM", null, "2.0.0", "unknown"],
  ]);
  assert.equal(asked.length, 4, "the name with spaces was not asked");
  assert.ok(asked.every((url) => url.startsWith("https://api.github.com/repos/JuanenRac/") && url.endsWith("/releases/latest")));
});

test("an answer is kept for the configured time, a forced look still waits the minimum, and a new owner is a new look", async () => {
  const { instance, clock, asked } = checker({ "A-PROGRAM": { status: 200, tag: "1.0.0" } }, { cacheMinutes: 60 });
  await instance.report();
  const first = asked.length;
  await instance.report();
  assert.equal(asked.length, first, "kept");
  clock.now += 5 * 60_000;
  await instance.report(true);
  assert.equal(asked.length, first, "a forced look before ten minutes returns the kept answer");
  clock.now += 6 * 60_000;
  await instance.report(true);
  assert.equal(asked.length, first * 2, "forced after ten minutes");
  clock.now += 61 * 60_000;
  await instance.report();
  assert.equal(asked.length, first * 3, "expired");
});

test("two looks at once ask GitHub once", async () => {
  const { instance, asked } = checker({});
  await Promise.all([instance.report(), instance.report()]);
  assert.equal(asked.length, 4);
});

test("a refusal for quota stops the look and says so; a program that fails is simply without a newest version", async () => {
  const limited = checker({ "B-PROGRAM": { status: 200, tag: "0.3.0" }, "A-PROGRAM": { status: 403 }, "C-PROGRAM": { status: 200, tag: "9.9.9" } });
  const report = await limited.instance.report();
  assert.equal(report.rateLimited, true);
  assert.equal(limited.asked.length, 2, "nothing is asked after the refusal");
  assert.deepEqual(report.items.map((i) => i.latest), [null, "0.3.0", null, null], "the program asked before the refusal keeps its answer");
  const offline = checker({ "A-PROGRAM": "throw", "B-PROGRAM": { status: 200, tag: "not a version" } });
  const reportOffline = await offline.instance.report();
  assert.equal(reportOffline.rateLimited, false);
  assert.ok(reportOffline.items.every((i) => i.latest === null));
});

// ---- the addresses --------------------------------------------------------------------------------------------------------------------------

const iface = (address: string, family: "IPv4" | "IPv6", internal = false) => ({ address, family, internal, netmask: "", mac: "", cidr: null }) as any;

test("the advertised addresses are the external IPv4 ones with the scheme and the port, sorted, without loopback, link-local or IPv6", () => {
  const interfaces = {
    lo: [iface("127.0.0.1", "IPv4", true)],
    eth0: [iface("192.168.0.180", "IPv4"), iface("fe80::1", "IPv6"), iface("169.254.3.4", "IPv4")],
    wlan0: [iface("10.0.0.7", "IPv4"), iface("192.168.0.180", "IPv4")],
    empty: undefined,
  };
  assert.deepEqual(advertisedAddresses({ port: 3000, tls: false, interfaces }), ["http://10.0.0.7:3000", "http://192.168.0.180:3000"]);
  assert.deepEqual(advertisedAddresses({ port: 3443, tls: true, interfaces, limit: 1 }), ["https://10.0.0.7:3443"]);
  assert.deepEqual(advertisedAddresses({ port: 3000, tls: false, interfaces: { lo: [iface("127.0.0.1", "IPv4", true)] } }), []);
});

// ---- the switches ---------------------------------------------------------------------------------------------------------------------------

function makeConfig(env: any = {}, initial: SecurityFile = {}) {
  let stored: SecurityFile = { ...initial };
  const logs: string[] = [];
  const config = new SecurityConfig({ env, load: () => ({ ...stored }), save: (file) => { stored = { ...file }; }, tlsActive: false, log: (m) => logs.push(m) });
  return { config, logs, stored: () => stored };
}
const bad400 = (e: unknown) => e instanceof SecurityConfigError && e.status === 400;

test("the look at the newest versions and the addresses in hydra-info are off by default and only the exact word 1 turns them on from the environment", () => {
  const { config } = makeConfig();
  assert.equal(config.updateCheckEnabled(), false);
  assert.equal(config.advertiseAddressEnabled(), false);
  assert.deepEqual(config.snapshot().updateCheck.enabled, { value: false, source: "default" });
  assert.deepEqual(config.snapshot().discovery.advertiseAddress, { value: false, source: "default" });
  assert.equal(makeConfig({ updateCheck: "1" }).config.updateCheckEnabled(), true);
  assert.equal(makeConfig({ advertiseAddress: "1" }).config.advertiseAddressEnabled(), true);
  for (const word of ["true", "yes", "on", "0", ""]) {
    assert.equal(makeConfig({ updateCheck: word }).config.updateCheckEnabled(), false, word);
    assert.equal(makeConfig({ advertiseAddress: word }).config.advertiseAddressEnabled(), false, word);
  }
  assert.deepEqual(resolveUpdateCheck(undefined, { updateCheck: { enabled: true } }), { value: true, source: "config" });
  assert.deepEqual(resolveAdvertiseAddress(undefined, { discovery: { advertiseAddress: true } }), { value: true, source: "config" });
});

test("an administrator turns each switch on and off, it is logged and warned, the file values are kept and the environment locks the switch", () => {
  const { config, logs, stored } = makeConfig({}, { updateCheck: { owner: "SomeOne", cacheMinutes: 30 } });
  const on = config.update({ updateCheck: { enabled: true }, discovery: { advertiseAddress: true } }, "root");
  assert.ok(on.warnings.includes("update_check_on"));
  assert.ok(on.warnings.includes("discovery_address_on"));
  assert.equal(config.updateCheckEnabled(), true);
  assert.equal(config.advertiseAddressEnabled(), true);
  assert.deepEqual(stored().updateCheck, { enabled: true, owner: "SomeOne", cacheMinutes: 30 });
  assert.deepEqual(stored().discovery, { advertiseAddress: true });
  assert.ok(logs.some((line) => line.includes("newest published versions")));
  assert.ok(logs.some((line) => line.includes("hydra-info")));
  const off = config.update({ updateCheck: { enabled: false }, discovery: { advertiseAddress: false } }, "root");
  assert.deepEqual(off.warnings, []);
  assert.equal(config.updateCheckEnabled(), false);
  assert.equal(config.advertiseAddressEnabled(), false);
  for (const value of ["yes", 1, null]) {
    assert.throws(() => config.update({ updateCheck: { enabled: value } }, "root"), bad400);
    assert.throws(() => config.update({ discovery: { advertiseAddress: value } }, "root"), bad400);
  }
  assert.throws(() => config.update({ updateCheck: [] }, "root"), bad400);
  assert.throws(() => config.update({ discovery: [] }, "root"), bad400);
  assert.throws(() => makeConfig({ updateCheck: "1" }).config.update({ updateCheck: { enabled: false } }, "root"), (e: unknown) => e instanceof SecurityConfigError && e.status === 409 && /UPDATE_CHECK/.test(e.message));
  assert.throws(() => makeConfig({ advertiseAddress: "0" }).config.update({ discovery: { advertiseAddress: true } }, "root"), (e: unknown) => e instanceof SecurityConfigError && e.status === 409 && /ADVERTISE_ADDRESS/.test(e.message));
});
