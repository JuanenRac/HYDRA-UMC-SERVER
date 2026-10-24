// =============================================================================
// HYDRA-UMC-SERVER - src/ble/helperTransport.ts
// Copyright (C) 2026 JuanenRac (Electro Hobby 3D) <electrohobby3d@gmail.com>
// GPL-3.0-or-later - see LICENSE
// =============================================================================
// The GattTransport of the CM5: a child process (scripts/ble_gatt_helper.py) that owns the BlueZ side and
// speaks JSON lines on stdin and stdout. The server never links against the Bluetooth stack: when the helper
// cannot start (no BlueZ, no adapter, no python3-dbus) the server logs it and goes on without Bluetooth.
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { MAX_MTU, MIN_MTU } from "./framing";
import type { GattHandlers, GattTransport } from "./bleGateway";

export interface HelperTransportOptions {
  command: string;
  args: string[];
  log?: (message: string) => void;
  /** How long the helper may take to register with BlueZ. */
  readyTimeoutMs?: number;
  /** The wait before the helper is started again after it died by itself (0: never restart). */
  restartDelayMs?: number;
}

export class HelperTransport implements GattTransport {
  private child: ChildProcessWithoutNullStreams | null = null;
  private handlers: GattHandlers | null = null;
  private currentMtu = MIN_MTU;
  private stopping = false;
  private restartTimer: ReturnType<typeof setTimeout> | null = null;
  private subscriptions = new Set<string>();

  constructor(private options: HelperTransportOptions) {}

  mtu(): number {
    return this.currentMtu;
  }

  private log(message: string): void {
    this.options.log?.(message);
  }

  async start(handlers: GattHandlers): Promise<void> {
    this.handlers = handlers;
    this.stopping = false;
    await this.launch();
  }

  private launch(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const settle = (error?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error) reject(error);
        else resolve();
      };
      let child: ChildProcessWithoutNullStreams;
      try {
        child = spawn(this.options.command, this.options.args, { stdio: ["pipe", "pipe", "pipe"] });
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)));
        return;
      }
      this.child = child;
      const timer = setTimeout(() => {
        settle(new Error("the Bluetooth helper did not register with BlueZ in time"));
        child.kill();
      }, this.options.readyTimeoutMs ?? 15000);
      child.on("error", (error) => settle(error));
      child.stdin.on("error", () => undefined);
      let buffer = "";
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        buffer += chunk;
        if (buffer.length > 1 << 20) buffer = ""; // a runaway helper must not grow the buffer without end
        let newline: number;
        while ((newline = buffer.indexOf("\n")) !== -1) {
          const line = buffer.slice(0, newline);
          buffer = buffer.slice(newline + 1);
          this.onLine(line, settle);
        }
      });
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (text: string) => {
        for (const line of text.split("\n")) if (line.trim()) this.log(`[BLE] helper: ${line.trim()}`);
      });
      child.on("exit", (code, signal) => {
        if (this.child === child) this.child = null;
        // Every central that listened is gone with the helper.
        const handlersNow = this.handlers;
        for (const key of this.subscriptions) {
          const [link, uuid] = key.split("|");
          handlersNow?.onSubscribe(link, uuid, false);
        }
        this.subscriptions.clear();
        this.currentMtu = MIN_MTU;
        settle(new Error(`the Bluetooth helper ended before it was ready (code ${code ?? signal})`));
        if (this.stopping) return;
        this.log(`[BLE] the helper ended (code ${code ?? signal})`);
        const delay = this.options.restartDelayMs ?? 5000;
        if (delay > 0) {
          this.restartTimer = setTimeout(() => {
            this.restartTimer = null;
            this.launch().catch((error) => this.log(`[BLE] the helper could not be started again: ${error instanceof Error ? error.message : String(error)}`));
          }, delay);
          this.restartTimer.unref?.();
        }
      });
    });
  }

  private onLine(line: string, settle: (error?: Error) => void): void {
    let message: any;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    if (!message || typeof message !== "object") return;
    switch (message.event) {
      case "ready":
        settle();
        break;
      case "error":
        settle(new Error(typeof message.message === "string" ? message.message : "the Bluetooth helper reported an error"));
        this.log(`[BLE] helper error: ${String(message.message ?? "")}`);
        break;
      case "mtu":
        if (Number.isInteger(message.mtu)) this.currentMtu = Math.min(MAX_MTU, Math.max(MIN_MTU, message.mtu));
        break;
      case "write":
        if (typeof message.link === "string" && typeof message.frame === "string") {
          this.handlers?.onWrite(message.link, Buffer.from(message.frame, "base64"));
        }
        break;
      case "subscribe":
        if (typeof message.link === "string" && typeof message.uuid === "string") {
          const key = `${message.link}|${message.uuid}`;
          if (message.on === true) this.subscriptions.add(key);
          else this.subscriptions.delete(key);
          this.handlers?.onSubscribe(message.link, message.uuid, message.on === true);
        }
        break;
      default:
        break;
    }
  }

  notify(uuid: string, frame: Buffer): Promise<void> {
    const child = this.child;
    if (!child || !child.stdin.writable) return Promise.reject(new Error("the Bluetooth helper is not running"));
    const line = JSON.stringify({ op: "notify", uuid, frame: frame.toString("base64") }) + "\n";
    return new Promise<void>((resolve, reject) => {
      child.stdin.write(line, (error) => (error ? reject(error) : resolve()));
    });
  }

  async stop(): Promise<void> {
    this.stopping = true;
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.restartTimer = null;
    const child = this.child;
    if (!child) return;
    await new Promise<void>((resolve) => {
      const kill = setTimeout(() => child.kill(), 1500);
      child.once("exit", () => {
        clearTimeout(kill);
        resolve();
      });
      try {
        child.stdin.write(JSON.stringify({ op: "stop" }) + "\n");
        child.stdin.end();
      } catch {
        child.kill();
      }
    });
  }
}
