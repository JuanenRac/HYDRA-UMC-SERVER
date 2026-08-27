// =============================================================================
// HYDRA-UMC STUDIO - User Account Store: users.ts
// Copyright (C) 2026 JuanenRac (Electro Hobby 3D) <electrohobby3d@gmail.com>
// GPL-3.0 - see LICENSE
//
// Real multi-user accounts, replacing a single hardcoded "demo"/"demo"
// login every server in this ecosystem would otherwise ship with. Two
// roles: "admin" (full access - settings writes, user
// management, robot commands) and "operator" (robot commands only, no
// settings overwrite, no user management) - see server.ts's own
// requireAdmin() for exactly which routes need which.
//
// Passwords are never stored in plaintext - scrypt (Node's own built-in
// crypto module, no external dependency) with a random salt per user,
// verified with a timing-safe comparison. data/users.json is the only
// place credentials live; it's excluded from the server's own static
// file serving the same way data/settings.json already is (see
// server.ts's own settings.json 404 guard, extended to cover this file
// too).
// =============================================================================

import fs from "fs";
import path from "path";
import crypto from "crypto";

export type UserRole = "admin" | "operator";

export interface StoredUser {
  username: string;
  passwordHash: string; // "saltHex:hashHex"
  role: UserRole;
  createdAt: string;
}

type UserResult = { ok: true } | { ok: false; error: string };

const usersPath = () => path.join(process.cwd(), "data", "users.json");

// scrypt cost parameters (SONNET/AUDITORIA_COMPLETA_44_PROYECTOS.txt #7:
// Node's scryptSync default, when no options object is passed at all, is
// N=16384/r=8/p=1 - below the OWASP Password Storage Cheat Sheet's current
// baseline of N=2^17/r=8/p=1. Bumped to that exact OWASP figure rather
// than a smaller in-between value: this only runs once per login attempt
// (not on any hot path like a jog/telemetry command, which never touch
// this file), so the extra ~100ms/~128MB it costs on a CM5 is a real but
// one-time-per-session price, not a recurring one. `maxmem` has to be
// raised alongside N/r or scryptSync throws "Invalid options: memory
// limit exceeded" - Node's own default maxmem (32MB) was sized for the
// OLD N=16384 cost, not this one.
const SCRYPT_OPTIONS: crypto.ScryptOptions = { N: 131072, r: 8, p: 1, maxmem: 256 * 1024 * 1024 };

function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(password, salt, 64, SCRYPT_OPTIONS).toString("hex");
  return `${salt}:${hash}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [salt, hash] = stored.split(":");
  if (!salt || !hash) return false;
  try {
    const hashBuffer = Buffer.from(hash, "hex");
    // Existing accounts hashed before this fix have a 64-byte hash
    // produced with Node's OLD default cost (N=16384) - re-deriving with
    // today's SCRYPT_OPTIONS would produce a different hash and lock
    // every existing user out. Both costs produce the same 64-byte
    // output length, so length alone can't tell them apart; instead try
    // today's cost first (the common case going forward) and fall back
    // to the pre-fix default cost for any hash it doesn't match - a
    // successful login on the fallback path means that account is still
    // on the weaker cost, which changePassword()/resetPassword() (or a
    // fresh hashPassword() call on next password change) upgrades
    // automatically the next time that user sets a password.
    const suppliedHashBuffer = crypto.scryptSync(password, salt, 64, SCRYPT_OPTIONS);
    if (hashBuffer.length === suppliedHashBuffer.length && crypto.timingSafeEqual(hashBuffer, suppliedHashBuffer)) {
      return true;
    }
    const legacyHashBuffer = crypto.scryptSync(password, salt, 64);
    return hashBuffer.length === legacyHashBuffer.length && crypto.timingSafeEqual(hashBuffer, legacyHashBuffer);
  } catch {
    return false;
  }
}

function loadUsers(): StoredUser[] {
  try {
    const raw = fs.readFileSync(usersPath(), "utf-8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function saveUsers(users: StoredUser[]): void {
  const dir = path.dirname(usersPath());
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(usersPath(), JSON.stringify(users, null, 2), "utf-8");
}

/** Called once at startup. Production deployments must supply bootstrap
 * credentials locally; they never receive a known default account. */
export function ensureSeedUser(): void {
  if (loadUsers().length > 0) return;
  const username = process.env.HYDRA_UMC_BOOTSTRAP_ADMIN_USERNAME;
  const password = process.env.HYDRA_UMC_BOOTSTRAP_ADMIN_PASSWORD;
  if (process.env.NODE_ENV === "production" && (!username || !password)) {
    throw new Error("Production first start requires HYDRA_UMC_BOOTSTRAP_ADMIN_USERNAME and HYDRA_UMC_BOOTSTRAP_ADMIN_PASSWORD");
  }
  saveUsers([
    { username: username || "admin", passwordHash: hashPassword(password || "admin"), role: "admin", createdAt: new Date().toISOString() },
  ]);
  console.log("[Users] Initial administrator account created from deployment configuration.");
}

export function findUser(username: string): StoredUser | undefined {
  return loadUsers().find(u => u.username.toLowerCase() === username.toLowerCase());
}

/** For the Config > Users panel - never includes passwordHash. */
export function listUsers(): Array<Omit<StoredUser, "passwordHash">> {
  return loadUsers().map(({ passwordHash: _unused, ...rest }) => rest);
}

export function createUser(username: string, password: string, role: UserRole): UserResult {
  const trimmed = username.trim();
  if (!trimmed) return { ok: false, error: "Username required" };
  if (!password || password.length < 4) return { ok: false, error: "Password must be at least 4 characters" };
  const users = loadUsers();
  if (users.some(u => u.username.toLowerCase() === trimmed.toLowerCase())) {
    return { ok: false, error: "Username already exists" };
  }
  users.push({ username: trimmed, passwordHash: hashPassword(password), role, createdAt: new Date().toISOString() });
  saveUsers(users);
  return { ok: true };
}

export function updateUser(
  username: string,
  updates: { newUsername?: string; password?: string; role?: UserRole }
): UserResult {
  const users = loadUsers();
  const idx = users.findIndex(u => u.username.toLowerCase() === username.toLowerCase());
  if (idx === -1) return { ok: false, error: "User not found" };

  if (updates.newUsername && updates.newUsername.trim().toLowerCase() !== username.toLowerCase()) {
    const newName = updates.newUsername.trim();
    if (!newName) return { ok: false, error: "Username required" };
    if (users.some((u, i) => i !== idx && u.username.toLowerCase() === newName.toLowerCase())) {
      return { ok: false, error: "Username already exists" };
    }
    users[idx].username = newName;
  }
  if (updates.password !== undefined) {
    if (updates.password.length < 4) return { ok: false, error: "Password must be at least 4 characters" };
    users[idx].passwordHash = hashPassword(updates.password);
  }
  if (updates.role) {
    // Guard against demoting the last remaining admin - would lock everyone out of Config > Users.
    if (users[idx].role === "admin" && updates.role !== "admin") {
      const otherAdmins = users.filter((u, i) => i !== idx && u.role === "admin");
      if (otherAdmins.length === 0) return { ok: false, error: "Cannot demote the last remaining admin account" };
    }
    users[idx].role = updates.role;
  }
  saveUsers(users);
  return { ok: true };
}

export function deleteUser(username: string): UserResult {
  const users = loadUsers();
  const target = users.find(u => u.username.toLowerCase() === username.toLowerCase());
  if (!target) return { ok: false, error: "User not found" };
  if (target.role === "admin") {
    const otherAdmins = users.filter(u => u.role === "admin" && u.username.toLowerCase() !== username.toLowerCase());
    if (otherAdmins.length === 0) return { ok: false, error: "Cannot delete the last remaining admin account" };
  }
  saveUsers(users.filter(u => u.username.toLowerCase() !== username.toLowerCase()));
  return { ok: true };
}
