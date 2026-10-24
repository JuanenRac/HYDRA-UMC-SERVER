import assert from "node:assert/strict";
import { test } from "node:test";
import { MAX_MESSAGE_BYTES, MessageTooLarge, Reassembler, sliceSize, splitMessage } from "../src/ble/framing.ts";

function roundTrip(message: Buffer, mtu: number): Buffer {
  const reassembler = new Reassembler();
  let out: Buffer | null = null;
  for (const frame of splitMessage(message, mtu)) {
    assert.ok(frame.length <= mtu - 3, "a frame never exceeds MTU - 3");
    const result = reassembler.push(frame);
    if (result.kind === "message") out = result.message;
    else assert.equal(result.kind, "partial");
  }
  assert.ok(out, "the message came back");
  return out;
}

test("every size and MTU round-trips, and the header bits follow the contract", () => {
  for (const mtu of [23, 24, 50, 185, 247, 517]) {
    for (const size of [0, 1, sliceSize(mtu) - 1, sliceSize(mtu), sliceSize(mtu) + 1, 3 * sliceSize(mtu), 1000, 5000]) {
      const message = Buffer.alloc(size, 0).map((_, i) => (i * 7 + size) & 0xff);
      assert.deepEqual(roundTrip(message, mtu), message, `mtu ${mtu} size ${size}`);
    }
  }
  const one = splitMessage(Buffer.from("hi"), 247);
  assert.equal(one.length, 1);
  assert.equal(one[0][0], 0x03, "a one-frame message has the first and last bits set and sequence 0");
  const three = splitMessage(Buffer.alloc(2 * sliceSize(23) + 1), 23);
  assert.deepEqual(three.map((f) => f[0]), [0x01, 0x10, 0x22]);
});

test("the sequence wraps modulo 16", () => {
  const frames = splitMessage(Buffer.alloc(40 * sliceSize(23)), 23);
  assert.equal(frames.length, 40);
  assert.deepEqual(frames.slice(14, 18).map((f) => f[0] >> 4), [14, 15, 0, 1]);
  assert.deepEqual(roundTrip(Buffer.alloc(40 * sliceSize(23), 9), 23).length, 40 * sliceSize(23));
});

test("the MTU is clamped: an absurd value cannot make a frame longer than the link allows", () => {
  assert.equal(sliceSize(5), 19);
  assert.equal(sliceSize(Number.NaN), 19);
  assert.equal(sliceSize(100000), 513);
});

test("a message past 64 KiB is not sent, and is dropped when it is received", () => {
  assert.throws(() => splitMessage(Buffer.alloc(MAX_MESSAGE_BYTES + 1), 247), MessageTooLarge);
  assert.equal(splitMessage(Buffer.alloc(MAX_MESSAGE_BYTES), 517).length > 0, true);
  const reassembler = new Reassembler();
  let last: any = null;
  // frames of a message one byte over the limit, built by hand
  const slice = sliceSize(517);
  const total = MAX_MESSAGE_BYTES + 1;
  let sent = 0;
  let seq = 0;
  while (sent < total) {
    const part = Math.min(slice, total - sent);
    sent += part;
    last = reassembler.push(Buffer.concat([Buffer.from([(seq << 4) | (sent === part ? 1 : 0) | (sent >= total ? 2 : 0)]), Buffer.alloc(part)]));
    seq = (seq + 1) & 15;
    if (last.kind === "damaged") break;
  }
  assert.deepEqual(last, { kind: "damaged", reason: "too-large" });
});

test("damaged frames are dropped and the next first frame starts again", () => {
  const reassembler = new Reassembler();
  assert.deepEqual(reassembler.push(Buffer.alloc(0)), { kind: "damaged", reason: "empty" });
  assert.deepEqual(reassembler.push(Buffer.from([0x02, 1])), { kind: "damaged", reason: "no-start" }, "a continuation with no start");
  assert.deepEqual(reassembler.push(Buffer.from([0x05, 1])), { kind: "damaged", reason: "reserved-bits" });
  assert.deepEqual(reassembler.push(Buffer.from([0x11, 1])), { kind: "damaged", reason: "out-of-sequence" }, "a first frame must have sequence 0");
  assert.equal(reassembler.push(Buffer.from([0x01, 65])).kind, "partial");
  assert.deepEqual(reassembler.push(Buffer.from([0x32, 66])), { kind: "damaged", reason: "out-of-sequence" }, "a frame was lost");
  assert.deepEqual(reassembler.push(Buffer.from([0x12, 66])), { kind: "damaged", reason: "no-start" }, "and the rest of that message is ignored");
  assert.equal(reassembler.push(Buffer.from([0x01, 65])).kind, "partial");
  assert.equal(reassembler.push(Buffer.from([0x01, 90])).kind, "partial", "a new first frame discards the partial message");
  const done = reassembler.push(Buffer.from([0x12, 91]));
  assert.equal(done.kind, "message");
  assert.deepEqual((done as any).message, Buffer.from([90, 91]));
});
