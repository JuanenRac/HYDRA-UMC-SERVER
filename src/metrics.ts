// =============================================================================
// HYDRA-UMC SERVER - Prometheus Metrics: src/metrics.ts
// Copyright (C) 2026 JuanenRac (Electro Hobby 3D) <electrohobby3d@gmail.com>
// GPL-3.0 - see LICENSE
//
// Backs GET /metrics in server.ts (Prometheus text exposition format, via
// the de-facto standard `prom-client` library - no hand-rolled format).
// Kept in its own module the same way kinematics.ts/users.ts are: server.ts
// wires this up by calling the two setSource() functions below once the
// state they read from (the WebSocket client Set, the vcgencmd-backed
// system-metrics reader) actually exists inside startServer(), while every
// counter/histogram is imported and used directly at the real call site
// (the /api/robot/:id/command handler, queueSettingsWrite, authenticate()).
//
// See monitoring/README.md for how to actually scrape this with a real
// Prometheus + Grafana stack (docker compose, same folder).
// =============================================================================

import client from "prom-client";

export const registry = new client.Registry();

// Free, standard Node.js process/runtime metrics (heap, event loop lag, GC
// pauses, open file descriptors, process_cpu_seconds_total...) on top of the
// hand-picked hydra_* metrics below - genuinely useful for spotting a memory
// leak or event-loop stall on a CM5 that's been up for weeks, and costs
// nothing to add. Prefixed so it can never collide with an hydra_* name.
client.collectDefaultMetrics({ register: registry, prefix: "hydra_nodejs_" });

// -----------------------------------------------------------------------
// Process uptime
// -----------------------------------------------------------------------
// A dedicated gauge rather than relying on Prometheus deriving it from
// collectDefaultMetrics' own process_start_time_seconds (time() - that) -
// simpler to read directly in Grafana without a promql subtraction, and
// matches the same `Math.round(process.uptime())` GET /api/hydra-info and
// GET /api/system/metrics already report over REST.
new client.Gauge({
  name: "hydra_process_uptime_seconds",
  help: "Seconds since this HYDRA-UMC SERVER process started",
  registers: [registry],
  collect() {
    this.set(process.uptime());
  },
});

// -----------------------------------------------------------------------
// WebSocket clients connected
// -----------------------------------------------------------------------
// wsClients (the live Set<WebSocket>) is created inside startServer(), not
// at module load time - this module can't import it directly without a
// circular dependency. setWsClientsSource() lets server.ts register a
// cheap `() => wsClients.size` getter once, read lazily on every /metrics
// scrape via this gauge's own collect() rather than needing a value pushed
// in on every connect/disconnect.
let wsClientsSource: (() => number) | null = null;
export function setWsClientsSource(getSize: () => number): void {
  wsClientsSource = getSize;
}

new client.Gauge({
  name: "hydra_ws_clients_connected",
  help: "Number of currently connected WebSocket clients (the browser UI plus any remote apps: HYDRA-UMC SUITE, Android, iOS)",
  registers: [registry],
  collect() {
    this.set(wsClientsSource ? wsClientsSource() : 0);
  },
});

// -----------------------------------------------------------------------
// settings.json write latency
// -----------------------------------------------------------------------
// Observed around the real fs.promises.writeFile()+rename() pair inside
// queueSettingsWrite() in server.ts - the one place EVERY write to
// settings.json actually goes through (POST /api/settings, the atomic
// POST /api/robot/:id/command, and the WS "settings" message all funnel
// through that same queue). Bucketed for a local disk write (sub-second),
// not a network call - default prom-client buckets top out at 10s, which
// would put every real sample in one bucket and be useless for spotting a
// slow SD card on a CM5.
export const settingsWriteDuration = new client.Histogram({
  name: "hydra_settings_write_duration_seconds",
  help: "Duration of a single settings.json write (temp-file write + atomic rename), in seconds",
  buckets: [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
  registers: [registry],
});

// -----------------------------------------------------------------------
// Atomic robot commands, by type
// -----------------------------------------------------------------------
// One label, `command` - the same string POST /api/robot/:id/command's own
// req.body.command switch already branches on (jog/play/pause/stop/tool/
// valve/pump/speed/vision). Incremented once per REQUEST (not once per
// affected robot in a combined-robot group), labeled "unknown" for any
// value the switch doesn't recognize rather than silently dropping it -
// an unexpected spike in hydra_robot_commands_total{command="unknown"} is
// itself a useful signal (a client sending a stale/typo'd command name).
export const robotCommandsTotal = new client.Counter({
  name: "hydra_robot_commands_total",
  help: "Total atomic robot commands received via POST /api/robot/:id/command, by command type",
  labelNames: ["command"] as const,
  registers: [registry],
});

// -----------------------------------------------------------------------
// Authentication failures
// -----------------------------------------------------------------------
// Covers every place a caller fails to authenticate against this server -
// NOT authorization (an already-valid "operator" token hitting an
// admin-only route via requireAdmin() is a permissions problem, not an
// auth one, and isn't counted here). `reason` distinguishes the REST
// bearer-token checks in authenticate() from the separate WebSocket
// upgrade handshake's own token check and from a rejected /api/login
// attempt, since those are 3 different code paths today.
export const authFailuresTotal = new client.Counter({
  name: "hydra_auth_failures_total",
  help: "Total authentication failures, by reason (no_token, token_invalid, token_expired, ws_no_token, ws_token_invalid, invalid_credentials)",
  labelNames: ["reason"] as const,
  registers: [registry],
});

// -----------------------------------------------------------------------
// System metrics (re-exposed from GET /api/system/metrics)
// -----------------------------------------------------------------------
// Same numbers that endpoint already computes for the Overview footer
// (Dashboard.tsx StatusFooter) - re-exposed here as real Prometheus gauges
// instead of a second, parallel implementation. server.ts registers its
// own getSystemMetrics() (the same function both routes now share) via
// setSystemMetricsSource() once, at module load.
export interface SystemMetricsSnapshot {
  cpu_load: number;
  memory_usage: number;
  temp: number | null;
  temp_is_real: boolean;
  rp1_temp: number | null;
}

let systemMetricsSource: (() => Promise<SystemMetricsSnapshot>) | null = null;
export function setSystemMetricsSource(fn: () => Promise<SystemMetricsSnapshot>): void {
  systemMetricsSource = fn;
}

const systemMemoryUsagePercent = new client.Gauge({
  name: "hydra_system_memory_usage_percent",
  help: "Memory used, as a percentage of total (0-100) - same figure GET /api/system/metrics reports as memory_usage",
  registers: [registry],
});
const systemTempCelsius = new client.Gauge({
  name: "hydra_system_temp_celsius",
  help: "SoC temperature in Celsius, from `vcgencmd measure_temp` on a real Pi/CM5 host - see hydra_system_temp_is_real for whether this reading is real or a dev-machine mock",
  registers: [registry],
});
const systemTempIsReal = new client.Gauge({
  name: "hydra_system_temp_is_real",
  help: "1 if hydra_system_temp_celsius came from a real vcgencmd read, 0 if it's a mocked value (vcgencmd unavailable - not a Pi/CM5 host, e.g. a Windows/macOS dev machine)",
  registers: [registry],
});
const systemRp1TempCelsius = new client.Gauge({
  name: "hydra_system_rp1_temp_celsius",
  help: "RP1 (CM5/Pi 5 family I/O controller) temperature in Celsius, from the real Linux hwmon rp1_adc sensor - absent (not exported) on any host without a real RP1 chip, never a mocked value",
  registers: [registry],
});

// Only ONE of the 4 gauges in this group actually triggers the (potentially
// vcgencmd-shelling-out, up to ~500ms) read, via its own collect() below -
// the other 3 (declared above, so this closure can reference them) are
// plain .set() targets updated as a side effect of that same call, so a
// single /metrics scrape does one system-metrics read, not four.
new client.Gauge({
  name: "hydra_system_cpu_load",
  help: "Simplified CPU load (os.loadavg()[0] * 10, rounded) - same figure GET /api/system/metrics reports as cpu_load",
  registers: [registry],
  async collect() {
    if (!systemMetricsSource) return;
    const snapshot = await systemMetricsSource();
    this.set(snapshot.cpu_load);
    systemMemoryUsagePercent.set(snapshot.memory_usage);
    if (snapshot.temp !== null) systemTempCelsius.set(snapshot.temp);
    systemTempIsReal.set(snapshot.temp_is_real ? 1 : 0);
    if (snapshot.rp1_temp !== null) systemRp1TempCelsius.set(snapshot.rp1_temp);
  },
});
