// =============================================================================
// HYDRA-UMC-SERVER - src/safetyLimits.ts
// Copyright (C) 2026 JuanenRac (Electro Hobby 3D) <electrohobby3d@gmail.com>
// GPL-3.0-or-later - see LICENSE
// =============================================================================
// The limits every client is held to, kept in the server so they cannot differ from one client to
// another: the size of a jog, the range of an absolute jog, the highest heated-bed target, whether
// a jog has to be armed first, and whether a claim has to name its controller. An administrator
// edits them (PUT /api/admin/safety-limits); they are saved through the transactional store
// (data/safety-limits.json, committed with the journal). Defaults are the prudent ones, the
// arming is off by default, and no value can be set beyond the hard ceilings below.
import fs from "node:fs";
import path from "node:path";
import { commitFiles } from "./transactionalFiles";

export interface JogLimits {
  /** Largest relative jog of one command (millimetres or degrees, the unit of the axis). */
  maxAmount: number;
  /** Largest absolute position an absolute jog may ask for, in either direction. */
  maxAbsolute: number;
}
export interface TemperatureLimits {
  /** Highest heated-bed target in degrees Celsius. */
  bedMaxC: number;
}
export interface SafetyConfig {
  jog: { armRequired: boolean; armTtlMs: number; default: JogLimits; models: Record<string, Partial<JogLimits>> };
  temperature: { default: TemperatureLimits; models: Record<string, Partial<TemperatureLimits>> };
  claims: { requireControllerId: boolean };
  /** The audit record of the changes that matter (GET /api/audit). On by default; the environment may lock it off. */
  audit: { enabled: boolean };
}

export const HARD_LIMITS = {
  jogMaxAmount: 1000,
  jogMaxAbsolute: 10000,
  armTtlMs: { min: 1000, max: 600_000 },
  bedMaxC: 300,
} as const;

export function defaultSafetyConfig(): SafetyConfig {
  return {
    jog: { armRequired: false, armTtlMs: 60_000, default: { maxAmount: 100, maxAbsolute: 1000 }, models: {} },
    temperature: { default: { bedMaxC: 110 }, models: {} },
    claims: { requireControllerId: false },
    audit: { enabled: true },
  };
}

export class SafetyLimitsError extends Error {}

/** "Parol6 (6-DOF)" and "parol6" name the same model. */
export function modelKey(model: unknown): string {
  return String(model ?? "").split("(")[0].trim().toLowerCase();
}

function positive(value: unknown, name: string, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0 || value > max) {
    throw new SafetyLimitsError(`${name} must be a number above 0 and at most ${max}`);
  }
  return value;
}

function section(name: string, value: unknown, allowed: string[]): any {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new SafetyLimitsError(`${name} must be an object`);
  for (const key of Object.keys(value)) if (!allowed.includes(key)) throw new SafetyLimitsError(`unknown setting "${name}.${key}"`);
  return value;
}

function modelTable<T>(raw: unknown, name: string, check: (entry: any, label: string) => Partial<T>): Record<string, Partial<T>> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new SafetyLimitsError(`${name} must be an object keyed by model`);
  const out: Record<string, Partial<T>> = {};
  for (const [key, entry] of Object.entries(raw)) {
    const k = modelKey(key);
    if (!k || k.length > 64) throw new SafetyLimitsError(`${name} has an invalid model name`);
    out[k] = check(entry, `${name}.${key}`);
  }
  return out;
}

const jogEntry = (entry: unknown, label: string): Partial<JogLimits> => {
  const e = section(label, entry, ["maxAmount", "maxAbsolute"]);
  const out: Partial<JogLimits> = {};
  if (e.maxAmount !== undefined) out.maxAmount = positive(e.maxAmount, `${label}.maxAmount`, HARD_LIMITS.jogMaxAmount);
  if (e.maxAbsolute !== undefined) out.maxAbsolute = positive(e.maxAbsolute, `${label}.maxAbsolute`, HARD_LIMITS.jogMaxAbsolute);
  return out;
};
const tempEntry = (entry: unknown, label: string): Partial<TemperatureLimits> => {
  const e = section(label, entry, ["bedMaxC"]);
  const out: Partial<TemperatureLimits> = {};
  if (e.bedMaxC !== undefined) out.bedMaxC = positive(e.bedMaxC, `${label}.bedMaxC`, HARD_LIMITS.bedMaxC);
  return out;
};

/** Merges a partial change into `current`; throws SafetyLimitsError for anything invalid. A `models` table in the patch replaces the whole table. */
export function mergeSafetyConfig(current: SafetyConfig, patch: any): SafetyConfig {
  const body = section("body", patch, ["jog", "temperature", "claims", "audit"]);
  const next: SafetyConfig = JSON.parse(JSON.stringify(current));
  if (body.jog !== undefined) {
    const jog = section("jog", body.jog, ["armRequired", "armTtlMs", "default", "models"]);
    if (jog.armRequired !== undefined) {
      if (typeof jog.armRequired !== "boolean") throw new SafetyLimitsError("jog.armRequired must be true or false");
      next.jog.armRequired = jog.armRequired;
    }
    if (jog.armTtlMs !== undefined) {
      if (typeof jog.armTtlMs !== "number" || !Number.isFinite(jog.armTtlMs) || jog.armTtlMs < HARD_LIMITS.armTtlMs.min || jog.armTtlMs > HARD_LIMITS.armTtlMs.max) {
        throw new SafetyLimitsError(`jog.armTtlMs must be between ${HARD_LIMITS.armTtlMs.min} and ${HARD_LIMITS.armTtlMs.max}`);
      }
      next.jog.armTtlMs = jog.armTtlMs;
    }
    if (jog.default !== undefined) next.jog.default = { ...next.jog.default, ...jogEntry(jog.default, "jog.default") };
    if (jog.models !== undefined) next.jog.models = modelTable<JogLimits>(jog.models, "jog.models", jogEntry);
  }
  if (body.temperature !== undefined) {
    const t = section("temperature", body.temperature, ["default", "models"]);
    if (t.default !== undefined) next.temperature.default = { ...next.temperature.default, ...tempEntry(t.default, "temperature.default") };
    if (t.models !== undefined) next.temperature.models = modelTable<TemperatureLimits>(t.models, "temperature.models", tempEntry);
  }
  if (body.claims !== undefined) {
    const c = section("claims", body.claims, ["requireControllerId"]);
    if (c.requireControllerId !== undefined) {
      if (typeof c.requireControllerId !== "boolean") throw new SafetyLimitsError("claims.requireControllerId must be true or false");
      next.claims.requireControllerId = c.requireControllerId;
    }
  }
  if (body.audit !== undefined) {
    const a = section("audit", body.audit, ["enabled"]);
    if (a.enabled !== undefined) {
      if (typeof a.enabled !== "boolean") throw new SafetyLimitsError("audit.enabled must be true or false");
      next.audit = { enabled: a.enabled };
    }
  }
  return next;
}

/** Reads the saved file; a missing or damaged one gives the defaults. */
export function loadSafetyConfig(file: string, log: (m: string) => void = () => undefined): SafetyConfig {
  const defaults = defaultSafetyConfig();
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(file, "utf-8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") log(`[SAFETY] ${file} could not be read (${(error as Error).message}); the default limits are used.`);
    return defaults;
  }
  try {
    return mergeSafetyConfig(defaults, raw);
  } catch (error) {
    log(`[SAFETY] ${file} holds an invalid value (${(error as Error).message}); the default limits are used.`);
    return defaults;
  }
}

export class SafetyLimits {
  private config: SafetyConfig;
  private file: string;

  constructor(private dataPath: string, private log: (message: string) => void = () => undefined) {
    this.file = path.join(dataPath, "safety-limits.json");
    this.config = loadSafetyConfig(this.file, log);
  }

  get(): SafetyConfig {
    return this.config;
  }

  jogFor(model: unknown): JogLimits {
    return { ...this.config.jog.default, ...(this.config.jog.models[modelKey(model)] ?? {}) };
  }

  temperatureFor(model: unknown): TemperatureLimits {
    return { ...this.config.temperature.default, ...(this.config.temperature.models[modelKey(model)] ?? {}) };
  }

  /** Applies a change and saves it through the journal; the previous limits stay if the save fails. */
  async update(patch: any, actor: string): Promise<SafetyConfig> {
    const next = mergeSafetyConfig(this.config, patch);
    await commitFiles(path.join(this.dataPath, ".txn"), [{ path: this.file, content: JSON.stringify(next, null, 2) }]);
    this.config = next;
    this.log(`[SAFETY] ${actor} changed the safety limits: ${JSON.stringify(patch)}`);
    return next;
  }

  /**
   * Lowers every heated-bed target of a settings tree that is above its limit to the limit (in
   * place) and says what it changed, so no client can store a target the server would not accept.
   */
  clampTemperatures(settings: any): { robotId: unknown; requested: number; applied: number }[] {
    const changes: { robotId: unknown; requested: number; applied: number }[] = [];
    for (const controller of Array.isArray(settings?.controllers) ? settings.controllers : []) {
      for (const robot of Array.isArray(controller?.robots) ? controller.robots : []) {
        const bed = robot?.heatedBed;
        if (!bed || typeof bed.targetTemp !== "number") continue;
        const max = this.temperatureFor(robot.model).bedMaxC;
        if (!Number.isFinite(bed.targetTemp) || bed.targetTemp > max) {
          const applied = Number.isFinite(bed.targetTemp) ? max : 0;
          changes.push({ robotId: robot.id, requested: bed.targetTemp, applied });
          bed.targetTemp = applied;
        }
      }
    }
    if (changes.length) this.log(`[SAFETY] ${changes.length} heated-bed target(s) lowered to the limit of their model.`);
    return changes;
  }
}

/** The explicit arming of the jog: in memory only (a restart disarms everything), bound to the account and the controller that armed it. */
export class JogArming {
  private armed = new Map<number, { userId: unknown; controllerId?: string; expiresAt: number }>();

  arm(robotId: number, userId: unknown, controllerId: string | undefined, ttlMs: number): number {
    const expiresAt = Date.now() + ttlMs;
    this.armed.set(robotId, { userId, controllerId, expiresAt });
    return expiresAt;
  }

  disarm(robotId: number): void {
    this.armed.delete(robotId);
  }

  isArmed(robotId: number, userId: unknown, controllerId: string | undefined): boolean {
    const entry = this.armed.get(robotId);
    if (!entry) return false;
    if (entry.expiresAt <= Date.now()) {
      this.armed.delete(robotId);
      return false;
    }
    return entry.userId === userId && entry.controllerId === controllerId;
  }

  expiresAt(robotId: number): number | null {
    const entry = this.armed.get(robotId);
    return entry && entry.expiresAt > Date.now() ? entry.expiresAt : null;
  }
}
