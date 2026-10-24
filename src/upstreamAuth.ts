// =============================================================================
// HYDRA-UMC-SERVER - src/upstreamAuth.ts
// Copyright (C) 2026 JuanenRac (Electro Hobby 3D) <electrohobby3d@gmail.com>
// GPL-3.0-or-later - see LICENSE
// =============================================================================
// The Bearer tokens this server presents to the services it relays to.
//
// The vision, analysis and data services (VISUAL-SERVOING-API, VLA-ENGINE, VISION-STREAMER, DATALAKE...) can ask for a Bearer
// token of their own; away from loopback some of them refuse to start without one. Clients (STUDIO, SUITE, the phones, the
// dashboard) never talk to those services: they talk to this server with their own session, and this server is the only holder
// of the service tokens. Nothing here is ever sent to a client.
//
// A token is configured the way the service reads it: the variable the service itself uses (so the environment file of the
// deployment is shared), or that name with `_FILE` appended, naming a file whose first line is the token (so a secret does
// not have to sit in the environment). The variable wins over the file. No token is no header: a service that asks for none is
// reached exactly as before.
import fs from "node:fs";

export type Env = Record<string, string | undefined>;

/** The variables, in order of preference, that hold the token of each relayed service (the names the services read). */
export const SERVICE_TOKEN_VARIABLES: Readonly<Record<string, readonly string[]>> = {
  "cognitive-node": ["HYDRA_UMC_COGNITIVE_NODE_TOKEN"],
  "detection-hef": ["HYDRA_UMC_DETECTION_HEF_TOKEN"],
  "visual-servoing-api": ["HYDRA_UMC_VISUAL_SERVOING_TOKEN"],
  "vla-engine": ["HYDRA_UMC_VLA_ENGINE_TOKEN"],
  "vision-node": ["HYDRA_UMC_VISION_NODE_TOKEN"],
  "vision-streamer": ["HYDRA_UMC_VISION_STREAMER_TOKEN"],
  "anomaly-detector": ["HYDRA_UMC_ANOMALY_TOKEN"],
  // the data lake has a token per role; this server only reads, so its read token, then the one for every role
  datalake: ["HYDRA_UMC_DATALAKE_READ_TOKEN", "HYDRA_UMC_DATALAKE_TOKEN"],
};

/** The first line of a token file, trimmed; empty when it cannot be read. */
function readTokenFile(path: string, read: (path: string) => string): string {
  try {
    return read(path).split(/\r?\n/, 1)[0].trim();
  } catch {
    return "";
  }
}

/** The token held by the first of `variables` that has one (the variable itself, else its `_FILE`); empty when none. */
export function resolveToken(variables: readonly string[], env: Env = process.env, read: (path: string) => string = (p) => fs.readFileSync(p, "utf-8")): string {
  for (const name of variables) {
    const direct = (env[name] ?? "").trim();
    if (direct) return direct;
    const file = (env[`${name}_FILE`] ?? "").trim();
    if (file) {
      const fromFile = readTokenFile(file, read);
      if (fromFile) return fromFile;
    }
  }
  return "";
}

/** The token this server presents to `service` (one of the keys of SERVICE_TOKEN_VARIABLES); empty when it has none or the service is unknown. */
export function tokenForService(service: string, env: Env = process.env, read?: (path: string) => string): string {
  const variables = SERVICE_TOKEN_VARIABLES[service];
  return variables ? resolveToken(variables, env, read) : "";
}

/** `{ authorization: "Bearer ..." }` for a token, or nothing for an empty one. A token with a line break or a control character is not sent (it could split a header). */
export function bearerHeader(token: string): Record<string, string> {
  // eslint-disable-next-line no-control-regex
  if (!token || /[\u0000-\u001F\u007F]/.test(token)) return {};
  return { authorization: `Bearer ${token}` };
}

/** The headers to present to `service`: its Bearer token when it has one. Reads the configuration on every call, so a token written to its file after the start is used. */
export function upstreamHeaders(service: string, env: Env = process.env, read?: (path: string) => string): Record<string, string> {
  return bearerHeader(tokenForService(service, env, read));
}

/** Which of the relayed services have a token configured (never the tokens themselves): for the status of the installation. */
export function configuredUpstreamTokens(env: Env = process.env, read?: (path: string) => string): Record<string, boolean> {
  return Object.fromEntries(Object.keys(SERVICE_TOKEN_VARIABLES).map((service) => [service, tokenForService(service, env, read) !== ""]));
}
