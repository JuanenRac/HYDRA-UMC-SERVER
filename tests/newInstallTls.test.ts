import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { applyNewInstallTlsDefault, NEW_INSTALL_TLS_ENV } from "../src/newInstallTls.ts";
import type { ServerConfig } from "../src/runtime.ts";

function makeCertificates(dir: string): boolean {
  try {
    execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", path.join(dir, "server.key"), "-out", path.join(dir, "server.pem"), "-days", "2", "-subj", "/CN=hydra-test"], { stdio: "ignore", env: { ...process.env, OPENSSL_CONF: "" } });
    return true;
  } catch {
    return false;
  }
}

function setup(withCertificates: boolean) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hydra-newtls-"));
  const dataDir = path.join(root, "data");
  const tlsDir = path.join(root, "tls");
  fs.mkdirSync(tlsDir);
  const haveCertificates = withCertificates ? makeCertificates(tlsDir) : false;
  let stored: ServerConfig = {};
  const logs: string[] = [];
  const run = (env: NodeJS.ProcessEnv = {}) =>
    applyNewInstallTlsDefault({ env: { HYDRA_TLS_DIR: tlsDir, ...env }, dataDir, load: () => ({ ...stored }), save: (config) => { stored = config; }, log: (message) => logs.push(message) });
  return { root, dataDir, tlsDir, haveCertificates, run, logs, stored: () => stored };
}

test("a new installation with the certificates of its authority starts with TLS on", (context) => {
  const { run, stored, tlsDir, haveCertificates, logs } = setup(true);
  if (!haveCertificates) return context.skip("openssl is needed");
  assert.equal(run(), "enabled");
  assert.deepEqual(stored().tls, { enabled: true, certPath: path.join(tlsDir, "server.pem"), keyPath: path.join(tlsDir, "server.key") });
  assert.match(logs[0], /new installation: TLS switched on/);
});

for (const marker of ["server-config.json", "settings.json", "users.json"]) {
  test(`an installation that already has ${marker} is left as it is`, (context) => {
    const { run, stored, dataDir, haveCertificates } = setup(true);
    if (!haveCertificates) return context.skip("openssl is needed");
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(path.join(dataDir, marker), "{}");
    assert.equal(run(), "not-new");
    assert.equal(stored().tls, undefined);
  });
}

test("a saved TLS choice, even an off one, is never replaced", (context) => {
  const setupResult = setup(true);
  if (!setupResult.haveCertificates) return context.skip("openssl is needed");
  let stored: ServerConfig = { tls: { enabled: false } };
  const outcome = applyNewInstallTlsDefault({ env: { HYDRA_TLS_DIR: setupResult.tlsDir }, dataDir: setupResult.dataDir, load: () => stored, save: (config) => { stored = config; }, log: () => {} });
  assert.equal(outcome, "already-chosen");
  assert.deepEqual(stored.tls, { enabled: false });
});

test("a new installation without certificates stays on plain HTTP and says so", () => {
  const { run, stored, logs } = setup(false);
  assert.equal(run(), "no-certificates");
  assert.equal(stored().tls, undefined);
  assert.match(logs[0], /staying on plain HTTP/);
});

test("certificates that cannot be used are not switched on", () => {
  const { run, stored, tlsDir } = setup(false);
  fs.writeFileSync(path.join(tlsDir, "server.pem"), "not a certificate");
  fs.writeFileSync(path.join(tlsDir, "server.key"), "not a key");
  assert.equal(run(), "bad-certificates");
  assert.equal(stored().tls, undefined);
});

test("the deployment can forbid the default", (context) => {
  const { run, stored, haveCertificates } = setup(true);
  if (!haveCertificates) return context.skip("openssl is needed");
  assert.equal(run({ [NEW_INSTALL_TLS_ENV]: "off" }), "switched-off");
  assert.equal(stored().tls, undefined);
});
