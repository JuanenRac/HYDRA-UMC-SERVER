// =============================================================================
// HYDRA-UMC-SERVER - src/portsRegistry.ts
// Copyright (C) 2026 JuanenRac (Electro Hobby 3D) <electrohobby3d@gmail.com>
// GPL-3.0-or-later - see LICENSE
// =============================================================================
// The registry of the services of the ecosystem (contracts/ports.yaml of the SDK): name, port, health
// path and systemd unit of each one, generated from what the repositories declare. The ecosystem
// status asks it for what a project's own manifest does not say (13 manifests declare no port: it comes
// from their systemd unit), so those services also get a live signal. A value in the manifest always
// wins over the registry. `HYDRA_UMC_PORTS_REGISTRY=off` turns the lookup off; a path in it names the
// file to read instead of searching for one.
import fs from "node:fs";
import path from "node:path";

export interface RegistryService {
  name: string;
  port: number | null;
  healthPath: string | null;
  systemdUnit: string | null;
}

/** Reads the generated file (a fixed, flat shape; not a general YAML reader). */
export function parsePortsRegistry(text: string): Map<string, RegistryService> {
  const services = new Map<string, RegistryService>();
  let current: RegistryService | null = null;
  const value = (raw: string): string | null => {
    const v = raw.trim().replace(/^["']|["']$/g, "");
    return v === "" || v === "null" ? null : v;
  };
  for (const line of text.split(/\r?\n/)) {
    if (/^\s*#/.test(line) || line.trim() === "") continue;
    const start = /^\s*-\s+name:\s*(.+)$/.exec(line);
    if (start) {
      const name = value(start[1]);
      current = name ? { name, port: null, healthPath: null, systemdUnit: null } : null;
      if (current) services.set(current.name, current);
      continue;
    }
    if (!current) continue;
    const field = /^\s+(port|health_path|systemd_unit):\s*(.*)$/.exec(line);
    if (!field) continue;
    const v = value(field[2]);
    if (field[1] === "port") {
      const n = v === null ? NaN : Number(v);
      current.port = Number.isInteger(n) && n > 0 && n <= 65535 ? n : null;
    } else if (field[1] === "health_path") {
      current.healthPath = v !== null && v.startsWith("/") ? v : null;
    } else {
      current.systemdUnit = v;
    }
  }
  return services;
}

/** Where the registry file may be: the named file, or the SDK checkout next to the other repositories. */
export function registryCandidates(ecosystemRoot: string, env: NodeJS.ProcessEnv = process.env): string[] {
  const named = (env.HYDRA_UMC_PORTS_REGISTRY ?? "").trim();
  if (named.toLowerCase() === "off") return [];
  if (named) return [path.resolve(named)];
  return ["HYDRA-UMC-SDK", "hydra-umc-sdk", "sdk"].map((dir) => path.join(ecosystemRoot, dir, "contracts", "ports.yaml"));
}

export function loadPortsRegistry(ecosystemRoot: string, env: NodeJS.ProcessEnv = process.env): Map<string, RegistryService> {
  for (const candidate of registryCandidates(ecosystemRoot, env)) {
    try {
      return parsePortsRegistry(fs.readFileSync(candidate, "utf-8"));
    } catch {
      /* try the next place */
    }
  }
  return new Map();
}

export interface DeclaredService {
  servicePort: number | null;
  serviceHealthPath: string | null;
  systemdUnit: string | null;
}

/** What the manifest declares, completed with what only the registry knows. The manifest wins. */
export function completeFromRegistry(name: string, declared: DeclaredService, registry: Map<string, RegistryService>): DeclaredService {
  const entry = registry.get(name);
  if (!entry) return declared;
  const servicePort = declared.servicePort ?? entry.port;
  return {
    servicePort,
    // a health path only makes sense next to the port it belongs to
    serviceHealthPath: declared.serviceHealthPath ?? (declared.servicePort === null ? entry.healthPath : null),
    systemdUnit: declared.systemdUnit ?? entry.systemdUnit,
  };
}
