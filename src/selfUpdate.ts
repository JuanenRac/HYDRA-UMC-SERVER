// =============================================================================
// HYDRA-UMC-SERVER - src/selfUpdate.ts
// Copyright (C) 2026 JuanenRac (Electro Hobby 3D) <electrohobby3d@gmail.com>
// GPL-3.0-or-later - see LICENSE
// =============================================================================
// Updating HYDRA-UMC from Studio: the programs of this machine (the server, Studio and the agent of the operating system) against the newest signed release
// of each, in steps that can be told one by one (checking, downloading, verifying, applying, restarting, done or failed).
//
// Nothing new is trusted here. A release carries the packages the family already signs: `hydra-<component>-<version>.tgz`, its `.sha256` and its `.sig`
// (Ed25519, `hydra-pkg/1`, the key pinned in the operating system image). This module only fetches those three files from the release of the repository of the
// program, hands the package to `tools/package_component.py verify` (hash, signature, names and paths) and, when that passes, to `tools/deploy_release.py install`,
// which keeps the release in use as `previous`, switches, restarts ONLY that component, checks its health and puts the earlier release back when it does not hold.
// Going back by hand is `deploy_release.py rollback`. The machine itself is never restarted.
//
// The restart of the server kills the process that asked for it, so the deploy tool is started DETACHED, with its output in a file, and the job lives in a file
// too: a server that comes back reads both and tells how it ended. Studio keeps asking meanwhile (see its panel).
//
// Only the newest release is a candidate (no channel to choose), the three files are named by this module and fetched from
// https://github.com/<owner>/<repo>/releases/download/v<version>/ and nowhere else, a package is never given as a path and no shell is used.
import { execFile, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { compareVersions, parseVersion } from "./updateCheck";
import { buildCommand, defaultRunner, parseToolOutput, validComponentName, type MaintenanceCommand, type MaintenanceSettings, type RunResult, type Runner } from "./maintenance";

export const SELF_UPDATE_DEFAULT_OWNER = "JuanenRac";
export const SELF_UPDATE_DEFAULT_APPLY_TIMEOUT_SECONDS = 600;
export const SELF_UPDATE_MAX_PACKAGE_BYTES = 300 * 1024 * 1024;
export const SELF_UPDATE_CACHE_MINUTES = 10;
const LOG_LIMIT = 120;
const OUTPUT_LIMIT = 64 * 1024;
const OWNER_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;

/** The programs that can be updated from Studio: component name of the package -> repository of the release that carries it. */
export const SELF_UPDATE_COMPONENTS = {
  server: "HYDRA-UMC-SERVER",
  studio: "HYDRA-UMC-STUDIO",
  "os-agent": "HYDRA-UMC-OS",
} as const;
export type SelfUpdateComponent = keyof typeof SELF_UPDATE_COMPONENTS;

export function isSelfUpdateComponent(value: unknown): value is SelfUpdateComponent {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(SELF_UPDATE_COMPONENTS, value);
}

export type SelfUpdateStep = "checking" | "downloading" | "verifying" | "applying" | "restarting" | "done" | "failed";
export const SELF_UPDATE_STEPS: readonly SelfUpdateStep[] = ["checking", "downloading", "verifying", "applying", "restarting", "done", "failed"];
export type SelfUpdateAction = "apply" | "rollback";

/** Why a job failed; Studio has a sentence in each language for each one. */
export type SelfUpdateFailure =
  | "no_release" | "already_current" | "no_signed_package" | "download_failed" | "package_too_large" | "signature_invalid"
  | "no_earlier_release" | "start_failed" | "rolled_back" | "deploy_failed" | "timeout" | "interrupted";

export class SelfUpdateError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
    this.name = "SelfUpdateError";
  }
}

export interface SelfUpdateFile {
  owner?: unknown;
  runnerPrefix?: unknown;
  applyTimeoutSeconds?: unknown;
}

export interface SelfUpdateSettings {
  owner: string;
  /** The words put in front of the deploy command so that it outlives the restart of this server (for example a transient systemd unit); empty: a detached process. `{out}` and `{job}` are replaced. */
  runnerPrefix: string[];
  applyTimeoutSeconds: number;
}

export function selfUpdateSettings(file: SelfUpdateFile | undefined): SelfUpdateSettings {
  const owner = typeof file?.owner === "string" && OWNER_PATTERN.test(file.owner) ? file.owner : SELF_UPDATE_DEFAULT_OWNER;
  const words: unknown = file?.runnerPrefix;
  const prefix = Array.isArray(words) && words.length <= 12 && words.every((word) => typeof word === "string" && word.length > 0 && word.length <= 200 && !word.includes("\0")) ? (words as string[]) : [];
  const seconds = file?.applyTimeoutSeconds;
  const applyTimeoutSeconds = typeof seconds === "number" && Number.isFinite(seconds) ? Math.min(3600, Math.max(30, Math.floor(seconds))) : SELF_UPDATE_DEFAULT_APPLY_TIMEOUT_SECONDS;
  return { owner, runnerPrefix: prefix, applyTimeoutSeconds };
}

export interface ReleaseAsset { name: string; url: string; size: number }
export interface LatestRelease { version: string; tag: string; assets: { pkg: ReleaseAsset; sha256: ReleaseAsset; sig: ReleaseAsset } | null }

export interface Installed { current: string | null; previous: string | null }

export interface SelfUpdateItem {
  id: SelfUpdateComponent;
  repo: string;
  installed: string | null;
  previous: string | null;
  latest: string | null;
  /** current, behind, ahead or unknown (as in /api/admin/updates). */
  state: "current" | "behind" | "ahead" | "unknown";
  /** Whether the newest release carries the three files of a signed package. */
  signedPackage: boolean;
}

export interface SelfUpdateReport {
  checkedAt: string | null;
  owner: string;
  rateLimited: boolean;
  items: SelfUpdateItem[];
}

export interface SelfUpdateJob {
  id: string;
  action: SelfUpdateAction;
  component: SelfUpdateComponent;
  state: SelfUpdateStep;
  fromVersion: string | null;
  /** The version the job is bringing in (or going back to). */
  targetVersion: string | null;
  startedAt: string;
  updatedAt: string;
  error: SelfUpdateFailure | null;
  detail: string;
  /** Where the deploy tool writes what it prints; empty before the tool is started. */
  outFile: string;
  packageName: string;
  log: Array<{ at: string; step: SelfUpdateStep; text: string }>;
  /** The user who started it. */
  by: string;
}

export type FetchResponse = { status: number; ok: boolean; json: () => Promise<unknown> };
export type FetchLike = (url: string, init: { headers: Record<string, string>; signal: AbortSignal }) => Promise<FetchResponse>;
/** Writes the file at `url` to `destination`, stopping with an error past `maxBytes`. */
export type Downloader = (url: string, destination: string, maxBytes: number, signal: AbortSignal) => Promise<void>;
export interface Launch { file: string; args: string[]; outFile: string }
/** Starts the deploy command so that it keeps running when this server is restarted. */
export type Launcher = (launch: Launch) => void | Promise<void>;

export interface SelfUpdateDeps {
  settings: () => SelfUpdateSettings;
  maintenance: () => MaintenanceSettings;
  /** The data folder of this server: the job file and its output live in `self-update/` under it. */
  dataPath: string;
  installed: (component: SelfUpdateComponent) => Promise<Installed>;
  fetch?: FetchLike;
  download?: Downloader;
  run?: Runner;
  launch?: Launcher;
  now?: () => number;
  newId?: () => string;
  timeoutMs?: number;
}

const iso = (ms: number) => new Date(ms).toISOString();

/** `hydra-<component>-<version>.tgz` and the two files that go with it. */
export function packageNames(component: SelfUpdateComponent, version: string): { pkg: string; sha256: string; sig: string } {
  const pkg = `hydra-${component}-${version}.tgz`;
  return { pkg, sha256: `${pkg}.sha256`, sig: `${pkg}.sig` };
}

/** The only address a file of a release is fetched from. */
export function releaseAssetUrl(owner: string, component: SelfUpdateComponent, version: string, name: string): string {
  return `https://github.com/${owner}/${SELF_UPDATE_COMPONENTS[component]}/releases/download/v${version}/${name}`;
}

/** What the releases of a repository say about the newest one: its version and whether the three files of a signed package are there (and how big). */
export function parseLatestRelease(body: unknown, owner: string, component: SelfUpdateComponent): LatestRelease | null {
  if (typeof body !== "object" || body === null) return null;
  const record = body as { tag_name?: unknown; assets?: unknown; draft?: unknown; prerelease?: unknown };
  if (record.draft === true || record.prerelease === true) return null;
  if (typeof record.tag_name !== "string" || !parseVersion(record.tag_name)) return null;
  const version = record.tag_name.trim().replace(/^v/, "");
  const names = packageNames(component, version);
  const sizes = new Map<string, number>();
  if (Array.isArray(record.assets)) {
    for (const asset of record.assets) {
      const item = asset as { name?: unknown; size?: unknown };
      if (typeof item?.name === "string") sizes.set(item.name, typeof item.size === "number" && Number.isFinite(item.size) && item.size >= 0 ? item.size : 0);
    }
  }
  const make = (name: string): ReleaseAsset => ({ name, url: releaseAssetUrl(owner, component, version, name), size: sizes.get(name) ?? 0 });
  const complete = sizes.has(names.pkg) && sizes.has(names.sha256) && sizes.has(names.sig);
  return { version, tag: `v${version}`, assets: complete ? { pkg: make(names.pkg), sha256: make(names.sha256), sig: make(names.sig) } : null };
}

/** The versions the deploy tool keeps for one component, read from the JSON of its `status`. */
export function installedFromStatus(status: unknown, component: string, fallback: string | null = null): Installed {
  const entry = typeof status === "object" && status !== null ? (status as Record<string, unknown>)[component] : undefined;
  const pick = (value: unknown): string | null => {
    const version = typeof value === "object" && value !== null ? (value as { version?: unknown }).version : undefined;
    return typeof version === "string" && parseVersion(version) ? version : null;
  };
  const record = typeof entry === "object" && entry !== null ? (entry as { current?: unknown; previous?: unknown }) : {};
  return { current: pick(record.current) ?? fallback, previous: pick(record.previous) };
}

/** The first line of what the deploy tool printed that tells how it ended. */
export function readDeployOutcome(text: string): { result: "pass" } | { result: "fail"; reason: string } | { result: "running" } {
  if (/^DEPLOY=PASS\s*$/m.test(text)) return { result: "pass" };
  const fail = /^DEPLOY=FAIL\s*(.*)$/m.exec(text);
  return fail ? { result: "fail", reason: fail[1].trim().slice(0, 300) } : { result: "running" };
}

/** Streams the file to `destination` through a temporary name; a file past the limit or an answer that is not 200 leaves nothing behind. */
export const defaultDownloader: Downloader = async (url, destination, maxBytes, signal) => {
  const response = await fetch(url, { signal, headers: { "User-Agent": "hydra-umc-server-self-update" }, redirect: "follow" });
  if (!response.ok || !response.body) throw new Error(`answered ${response.status}`);
  const declared = Number(response.headers.get("content-length") ?? 0);
  if (declared > maxBytes) throw new SelfUpdateError(413, "too large");
  const partial = `${destination}.part`;
  const out = fs.createWriteStream(partial, { flags: "w", mode: 0o600 });
  let seen = 0;
  try {
    const reader = response.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      seen += value.byteLength;
      if (seen > maxBytes) throw new SelfUpdateError(413, "too large");
      if (!out.write(value)) await new Promise<void>((resolve) => out.once("drain", () => resolve()));
    }
    await new Promise<void>((resolve, reject) => { out.once("error", reject); out.end(() => resolve()); });
    fs.renameSync(partial, destination);
  } catch (error) {
    out.destroy();
    fs.rmSync(partial, { force: true });
    throw error;
  }
};

/** Starts the command detached from this process, its output in `outFile`. With a prefix (a transient unit of systemd, for instance) the prefix starts it instead. */
export function launcherWith(prefix: string[], job: string): Launcher {
  return ({ file, args, outFile }) => {
    const words = prefix.map((word) => word.replaceAll("{out}", outFile).replaceAll("{job}", job));
    const [command, ...rest] = words.length > 0 ? [...words, file, ...args] : [file, ...args];
    const fd = fs.openSync(outFile, "a", 0o600);
    const child = spawn(command, rest, { detached: true, stdio: ["ignore", fd, fd], shell: false, windowsHide: true });
    child.on("error", () => { /* the job notices that nothing was written and ends as interrupted */ });
    child.unref();
    fs.closeSync(fd);
  };
}

/** GitHub is not a service of the family: this call never carries the identity of the server. */
const github: { fetch: FetchLike } = { fetch: (url, init) => fetch(url, init) as unknown as Promise<FetchResponse> };

const clip = (text: string) => (Buffer.byteLength(text) > OUTPUT_LIMIT ? text.slice(0, OUTPUT_LIMIT) : text);

export class SelfUpdate {
  private readonly deps: SelfUpdateDeps;
  private job: SelfUpdateJob | null = null;
  private loaded = false;
  private cached: { at: number; report: SelfUpdateReport } | null = null;
  private pipeline: Promise<void> = Promise.resolve();

  constructor(deps: SelfUpdateDeps) {
    this.deps = deps;
  }

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }

  private get folder(): string {
    return path.join(this.deps.dataPath, "self-update");
  }

  private get jobFile(): string {
    return path.join(this.folder, "job.json");
  }

  /** Resolves when the steps that run in this process (checking to verifying, and the start of the tool) are over. For tests and for a clean stop. */
  idle(): Promise<void> {
    return this.pipeline;
  }

  // ---- the job on disk -------------------------------------------------------------------------------------------------------------------------------------
  private save(): void {
    if (!this.job) return;
    fs.mkdirSync(this.folder, { recursive: true, mode: 0o700 });
    const temporary = `${this.jobFile}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(this.job), { mode: 0o600 });
    fs.renameSync(temporary, this.jobFile);
  }

  private load(): void {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const raw = JSON.parse(fs.readFileSync(this.jobFile, "utf8")) as Partial<SelfUpdateJob>;
      if (raw && typeof raw.id === "string" && isSelfUpdateComponent(raw.component) && typeof raw.state === "string" && SELF_UPDATE_STEPS.includes(raw.state as SelfUpdateStep)) {
        this.job = {
          id: raw.id, action: raw.action === "rollback" ? "rollback" : "apply", component: raw.component, state: raw.state as SelfUpdateStep,
          fromVersion: typeof raw.fromVersion === "string" ? raw.fromVersion : null, targetVersion: typeof raw.targetVersion === "string" ? raw.targetVersion : null,
          startedAt: String(raw.startedAt ?? ""), updatedAt: String(raw.updatedAt ?? ""), error: (raw.error as SelfUpdateFailure | null) ?? null, detail: String(raw.detail ?? ""),
          outFile: typeof raw.outFile === "string" ? raw.outFile : "", packageName: typeof raw.packageName === "string" ? raw.packageName : "",
          log: Array.isArray(raw.log) ? raw.log.slice(-LOG_LIMIT) : [], by: String(raw.by ?? ""),
        };
        // A job whose steps ran inside a process that is gone (checking, downloading, verifying) cannot be resumed.
        if (["checking", "downloading", "verifying"].includes(this.job.state)) this.finish("failed", "interrupted", "the server was restarted before the package was in place");
      }
    } catch { /* no job yet, or a file that is not one */ }
  }

  private move(step: SelfUpdateStep, text: string): void {
    const job = this.job as SelfUpdateJob;
    job.state = step;
    job.updatedAt = iso(this.now());
    job.log = [...job.log, { at: job.updatedAt, step, text }].slice(-LOG_LIMIT);
    this.save();
  }

  private finish(step: "done" | "failed", error: SelfUpdateFailure | null, detail: string): void {
    const job = this.job as SelfUpdateJob;
    job.error = error;
    job.detail = detail.slice(0, 300);
    this.move(step, detail || step);
  }

  // ---- reading --------------------------------------------------------------------------------------------------------------------------------------------
  /** The newest signed release of each program set against what is installed. The answer is kept ten minutes; `force` looks again, never more than once in that time. */
  async report(force = false): Promise<SelfUpdateReport> {
    const owner = this.deps.settings().owner;
    if (this.cached && this.cached.report.owner === owner && this.now() - this.cached.at < SELF_UPDATE_CACHE_MINUTES * 60_000 && (!force || this.now() - this.cached.at < 60_000)) return this.cached.report;
    const fetchFn: FetchLike = this.deps.fetch ?? github.fetch;
    let rateLimited = false;
    const items: SelfUpdateItem[] = [];
    for (const id of Object.keys(SELF_UPDATE_COMPONENTS) as SelfUpdateComponent[]) {
      const installed = await this.deps.installed(id).catch((): Installed => ({ current: null, previous: null }));
      let latest: LatestRelease | null = null;
      if (!rateLimited) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), this.deps.timeoutMs ?? 8000);
        try {
          const response = await fetchFn(`https://api.github.com/repos/${owner}/${SELF_UPDATE_COMPONENTS[id]}/releases/latest`, {
            headers: { Accept: "application/vnd.github+json", "User-Agent": "hydra-umc-server-self-update", "X-GitHub-Api-Version": "2022-11-28" }, signal: controller.signal,
          });
          if (response.status === 403 || response.status === 429) rateLimited = true;
          else if (response.ok) latest = parseLatestRelease(await response.json(), owner, id);
        } catch { /* unreachable GitHub, timeout, an answer that is not JSON: no known newest version */ } finally { clearTimeout(timer); }
      }
      const order = compareVersions(installed.current, latest?.version ?? null);
      items.push({ id, repo: SELF_UPDATE_COMPONENTS[id], installed: installed.current, previous: installed.previous, latest: latest?.version ?? null,
        state: order === null ? "unknown" : order === 0 ? "current" : order < 0 ? "behind" : "ahead", signedPackage: latest?.assets != null });
    }
    const report: SelfUpdateReport = { checkedAt: iso(this.now()), owner, rateLimited, items };
    this.cached = { at: this.now(), report };
    return report;
  }

  /** The job (the last one when no id is given), brought up to date with what the deploy tool has printed. */
  async current(id?: string): Promise<SelfUpdateJob | null> {
    this.load();
    if (!this.job || (id !== undefined && this.job.id !== id)) return null;
    if (this.job.state === "applying" || this.job.state === "restarting") await this.refresh();
    return this.job;
  }

  private async refresh(): Promise<void> {
    const job = this.job as SelfUpdateJob;
    let text = "";
    try { text = fs.readFileSync(job.outFile, "utf8"); } catch { /* not written yet */ }
    const outcome = readDeployOutcome(text);
    const installed = await this.deps.installed(job.component).catch((): Installed => ({ current: null, previous: null }));
    if (outcome.result === "pass") {
      // The tool ended well; the program in use must be the one asked for (the new server answers, so it is the one that says so).
      if (job.targetVersion !== null && installed.current !== null && installed.current !== job.targetVersion) this.finish("failed", "deploy_failed", `the tool finished but ${installed.current} is in use`);
      else this.finish("done", null, job.action === "rollback" ? `back to ${job.targetVersion ?? ""}` : `${job.targetVersion ?? ""} is in use`);
      return;
    }
    if (outcome.result === "fail") {
      const back = /did not|rolled|put back|earlier release/.test(outcome.reason);
      this.finish("failed", back ? "rolled_back" : "deploy_failed", outcome.reason);
      return;
    }
    if (Date.parse(job.updatedAt) + this.deps.settings().applyTimeoutSeconds * 1000 < this.now()) {
      this.finish("failed", "timeout", "the deploy tool did not report an end in time");
      return;
    }
    if (job.state === "applying" && job.targetVersion !== null && installed.current === job.targetVersion) this.move("restarting", "the new release is in place; its unit is restarting");
  }

  // ---- starting -------------------------------------------------------------------------------------------------------------------------------------------
  /** Starts an update or a way back. Throws a SelfUpdateError (the status is the answer of the route) when it cannot start; otherwise returns at once with the job and carries on in the background. */
  async start(action: SelfUpdateAction, component: unknown, by: string): Promise<SelfUpdateJob> {
    if (!isSelfUpdateComponent(component) || !validComponentName(component)) throw new SelfUpdateError(400, "component must be one of: " + Object.keys(SELF_UPDATE_COMPONENTS).join(", "));
    const running = await this.current();
    if (running && !["done", "failed"].includes(running.state)) throw new SelfUpdateError(409, "Another update is going on");
    const installed = await this.deps.installed(component).catch((): Installed => ({ current: null, previous: null }));
    const at = iso(this.now());
    const id = (this.deps.newId ?? (() => `${this.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`))();
    const job: SelfUpdateJob = {
      id, action, component, state: action === "apply" ? "checking" : "applying", fromVersion: installed.current, targetVersion: action === "rollback" ? installed.previous : null,
      startedAt: at, updatedAt: at, error: null, detail: "", outFile: path.join(this.folder, `${id}.out`), packageName: "", log: [], by,
    };
    if (action === "rollback" && installed.previous === null) throw new SelfUpdateError(409, "There is no earlier release to go back to");
    this.job = job;
    this.loaded = true;
    this.move(job.state, action === "apply" ? "looking for the newest signed release" : `going back to ${installed.previous ?? ""}`);
    this.pipeline = (action === "apply" ? this.runApply(component, installed) : this.runRollback(component)).catch((error: unknown) => {
      this.finish("failed", error instanceof SelfUpdateError && error.status === 413 ? "package_too_large" : "start_failed", String((error as Error)?.message ?? error));
    });
    return job;
  }

  private async runApply(component: SelfUpdateComponent, installed: Installed): Promise<void> {
    const job = this.job as SelfUpdateJob;
    const settings = this.deps.settings();
    const maintenance = this.deps.maintenance();
    const fetchFn: FetchLike = this.deps.fetch ?? github.fetch;
    // 1. the newest release and its three files
    let latest: LatestRelease | null = null;
    try {
      const response = await fetchFn(`https://api.github.com/repos/${settings.owner}/${SELF_UPDATE_COMPONENTS[component]}/releases/latest`, {
        headers: { Accept: "application/vnd.github+json", "User-Agent": "hydra-umc-server-self-update", "X-GitHub-Api-Version": "2022-11-28" }, signal: AbortSignal.timeout(this.deps.timeoutMs ?? 8000),
      });
      if (response.ok) latest = parseLatestRelease(await response.json(), settings.owner, component);
    } catch { /* handled below */ }
    if (!latest) return this.finish("failed", "no_release", "GitHub could not be asked, or there is no release");
    job.targetVersion = latest.version;
    const order = compareVersions(installed.current, latest.version);
    if (order !== null && order >= 0) return this.finish("failed", "already_current", `${installed.current ?? ""} is already the newest`);
    if (!latest.assets) return this.finish("failed", "no_signed_package", `${latest.tag} has no signed package for ${component}`);
    const wanted = [latest.assets.pkg, latest.assets.sha256, latest.assets.sig];
    if (wanted.some((asset) => asset.size > SELF_UPDATE_MAX_PACKAGE_BYTES)) return this.finish("failed", "package_too_large", "the package is larger than the limit");
    job.packageName = latest.assets.pkg.name;
    // 2. the download (a file at a time, through a temporary name, to the folder of the packages)
    this.move("downloading", `fetching ${latest.assets.pkg.name}`);
    fs.mkdirSync(maintenance.packagesDir, { recursive: true });
    const download = this.deps.download ?? defaultDownloader;
    const paths = wanted.map((asset) => path.join(maintenance.packagesDir, asset.name));
    try {
      for (const [index, asset] of wanted.entries()) {
        fs.rmSync(paths[index], { force: true });
        await download(asset.url, paths[index], SELF_UPDATE_MAX_PACKAGE_BYTES, AbortSignal.timeout(Math.max(60, settings.applyTimeoutSeconds) * 1000));
      }
    } catch (error) {
      this.discard(paths);
      return this.finish("failed", error instanceof SelfUpdateError && error.status === 413 ? "package_too_large" : "download_failed", String((error as Error)?.message ?? error));
    }
    // 3. the hash and the signature, by the check the family already has (tools/package_component.py verify)
    this.move("verifying", "checking the hash and the signature");
    const tool = path.join(path.dirname(maintenance.tool), "package_component.py");
    const verified = await (this.deps.run ?? defaultRun)({ file: maintenance.python, args: [tool, "verify", paths[0]] }, maintenance.timeoutSeconds * 1000);
    const match = /^PACKAGE=OK (\S+) (\S+) ([0-9a-f]{64})\s*$/m.exec(verified.stdout);
    if (verified.exitCode !== 0 || verified.timedOut || !match || match[1] !== component || match[2] !== latest.version) {
      this.discard(paths);
      return this.finish("failed", "signature_invalid", clip((verified.stderr || verified.stdout).trim()).split("\n").slice(-1)[0] ?? "the package was refused");
    }
    // 4. the deploy tool, detached: it keeps the release in use as `previous`, switches, restarts that one program, checks it and goes back when it does not hold
    const command = buildCommand("install", { package: latest.assets.pkg.name }, maintenance);
    await this.launchTool(command);
  }

  private async runRollback(component: SelfUpdateComponent): Promise<void> {
    const command = buildCommand("rollback", { component }, this.deps.maintenance());
    await this.launchTool(command);
  }

  private async launchTool(command: MaintenanceCommand): Promise<void> {
    const job = this.job as SelfUpdateJob;
    fs.mkdirSync(this.folder, { recursive: true, mode: 0o700 });
    fs.writeFileSync(job.outFile, "", { mode: 0o600 });
    this.move("applying", job.action === "apply" ? `installing ${job.targetVersion ?? ""} next to the one in use` : "putting the earlier release back");
    await (this.deps.launch ?? launcherWith(this.deps.settings().runnerPrefix, job.id))({ file: command.file, args: command.args, outFile: job.outFile });
  }

  private discard(paths: string[]): void {
    for (const file of paths) { fs.rmSync(file, { force: true }); fs.rmSync(`${file}.part`, { force: true }); }
  }
}

/** What is installed, from the `status` of the deploy tool (kept five seconds); a server with no release of its own yet is the version that runs it. */
export function installedReader(maintenance: () => MaintenanceSettings, appVersion: () => string | null, run: Runner = defaultRunner, now: () => number = Date.now): (component: SelfUpdateComponent) => Promise<Installed> {
  let kept: { at: number; status: unknown } | null = null;
  return async (component) => {
    if (!kept || now() - kept.at > 5000) {
      const settings = maintenance();
      const command = buildCommand("status", {}, settings);
      const done = await run(command, Math.min(settings.timeoutSeconds, 30) * 1000).catch((): RunResult => ({ exitCode: 1, stdout: "", stderr: "", timedOut: false }));
      kept = { at: now(), status: done.exitCode === 0 && !done.timedOut ? parseToolOutput(done.stdout) : null };
    }
    return installedFromStatus(kept.status, component, component === "server" ? appVersion() : null);
  };
}

const defaultRun: Runner = (command, timeoutMs) =>
  new Promise<RunResult>((resolve) => {
    execFile(command.file, command.args, { timeout: timeoutMs, maxBuffer: 4 * OUTPUT_LIMIT, shell: false, windowsHide: true }, (error, stdout, stderr) => {
      const code = error ? (typeof (error as { code?: unknown }).code === "number" ? (error as { code: number }).code : 1) : 0;
      resolve({ exitCode: code, stdout: String(stdout ?? ""), stderr: String(stderr ?? ""), timedOut: Boolean(error && (error as { killed?: boolean }).killed) });
    });
  });
