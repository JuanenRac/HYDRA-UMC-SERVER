// =============================================================================
// HYDRA-UMC-SERVER - Unit tests for the bluetoothctl calls of the pairing helpers
// Copyright (C) 2026 JuanenRac (Electro Hobby 3D) <electrohobby3d@gmail.com>
// GPL-3.0-or-later - see LICENSE
// =============================================================================
// src/bluetooth.ts runs the real `bluetoothctl`. These tests put a stand-in program with that name first on the PATH: it records every call and answers from the
// environment, so the order of the pairing handshake, the arguments (the MAC is one argument, never a shell line), the device that vanishes between the list and its
// details, and the failure of each step can be checked without a radio. The stand-in is a shell script, so the tests run where there is a POSIX shell.
import test, { after, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  BLUETOOTH_ACTION_TIMEOUT_MS, BLUETOOTH_SCAN_TIMEOUT_S, getBluetoothStatus, listBluetoothDevices, pairBluetoothDevice, removeBluetoothDevice, scanBluetoothDevices,
  setBluetoothPower,
} from "../src/bluetooth.ts";

const posix = process.platform !== "win32";
const options = { skip: posix ? false : "needs a POSIX shell for the stand-in bluetoothctl" };

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hydra-umc-btctl-"));
const logFile = path.join(dir, "calls.log");
const originalPath = process.env.PATH;

const SCRIPT = `#!/bin/sh
echo "$*" >> "$FAKE_BT_LOG"
case "$1" in
  devices)
    [ -n "$FAKE_BT_DEVICES_FAIL" ] && exit 2
    printf '%s' "$FAKE_BT_DEVICES"
    ;;
  info)
    case " $FAKE_BT_INFO_FAIL " in *" $2 "*) exit 1 ;; esac
    printf 'Device %s (public)\\n' "$2"
    case "$2" in
      AA:AA:AA:AA:AA:01) printf '\\tName: Xbox Controller\\n\\tIcon: input-gaming\\n\\tPaired: yes\\n\\tBonded: yes\\n\\tTrusted: yes\\n\\tConnected: yes\\n' ;;
      AA:AA:AA:AA:AA:02) printf '\\tAlias: Nameless\\n\\tPaired: yes\\n\\tBonded: no\\n\\tTrusted: no\\n\\tConnected: no\\n' ;;
      AA:AA:AA:AA:AA:03) : ;;
      *) printf '\\tName: Unknown\\n\\tPaired: no\\n' ;;
    esac
    ;;
  show) printf 'Controller 00:11:22:33:44:55 (public)\\n\\tPowered: yes\\n' ;;
  pair) [ -n "$FAKE_BT_PAIR_FAIL" ] && exit 1 ;;
  trust) [ -n "$FAKE_BT_TRUST_FAIL" ] && exit 1 ;;
  connect) [ -n "$FAKE_BT_CONNECT_FAIL" ] && exit 1 ;;
  remove) [ -n "$FAKE_BT_REMOVE_FAIL" ] && exit 1 ;;
  power) [ -n "$FAKE_BT_POWER_FAIL" ] && exit 1 ;;
  --timeout) [ -n "$FAKE_BT_SCAN_FAIL" ] && exit 1 ;;
esac
exit 0
`;

const FAKE_ENV = ["FAKE_BT_DEVICES", "FAKE_BT_DEVICES_FAIL", "FAKE_BT_INFO_FAIL", "FAKE_BT_PAIR_FAIL", "FAKE_BT_TRUST_FAIL", "FAKE_BT_CONNECT_FAIL", "FAKE_BT_REMOVE_FAIL", "FAKE_BT_POWER_FAIL", "FAKE_BT_SCAN_FAIL"];

const calls = (): string[] => (fs.existsSync(logFile) ? fs.readFileSync(logFile, "utf8").split("\n").filter(Boolean) : []);

before(() => {
  if (!posix) return;
  fs.writeFileSync(path.join(dir, "bluetoothctl"), SCRIPT, { mode: 0o755 });
  process.env.PATH = `${dir}${path.delimiter}${originalPath}`;
  process.env.FAKE_BT_LOG = logFile;
});

beforeEach(() => {
  fs.rmSync(logFile, { force: true });
  for (const name of FAKE_ENV) delete process.env[name];
});

after(() => {
  process.env.PATH = originalPath;
  delete process.env.FAKE_BT_LOG;
  for (const name of FAKE_ENV) delete process.env[name];
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

test("the timeouts are bounded and the scan is shorter than the time its call may take", () => {
  assert.ok(BLUETOOTH_SCAN_TIMEOUT_S > 0 && BLUETOOTH_SCAN_TIMEOUT_S <= 30);
  assert.ok(BLUETOOTH_ACTION_TIMEOUT_MS >= 5000 && BLUETOOTH_ACTION_TIMEOUT_MS <= 60000);
});

test("the device list asks for the details of each device and reads every flag", options, async () => {
  process.env.FAKE_BT_DEVICES = "Device AA:AA:AA:AA:AA:01 Xbox Wireless Controller\nDevice AA:AA:AA:AA:AA:02 Nameless pad\nDevice aa:aa:aa:aa:aa:09 lower case\n";
  const devices = await listBluetoothDevices();
  assert.deepEqual(devices, [
    { mac: "AA:AA:AA:AA:AA:01", name: "Xbox Controller", icon: "input-gaming", paired: true, bonded: true, connected: true, trusted: true },
    { mac: "AA:AA:AA:AA:AA:02", name: "Nameless", icon: null, paired: true, bonded: false, connected: false, trusted: false },
    { mac: "aa:aa:aa:aa:aa:09", name: "Unknown", icon: null, paired: false, bonded: false, connected: false, trusted: false },
  ]);
  assert.deepEqual(calls(), ["devices", "info AA:AA:AA:AA:AA:01", "info AA:AA:AA:AA:AA:02", "info aa:aa:aa:aa:aa:09"]);
});

test("a device whose details are empty keeps the name BlueZ listed, and a nameless one falls back to its address", options, async () => {
  process.env.FAKE_BT_DEVICES = "Device AA:AA:AA:AA:AA:03 Listed Name\nDevice AA:AA:AA:AA:AA:04 \n";
  process.env.FAKE_BT_INFO_FAIL = "";
  const devices = await listBluetoothDevices();
  assert.equal(devices[0].name, "Listed Name");
  assert.equal(devices[0].paired, false, "no flag is yes when the details are empty");
  assert.equal(devices[1].mac, "AA:AA:AA:AA:AA:04");
  assert.equal(devices[1].name, "Unknown", "the details of the second one still name it");
});

test("a device that vanished between the list and its details is skipped and the others are kept", options, async () => {
  process.env.FAKE_BT_DEVICES = "Device AA:AA:AA:AA:AA:01 First\nDevice AA:AA:AA:AA:AA:02 Gone\nDevice AA:AA:AA:AA:AA:03 Third\n";
  process.env.FAKE_BT_INFO_FAIL = "AA:AA:AA:AA:AA:02";
  const devices = await listBluetoothDevices();
  assert.deepEqual(devices.map((d) => d.mac), ["AA:AA:AA:AA:AA:01", "AA:AA:AA:AA:AA:03"]);
});

test("lines that are not devices are ignored, and an empty list is an empty array", options, async () => {
  process.env.FAKE_BT_DEVICES = "[CHG] Controller 00:11:22:33:44:55 Discovering: yes\nnoise\nDevice 12:34 too-short\n";
  assert.deepEqual(await listBluetoothDevices(), []);
  assert.deepEqual(calls(), ["devices"], "no details were asked for");
  process.env.FAKE_BT_DEVICES = "";
  assert.deepEqual(await listBluetoothDevices(), []);
});

test("a failing device listing is an error for the caller", options, async () => {
  process.env.FAKE_BT_DEVICES_FAIL = "1";
  await assert.rejects(listBluetoothDevices());
});

test("the status is the raw controller text plus the device list in one call", options, async () => {
  process.env.FAKE_BT_DEVICES = "Device AA:AA:AA:AA:AA:01 Pad\n";
  const status = await getBluetoothStatus();
  assert.match(status.stdout, /Powered: yes/);
  assert.equal(status.devices.length, 1);
  assert.deepEqual(calls().slice(0, 2), ["show", "devices"]);
});

test("power on and off are the exact words, and a failure is an error", options, async () => {
  await setBluetoothPower(true);
  await setBluetoothPower(false);
  assert.deepEqual(calls(), ["power on", "power off"]);
  process.env.FAKE_BT_POWER_FAIL = "1";
  await assert.rejects(setBluetoothPower(true));
});

test("a scan runs for the set number of seconds and then lists the devices", options, async () => {
  process.env.FAKE_BT_DEVICES = "Device AA:AA:AA:AA:AA:01 Pad\n";
  const found = await scanBluetoothDevices();
  assert.equal(found.length, 1);
  assert.equal(calls()[0], `--timeout ${BLUETOOTH_SCAN_TIMEOUT_S} scan on`);
  assert.equal(calls()[1], "devices");
});

test("a failed scan lists nothing and is an error", options, async () => {
  process.env.FAKE_BT_SCAN_FAIL = "1";
  await assert.rejects(scanBluetoothDevices());
  assert.deepEqual(calls(), [`--timeout ${BLUETOOTH_SCAN_TIMEOUT_S} scan on`], "the device list was not asked for");
});

test("pairing goes pair, trust, connect, info in that order and returns what the details say", options, async () => {
  const result = await pairBluetoothDevice("AA:AA:AA:AA:AA:01");
  assert.deepEqual(calls(), ["pair AA:AA:AA:AA:AA:01", "trust AA:AA:AA:AA:AA:01", "connect AA:AA:AA:AA:AA:01", "info AA:AA:AA:AA:AA:01"]);
  assert.equal(result.paired, true);
  assert.equal(result.bonded, true);
  assert.equal(result.name, "Xbox Controller");
});

test("a failed immediate connection does not fail the pairing: a trusted device reconnects on its own", options, async () => {
  process.env.FAKE_BT_CONNECT_FAIL = "1";
  const result = await pairBluetoothDevice("AA:AA:AA:AA:AA:02");
  assert.equal(result.paired, true);
  assert.equal(result.connected, false);
  assert.equal(calls().at(-1), "info AA:AA:AA:AA:AA:02");
});

test("a failed pair stops the handshake before trusting or connecting, and a failed trust stops before connecting", options, async () => {
  process.env.FAKE_BT_PAIR_FAIL = "1";
  await assert.rejects(pairBluetoothDevice("AA:AA:AA:AA:AA:01"));
  assert.deepEqual(calls(), ["pair AA:AA:AA:AA:AA:01"]);
  delete process.env.FAKE_BT_PAIR_FAIL;
  fs.rmSync(logFile, { force: true });
  process.env.FAKE_BT_TRUST_FAIL = "1";
  await assert.rejects(pairBluetoothDevice("AA:AA:AA:AA:AA:01"));
  assert.deepEqual(calls(), ["pair AA:AA:AA:AA:AA:01", "trust AA:AA:AA:AA:AA:01"]);
});

test("the address reaches the program as one argument, never as a shell line", options, async () => {
  const hostile = "AA:AA:AA:AA:AA:01; touch pwned";
  await removeBluetoothDevice(hostile);
  assert.deepEqual(calls(), [`remove ${hostile}`]);
  assert.equal(fs.existsSync(path.join(process.cwd(), "pwned")), false);
  assert.equal(fs.existsSync(path.join(dir, "pwned")), false);
});

test("removing a device sends remove, and a failure is an error", options, async () => {
  await removeBluetoothDevice("AA:AA:AA:AA:AA:01");
  assert.deepEqual(calls(), ["remove AA:AA:AA:AA:AA:01"]);
  process.env.FAKE_BT_REMOVE_FAIL = "1";
  await assert.rejects(removeBluetoothDevice("AA:AA:AA:AA:AA:01"));
});

test("without a bluetoothctl on the machine every call is an error the routes can report", options, async () => {
  process.env.PATH = path.join(dir, "nowhere");
  try {
    await assert.rejects(listBluetoothDevices());
    await assert.rejects(setBluetoothPower(true));
  } finally {
    process.env.PATH = `${dir}${path.delimiter}${originalPath}`;
  }
});
