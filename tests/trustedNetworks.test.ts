import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DEFAULT_LOCAL_NETWORKS, classify, inRanges, makeTrustedNetworksGate, outsideNeedsSecondFactor, outsideVerdict, parseRange, parseRanges, resolveTrustedNetworks,
} from "../src/trustedNetworks.ts";
import { SecurityConfig, resolveTrustedNetworksEnabled, type SecurityFile } from "../src/securityConfig.ts";

function makeConfig(env: any = {}, initial: SecurityFile = {}) {
  let stored: SecurityFile = { ...initial };
  const config = new SecurityConfig({ env, load: () => ({ ...stored }), save: (file) => { stored = { ...file }; }, tlsActive: false });
  return { config, stored: () => stored };
}

test("the option is off by default, so nothing about a request changes", () => {
  const { config } = makeConfig();
  assert.equal(config.trustedNetworks().enabled, false);
  assert.deepEqual(config.snapshot().trustedNetworks.enabled, { value: false, source: "default" });
  const gate = makeTrustedNetworksGate(() => config.trustedNetworks());
  let reached = 0;
  const res: any = { status() { throw new Error("must not answer"); } };
  gate({ ip: "203.0.113.9", method: "PUT", path: "/api/admin/server-config", body: {} }, res, () => { reached++; });
  assert.equal(reached, 1);
});

test("address ranges: CIDR blocks, single addresses, IPv6 and mapped IPv4", () => {
  assert.ok(parseRange("10.66.0.0/24"));
  assert.ok(parseRange("192.168.0.180"));
  assert.ok(parseRange("fd00::/8"));
  for (const bad of ["10.66.0.0/33", "10.66.0/24", "nope", "10.0.0.0/8/1", "", 7, null, "::1/129"]) assert.equal(parseRange(bad), null, String(bad));
  const list = parseRanges(["10.66.0.0/24", "bad", "fd00::/8"]);
  assert.equal(list.ranges.length, 2);
  assert.deepEqual(list.invalid, ["bad"]);
  assert.equal(inRanges("10.66.0.77", list.ranges), true);
  assert.equal(inRanges("10.66.1.77", list.ranges), false);
  assert.equal(inRanges("::ffff:10.66.0.5", list.ranges), true);
  assert.equal(inRanges("fd12:3456::1", list.ranges), true);
  assert.equal(inRanges("2001:db8::1", list.ranges), false);
  assert.equal(inRanges(undefined, list.ranges), false);
  assert.equal(inRanges("not an address", list.ranges), false);
});

test("the house is the private ranges unless the file lists others; the VPN counts as the house", () => {
  const defaults = resolveTrustedNetworks(true, undefined);
  assert.equal(defaults.local.length, DEFAULT_LOCAL_NETWORKS.length);
  for (const address of ["192.168.0.180", "10.1.2.3", "172.20.0.1", "127.0.0.1", "::1", "::ffff:192.168.1.9"]) assert.equal(classify(address, defaults), "local", address);
  for (const address of ["203.0.113.9", "8.8.8.8", "100.64.1.1", "2001:db8::5", undefined]) assert.equal(classify(address, defaults), "remote", String(address));
  const custom = resolveTrustedNetworks(true, { local: ["192.168.0.0/24"], vpn: ["100.64.0.0/10"] });
  assert.equal(classify("192.168.0.9", custom), "local");
  assert.equal(classify("192.168.5.9", custom), "remote");
  assert.equal(classify("10.1.2.3", custom), "remote");
  assert.equal(classify("100.100.1.1", custom), "local");
  // an entry that is not a range makes the trusted area smaller, never larger
  const damaged = resolveTrustedNetworks(true, { local: ["192.168.0.0/24", "garbage"] });
  assert.equal(damaged.local.length, 1);
  assert.deepEqual(damaged.invalid, ["garbage"]);
  assert.equal(classify("10.1.2.3", damaged), "remote");
});

test("the conservative defaults of the rest: operate from outside, second factor required", () => {
  const settings = resolveTrustedNetworks(true, undefined);
  assert.equal(settings.outside, "operate");
  assert.equal(settings.outsideRequiresSecondFactor, true);
  const odd = resolveTrustedNetworks(true, { outside: "everything" as any, outsideRequiresSecondFactor: "no" as any });
  assert.equal(odd.outside, "operate");
  assert.equal(odd.outsideRequiresSecondFactor, true);
  assert.equal(resolveTrustedNetworks(true, { outside: "view", outsideRequiresSecondFactor: false }).outside, "view");
});

test("from outside, administering is refused in both policies and operating only in view", () => {
  const operate = resolveTrustedNetworks(true, { outside: "operate" });
  const view = resolveTrustedNetworks(true, { outside: "view" });
  const admin: [string, string][] = [["PUT", "/api/admin/server-config"], ["GET", "/api/admin/logs"], ["POST", "/api/admin/restart"], ["POST", "/api/users"], ["GET", "/api/users"], ["POST", "/api/system/reboot"], ["POST", "/api/ecosystem/service/x/restart"], ["POST", "/api/settings"], ["POST", "/api/upload-work"], ["POST", "/api/bridges/laser/cmd/start"], ["POST", "/api/integrations/test-connection"]];
  for (const [method, path] of admin) {
    assert.deepEqual(outsideVerdict(operate, method, path), { allowed: false, reason: "admin" }, `${method} ${path}`);
    assert.deepEqual(outsideVerdict(view, method, path), { allowed: false, reason: "admin" }, `${method} ${path}`);
  }
  for (const [method, path, command] of [["POST", "/api/robot/1/command", "jog"], ["POST", "/api/robot/1/command", "reset"], ["POST", "/api/robot/1/claim", undefined], ["POST", "/api/voice/turn", undefined]] as const) {
    assert.equal(outsideVerdict(operate, method, path, command).allowed, true, `${path} ${command}`);
    assert.deepEqual(outsideVerdict(view, method, path, command), { allowed: false, reason: "view" }, `${path} ${command}`);
  }
  for (const [method, path, command] of [["GET", "/api/settings", undefined], ["GET", "/api/robot/1", undefined], ["POST", "/api/login", undefined], ["POST", "/api/refresh", undefined], ["POST", "/api/totp/confirm", undefined], ["POST", "/api/stop-all", undefined], ["POST", "/api/robot/1/command", "stop"], ["POST", "/api/robot/1/command", "disable"], ["POST", "/api/camera/ticket", undefined], ["POST", "/api/push/devices", undefined]] as const) {
    assert.equal(outsideVerdict(view, method, path, command).allowed, true, `${method} ${path} ${command}`);
  }
  assert.equal(outsideVerdict(view, "POST", "/api/stop-all/release").allowed, false);
});

test("the gate lets the house through, refuses outside with the code and records it", () => {
  const settings = resolveTrustedNetworks(true, { outside: "view", vpn: ["10.66.0.0/24"] });
  const recorded: any[] = [];
  const gate = makeTrustedNetworksGate(() => settings, { record: (entry) => { recorded.push(entry); } });
  const run = (ip: string, method: string, path: string, body: any = {}) => {
    let status = 0;
    let json: any;
    let reached = false;
    const res: any = { status(code: number) { status = code; return res; }, json(value: any) { json = value; return res; } };
    gate({ ip, method, path, body, user: { id: "u1", username: "alice" } }, res, () => { reached = true; });
    return { status, json, reached };
  };
  assert.equal(run("192.168.0.50", "PUT", "/api/admin/server-config").reached, true);
  assert.equal(run("10.66.0.4", "PUT", "/api/admin/server-config").reached, true);
  const refused = run("203.0.113.9", "PUT", "/api/admin/server-config");
  assert.equal(refused.reached, false);
  assert.equal(refused.status, 403);
  assert.equal(refused.json.code, "remote-policy");
  assert.equal(refused.json.needs, "vpn");
  assert.equal(run("203.0.113.9", "POST", "/api/robot/1/command", { command: "jog" }).status, 403);
  assert.equal(run("203.0.113.9", "POST", "/api/robot/1/command", { command: "stop" }).reached, true);
  assert.equal(run("203.0.113.9", "GET", "/api/robot/1").reached, true);
  assert.equal(recorded.length, 2);
  assert.equal(recorded[0].type, "remote-policy");
  assert.equal(recorded[0].outcome, "refused");
  assert.equal(recorded[0].ip, "203.0.113.9");
});

test("a failing audit never lets a refused request through", () => {
  const gate = makeTrustedNetworksGate(() => resolveTrustedNetworks(true, undefined), { record: () => { throw new Error("disk full"); } });
  let status = 0;
  let reached = false;
  const res: any = { status(code: number) { status = code; return res; }, json() { return res; } };
  gate({ ip: "203.0.113.9", method: "POST", path: "/api/users", body: {} }, res, () => { reached = true; });
  assert.equal(status, 403);
  assert.equal(reached, false);
});

test("signing in from outside needs the second factor turned on, from the house it does not", () => {
  const on = resolveTrustedNetworks(true, undefined);
  assert.equal(outsideNeedsSecondFactor(on, "203.0.113.9", false), true);
  assert.equal(outsideNeedsSecondFactor(on, "203.0.113.9", true), false);
  assert.equal(outsideNeedsSecondFactor(on, "192.168.0.9", false), false);
  assert.equal(outsideNeedsSecondFactor(resolveTrustedNetworks(false, undefined), "203.0.113.9", false), false);
  assert.equal(outsideNeedsSecondFactor(resolveTrustedNetworks(true, { outsideRequiresSecondFactor: false }), "203.0.113.9", false), false);
});

test("the switch: environment first, then the saved file, then off; it is read and changed like the other options", () => {
  assert.deepEqual(resolveTrustedNetworksEnabled(undefined, {}), { value: false, source: "default" });
  assert.deepEqual(resolveTrustedNetworksEnabled("1", {}), { value: true, source: "env" });
  assert.deepEqual(resolveTrustedNetworksEnabled("yes", {}), { value: false, source: "env" });
  assert.deepEqual(resolveTrustedNetworksEnabled(undefined, { trustedNetworks: { enabled: true } }), { value: true, source: "config" });
  const { config, stored } = makeConfig();
  const result = config.update({ trustedNetworks: { enabled: true } }, "root");
  assert.equal(result.snapshot.trustedNetworks.enabled.value, true);
  assert.equal(result.snapshot.trustedNetworks.outside, "operate");
  assert.equal(result.snapshot.trustedNetworks.outsideRequiresSecondFactor, true);
  assert.ok(result.warnings.includes("trusted_networks_on"));
  assert.equal(stored().trustedNetworks?.enabled, true);
  assert.equal(config.trustedNetworks().enabled, true);
  config.update({ trustedNetworks: { enabled: false } }, "root");
  assert.equal(config.trustedNetworks().enabled, false);
  assert.throws(() => config.update({ trustedNetworks: { enabled: "yes" } }, "root"), /true or false/);
  assert.throws(() => config.update({ trustedNetworks: [] }, "root"), /object/);
  const locked = makeConfig({ trustedNetworks: "1" }).config;
  assert.throws(() => locked.update({ trustedNetworks: { enabled: false } }, "root"), /HYDRA_UMC_TRUSTED_NETWORKS/);
});

test("the ranges, the policy and the damaged entries of the file are reported but not editable through the switch", () => {
  const { config, stored } = makeConfig({}, { trustedNetworks: { enabled: true, local: ["192.168.0.0/24", "oops"], vpn: ["10.66.0.0/24"], outside: "view", outsideRequiresSecondFactor: false } });
  const snap = config.snapshot().trustedNetworks;
  assert.equal(snap.localRanges, 1);
  assert.equal(snap.vpnRanges, 1);
  assert.equal(snap.invalidEntries, 1);
  assert.equal(snap.outside, "view");
  assert.equal(snap.outsideRequiresSecondFactor, false);
  config.update({ trustedNetworks: { enabled: false } }, "root");
  // changing the switch keeps what the file says about the rest
  assert.deepEqual(stored().trustedNetworks, { enabled: false, local: ["192.168.0.0/24", "oops"], vpn: ["10.66.0.0/24"], outside: "view", outsideRequiresSecondFactor: false });
});

test("sign-in over HTTP: from outside an account without the factor is turned away, one with it signs in, and the house signs in as before", async () => {
  const { default: fs } = await import("node:fs");
  const { default: os } = await import("node:os");
  const { default: path } = await import("node:path");
  const { default: express } = await import("express");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hydra-umc-trusted-"));
  const originalCwd = process.cwd();
  process.chdir(dir);
  let server: import("node:http").Server | undefined;
  try {
    const { createUser } = await import("../src/users");
    const { registerAuthRoutes } = await import("../src/routes/auth");
    const { registerTotpRoutes } = await import("../src/routes/totpRoutes");
    const { totpCode, fromBase32, stepOf } = await import("../src/totp");
    await createUser("ana", "correct-horse-battery", "operator");
    // the test client sits on the loopback: it is "outside" when the house is another range, "inside" when it is the loopback
    let settings = resolveTrustedNetworks(true, { local: ["192.0.2.0/24"] });
    const app = express();
    app.use(express.json());
    registerAuthRoutes(app, { trustedNetworks: () => settings });
    registerTotpRoutes(app);
    server = app.listen(0, "127.0.0.1");
    await new Promise((resolve) => server!.once("listening", resolve));
    const base = "http://127.0.0.1:" + (server.address() as import("node:net").AddressInfo).port;
    const call = async (method: string, url: string, body?: unknown, token?: string) => {
      const response = await fetch(base + url, { method, headers: { "content-type": "application/json", ...(token ? { authorization: "Bearer " + token } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
      return { status: response.status, body: (await response.json().catch(() => ({}))) as any };
    };
    const login = { username: "ana", password: "correct-horse-battery" };
    const outside = await call("POST", "/api/login", login);
    assert.equal(outside.status, 403);
    assert.equal(outside.body.code, "second-factor-required");
    assert.equal(outside.body.token, undefined);
    // a wrong password is still told apart from the rest: it does not reveal anything about the account
    assert.equal((await call("POST", "/api/login", { ...login, password: "wrong-password-here" })).status, 401);
    // from the house the account signs in, turns the factor on, and then signs in from outside with a code
    settings = resolveTrustedNetworks(true, { local: ["127.0.0.0/8"] });
    const house = await call("POST", "/api/login", login);
    assert.equal(house.status, 200);
    const token = house.body.token as string;
    const begun = await call("POST", "/api/totp/begin", { password: login.password }, token);
    const key = fromBase32(begun.body.secret);
    assert.equal((await call("POST", "/api/totp/confirm", { code: totpCode(key, stepOf(Date.now())) }, token)).status, 200);
    settings = resolveTrustedNetworks(true, { local: ["192.0.2.0/24"] });
    const withFactor = await call("POST", "/api/login", { ...login, totp: totpCode(key, stepOf(Date.now()) + 1) });
    assert.notEqual(withFactor.status, 403);
    // the option off: nothing is asked beyond what the account itself asked for
    settings = resolveTrustedNetworks(false, { local: ["192.0.2.0/24"] });
    assert.equal((await call("POST", "/api/login", login)).status, 401);
  } finally {
    server?.close();
    process.chdir(originalCwd);
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});
