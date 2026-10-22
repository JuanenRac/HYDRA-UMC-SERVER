import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { createSettingsStore, settingsStoreOptionsFromEnv } from "../src/settingsStore.ts";
import { commitFiles, recoverTransactions } from "../src/transactionalFiles.ts";
import { backupSettings } from "../src/settingsBackups.ts";

const tempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), "hydra-store-"));
const payload = (name: string, points: number[]) => ({
  serverName: name,
  controllers: [{ id: "c1", robots: [{ id: 1, name: "A", recordedPoints: points }, { id: 2, name: "B", recordedPoints: [9] }] }],
});
const read = (file: string) => JSON.parse(fs.readFileSync(file, "utf-8"));

test("a write lands as one unit and reads back whole", async () => {
  const dir = tempDir();
  try {
    const store = createSettingsStore(dir);
    await store.queueSettingsWrite(payload("one", [1, 2, 3]));
    const loaded = store.loadFullSettingsFromDisk();
    assert.equal(loaded.serverName, "one");
    assert.deepEqual(loaded.controllers[0].robots[0].recordedPoints, [1, 2, 3]);
    assert.deepEqual(read(store.getPointsPath("c1", 2)), [9]);
    assert.deepEqual(fs.readdirSync(path.join(dir, ".txn")), []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("an existing installation is migrated without losing anything, once", () => {
  const dir = tempDir();
  try {
    fs.mkdirSync(path.join(dir, "points", "c1"), { recursive: true });
    fs.writeFileSync(path.join(dir, "settings.json"), JSON.stringify({ serverName: "old", controllers: [{ id: "c1", robots: [{ id: 1, name: "A" }] }] }));
    fs.writeFileSync(path.join(dir, "points", "c1", "1.json"), "[7,8]");
    const store = createSettingsStore(dir);
    assert.equal(store.loadFullSettingsFromDisk().controllers[0].robots[0].recordedPoints.length, 2);
    const meta = read(path.join(dir, "store-meta.json"));
    const copy = path.join(dir, "backups", meta.copy);
    assert.equal(read(path.join(copy, "settings.json")).serverName, "old");
    assert.equal(fs.readFileSync(path.join(copy, "points", "c1", "1.json"), "utf-8"), "[7,8]");
    assert.equal(read(path.join(dir, "settings.json")).serverName, "old");
    createSettingsStore(dir);
    assert.equal(fs.readdirSync(path.join(dir, "backups")).filter((n) => n.startsWith("pre-store-")).length, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a cut before the commit point leaves the old files and the recovery discards the leftovers", async () => {
  const dir = tempDir();
  try {
    const store = createSettingsStore(dir);
    await store.queueSettingsWrite(payload("before", [1]));
    // the process dies after staging: files staged, no manifest
    const staged = path.join(dir, ".txn", "dead-1");
    fs.mkdirSync(staged, { recursive: true });
    fs.writeFileSync(path.join(staged, "0.new"), JSON.stringify({ serverName: "never" }));
    const report = recoverTransactions(path.join(dir, ".txn"));
    assert.deepEqual([report.rolledForward, report.rolledBack], [0, 1]);
    assert.equal(createSettingsStore(dir).loadFullSettingsFromDisk().serverName, "before");
    // an error between staging and the commit point cleans up after itself
    const failing = createSettingsStore(dir, { txnHooks: { afterStage: () => { throw new Error("disk full"); } } });
    await assert.rejects(failing.queueSettingsWrite(payload("lost", [5])), /disk full/);
    assert.equal(createSettingsStore(dir).loadFullSettingsFromDisk().serverName, "before");
    assert.deepEqual(fs.readdirSync(path.join(dir, ".txn")), []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a cut after the commit point is finished on the next start, whichever file it stopped at", async () => {
  const cuts = [
    { afterCommit: () => { throw new Error("killed"); } },
    { afterApply: (index: number) => { if (index === 0) throw new Error("killed"); } },
  ];
  for (const hooks of cuts) {
    const dir = tempDir();
    try {
      await createSettingsStore(dir).queueSettingsWrite(payload("old", [1]));
      const cut = createSettingsStore(dir, { txnHooks: hooks });
      await assert.rejects(cut.queueSettingsWrite(payload("new", [4, 5])), /killed/);
      // the next start
      const next = createSettingsStore(dir);
      const loaded = next.loadFullSettingsFromDisk();
      assert.equal(loaded.serverName, "new");
      assert.deepEqual(loaded.controllers[0].robots[0].recordedPoints, [4, 5]);
      assert.deepEqual(fs.readdirSync(path.join(dir, ".txn")), []);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

test("a staged file that does not match its hash is not applied", async () => {
  const dir = tempDir();
  try {
    const target = path.join(dir, "x.json");
    fs.writeFileSync(target, "old");
    await assert.rejects(commitFiles(path.join(dir, ".txn"), [{ path: target, content: "new" }], { afterCommit: () => { throw new Error("killed"); } }));
    const txn = fs.readdirSync(path.join(dir, ".txn"))[0];
    fs.writeFileSync(path.join(dir, ".txn", txn, "0.new"), "tampered");
    const report = recoverTransactions(path.join(dir, ".txn"));
    assert.equal(report.problems.length, 1);
    assert.equal(fs.readFileSync(target, "utf-8"), "old");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a damaged settings.json is restored from the newest good copy and kept for inspection", async () => {
  const dir = tempDir();
  try {
    const store = createSettingsStore(dir, { backups: 5, backupIntervalMs: 0 });
    await store.queueSettingsWrite(payload("good", [1]));
    await store.queueSettingsWrite(payload("newer", [2])); // copies the previous file before writing
    fs.writeFileSync(store.getSettingsPath(), "{ cut in the middle");
    const restored = createSettingsStore(dir, { backups: 5, backupIntervalMs: 0 }).loadFullSettingsFromDisk();
    assert.equal(restored.serverName, "good");
    assert.ok(fs.readdirSync(dir).some((name) => name.startsWith("settings.json.corrupt-")));
    assert.equal(read(path.join(dir, "settings.json")).serverName, "good");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("copies are throttled and pruned; zero turns them off", () => {
  const dir = tempDir();
  try {
    const settings = path.join(dir, "settings.json");
    fs.writeFileSync(settings, "{}");
    const t0 = Date.UTC(2026, 0, 1, 0, 0, 0);
    assert.ok(backupSettings(dir, settings, 2, 60_000, t0));
    assert.equal(backupSettings(dir, settings, 2, 3_600_000, Date.now()), null); // the newest copy is younger than the interval
    for (let i = 1; i <= 3; i++) assert.ok(backupSettings(dir, settings, 2, 0, t0 + i * 1000));
    assert.equal(fs.readdirSync(path.join(dir, "backups")).length, 2);
    assert.equal(backupSettings(dir, settings, 0, 0, t0 + 99_000), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("the plain mode writes file by file as before and the options come from the environment", async () => {
  const dir = tempDir();
  try {
    const store = createSettingsStore(dir, { mode: "plain" });
    await store.queueSettingsWrite(payload("plain", [1]));
    assert.equal(store.loadFullSettingsFromDisk().serverName, "plain");
    assert.equal(fs.existsSync(path.join(dir, ".txn")), false);
    assert.equal(fs.existsSync(path.join(dir, "store-meta.json")), false);
    assert.deepEqual(settingsStoreOptionsFromEnv({}), { mode: "journal", backups: 10, backupIntervalMs: 600_000 });
    assert.deepEqual(settingsStoreOptionsFromEnv({ HYDRA_UMC_SETTINGS_STORE: "PLAIN", HYDRA_UMC_SETTINGS_BACKUPS: "0", HYDRA_UMC_SETTINGS_BACKUP_INTERVAL_S: "5" }), { mode: "plain", backups: 0, backupIntervalMs: 5000 });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
