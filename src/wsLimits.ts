// =============================================================================
// HYDRA-UMC-SERVER - src/wsLimits.ts
// Copyright (C) 2026 JuanenRac (Electro Hobby 3D) <electrohobby3d@gmail.com>
// GPL-3.0-or-later - see LICENSE
// =============================================================================
// The size limits of a WebSocket message (websocket.limitPayload of Server Admin), with no imports so that a test can load them alone.

/** The size of a message that an account that is not an administrator may send. */
export const WS_MAX_MESSAGE_BYTES = 1024 * 1024;
/** The size that no message may pass, whoever sends it (the library allowed 100 MiB). */
export const WS_MAX_ADMIN_BYTES = 16 * 1024 * 1024;

/** The size in bytes of what the library hands to the message handler (one buffer, a list of them, or an array buffer). */
export function messageSize(raw: Buffer | ArrayBuffer | Buffer[]): number {
  if (Array.isArray(raw)) return raw.reduce((sum, part) => sum + part.length, 0);
  return raw instanceof ArrayBuffer ? raw.byteLength : raw.length;
}
