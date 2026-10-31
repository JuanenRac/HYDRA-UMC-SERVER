import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { SecurityConfig, SecurityConfigError, securityEnvFrom, type SecurityFile } from "../src/securityConfig.ts";
import { applyNewInstallTlsDefault } from "../src/newInstallTls.ts";
import { cameraSpawnSpec, setCameraCredentialsViaEnv } from "../src/serverPolicy.ts";

function makeConfig(env: any = {}, initial: SecurityFile = {}) {
  let stored: SecurityFile = { ...initial };
  const logs: string[] = [];
  const config = new SecurityConfig({ env, load: () => ({ ...stored }), save: (file) => { stored = { ...file }; }, tlsActive: false, log: (m) => logs.push(m) });
  return { config, logs, stored: () => stored };
}

test("both options start on the conservative side", () => {
  const { config } = makeConfig();
  assert.equal(config.cameraCredentialsViaEnv(), true);
  const snapshot = config.snapshot();
  assert.deepEqual(snapshot.camera.credentialsViaEnv, { value: true, source: "default" });
  assert.deepEqual(snapshot.install.newInstallTls, { value: true, source: "default" });
  assert.deepEqual(snapshot.camera.open, { value: false, source: "default" });
});

test("the environment words keep their meaning: only off loosens", () => {
  assert.equal(makeConfig({ cameraCredentialsViaEnv: "off" }).config.cameraCredentialsViaEnv(), false);
  assert.equal(makeConfig({ cameraCredentialsViaEnv: " OFF " }).config.cameraCredentialsViaEnv(), false);
  for (const word of ["on", "0", "no", "false", "x"]) assert.equal(makeConfig({ cameraCredentialsViaEnv: word }).config.cameraCredentialsViaEnv(), true, word);
  assert.equal(makeConfig({ newInstallTls: "off" }).config.snapshot().install.newInstallTls.value, false);
  for (const word of ["on", "0", "no", "x"]) assert.equal(makeConfig({ newInstallTls: word }).config.snapshot().install.newInstallTls.value, true, word);
  const env = securityEnvFrom({ HYDRA_UMC_CAMERA_CREDENTIALS_VIA_ENV: "off", HYDRA_UMC_NEW_INSTALL_TLS: "off" });
  assert.deepEqual([env.cameraCredentialsViaEnv, env.newInstallTls], ["off", "off"]);
});

test("an administrator can loosen each option: it is saved, warned about and logged; closing it again warns of nothing", () => {
  const { config, logs, stored } = makeConfig();
  assert.deepEqual(config.update({ camera: { credentialsViaEnv: false } }, "root").warnings, ["camera_credentials_in_arguments"]);
  assert.equal(config.cameraCredentialsViaEnv(), false);
  assert.match(logs.at(-1)!, /command line/);
  assert.deepEqual(config.update({ install: { newInstallTls: false } }, "root").warnings, ["new_install_tls_off"]);
  assert.match(logs.at(-1)!, /forbade a new installation/);
  assert.deepEqual(stored().camera, { credentialsViaEnv: false });
  assert.deepEqual(stored().install, { newInstallTls: false });
  assert.deepEqual(config.update({ camera: { credentialsViaEnv: true } }, "root").warnings, []);
  assert.deepEqual(config.update({ install: { newInstallTls: true } }, "root").warnings, []);
  assert.equal(config.cameraCredentialsViaEnv(), true);
  // the other camera option is untouched by a patch of this one
  assert.deepEqual(makeConfig({}, { camera: { open: true } }).config.update({ camera: { credentialsViaEnv: false } }, "root").snapshot.camera.open, { value: true, source: "config" });
});

test("the options refuse a value that is not true or false, a patch that is not an object, and a value fixed by the environment", () => {
  const { config } = makeConfig();
  const bad400 = (e: unknown) => e instanceof SecurityConfigError && e.status === 400;
  for (const value of ["off", 0, null]) {
    assert.throws(() => config.update({ camera: { credentialsViaEnv: value } }, "root"), bad400);
    assert.throws(() => config.update({ install: { newInstallTls: value } }, "root"), bad400);
  }
  for (const group of ["install"]) {
    assert.throws(() => config.update({ [group]: "x" }, "root"), bad400, group);
    assert.throws(() => config.update({ [group]: [] }, "root"), bad400, group);
  }
  const locked = (e: unknown) => e instanceof SecurityConfigError && e.status === 409;
  const fixed = makeConfig({ cameraCredentialsViaEnv: "on", newInstallTls: "on" });
  assert.throws(() => fixed.config.update({ camera: { credentialsViaEnv: false } }, "root"), locked);
  assert.throws(() => fixed.config.update({ install: { newInstallTls: false } }, "root"), locked);
  assert.equal(fixed.config.cameraCredentialsViaEnv(), true);
});

test("a saved value is read on the next start, and the environment wins over it", () => {
  const saved: SecurityFile = { camera: { credentialsViaEnv: false }, install: { newInstallTls: false } };
  const fromFile = makeConfig({}, saved).config;
  assert.equal(fromFile.cameraCredentialsViaEnv(), false);
  assert.equal(fromFile.snapshot().install.newInstallTls.source, "config");
  const overruled = makeConfig({ cameraCredentialsViaEnv: "on", newInstallTls: "on" }, saved).config;
  assert.equal(overruled.cameraCredentialsViaEnv(), true);
  assert.deepEqual(overruled.snapshot().install.newInstallTls, { value: true, source: "env" });
});

test("the camera process gets its password the way the option says, on the next start of a camera", () => {
  const url = "rtsp://user:secret@192.168.0.50:554/stream";
  try {
    assert.ok(cameraSpawnSpec(url, 8100).args.includes("--device-env"));
    setCameraCredentialsViaEnv(() => false);
    const loose = cameraSpawnSpec(url, 8100);
    assert.deepEqual(loose.extraEnv, {});
    assert.ok(loose.args.includes(url));
    // an explicit value still wins over the configured source
    assert.ok(cameraSpawnSpec(url, 8100, true).args.includes("--device-env"));
    assert.ok(cameraSpawnSpec(url, 8100, "off").args.includes(url));
    setCameraCredentialsViaEnv(() => true);
    assert.ok(cameraSpawnSpec(url, 8100).args.includes("--device-env"));
    assert.deepEqual(cameraSpawnSpec("/dev/video0", 8101).extraEnv, {});
  } finally {
    setCameraCredentialsViaEnv(() => true);
  }
});

test("a new installation honours the saved option of the configuration and the environment wins", () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "hydra-install-"));
  try {
    const run = (env: Record<string, string>, config: any) => {
      let saved: any;
      const outcome = applyNewInstallTlsDefault({ env, dataDir, load: () => config, save: (c) => { saved = c; }, log: () => {} });
      return { outcome, saved };
    };
    assert.equal(run({}, { install: { newInstallTls: false } }).outcome, "switched-off");
    assert.equal(run({}, { install: { newInstallTls: false } }).saved, undefined);
    // the environment on beats a saved "no": the next outcome is the ordinary one (no certificates here)
    assert.equal(run({ HYDRA_UMC_NEW_INSTALL_TLS: "on", HYDRA_TLS_DIR: path.join(dataDir, "none") }, { install: { newInstallTls: false } }).outcome, "no-certificates");
    assert.equal(run({ HYDRA_UMC_NEW_INSTALL_TLS: "off" }, {}).outcome, "switched-off");
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
