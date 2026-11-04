// =============================================================================
// HYDRA-UMC-SERVER - src/bridgeSettings.ts
// Copyright (C) 2026 JuanenRac (Electro Hobby 3D) <electrohobby3d@gmail.com>
// GPL-3.0-or-later - see LICENSE
// =============================================================================
// The switches of the machine bridges that an administrator sets from Server Admin. The server keeps them in its configuration
// (data/server-config.json, key "bridges") and, while the bridge gateway is on, announces them to each bridge on one retained topic,
// `<prefix>/<bridge>/settings` ({"schema":1,"settings":{...}}). A bridge applies them only when its own host allows remote settings (a local
// switch, off by default) and never lets a remote value turn on something its own configuration keeps off.
//
// Every function that moves hardware is off by default. The numbers and words here are the ones the bridges already read from their
// environment or configuration file; this module only gives them one place to be set and one way to arrive.

/** One switch: what it is, which bridge reads it, the value that is safe, and whether turning it on is a risk the administrator must confirm. */
export interface BridgeSwitch {
  bridge: BridgeName;
  key: string;
  kind: "boolean" | "choice";
  /** Allowed words for a "choice". */
  choices?: readonly string[];
  /** The conservative value (what applies while nothing is saved). */
  def: boolean | string;
  /** The values that let the bridge act on hardware or take a protection away: saving one asks for a confirmation and answers a warning. */
  risky: readonly BridgeSettingValue[];
  /** Where the bridge reads it without the server (the origin shown next to the switch). */
  localName: string;
}

export const BRIDGE_NAMES = ["droids", "uav", "amr", "openpnp"] as const;
export type BridgeName = (typeof BRIDGE_NAMES)[number];

export const BRIDGE_SWITCHES: readonly BridgeSwitch[] = [
  { bridge: "droids", key: "globalStop", kind: "boolean", def: false, risky: [], localName: "HYDRA_UMC_DROIDS_GLOBAL_STOP" },
  { bridge: "droids", key: "cutOnGlobalStop", kind: "boolean", def: true, risky: [false], localName: "config/spot_session.json: cut_on_global_stop" },
  { bridge: "uav", key: "missionUploadEnabled", kind: "boolean", def: false, risky: [true], localName: "config/uav.json: mission.upload_enabled" },
  { bridge: "amr", key: "publishState", kind: "boolean", def: false, risky: [], localName: "HYDRA_UMC_AMR_PUBLISH_STATE" },
  { bridge: "amr", key: "publishOpcua", kind: "boolean", def: false, risky: [], localName: "HYDRA_UMC_AMR_PUBLISH_OPCUA" },
  { bridge: "amr", key: "zoneInterlock", kind: "boolean", def: false, risky: [], localName: "HYDRA_UMC_AMR_ZONE_INTERLOCK" },
  { bridge: "amr", key: "zoneUnknown", kind: "choice", choices: ["pause", "ignore"], def: "pause", risky: ["ignore"], localName: "HYDRA_UMC_AMR_ZONE_UNKNOWN" },
  { bridge: "openpnp", key: "boardCode", kind: "choice", choices: ["off", "advisory", "required"], def: "off", risky: [], localName: "HYDRA_UMC_OPENPNP_BOARD_CODE" },
];

export type BridgeSettingValue = boolean | string;
export type BridgesFile = Partial<Record<BridgeName, Record<string, BridgeSettingValue>>>;

export type BridgeSource = "config" | "default";
export interface BridgeSettingView {
  value: BridgeSettingValue;
  source: BridgeSource;
  default: BridgeSettingValue;
  /** The values that ask for a confirmation before they are saved (empty when none does). */
  risky: readonly BridgeSettingValue[];
  choices?: readonly string[];
  localName: string;
}
export type BridgesSnapshot = Record<BridgeName, Record<string, BridgeSettingView>>;

export const isBridgeName = (value: unknown): value is BridgeName => typeof value === "string" && (BRIDGE_NAMES as readonly string[]).includes(value);

const switchOf = (bridge: BridgeName, key: string): BridgeSwitch | undefined => BRIDGE_SWITCHES.find((s) => s.bridge === bridge && s.key === key);

/** A saved value counts only when it is one this switch accepts; anything else is the default. */
function validValue(sw: BridgeSwitch, value: unknown): value is BridgeSettingValue {
  return sw.kind === "boolean" ? typeof value === "boolean" : typeof value === "string" && (sw.choices ?? []).includes(value);
}

export function resolveBridgeSettings(file: BridgesFile | undefined): BridgesSnapshot {
  const out = {} as BridgesSnapshot;
  for (const name of BRIDGE_NAMES) out[name] = {};
  for (const sw of BRIDGE_SWITCHES) {
    const saved = file?.[sw.bridge]?.[sw.key];
    const has = validValue(sw, saved);
    out[sw.bridge][sw.key] = {
      value: has ? (saved as BridgeSettingValue) : sw.def,
      source: has ? "config" : "default",
      default: sw.def,
      risky: sw.risky,
      ...(sw.choices ? { choices: sw.choices } : {}),
      localName: sw.localName,
    };
  }
  return out;
}

/** Does this value turn on a risky function (or take a protection away)? */
export function isRiskyValue(sw: BridgeSwitch, value: BridgeSettingValue): boolean {
  return sw.risky.includes(value);
}

export interface BridgesPatchResult {
  next: BridgesFile;
  warnings: string[];
}

/** Validates and merges a PUT body piece ({ droids: { cutOnGlobalStop: false }, ... }). Throws a message for the 400 answer. */
export function applyBridgesPatch(current: BridgesFile | undefined, patch: unknown): BridgesPatchResult {
  if (typeof patch !== "object" || patch === null || Array.isArray(patch)) throw new Error("bridges must be an object");
  const next: BridgesFile = {};
  for (const name of BRIDGE_NAMES) if (current?.[name]) next[name] = { ...current[name] };
  const warnings: string[] = [];
  for (const [bridge, body] of Object.entries(patch as Record<string, unknown>)) {
    if (!isBridgeName(bridge)) throw new Error(`bridges.${bridge} is not a known bridge`);
    if (typeof body !== "object" || body === null || Array.isArray(body)) throw new Error(`bridges.${bridge} must be an object`);
    for (const [key, value] of Object.entries(body as Record<string, unknown>)) {
      const sw = switchOf(bridge, key);
      if (!sw) throw new Error(`bridges.${bridge}.${key} is not a known option`);
      if (!validValue(sw, value)) {
        throw new Error(sw.kind === "boolean" ? `bridges.${bridge}.${key} must be true or false` : `bridges.${bridge}.${key} must be one of ${(sw.choices ?? []).join(", ")}`);
      }
      next[bridge] = { ...(next[bridge] ?? {}), [key]: value };
      if (isRiskyValue(sw, value)) warnings.push(`bridge_${bridge}_${key}`);
    }
  }
  return { next, warnings };
}

/** The retained message for one bridge: only the switches of that bridge, with their values in force. */
export function settingsMessage(name: BridgeName, file: BridgesFile | undefined): string {
  const view = resolveBridgeSettings(file)[name];
  return JSON.stringify({ schema: 1, settings: Object.fromEntries(Object.entries(view).map(([k, v]) => [k, v.value])) });
}

/** Every bridge with its retained message. */
export function allSettingsMessages(file: BridgesFile | undefined): Array<{ name: BridgeName; payload: string }> {
  return BRIDGE_NAMES.map((name) => ({ name, payload: settingsMessage(name, file) }));
}
