// =============================================================================
// HYDRA-UMC SERVER - src/listenPort.ts
// Copyright (C) 2026 JuanenRac (Electro Hobby 3D) <electrohobby3d@gmail.com>
// GPL-3.0-or-later - see LICENSE
//
// The listen port of this service. Three services of the same machine used to
// read the one variable PORT, so a shared EnvironmentFile (or an `export
// PORT=3000`) silently moved one of them onto another service's port. Each
// service has a variable of its own, which wins; PORT is only a last resort
// and says so on the console.
// =============================================================================

export type ListenPortSource = "specific" | "PORT" | "config" | "default";

export interface ResolvedListenPort {
  port: number;
  source: ListenPortSource;
  warning?: string;
}

export const SERVER_PORT_VARIABLE = "HYDRA_UMC_SERVER_PORT";

function parseListenPort(raw: string | undefined): number | undefined {
  if (raw === undefined || raw.trim() === "") return undefined;
  const value = Number(raw);
  return Number.isInteger(value) && value > 0 && value < 65536 ? value : undefined;
}

export function resolveListenPort(
  env: Record<string, string | undefined>,
  configPort: number | undefined,
  fallback = 3000,
): ResolvedListenPort {
  const specific = parseListenPort(env[SERVER_PORT_VARIABLE]);
  if (specific !== undefined) return { port: specific, source: "specific" };
  const shared = parseListenPort(env.PORT);
  if (shared !== undefined) {
    return {
      port: shared,
      source: "PORT",
      warning: `${SERVER_PORT_VARIABLE} is not set: using the shared PORT=${shared}. Set ${SERVER_PORT_VARIABLE} so another service of this machine cannot move this one.`,
    };
  }
  if (Number.isInteger(configPort) && (configPort as number) > 0) return { port: configPort as number, source: "config" };
  return { port: fallback, source: "default" };
}
