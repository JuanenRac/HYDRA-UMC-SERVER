// =============================================================================
// HYDRA-UMC-SERVER - Direct unit tests for src/refresh_tokens.ts
// Copyright (C) 2026 JuanenRac (Electro Hobby 3D) <electrohobby3d@gmail.com>
// GPL-3.0 - see LICENSE
// =============================================================================
// real unit coverage for the refresh-token store, same in-process/
// temp-cwd convention as tests/users.test.ts (usersPath()/refreshTokensPath()
// both resolve against process.cwd(), the same real mechanism the running
// server itself uses - no mocked file I/O).
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  issueRefreshToken,
  consumeRefreshToken,
  revokeRefreshToken,
  pruneExpiredRefreshTokens,
  openSessionsByClient,
  RefreshTokensFileError,
  MAX_REFRESH_TOKENS_PER_USER,
  hashRefreshToken,
  peekRefreshToken,
} from "../src/refresh_tokens";
import { createUser, findUser, type StoredUser } from "../src/users";

async function withTempCwd<T>(fn: (dir: string) => Promise<T> | T): Promise<T> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hydra-umc-server-refresh-test-"));
  const originalCwd = process.cwd();
  process.chdir(dir);
  try {
    return await fn(dir);
  } finally {
    process.chdir(originalCwd);
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
}

function writeRawRefreshTokensJson(dir: string, content: string): void {
  const dataDir = path.join(dir, "data");
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(path.join(dataDir, "refresh_tokens.json"), content, "utf-8");
}

test("issueRefreshToken + consumeRefreshToken - real round trip", async () => {
  await withTempCwd(async () => {
    await createUser("alice", "correcthorsebattery", "operator");
    const alice = findUser("alice") as StoredUser;
    const token = issueRefreshToken(alice);
    assert.match(token, /^[0-9a-f]{64}$/, "opaque 32-byte hex token");

    const result = consumeRefreshToken(token);
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.user.username, "alice");
      assert.notEqual(result.refreshToken, token, "rotated on use");
    }
  });
});

test("issueRefreshToken - keeps only the newest tokens per account", async () => {
  await withTempCwd(async () => {
    await createUser("dave", "correcthorsebattery", "operator");
    const dave = findUser("dave") as StoredUser;
    const issued: string[] = [];
    for (let i = 0; i < MAX_REFRESH_TOKENS_PER_USER + 3; i++) issued.push(issueRefreshToken(dave));
    assert.equal(consumeRefreshToken(issued[0]).ok, false, "the oldest token was dropped");
    assert.equal(consumeRefreshToken(issued[issued.length - 1]).ok, true, "the newest token still works");
  });
});

test("consumeRefreshToken - rotation invalidates the old token (single real use)", async () => {
  await withTempCwd(async () => {
    await createUser("bob", "correcthorsebattery", "operator");
    const bob = findUser("bob") as StoredUser;
    const token = issueRefreshToken(bob);

    const first = consumeRefreshToken(token);
    assert.equal(first.ok, true);

    const replay = consumeRefreshToken(token);
    assert.equal(replay.ok, false);
    if (!replay.ok) assert.equal(replay.reason, "invalid");
  });
});

test("consumeRefreshToken - unknown token is invalid", async () => {
  await withTempCwd(() => {
    const result = consumeRefreshToken("never-issued");
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.reason, "invalid");
  });
});

test("consumeRefreshToken - expired token is refused and removed", async () => {
  await withTempCwd(async (dir) => {
    await createUser("carol", "correcthorsebattery", "operator");
    const carol = findUser("carol") as StoredUser;
    const token = issueRefreshToken(carol);

    // Simulate real time passing past REFRESH_TOKEN_TTL_MS by rewriting the
    // record's own expiresAt directly - the real store format, just with a
    // timestamp already in the past, not a mocked clock.
    const raw = JSON.parse(fs.readFileSync(path.join(dir, "data", "refresh_tokens.json"), "utf-8"));
    raw[0].expiresAt = Date.now() - 1000;
    fs.writeFileSync(path.join(dir, "data", "refresh_tokens.json"), JSON.stringify(raw), "utf-8");

    const result = consumeRefreshToken(token);
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.reason, "expired");

    // Real cleanup, not just a rejected result - the dead record is gone.
    const after = JSON.parse(fs.readFileSync(path.join(dir, "data", "refresh_tokens.json"), "utf-8"));
    assert.equal(after.length, 0);
  });
});

test("consumeRefreshToken - a password change (tokenVersion bump) revokes an outstanding refresh token", async () => {
  await withTempCwd(async () => {
    const { updateUser } = await import("../src/users");
    await createUser("dave", "correcthorsebattery", "operator");
    const dave = findUser("dave") as StoredUser;
    const token = issueRefreshToken(dave);

    await updateUser("dave", { password: "differenthorsebattery" });

    const result = consumeRefreshToken(token);
    assert.equal(result.ok, false, "a refresh token minted before the password change must not survive it");
    if (!result.ok) assert.equal(result.reason, "revoked");
  });
});

test("consumeRefreshToken - a deleted account revokes its outstanding refresh token", async () => {
  await withTempCwd(async () => {
    const { deleteUser } = await import("../src/users");
    // A real deployment always keeps at least one admin - createUser()
    // itself is used for a second admin account here purely so deleteUser()
    // below is allowed to remove "eve" without hitting the "last remaining
    // admin" guard, which is orthogonal to what this test exercises.
    await createUser("admin2", "correcthorsebattery", "admin");
    await createUser("eve", "correcthorsebattery", "admin");
    const eve = findUser("eve") as StoredUser;
    const token = issueRefreshToken(eve);

    await deleteUser("eve");

    const result = consumeRefreshToken(token);
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.reason, "revoked");
  });
});

test("consumeRefreshToken - recreating the same username never inherits the old refresh token", async () => {
  await withTempCwd(async () => {
    const { deleteUser } = await import("../src/users");
    await createUser("admin2", "correcthorsebattery", "admin");
    await createUser("frank", "correcthorsebattery", "operator");
    const originalFrank = findUser("frank") as StoredUser;
    const token = issueRefreshToken(originalFrank);

    await deleteUser("frank");
    await createUser("frank", "adifferentpassword", "operator");

    const result = consumeRefreshToken(token);
    assert.equal(result.ok, false, "the OLD frank's refresh token must not authenticate the NEW frank account");
    if (!result.ok) assert.equal(result.reason, "revoked");
  });
});

test("revokeRefreshToken - real logout invalidates the token server-side", async () => {
  await withTempCwd(async () => {
    await createUser("grace", "correcthorsebattery", "operator");
    const grace = findUser("grace") as StoredUser;
    const token = issueRefreshToken(grace);

    revokeRefreshToken(token);

    const result = consumeRefreshToken(token);
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.reason, "invalid");
  });
});

test("revokeRefreshToken - revoking an unknown/already-used token is a harmless no-op", async () => {
  await withTempCwd(() => {
    assert.doesNotThrow(() => revokeRefreshToken("never-issued"));
  });
});

test("pruneExpiredRefreshTokens - removes only the real expired records", async () => {
  await withTempCwd(async (dir) => {
    await createUser("henry", "correcthorsebattery", "operator");
    const henry = findUser("henry") as StoredUser;
    const stillValidToken = issueRefreshToken(henry);
    issueRefreshToken(henry); // a second, real token to be expired below

    const raw = JSON.parse(fs.readFileSync(path.join(dir, "data", "refresh_tokens.json"), "utf-8"));
    raw[1].expiresAt = Date.now() - 1000;
    fs.writeFileSync(path.join(dir, "data", "refresh_tokens.json"), JSON.stringify(raw), "utf-8");

    const removed = pruneExpiredRefreshTokens();
    assert.equal(removed, 1);

    const remaining = JSON.parse(fs.readFileSync(path.join(dir, "data", "refresh_tokens.json"), "utf-8"));
    assert.equal(remaining.length, 1);
    assert.equal(remaining[0].tokenHash, hashRefreshToken(stillValidToken));
    assert.equal(remaining[0].token, undefined, "the token itself is not kept");
  });
});

test("pruneExpiredRefreshTokens - a fresh install with no file yet is a harmless no-op", async () => {
  await withTempCwd(() => {
    assert.equal(pruneExpiredRefreshTokens(), 0);
  });
});

test("a corrupted refresh_tokens.json fails loudly instead of being treated as empty", async () => {
  await withTempCwd(async (dir) => {
    writeRawRefreshTokensJson(dir, "{not valid json");
    assert.throws(() => consumeRefreshToken("anything"), RefreshTokensFileError);
  });
});

test("a refresh_tokens.json holding something other than a JSON array fails loudly", async () => {
  await withTempCwd(async (dir) => {
    writeRawRefreshTokensJson(dir, JSON.stringify({ not: "an array" }));
    assert.throws(() => consumeRefreshToken("anything"), RefreshTokensFileError);
  });
});

test("the client that opened a session travels with it through a rotation and a logout, and open sessions are counted per client", async () => {
  await withTempCwd(async () => {
    await createUser("carol", "correcthorsebattery", "operator");
    const carol = findUser("carol") as StoredUser;
    const a = issueRefreshToken(carol, "aaaaaaaaaaaaaaaa");
    issueRefreshToken(carol, "aaaaaaaaaaaaaaaa");
    issueRefreshToken(carol, "bbbbbbbbbbbbbbbb");
    issueRefreshToken(carol);
    assert.deepEqual([...openSessionsByClient()].sort(), [["aaaaaaaaaaaaaaaa", 2], ["bbbbbbbbbbbbbbbb", 1]]);

    const rotated = consumeRefreshToken(a);
    assert.ok(rotated.ok);
    assert.equal(rotated.ok && rotated.clientId, "aaaaaaaaaaaaaaaa");
    assert.equal(openSessionsByClient().get("aaaaaaaaaaaaaaaa"), 2, "a rotation keeps the client of the session");

    const gone = revokeRefreshToken(rotated.ok ? rotated.refreshToken : "");
    assert.deepEqual(gone, { clientId: "aaaaaaaaaaaaaaaa" });
    assert.equal(openSessionsByClient().get("aaaaaaaaaaaaaaaa"), 1);
    assert.equal(revokeRefreshToken("0".repeat(64)), undefined, "an unknown token revokes nothing");
  });
});

test("the file keeps the SHA-256 of a token, never the token, and is written for its owner only", async () => {
  await withTempCwd(async (dir) => {
    await createUser("ivan", "correcthorsebattery", "operator");
    const ivan = findUser("ivan") as StoredUser;
    const token = issueRefreshToken(ivan);
    const file = path.join(dir, "data", "refresh_tokens.json");
    const text = fs.readFileSync(file, "utf-8");
    assert.equal(text.includes(token), false, "the token is nowhere in the file");
    const raw = JSON.parse(text);
    assert.equal(raw[0].tokenHash, hashRefreshToken(token));
    assert.match(raw[0].tokenHash, /^[0-9a-f]{64}$/);
    assert.equal(raw[0].token, undefined);
    if (process.platform !== "win32") assert.equal(fs.statSync(file).mode & 0o077, 0, "no access for the group or the others");
    // a renewal works with the token and the new one is a hash again
    const renewed = consumeRefreshToken(token);
    assert.equal(renewed.ok, true);
    const after = fs.readFileSync(file, "utf-8");
    assert.equal(after.includes(token), false);
    assert.equal(consumeRefreshToken(token).ok, false, "the old one was spent");
    if (renewed.ok) assert.equal(after.includes(renewed.refreshToken), false);
  });
});

test("a file written before the hash was kept still renews, and is rewritten with hashes", async () => {
  await withTempCwd(async (dir) => {
    await createUser("judy", "correcthorsebattery", "operator");
    const judy = findUser("judy") as StoredUser;
    const issued = issueRefreshToken(judy);
    const issuedLater = issueRefreshToken(judy);
    const file = path.join(dir, "data", "refresh_tokens.json");
    // the old format: the token itself in the field `token`
    const records = JSON.parse(fs.readFileSync(file, "utf-8"));
    const plain = [issued, issuedLater];
    fs.writeFileSync(file, JSON.stringify(records.map((r: any, i: number) => { const { tokenHash: _gone, ...rest } = r; return { ...rest, token: plain[i] }; })), "utf-8");

    // the sweep at start-up rewrites the file even when nothing expired
    assert.equal(pruneExpiredRefreshTokens(), 0);
    const migrated = fs.readFileSync(file, "utf-8");
    for (const token of plain) assert.equal(migrated.includes(token), false, "no token is left in the clear");
    assert.deepEqual(JSON.parse(migrated).map((r: any) => r.tokenHash), plain.map(hashRefreshToken));

    // and both tokens that were issued before still renew
    assert.equal(consumeRefreshToken(issued).ok, true);
    assert.equal(consumeRefreshToken(issuedLater).ok, true);
  });
});

test("a record of the old format that is renewed before any sweep is written back as a hash", async () => {
  await withTempCwd(async (dir) => {
    await createUser("kim", "correcthorsebattery", "operator");
    const kim = findUser("kim") as StoredUser;
    const token = issueRefreshToken(kim);
    const file = path.join(dir, "data", "refresh_tokens.json");
    const [record] = JSON.parse(fs.readFileSync(file, "utf-8"));
    const { tokenHash: _gone, ...rest } = record;
    fs.writeFileSync(file, JSON.stringify([{ ...rest, token }]), "utf-8");
    assert.equal(consumeRefreshToken(token).ok, true);
    assert.equal(fs.readFileSync(file, "utf-8").includes(token), false);
  });
});

test("peekRefreshToken answers without using the token", async () => {
  await withTempCwd(async (dir) => {
    await createUser("leo", "correcthorsebattery", "operator");
    const leo = findUser("leo") as StoredUser;
    const token = issueRefreshToken(leo);
    const file = path.join(dir, "data", "refresh_tokens.json");
    const before = fs.readFileSync(file, "utf-8");
    for (let i = 0; i < 3; i += 1) {
      const peeked = peekRefreshToken(token);
      assert.equal(peeked.ok, true);
      if (peeked.ok) assert.equal(peeked.user.username, "leo");
    }
    assert.equal(fs.readFileSync(file, "utf-8"), before, "nothing was rotated or written");
    assert.equal(peekRefreshToken("0".repeat(64)).ok, false);
    assert.equal(peekRefreshToken("").ok, false);
    // an expired token, and one of an account that changed since, are not accepted either
    const raw = JSON.parse(before);
    raw[0].expiresAt = Date.now() - 1000;
    fs.writeFileSync(file, JSON.stringify(raw), "utf-8");
    assert.equal(peekRefreshToken(token).ok, false);
    // a damaged file is a refusal, not a crash
    fs.writeFileSync(file, "{ not json", "utf-8");
    assert.equal(peekRefreshToken(token).ok, false);
  });
});
