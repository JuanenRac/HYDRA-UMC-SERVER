// =============================================================================
// HYDRA-UMC-SERVER - src/mqttStart.ts
// Copyright (C) 2026 JuanenRac (Electro Hobby 3D) <electrohobby3d@gmail.com>
// GPL-3.0-or-later - see LICENSE
// =============================================================================
// Puts the MQTT bridge together for the running server: the settings, the passwords from the environment, the
// account the commands travel with and the way a command reaches the route (a request to this same server over
// the loopback address, like the Bluetooth service does).
import http from "node:http";
import https from "node:https";
import { loopbackExecutor } from "./ble/start";
import { MqttBridge, loopbackAccount, readSecret, type MqttEnv, type MqttSettings } from "./mqttBridge";

export interface StartMqttOptions {
  settings: MqttSettings;
  env: MqttEnv;
  port: number;
  tls: boolean;
  getSettings: () => any;
  allowedCommands: ReadonlySet<string>;
  log: (message: string) => void;
  /** Replaces the client of the broker / the sign-in (the checks of the server use simulated ones). */
  connect?: ConstructorParameters<typeof MqttBridge>[0]["connect"];
  login?: (username: string, password: string) => Promise<{ status: number; body: any }>;
}

/** POST /api/login on this server over the loopback address. */
export function loopbackLogin(port: number, tls: boolean) {
  return (username: string, password: string): Promise<{ status: number; body: any }> =>
    new Promise((resolve) => {
      const body = JSON.stringify({ username, password });
      const options: https.RequestOptions = {
        host: "127.0.0.1",
        port,
        path: "/api/login",
        method: "POST",
        timeout: 8000,
        headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) },
        ...(tls ? { rejectUnauthorized: false } : {}),
      };
      const req = (tls ? https : http).request(options, (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          let parsed: any = null;
          try {
            parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          } catch {
            parsed = null;
          }
          resolve({ status: res.statusCode ?? 0, body: parsed });
        });
        res.on("error", () => resolve({ status: 0, body: null }));
      });
      req.on("timeout", () => req.destroy());
      req.on("error", () => resolve({ status: 0, body: null }));
      req.end(body);
    });
}

/** Starts the bridge when the mode is not "off". Never throws: a server without a reachable broker goes on and says why. */
export function startMqttBridge(options: StartMqttOptions): MqttBridge | null {
  const { settings } = options;
  if (settings.mode === "off") return null;
  const password = readSecret(options.env.password, options.env.passwordFile);
  let account;
  if (settings.mode === "commands") {
    const commandPassword = readSecret(options.env.commandPassword, options.env.commandPasswordFile);
    if (!settings.commandUser || !commandPassword) {
      options.log("[MQTT] commands are on but the account that carries them out is not complete (HYDRA_UMC_MQTT_COMMAND_USER and its password): the bridge starts with the state only.");
    } else {
      account = loopbackAccount(settings.commandUser, commandPassword, options.login ?? loopbackLogin(options.port, options.tls));
    }
  }
  const effective: MqttSettings = settings.mode === "commands" && !account ? { ...settings, mode: "state" } : settings;
  const bridge = new MqttBridge({
    settings: effective,
    getSettings: options.getSettings,
    allowedCommands: options.allowedCommands,
    password,
    account,
    execute: account ? loopbackExecutor(options.port, options.tls) : undefined,
    connect: options.connect,
    log: options.log,
  });
  try {
    bridge.start();
  } catch (error) {
    options.log(`[MQTT] the bridge could not start, the server goes on without it: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
  return bridge;
}
