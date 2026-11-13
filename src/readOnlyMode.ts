// =============================================================================
// HYDRA-UMC-SERVER - src/readOnlyMode.ts
// Copyright (C) 2026 JuanenRac (Electro Hobby 3D) <electrohobby3d@gmail.com>
// GPL-3.0 - see LICENSE
// =============================================================================
// Read-only mode of this server (off unless HYDRA_UMC_READ_ONLY is on). While it is on the server shows its robots and their data and changes nothing,
// for every account and every app: a request that writes is answered with 423 `server-read-only` before it reaches a route, and nothing is lost,
// because reading, the sign-in, STOP and the safe-mode disable go on, so the person is told why and the stop is never held back.
// ---------------------------------------------------------------------------------------------------------------------------------------------

/** Is read-only mode on? Only a plain yes (1, true, on, yes) switches it on; anything else, an empty or damaged value included, leaves the server as it is. */
export function readOnlyEnabled(value: string | undefined = process.env.HYDRA_UMC_READ_ONLY): boolean {
  return ["1", "true", "on", "yes"].includes((value ?? "").trim().toLowerCase());
}

const SESSION_PATH = /^\/api\/(login|logout|refresh)\/?$/;
const TICKET_PATH = /^\/api\/(camera|info)\/ticket\/?$/;
const ROBOT_COMMAND_PATH = /^\/api\/robot\/[^/]+\/command\/?$/;

/**
 * Whether a request may go on in read-only mode: a read, the session (sign in, renewal, sign out), the tickets that only read in substance,
 * the global stop, and a robot command that is a stop or the safe-mode disable. `command` is the `command` of the body of a robot command.
 */
export function readOnlyAllows(method: string | undefined, path: string | undefined, command?: unknown): boolean {
  const verb = (method ?? "").toUpperCase();
  if (verb === "GET" || verb === "HEAD" || verb === "OPTIONS") return true;
  const clean = (path ?? "").split("?")[0];
  if (verb !== "POST") return false;
  if (SESSION_PATH.test(clean) || TICKET_PATH.test(clean)) return true;
  if (clean.replace(/\/+$/, "") === "/api/stop-all") return true;
  return ROBOT_COMMAND_PATH.test(clean) && (command === "stop" || command === "disable");
}

export const READ_ONLY_REFUSAL = {
  error: "this server is in read-only mode: nothing is changed except STOP and the safe-mode disable",
  code: "server-read-only",
} as const;

export interface ReadOnlyAudit {
  record(entry: { type: string; outcome: string; userId?: unknown; username?: string; ip?: string; detail?: unknown }): void;
}

/** The express middleware. `isOn` is read on every request, so a change applies at once. */
export function makeReadOnlyGate(isOn: () => boolean = () => readOnlyEnabled(), audit?: ReadOnlyAudit) {
  return (req: any, res: any, next: () => void) => {
    if (!isOn()) return next();
    if (readOnlyAllows(String(req.method ?? "GET"), String(req.path ?? ""), req.body?.command)) return next();
    try {
      audit?.record({ type: "read-only", outcome: "refused", userId: req.user?.id, username: req.user?.username, ip: req.ip, detail: { method: req.method, path: req.path } });
    } catch { /* an audit that cannot be written never turns a refusal into an answer of success */ }
    return res.status(423).json(READ_ONLY_REFUSAL);
  };
}
