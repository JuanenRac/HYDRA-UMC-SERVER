// =============================================================================
// HYDRA-UMC-SERVER - src/orchestratorConfigFile.ts
// Copyright (C) 2026 JuanenRac (Electro Hobby 3D) <electrohobby3d@gmail.com>
// GPL-3.0-or-later - see LICENSE
// =============================================================================
// The one option of the orchestrator that an administrator can change from Server Admin: `estop.retry_server` (keep asking this server to
// confirm a global stop until it does). It lives in the JSON configuration file the orchestrator reads when it starts (`--config`).
// The same rules as the file of the job dispatcher (dispatcherConfigFile.ts): the path comes from the deployment, only that key is set and
// every other one is kept, a file that is not a JSON object is never overwritten, and the write is atomic.
import fs from "node:fs";
import path from "node:path";

export class OrchestratorConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OrchestratorConfigError";
  }
}

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

function readObject(file: string): Record<string, unknown> {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf-8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw new OrchestratorConfigError(`the configuration file of the orchestrator cannot be read (${(error as Error).message})`);
  }
  if (text.trim() === "") return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new OrchestratorConfigError("the configuration file of the orchestrator is not valid JSON; it was left as it is");
  }
  if (!isObject(parsed)) throw new OrchestratorConfigError("the configuration file of the orchestrator is not a JSON object; it was left as it is");
  return parsed;
}

/** What the file says; on (the default of the orchestrator) unless it says false. Never throws for a missing file. */
export function readRetryServer(file: string): boolean {
  const estop = readObject(file).estop;
  return !(isObject(estop) && estop.retry_server === false);
}

export function writeRetryServer(file: string, retry: boolean): void {
  if (typeof retry !== "boolean") throw new OrchestratorConfigError("retryServer must be true or false");
  const document = readObject(file);
  document.estop = { ...(isObject(document.estop) ? document.estop : {}), retry_server: retry };
  const temp = `${file}.${process.pid}.tmp`;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(temp, `${JSON.stringify(document, null, 2)}\n`, { mode: 0o600, flush: true });
    fs.renameSync(temp, file);
  } catch (error) {
    try { fs.unlinkSync(temp); } catch { /* nothing to remove */ }
    throw new OrchestratorConfigError(`the configuration file of the orchestrator could not be written (${(error as Error).message})`);
  }
}
