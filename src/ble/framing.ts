// =============================================================================
// HYDRA-UMC-SERVER - src/ble/framing.ts
// Copyright (C) 2026 JuanenRac (Electro Hobby 3D) <electrohobby3d@gmail.com>
// GPL-3.0-or-later - see LICENSE
// =============================================================================
// The framing of a message over the GATT characteristics (docs/BLE_GATT.md): a message can be larger than
// one ATT payload, so it is cut into frames. Every frame starts with one header byte:
//   bit 0      1 = first frame of the message
//   bit 1      1 = last frame of the message (a one-frame message has both bits set)
//   bits 2-3   reserved, 0
//   bits 4-7   sequence number: 0 on the first frame, +1 per frame, modulo 16
// The payload of a frame is MTU - 3 bytes, header included.

export const FIRST = 0x01;
export const LAST = 0x02;
/** A message past this size is dropped by the receiver (it asks for it, so the sender never exceeds it). */
export const MAX_MESSAGE_BYTES = 64 * 1024;
/** The smallest MTU a link can have: the default of ATT. */
export const MIN_MTU = 23;
/** The largest MTU a link can negotiate. */
export const MAX_MTU = 517;

/** The bytes of a frame that carry the message once the ATT header (3) and the frame header (1) are taken off. */
export function sliceSize(mtu: number): number {
  const clamped = Math.min(MAX_MTU, Math.max(MIN_MTU, Math.floor(mtu) || MIN_MTU));
  return clamped - 3 - 1;
}

export class MessageTooLarge extends Error {
  constructor(public size: number) {
    super(`message of ${size} bytes is past the limit of ${MAX_MESSAGE_BYTES}`);
  }
}

/** Cuts a message into the frames that fit a link with this MTU. An empty message is one empty frame. */
export function splitMessage(message: Uint8Array, mtu: number): Buffer[] {
  if (message.length > MAX_MESSAGE_BYTES) throw new MessageTooLarge(message.length);
  const size = sliceSize(mtu);
  const frames: Buffer[] = [];
  let offset = 0;
  let seq = 0;
  let first = true;
  do {
    const slice = message.subarray(offset, offset + size);
    offset += slice.length;
    const last = offset >= message.length;
    const header = (seq << 4) | (first ? FIRST : 0) | (last ? LAST : 0);
    first = false;
    frames.push(Buffer.concat([Buffer.from([header]), slice]));
    seq = (seq + 1) & 0x0f;
  } while (offset < message.length);
  return frames;
}

export type PushResult =
  | { kind: "partial" }
  | { kind: "message"; message: Buffer }
  | { kind: "damaged"; reason: "empty" | "reserved-bits" | "no-start" | "out-of-sequence" | "too-large" };

/**
 * Joins the frames of one link back into messages. A frame out of sequence, a continuation with no start, a
 * frame with reserved bits set and a message past the limit are dropped (the answer says so) and the receiver
 * waits for the next first frame; a first frame always discards a partial message.
 */
export class Reassembler {
  private parts: Buffer[] = [];
  private size = 0;
  private next = 0;
  private open = false;

  reset(): void {
    this.parts = [];
    this.size = 0;
    this.next = 0;
    this.open = false;
  }

  push(frame: Uint8Array): PushResult {
    if (frame.length === 0) {
      this.reset();
      return { kind: "damaged", reason: "empty" };
    }
    const header = frame[0];
    if ((header & 0x0c) !== 0) {
      this.reset();
      return { kind: "damaged", reason: "reserved-bits" };
    }
    const first = (header & FIRST) !== 0;
    const last = (header & LAST) !== 0;
    const seq = (header >> 4) & 0x0f;
    if (first) {
      this.reset();
      if (seq !== 0) return { kind: "damaged", reason: "out-of-sequence" };
      this.open = true;
    } else if (!this.open) {
      return { kind: "damaged", reason: "no-start" };
    } else if (seq !== this.next) {
      this.reset();
      return { kind: "damaged", reason: "out-of-sequence" };
    }
    const slice = Buffer.from(frame.subarray(1));
    this.size += slice.length;
    if (this.size > MAX_MESSAGE_BYTES) {
      this.reset();
      return { kind: "damaged", reason: "too-large" };
    }
    this.parts.push(slice);
    this.next = (seq + 1) & 0x0f;
    if (!last) return { kind: "partial" };
    const message = Buffer.concat(this.parts);
    this.reset();
    return { kind: "message", message };
  }
}
