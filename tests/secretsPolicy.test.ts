import assert from "node:assert/strict";
import { test } from "node:test";
import { bootstrapPasswordProblem, jwtSecretProblem, looksLikeAPlaceholder } from "../src/secretsPolicy.ts";

test("the example values of the deployment template are placeholders", () => {
  for (const value of ["SET_LOCALLY_TO_A_LONG_RANDOM_VALUE", "SET_LOCALLY_AND_REMOVE_AFTER_FIRST_START", "change-me-please", "ChangeMe", "your_secret_here", "hydra_industrial_secret_2026", "hydraumc-setup"]) {
    assert.equal(looksLikeAPlaceholder(value), true, value);
  }
  assert.equal(looksLikeAPlaceholder("f3a9c07b1d5e48a2b6c1e90d7a4f3b28"), false);
});

test("a production JWT secret must be long, varied and not an example", () => {
  assert.match(jwtSecretProblem("SET_LOCALLY_TO_A_LONG_RANDOM_VALUE") ?? "", /example/);
  assert.match(jwtSecretProblem("short") ?? "", /at least 32/);
  assert.match(jwtSecretProblem("a".repeat(40)) ?? "", /repetitive/);
  assert.equal(jwtSecretProblem("f3a9c07b1d5e48a2b6c1e90d7a4f3b28c5d6e7f8a9b0c1d2"), null);
});

test("a production bootstrap administrator password must be long and not an example", () => {
  assert.match(bootstrapPasswordProblem("SET_LOCALLY_AND_REMOVE_AFTER_FIRST_START", "hydra_umc") ?? "", /example/);
  assert.match(bootstrapPasswordProblem("short-pass", "hydra_umc") ?? "", /at least 12/);
  assert.match(bootstrapPasswordProblem("my-hydra_umc-password-1", "hydra_umc") ?? "", /username/);
  assert.equal(bootstrapPasswordProblem("correct horse battery staple 7", "hydra_umc"), null);
});
