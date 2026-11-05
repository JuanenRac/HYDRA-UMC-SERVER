// =============================================================================
// HYDRA-UMC-SERVER - src/serviceIdentity.ts
// Copyright (C) 2026 JuanenRac (Electro Hobby 3D) <electrohobby3d@gmail.com>
// GPL-3.0-or-later - see LICENSE
// =============================================================================
// The one outbound client of identity: what this server presents to the services it calls.
//
// The server is the one issuer of identity of the family. A service whose identity switch is on (see HYDRA-UMC-OS, docs/SERVER_IDENTITY.md)
// refuses a request with no credential, even from this machine, so every call this server makes to a service (the state of the family,
// the health probes, the relays) must be able to carry a signed token. This module makes it: a short token (sixty seconds) in the format
// the services verify (HS256, claims username, role and exp), signed with the same JWT_SECRET that signs the sign-in tokens.
//
// Off by default and then invisible: with the switch off nothing is signed and no header is added, so a request is the one it always was.
// It is also silent when the key is unusable (unset, an example value, too short): a token signed with a public default would be a forgery
// kit, so none is made. A service that has a token of its own keeps receiving it (see upstreamAuth.ts): the signed token fills the gap of
// the services that had none, which are the ones the key closes.
import jwt from "jsonwebtoken";
import { jwtSecretProblem } from "./secretsPolicy";

export type Env = Record<string, string | undefined>;
export type IdentityRole = "admin" | "operator" | "viewer";

/** The environment word that decides the switch before the configuration file does: "1" turns it on, "0" turns it off, and an administrator cannot change what it says. */
export const SERVICE_IDENTITY_ENV_SWITCH = "HYDRA_UMC_SERVICE_IDENTITY";
/** The name the services see as the caller. */
export const SERVICE_IDENTITY_USERNAME = "hydra-umc-server";
/** A token lives this long: it is made for one request. */
export const SERVICE_TOKEN_TTL_SECONDS = 60;

/** The switch of the environment: `on`, `off` or null when it says nothing (any other word says nothing). */
export function identityEnvSwitch(env: Env = process.env): "on" | "off" | null {
  const word = (env[SERVICE_IDENTITY_ENV_SWITCH] ?? "").trim();
  if (word === "1") return "on";
  if (word === "0") return "off";
  return null;
}

let switchProvider: (() => boolean) | null = null;

/** The server wires the resolved switch (environment, then configuration file, then off) once its configuration is loaded. Tests reset it with null. */
export function setServiceIdentitySwitch(provider: (() => boolean) | null): void {
  switchProvider = provider;
}

/** Is the switch on? The wired provider when there is one, else the environment alone. */
export function serviceIdentitySwitchOn(env: Env = process.env): boolean {
  return switchProvider ? switchProvider() : identityEnvSwitch(env) === "on";
}

/** The key the tokens are signed with (the JWT_SECRET of this server), or "" when it is not fit to sign with. */
export function identityKey(env: Env = process.env): string {
  const secret = (env.JWT_SECRET ?? "").trim();
  return secret && jwtSecretProblem(secret) === null ? secret : "";
}

/** Why no token would be made right now: "off" (the switch), "no_key" (unusable JWT_SECRET), or null when tokens are made. */
export function serviceIdentityIdle(env: Env = process.env): "off" | "no_key" | null {
  if (!serviceIdentitySwitchOn(env)) return "off";
  if (!identityKey(env)) return "no_key";
  return null;
}

/** A token for `role`, or "" when the switch is off or the key is unusable. `now` is in seconds. */
export function signServiceToken(role: IdentityRole, env: Env = process.env, now: number = Math.floor(Date.now() / 1000)): string {
  if (serviceIdentityIdle(env) !== null) return "";
  // no iat: a clock a little behind on another machine must not make a fresh token look like it comes from the future
  return jwt.sign({ username: SERVICE_IDENTITY_USERNAME, role, exp: now + SERVICE_TOKEN_TTL_SECONDS }, identityKey(env), { algorithm: "HS256", noTimestamp: true });
}

/** `{ authorization: "Bearer <token>" }` for `role`, or nothing when no token is made. */
export function identityHeader(role: IdentityRole, env: Env = process.env, now?: number): Record<string, string> {
  const token = signServiceToken(role, env, now);
  return token ? { authorization: `Bearer ${token}` } : {};
}

/** The role a request needs: a read is a viewer, anything that changes something is an operator. */
export function roleForMethod(method: string | undefined): IdentityRole {
  const m = (method ?? "GET").toUpperCase();
  return m === "GET" || m === "HEAD" || m === "OPTIONS" ? "viewer" : "operator";
}

/**
 * Adds the signed token to a header bag that has no Authorization yet. Used by the callers that build their own headers (the stop relay,
 * the takeover, the reload of the dispatcher, the health probes). A bag that already has an Authorization (the token of the service) is left as it is.
 */
export function withIdentity<T extends Record<string, string>>(headers: T, role: IdentityRole, env: Env = process.env): T {
  const has = Object.keys(headers).some((name) => name.toLowerCase() === "authorization");
  if (has) return headers;
  return { ...headers, ...identityHeader(role, env) };
}
