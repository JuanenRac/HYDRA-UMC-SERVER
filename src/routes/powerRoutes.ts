// =============================================================================
// HYDRA-UMC-SERVER - src/routes/powerRoutes.ts
// Copyright (C) 2026 JuanenRac (Electro Hobby 3D) <electrohobby3d@gmail.com>
// GPL-3.0 - see LICENSE
// =============================================================================
// The loopback-only kiosk power routes, moved out of server.ts unchanged.
import express from "express";
import { execFile } from "child_process";
import { promisify } from "util";
import { loopbackCallerProblem } from "../serverPolicy";

const execFileAsync = promisify(execFile);

export function registerPowerRoutes(app: express.Express): void {
  // Real, deliberately UNauthenticated power controls for THIS device's own
  // kiosk (HYDRA-UMC-OS's install_kiosk.sh) - the shutdown/restart buttons
  // on STUDIO's own pre-login screen (AuthGate.tsx) have to work before an
  // operator standing at the physical touchscreen has logged in at all, the
  // same way a real power button would. Safe specifically because they are
  // gated to loopback callers only: this server's own HTTP listener binds
  // 0.0.0.0 (STUDIO/mobile apps need real LAN reach), so without a loopback
  // check the exact same unauthenticated request from any other device on
  // the network could power off the robot controller. The kiosk's own
  // Chromium runs ON this device (see kiosk-session.sh), so its requests
  // genuinely originate from 127.0.0.1/::1 - nothing else on the LAN can
  // spoof req.socket.remoteAddress.
  function requireLoopbackCaller(req: express.Request, res: express.Response): boolean {
    // loopbackCallerProblem also refuses a proxied request (a reverse proxy or tunnel on this machine would turn every remote request into a loopback one) and a request
    // a web page made from another origin (a plain POST to localhost needs no preflight), so a page open in the kiosk's browser cannot power the cell off.
    const problem = loopbackCallerProblem(req.socket.remoteAddress, req.headers);
    if (problem === null) return true;
    res.status(403).json({ error: problem });
    return false;
  }

  // Responds BEFORE actually executing systemctl: once reboot/poweroff
  // really runs, this process (and the TCP connection carrying the
  // response) can be torn down mid-flight, and a client that never sees a
  // response would show its own confusing network-error state instead of
  // "it's shutting down". Requires the polkit rule
  // HYDRA-UMC-OS/provisioning/polkit/49-hydra-umc-server-power.rules -
  // this service otherwise runs as the unprivileged hydra-umc-server user
  // (NoNewPrivileges, see its own systemd unit) and could not reboot/power
  // off the host on its own.
  async function runPowerAction(action: "reboot" | "poweroff", res: express.Response) {
    res.json({ success: true });
    try {
      await execFileAsync("systemctl", [action]);
    } catch (error) {
      // The response above already went out - this can only ever reach the
      // server's own log now, never a second HTTP response.
      console.error(`[POWER] systemctl ${action} failed:`, error);
    }
  }

  app.post("/api/system/reboot", (req, res) => {
    if (!requireLoopbackCaller(req, res)) return;
    void runPowerAction("reboot", res);
  });

  app.post("/api/system/shutdown", (req, res) => {
    if (!requireLoopbackCaller(req, res)) return;
    void runPowerAction("poweroff", res);
  });
}
