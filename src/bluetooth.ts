// =============================================================================
// HYDRA-UMC STUDIO - Bluetooth pairing helpers: bluetooth.ts
// Copyright (C) 2026 JuanenRac (Electro Hobby 3D) <electrohobby3d@gmail.com>
// GPL-3.0 - see LICENSE
//
// Pure bluetoothctl wrapper logic behind server.ts's own /api/system/
// bluetooth/* routes (status/power/scan/pair/remove) - extracted the same
// way kinematics.ts/users.ts already separate real domain logic from route
// wiring: this module owns the subprocess calls and output parsing, the
// `app.get/app.post` registrations and their auth middleware stay in
// server.ts exactly like calculateJoints()'s own callers there.
//
// Real gap found pairing a physical Xbox controller against a real device:
// BlueZ's own default ClassicBondedOnly=true (profiles/input/device.c)
// refuses the HID connection for a device that bonds over LE rather than
// classic BR/EDR on some hardware (Broadcom BCM4345C0) - `pair`/`trust`
// both genuinely succeed, but the device is stuck at Paired=yes/Bonded=no
// forever and never becomes a real /dev/input device. HYDRA-UMC-OS's own
// provisioning/first_boot.sh sets ClassicBondedOnly=false for exactly this
// reason - a host provisioned before that fix landed will still hit it
// here, which is why server.ts's own POST /pair error response names the
// real fix instead of a generic failure message.
// =============================================================================

import { execFile } from "child_process";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

export const BLUETOOTH_SCAN_TIMEOUT_S = 10;
export const BLUETOOTH_ACTION_TIMEOUT_MS = 20000;
export const BLUETOOTH_MAC_RE = /^([0-9A-Fa-f]{2}:){5}[0-9A-Fa-f]{2}$/;

export interface BluetoothDeviceInfo {
  mac: string;
  name: string;
  icon: string | null;
  paired: boolean;
  bonded: boolean;
  connected: boolean;
  trusted: boolean;
}

export function parseBluetoothctlInfo(output: string): Partial<BluetoothDeviceInfo> {
  const field = (label: string): string | undefined => {
    const match = output.match(new RegExp(`^\\s*${label}:\\s*(.+)$`, "m"));
    return match ? match[1].trim() : undefined;
  };
  return {
    name: field("Name") ?? field("Alias"),
    icon: field("Icon") ?? null,
    paired: field("Paired") === "yes",
    bonded: field("Bonded") === "yes",
    connected: field("Connected") === "yes",
    trusted: field("Trusted") === "yes",
  };
}

/** `bluetoothctl devices` lists every device BlueZ currently remembers
 * (paired or merely seen during the last scan); `info` per-MAC is the
 * only source for the real paired/bonded/connected/trusted flags - there
 * is no bulk-info bluetoothctl subcommand. A device that vanished between
 * the two calls (moved out of range) is just skipped, not a real error
 * worth failing the whole list over. */
export async function listBluetoothDevices(): Promise<BluetoothDeviceInfo[]> {
  const { stdout } = await execFileAsync("bluetoothctl", ["devices"], { timeout: BLUETOOTH_ACTION_TIMEOUT_MS });
  const seen = [...stdout.matchAll(/^Device ([0-9A-Fa-f:]{17})\s+(.*)$/gm)].map((m) => ({
    mac: m[1],
    fallbackName: m[2].trim(),
  }));
  const devices: BluetoothDeviceInfo[] = [];
  for (const { mac, fallbackName } of seen) {
    try {
      const { stdout: info } = await execFileAsync("bluetoothctl", ["info", mac], { timeout: BLUETOOTH_ACTION_TIMEOUT_MS });
      const parsed = parseBluetoothctlInfo(info);
      devices.push({
        mac,
        name: parsed.name || fallbackName || mac,
        icon: parsed.icon ?? null,
        paired: parsed.paired ?? false,
        bonded: parsed.bonded ?? false,
        connected: parsed.connected ?? false,
        trusted: parsed.trusted ?? false,
      });
    } catch {
      continue;
    }
  }
  return devices;
}

/** Raw `bluetoothctl show` status text, plus the real device list - kept
 * as one round trip since server.ts's own GET /status route needs both. */
export async function getBluetoothStatus(): Promise<{ stdout: string; devices: BluetoothDeviceInfo[] }> {
  const { stdout } = await execFileAsync("bluetoothctl", ["show"], { timeout: BLUETOOTH_ACTION_TIMEOUT_MS });
  const devices = await listBluetoothDevices();
  return { stdout, devices };
}

export async function setBluetoothPower(on: boolean): Promise<void> {
  await execFileAsync("bluetoothctl", ["power", on ? "on" : "off"], { timeout: BLUETOOTH_ACTION_TIMEOUT_MS });
}

export async function scanBluetoothDevices(): Promise<BluetoothDeviceInfo[]> {
  // bluetoothctl's own non-interactive one-shot form: runs real discovery
  // for exactly this many seconds, then exits on its own - no persistent
  // session/agent bookkeeping needed on this side.
  await execFileAsync("bluetoothctl", ["--timeout", String(BLUETOOTH_SCAN_TIMEOUT_S), "scan", "on"], {
    timeout: (BLUETOOTH_SCAN_TIMEOUT_S + 5) * 1000,
  });
  return listBluetoothDevices();
}

export async function pairBluetoothDevice(mac: string): Promise<Partial<BluetoothDeviceInfo>> {
  // Real, sequential handshake, same order proven live against a physical
  // Xbox controller: pair (creates the real link key/bond), trust (so it
  // reconnects on its own next time it powers on in range), connect (opens
  // the HID/profile connection right now instead of waiting for the
  // device's own next reconnect attempt).
  await execFileAsync("bluetoothctl", ["pair", mac], { timeout: BLUETOOTH_ACTION_TIMEOUT_MS });
  await execFileAsync("bluetoothctl", ["trust", mac], { timeout: BLUETOOTH_ACTION_TIMEOUT_MS });
  try {
    await execFileAsync("bluetoothctl", ["connect", mac], { timeout: BLUETOOTH_ACTION_TIMEOUT_MS });
  } catch {
    // Pairing/trusting already succeeded even if this immediate connect
    // attempt didn't - a trusted device reconnects on its own once it's
    // actually powered on and in range, so this alone is not a real
    // failure of pairing itself.
  }
  const { stdout: info } = await execFileAsync("bluetoothctl", ["info", mac], { timeout: BLUETOOTH_ACTION_TIMEOUT_MS });
  return parseBluetoothctlInfo(info);
}

export async function removeBluetoothDevice(mac: string): Promise<void> {
  await execFileAsync("bluetoothctl", ["remove", mac], { timeout: BLUETOOTH_ACTION_TIMEOUT_MS });
}
