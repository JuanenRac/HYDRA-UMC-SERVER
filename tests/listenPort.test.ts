import test from "node:test";
import assert from "node:assert/strict";
import { resolveListenPort } from "../src/listenPort";

test("the variable of the service wins over the shared PORT", () => {
  const r = resolveListenPort({ HYDRA_UMC_SERVER_PORT: "3100", PORT: "1883" }, 4000);
  assert.deepEqual(r, { port: 3100, source: "specific" });
});

test("the shared PORT is only a reserve and warns", () => {
  const r = resolveListenPort({ PORT: "3200" }, 4000);
  assert.equal(r.port, 3200);
  assert.equal(r.source, "PORT");
  assert.match(r.warning ?? "", /HYDRA_UMC_SERVER_PORT/);
});

test("PORT is ignored when the specific variable is valid, even if PORT is invalid", () => {
  assert.equal(resolveListenPort({ HYDRA_UMC_SERVER_PORT: "3100", PORT: "abc" }, undefined).port, 3100);
});

test("an invalid specific variable falls through to the next source", () => {
  assert.equal(resolveListenPort({ HYDRA_UMC_SERVER_PORT: "70000" }, 4000).source, "config");
  assert.equal(resolveListenPort({ HYDRA_UMC_SERVER_PORT: "" }, undefined).port, 3000);
});

test("saved config then the historical default", () => {
  assert.deepEqual(resolveListenPort({}, 4000), { port: 4000, source: "config" });
  assert.deepEqual(resolveListenPort({}, undefined), { port: 3000, source: "default" });
});
