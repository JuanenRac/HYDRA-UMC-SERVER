// =============================================================================
// HYDRA-UMC-SERVER - src/urtcTools.ts
// Copyright (C) 2026 JuanenRac (Electro Hobby 3D) <electrohobby3d@gmail.com>
// GPL-3.0 - see LICENSE
// =============================================================================
// The tool modes of the URTC tool heads, as the common list of the SDK writes them (contracts/urtc_tools.json: identifier, constant name and title).
// The command "tool" of a robot has always taken any text. This list lets the server say, in its log, that a tool is not one of the family; it never
// refuses it (a lab can have its own head), so what the command does is the same as before. tests/urtcTools.test.ts compares this table with the
// file of the SDK when a checkout of the SDK is at hand (HYDRA_UMC_SDK_DIR, or the sibling folder).

export interface UrtcTool {
  id: number;
  name: string;
  title: string;
}

/** The identifier that means "no tool assigned" (TOOL_INVALID). */
export const URTC_NO_TOOL_ID = 25;

export const URTC_TOOLS: readonly UrtcTool[] = [
  { id: 0, name: "TOOL_SOLDERING_IRON", title: "Soldering Station (T12)" },
  { id: 1, name: "TOOL_PASTE_DISPENSER", title: "SMT Solder Paste Dispenser" },
  { id: 2, name: "TOOL_LIQUID_DISPENSER", title: "Thermal Paste / Liquid Dispenser" },
  { id: 3, name: "TOOL_SCREWDRIVER", title: "Smart Electric Screwdriver" },
  { id: 4, name: "TOOL_VACUUM_PICKUP", title: "Vacuum / Pneumatic Gripper" },
  { id: 5, name: "TOOL_DRILL", title: "Drill (BL4260)" },
  { id: 6, name: "TOOL_GRIPPER_GIMBAL", title: "Gimbal Gripper" },
  { id: 7, name: "TOOL_GRIPPER_NEMA", title: "NEMA Gripper" },
  { id: 8, name: "TOOL_AOI_INSPECTION", title: "AOI (Automated Optical Inspection) System" },
  { id: 9, name: "TOOL_LASER_ENGRAVER", title: "Engraving Laser Diode (10W optical)" },
  { id: 10, name: "TOOL_3D_PRINTER", title: "3D Printing Hotend" },
  { id: 11, name: "TOOL_SCAN_PROBE", title: "3D Scanner Probe" },
  { id: 12, name: "TOOL_SMT_PICKPLACE", title: "SMT Pick & Place Head" },
  { id: 13, name: "TOOL_ELECTROMAGNET", title: "Heavy-Duty Electromagnet" },
  { id: 14, name: "TOOL_SPOT_WELDER", title: "Spot Welder Head" },
  { id: 15, name: "TOOL_CONFORMAL_COATING", title: "Conformal Coating Airbrush" },
  { id: 16, name: "TOOL_VACUUM_GRIPPER_LG", title: "Large-Format Vacuum Gripper" },
  { id: 17, name: "TOOL_FLYING_PROBE", title: "Functional Testing Head" },
  { id: 18, name: "TOOL_UV_CURING", title: "UV Curing Head" },
  { id: 19, name: "TOOL_HOTAIR_REWORK", title: "Hot Air Rework Nozzle" },
  { id: 20, name: "TOOL_PRESSFIT_INSERTER", title: "Pneumatic Press-Fit Inserter" },
  { id: 21, name: "TOOL_CRIMPING_ACTUATOR", title: "Wire Harnessing / Crimping Actuator" },
  { id: 22, name: "TOOL_THERMAL_INSPECTION", title: "PCB Advanced Inspection" },
  { id: 23, name: "TOOL_PASTE_JETTING", title: "Solder Paste Jetting Valve" },
  { id: 24, name: "TOOL_ULTRASONIC_WELDER", title: "Ultrasonic Welder / Packaging Sealer" },
];

const NAMES: ReadonlySet<string> = new Set(
  URTC_TOOLS.flatMap((tool) => [tool.name, tool.name.replace(/^TOOL_/, ""), tool.title].map((text) => text.toLowerCase())).concat(["none", "tool_invalid", "invalid"]),
);

/**
 * True when `value` names a tool of the family: its constant name (with or without `TOOL_`), its title (what STUDIO sends), "None" (no tool), or its
 * identifier as a whole number from 0 to 25. Case and the spaces at the ends do not count.
 */
export function isKnownUrtcTool(value: unknown): boolean {
  if (typeof value === "number") return Number.isInteger(value) && value >= 0 && value <= URTC_NO_TOOL_ID;
  if (typeof value !== "string") return false;
  const text = value.trim().toLowerCase();
  if (text === "") return false;
  if (/^\d{1,2}$/.test(text)) return Number(text) <= URTC_NO_TOOL_ID;
  return NAMES.has(text);
}

/** The line for the log when the tool of a command is not one of the family, or null when it is. The text is cut so a long value cannot fill the log. */
export function unknownToolLogLine(robotId: unknown, value: unknown): string | null {
  if (isKnownUrtcTool(value)) return null;
  const shown = typeof value === "string" ? JSON.stringify(value.slice(0, 60)) : typeof value === "number" ? String(value) : `a ${typeof value}`;
  return `[tool] robot ${String(robotId)}: ${shown} is not a tool of the URTC family (the command is applied as sent)`;
}
