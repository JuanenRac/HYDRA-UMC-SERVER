// =============================================================================
// HYDRA-UMC-SERVER - src/serverConfigFile.ts
// Copyright (C) 2026 JuanenRac (Electro Hobby 3D) <electrohobby3d@gmail.com>
// GPL-3.0-or-later - see LICENSE
// =============================================================================
// Reading data/server-config.json. The server reads it many times while it runs, so a read must never turn an unreadable file into "no options":
//   - not there: a fresh install, an empty set of options;
//   - there but unreadable or not an object, at start-up: the server refuses to start (src/configFileGuard.ts);
//   - there but unreadable while running (edited by hand, a cut write): the last text that was good keeps being used, a copy of the damaged
//     file is kept once, and the loss is logged. The options an administrator saved are not dropped and the next save does not make that permanent.
import fs from "node:fs";
import { keepDamagedCopy, refuseDamagedConfig } from "./configFileGuard";

export class ServerConfigReader {
  /** The last text that parsed as an object. */
  private lastGood: string | undefined;
  private copied = false;

  constructor(private readonly file: string, private readonly log: (message: string) => void = () => undefined) {}

  private parse(text: string): Record<string, unknown> | string {
    try {
      const value = JSON.parse(text);
      if (typeof value !== "object" || value === null || Array.isArray(value)) return "it does not hold a JSON object";
      return value as Record<string, unknown>;
    } catch (error) {
      return `not valid JSON: ${(error as Error).message}`;
    }
  }

  /** Reads the file at start-up: {} when it is not there, the options when it is good, and a refusal (a throw) when it is there and cannot be understood. */
  readAtStart(env: Record<string, string | undefined> = process.env): Record<string, unknown> {
    let text: string;
    try {
      text = fs.readFileSync(this.file, "utf-8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
      refuseDamagedConfig(this.file, `it could not be read: ${(error as Error).message}`, this.log, env);
      return {};
    }
    const parsed = this.parse(text);
    if (typeof parsed === "string") {
      refuseDamagedConfig(this.file, parsed, this.log, env);
      return {};
    }
    this.lastGood = text;
    return parsed;
  }

  /** Reads the file while running: never throws, never gives {} for a file that is there. */
  read(): Record<string, unknown> {
    let text: string;
    try {
      text = fs.readFileSync(this.file, "utf-8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
      return this.fallback(`it could not be read: ${(error as Error).message}`);
    }
    const parsed = this.parse(text);
    if (typeof parsed === "string") return this.fallback(parsed);
    this.lastGood = text;
    this.copied = false;
    return parsed;
  }

  private fallback(reason: string): Record<string, unknown> {
    if (!this.copied) {
      this.copied = true;
      const copy = keepDamagedCopy(this.file);
      this.log(`[CONFIG] ${this.file} cannot be understood while the server runs (${reason}); ${copy ? `a copy was kept at ${copy}` : "no copy could be made"}; ${this.lastGood === undefined ? "the defaults are used" : "the last good options keep being used"}.`);
    }
    if (this.lastGood === undefined) return {};
    return JSON.parse(this.lastGood) as Record<string, unknown>;
  }
}
