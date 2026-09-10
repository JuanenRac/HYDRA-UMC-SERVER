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
  // SERVER-01 (P1): a JWT's own {username, role} claims were trusted for the
  // token's entire lifetime - deleting or demoting a user never revoked
  // an already-issued token, and a WebSocket only checked identity once,
  // at connect time. Every real account mutation (password/role change)
  // now bumps this - see effectiveTokenVersion() below and
  // server.ts's own authenticate()/WS connect+heartbeat re-checks, which
  // compare a token's own recorded tokenVersion against this CURRENT
  // value on every request/periodic tick, not just at login. Optional
  // so a users.json written before this field existed still parses -
  // effectiveTokenVersion() treats a missing value as 1, the same
  // starting value every account created after this fix gets explicitly.
  tokenVersion?: number;
  // REV-004 (P1): tokenVersion
  // alone is compared PER USERNAME - deleting an account and recreating
  // the same username reset tokenVersion back to 1 on the new account,
  // and an old, not-yet-expired JWT for the OLD (deleted) account still
  // carried tokenVersion:1 too, so it kept authenticating as the NEW
  // account (possibly with a different role) after "deletion". A real,
  // random, never-reused id (crypto.randomUUID()) fixes this: every
  // freshly created account gets its own real id that can never equal
  // any previous account's, whatever its username. Optional for the
  // same backward-compatibility reason tokenVersion is - see
  // effectiveId() below for the pre-migration fallback, and note in
  // SECURITY.md/CHANGELOG.md that deploying this fix invalidates every
  // already-issued token (none of them carry a real `id` claim yet).
  id?: string;
}

/** SERVER-01: the real, current session generation for `user` - see
 * `StoredUser.tokenVersion`'s own doc comment for why a missing value
 * (an account stored before this field existed) defaults to 1 instead
 * of `undefined`, which would never equal a real token's own claim. */
export function effectiveTokenVersion(user: StoredUser): number {
  return user.tokenVersion ?? 1;
}

/** REV-004: the real, immutable account identity for `user` - see
 * `StoredUser.id`'s own doc comment. A pre-migration account (stored
 * before this field existed) falls back to its own username - safe
 * because that account was never deleted-and-recreated (it is the
 * exact same continuous account this fallback describes); a genuinely
 * NEW account (via createUser()) always gets a real, random id instead
 * of ever falling back to this. */
export function effectiveId(user: StoredUser): string {
  return user.id ?? user.username;
}

type UserResult = { ok: true } | { ok: false; error: string };

const usersPath = () => path.join(process.cwd(), "data", "users.json");

// scrypt cost parameters: Node's scryptSync default, when no options object
// is passed at all, is
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

// SERVER-03 (P1): `crypto.scryptSync` runs on Node's own single main thread -
// blocking it for the ~100ms this cost parameter takes (see the comment
// above) stalls EVERY concurrent HTTP/WebSocket connection this server
// is holding open, including real-time robot command/telemetry traffic,
// for that same ~100ms, on every single login attempt. `crypto.scrypt`'s
// real async form offloads the actual CPU/memory-heavy work onto Node's
// own libuv threadpool instead, so the main thread keeps serving other
// connections while a login is being verified - the standard, idiomatic
// fix for exactly this problem, not a hand-rolled worker pool.
function scryptAsync(password: crypto.BinaryLike, salt: crypto.BinaryLike, keylen: number, options?: crypto.ScryptOptions): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const callback = (err: Error | null, derivedKey: Buffer) => {
      if (err) reject(err);
      else resolve(derivedKey);
    };
    if (options) {
      crypto.scrypt(password, salt, keylen, options, callback);
    } else {
      crypto.scrypt(password, salt, keylen, callback);
    }
  });
}

// SERVER-03's own closure criterion goes further than "don't block the
// main thread": it also asks for a real concurrency/CPU-memory bound and
// an explicit overload rejection, not just an unbounded queue - the async
// scrypt above already moves the cost off the main thread, but nothing
// yet stops an unbounded number of simultaneous logins (or an admin bulk-
// import script hammering createUser/updateUser) from piling up more
// concurrent SCRYPT_OPTIONS-sized (256MB maxmem each) operations than the
// threadpool/host can actually sustain at once. Cap how many run
// concurrently; once even the wait queue itself is full, fail closed with
// a distinct, recognizable error instead of queueing indefinitely (an
// unbounded queue is just a slower-motion version of the same problem).
const MAX_CONCURRENT_SCRYPT_OPS = 4; // Node's own default UV_THREADPOOL_SIZE
const MAX_QUEUED_SCRYPT_OPS = 20;
let activeScryptOps = 0;
const scryptWaiters: Array<() => void> = [];

/** Thrown by withScryptSlot() below when both the concurrent-op slots and
 * the wait queue are full - server.ts's asyncHandler() recognizes this
 * specifically and responds 503 (a real, bounded overload signal) rather
 * than the generic 500 every other unexpected error gets. */
export class ScryptOverloadError extends Error {}

async function withScryptSlot<T>(fn: () => Promise<T>): Promise<T> {
  if (activeScryptOps >= MAX_CONCURRENT_SCRYPT_OPS) {
    if (scryptWaiters.length >= MAX_QUEUED_SCRYPT_OPS) {
      throw new ScryptOverloadError("too many concurrent password operations in progress - try again shortly");
    }
    await new Promise<void>((resolve) => scryptWaiters.push(resolve));
  }
  activeScryptOps += 1;
  try {
    return await fn();
  } finally {
    activeScryptOps -= 1;
    const next = scryptWaiters.shift();
    if (next) next();
  }
}

async function hashPassword(password: string): Promise<string> {
  return withScryptSlot(async () => {
    const salt = crypto.randomBytes(16).toString("hex");
    const hash = (await scryptAsync(password, salt, 64, SCRYPT_OPTIONS)).toString("hex");
    return `${salt}:${hash}`;
  });
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [salt, hash] = stored.split(":");
  if (!salt || !hash) return false;
  // Deliberately outside withScryptSlot's callback: a full queue should
  // surface as ScryptOverloadError to the caller, not be swallowed by the
  // catch below (which is only for a malformed/undecodable stored hash).
  return withScryptSlot(async () => {
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
      const suppliedHashBuffer = await scryptAsync(password, salt, 64, SCRYPT_OPTIONS);
      if (hashBuffer.length === suppliedHashBuffer.length && crypto.timingSafeEqual(hashBuffer, suppliedHashBuffer)) {
        return true;
      }
      const legacyHashBuffer = await scryptAsync(password, salt, 64);
      return hashBuffer.length === legacyHashBuffer.length && crypto.timingSafeEqual(hashBuffer, legacyHashBuffer);
    } catch {
      return false;
    }
  });
}

// SERVER-02 (P1): a real, distinct failure reason - loadUsers() below throws this
// instead of silently returning [] for anything other than the file
// genuinely not existing yet, so a caller (ensureSeedUser() in
// particular) can never mistake real corruption for a fresh install.
export class UsersFileError extends Error {}

function loadUsers(): StoredUser[] {
  let raw: string;
  try {
    raw = fs.readFileSync(usersPath(), "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    // Any OTHER read failure (permission denied, a real I/O error) is
    // NOT "no users file yet" - failing loudly here is safer than
    // silently treating it as a fresh install and overwriting whatever
    // is actually on disk.
    throw new UsersFileError(`could not read ${usersPath()}: ${(err as Error).message}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    // A corrupted/truncated users.json (e.g. from a crash mid-write,
    // before saveUsers() below was made atomic) must never look like
    // "no users file yet" - that used to let ensureSeedUser() silently
    // create a fresh admin account, discarding every real account that
    // file actually held.
    throw new UsersFileError(`${usersPath()} exists but is not valid JSON: ${(err as Error).message}`);
  }
  if (!Array.isArray(parsed)) {
    throw new UsersFileError(`${usersPath()} exists but does not contain a JSON array`);
  }
  return parsed as StoredUser[];
}

function saveUsers(users: StoredUser[]): void {
  const dir = path.dirname(usersPath());
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  // Write to a temp file in the SAME directory first, then rename
  // atomically - fs.renameSync on the same filesystem is atomic on both
  // POSIX and Windows, so a crash/power-loss mid-write leaves either the
  // OLD complete file or the NEW complete file, never a truncated one
  // (the exact real risk loadUsers() above now has to defend against).
  const target = usersPath();
  const tmp = `${target}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(users, null, 2), "utf-8");
  fs.renameSync(tmp, target);
}

// REV-003 (P1): createUser()/
// updateUser()/deleteUser() each do a real read-modify-write cycle
// (loadUsers() -> mutate an in-memory array -> saveUsers()) with a real
// `await` (hashPassword()) sitting in the middle. Two concurrent calls
// each read the SAME on-disk file before either had written its own
// change back, so whichever call's saveUsers() lands last silently wins,
// discarding the other's real account/mutation entirely - reproduced
// with two concurrent createUser() calls against an in-memory stand-in:
// both report ok:true, but only one user survives. A single, in-process
// promise-chained mutex serializes every real mutation below - this
// process is the only writer of data/users.json, so this alone is
// sufficient (a second server process sharing the same file would need a
// real file lock instead, out of scope for this deployment shape).
let usersLockChain: Promise<unknown> = Promise.resolve();
function withUsersLock<T>(fn: () => Promise<T>): Promise<T> {
  const result = usersLockChain.then(fn, fn);
  // Keep the chain alive regardless of this call's own outcome (resolved
  // or rejected) - a failed mutation must never leave every later one
  // waiting on a promise that will never settle.
  usersLockChain = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

/** Called once at startup. Production deployments must supply bootstrap
 * credentials locally; they never receive a known default account. */
export async function ensureSeedUser(): Promise<void> {
  if (loadUsers().length > 0) return;
  const username = process.env.HYDRA_UMC_BOOTSTRAP_ADMIN_USERNAME;
  const password = process.env.HYDRA_UMC_BOOTSTRAP_ADMIN_PASSWORD;
  if (process.env.NODE_ENV === "production" && (!username || !password)) {
    throw new Error("Production first start requires HYDRA_UMC_BOOTSTRAP_ADMIN_USERNAME and HYDRA_UMC_BOOTSTRAP_ADMIN_PASSWORD");
  }
  saveUsers([
    { id: crypto.randomUUID(), username: username || "admin", passwordHash: await hashPassword(password || "admin"), role: "admin", createdAt: new Date().toISOString(), tokenVersion: 1 },
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

export async function createUser(username: string, password: string, role: UserRole): Promise<UserResult> {
  const trimmed = username.trim();
  if (!trimmed) return { ok: false, error: "Username required" };
  if (!password || password.length < 4) return { ok: false, error: "Password must be at least 4 characters" };
  // REV-003: the hashPassword() await below is real, unavoidable async
  // work (see SERVER-03) - withUsersLock() serializes the WHOLE
  // read-modify-write sequence around it, so a concurrent createUser()
  // (or updateUser()/deleteUser()) can never read the same pre-mutation
  // file this call already committed to changing.
  return withUsersLock(async () => {
    const users = loadUsers();
    if (users.some(u => u.username.toLowerCase() === trimmed.toLowerCase())) {
      return { ok: false, error: "Username already exists" };
    }
    // REV-004: a real, random, never-reused id - see StoredUser.id's own
    // doc comment for why this (not tokenVersion alone) is what actually
    // stops an old token from re-authenticating against a same-named
    // account created after the original was deleted.
    users.push({ id: crypto.randomUUID(), username: trimmed, passwordHash: await hashPassword(password), role, createdAt: new Date().toISOString(), tokenVersion: 1 });
    saveUsers(users);
    return { ok: true };
  });
}

export async function updateUser(
  username: string,
  updates: { newUsername?: string; password?: string; role?: UserRole }
): Promise<UserResult> {
  // REV-003: same real race as createUser() above - serialized the same way.
  return withUsersLock(async () => {
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
      users[idx].passwordHash = await hashPassword(updates.password);
    }
    if (updates.role) {
      // Guard against demoting the last remaining admin - would lock everyone out of Config > Users.
      if (users[idx].role === "admin" && updates.role !== "admin") {
        const otherAdmins = users.filter((u, i) => i !== idx && u.role === "admin");
        if (otherAdmins.length === 0) return { ok: false, error: "Cannot demote the last remaining admin account" };
      }
      users[idx].role = updates.role;
    }
    // SERVER-01: any real account mutation reaching this point (rename,
    // password change, or role change) invalidates every token/WebSocket
    // session already issued for this account - see
    // effectiveTokenVersion()'s own doc comment and server.ts's
    // authenticate()/WS re-checks. A stale, already-issued token must
    // never keep authorizing as this account's OLD role/identity forever
    // just because it hasn't expired yet.
    users[idx].tokenVersion = effectiveTokenVersion(users[idx]) + 1;
    saveUsers(users);
    return { ok: true };
  });
}

export async function deleteUser(username: string): Promise<UserResult> {
  // REV-003: same real race as createUser() above - serialized the same
  // way even though this function itself has no `await` of its own, so
  // it can never interleave with a concurrent createUser()/updateUser()
  // either (e.g. delete racing a rename of the SAME account).
  return withUsersLock(async () => {
    const users = loadUsers();
    const target = users.find(u => u.username.toLowerCase() === username.toLowerCase());
    if (!target) return { ok: false, error: "User not found" };
    if (target.role === "admin") {
      const otherAdmins = users.filter(u => u.role === "admin" && u.username.toLowerCase() !== username.toLowerCase());
      if (otherAdmins.length === 0) return { ok: false, error: "Cannot delete the last remaining admin account" };
    }
    saveUsers(users.filter(u => u.username.toLowerCase() !== username.toLowerCase()));
    return { ok: true };
  });
}
