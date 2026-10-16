/**
 * What a production server accepts as its signing secret and as the first administrator's password.
 * A deployment template carries example values (`SET_LOCALLY_TO_A_LONG_RANDOM_VALUE`) so that nobody has to guess the variable names; a server that accepted them
 * as they stand would let anybody who has read the template forge an administrator's token or sign in with the example password.
 * Copyright (C) 2026 JuanenRac (Electro Hobby 3D). GPL-3.0-or-later.
 */

/** Words that only appear in an example value, a placeholder or a published default. */
const PLACEHOLDER = /(set[_ -]?locally|change[_ -]?me|replace[_ -]?me|your[_ -]?(secret|password)|example|placeholder|hydra_industrial_secret|hydraumc-setup|remove[_ -]?after)/i;

export const MIN_JWT_SECRET_LENGTH = 32;
export const MIN_BOOTSTRAP_PASSWORD_LENGTH = 12;
export const MIN_PASSWORD_LENGTH = 8;

export function looksLikeAPlaceholder(value: string): boolean {
  return PLACEHOLDER.test(value);
}

/** The reason a production JWT secret is refused, or null when it is acceptable. */
export function jwtSecretProblem(secret: string): string | null {
  if (looksLikeAPlaceholder(secret)) return "JWT_SECRET is an example value from a deployment template: generate a real one (for example `openssl rand -hex 32`)";
  if (secret.length < MIN_JWT_SECRET_LENGTH) return `JWT_SECRET must have at least ${MIN_JWT_SECRET_LENGTH} characters`;
  if (new Set(secret).size < 8) return "JWT_SECRET is too repetitive to be a random value";
  return null;
}

/** The reason a production bootstrap administrator password is refused, or null when it is acceptable. */
export function bootstrapPasswordProblem(password: string, username: string): string | null {
  if (looksLikeAPlaceholder(password)) return "the bootstrap administrator password is an example value from a deployment template";
  if (password.length < MIN_BOOTSTRAP_PASSWORD_LENGTH) return `the bootstrap administrator password must have at least ${MIN_BOOTSTRAP_PASSWORD_LENGTH} characters`;
  if (username && password.toLowerCase().includes(username.toLowerCase())) return "the bootstrap administrator password must not contain the username";
  return null;
}
