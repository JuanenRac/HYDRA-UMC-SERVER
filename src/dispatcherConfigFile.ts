// =============================================================================
// HYDRA-UMC-SERVER - src/dispatcherConfigFile.ts
// Copyright (C) 2026 JuanenRac (Electro Hobby 3D) <electrohobby3d@gmail.com>
// GPL-3.0-or-later - see LICENSE
// =============================================================================
// The two options of the replanning of the job dispatcher that an administrator can change from Server Admin:
// `replan.allow_unconfirmed` (send a job back to the queue when a silent robot never confirmed its stop) and
// `replan.stop_ack_timeout_seconds` (how long to wait for that confirmation). They live in the JSON configuration
// file that the dispatcher reads when it starts (its `-config` option); this module is the only place that writes it.
//
// Rules:
//   - the path comes from the deployment (HYDRA_UMC_JOB_DISPATCHER_CONFIG or `jobDispatcher.configFile` in the settings
//     file), never from a request: an administrator can change the two values, not choose a file to overwrite;
//   - the file is read as it is, only those two keys of the `replan` section are set, and every other key (the dispatcher
//     refuses a file with a key it does not know) is kept as it was;
//   - a file that cannot be read as a JSON object is never overwritten (fail closed);
//   - the write is atomic: a temporary file next to it, flushed, then renamed over it;
//   - the ranges are the ones of the dispatcher: the timeout is greater than 0 and at most 86400 seconds.
import fs from "node:fs";
import path from "node:path";

export const DEFAULT_STOP_ACK_TIMEOUT_SECONDS = 30;
export const MAX_STOP_ACK_TIMEOUT_SECONDS = 86400;

export interface ReplanOptions {
  allowUnconfirmed: boolean;
  stopAckTimeoutSeconds: number;
}

export class DispatcherConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DispatcherConfigError";
  }
}

export function validTimeout(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 && value <= MAX_STOP_ACK_TIMEOUT_SECONDS;
}

function readObject(file: string): Record<string, unknown> {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf-8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw new DispatcherConfigError(`the configuration file of the dispatcher cannot be read (${(error as Error).message})`);
  }
  if (text.trim() === "") return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new DispatcherConfigError("the configuration file of the dispatcher is not valid JSON; it was left as it is");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new DispatcherConfigError("the configuration file of the dispatcher is not a JSON object; it was left as it is");
  }
  return parsed as Record<string, unknown>;
}

/** What the file says now; the dispatcher's own defaults for what it leaves out. Never throws for a missing file. */
export function readReplanOptions(file: string): ReplanOptions {
  const replan = readObject(file).replan;
  const section = typeof replan === "object" && replan !== null && !Array.isArray(replan) ? (replan as Record<string, unknown>) : {};
  return {
    allowUnconfirmed: section.allow_unconfirmed === true,
    stopAckTimeoutSeconds: validTimeout(section.stop_ack_timeout_seconds) ? section.stop_ack_timeout_seconds : DEFAULT_STOP_ACK_TIMEOUT_SECONDS,
  };
}

/** Sets the two options and nothing else, atomically. Returns the options now in the file. */
export function writeReplanOptions(file: string, options: ReplanOptions): ReplanOptions {
  if (typeof options.allowUnconfirmed !== "boolean") throw new DispatcherConfigError("allowUnconfirmed must be true or false");
  if (!validTimeout(options.stopAckTimeoutSeconds)) throw new DispatcherConfigError(`stopAckTimeoutSeconds must be greater than 0 and at most ${MAX_STOP_ACK_TIMEOUT_SECONDS}`);
  const document = readObject(file);
  const previous = document.replan;
  const section: Record<string, unknown> = typeof previous === "object" && previous !== null && !Array.isArray(previous) ? { ...(previous as Record<string, unknown>) } : {};
  section.allow_unconfirmed = options.allowUnconfirmed;
  section.stop_ack_timeout_seconds = options.stopAckTimeoutSeconds;
  document.replan = section;
  const text = `${JSON.stringify(document, null, 2)}\n`;
  const temp = `${file}.${process.pid}.tmp`;
  let descriptor: number | undefined;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    descriptor = fs.openSync(temp, "w", 0o600);
    fs.writeSync(descriptor, text);
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    fs.renameSync(temp, file);
  } catch (error) {
    if (descriptor !== undefined) {
      try { fs.closeSync(descriptor); } catch { /* best effort */ }
    }
    try { fs.unlinkSync(temp); } catch { /* nothing to remove */ }
    throw new DispatcherConfigError(`the configuration file of the dispatcher could not be written (${(error as Error).message})`);
  }
  return { allowUnconfirmed: options.allowUnconfirmed, stopAckTimeoutSeconds: options.stopAckTimeoutSeconds };
}
