import assert from "node:assert/strict";
import { test } from "node:test";
import { SecurityConfig, SecurityConfigError, securityEnvFrom, type SecurityFile } from "../src/securityConfig.ts";
import { SERVICES_THAT_ACCEPT_IDENTITY, buildServiceIdentityStatus, shortServiceName } from "../src/serviceIdentity.ts";

// auth.serviceIdentity.enabled: the switch that makes the server present its token on its calls to the services.

function makeConfig(env: any = {}, initial: SecurityFile = {}) {
  let stored: SecurityFile = { ...initial };
  const logs: string[] = [];
  const config = new SecurityConfig({ env, load: () => ({ ...stored }), save: (file) => { stored = { ...file }; }, tlsActive: false, log: (m) => logs.push(m) });
  return { config, logs, stored: () => stored };
}
const status = (e: unknown, code: number) => e instanceof SecurityConfigError && e.status === code;

test("it starts off, with the default as its source", () => {
  const { config } = makeConfig();
  assert.deepEqual(config.snapshot().auth.serviceIdentity.enabled, { value: false, source: "default" });
  assert.equal(config.serviceIdentityEnabled(), false);
});

test("the environment decides and locks it: 1 on, 0 off, any other word says nothing", () => {
  assert.deepEqual(makeConfig(securityEnvFrom({ HYDRA_UMC_SERVICE_IDENTITY: "1" } as any)).config.snapshot().auth.serviceIdentity.enabled, { value: true, source: "env" });
  assert.deepEqual(makeConfig(securityEnvFrom({ HYDRA_UMC_SERVICE_IDENTITY: "0" } as any), { auth: { serviceIdentity: { enabled: true } } }).config.snapshot().auth.serviceIdentity.enabled, { value: false, source: "env" });
  assert.deepEqual(makeConfig(securityEnvFrom({ HYDRA_UMC_SERVICE_IDENTITY: "yes" } as any)).config.snapshot().auth.serviceIdentity.enabled, { value: false, source: "default" });
  const { config } = makeConfig(securityEnvFrom({ HYDRA_UMC_SERVICE_IDENTITY: "0" } as any));
  assert.throws(() => config.update({ auth: { serviceIdentity: { enabled: true, confirm: true } } }, "root"), (e) => status(e, 409));
});

test("turning it on needs a confirmation, is saved, warned about and logged; turning it off warns the other way", () => {
  const { config, logs, stored } = makeConfig();
  assert.throws(() => config.update({ auth: { serviceIdentity: { enabled: true } } }, "root"), (e) => status(e, 400) && /confirm: true/.test((e as Error).message));
  assert.throws(() => config.update({ auth: { serviceIdentity: { enabled: true, confirm: false } } }, "root"), (e) => status(e, 400));
  assert.equal(config.serviceIdentityEnabled(), false);
  const on = config.update({ auth: { serviceIdentity: { enabled: true, confirm: true } } }, "root");
  assert.deepEqual(on.warnings, ["service_identity_on"]);
  assert.equal(config.serviceIdentityEnabled(), true);
  assert.deepEqual(stored().auth?.serviceIdentity, { enabled: true });
  assert.match(logs.join("\n"), /root turned the identity of this server in its calls to the services ON/);
  const off = config.update({ auth: { serviceIdentity: { enabled: false } } }, "root");
  assert.deepEqual(off.warnings, ["service_identity_off"]);
  assert.equal(config.serviceIdentityEnabled(), false);
  assert.match(logs.join("\n"), /services ?.*off/);
});

test("the shape is checked and the other sign-in options are left as they were", () => {
  const { config } = makeConfig();
  for (const bad of [true, "on", [], { enabled: "yes" }, { confirm: true }, { enabled: true, confirm: true, extra: 1 }, { enabled: false, confirm: "y" }]) {
    assert.throws(() => config.update({ auth: { serviceIdentity: bad } } as any, "root"), (e) => status(e, 400), JSON.stringify(bad));
  }
  config.update({ auth: { acceptHs256: false } }, "root");
  config.update({ auth: { serviceIdentity: { enabled: true, confirm: true } } }, "root");
  assert.equal(config.snapshot().auth.acceptHs256.value, false);
  assert.equal(config.snapshot().auth.serviceIdentity.enabled.value, true);
});

test("the status lists who takes the identity, who does not yet", () => {
  const s = buildServiceIdentityStatus({ enabled: true, source: "config", keyUsable: true, registryNames: ["HYDRA-UMC-SERVER", "HYDRA-UMC-DATALAKE", "HYDRA-UMC-VOICE-UI", "HYDRA-UMC-GATEWAY-INDUSTRIAL"] });
  assert.equal(s.state, "presenting");
  assert.equal(s.locked, false);
  const by = Object.fromEntries(s.services.map((x) => [x.name, x.support]));
  assert.equal(by["datalake"], "accepts");
  assert.equal(by["connector-hub"], "accepts");
  assert.equal(by["voice-ui"], "not_yet");
  assert.equal(by["gateway-industrial"], "not_yet");
  assert.equal(by["server"], undefined);
  for (const name of SERVICES_THAT_ACCEPT_IDENTITY) assert.equal(by[name], "accepts", name);
  assert.deepEqual(s.order.slice(0, 2), ["server_first", "then_one_by_one"]);
  assert.equal(buildServiceIdentityStatus({ enabled: true, source: "env", keyUsable: false }).state, "idle_no_key");
  assert.equal(buildServiceIdentityStatus({ enabled: false, source: "env", keyUsable: true }).state, "off");
  assert.equal(buildServiceIdentityStatus({ enabled: false, source: "env", keyUsable: true }).locked, true);
  assert.equal(shortServiceName("HYDRA-UMC-JOB-DISPATCHER"), "job-dispatcher");
});
