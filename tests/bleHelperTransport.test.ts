import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { HelperTransport } from "../src/ble/helperTransport.ts";
import { ACK_UUID, STATE_UUID, type GattHandlers } from "../src/ble/bleGateway.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const HELPER = path.join(ROOT, "scripts", "ble_gatt_helper.py");

function findPython(): string | null {
  for (const candidate of ["python3", "python", "py"]) {
    const probe = spawnSync(candidate, ["-c", "import sys; sys.exit(0 if sys.version_info >= (3, 9) else 1)"], { stdio: "ignore" });
    if (probe.status === 0) return candidate;
  }
  return null;
}

const python = findPython();
const waitFor = async (condition: () => boolean, ms = 4000) => {
  const until = Date.now() + ms;
  while (!condition() && Date.now() < until) await new Promise((r) => setTimeout(r, 10));
  assert.ok(condition(), "timed out");
};

function recorder() {
  const writes: { link: string; frame: Buffer }[] = [];
  const subs: [string, string, boolean][] = [];
  const handlers: GattHandlers = {
    onWrite: (link, frame) => writes.push({ link, frame }),
    onSubscribe: (link, uuid, on) => subs.push([link, uuid, on]),
  };
  return { writes, subs, handlers };
}

const send = (transport: HelperTransport, op: object) => (transport as any).child.stdin.write(JSON.stringify(op) + "\n");

test("the helper (without a radio) carries writes, subscriptions and the MTU to the server and notifications back", { skip: python === null ? "no python3 on this machine" : false }, async () => {
  const { writes, subs, handlers } = recorder();
  const transport = new HelperTransport({ command: python!, args: [HELPER, "--simulate"], restartDelayMs: 0 });
  await transport.start(handlers);
  assert.equal(transport.mtu(), 23, "the default MTU until a central says otherwise");

  send(transport, { op: "simulate-write", link: "dev_1", frame: Buffer.from([0x03, 0x41, 0x42]).toString("base64") });
  await waitFor(() => writes.length === 1);
  assert.equal(writes[0].link, "dev_1");
  assert.deepEqual(writes[0].frame, Buffer.from([0x03, 0x41, 0x42]));

  send(transport, { op: "simulate-subscribe", link: "notify", uuid: STATE_UUID, on: true });
  send(transport, { op: "simulate-subscribe", link: "notify", uuid: ACK_UUID, on: true });
  await waitFor(() => subs.length === 2);
  assert.deepEqual(subs[0], ["notify", STATE_UUID, true]);

  send(transport, { op: "simulate-mtu", mtu: 247 });
  await waitFor(() => transport.mtu() === 247);
  send(transport, { op: "simulate-mtu", mtu: 100000 });
  await waitFor(() => transport.mtu() === 517);

  await transport.notify(STATE_UUID, Buffer.from([0x03, 1]));

  await transport.stop();
  await assert.rejects(() => transport.notify(STATE_UUID, Buffer.from([0x03, 1])), /not running/);
});

test("a helper that dies takes the subscriptions of its centrals with it", { skip: python === null ? "no python3 on this machine" : false }, async () => {
  const { subs, handlers } = recorder();
  const transport = new HelperTransport({ command: python!, args: [HELPER, "--simulate"], restartDelayMs: 0 });
  await transport.start(handlers);
  send(transport, { op: "simulate-subscribe", link: "notify", uuid: STATE_UUID, on: true });
  send(transport, { op: "simulate-mtu", mtu: 200 });
  await waitFor(() => subs.length === 1 && transport.mtu() === 200);
  (transport as any).child.kill();
  await waitFor(() => subs.length === 2);
  assert.deepEqual(subs[1], ["notify", STATE_UUID, false]);
  assert.equal(transport.mtu(), 23);
  await transport.stop();
});

test("a program that does not exist, or that ends before it is ready, fails to start without hanging", async () => {
  await assert.rejects(() => new HelperTransport({ command: "hydra-no-such-program", args: [], restartDelayMs: 0 }).start(recorder().handlers));
  await assert.rejects(
    () => new HelperTransport({ command: process.execPath, args: ["-e", "process.exit(3)"], restartDelayMs: 0 }).start(recorder().handlers),
    /ended before it was ready/,
  );
});

test("a helper that reports an error instead of ready makes the start fail with its message", async () => {
  const script = 'process.stdout.write(JSON.stringify({event:"error",message:"no Bluetooth adapter"})+"\\n"); setTimeout(()=>{},2000)';
  const transport = new HelperTransport({ command: process.execPath, args: ["-e", script], restartDelayMs: 0, readyTimeoutMs: 3000 });
  await assert.rejects(() => transport.start(recorder().handlers), /no Bluetooth adapter/);
  await transport.stop();
});

test("a helper that never says ready is given up on", async () => {
  const transport = new HelperTransport({ command: process.execPath, args: ["-e", "setTimeout(()=>{},5000)"], restartDelayMs: 0, readyTimeoutMs: 200 });
  await assert.rejects(() => transport.start(recorder().handlers), /did not register/);
  await transport.stop();
});

test("junk on the helper's output is ignored", async () => {
  const { writes, handlers } = recorder();
  const script = [
    'process.stdout.write("not json\\n");',
    'process.stdout.write(JSON.stringify({event:"write",link:7,frame:"AA=="})+"\\n");',
    'process.stdout.write(JSON.stringify({event:"ready"})+"\\n");',
    'process.stdout.write(JSON.stringify({event:"write",link:"x",frame:"AwE="})+"\\n");',
    "setTimeout(()=>{},1500)",
  ].join("");
  const transport = new HelperTransport({ command: process.execPath, args: ["-e", script], restartDelayMs: 0 });
  await transport.start(handlers);
  await waitFor(() => writes.length === 1);
  assert.deepEqual(writes[0], { link: "x", frame: Buffer.from([3, 1]) });
  await transport.stop();
});
