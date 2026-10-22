// =============================================================================
// HYDRA-UMC-SERVER - src/transactionalFiles.ts
// Copyright (C) 2026 JuanenRac (Electro Hobby 3D) <electrohobby3d@gmail.com>
// GPL-3.0-or-later - see LICENSE
// =============================================================================
// An all-or-nothing write of several files (settings.json plus one points file per robot), with a
// journal, so a cut in the middle (power loss, kill, full disk) can never leave the files from
// two different moments next to each other.
//
// Protocol, in a directory <root>/<id>/ next to the data:
//   1. every new content is written and flushed to <i>.new;
//   2. manifest.json (the target of each file and the SHA-256 of its content) is written last,
//      flushed and renamed into place: this rename is the commit point;
//   3. each <i>.new is renamed over its target and the directory is removed.
// On start, recoverTransactions() finishes (rolls forward) every transaction that has a manifest
// and discards (rolls back) every one that has not.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export interface TxnFile {
  path: string;
  content: string;
}

/** Test hooks: each one runs at a point of the protocol and may throw to simulate a cut. */
export interface TxnHooks {
  afterStage?: () => void;
  afterCommit?: () => void;
  afterApply?: (index: number) => void;
}

const sha256 = (text: string | Buffer) => crypto.createHash("sha256").update(text).digest("hex");

async function writeDurable(file: string, content: string): Promise<void> {
  const handle = await fs.promises.open(file, "w");
  try {
    await handle.writeFile(content, "utf-8");
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function renameWithRetry(from: string, to: string): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      await fs.promises.mkdir(path.dirname(to), { recursive: true });
      await fs.promises.rename(from, to);
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 50 * (attempt + 1)));
    }
  }
  throw lastError;
}

export async function commitFiles(root: string, files: TxnFile[], hooks: TxnHooks = {}): Promise<void> {
  if (files.length === 0) return;
  const id = `${Date.now()}-${process.pid}-${crypto.randomBytes(3).toString("hex")}`;
  const dir = path.join(root, id);
  await fs.promises.mkdir(dir, { recursive: true });
  try {
    for (let index = 0; index < files.length; index++) {
      await writeDurable(path.join(dir, `${index}.new`), files[index].content);
    }
    hooks.afterStage?.();
    const manifest = JSON.stringify({
      version: 1,
      files: files.map((file) => ({ target: file.path, sha256: sha256(file.content) })),
    });
    await writeDurable(path.join(dir, "manifest.tmp"), manifest);
    await fs.promises.rename(path.join(dir, "manifest.tmp"), path.join(dir, "manifest.json"));
  } catch (error) {
    // Nothing was committed: discard the staging directory (a cut here is handled by the recovery).
    await fs.promises.rm(dir, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
  hooks.afterCommit?.();
  for (let index = 0; index < files.length; index++) {
    await renameWithRetry(path.join(dir, `${index}.new`), files[index].path);
    hooks.afterApply?.(index);
  }
  await fs.promises.rm(dir, { recursive: true, force: true }).catch(() => undefined);
}

export interface RecoveryReport {
  rolledForward: number;
  rolledBack: number;
  problems: string[];
}

/** Finishes the committed transactions and discards the ones that never committed. Synchronous: it runs once, at start. */
export function recoverTransactions(root: string): RecoveryReport {
  const report: RecoveryReport = { rolledForward: 0, rolledBack: 0, problems: [] };
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return report;
  }
  for (const entry of entries.filter((item) => item.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
    const dir = path.join(root, entry.name);
    const manifestPath = path.join(dir, "manifest.json");
    let manifest: { files: { target: string; sha256: string }[] } | null = null;
    try {
      manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));
    } catch {
      manifest = null;
    }
    if (!manifest || !Array.isArray(manifest.files)) {
      fs.rmSync(dir, { recursive: true, force: true });
      report.rolledBack++;
      continue;
    }
    let complete = true;
    manifest.files.forEach((file, index) => {
      const staged = path.join(dir, `${index}.new`);
      if (!fs.existsSync(staged)) return; // already applied before the cut
      try {
        const content = fs.readFileSync(staged);
        if (sha256(content) !== file.sha256) throw new Error("the staged content does not match its hash");
        fs.mkdirSync(path.dirname(file.target), { recursive: true });
        fs.renameSync(staged, file.target);
      } catch (error) {
        complete = false;
        report.problems.push(`${file.target}: ${(error as Error).message}`);
      }
    });
    if (complete) {
      fs.rmSync(dir, { recursive: true, force: true });
      report.rolledForward++;
    }
  }
  return report;
}
