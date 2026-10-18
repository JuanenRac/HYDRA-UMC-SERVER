import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import { test } from "node:test";
import { BLUETOOTH_MAC_RE, parseBluetoothctlInfo } from "../src/bluetooth.ts";
import { probeHttp, probeService, probeTcp } from "../src/ecosystemStatus.ts";

test("parseBluetoothctlInfo reads every flag from a real bluetoothctl info block", () => {
  const info = parseBluetoothctlInfo(
    "Device AA:BB:CC:DD:EE:FF (public)\n\tName: Gamepad\n\tAlias: Pad\n\tIcon: input-gaming\n\tPaired: yes\n\tBonded: yes\n\tTrusted: no\n\tConnected: yes\n"
  );
  assert.deepEqual(info, { name: "Gamepad", icon: "input-gaming", paired: true, bonded: true, connected: true, trusted: false });
});

test("parseBluetoothctlInfo falls back to Alias, defaults flags to false and tolerates empty output", () => {
  assert.equal(parseBluetoothctlInfo("\tAlias: Only Alias\n").name, "Only Alias");
  const empty = parseBluetoothctlInfo("");
  assert.equal(empty.name, undefined);
  assert.equal(empty.icon, null);
  assert.equal(empty.paired, false);
  assert.equal(empty.connected, false);
});

test("parseBluetoothctlInfo ignores a flag value that is not exactly yes", () => {
  assert.equal(parseBluetoothctlInfo("Paired: Yes\nTrusted: yes please\n").paired, false);
});

test("BLUETOOTH_MAC_RE accepts only a full colon-separated MAC (no option or shell injection)", () => {
  assert.ok(BLUETOOTH_MAC_RE.test("aa:bb:cc:dd:ee:ff"));
  assert.ok(BLUETOOTH_MAC_RE.test("AA:BB:CC:DD:EE:FF"));
  for (const bad of ["", "aa:bb:cc:dd:ee", "aa:bb:cc:dd:ee:ff:00", "aa-bb-cc-dd-ee-ff", "aa:bb:cc:dd:ee:fg", "aa:bb:cc:dd:ee:ff; reboot", "-h", "aa:bb:cc:dd:ee:ff\n"]) {
    assert.equal(BLUETOOTH_MAC_RE.test(bad), false, JSON.stringify(bad));
  }
});

test("probeTcp is true for a listening port and false for a closed one", async () => {
  const server = net.createServer();
  const port: number = await new Promise((r) => server.listen(0, "127.0.0.1", () => r((server.address() as net.AddressInfo).port)));
  assert.equal(await probeTcp(port), true);
  await new Promise<void>((r) => server.close(() => r()));
  assert.equal(await probeTcp(port), false);
});

test("probeHttp is true only for 2xx and false for 3xx, 4xx, 5xx and a closed port", async () => {
  const server = http.createServer((req, res) => {
    res.writeHead(req.url === "/ok" ? 204 : req.url === "/redirect" ? 302 : req.url === "/boom" ? 500 : 404);
    res.end();
  });
  const port: number = await new Promise((r) => server.listen(0, "127.0.0.1", () => r((server.address() as net.AddressInfo).port)));
  try {
    assert.equal(await probeHttp(port, "/ok"), true);
    assert.equal(await probeHttp(port, "/missing"), false);
    assert.equal(await probeHttp(port, "/boom"), false);
    assert.equal(await probeHttp(port, "/redirect"), false);
    assert.equal(await probeService(port, "/ok"), true, "a health path selects the HTTP probe");
    assert.equal(await probeService(port, null), true, "no health path selects the TCP probe");
  } finally {
    await new Promise<void>((r) => { server.close(() => r()); server.closeAllConnections(); });
  }
  assert.equal(await probeHttp(port, "/ok"), false);
});
