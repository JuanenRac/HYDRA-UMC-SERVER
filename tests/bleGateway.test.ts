import assert from "node:assert/strict";
import { test } from "node:test";
import { Reassembler, splitMessage } from "../src/ble/framing.ts";
import {
  ACK_UUID, BleGateway, STATE_UUID, ackCodeFor, encodeState, slimState,
  type BleCommandRequest, type BleExecuteResult, type BleMode, type GattHandlers, type GattTransport,
} from "../src/ble/bleGateway.ts";

/** A radio that is a table: the frames the server notified, and a central that writes and subscribes. */
class SimulatedRadio implements GattTransport {
  handlers!: GattHandlers;
  notified: { uuid: string; frame: Buffer }[] = [];
  mtuNow = 23;
  failNotify = false;
  async start(handlers: GattHandlers) { this.handlers = handlers; }
  async notify(uuid: string, frame: Buffer) {
    if (this.failNotify) throw new Error("radio down");
    this.notified.push({ uuid, frame });
  }
  mtu() { return this.mtuNow; }
  async stop() {}
  subscribe(uuid: string, link = "phone") { this.handlers.onSubscribe(link, uuid, true); }
  write(message: object | string, link = "phone", mtu = 23) {
    const bytes = Buffer.from(typeof message === "string" ? message : JSON.stringify(message));
    for (const frame of splitMessage(bytes, mtu)) this.handlers.onWrite(link, frame);
  }
  /** The messages the central received on a characteristic. */
  received(uuid: string): any[] {
    const reassembler = new Reassembler();
    const out: any[] = [];
    for (const item of this.notified) {
      if (item.uuid !== uuid) continue;
      const result = reassembler.push(item.frame);
      if (result.kind === "message") out.push(JSON.parse(result.message.toString("utf8")));
    }
    return out;
  }
}

const COMMANDS = new Set(["stop", "play", "pause", "jog", "speed"]);
const flush = async () => { for (let i = 0; i < 40; i += 1) await new Promise((r) => setImmediate(r)); };

function make(mode: BleMode, over: Partial<{ execute: (r: BleCommandRequest) => Promise<BleExecuteResult>; state: unknown; now: () => number; commandsPerSecond: number }> = {}) {
  const radio = new SimulatedRadio();
  const calls: BleCommandRequest[] = [];
  let state: unknown = over.state ?? { controllers: [{ id: "c", robots: [{ id: 1, name: "A" }] }] };
  const gateway = new BleGateway({
    mode,
    transport: radio,
    getState: () => state,
    execute: over.execute ?? (async (request) => { calls.push(request); return { status: 200, body: { success: true } }; }),
    allowedCommands: COMMANDS,
    minStateIntervalMs: 0,
    frameDelayMs: 0,
    sleep: async () => undefined,
    now: over.now,
    commandsPerSecond: over.commandsPerSecond ?? 10,
  });
  return { radio, gateway, calls, setState: (value: unknown) => { state = value; } };
}

const command = (extra: object = {}) => ({ id: "c1", robotId: 1, command: "pause", params: {}, token: "tok", ...extra });

test("with the mode off nothing starts", async () => {
  const { gateway, radio } = make("off");
  await gateway.start();
  assert.equal(radio.handlers, undefined);
});

test("the state is notified as soon as a central subscribes, in frames that fit the MTU", async () => {
  const { gateway, radio } = make("state");
  await gateway.start();
  radio.mtuNow = 50;
  radio.subscribe(STATE_UUID);
  await flush();
  assert.ok(radio.notified.length >= 2);
  assert.ok(radio.notified.every((n) => n.uuid === STATE_UUID && n.frame.length <= 47));
  assert.deepEqual(radio.received(STATE_UUID), [{ controllers: [{ id: "c", robots: [{ id: 1, name: "A" }] }] }]);
});

test("only the newest state is sent when changes come faster than the notifications", async () => {
  const { gateway, radio, setState } = make("state");
  await gateway.start();
  radio.mtuNow = 247;
  radio.subscribe(STATE_UUID);
  await flush();
  setState({ n: 1 });
  gateway.publishState(true);
  setState({ n: 2 });
  gateway.publishState(true);
  await flush();
  const states = radio.received(STATE_UUID);
  assert.deepEqual(states.at(-1), { n: 2 });
});

test("without a subscriber nothing is notified", async () => {
  const { gateway, radio } = make("state");
  await gateway.start();
  gateway.publishState(true);
  await flush();
  assert.equal(radio.notified.length, 0);
});

test("in state mode a command is refused and never reaches the route", async () => {
  const { gateway, radio, calls } = make("state");
  await gateway.start();
  radio.subscribe(ACK_UUID);
  radio.write(command());
  await flush();
  assert.equal(calls.length, 0);
  assert.deepEqual(radio.received(ACK_UUID), [{ id: "c1", ok: false, status: 0, code: "commands-disabled" }]);
});

test("in commands mode the route answers and the acknowledgement says what it said", async () => {
  const { gateway, radio, calls } = make("commands");
  await gateway.start();
  radio.subscribe(ACK_UUID);
  radio.write(command({ params: { paused: true }, controllerId: "phone-1" }), "phone", 23);
  await flush();
  assert.deepEqual(calls, [{ id: "c1", robotId: 1, command: "pause", params: { paused: true }, controllerId: "phone-1", token: "tok" }]);
  assert.deepEqual(radio.received(ACK_UUID), [{ id: "c1", ok: true, status: 200, code: "ok" }]);
});

test("a refusal of the route is acknowledged with its status and code, never as success", async () => {
  const answers: BleExecuteResult[] = [
    { status: 409, body: { error: "reserved by ana", code: "other-account" } },
    { status: 403, body: { error: "forbidden" } },
    { status: 401, body: {} },
    { status: 412, body: null },
    { status: 500, body: null },
    { status: 0, body: null },
  ];
  const { gateway, radio } = make("commands", { execute: async () => answers.shift()! });
  await gateway.start();
  radio.subscribe(ACK_UUID);
  for (let i = 0; i < 6; i += 1) radio.write(command({ id: `r${i}` }), "phone", 247);
  await flush();
  const acks = radio.received(ACK_UUID);
  assert.deepEqual(acks.map((a) => [a.id, a.ok, a.status, a.code]), [
    ["r0", false, 409, "other-account"],
    ["r1", false, 403, "forbidden"],
    ["r2", false, 401, "session-expired"],
    ["r3", false, 412, "revision-changed"],
    ["r4", false, 500, "server-error"],
    ["r5", false, 0, "unreachable"],
  ]);
  assert.equal(acks[0].error, "reserved by ana");
});

test("a route that throws is an unreachable server, not a hang", async () => {
  const { gateway, radio } = make("commands", { execute: async () => { throw new Error("boom"); } });
  await gateway.start();
  radio.subscribe(ACK_UUID);
  radio.write(command());
  await flush();
  assert.deepEqual(radio.received(ACK_UUID), [{ id: "c1", ok: false, status: 0, code: "unreachable" }]);
});

test("malformed commands are refused before the route and say why", async () => {
  const { gateway, radio, calls } = make("commands");
  await gateway.start();
  radio.subscribe(ACK_UUID);
  radio.write("not json");
  radio.write(command({ id: undefined }));
  radio.write(command({ id: "x".repeat(65) }));
  radio.write(command({ robotId: "1" }));
  radio.write(command({ robotId: -1 }));
  radio.write(command({ command: "rm -rf" }));
  radio.write(command({ token: undefined }));
  radio.write(command({ token: "" }));
  radio.write(command({ token: "t".repeat(5000) }));
  radio.write(command({ params: [1] }));
  radio.write(command({ params: { big: "z".repeat(5000) } }));
  radio.write(command({ controllerId: 7 }));
  await flush();
  assert.equal(calls.length, 0);
  assert.deepEqual(radio.received(ACK_UUID).map((a) => a.code), [
    "malformed", "id-required", "id-required", "malformed", "malformed", "unknown-command",
    "token-required", "token-required", "malformed", "malformed", "malformed", "malformed",
  ]);
});

test("a damaged frame is acknowledged as a damaged message and the next command still works", async () => {
  const { gateway, radio, calls } = make("commands");
  await gateway.start();
  radio.subscribe(ACK_UUID);
  radio.handlers.onWrite("phone", Buffer.from([0x12, 65]));
  radio.write(command());
  await flush();
  assert.equal(calls.length, 1);
  assert.deepEqual(radio.received(ACK_UUID).map((a) => a.code), ["damaged-message", "ok"]);
});

test("a link that drops forgets its partial message", async () => {
  const { gateway, radio, calls } = make("commands");
  await gateway.start();
  radio.subscribe(ACK_UUID, "a");
  const frames = splitMessage(Buffer.from(JSON.stringify(command())), 23);
  radio.handlers.onWrite("a", frames[0]);
  radio.handlers.onSubscribe("a", ACK_UUID, false);
  for (const frame of frames.slice(1)) radio.handlers.onWrite("a", frame);
  await flush();
  assert.equal(calls.length, 0, "the rest of a message whose start was lost is not a command");
});

test("one phone cannot flood the route, but STOP always gets through", async () => {
  let clock = 0;
  const { gateway, radio, calls } = make("commands", { now: () => clock, commandsPerSecond: 2 });
  await gateway.start();
  radio.subscribe(ACK_UUID);
  for (let i = 0; i < 8; i += 1) radio.write(command({ id: `j${i}`, command: "jog", params: { axis: "x", amount: 1 } }), "phone", 247);
  radio.write(command({ id: "stop-1", command: "stop" }), "phone", 247);
  await flush();
  const acks = radio.received(ACK_UUID);
  const limited = acks.filter((a) => a.code === "rate-limited");
  assert.ok(limited.length >= 3, "the burst is cut");
  assert.ok(calls.some((c) => c.command === "stop"), "STOP reaches the route");
  assert.equal(acks.find((a) => a.id === "stop-1")?.ok, true);
  clock += 5000;
  radio.write(command({ id: "later", command: "jog", params: {} }), "phone", 247);
  await flush();
  assert.equal(radio.received(ACK_UUID).find((a) => a.id === "later")?.ok, true, "after a pause the phone may send again");
});

test("the limit is per link: a second phone has its own budget", async () => {
  const { gateway, radio } = make("commands", { commandsPerSecond: 1 });
  await gateway.start();
  radio.subscribe(ACK_UUID, "a");
  for (let i = 0; i < 4; i += 1) radio.write(command({ id: `a${i}`, command: "jog" }), "a", 247);
  radio.write(command({ id: "b0", command: "jog" }), "b", 247);
  await flush();
  const acks = radio.received(ACK_UUID);
  assert.equal(acks.find((a) => a.id === "b0")?.ok, true);
  assert.ok(acks.some((a) => a.code === "rate-limited"));
});

test("an acknowledgement is sent before a waiting state", async () => {
  const { gateway, radio, setState } = make("commands");
  await gateway.start();
  radio.mtuNow = 247;
  radio.subscribe(STATE_UUID);
  radio.subscribe(ACK_UUID);
  await flush();
  radio.notified.length = 0;
  setState({ big: "x".repeat(3000) });
  gateway.publishState(true);
  radio.write(command(), "phone", 247);
  await flush();
  const firstAck = radio.notified.findIndex((n) => n.uuid === ACK_UUID);
  const firstStateFrame = radio.notified.findIndex((n) => n.uuid === STATE_UUID);
  assert.ok(firstAck >= 0 && firstStateFrame >= 0);
  // whole messages are never interleaved: after a state frame with more to come only state frames follow
  let open: string | null = null;
  for (const n of radio.notified) {
    const last = (n.frame[0] & 2) !== 0;
    if (open !== null) assert.equal(n.uuid, open, "frames of two messages are never mixed");
    open = last ? null : n.uuid;
  }
});

test("a state that does not fit one message is sent slim, flagged as truncated", () => {
  const robots = Array.from({ length: 40 }, (_, i) => ({ id: i, name: `R${i}`, joints: [1, 2, 3], works: "w".repeat(3000), secretBlob: "z".repeat(1000) }));
  const tree = { controllers: [{ id: "c", name: "C", robots }] };
  const bytes = encodeState(tree);
  assert.ok(bytes.length < 64 * 1024);
  const parsed = JSON.parse(bytes.toString("utf8"));
  assert.equal(parsed.truncated, true);
  assert.deepEqual(parsed.controllers[0].robots[3], { id: 3, name: "R3", joints: [1, 2, 3] });
  assert.deepEqual(slimState({}), { truncated: true, controllers: [] });
  const small = { controllers: [] };
  assert.deepEqual(JSON.parse(encodeState(small).toString("utf8")), small);
});

test("a radio that fails to notify drops that message and goes on", async () => {
  const { gateway, radio } = make("state");
  await gateway.start();
  radio.failNotify = true;
  radio.subscribe(STATE_UUID);
  await flush();
  radio.failNotify = false;
  gateway.publishState(true);
  await flush();
  assert.ok(radio.received(STATE_UUID).length >= 1);
});

test("stopping the gateway stops the notifications", async () => {
  const { gateway, radio } = make("state");
  await gateway.start();
  radio.subscribe(STATE_UUID);
  await flush();
  const before = radio.notified.length;
  await gateway.stop();
  gateway.publishState(true);
  await flush();
  assert.equal(radio.notified.length, before);
});

test("status codes map to stable words", () => {
  assert.equal(ackCodeFor(200, null), "ok");
  assert.equal(ackCodeFor(201, {}), "ok");
  assert.equal(ackCodeFor(409, { code: "x".repeat(65) }), "claimed");
  assert.equal(ackCodeFor(418, null), "rejected");
});
