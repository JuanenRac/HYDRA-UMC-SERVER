import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { aiPortDrift, effectiveAiPorts, parsePortsRegistry, registryNameOfAiService, type RegistryService } from "../src/portsRegistry";
import { LOCAL_AI_SERVICE_PORTS } from "../src/routes/localAiRoutes";

// The ports of the local AI services: the built-in table is the default, the registry of the SDK can only correct a port, and a port that moved is found by a check.

const entry = (name: string, port: number | null): RegistryService => ({ name, port, healthPath: "/health", systemdUnit: null });
const registryOf = (...entries: RegistryService[]) => new Map(entries.map((e) => [e.name, e]));
const DEFAULTS = { "visual-servoing-api": 8116, "vla-engine": 8098, datalake: 8095 };

test("a service is named in the registry like the repository it comes from", () => {
  assert.equal(registryNameOfAiService("visual-servoing-api"), "HYDRA-UMC-VISUAL-SERVOING-API");
  assert.equal(registryNameOfAiService("datalake"), "HYDRA-UMC-DATALAKE");
});

test("with the option off the built-in table is the answer, whatever the registry says", () => {
  const registry = registryOf(entry("HYDRA-UMC-VISUAL-SERVOING-API", 9999));
  assert.equal(effectiveAiPorts(DEFAULTS, registry, false), DEFAULTS);
});

test("with the option on a port the registry names is used, and everything else stays as it is", () => {
  const registry = registryOf(entry("HYDRA-UMC-VISUAL-SERVOING-API", 8200), entry("HYDRA-UMC-DATALAKE", null), entry("HYDRA-UMC-SOMETHING-NEW", 8300));
  assert.deepEqual(effectiveAiPorts(DEFAULTS, registry, true), { "visual-servoing-api": 8200, "vla-engine": 8098, datalake: 8095 });
});

test("the registry never adds a service and never takes a port that is not one", () => {
  const registry = registryOf(entry("HYDRA-UMC-NEW-SERVICE", 8300), entry("HYDRA-UMC-VLA-ENGINE", 0), entry("HYDRA-UMC-DATALAKE", 70000), entry("HYDRA-UMC-VISUAL-SERVOING-API", 81.5));
  const ports = effectiveAiPorts(DEFAULTS, registry, true);
  assert.deepEqual(Object.keys(ports).sort(), Object.keys(DEFAULTS).sort());
  assert.deepEqual(ports, DEFAULTS);
});

test("a port that moved is listed as drift, and one that agrees is not", () => {
  const registry = registryOf(entry("HYDRA-UMC-VISUAL-SERVOING-API", 8091), entry("HYDRA-UMC-VLA-ENGINE", 8098), entry("HYDRA-UMC-DATALAKE", null));
  assert.deepEqual(aiPortDrift(DEFAULTS, registry), [{ service: "visual-servoing-api", builtIn: 8116, registry: 8091 }]);
  assert.deepEqual(aiPortDrift(DEFAULTS, new Map()), []);
});

test("the table of the relay agrees with the registry of the SDK when it is next to this repository", (t) => {
  const roots = [process.env.HYDRA_UMC_SDK_DIR, path.resolve(process.cwd(), "..", "HYDRA-UMC-SDK")].filter((dir): dir is string => !!dir);
  const file = roots.map((dir) => path.join(dir, "contracts", "ports.yaml")).find((candidate) => fs.existsSync(candidate));
  if (!file) {
    t.skip("no registry of the SDK at hand");
    return;
  }
  const drift = aiPortDrift(LOCAL_AI_SERVICE_PORTS, parsePortsRegistry(fs.readFileSync(file, "utf8")));
  assert.deepEqual(drift, [], "a service moved its port and the relay still sends to the old one");
});
