// =============================================================================
// HYDRA-UMC-SERVER - src/ble/bleGateway.ts
// Copyright (C) 2026 JuanenRac (Electro Hobby 3D) <electrohobby3d@gmail.com>
// GPL-3.0-or-later - see LICENSE
// =============================================================================
// The Bluetooth LE side of the server, without any radio: what a phone sends to the COMMAND characteristic,
// what the server answers on the ACK characteristic and what it notifies on the STATE characteristic
// (docs/BLE_GATT.md). The radio itself is a GattTransport (BlueZ on the CM5, a simulated central in the tests).
//
// A command that arrives over BLE gets no privilege of its own: it carries the access token of the account
// that sends it and is handed to `execute`, which presents it to the same route a Wi-Fi client uses
// (POST /api/robot/:id/command) with the same authorization, reservation and safety-limit rules. The answer
// of that route becomes the ACK. A command is never acknowledged before the route has answered, so a STOP
// that nobody confirmed never looks confirmed.
import { MAX_MESSAGE_BYTES, MessageTooLarge, Reassembler, splitMessage } from "./framing";

export const SERVICE_UUID = "48594452-0001-4000-8000-554d43000001";
export const STATE_UUID = "48594452-0002-4000-8000-554d43000001";
export const COMMAND_UUID = "48594452-0003-4000-8000-554d43000001";
export const ACK_UUID = "48594452-0004-4000-8000-554d43000001";

export type BleMode = "off" | "state" | "commands";

export interface BleCommandRequest {
  id: string;
  robotId: number;
  command: string;
  params: Record<string, unknown>;
  controllerId?: string;
  token: string;
}

export interface BleExecuteResult {
  /** The HTTP status the command route answered (0: it could not be reached). */
  status: number;
  body: any;
}

export interface BleAck {
  id: string | null;
  ok: boolean;
  status: number;
  code: string;
  error?: string;
}

export interface GattHandlers {
  /** One frame written to the COMMAND characteristic by the central `link`. */
  onWrite(link: string, frame: Buffer): void;
  /** A central switched notifications of a characteristic on or off (a link that drops is reported as off). */
  onSubscribe(link: string, uuid: string, subscribed: boolean): void;
}

export interface GattTransport {
  start(handlers: GattHandlers): Promise<void>;
  /** Notifies one frame to every central subscribed to the characteristic. */
  notify(uuid: string, frame: Buffer): Promise<void> | void;
  /** The MTU the notifications are cut for: the smallest among the links that listen (the default one when unknown). */
  mtu(): number;
  stop(): Promise<void>;
}

export interface BleGatewayOptions {
  mode: BleMode;
  transport: GattTransport;
  /** The state tree as it is sent to an operator (without the credentials of the cameras). */
  getState: () => unknown;
  /** Hands a command to the route of the server; never rejects (a failure is a status of 0). */
  execute: (request: BleCommandRequest) => Promise<BleExecuteResult>;
  log?: (message: string) => void;
  /** The commands a phone may send (anything else is refused before it reaches the route). */
  allowedCommands: ReadonlySet<string>;
  /** Pace of the notifications. */
  minStateIntervalMs?: number;
  frameDelayMs?: number;
  /** The commands one link may send per second (STOP is never limited). */
  commandsPerSecond?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

const MAX_TOKEN_CHARS = 4096;
const MAX_PARAMS_BYTES = 4096;
const MAX_ID_CHARS = 64;

const STATUS_CODES: Record<number, string> = {
  0: "unreachable",
  400: "rejected",
  401: "session-expired",
  403: "forbidden",
  404: "not-found",
  409: "claimed",
  412: "revision-changed",
  429: "rate-limited",
};

export function ackCodeFor(status: number, body: any): string {
  if (status >= 200 && status < 300) return "ok";
  if (body && typeof body.code === "string" && body.code.length <= 64) return body.code;
  if (status >= 500) return "server-error";
  return STATUS_CODES[status] ?? "rejected";
}

/** The fields of a robot that survive when the whole tree does not fit one message. */
const SLIM_ROBOT_FIELDS = ["id", "name", "model", "joints", "pos", "position", "playbackState", "valves", "pumps", "reservation", "heatedBed", "speed"];

export function slimState(tree: any): unknown {
  const controllers = Array.isArray(tree?.controllers) ? tree.controllers : [];
  return {
    truncated: true,
    controllers: controllers.map((controller: any) => ({
      id: controller?.id,
      name: controller?.name,
      robots: (Array.isArray(controller?.robots) ? controller.robots : []).map((robot: any) => {
        const out: Record<string, unknown> = {};
        for (const field of SLIM_ROBOT_FIELDS) if (robot && robot[field] !== undefined) out[field] = robot[field];
        return out;
      }),
    })),
  };
}

/** The bytes of the state message: the whole tree when it fits, otherwise the slim form. */
export function encodeState(tree: unknown): Buffer {
  const whole = Buffer.from(JSON.stringify(tree ?? {}), "utf8");
  if (whole.length <= MAX_MESSAGE_BYTES) return whole;
  return Buffer.from(JSON.stringify(slimState(tree)), "utf8");
}

interface Link {
  reassembler: Reassembler;
  bucket: number;
  bucketAt: number;
}

type Outgoing = { uuid: string; message: Buffer };

export class BleGateway {
  private links = new Map<string, Link>();
  private stateSubscribers = new Set<string>();
  private ackSubscribers = new Set<string>();
  private queue: Outgoing[] = [];
  private pendingState = false;
  private draining = false;
  private lastStateAt = 0;
  private stateTimer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;
  private readonly minStateIntervalMs: number;
  private readonly frameDelayMs: number;
  private readonly commandsPerSecond: number;

  constructor(private options: BleGatewayOptions) {
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.now = options.now ?? Date.now;
    this.minStateIntervalMs = options.minStateIntervalMs ?? 500;
    this.frameDelayMs = options.frameDelayMs ?? 8;
    this.commandsPerSecond = options.commandsPerSecond ?? 10;
  }

  get mode(): BleMode {
    return this.options.mode;
  }

  async start(): Promise<void> {
    if (this.options.mode === "off") return;
    await this.options.transport.start({
      onWrite: (link, frame) => this.onWrite(link, frame),
      onSubscribe: (link, uuid, subscribed) => this.onSubscribe(link, uuid, subscribed),
    });
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.stateTimer) clearTimeout(this.stateTimer);
    this.stateTimer = null;
    await this.options.transport.stop();
  }

  private log(message: string): void {
    this.options.log?.(`[BLE] ${message}`);
  }

  private linkFor(id: string): Link {
    let link = this.links.get(id);
    if (!link) {
      link = { reassembler: new Reassembler(), bucket: this.commandsPerSecond * 2, bucketAt: this.now() };
      this.links.set(id, link);
    }
    return link;
  }

  private onSubscribe(linkId: string, uuid: string, subscribed: boolean): void {
    if (uuid === STATE_UUID) {
      if (subscribed) {
        this.stateSubscribers.add(linkId);
        // The contract: a full state right after the subscription is enabled.
        this.publishState(true);
      } else {
        this.stateSubscribers.delete(linkId);
      }
    } else if (uuid === ACK_UUID) {
      if (subscribed) this.ackSubscribers.add(linkId);
      else this.ackSubscribers.delete(linkId);
    }
    if (!subscribed && !this.stateSubscribers.has(linkId) && !this.ackSubscribers.has(linkId)) {
      // Nothing listens on this link any more: forget it (a partial message never leaks into the next link).
      this.links.delete(linkId);
    }
  }

  // ---- commands -------------------------------------------------------------------------------------

  private onWrite(linkId: string, frame: Buffer): void {
    const link = this.linkFor(linkId);
    const result = link.reassembler.push(frame);
    if (result.kind === "partial") return;
    if (result.kind === "damaged") {
      this.log(`damaged command message from ${linkId}: ${result.reason}`);
      this.enqueue(ACK_UUID, this.encodeAck({ id: null, ok: false, status: 0, code: "damaged-message" }));
      return;
    }
    void this.handleCommand(linkId, link, result.message);
  }

  private encodeAck(ack: BleAck): Buffer {
    return Buffer.from(JSON.stringify(ack), "utf8");
  }

  private ack(ack: BleAck): void {
    this.enqueue(ACK_UUID, this.encodeAck(ack));
  }

  /** Parses and checks one command; null (after the refusal was acknowledged) when it is not acceptable. */
  private parse(message: Buffer): BleCommandRequest | { refusal: BleAck } {
    let value: any;
    try {
      value = JSON.parse(message.toString("utf8"));
    } catch {
      return { refusal: { id: null, ok: false, status: 0, code: "malformed" } };
    }
    const id = typeof value?.id === "string" && value.id.length > 0 && value.id.length <= MAX_ID_CHARS ? value.id : null;
    const fail = (code: string): { refusal: BleAck } => ({ refusal: { id, ok: false, status: 0, code } });
    if (id === null) return fail("id-required");
    if (!Number.isInteger(value.robotId) || value.robotId < 0) return fail("malformed");
    if (typeof value.command !== "string" || !this.options.allowedCommands.has(value.command)) return fail("unknown-command");
    if (typeof value.token !== "string" || value.token.length === 0) return fail("token-required");
    if (value.token.length > MAX_TOKEN_CHARS) return fail("malformed");
    const params = value.params === undefined ? {} : value.params;
    if (typeof params !== "object" || params === null || Array.isArray(params)) return fail("malformed");
    if (Buffer.byteLength(JSON.stringify(params), "utf8") > MAX_PARAMS_BYTES) return fail("malformed");
    if (value.controllerId !== undefined && (typeof value.controllerId !== "string" || value.controllerId.length > 128)) return fail("malformed");
    return { id, robotId: value.robotId, command: value.command, params, controllerId: value.controllerId, token: value.token };
  }

  private takeToken(link: Link): boolean {
    const now = this.now();
    const capacity = this.commandsPerSecond * 2;
    link.bucket = Math.min(capacity, link.bucket + ((now - link.bucketAt) / 1000) * this.commandsPerSecond);
    link.bucketAt = now;
    if (link.bucket < 1) return false;
    link.bucket -= 1;
    return true;
  }

  private async handleCommand(linkId: string, link: Link, message: Buffer): Promise<void> {
    const parsed = this.parse(message);
    if ("refusal" in parsed) {
      this.ack(parsed.refusal);
      return;
    }
    if (this.options.mode !== "commands") {
      this.ack({ id: parsed.id, ok: false, status: 0, code: "commands-disabled" });
      return;
    }
    // A STOP is never held back by the pace limit: it must always get through.
    if (parsed.command !== "stop" && !this.takeToken(link)) {
      this.ack({ id: parsed.id, ok: false, status: 429, code: "rate-limited" });
      return;
    }
    let result: BleExecuteResult;
    try {
      result = await this.options.execute(parsed);
    } catch {
      result = { status: 0, body: null };
    }
    const ok = result.status >= 200 && result.status < 300;
    const out: BleAck = { id: parsed.id, ok, status: result.status, code: ackCodeFor(result.status, result.body) };
    if (!ok && typeof result.body?.error === "string") out.error = result.body.error.slice(0, 200);
    this.log(`command ${parsed.command} for robot ${parsed.robotId} from ${linkId}: ${out.ok ? "applied" : `refused (${out.code})`}`);
    this.ack(out);
  }

  // ---- notifications --------------------------------------------------------------------------------

  /** Called after any change of the state; the notifications are coalesced to one per interval. */
  publishState(immediate = false): void {
    if (this.stopped || this.options.mode === "off" || this.stateSubscribers.size === 0) return;
    this.pendingState = true;
    const wait = immediate ? 0 : Math.max(0, this.lastStateAt + this.minStateIntervalMs - this.now());
    if (wait === 0) {
      this.queueState();
    } else if (!this.stateTimer) {
      this.stateTimer = setTimeout(() => {
        this.stateTimer = null;
        this.queueState();
      }, wait);
      this.stateTimer.unref?.();
    }
  }

  private queueState(): void {
    if (!this.pendingState || this.stateSubscribers.size === 0) return;
    this.pendingState = false;
    this.lastStateAt = this.now();
    // Only the newest state matters: an older one still waiting is replaced.
    this.queue = this.queue.filter((item) => item.uuid !== STATE_UUID);
    this.queue.push({ uuid: STATE_UUID, message: encodeState(this.options.getState()) });
    void this.drain();
  }

  private enqueue(uuid: string, message: Buffer): void {
    if (this.stopped) return;
    // An acknowledgement goes before a waiting state.
    const index = this.queue.findIndex((item) => item.uuid === STATE_UUID);
    if (index === -1) this.queue.push({ uuid, message });
    else this.queue.splice(index, 0, { uuid, message });
    void this.drain();
  }

  private async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      while (this.queue.length > 0 && !this.stopped) {
        const item = this.queue.shift()!;
        let frames: Buffer[];
        try {
          frames = splitMessage(item.message, this.options.transport.mtu());
        } catch (error) {
          if (error instanceof MessageTooLarge) continue;
          throw error;
        }
        for (const frame of frames) {
          if (this.stopped) return;
          try {
            await this.options.transport.notify(item.uuid, frame);
          } catch (error) {
            this.log(`a notification failed: ${error instanceof Error ? error.message : String(error)}`);
            break;
          }
          if (this.frameDelayMs > 0) await this.sleep(this.frameDelayMs);
        }
      }
    } finally {
      this.draining = false;
    }
  }
}
