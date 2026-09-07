// =============================================================================
// HYDRA-UMC-SERVER - Direct unit tests for src/kinematics.ts
// Copyright (C) 2026 JuanenRac (Electro Hobby 3D) <electrohobby3d@gmail.com>
// GPL-3.0 - see LICENSE
// =============================================================================
// calculateJoints() already lived in its own module, but - like the rest
// of this repository before the same audit that added
// tests/serverPolicy.test.ts - had no direct unit test of its own; the
// "reset"/"jog" command cases in server.ts only exercise it indirectly,
// end-to-end, through a whole real server process. Expected values below
// were captured from this function's own real output (not hand-derived),
// except the 3-4-5 triangle case, whose j1 is independently checkable by
// hand (atan2(400, 300) = atan(4/3) = 53.13 deg, the classic 3-4-5 right
// triangle).
import test from "node:test";
import assert from "node:assert/strict";
import { calculateJoints } from "../src/kinematics";

test("calculateJoints", async (t) => {
  await t.test("home-like pose (x=y=0, z=195) hits both degenerate-distance guards at once", () => {
    const j = calculateJoints({ x: 0, y: 0, z: 195 });
    assert.deepEqual(j, { j1: 0, j2: 90, j3: 180, j4: 0, j5: -90, j6: 0 });
  });

  await t.test("a fully empty position defaults every field to 0", () => {
    const j = calculateJoints({});
    assert.deepEqual(j, { j1: 0, j2: -112.247, j3: 115.522, j4: 0, j5: 47.769, j6: 0 });
  });

  await t.test("j1 matches a real, independently-checkable 3-4-5 right triangle", () => {
    const j = calculateJoints({ x: 300, y: 400, z: 195 });
    assert.equal(j.j1, 53.13); // atan2(400, 300) * 180/pi, rounded to 3 decimals
  });

  await t.test("j4/j6 pass a/c straight through, j5 folds in b - orientation is never silently dropped", () => {
    const withoutOrientation = calculateJoints({ x: 0, y: 0, z: 195 });
    const withOrientation = calculateJoints({ x: 0, y: 0, z: 195, a: 10, b: 5, c: -20 });
    assert.equal(withOrientation.j4, 10);
    assert.equal(withOrientation.j6, -20);
    assert.equal(withOrientation.j5, withoutOrientation.j5 + 5);
    // Position-driven joints (j1/j2/j3) are unaffected by orientation.
    assert.equal(withOrientation.j1, withoutOrientation.j1);
    assert.equal(withOrientation.j2, withoutOrientation.j2);
    assert.equal(withOrientation.j3, withoutOrientation.j3);
  });

  await t.test("every returned joint is a plain finite number, never NaN, even from a degenerate input", () => {
    const j = calculateJoints({ x: 0, y: 0, z: 0 });
    for (const value of Object.values(j)) {
      assert.equal(typeof value, "number");
      assert.ok(Number.isFinite(value), `expected a finite number, got ${value}`);
    }
  });
});
