// =============================================================================
// HYDRA-UMC-SERVER - Direct unit tests for src/users.ts
// Copyright (C) 2026 JuanenRac (Electro Hobby 3D) <electrohobby3d@gmail.com>
// GPL-3.0 - see LICENSE
// =============================================================================
// Found while auditing the code (SERVER-01/02/03,
// all P1): this store had zero direct unit tests of its own - the only
// coverage touching it at all was tools/verify_auth_negative.mjs, a real
// end-to-end contract script that proves anonymous/invalid-token/wrong-role
// requests are denied, but never exercises users.json corruption, atomic
// save, or session-revocation via tokenVersion. Run in-process with node's
// own test runner (via `tsx --test`, same convention as
// tests/serverPolicy.test.ts), each test in its own temp directory switched
// to via process.chdir() - usersPath() in src/users.ts resolves against
// process.cwd(), the same real mechanism the running server itself uses.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import {
  effectiveTokenVersion,
  effectiveId,
  UsersFileError,
  ScryptOverloadError,
  ensureSeedUser,
  findUser,
  listUsers,
  createUser,
  updateUser,
  deleteUser,
  verifyPassword,
  type StoredUser,
} from "../src/users";

/** Runs `fn` with process.cwd() pointed at a fresh, empty temp directory -
 * every users.ts function resolves data/users.json against cwd, so this is
 * the real isolation boundary, not a mock. Always restores the original
 * cwd and removes the temp directory afterward, even if `fn` throws. */
async function withTempCwd<T>(fn: (dir: string) => Promise<T> | T): Promise<T> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hydra-umc-server-users-test-"));
  const originalCwd = process.cwd();
  process.chdir(dir);
  try {
    return await fn(dir);
  } finally {
    process.chdir(originalCwd);
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
}

function writeRawUsersJson(dir: string, content: string): void {
  const dataDir = path.join(dir, "data");
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(path.join(dataDir, "users.json"), content, "utf-8");
}

test("effectiveTokenVersion", async (t) => {
  await t.test("defaults a users.json written before SERVER-01 (no tokenVersion field) to 1", () => {
    const legacy = { username: "x", passwordHash: "s:h", role: "admin", createdAt: "" } as StoredUser;
    assert.equal(effectiveTokenVersion(legacy), 1);
  });
  await t.test("returns the real stored value once one exists", () => {
    const user = { username: "x", passwordHash: "s:h", role: "admin", createdAt: "", tokenVersion: 7 } as StoredUser;
    assert.equal(effectiveTokenVersion(user), 7);
  });
});

test("effectiveId - REV-004", async (t) => {
  await t.test("defaults a users.json written before REV-004 (no id field) to the username", () => {
    const legacy = { username: "x", passwordHash: "s:h", role: "admin", createdAt: "" } as StoredUser;
    assert.equal(effectiveId(legacy), "x");
  });
  await t.test("returns the real stored id once one exists, never the username", () => {
    const user = { username: "x", passwordHash: "s:h", role: "admin", createdAt: "", id: "real-uuid-value" } as StoredUser;
    assert.equal(effectiveId(user), "real-uuid-value");
  });
});

test("loadUsers (via findUser/listUsers) - SERVER-02", async (t) => {
  await t.test("a genuinely missing users.json is a fresh install, not an error", async () => {
    await withTempCwd(() => {
      assert.deepEqual(listUsers(), []);
      assert.equal(findUser("admin"), undefined);
    });
  });

  await t.test("corrupted/truncated JSON throws UsersFileError instead of looking like a fresh install", async () => {
    await withTempCwd((dir) => {
      writeRawUsersJson(dir, '[{"username": "admin", "passwordHash": ');
      assert.throws(() => listUsers(), UsersFileError);
    });
  });

  await t.test("a users.json that parses but isn't a JSON array throws UsersFileError", async () => {
    await withTempCwd((dir) => {
      writeRawUsersJson(dir, JSON.stringify({ username: "admin" }));
      assert.throws(() => listUsers(), UsersFileError);
    });
  });

  await t.test("ensureSeedUser never mistakes real corruption for an empty file and overwrites it", async () => {
    await withTempCwd(async (dir) => {
      writeRawUsersJson(dir, "not json at all");
      await assert.rejects(() => ensureSeedUser(), UsersFileError);
      // The original corrupt content must still be on disk - a caller
      // that let this slide would have silently discarded every real
      // account that file held.
      assert.equal(fs.readFileSync(path.join(dir, "data", "users.json"), "utf-8"), "not json at all");
    });
  });
});

test("saveUsers atomicity (via createUser) - SERVER-02", async (t) => {
  await t.test("leaves no orphaned .tmp file behind after a normal write", async () => {
    await withTempCwd(async (dir) => {
      const result = await createUser("operator-1", "a-real-password", "operator");
      assert.equal(result.ok, true);
      const entries = fs.readdirSync(path.join(dir, "data"));
      assert.ok(entries.includes("users.json"));
      assert.ok(!entries.some((name) => name.endsWith(".tmp")), `unexpected leftover temp file(s): ${entries.join(", ")}`);
    });
  });

  await t.test("the users.json written on disk round-trips through loadUsers unchanged", async () => {
    await withTempCwd(async () => {
      await createUser("operator-1", "a-real-password", "operator");
      const users = listUsers();
      assert.equal(users.length, 1);
      assert.equal(users[0].username, "operator-1");
      assert.equal(users[0].role, "operator");
    });
  });
});

test("createUser - SERVER-01 tokenVersion seeding", async (t) => {
  await t.test("a freshly created account starts at tokenVersion 1, explicitly", async () => {
    await withTempCwd(async () => {
      await createUser("operator-1", "a-real-password", "operator");
      const stored = findUser("operator-1");
      assert.ok(stored);
      assert.equal(stored!.tokenVersion, 1);
    });
  });

  await t.test("rejects a duplicate username without touching tokenVersion semantics", async () => {
    await withTempCwd(async () => {
      await createUser("operator-1", "a-real-password", "operator");
      const result = await createUser("Operator-1", "another-password", "operator");
      assert.equal(result.ok, false);
    });
  });

  await t.test("a freshly created account gets a real id, distinct from its own username - REV-004", async () => {
    await withTempCwd(async () => {
      await createUser("operator-1", "a-real-password", "operator");
      const stored = findUser("operator-1")!;
      assert.ok(stored.id, "a freshly created account must always get a real id");
      assert.notEqual(stored.id, stored.username);
    });
  });
});

test("updateUser bumps tokenVersion on every real mutation - SERVER-01", async (t) => {
  await t.test("a password change bumps tokenVersion, revoking every already-issued token/session", async () => {
    await withTempCwd(async () => {
      await createUser("operator-1", "old-password", "operator");
      const before = findUser("operator-1")!.tokenVersion;
      const result = await updateUser("operator-1", { password: "new-password" });
      assert.equal(result.ok, true);
      assert.equal(findUser("operator-1")!.tokenVersion, (before ?? 1) + 1);
    });
  });

  await t.test("a role change bumps tokenVersion", async () => {
    await withTempCwd(async () => {
      await createUser("admin-2", "old-password", "admin");
      await createUser("admin-1", "old-password", "admin");
      const before = findUser("admin-2")!.tokenVersion;
      await updateUser("admin-2", { role: "operator" });
      assert.equal(findUser("admin-2")!.tokenVersion, (before ?? 1) + 1);
    });
  });

  await t.test("a rename alone still bumps tokenVersion - the account's identity itself changed", async () => {
    await withTempCwd(async () => {
      await createUser("operator-1", "old-password", "operator");
      const before = findUser("operator-1")!.tokenVersion;
      await updateUser("operator-1", { newUsername: "operator-1-renamed" });
      const after = findUser("operator-1-renamed")!;
      assert.equal(after.tokenVersion, (before ?? 1) + 1);
    });
  });

  await t.test("a legacy account with no stored tokenVersion bumps from the implied default of 1, not from undefined+1=NaN", async () => {
    await withTempCwd(async (dir) => {
      const legacyUser: StoredUser = {
        username: "legacy-admin",
        passwordHash: "deadbeef:deadbeef",
        role: "admin",
        createdAt: new Date().toISOString(),
        // tokenVersion intentionally omitted - simulates a users.json
        // written before SERVER-01 existed.
      };
      writeRawUsersJson(dir, JSON.stringify([legacyUser]));
      await updateUser("legacy-admin", { role: "admin" === legacyUser.role ? "admin" : "operator" });
      // role update above is a no-op value-wise for role but updateUser
      // still runs the tokenVersion bump unconditionally once any
      // updates.role is provided at all.
      assert.equal(findUser("legacy-admin")!.tokenVersion, 2);
    });
  });

  await t.test("refuses to demote the last remaining admin, and does not bump tokenVersion when it refuses", async () => {
    await withTempCwd(async () => {
      await createUser("only-admin", "old-password", "admin");
      const before = findUser("only-admin")!.tokenVersion;
      const result = await updateUser("only-admin", { role: "operator" });
      assert.equal(result.ok, false);
      assert.equal(findUser("only-admin")!.tokenVersion, before);
    });
  });
});

test("deleteUser", async (t) => {
  await t.test("refuses to delete the last remaining admin", async () => {
    await withTempCwd(async () => {
      await createUser("only-admin", "old-password", "admin");
      const result = await deleteUser("only-admin");
      assert.equal(result.ok, false);
      assert.equal(listUsers().length, 1);
    });
  });

  await t.test("removes a real, non-last-admin account", async () => {
    await withTempCwd(async () => {
      await createUser("operator-1", "old-password", "operator");
      const result = await deleteUser("operator-1");
      assert.equal(result.ok, true);
      assert.equal(listUsers().length, 0);
    });
  });
});

test("REV-003 - concurrent mutations no longer lose a real account", async (t) => {
  await t.test("two concurrent createUser calls for DIFFERENT usernames both survive", async () => {
    // Before the withUsersLock() fix, both calls' own loadUsers() read the
    // same pre-mutation file (the race window is hashPassword()'s own
    // await), so whichever saveUsers() ran last silently discarded the
    // other's real account - reproduced this exact way against the real
    // file store, no mock.
    await withTempCwd(async () => {
      const [a, b] = await Promise.all([
        createUser("concurrent-a", "a-real-password", "operator"),
        createUser("concurrent-b", "a-real-password", "operator"),
      ]);
      assert.equal(a.ok, true);
      assert.equal(b.ok, true);
      assert.equal(listUsers().length, 2, "both real accounts must survive, not just whichever wrote last");
      assert.ok(findUser("concurrent-a"));
      assert.ok(findUser("concurrent-b"));
    });
  });

  await t.test("a createUser racing an updateUser of a different account both apply", async () => {
    await withTempCwd(async () => {
      await createUser("existing", "old-password", "operator");
      const [created, updated] = await Promise.all([
        createUser("new-account", "a-real-password", "operator"),
        updateUser("existing", { password: "new-password" }),
      ]);
      assert.equal(created.ok, true);
      assert.equal(updated.ok, true);
      assert.equal(listUsers().length, 2);
      assert.ok(await verifyPassword("new-password", findUser("existing")!.passwordHash));
    });
  });

  await t.test("many concurrent createUser calls all survive, none silently overwritten", async () => {
    await withTempCwd(async () => {
      const results = await Promise.all(
        Array.from({ length: 10 }, (_, i) => createUser(`bulk-${i}`, "a-real-password", "operator")),
      );
      assert.ok(results.every((r) => r.ok === true));
      assert.equal(listUsers().length, 10);
    });
  });
});

test("REV-004 - a recreated account never reuses a deleted account's identity", async (t) => {
  await t.test("deleting and recreating the same username produces a real, different id", async () => {
    await withTempCwd(async () => {
      await createUser("recycled", "old-password", "operator");
      const original = findUser("recycled")!;
      await deleteUser("recycled");
      await createUser("recycled", "new-password", "admin"); // even with a different role
      const recreated = findUser("recycled")!;
      assert.notEqual(effectiveId(recreated), effectiveId(original), "a recreated account must never reuse the deleted account's own identity");
      // tokenVersion alone (SERVER-01's own fix) resets to 1 on the new
      // account too - this is the exact real gap effectiveId() closes.
      assert.equal(recreated.tokenVersion, 1);
      assert.equal(original.tokenVersion, 1);
    });
  });

  await t.test("a pre-migration account with no stored id falls back to its own username, unchanged", async () => {
    await withTempCwd((dir) => {
      const legacyUser: StoredUser = {
        username: "legacy-admin",
        passwordHash: "deadbeef:deadbeef",
        role: "admin",
        createdAt: new Date().toISOString(),
        // id intentionally omitted - simulates a users.json written
        // before REV-004's fix existed.
      };
      writeRawUsersJson(dir, JSON.stringify([legacyUser]));
      assert.equal(effectiveId(findUser("legacy-admin")!), "legacy-admin");
    });
  });
});

test("hashPassword/verifyPassword (async, SERVER-03)", async (t) => {
  await t.test("a login with the correct password succeeds and a wrong one fails, now that both are async", async () => {
    await withTempCwd(async () => {
      await createUser("operator-1", "correct-password", "operator");
      const stored = findUser("operator-1")!;
      assert.equal(await verifyPassword("correct-password", stored.passwordHash), true);
      assert.equal(await verifyPassword("wrong-password", stored.passwordHash), false);
    });
  });

  await t.test("a malformed stored hash (no salt:hash separator) fails closed instead of throwing", async () => {
    assert.equal(await verifyPassword("anything", "not-a-real-stored-hash"), false);
  });

  await t.test("still accepts a pre-fix account hashed with Node's old default scrypt cost (the legacy fallback path)", async () => {
    await withTempCwd(async () => {
      const salt = crypto.randomBytes(16).toString("hex");
      // Deliberately built with NO options object, matching exactly what
      // this codebase's own hashPassword() used to call before SERVER-03
      // bumped the cost parameters - this is the real shape an account
      // created before that fix still has on disk today.
      const legacyHash = crypto.scryptSync("legacy-password", salt, 64).toString("hex");
      assert.equal(await verifyPassword("legacy-password", `${salt}:${legacyHash}`), true);
      assert.equal(await verifyPassword("wrong-password", `${salt}:${legacyHash}`), false);
    });
  });
});

test("scrypt concurrency bound - SERVER-03 overload rejection", async (t) => {
  await t.test("once concurrent + queued operations are exhausted, further attempts fail closed with ScryptOverloadError instead of queueing forever", async () => {
    let stored: string;
    await withTempCwd(async () => {
      await createUser("load-test", "a-real-password", "operator");
      stored = findUser("load-test")!.passwordHash;
    });
    // MAX_CONCURRENT_SCRYPT_OPS (4) + MAX_QUEUED_SCRYPT_OPS (20) = 24 real
    // slots. Array.from's mapper runs synchronously for every index before
    // any of these promises has a chance to settle, so this burst reaches
    // withScryptSlot()'s own queue-full branch deterministically - not a
    // timing-dependent race.
    const attempts = Array.from({ length: 30 }, () => verifyPassword("a-real-password", stored));
    const settled = await Promise.allSettled(attempts);
    const rejected = settled.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    const fulfilled = settled.filter((r): r is PromiseFulfilledResult<boolean> => r.status === "fulfilled");
    assert.equal(rejected.length, 6, `expected exactly 6 of 30 calls to overflow 24 real slots, got ${rejected.length}`);
    for (const r of rejected) assert.ok(r.reason instanceof ScryptOverloadError);
    assert.equal(fulfilled.length, 24);
    assert.ok(fulfilled.every((r) => r.value === true), "every admitted call used the correct password and must still succeed");
  });
});

test("ensureSeedUser - SERVER-01 tokenVersion seeding", async (t) => {
  await t.test("the bootstrap admin starts at tokenVersion 1", async () => {
    await withTempCwd(async () => {
      const originalEnv = { ...process.env };
      delete process.env.NODE_ENV;
      process.env.HYDRA_UMC_BOOTSTRAP_ADMIN_USERNAME = "seed-admin";
      process.env.HYDRA_UMC_BOOTSTRAP_ADMIN_PASSWORD = "seed-password";
      try {
        await ensureSeedUser();
        const stored = findUser("seed-admin");
        assert.ok(stored);
        assert.equal(stored!.tokenVersion, 1);
      } finally {
        process.env = originalEnv;
      }
    });
  });

  await t.test("never re-seeds once a real account already exists", async () => {
    await withTempCwd(async () => {
      await createUser("existing-admin", "existing-password", "admin");
      await ensureSeedUser();
      assert.equal(listUsers().length, 1);
      assert.equal(listUsers()[0].username, "existing-admin");
    });
  });
});
