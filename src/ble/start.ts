// =============================================================================
// HYDRA-UMC-SERVER - src/ble/start.ts
// Copyright (C) 2026 JuanenRac (Electro Hobby 3D) <electrohobby3d@gmail.com>
// GPL-3.0-or-later - see LICENSE
// =============================================================================
// Puts the Bluetooth LE service together for the running server: the gateway, the BlueZ helper and the
// way a command reaches the route (a request to this same server over the loopback address, so a command
// from a phone is judged by exactly the rules of a command from the network).
import http from "node:http";
import https from "node:https";
import path from "node:path";
import { BleGateway, type BleCommandRequest, type BleExecuteResult, type BleMode, type GattTransport } from "./bleGateway";
import { HelperTransport } from "./helperTransport";
import type { BleFile } from "../securityConfig";

export interface StartBleOptions {
  mode: BleMode;
  requireEncryption: boolean;
  file: BleFile;
  port: number;
  tls: boolean;
  getState: () => unknown;
  allowedCommands: ReadonlySet<string>;
  log: (message: string) => void;
  /** Replaces the BlueZ helper (the checks of the server use a simulated one). */
  transport?: GattTransport;
  /** Replaces the request to the route of the command. */
  execute?: (request: BleCommandRequest) => Promise<BleExecuteResult>;
}

/** POST /api/robot/:id/command on this server, over the loopback address, with the token the phone presented. */
export function loopbackExecutor(port: number, tls: boolean): (request: BleCommandRequest) => Promise<BleExecuteResult> {
  return (request) =>
    new Promise<BleExecuteResult>((resolve) => {
      const body = JSON.stringify({ command: request.command, params: request.params, ...(request.controllerId ? { controllerId: request.controllerId } : {}) });
      const options: https.RequestOptions = {
        host: "127.0.0.1",
        port,
        path: `/api/robot/${request.robotId}/command`,
        method: "POST",
        timeout: 8000,
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body),
          Authorization: `Bearer ${request.token}`,
        },
        // The certificate of this very server is checked by the phones that use it; on the loopback address
        // of the same machine its name never matches.
        ...(tls ? { rejectUnauthorized: false } : {}),
      };
      const req = (tls ? https : http).request(options, (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        res.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size <= 1 << 20) chunks.push(chunk);
        });
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

export function helperTransportFor(options: Pick<StartBleOptions, "file" | "requireEncryption" | "log">): HelperTransport {
  const script = process.env.HYDRA_UMC_BLE_HELPER || path.join(process.cwd(), "scripts", "ble_gatt_helper.py");
  const args = [script, "--name", options.file.name?.trim() || "HYDRA-UMC"];
  if (options.file.adapter) args.push("--adapter", options.file.adapter);
  if (options.requireEncryption) args.push("--require-encryption");
  return new HelperTransport({ command: options.file.helperCommand?.trim() || "python3", args, log: options.log });
}

const clampNumber = (value: unknown, fallback: number, min: number, max: number): number =>
  typeof value === "number" && Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback;

/**
 * Starts the Bluetooth LE service when the mode is not "off". It never throws: a server without BlueZ goes
 * on without Bluetooth and says why in the log.
 */
export async function startBle(options: StartBleOptions): Promise<BleGateway | null> {
  if (options.mode === "off") return null;
  const gateway = new BleGateway({
    mode: options.mode,
    transport: options.transport ?? helperTransportFor(options),
    getState: options.getState,
    execute: options.execute ?? loopbackExecutor(options.port, options.tls),
    allowedCommands: options.allowedCommands,
    log: options.log,
    minStateIntervalMs: clampNumber(options.file.minStateIntervalMs, 500, 50, 60000),
    frameDelayMs: clampNumber(options.file.frameDelayMs, 8, 0, 1000),
    commandsPerSecond: clampNumber(options.file.commandsPerSecond, 10, 1, 100),
  });
  try {
    await gateway.start();
  } catch (error) {
    options.log(`[BLE] Bluetooth is not available, the server goes on without it: ${error instanceof Error ? error.message : String(error)}`);
    await gateway.stop().catch(() => undefined);
    return null;
  }
  options.log(`[BLE] Bluetooth LE service started: ${options.mode === "commands" ? "state and commands" : "state only"}${options.requireEncryption ? ", encrypted link required" : ", NO link encryption required"}`);
  return gateway;
}
