// =============================================================================
// HYDRA-UMC-SERVER - src/maintenance.ts
// Copyright (C) 2026 JuanenRac (Electro Hobby 3D) <electrohobby3d@gmail.com>
// GPL-3.0-or-later - see LICENSE
// =============================================================================
// The routes under /api/admin/maintenance wrap the deploy tool of the operating system image (tools/deploy_release.py: status, install, rollback, prune).
// Rules, all on the side of keeping the machine safe:
//  * off by default (maintenance.enabled; the routes then answer 404);
//  * no shell: the tool is started with an argument list, so nothing the caller sends is ever read as a command;
//  * a package is NAMED, never given as a path: it must be a plain file name that resolves, after links are followed, to a regular file inside
//    the one folder the configuration names (packagesDir);
//  * a component or a release is a short name of letters, digits, dots, dashes and underscores;
//  * one run at a time, with a time limit; the answer carries what the tool printed, cut to a fixed size.
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { MaintenanceFile } from "./securityConfig";

export const MAINTENANCE_DEFAULT_ROOT = "/opt/hydra-umc";
export const MAINTENANCE_DEFAULT_TOOL = "tools/deploy_release.py";
export const MAINTENANCE_DEFAULT_PYTHON = "python3";
export const MAINTENANCE_DEFAULT_TIMEOUT_SECONDS = 300;
export const MAINTENANCE_MAX_OUTPUT_BYTES = 64 * 1024;

export type MaintenanceAction = "status" | "install" | "rollback" | "prune";

export class MaintenanceError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
    this.name = "MaintenanceError";
  }
}

const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const PACKAGE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/** A component name as the deploy tool keeps it (a folder under the root). */
export function validComponentName(value: unknown): value is string {
  return typeof value === "string" && NAME_PATTERN.test(value) && !value.includes("..");
}

/** The name of a package file (no folder, no leading dot or dash, no `..`). */
export function validPackageName(value: unknown): value is string {
  return typeof value === "string" && PACKAGE_PATTERN.test(value) && !value.includes("..");
}

function limitedNumber(value: unknown, fallback: number, low: number, high: number): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.min(high, Math.max(low, Math.floor(value))) : fallback;
}

export interface MaintenanceSettings {
  root: string;
  packagesDir: string;
  tool: string;
  python: string;
  timeoutSeconds: number;
}

/** The settings the file holds, with the defaults for what is missing or not usable. `dataPath` is the data folder of this server. */
export function maintenanceSettings(file: MaintenanceFile | undefined, dataPath: string): MaintenanceSettings {
  const text = (value: unknown, fallback: string) => (typeof value === "string" && value.trim() && !value.includes("\0") ? value.trim() : fallback);
  const root = text(file?.root, MAINTENANCE_DEFAULT_ROOT);
  const tool = text(file?.tool, MAINTENANCE_DEFAULT_TOOL);
  return {
    root,
    packagesDir: path.resolve(dataPath, text(file?.packagesDir, "packages")),
    tool: path.isAbsolute(tool) ? tool : path.join(root, tool),
    python: text(file?.python, MAINTENANCE_DEFAULT_PYTHON),
    timeoutSeconds: limitedNumber(file?.timeoutSeconds, MAINTENANCE_DEFAULT_TIMEOUT_SECONDS, 10, 1800),
  };
}

/** Resolves a package name to its real path inside the packages folder; throws the 400 or 404 the route answers with. */
export function resolvePackage(settings: MaintenanceSettings, name: unknown): string {
  if (!validPackageName(name)) throw new MaintenanceError(400, "package must be the plain name of a file in the packages folder");
  const base = (() => {
    try { return fs.realpathSync(settings.packagesDir); } catch { throw new MaintenanceError(404, "There is no packages folder"); }
  })();
  const wanted = path.join(base, name);
  let real: string;
  try { real = fs.realpathSync(wanted); } catch { throw new MaintenanceError(404, "There is no such package"); }
  const inside = path.relative(base, real);
  if (inside === "" || inside.startsWith("..") || path.isAbsolute(inside) || path.dirname(real) !== base) throw new MaintenanceError(400, "package must be a file inside the packages folder");
  if (!fs.statSync(real).isFile()) throw new MaintenanceError(400, "package must be a regular file");
  return real;
}

export interface MaintenanceCommand {
  file: string;
  args: string[];
}

/** The command for one action. `body` is what the caller sent (already parsed); anything not listed here is refused, never passed on. */
export function buildCommand(action: MaintenanceAction, body: Record<string, unknown>, settings: MaintenanceSettings): MaintenanceCommand {
  const head = [settings.tool, "--root", settings.root];
  const withPython = (rest: string[]): MaintenanceCommand => ({ file: settings.python, args: [...head, ...rest] });
  switch (action) {
    case "status": {
      if (body.component === undefined) return withPython(["status"]);
      if (!validComponentName(body.component)) throw new MaintenanceError(400, "component must be the name of a component");
      return withPython(["status", body.component]);
    }
    case "install": {
      const real = resolvePackage(settings, body.package);
      if (body.allowDowngrade !== undefined && typeof body.allowDowngrade !== "boolean") throw new MaintenanceError(400, "allowDowngrade must be true or false");
      return withPython(["install", real, ...(body.allowDowngrade === true ? ["--allow-downgrade"] : [])]);
    }
    case "rollback": {
      if (!validComponentName(body.component)) throw new MaintenanceError(400, "component must be the name of a component");
      return withPython(["rollback", body.component]);
    }
    case "prune": {
      if (!validComponentName(body.component)) throw new MaintenanceError(400, "component must be the name of a component");
      if (body.keep !== undefined && (typeof body.keep !== "number" || !Number.isInteger(body.keep) || body.keep < 2 || body.keep > 50)) throw new MaintenanceError(400, "keep must be a whole number from 2 to 50");
      return withPython(["prune", body.component, ...(body.keep !== undefined ? ["--keep", String(body.keep)] : [])]);
    }
  }
}

export interface RunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export type Runner = (command: MaintenanceCommand, timeoutMs: number) => Promise<RunResult>;

const clip = (text: string) => (Buffer.byteLength(text) > MAINTENANCE_MAX_OUTPUT_BYTES ? `${text.slice(0, MAINTENANCE_MAX_OUTPUT_BYTES)}\n[cut]` : text);

/** Starts the tool without a shell. */
export const defaultRunner: Runner = (command, timeoutMs) =>
  new Promise((resolve) => {
    execFile(command.file, command.args, { timeout: timeoutMs, maxBuffer: 4 * MAINTENANCE_MAX_OUTPUT_BYTES, shell: false, windowsHide: true }, (error, stdout, stderr) => {
      const code = error ? (typeof (error as { code?: unknown }).code === "number" ? ((error as { code: number }).code) : 1) : 0;
      resolve({ exitCode: code, stdout: String(stdout ?? ""), stderr: String(stderr ?? ""), timedOut: Boolean(error && (error as { killed?: boolean }).killed) });
    });
  });

export interface MaintenanceOutcome {
  ok: boolean;
  action: MaintenanceAction;
  exitCode: number;
  timedOut: boolean;
  /** What the tool printed as JSON before its DEPLOY=PASS line, when it is JSON. */
  result: unknown;
  /** The last lines the tool printed on its error output (cut). */
  message: string;
}

/** What the tool printed: a JSON document followed by the line DEPLOY=PASS. Anything that is not that comes back as null. */
export function parseToolOutput(stdout: string): unknown {
  const body = stdout.replace(/\r\n/g, "\n").replace(/\nDEPLOY=PASS\n?$/, "").trim();
  if (!body) return null;
  try { return JSON.parse(body); } catch { return null; }
}

export class Maintenance {
  private busy = false;

  private readonly deps: { settings: () => MaintenanceSettings; runner?: Runner };

  constructor(deps: { settings: () => MaintenanceSettings; runner?: Runner }) {
    this.deps = deps;
  }

  /** Whether a run is going on right now. */
  get running(): boolean {
    return this.busy;
  }

  async run(action: MaintenanceAction, body: Record<string, unknown>): Promise<MaintenanceOutcome> {
    const settings = this.deps.settings();
    const command = buildCommand(action, body, settings);
    if (this.busy) throw new MaintenanceError(409, "Another maintenance run is going on");
    this.busy = true;
    try {
      const done = await (this.deps.runner ?? defaultRunner)(command, settings.timeoutSeconds * 1000);
      const ok = done.exitCode === 0 && !done.timedOut;
      return {
        ok, action, exitCode: done.exitCode, timedOut: done.timedOut,
        result: ok ? parseToolOutput(done.stdout) : null,
        message: clip((done.stderr || (ok ? "" : done.stdout)).trim().split("\n").slice(-20).join("\n")),
      };
    } finally {
      this.busy = false;
    }
  }
}
