// =============================================================================
// HYDRA-UMC-SERVER - src/updateCheck.ts
// Copyright (C) 2026 JuanenRac (Electro Hobby 3D) <electrohobby3d@gmail.com>
// GPL-3.0-or-later - see LICENSE
// =============================================================================
// The newest published version of each program of the ecosystem, set against the version installed on this machine (GET /api/admin/updates).
// It asks the release list of GitHub (`/repos/<owner>/<program>/releases/latest`, public and without a key) once per program, keeps the answer for
// `cacheMinutes` (the anonymous limit of GitHub is small and shared by everything on the network) and stops at the first refusal for quota, so one
// look never spends more than it was given. Nothing else leaves the server and nothing is installed: it reports, it never updates. Off by default.
import type { EcosystemProjectStatus } from "./ecosystemStatus";

export const UPDATE_DEFAULT_OWNER = "JuanenRac";
export const UPDATE_DEFAULT_CACHE_MINUTES = 360;
export const UPDATE_MIN_CACHE_MINUTES = 10;
export const UPDATE_MAX_CACHE_MINUTES = 7 * 24 * 60;
/** The most programs one look asks about. */
export const UPDATE_MAX_PROGRAMS = 150;
const OWNER_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;
const NAME_PATTERN = /^[A-Za-z0-9._-]{1,100}$/;

/** What data/server-config.json may hold in the `updateCheck` block besides the switch. */
export interface UpdateCheckSettings {
  owner?: unknown;
  cacheMinutes?: unknown;
}

export function updateOwner(settings: UpdateCheckSettings | undefined): string {
  return typeof settings?.owner === "string" && OWNER_PATTERN.test(settings.owner) ? settings.owner : UPDATE_DEFAULT_OWNER;
}

export function updateCacheMinutes(settings: UpdateCheckSettings | undefined): number {
  const value = settings?.cacheMinutes;
  return typeof value === "number" && Number.isFinite(value) ? Math.min(UPDATE_MAX_CACHE_MINUTES, Math.max(UPDATE_MIN_CACHE_MINUTES, Math.floor(value))) : UPDATE_DEFAULT_CACHE_MINUTES;
}

export type UpdateState = "current" | "behind" | "ahead" | "unknown";

export interface UpdateItem {
  name: string;
  family: string | null;
  installed: string | null;
  latest: string | null;
  state: UpdateState;
}

export interface UpdateReport {
  /** When the newest versions were asked, or null before the first look. */
  checkedAt: string | null;
  owner: string;
  /** True when GitHub refused for quota during the look: the programs it did not reach have no `latest`. */
  rateLimited: boolean;
  items: UpdateItem[];
}

/** "v0.8.2.6" -> [0, 8, 2, 6]; null when the text is not a dotted version of numbers. */
export function parseVersion(text: string | null | undefined): number[] | null {
  if (typeof text !== "string") return null;
  const match = /^v?(\d+(?:\.\d+){0,5})(?:[-+].*)?$/.exec(text.trim());
  return match ? match[1].split(".").map(Number) : null;
}

/** -1, 0 or 1; a missing component counts as 0 (1.2 equals 1.2.0). Null when either side is not a version. */
export function compareVersions(a: string | null | undefined, b: string | null | undefined): -1 | 0 | 1 | null {
  const left = parseVersion(a);
  const right = parseVersion(b);
  if (!left || !right) return null;
  for (let i = 0; i < Math.max(left.length, right.length); i += 1) {
    const x = left[i] ?? 0;
    const y = right[i] ?? 0;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

export function stateOf(installed: string | null, latest: string | null): UpdateState {
  const order = compareVersions(installed, latest);
  if (order === null) return "unknown";
  return order === 0 ? "current" : order < 0 ? "behind" : "ahead";
}

export type FetchLike = (url: string, init: { headers: Record<string, string>; signal: AbortSignal }) => Promise<{ status: number; ok: boolean; json: () => Promise<unknown>; headers?: { get: (name: string) => string | null } }>;

export interface UpdateCheckDeps {
  fetch?: FetchLike;
  now?: () => number;
  /** The programs installed here (the scan of the ecosystem). */
  projects: () => Promise<EcosystemProjectStatus[]>;
  settings: () => UpdateCheckSettings | undefined;
  /** How long to wait for GitHub, per program, in milliseconds (8000 by default). */
  timeoutMs?: number;
}

export class UpdateChecker {
  private readonly deps: UpdateCheckDeps;
  private cached: { at: number; report: UpdateReport } | null = null;
  private running: Promise<UpdateReport> | null = null;

  constructor(deps: UpdateCheckDeps) {
    this.deps = deps;
  }

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }

  /** The kept report while it is fresh, else a new look. `force` asks for a new look, but never more often than the minimum time of the cache. */
  async report(force = false): Promise<UpdateReport> {
    const settings = this.deps.settings();
    const ageMs = this.cached ? this.now() - this.cached.at : Infinity;
    const keepMs = updateCacheMinutes(settings) * 60_000;
    const minimumMs = UPDATE_MIN_CACHE_MINUTES * 60_000;
    if (this.cached && ageMs < (force ? minimumMs : keepMs) && this.cached.report.owner === updateOwner(settings)) return this.cached.report;
    if (this.running) return this.running;
    this.running = this.look().finally(() => { this.running = null; });
    return this.running;
  }

  private async look(): Promise<UpdateReport> {
    const owner = updateOwner(this.deps.settings());
    const fetchFn: FetchLike = this.deps.fetch ?? ((url, init) => fetch(url, init));
    const projects = (await this.deps.projects()).filter((p) => NAME_PATTERN.test(p.name)).slice(0, UPDATE_MAX_PROGRAMS);
    let rateLimited = false;
    const latestOf = new Map<string, string | null>();
    for (const project of projects) {
      if (rateLimited) { latestOf.set(project.name, null); continue; }
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.deps.timeoutMs ?? 8000);
      try {
        const response = await fetchFn(`https://api.github.com/repos/${owner}/${project.name}/releases/latest`, {
          headers: { Accept: "application/vnd.github+json", "User-Agent": "hydra-umc-server-update-check", "X-GitHub-Api-Version": "2022-11-28" },
          signal: controller.signal,
        });
        if (response.status === 403 || response.status === 429) { rateLimited = true; latestOf.set(project.name, null); continue; }
        if (!response.ok) { latestOf.set(project.name, null); continue; }
        const body = (await response.json()) as { tag_name?: unknown } | null;
        latestOf.set(project.name, typeof body?.tag_name === "string" && parseVersion(body.tag_name) ? body.tag_name.trim().replace(/^v/, "") : null);
      } catch {
        // an unreachable GitHub, a timeout or an answer that is not JSON: this program has no known newest version
        latestOf.set(project.name, null);
      } finally {
        clearTimeout(timer);
      }
    }
    const items: UpdateItem[] = projects
      .map((p) => {
        const latest = latestOf.get(p.name) ?? null;
        return { name: p.name, family: p.family, installed: p.version, latest, state: stateOf(p.version, latest) };
      })
      .sort((a, b) => (a.name.toLowerCase() < b.name.toLowerCase() ? -1 : a.name.toLowerCase() > b.name.toLowerCase() ? 1 : 0));
    const report: UpdateReport = { checkedAt: new Date(this.now()).toISOString(), owner, rateLimited, items };
    this.cached = { at: this.now(), report };
    return report;
  }
}
