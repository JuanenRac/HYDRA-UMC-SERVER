// =============================================================================
// HYDRA-UMC-SERVER - src/dispatcherReload.ts
// Copyright (C) 2026 JuanenRac (Electro Hobby 3D) <electrohobby3d@gmail.com>
// GPL-3.0-or-later - see LICENSE
// =============================================================================
// After this server writes the two replanning options into the configuration file of the job dispatcher (src/dispatcherConfigFile.ts),
// it asks the dispatcher to read the file again: POST /admin/reload-config, which the dispatcher answers only to a caller on its own
// machine. The dispatcher checks the file before it installs anything, so a file that is not valid changes nothing there (422) and its
// previous values stay in force; this server then shows the change as saved but not applied, and the dispatcher reads the file the next
// time it starts.
//
// The address of the dispatcher is HYDRA_UMC_JOB_DISPATCHER_URL (or `jobDispatcher.stopRelay.url`, the same address the stop relay uses)
// and its token HYDRA_UMC_JOB_DISPATCHER_TOKEN (or JOB_DISPATCHER_TOKEN, the variable the dispatcher itself reads). Without an address
// nothing is called and the change waits for the next start of the dispatcher. The time to wait is `jobDispatcher.reload.timeoutMs`.

import { identityHeader } from "./serviceIdentity";

export const RELOAD_DEFAULT_TIMEOUT_MS = 3000;

export interface ReloadFile {
  timeoutMs?: unknown;
}

export interface ReloadSettings {
  /** Empty: no address, so nothing is called. */
  url: string;
  token: string;
  timeoutMs: number;
}

export interface ReloadEnv {
  HYDRA_UMC_JOB_DISPATCHER_URL?: string;
  HYDRA_UMC_JOB_DISPATCHER_TOKEN?: string;
  JOB_DISPATCHER_TOKEN?: string;
}

export type ReloadResolution = { ok: true; settings: ReloadSettings } | { ok: false; error: string };

export function resolveReload(env: ReloadEnv, file: ReloadFile | undefined, fileUrl: unknown): ReloadResolution {
  const timeoutMs = file?.timeoutMs === undefined ? RELOAD_DEFAULT_TIMEOUT_MS : file.timeoutMs;
  if (typeof timeoutMs !== "number" || !Number.isFinite(timeoutMs) || timeoutMs < 100 || timeoutMs > 60000) {
    return { ok: false, error: "jobDispatcher.reload.timeoutMs must be a number from 100 to 60000" };
  }
  const url = (env.HYDRA_UMC_JOB_DISPATCHER_URL ?? (typeof fileUrl === "string" ? fileUrl : "")).trim().replace(/\/+$/, "");
  const token = (env.HYDRA_UMC_JOB_DISPATCHER_TOKEN ?? env.JOB_DISPATCHER_TOKEN ?? "").trim();
  return { ok: true, settings: { url, token, timeoutMs } };
}

export type ReloadOutcome = { ok: true } | { ok: false; reason: string };

export interface ReloadDeps {
  settings: ReloadSettings;
  fetch: (url: string, init: { method: string; headers: Record<string, string>; signal: AbortSignal }) => Promise<{ status: number; json: () => Promise<unknown> }>;
}

/** Asks the dispatcher to read its file again. Never throws; says why when it did not take. */
export async function reloadDispatcher(deps: ReloadDeps): Promise<ReloadOutcome> {
  const { settings } = deps;
  if (settings.url === "") return { ok: false, reason: "no address of the dispatcher is set" };
  const controller = new AbortController();
  const abort = setTimeout(() => controller.abort(), settings.timeoutMs);
  try {
    const headers: Record<string, string> = { Accept: "application/json" };
    if (settings.token) headers.Authorization = `Bearer ${settings.token}`;
    else Object.assign(headers, identityHeader("admin"));
    const answer = await deps.fetch(`${settings.url}/admin/reload-config`, { method: "POST", headers, signal: controller.signal });
    if (answer.status === 200) return { ok: true };
    let detail = "";
    try {
      const body = await answer.json();
      if (typeof body === "object" && body !== null && typeof (body as { error?: unknown }).error === "string") detail = `: ${(body as { error: string }).error}`;
    } catch {
      detail = "";
    }
    if (answer.status === 404) return { ok: false, reason: "this dispatcher was started without a configuration file, or is an older version that cannot reload it" };
    if (answer.status === 422) return { ok: false, reason: `the dispatcher refused the file and kept its previous values${detail}` };
    if (answer.status === 403) return { ok: false, reason: "the dispatcher reloads only on request from its own machine" };
    return { ok: false, reason: `the dispatcher answered ${answer.status}${detail}` };
  } catch {
    return { ok: false, reason: "the dispatcher does not answer" };
  } finally {
    clearTimeout(abort);
  }
}
