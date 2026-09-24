// =============================================================================
// HYDRA-UMC-SERVER - src/ecosystemStatus.ts
// Copyright (C) 2026 JuanenRac (Electro Hobby 3D) <electrohobby3d@gmail.com>
// GPL-3.0 - see LICENSE
// =============================================================================
// Ecosystem discovery and liveness: where the sibling checkouts live, the
// TCP/HTTP/systemd probes and the per-project status scan. Moved out of
// server.ts unchanged.

import fs from "fs";
import http from "http";
import net from "net";
import path from "path";
import { execFile } from "child_process";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

// Real, honest V0 - most of the wider ecosystem's repos are source
// checkouts under active development, not deployed network services, so
// this can't and doesn't pretend every one of them has a live green/red
// bulb. What genuinely exists: every HYDRA-UMC/URTC repo self-describes
// itself in its own hydra-umc.project.json (schema_version/name/role/
// stack/maturity/family/deployment_target/version - see the dashboard/
// updater tools' own dynamic-manifest-discovery pattern, which this
// mirrors server-side instead of duplicating a static catalog a third
// time). This scans this process's own parent directory (matches how
// every real HYDRA-UMC-SERVER instance is actually launched today - from
// inside its own checkout, sibling to every other repo on the SAME
// dev/staging machine) for that same manifest file in each immediate
// subdirectory, server carries this work per the ecosystem's own
// standing principle (clients like Android/STUDIO stay thin frontends of
// whatever server exposes, not scanners of their own). Deliberately
// gives up cleanly (available: false, not a thrown error) when siblings
// aren't there to find - a real future CM5 deployment won't have 49
// other repos checked out next to it, and this must never crash startup
// or a real request over that.
//
// On top of that static scan, a repo whose manifest opts in with a real
// `service` object ({port, health_path?}) gets a REAL live probe (see
// probeService() below) - a genuine TCP connect, or an HTTP GET expecting
// 2xx when health_path is declared - run concurrently against every
// declared sibling on this same host. `live` is `null` for every project
// that doesn't declare one (a library/CLI/firmware/UI - "not applicable",
// never shown as down for something it was never meant to do), and a
// real `true`/`false` for one that does. This is the real, per-service
// "green bulb / red bulb" clients like the Android app's Ecosystem tab
// read - not just a maturity label.
// Real per-service liveness probe - the "Integración real entre proyectos"
// gap this whole endpoint exists to close: a manifest saying "maturity:
// established" is a claim, not a fact about whether that process is
// actually up right now. A repo only gets probed if its own manifest
// opts in with a real `service` object ({port, health_path?}) - see
// HYDRA-UMC-UPDATER's project_manifest.py for the schema this reads.
// `health_path` present means a real HTTP GET expecting 2xx; absent
// means a bare TCP connect is enough (a raw protocol like MQTT/OPC-UA
// that doesn't speak HTTP). Every sibling is assumed to run on this same
// host (127.0.0.1) - true for every real deployment today (one dev
// machine, or eventually one CM5), and the same assumption this
// endpoint's own manifest-scan already makes by only looking at the
// immediate parent directory.
export const SERVICE_PROBE_TIMEOUT_MS = 800;
export const SERVICE_PROBE_HOST = "127.0.0.1";

export function probeTcp(port: number, host: string = SERVICE_PROBE_HOST): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port });
    const timer = setTimeout(() => {
      socket.destroy();
      resolve(false);
    }, SERVICE_PROBE_TIMEOUT_MS);
    socket.once("connect", () => {
      clearTimeout(timer);
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => {
      clearTimeout(timer);
      resolve(false);
    });
  });
}

export function probeHttp(port: number, healthPath: string): Promise<boolean> {
  return new Promise((resolve) => {
    const req = http.get(
      { host: SERVICE_PROBE_HOST, port, path: healthPath, timeout: SERVICE_PROBE_TIMEOUT_MS },
      (res) => {
        const ok = typeof res.statusCode === "number" && res.statusCode >= 200 && res.statusCode < 300;
        res.resume(); // drain so the socket can close cleanly, we don't need the body
        resolve(ok);
      }
    );
    req.on("timeout", () => req.destroy());
    req.on("error", () => resolve(false));
  });
}

export function probeService(port: number, healthPath: string | null): Promise<boolean> {
  return healthPath ? probeHttp(port, healthPath) : probeTcp(port);
}


// Where every sibling HYDRA-UMC-* repo checkout actually lives - shared by
// getEcosystemStatus() (below) and the camera-process supervisor
// (reconcileCameraProcesses(), inside startServer()), which needs it to
// locate HYDRA-UMC-VISION-STREAMER's own installed console script. Real
// bug this env var exists to fix, reproduced on the CM5: `../` from
// process.cwd() is correct for local dev (every HYDRA-UMC-* repo checked
// out flat next to this one), but a real CM5 deployment's own
// WorkingDirectory is /opt/hydra-umc/server, whose parent holds only
// build ARTIFACTS, not full source checkouts - HYDRA_UMC_ECOSYSTEM_ROOT
// lets a real deployment point this at wherever its own checkouts
// actually live; unset (every existing dev setup) keeps `../`.
export function ecosystemRoot(): string {
  return process.env.HYDRA_UMC_ECOSYSTEM_ROOT
    ? path.resolve(process.env.HYDRA_UMC_ECOSYSTEM_ROOT)
    : path.resolve(process.cwd(), "..");
}

// Real installed console script (`[project.scripts]` in that repo's own
// pyproject.toml) inside HYDRA-UMC-VISION-STREAMER's own `.venv` -
// Windows and Linux/CM5 use different real layouts for this
// (`.venv/Scripts/*.exe` vs `.venv/bin/*`), same distinction every
// per-platform path in this ecosystem already has to make. The
// CONTAINING directory name is resolved dynamically via each sibling's
// own `hydra-umc.project.json` `name` field (same real
// manifest-driven-discovery this file's own getEcosystemStatus() already
// uses) rather than a
// hardcoded `"HYDRA-UMC-VISION-STREAMER"` literal - a real CM5
// deployment's own directory naming (`/opt/hydra-umc/vision-streamer`,
// no prefix, matching every other service under `/opt/hydra-umc/`)
// doesn't match the Windows dev sibling-checkout convention this
// literal used to assume, and silently never found it there. Falls back
// to the literal sibling-checkout name if no manifest match is found
// (keeps working unmodified for the one dev layout that never had this
// problem in the first place).
export function visionStreamerExecutablePath(): string {
  const root = ecosystemRoot();
  let repoDir = path.join(root, "HYDRA-UMC-VISION-STREAMER");
  try {
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const manifestPath = path.join(root, entry.name, "hydra-umc.project.json");
      if (!fs.existsSync(manifestPath)) continue;
      const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));
      if (manifest?.name === "HYDRA-UMC-VISION-STREAMER") {
        repoDir = path.join(root, entry.name);
        break;
      }
    }
  } catch {
    // real read/parse failure scanning siblings - fall through to the
    // literal-name default above rather than throwing out of a path
    // resolution helper.
  }
  return process.platform === "win32"
    ? path.join(repoDir, ".venv", "Scripts", "hydra-umc-vision-streamer.exe")
    : path.join(repoDir, ".venv", "bin", "hydra-umc-vision-streamer");
}

export interface SystemdProbeResult {
  pid: number | null;
  activeState: string | null;
  subState: string | null;
}

// Real, tested (against the actual CM5 systemd manager, not guessed):
// `systemctl show <unit> --property=...` is a read-only query that the
// unprivileged hydra-umc-server user can run for ANY unit, not just its
// own - no polkit rule needed (unlike runPowerAction's reboot/poweroff
// above, a genuinely privileged action). A unit that doesn't exist
// answers MainPID=0/ActiveState=inactive/SubState=dead with exit 0
// rather than an error - indistinguishable here from "exists but
// stopped", which is an honest, acceptable limit of `show` alone.
export async function probeSystemd(unit: string): Promise<SystemdProbeResult> {
  try {
    const { stdout } = await execFileAsync(
      "systemctl",
      ["show", unit, "--property=MainPID,ActiveState,SubState"],
      { timeout: SERVICE_PROBE_TIMEOUT_MS }
    );
    const props: Record<string, string> = {};
    for (const line of stdout.split("\n")) {
      const eq = line.indexOf("=");
      if (eq === -1) continue;
      props[line.slice(0, eq)] = line.slice(eq + 1).trim();
    }
    const pid = Number.parseInt(props.MainPID ?? "", 10);
    return {
      pid: Number.isFinite(pid) && pid > 0 ? pid : null,
      activeState: props.ActiveState || null,
      subState: props.SubState || null,
    };
  } catch {
    // systemctl itself missing/unreachable (e.g. running this repo's own
    // test suite, or a non-systemd dev machine) - not an error worth
    // failing the whole scan over, just "no systemd info for this one".
    return { pid: null, activeState: null, subState: null };
  }
}

export interface EcosystemProjectStatus {
  name: string;
  role: string | null;
  stack: string | null;
  maturity: string | null;
  family: string | null;
  version: string | null;
  deploymentTarget: string | null;
  servicePort: number | null;
  serviceHealthPath: string | null;
  // The fixed local probe host (127.0.0.1) whenever servicePort is set -
  // every real probe in this scan is local-only, never a remote address.
  serviceHost: string | null;
  // Real feedback from live testing: most running services on the CM5
  // don't declare a TCP/HTTP service.port at all (their manifest never
  // claimed one - many are CLI/library-shaped, not network services), so
  // `live` alone left them looking indistinguishable from "not running".
  // service.systemd_unit (optional manifest field) names the real
  // systemd unit managing this project, if any - independent of whether
  // it exposes a port, giving those exact projects a real, honest signal
  // instead of none.
  systemdUnit: string | null;
  pid: number | null;
  activeState: string | null;
  subState: string | null;
  // null = this project doesn't declare a service (a library/CLI/
  // firmware/UI - "not applicable", never shown as down). true/false =
  // a real probe actually ran and this is its result.
  live: boolean | null;
}

export async function getEcosystemStatus(): Promise<{
  available: boolean;
  scannedAt: string;
  projects: EcosystemProjectStatus[];
}> {
  const scannedAt = new Date().toISOString();
  try {
    const parentDir = ecosystemRoot();
    const entries = fs.readdirSync(parentDir, { withFileTypes: true });
    const projects: EcosystemProjectStatus[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const manifestPath = path.join(parentDir, entry.name, "hydra-umc.project.json");
      if (!fs.existsSync(manifestPath)) continue;
      try {
        const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));
        const service = manifest.service;
        const servicePort =
          service && typeof service === "object" && Number.isInteger(service.port) && service.port > 0 && service.port <= 65535
            ? service.port
            : null;
        const serviceHealthPath =
          servicePort !== null && typeof service.health_path === "string" && service.health_path.startsWith("/")
            ? service.health_path
            : null;
        const systemdUnit =
          service && typeof service === "object" && typeof service.systemd_unit === "string" && service.systemd_unit.trim()
            ? service.systemd_unit.trim()
            : null;
        projects.push({
          name: typeof manifest.name === "string" ? manifest.name : entry.name,
          role: typeof manifest.role === "string" ? manifest.role : null,
          stack: typeof manifest.stack === "string" ? manifest.stack : null,
          maturity: typeof manifest.maturity === "string" ? manifest.maturity : null,
          family: typeof manifest.family === "string" ? manifest.family : null,
          version: typeof manifest.version === "string" ? manifest.version : null,
          deploymentTarget: typeof manifest.deployment_target === "string" ? manifest.deployment_target : null,
          servicePort,
          serviceHealthPath,
          serviceHost: servicePort !== null ? SERVICE_PROBE_HOST : null,
          systemdUnit,
          pid: null, // filled in below, after every manifest is read - a probe is real I/O, keep it out of this synchronous scan
          activeState: null,
          subState: null,
          live: null,
        });
      } catch {
        // Malformed/unreadable manifest for this one repo - skip it, not
        // the whole scan (one repo mid-edit shouldn't hide every other
        // one's real status).
      }
    }
    // Real probes run concurrently (not one-by-one) so N declared services
    // cost one SERVICE_PROBE_TIMEOUT_MS window total, not N of them. A
    // project can have EITHER, both, or neither of servicePort/systemdUnit
    // declared - each probe runs independently of the other.
    await Promise.all(
      projects.map(async (project) => {
        const tasks: Promise<void>[] = [];
        if (project.servicePort !== null) {
          tasks.push(
            probeService(project.servicePort, project.serviceHealthPath).then((live) => { project.live = live; })
          );
        }
        if (project.systemdUnit !== null) {
          tasks.push(
            probeSystemd(project.systemdUnit).then((result) => {
              project.pid = result.pid;
              project.activeState = result.activeState;
              project.subState = result.subState;
            })
          );
        }
        await Promise.all(tasks);
      })
    );
    projects.sort((a, b) => (a.family || "").localeCompare(b.family || "") || a.name.localeCompare(b.name));
    return { available: true, scannedAt, projects };
  } catch {
    return { available: false, scannedAt, projects: [] };
  }
}
