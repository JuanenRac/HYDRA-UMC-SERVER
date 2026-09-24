// =============================================================================
// HYDRA-UMC-SERVER - src/routes/bluetoothRoutes.ts
// Copyright (C) 2026 JuanenRac (Electro Hobby 3D) <electrohobby3d@gmail.com>
// GPL-3.0 - see LICENSE
// =============================================================================
// The /api/system/bluetooth/* routes, moved out of server.ts unchanged. They
// need only the app and the two auth middlewares, so they are registered
// through a small function instead of living inside startServer().
import express from "express";
import {
  BLUETOOTH_MAC_RE,
  getBluetoothStatus,
  pairBluetoothDevice,
  removeBluetoothDevice,
  scanBluetoothDevices,
  setBluetoothPower,
} from "../bluetooth";

type Middleware = (req: any, res: any, next: any) => unknown;

export function registerBluetoothRoutes(app: express.Express, auth: { authenticate: Middleware; requireAdmin: Middleware; industrialLog: (msg: string) => void }): void {
  const { authenticate, requireAdmin, industrialLog } = auth;

  // ---------------------------------------------------------------------
  // Real Bluetooth pairing (Config > Bluetooth in STUDIO) - scans for and
  // pairs a real Bluetooth gamepad (or any other device) directly to this
  // device's own adapter, without SSH. Every call shells out to the real
  // `bluetoothctl` CLI (execFile, no shell) against this host's real
  // BlueZ daemon - see ./bluetooth.ts for that subprocess/parsing logic
  // (extracted the same way kinematics.ts/users.ts already separate real
  // domain logic from route wiring). Unlike the systemctl-backed endpoints
  // above, this needs NO polkit rule: this device's own stock
  // /usr/share/dbus-1/system.d/bluetooth.conf (Debian/Raspberry Pi OS's
  // own default BlueZ policy) already allows any local user to talk to
  // org.bluez, so this runs fine as hydra-umc-server's own unprivileged,
  // NoNewPrivileges account.
  app.get("/api/system/bluetooth/status", authenticate, requireAdmin, async (req, res) => {
    try {
      const { stdout, devices } = await getBluetoothStatus();
      res.json({
        available: true,
        powered: /Powered:\s*yes/.test(stdout),
        discovering: /Discovering:\s*yes/.test(stdout),
        devices,
      });
    } catch {
      res.status(503).json({
        available: false,
        error: "Bluetooth is not available on this device (bluetoothctl failed - no adapter, or bluetoothd is not running).",
      });
    }
  });

  app.post("/api/system/bluetooth/power", authenticate, requireAdmin, async (req, res) => {
    const { on } = req.body || {};
    if (typeof on !== "boolean") return res.status(400).json({ error: "on must be a boolean" });
    try {
      await setBluetoothPower(on);
      industrialLog(`[ADMIN] Bluetooth powered ${on ? "on" : "off"} via Config.`);
      res.json({ success: true });
    } catch {
      res.status(503).json({ error: "Could not change the Bluetooth power state - see this server's own logs." });
    }
  });

  app.post("/api/system/bluetooth/scan", authenticate, requireAdmin, async (req, res) => {
    try {
      const devices = await scanBluetoothDevices();
      industrialLog(`[ADMIN] Bluetooth scan requested via Config - found ${devices.length} device(s).`);
      res.json({ success: true, devices });
    } catch {
      res.status(503).json({ error: "Bluetooth scan failed - see this server's own logs for the real reason." });
    }
  });

  app.post("/api/system/bluetooth/pair", authenticate, requireAdmin, async (req, res) => {
    const { mac } = req.body || {};
    if (typeof mac !== "string" || !BLUETOOTH_MAC_RE.test(mac)) {
      return res.status(400).json({ error: "mac must be a real Bluetooth MAC address (AA:BB:CC:DD:EE:FF)" });
    }
    try {
      const parsed = await pairBluetoothDevice(mac);
      industrialLog(
        `[ADMIN] Bluetooth pair requested via Config for ${mac} (${parsed.name ?? "unknown"}) - paired=${parsed.paired} bonded=${parsed.bonded}.`,
      );
      if (parsed.paired && !parsed.bonded) {
        // Real gap found pairing a physical Xbox controller against a
        // real device: BlueZ's own default ClassicBondedOnly=true
        // (profiles/input/device.c) refuses the HID connection for a
        // device that bonds over LE rather than classic BR/EDR on some
        // hardware (Broadcom BCM4345C0) - `pair`/`trust` both genuinely
        // succeed, but the device is stuck at Paired=yes/Bonded=no
        // forever and never becomes a real /dev/input device. Name the
        // real fix instead of a generic failure, since "paired but not
        // bonded" on its own looks like success at a glance.
        return res.status(503).json({
          error:
            `${parsed.name ?? mac} paired but did not bond - this device likely still has BlueZ's default ` +
            `ClassicBondedOnly=true (see /etc/bluetooth/input.conf; HYDRA-UMC-OS's own first_boot.sh sets it to ` +
            `false). It will never appear as a usable input device until that is fixed and Bluetooth is restarted.`,
          mac,
          name: parsed.name ?? mac,
          paired: true,
          bonded: false,
        });
      }
      res.json({
        success: Boolean(parsed.paired),
        mac,
        name: parsed.name ?? mac,
        paired: parsed.paired ?? false,
        bonded: parsed.bonded ?? false,
        connected: parsed.connected ?? false,
      });
    } catch {
      res.status(503).json({
        error: `Could not pair with ${mac} - it may be out of range or no longer in pairing mode. Scan again and retry.`,
      });
    }
  });

  app.post("/api/system/bluetooth/remove", authenticate, requireAdmin, async (req, res) => {
    const { mac } = req.body || {};
    if (typeof mac !== "string" || !BLUETOOTH_MAC_RE.test(mac)) {
      return res.status(400).json({ error: "mac must be a real Bluetooth MAC address (AA:BB:CC:DD:EE:FF)" });
    }
    try {
      await removeBluetoothDevice(mac);
      industrialLog(`[ADMIN] Bluetooth device ${mac} removed via Config.`);
      res.json({ success: true });
    } catch {
      res.status(503).json({ error: `Could not remove ${mac} - see this server's own logs.` });
    }
  });
}
