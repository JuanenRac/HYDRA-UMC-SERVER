// =============================================================================
// HYDRA-UMC-SERVER - src/newInstallTls.ts
// Copyright (C) 2026 JuanenRac (Electro Hobby 3D) <electrohobby3d@gmail.com>
// GPL-3.0-or-later - see LICENSE
// =============================================================================
// TLS is the default of a NEW installation only. On the very first start of a server (no saved
// server configuration, no settings and no users yet) and when this installation already has the
// certificates of its own authority (the broker/server certificate made by the HYDRA-UMC-OS
// provisioning script `hydra_mqtt_tls.sh init`), the server saves "TLS on" with those paths in
// data/server-config.json, exactly as an administrator would from the Server Admin screen. From then on it
// is an ordinary saved choice: the Admin screen can switch it off, and the environment still wins.
//
// An installation that already has any of those files is never touched, and neither is one without
// the certificates (it stays on plain HTTP until an administrator turns TLS on). The deployment can
// forbid the default with HYDRA_UMC_NEW_INSTALL_TLS=off or, in a configuration seeded before the first start,
// with "install": { "newInstallTls": false } (the Server Admin screen shows and saves the same option; the
// environment wins). It is only read at the first start of an installation.
import fs from "node:fs";
import path from "node:path";
import { resolveNewInstallTls, tlsFilesProblem } from "./securityConfig";
import type { ServerConfig } from "./runtime";

export const DEFAULT_TLS_DIR = "/etc/hydra-umc/tls";
export const NEW_INSTALL_TLS_ENV = "HYDRA_UMC_NEW_INSTALL_TLS";

/** Files whose presence means that this installation has run before. */
const FIRST_RUN_MARKERS = ["server-config.json", "settings.json", "users.json"];

export interface NewInstallTlsOptions {
  env: NodeJS.ProcessEnv;
  dataDir: string;
  load: () => ServerConfig;
  save: (config: ServerConfig) => void;
  log: (message: string) => void;
}

export type NewInstallTlsOutcome = "enabled" | "not-new" | "no-certificates" | "bad-certificates" | "switched-off" | "already-chosen";

export function applyNewInstallTlsDefault(options: NewInstallTlsOptions): NewInstallTlsOutcome {
  const { env, dataDir, load, save, log } = options;
  // The environment first, then the option saved in the server configuration (Server Admin), then the default (on).
  const config = load();
  if (!resolveNewInstallTls(env[NEW_INSTALL_TLS_ENV], config).value) return "switched-off";
  if (FIRST_RUN_MARKERS.some((name) => fs.existsSync(path.join(dataDir, name)))) return "not-new";
  if (config.tls !== undefined) return "already-chosen";
  const dir = (env.HYDRA_TLS_DIR ?? "").trim() || DEFAULT_TLS_DIR;
  const certPath = path.join(dir, "server.pem");
  const keyPath = path.join(dir, "server.key");
  if (!fs.existsSync(certPath) || !fs.existsSync(keyPath)) {
    log("[TLS] new installation without the certificates of its own authority: staying on plain HTTP until an administrator turns TLS on");
    return "no-certificates";
  }
  const problem = tlsFilesProblem(certPath, keyPath);
  if (problem) {
    log(`[TLS] new installation, but the certificates in ${dir} cannot be used (${problem}): staying on plain HTTP`);
    return "bad-certificates";
  }
  save({ ...config, tls: { enabled: true, certPath, keyPath } });
  log(`[TLS] new installation: TLS switched on with the certificates in ${dir} (an administrator can switch it off in the Server Admin screen)`);
  return "enabled";
}
