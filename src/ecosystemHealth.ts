// =============================================================================
// HYDRA-UMC-SERVER - src/ecosystemHealth.ts
// Copyright (C) 2026 JuanenRac (Electro Hobby 3D) <electrohobby3d@gmail.com>
// GPL-3.0-or-later - see LICENSE
// =============================================================================
// The health of the services of the ecosystem in one answer (GET /api/ecosystem/health, behind the switch ecosystemHealth.enabled,
// off by default). It reads what the server already knows - the manifests of the sibling checkouts and the registry of ports, as
// src/ecosystemStatus.ts does - and asks each declared service for its health with a short timeout and no side effect: a GET of its
// health path (the HealthReport it answers is read for its state and version) or a bare TCP connect. A service that does not answer
// is "down" and one that cannot be asked is "unknown"; nothing here throws out of the route, so one dead service never hides the others.
//
// Each service is ok, degraded, down or unknown, with a short reason CODE (the clients translate it), the version it reports against the
// version of its manifest (drift when they differ) and when the server last heard from it. The certificate of the server's own TLS is read
// from its file and reported with the days left. The pure part (buildEcosystemHealth) takes the clock and the probe results as arguments
// so it is tested with a simulated clock; collectEcosystemHealth does the probing.
//
// What a client may see: an administrator also gets the port, health path, unit and active state of each service; any other account that
// is allowed in (operator) gets none of them, nor any path or fingerprint of the certificate.
import fs from "node:fs";
import http from "node:http";
import { X509Certificate } from "node:crypto";
import { getEcosystemStatus, probeTcp, SERVICE_PROBE_HOST, type EcosystemProjectStatus } from "./ecosystemStatus";

export type ServiceState = "ok" | "degraded" | "down" | "unknown";
export type ServiceReason =
  | "health_ok"
  | "health_degraded"
  | "health_failed"
  | "http_error"
  | "unreachable"
  | "reachable_unit_not_active"
  | "unreachable_unit_active"
  | "unit_active"
  | "unit_starting"
  | "unit_failed"
  | "unit_inactive"
  | "no_signal"
  | "probe_error";

export const DEFAULT_CERT_WARN_DAYS = 30;
export const DEFAULT_PROBE_TIMEOUT_MS = 1500;
const MAX_BODY_BYTES = 16 * 1024;
const MAX_VERSION_LENGTH = 24;

/** What asking one service gave. */
export interface ProbeDetail {
  reachable: boolean;
  /** Only for an HTTP probe that got an answer. */
  httpStatus?: number;
  /** The "state" of a HealthReport body, upper-cased, when there was one. */
  reportedState?: string;
  /** The "version" field of the body, when it is a plain version string. */
  reportedVersion?: string;
  latencyMs?: number;
}

export interface ServiceHealth {
  name: string;
  family: string | null;
  role: string | null;
  state: ServiceState;
  reason: ServiceReason;
  version_expected: string | null;
  version_reported: string | null;
  /** True only when both versions are known and differ. */
  drift: boolean;
  last_seen_utc: string | null;
  latency_ms: number | null;
  /** Administrators only. */
  port?: number | null;
  health_path?: string | null;
  systemd_unit?: string | null;
  active_state?: string | null;
}

export type CertificateState = "ok" | "expiring" | "expired" | "unreadable";

export interface CertificateHealth {
  state: CertificateState;
  not_after_utc: string | null;
  days_left: number | null;
  warn_days: number;
}

export type HealthWarningCode = "certificate_expiring" | "certificate_expired" | "certificate_unreadable" | "version_drift" | "service_down" | "service_degraded";

export interface HealthWarning {
  code: HealthWarningCode;
  service?: string;
}

export interface EcosystemHealthReport {
  schema_version: "1.0";
  generated_at_utc: string;
  /** False when the sibling checkouts could not be scanned at all (then there are no services). */
  available: boolean;
  summary: { total: number; ok: number; degraded: number; down: number; unknown: number; drift: number };
  services: ServiceHealth[];
  certificate: CertificateHealth | null;
  warnings: HealthWarning[];
}

/** Remembers when each service last answered, so "last heard from" survives from one request to the next. */
export class LastSeenMemory {
  readonly #seen = new Map<string, number>();
  mark(name: string, at: number): void {
    this.#seen.set(name, at);
  }
  get(name: string): number | undefined {
    return this.#seen.get(name);
  }
}

const GOOD_STATES = new Set(["READY", "OK", "HEALTHY", "UP"]);
const DEGRADED_STATES = new Set(["DEGRADED", "WARN", "WARNING", "STARTING"]);

function plainVersion(value: unknown): string | null {
  return typeof value === "string" && /^[0-9A-Za-z][0-9A-Za-z._+-]*$/.test(value) && value.length <= MAX_VERSION_LENGTH ? value : null;
}

/** Whole days left until a date, rounded down (negative once it has passed). */
export function daysLeft(notAfterMs: number, nowMs: number): number {
  return Math.floor((notAfterMs - nowMs) / 86_400_000);
}

export function certificateHealth(notAfterMs: number | null, nowMs: number, warnDays: number): CertificateHealth {
  if (notAfterMs === null || Number.isNaN(notAfterMs)) return { state: "unreadable", not_after_utc: null, days_left: null, warn_days: warnDays };
  const left = daysLeft(notAfterMs, nowMs);
  const state: CertificateState = notAfterMs <= nowMs ? "expired" : left < warnDays ? "expiring" : "ok";
  return { state, not_after_utc: new Date(notAfterMs).toISOString(), days_left: left, warn_days: warnDays };
}

function judge(project: EcosystemProjectStatus, detail: ProbeDetail | "error" | undefined): { state: ServiceState; reason: ServiceReason; heard: boolean } {
  const unit = project.activeState;
  const unitActive = unit === "active";
  if (detail === "error") return { state: "unknown", reason: "probe_error", heard: false };
  if (project.servicePort !== null && detail) {
    if (detail.reachable) {
      if (detail.httpStatus !== undefined && (detail.httpStatus < 200 || detail.httpStatus >= 300)) return { state: "down", reason: "http_error", heard: true };
      const reported = detail.reportedState;
      if (reported && DEGRADED_STATES.has(reported)) return { state: "degraded", reason: "health_degraded", heard: true };
      if (reported && !GOOD_STATES.has(reported)) return { state: "down", reason: "health_failed", heard: true };
      if (project.systemdUnit !== null && unit !== null && !unitActive) return { state: "degraded", reason: "reachable_unit_not_active", heard: true };
      return { state: "ok", reason: "health_ok", heard: true };
    }
    if (unitActive) return { state: "degraded", reason: "unreachable_unit_active", heard: false };
    return { state: "down", reason: "unreachable", heard: false };
  }
  if (project.systemdUnit !== null) {
    if (unit === null) return { state: "unknown", reason: "no_signal", heard: false };
    if (unitActive) return { state: "ok", reason: "unit_active", heard: true };
    if (unit === "activating" || unit === "reloading") return { state: "degraded", reason: "unit_starting", heard: false };
    if (unit === "failed") return { state: "down", reason: "unit_failed", heard: false };
    return { state: "down", reason: "unit_inactive", heard: false };
  }
  return { state: "unknown", reason: "no_signal", heard: false };
}

export interface BuildInput {
  available: boolean;
  projects: EcosystemProjectStatus[];
  /** The probe result of each service by name; a missing entry means it was not asked, "error" that asking threw. */
  details: Map<string, ProbeDetail | "error">;
  now: number;
  memory: LastSeenMemory;
  /** The not-after date of the TLS certificate in ms, null when it could not be read, undefined when the server has none. */
  certificateNotAfterMs: number | null | undefined;
  certWarnDays: number;
  admin: boolean;
}

/** The pure part: the report from the facts. Only services that declare a port or a unit are listed (the rest are libraries, tools or firmware). */
export function buildEcosystemHealth(input: BuildInput): EcosystemHealthReport {
  const { now, memory } = input;
  const services: ServiceHealth[] = [];
  for (const project of input.projects) {
    if (project.servicePort === null && project.systemdUnit === null) continue;
    const detail = input.details.get(project.name);
    const verdict = judge(project, detail);
    if (verdict.heard) memory.mark(project.name, now);
    const seen = memory.get(project.name);
    const probe = detail && detail !== "error" ? detail : undefined;
    const reported = probe?.reportedVersion ?? null;
    const expected = plainVersion(project.version);
    const entry: ServiceHealth = {
      name: project.name,
      family: project.family,
      role: project.role,
      state: verdict.state,
      reason: verdict.reason,
      version_expected: expected,
      version_reported: reported,
      drift: expected !== null && reported !== null && expected !== reported,
      last_seen_utc: seen === undefined ? null : new Date(seen).toISOString(),
      latency_ms: probe?.latencyMs ?? null,
    };
    if (input.admin) {
      entry.port = project.servicePort;
      entry.health_path = project.serviceHealthPath;
      entry.systemd_unit = project.systemdUnit;
      entry.active_state = project.activeState;
    }
    services.push(entry);
  }
  services.sort((a, b) => (a.family ?? "").localeCompare(b.family ?? "") || a.name.localeCompare(b.name));

  const certificate = input.certificateNotAfterMs === undefined ? null : certificateHealth(input.certificateNotAfterMs, now, input.certWarnDays);
  const warnings: HealthWarning[] = [];
  if (certificate?.state === "expired") warnings.push({ code: "certificate_expired" });
  else if (certificate?.state === "expiring") warnings.push({ code: "certificate_expiring" });
  else if (certificate?.state === "unreadable") warnings.push({ code: "certificate_unreadable" });
  for (const s of services) {
    if (s.state === "down") warnings.push({ code: "service_down", service: s.name });
    else if (s.state === "degraded") warnings.push({ code: "service_degraded", service: s.name });
    if (s.drift) warnings.push({ code: "version_drift", service: s.name });
  }
  const count = (state: ServiceState) => services.filter((s) => s.state === state).length;
  return {
    schema_version: "1.0",
    generated_at_utc: new Date(now).toISOString(),
    available: input.available,
    summary: { total: services.length, ok: count("ok"), degraded: count("degraded"), down: count("down"), unknown: count("unknown"), drift: services.filter((s) => s.drift).length },
    services,
    certificate,
    warnings,
  };
}

/** One GET of a health path: the status, the state and version of a JSON body (read up to 16 KiB), and how long it took. Never throws. */
export function fetchHealthDetail(port: number, healthPath: string, timeoutMs: number, host: string = SERVICE_PROBE_HOST): Promise<ProbeDetail> {
  return new Promise((resolve) => {
    const started = Date.now();
    let done = false;
    const finish = (detail: ProbeDetail) => {
      if (done) return;
      done = true;
      resolve(detail);
    };
    const req = http.get({ host, port, path: healthPath, timeout: timeoutMs, headers: { accept: "application/json" } }, (res) => {
      const chunks: Buffer[] = [];
      let size = 0;
      res.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size <= MAX_BODY_BYTES) chunks.push(chunk);
      });
      res.on("error", () => finish({ reachable: true, httpStatus: res.statusCode, latencyMs: Date.now() - started }));
      res.on("end", () => {
        const detail: ProbeDetail = { reachable: true, httpStatus: res.statusCode, latencyMs: Date.now() - started };
        if (size <= MAX_BODY_BYTES) {
          try {
            const body = JSON.parse(Buffer.concat(chunks).toString("utf-8"));
            if (body && typeof body === "object" && !Array.isArray(body)) {
              if (typeof body.state === "string") detail.reportedState = body.state.toUpperCase();
              const version = plainVersion(body.version);
              if (version) detail.reportedVersion = version;
            }
          } catch {
            /* a body that is not JSON is only the status code */
          }
        }
        finish(detail);
      });
    });
    req.on("timeout", () => {
      req.destroy();
      finish({ reachable: false });
    });
    req.on("error", () => finish({ reachable: false }));
  });
}

/** Reads the not-after date of a PEM certificate file; null when it cannot be read or parsed. */
export function readCertificateNotAfter(file: string): number | null {
  try {
    const ms = Date.parse(new X509Certificate(fs.readFileSync(file)).validTo);
    return Number.isNaN(ms) ? null : ms;
  } catch {
    return null;
  }
}

export interface CollectDeps {
  getStatus?: () => Promise<{ available: boolean; projects: EcosystemProjectStatus[] }>;
  fetchDetail?: (port: number, healthPath: string, timeoutMs: number) => Promise<ProbeDetail>;
  tcpProbe?: (port: number, host: string, timeoutMs: number) => Promise<boolean>;
  now?: () => number;
  memory: LastSeenMemory;
  /** The path of the certificate of the TLS that is on, or null when the server runs without TLS. */
  certificatePath: () => string | null;
  readCertificate?: (file: string) => number | null;
  /** The configured values (server-config.json, ecosystemHealth); anything invalid gives the default. */
  certWarnDays: () => unknown;
  probeTimeoutMs: () => unknown;
}

export function certWarnDaysFrom(value: unknown): number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 365 ? value : DEFAULT_CERT_WARN_DAYS;
}

export function probeTimeoutFrom(value: unknown): number {
  return typeof value === "number" && Number.isInteger(value) && value >= 100 && value <= 10_000 ? value : DEFAULT_PROBE_TIMEOUT_MS;
}

/** Asks every declared service at once (one timeout window in all) and builds the report. Fail-soft: a probe that throws makes that one service unknown. */
export async function collectEcosystemHealth(deps: CollectDeps, admin: boolean): Promise<EcosystemHealthReport> {
  const now = (deps.now ?? Date.now)();
  const timeout = probeTimeoutFrom(deps.probeTimeoutMs());
  const fetchDetail = deps.fetchDetail ?? fetchHealthDetail;
  const tcp = deps.tcpProbe ?? probeTcp;
  let status: { available: boolean; projects: EcosystemProjectStatus[] };
  try {
    status = await (deps.getStatus ?? getEcosystemStatus)();
  } catch {
    status = { available: false, projects: [] };
  }
  const details = new Map<string, ProbeDetail | "error">();
  await Promise.all(
    status.projects.map(async (project) => {
      if (project.servicePort === null) return;
      const started = Date.now();
      try {
        if (project.serviceHealthPath) {
          details.set(project.name, await fetchDetail(project.servicePort, project.serviceHealthPath, timeout));
        } else {
          const reachable = await tcp(project.servicePort, SERVICE_PROBE_HOST, timeout);
          details.set(project.name, { reachable, ...(reachable ? { latencyMs: Date.now() - started } : {}) });
        }
      } catch {
        details.set(project.name, "error");
      }
    }),
  );
  let certificateNotAfterMs: number | null | undefined;
  try {
    const file = deps.certificatePath();
    certificateNotAfterMs = file ? (deps.readCertificate ?? readCertificateNotAfter)(file) : undefined;
  } catch {
    certificateNotAfterMs = null;
  }
  return buildEcosystemHealth({
    available: status.available,
    projects: status.projects,
    details,
    now,
    memory: deps.memory,
    certificateNotAfterMs,
    certWarnDays: certWarnDaysFrom(deps.certWarnDays()),
    admin,
  });
}
