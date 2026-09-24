// =============================================================================
// HYDRA-UMC-SERVER - src/systemMetrics.ts
// Copyright (C) 2026 JuanenRac (Electro Hobby 3D) <electrohobby3d@gmail.com>
// GPL-3.0 - see LICENSE
// =============================================================================
// Live host metrics: network interface state, CPU/memory/disk/process
// readouts and the supervisor snapshot. Moved out of server.ts unchanged.

import fs from "fs";
import os from "os";
import { execFile } from "child_process";
import { promisify } from "util";
import { setSystemMetricsSource } from "./metrics";

const execFileAsync = promisify(execFile);

// wifi/ethernet: read from /sys/class/net/<iface>/operstate, Linux-only (real
// on a CM5, absent on Windows/macOS dev machines - null there rather than a
// guess). bluetooth: presence of any /sys/class/bluetooth/hci* controller
// with an "up" state file is the closest cheap signal without a native BLE
// dependency. Each check is independently wrapped so one missing interface
// (e.g. no onboard Wi-Fi) doesn't blank out the other two.
export function readInterfaceUp(iface: string): boolean | null {
  try {
    const state = fs.readFileSync(`/sys/class/net/${iface}/operstate`, "utf-8").trim();
    return state === "up";
  } catch {
    return null;
  }
}

export function readBluetoothUp(): boolean | null {
  try {
    const controllers = fs.readdirSync("/sys/class/bluetooth").filter(n => n.startsWith("hci"));
    if (controllers.length === 0) return null;
    return controllers.some(c => {
      try { return fs.readFileSync(`/sys/class/bluetooth/${c}/../../power/runtime_status`, "utf-8").trim() !== "suspended"; }
      catch { return true; } // controller present but state file layout differs by kernel - assume present means available
    });
  } catch {
    return null;
  }
}

// RP1 (the CM5/Pi 5 family's own I/O controller chip - USB, Ethernet,
// GPIO) exposes its own real temperature sensor via the standard Linux
// hwmon framework, independent of vcgencmd's SoC-only reading above. There
// is no fixed hwmonN index - it depends on registration order - so this
// finds it by its own real driver name ("rp1_adc") rather than assuming a
// number. Returns null (not a mock) on any older Pi/non-Pi host: unlike
// the SoC itself, RP1 is real hardware that simply doesn't exist there,
// not a value this host merely can't currently read.
export function readRp1Temp(): number | null {
  try {
    const hwmonRoot = "/sys/class/hwmon";
    for (const entry of fs.readdirSync(hwmonRoot)) {
      const namePath = `${hwmonRoot}/${entry}/name`;
      let name: string;
      try { name = fs.readFileSync(namePath, "utf-8").trim(); } catch { continue; }
      if (name !== "rp1_adc") continue;
      const raw = fs.readFileSync(`${hwmonRoot}/${entry}/temp1_input`, "utf-8").trim();
      const millideg = parseInt(raw, 10);
      if (Number.isNaN(millideg)) return null;
      return Math.round((millideg / 1000) * 10) / 10; // millidegC -> degC, 1dp
    }
    return null;
  } catch {
    return null;
  }
}

// Cumulative RX/TX byte counters for one interface, straight from the
// standard Linux sysfs statistics files - the kernel itself accumulates
// these from the moment the interface is registered (effectively "since
// boot" for wlan0/eth0 on a real CM5 deployment that never manually
// resets its network stack) with no polling/sampling of our own needed,
// same "real sysfs read, honest null on any other host" convention as
// readInterfaceUp/readRp1Temp above. Returns null (not 0) when the
// interface doesn't exist on this host at all - a genuinely absent
// interface must never look like one that exists with zero traffic.
export function readInterfaceBytes(iface: string): { rxBytes: number; txBytes: number } | null {
  try {
    const rxBytes = parseInt(fs.readFileSync(`/sys/class/net/${iface}/statistics/rx_bytes`, "utf-8").trim(), 10);
    const txBytes = parseInt(fs.readFileSync(`/sys/class/net/${iface}/statistics/tx_bytes`, "utf-8").trim(), 10);
    if (!Number.isFinite(rxBytes) || !Number.isFinite(txBytes)) return null;
    return { rxBytes, txBytes };
  } catch {
    return null; // interface doesn't exist on this host (no onboard Wi-Fi, non-Linux dev machine, ...)
  }
}

// Real per-interface cumulative traffic for the Supervisor panel's data-flow
// graphs (STUDIO/SUITE, "extras a discrecion" feature request) - only the
// interfaces this host actually has get a real reading; the rest stay null
// rather than a fabricated 0, matching readNetworkStatus()'s existing
// wifi/ethernet/bluetooth presence checks. Bluetooth has no standard sysfs
// byte-counter equivalent (unlike a real net_device, an hci controller
// doesn't expose /sys/class/bluetooth/hciN/statistics/*) - reported as null
// rather than approximated from some other signal, an honest gap tracked in
// this repo's own CHANGELOG/backlog rather than silently guessed at.
export function readNetworkTraffic() {
  return {
    wifi: readInterfaceBytes("wlan0"),
    ethernet: readInterfaceBytes("eth0"),
    bluetooth: null as { rxBytes: number; txBytes: number } | null,
  };
}

export function readNetworkStatus() {
  return {
    wifi: readInterfaceUp("wlan0"),
    ethernet: readInterfaceUp("eth0"),
    bluetooth: readBluetoothUp(),
    traffic: readNetworkTraffic(),
  };
}

// =============================================================================
// Supervisor (GET /api/system/supervisor) - a real, Netdata-style deep-dive
// into this host's own live resource usage, distinct from the lighter
// GET /api/system/metrics above (Overview footer's own coarse CPU/mem/temp
// readout). Per-core CPU % needs a delta between two os.cpus() samples -
// rather than block each HTTP request on a two-sample window (os.cpus()
// timings only update roughly once a scheduler tick, so a request-scoped
// delta would need an artificial sleep), a 1s background interval keeps a
// rolling "current %" always ready to serve instantly, the same tradeoff
// Netdata itself makes (a fixed collector interval, not per-request
// sampling). Every value here is real - a field this host genuinely cannot
// read (e.g. per-core frequency on a non-Linux dev box) is null, never a
// mocked number, unlike vcgencmd's temp reading above (which mocks
// specifically because "no CPU temperature at all" would be a confusing
// gap in an otherwise-always-present field on a industrial monitoring
// dashboard - the supervisor's own fields don't have that same precedent,
// so they stay honestly absent instead).
// =============================================================================

export interface CpuUsageSample {
  overallPercent: number;
  perCorePercent: number[];
}

export let lastCpuTimes: os.CpuInfo[] | null = null;
export let lastCpuUsage: CpuUsageSample = { overallPercent: 0, perCorePercent: [] };

export function sampleCpuUsage(): void {
  const cpus = os.cpus();
  if (lastCpuTimes && lastCpuTimes.length === cpus.length) {
    const perCorePercent = cpus.map((cpu, i) => {
      const prev = lastCpuTimes![i].times;
      const cur = cpu.times;
      const prevTotal = prev.user + prev.nice + prev.sys + prev.idle + prev.irq;
      const curTotal = cur.user + cur.nice + cur.sys + cur.idle + cur.irq;
      const totalDelta = curTotal - prevTotal;
      const idleDelta = cur.idle - prev.idle;
      if (totalDelta <= 0) return 0;
      return Math.round((1 - idleDelta / totalDelta) * 1000) / 10;
    });
    const overallPercent = perCorePercent.length
      ? Math.round((perCorePercent.reduce((a, b) => a + b, 0) / perCorePercent.length) * 10) / 10
      : 0;
    lastCpuUsage = { overallPercent, perCorePercent };
  }
  lastCpuTimes = cpus;
}
sampleCpuUsage(); // primes lastCpuTimes immediately - first real delta lands on the next interval tick, 1s later
export const cpuSampleInterval = setInterval(sampleCpuUsage, 1000);
cpuSampleInterval.unref(); // never keeps the process alive on its own (matches every other setInterval in this file)

// Per-core clock speed - Linux-only (/sys/devices/system/cpu/cpuN/cpufreq),
// absent on this file's own Windows dev machine and on any CM5 running a
// governor/kernel build without cpufreq exposed - null per core rather than
// guessing from a nominal spec.
export function readCpuFrequenciesMHz(coreCount: number): (number | null)[] {
  const out: (number | null)[] = [];
  for (let i = 0; i < coreCount; i++) {
    try {
      const khz = fs.readFileSync(`/sys/devices/system/cpu/cpu${i}/cpufreq/scaling_cur_freq`, "utf-8").trim();
      const val = parseInt(khz, 10);
      out.push(Number.isFinite(val) ? Math.round(val / 1000) : null);
    } catch {
      out.push(null);
    }
  }
  return out;
}

// Real /proc/meminfo parse (Linux-only) - kB fields converted to bytes.
// os.freemem()/totalmem() (used by the lighter /api/system/metrics above)
// only ever gives 2 coarse numbers; this gives the actual breakdown a
// Netdata-style memory panel needs (buffers/cache counted separately from
// "used", matching how `free -h` itself reports it - naively treating
// buffers/cache as "used" is the classic wrong-looking-full-RAM mistake).
export interface MemoryInfo {
  totalBytes: number; usedBytes: number; freeBytes: number; availableBytes: number;
  buffersBytes: number; cachedBytes: number; swapTotalBytes: number; swapUsedBytes: number;
}
export function readMemoryInfo(): MemoryInfo | null {
  try {
    const text = fs.readFileSync("/proc/meminfo", "utf-8");
    const kb = (key: string): number => {
      const m = text.match(new RegExp(`^${key}:\\s+(\\d+)`, "m"));
      return m ? parseInt(m[1], 10) * 1024 : 0;
    };
    const totalBytes = kb("MemTotal");
    const freeBytes = kb("MemFree");
    const availableBytes = kb("MemAvailable") || freeBytes;
    const buffersBytes = kb("Buffers");
    const cachedBytes = kb("Cached");
    const swapTotalBytes = kb("SwapTotal");
    const swapFreeBytes = kb("SwapFree");
    return {
      totalBytes,
      usedBytes: Math.max(0, totalBytes - availableBytes),
      freeBytes,
      availableBytes,
      buffersBytes,
      cachedBytes,
      swapTotalBytes,
      swapUsedBytes: Math.max(0, swapTotalBytes - swapFreeBytes),
    };
  } catch {
    return null; // non-Linux host (this file's own Windows dev machine, most CI runners)
  }
}

// Real root-filesystem (the CM5's own eMMC/SD "flash") usage via `df`,
// matching this file's own vcgencmd/ps convention: execFile (async, no
// shell, no injection surface - fixed literal args), mock-free null on
// failure rather than a guessed number.
export interface DiskInfo { totalBytes: number; usedBytes: number; freeBytes: number; mount: string }
export async function readDiskUsage(): Promise<DiskInfo | null> {
  try {
    const { stdout } = await execFileAsync("df", ["-k", "-P", "/"], { timeout: 1000 });
    const line = stdout.trim().split("\n")[1];
    const parts = line.trim().split(/\s+/);
    // Filesystem 1024-blocks Used Available Capacity Mounted-on
    const totalBytes = parseInt(parts[1], 10) * 1024;
    const usedBytes = parseInt(parts[2], 10) * 1024;
    const freeBytes = parseInt(parts[3], 10) * 1024;
    if (![totalBytes, usedBytes, freeBytes].every(Number.isFinite)) return null;
    return { totalBytes, usedBytes, freeBytes, mount: parts[5] || "/" };
  } catch {
    return null; // `df` not on PATH (Windows dev machine) or the read failed
  }
}

// Real top-N processes by CPU%, via `ps` (same execFile convention as
// above) - name only, no full command line/args, matching this endpoint's
// own "no auth, but don't leak more than coarse host introspection" trust
// tier (see this route's own registration comment).
export interface ProcessInfo { pid: number; name: string; cpuPercent: number; memPercent: number; rssBytes: number }
export async function readTopProcesses(limit: number): Promise<ProcessInfo[]> {
  try {
    const { stdout } = await execFileAsync(
      "ps", ["-eo", "pid,comm,%cpu,%mem,rss", "--sort=-%cpu", "--no-headers"],
      { timeout: 1000, maxBuffer: 1024 * 1024 },
    );
    return stdout
      .trim()
      .split("\n")
      .slice(0, limit)
      .map((line) => {
        const parts = line.trim().split(/\s+/);
        return {
          pid: parseInt(parts[0], 10),
          name: parts[1] || "?",
          cpuPercent: parseFloat(parts[2]) || 0,
          memPercent: parseFloat(parts[3]) || 0,
          rssBytes: (parseInt(parts[4], 10) || 0) * 1024, // ps reports rss in kB
        };
      })
      .filter((p) => Number.isFinite(p.pid));
  } catch {
    return []; // `ps --sort` isn't POSIX (BSD/macOS ps rejects it) or ps isn't on PATH
  }
}

export async function getSupervisorSnapshot() {
  const cpus = os.cpus();
  const [disk, processes] = await Promise.all([readDiskUsage(), readTopProcesses(20)]);
  let cpuTemp: number | null = null;
  let cpuTempIsReal = false;
  try {
    const { stdout } = await execFileAsync("vcgencmd", ["measure_temp"], { timeout: 500 });
    const match = stdout.match(/temp=([\d.]+)/);
    if (match) { cpuTemp = parseFloat(match[1]); cpuTempIsReal = true; }
  } catch {
    cpuTemp = null; // honest here, unlike getSystemMetrics()'s mocked fallback - see this section's own header comment
  }
  return {
    timestamp: Date.now(),
    cpu: {
      model: cpus[0]?.model || null,
      coreCount: cpus.length,
      overallPercent: lastCpuUsage.overallPercent,
      perCorePercent: lastCpuUsage.perCorePercent,
      perCoreFrequencyMHz: readCpuFrequenciesMHz(cpus.length),
      loadAvg: os.loadavg(),
    },
    memory: readMemoryInfo(),
    disk,
    temps: {
      cpu: cpuTemp,
      cpuIsReal: cpuTempIsReal,
      rp1: readRp1Temp(),
    },
    processes,
    uptimeSeconds: Math.round(os.uptime()),
    network: readNetworkStatus(),
  };
}

// Shared by GET /api/system/metrics (unchanged wire shape - the browser
// UI's own StatusFooter) and GET /metrics (src/metrics.ts's own
// hydra_system_* Prometheus gauges, wired up via setSystemMetricsSource()
// below) - pulled out of the route handler it used to live in directly so
// both call sites do the exact same vcgencmd read computation instead of
// two copies drifting apart. See the original inline comment (now here)
// for why this is execFile (async, no shell) and not execSync.
export async function getSystemMetrics(): Promise<{
  cpu_load: number;
  memory_usage: number;
  temp: number | null;
  temp_is_real: boolean;
  rp1_temp: number | null;
  uptime: number;
  network: ReturnType<typeof readNetworkStatus>;
}> {
  // Real read on a CM5/Pi host; throws (command not found) on any other OS,
  // in which case we fall back to a clearly-mocked value rather than lie.
  // execFile (async, no shell) instead of the old execSync: a synchronous
  // call here stalled the ENTIRE event loop - every other in-flight
  // request and every open WebSocket's message handling on this
  // single-threaded server - for as long as vcgencmd took to answer, up
  // to the 500ms timeout below if it ever hung (and this route can be
  // polled every few seconds by the dashboard's own status footer, and now
  // also by a Prometheus scrape on its own interval). execFile also never
  // spawns a shell to parse the command line, so there's no
  // shell-metacharacter injection surface even in principle - moot today
  // since "vcgencmd"/"measure_temp" are fixed literals with no
  // interpolated input, but a strictly safer default regardless.
  let temp: number | null = null;
  let tempIsReal = false;
  try {
    const { stdout } = await execFileAsync("vcgencmd", ["measure_temp"], { timeout: 500 });
    const match = stdout.match(/temp=([\d.]+)/);
    if (match) { temp = parseFloat(match[1]); tempIsReal = true; }
  } catch {
    temp = 45 + Math.random() * 10; // Mock - vcgencmd isn't available on this host (not a Pi, or dev machine)
  }

  // cpu_load/memory_usage reuse the exact same real sources GET
  // /api/system/supervisor computes from (lastCpuUsage's delta-sampled
  // os.cpus() busy%, readMemoryInfo()'s /proc/meminfo MemAvailable-based
  // used%) - this used to be its own independent formula
  // (os.loadavg()[0]*10, a 1-minute load-average heuristic that isn't a
  // percentage at all, and raw freemem() which double-counts reclaimable
  // page cache as "used"), which is exactly why the footer and the
  // Supervisor panel could show two different numbers for what a user
  // reasonably expects to be the same "CPU load" - real feedback: 21% in
  // the Supervisor vs 9% in the footer for the same instant. One real
  // measurement now, read from two places, never two competing guesses.
  const memInfo = readMemoryInfo();
  return {
    cpu_load: Math.round(lastCpuUsage.overallPercent),
    memory_usage: memInfo
      ? Math.round((memInfo.usedBytes / memInfo.totalBytes) * 100)
      : Math.round((1 - os.freemem() / os.totalmem()) * 100), // non-Linux fallback, no /proc/meminfo to read
    temp,
    temp_is_real: tempIsReal,
    rp1_temp: readRp1Temp(),
    uptime: Math.round(process.uptime()),
    network: readNetworkStatus(),
  };
}

// Registered once, at module load - independent of startServer()'s own
// local state, unlike setWsClientsSource() below which has to wait for
// wsClients to exist.
setSystemMetricsSource(getSystemMetrics);
