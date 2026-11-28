// =============================================================================
// HYDRA-UMC-SERVER - src/robotTokens.ts
// Copyright (C) 2026 JuanenRac (Electro Hobby 3D) <electrohobby3d@gmail.com>
// GPL-3.0-or-later - see LICENSE
// =============================================================================
// The job dispatcher can give a robot a token of its own (its `robot_tokens` section): only that token, or the general one, may then speak for
// the robot. This server speaks for the robots of its roster (the stop acknowledgement of src/jobStopRelay.ts and the registration of
// src/dispatcherRegistrar.ts), so `jobDispatcher.robotTokenEnv` of data/server-config.json maps a dispatcher robot id to the NAME of an environment
// variable with that robot's token. Empty by default: every call then carries what it carried before. A token is never kept in the settings file.

export type RobotTokensResolution = { ok: true; tokens: Record<string, string> } | { ok: false; error: string };

const VARIABLE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Fails closed, like the dispatcher: a variable that is empty, a token of two robots or one equal to the general token is an error. */
export function resolveRobotTokens(section: unknown, env: Record<string, string | undefined>, generalToken: string): RobotTokensResolution {
  if (section === undefined) return { ok: true, tokens: {} };
  if (typeof section !== "object" || section === null || Array.isArray(section)) return { ok: false, error: "jobDispatcher.robotTokenEnv must be an object" };
  const tokens: Record<string, string> = {};
  const seen = new Set<string>();
  for (const [robot, name] of Object.entries(section)) {
    if (robot === "" || typeof name !== "string" || !VARIABLE.test(name)) return { ok: false, error: "jobDispatcher.robotTokenEnv: every entry needs a robot id and the name of an environment variable" };
    const value = (env[name] ?? "").trim();
    if (value === "") return { ok: false, error: `jobDispatcher.robotTokenEnv: the environment variable of robot "${robot}" is empty` };
    if (value === generalToken) return { ok: false, error: `jobDispatcher.robotTokenEnv: robot "${robot}" has the token of the dispatcher` };
    if (seen.has(value)) return { ok: false, error: `jobDispatcher.robotTokenEnv: robot "${robot}" shares its token with another robot` };
    seen.add(value);
    tokens[robot] = value;
  }
  return { ok: true, tokens };
}

/** The token of a robot, or undefined (an id that is not a key of the map never reads a property of Object). */
export function robotTokenOf(tokens: Record<string, string> | undefined, robot: string): string | undefined {
  return tokens && Object.prototype.hasOwnProperty.call(tokens, robot) ? tokens[robot] : undefined;
}
