// =============================================================================
// HYDRA-UMC-SERVER - src/nodeHealth.ts
// Copyright (C) 2026 JuanenRac (Electro Hobby 3D) <electrohobby3d@gmail.com>
// GPL-3.0-or-later - see LICENSE
// =============================================================================
// The last health frame that the kinematic brain heard from a controller board, as the SPI bridge of the CM5 reports it (GET /node-health?slot=N of the bridge,
// the types 0x27 and 0x2A of the SPI link). The server only reads it and passes it on, in a fixed shape: whatever else the bridge says is dropped, and a
// damaged answer is not passed on. Read only: nothing is sent to the board. The route is behind the switch nodeHealth.enabled (off by default).

export const NODE_HEALTH_SLOTS = 8;

export interface NodeHealth {
  /** False when the brain did not answer (its build has the health query off, or the link is down). Then only `slot` and `source` carry anything. */
  online: boolean;
  slot: number;
  /** True when the brain has heard a health frame of the slot; false when it never has; null when it did not answer. */
  heard: boolean | null;
  /** How long ago the brain heard it, in milliseconds (steps of 100 ms, 25 400 at most). Absent when nothing was heard. */
  ageMs?: number;
  sequence?: number;
  flags?: number;
  flagNames?: string[];
  txErrors?: number;
  rxErrors?: number;
  stalls?: number;
  /** Seconds since the board started, in steps of 16 (4080 means 4080 or more). */
  uptimeS?: number;
  source: "brain-health";
}

const isInt = (value: unknown, min: number, max: number): value is number => typeof value === "number" && Number.isInteger(value) && value >= min && value <= max;

/** The answer of the bridge for `slot`, in the fixed shape, or null when it is not a health answer of that slot. */
export function parseNodeHealth(raw: unknown, slot: number): NodeHealth | null {
  if (typeof raw !== "object" || raw === null) return null;
  const body = raw as Record<string, unknown>;
  if (body.online === false) return { online: false, slot, heard: null, source: "brain-health" };
  if (body.online !== true || body.slot !== slot) return null;
  if (body.heard === false) return { online: true, slot, heard: false, source: "brain-health" };
  if (body.heard !== true) return null;
  const names = Array.isArray(body.flag_names) && body.flag_names.every((name) => typeof name === "string" && name.length <= 64) && body.flag_names.length <= 16 ? (body.flag_names as string[]) : null;
  if (!isInt(body.age_ms, 0, 25_400) || !isInt(body.sequence, 0, 255) || !isInt(body.flags, 0, 255) || names === null || !isInt(body.tx_errors, 0, 255) || !isInt(body.rx_errors, 0, 255) || !isInt(body.stalls, 0, 255) || !isInt(body.uptime_s, 0, 4080)) return null;
  return {
    online: true, slot, heard: true, ageMs: body.age_ms, sequence: body.sequence, flags: body.flags, flagNames: [...names],
    txErrors: body.tx_errors, rxErrors: body.rx_errors, stalls: body.stalls, uptimeS: body.uptime_s, source: "brain-health",
  };
}

/** The slot of a request: a whole number from 0 to 7, or null. */
export function parseSlot(value: unknown): number | null {
  if (typeof value !== "string" || !/^\d$/.test(value)) return null;
  const slot = Number(value);
  return slot < NODE_HEALTH_SLOTS ? slot : null;
}

/** The fetch of one slot from the bridge: the parsed answer, or null on any failure (no address, a refusal, a timeout, a damaged body). */
export function bridgeNodeHealthFetcher(baseUrl: string, headers: () => Record<string, string>, timeoutMs: number, fetchImpl: typeof fetch = fetch): (slot: number) => Promise<NodeHealth | null> {
  return async (slot) => {
    if (!baseUrl) return null;
    try {
      const response = await fetchImpl(`${baseUrl.replace(/\/+$/, "")}/node-health?slot=${slot}`, { headers: headers(), signal: AbortSignal.timeout(timeoutMs) });
      if (!response.ok) return null;
      return parseNodeHealth(await response.json(), slot);
    } catch {
      return null;
    }
  };
}
