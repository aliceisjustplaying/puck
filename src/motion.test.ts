// Unit proof for mapAccelerationToVector (motion.ts's own pure, exported
// mapper from a raw devicemotion reading to the ABI's gravity vector),
// covering BOTH platform sign conventions at BOTH calibration anchors this
// file's own header comment derives - no DOM, no devicemotion event, no
// browser: this is exactly the pure function FIX 1 exists to make
// unit-testable, since scripts/verify-motion.ts can dispatch a real
// devicemotion event in real Chrome but cannot reliably fake
// DeviceMotionEvent.requestPermission as a function inside that same real
// event flow (see that script's own header comment).
//
// Run with: bun test src/motion.test.ts
import { describe, expect, test } from "bun:test";
import { mapAccelerationToVector } from "./motion";

const G = 9.80665;
const EPS = 1e-6;

function expectVectorClose(actual: { x: number; y: number; z: number }, expected: { x: number; y: number; z: number }): void {
  expect(actual.x).toBeCloseTo(expected.x, 6);
  expect(actual.y).toBeCloseTo(expected.y, 6);
  expect(actual.z).toBeCloseTo(expected.z, 6);
}

describe("mapAccelerationToVector: spec/Android convention (isIOS = false)", () => {
  test("flat, face-up on a table: raw support force (0,0,+g) -> ABI (0,0,-1)", () => {
    expectVectorClose(mapAccelerationToVector(0, 0, G, false), { x: 0, y: 0, z: -1 });
  });

  test("upright, screen facing the user: raw support force (0,-g,0) -> ABI (0,1,0)", () => {
    expectVectorClose(mapAccelerationToVector(0, -G, 0, false), { x: 0, y: 1, z: 0 });
  });
});

describe("mapAccelerationToVector: iOS Safari convention (isIOS = true)", () => {
  test("flat, face-up on a table: raw gravity-direct (0,0,-g) -> ABI (0,0,-1)", () => {
    expectVectorClose(mapAccelerationToVector(0, 0, -G, true), { x: 0, y: 0, z: -1 });
  });

  test("upright, screen facing the user: raw gravity-direct (0,+g,0) -> ABI (0,1,0)", () => {
    expectVectorClose(mapAccelerationToVector(0, G, 0, true), { x: 0, y: 1, z: 0 });
  });
});

describe("mapAccelerationToVector: negating the WRONG convention reproduces the reported bug", () => {
  test("applying the spec's negation to iOS's already gravity-direct reading flips it backwards (the double-flip bug)", () => {
    // iOS raw for "tilted right" (gravity now has a positive x component
    // pouring toward the right edge of the panel) is gravity-direct, e.g.
    // (+g*0.5, 0, -g*0.87) for a moderate rightward tilt off flat. Mapping
    // it with isIOS=false (the old, always-negate code path this fix
    // replaces) pours the OTHER way - this is the exact regression Sylve
    // reported on his real iPhone ("tilt doesn't work in the right
    // direction... tilting right pours left").
    const iosRawTiltedRight = { x: 0.5 * G, y: 0, z: -0.87 * G };
    const correct = mapAccelerationToVector(iosRawTiltedRight.x, iosRawTiltedRight.y, iosRawTiltedRight.z, true);
    const doubleFlipped = mapAccelerationToVector(iosRawTiltedRight.x, iosRawTiltedRight.y, iosRawTiltedRight.z, false);
    expect(correct.x).toBeGreaterThan(0); // correct: pours right, matching the tilt
    expect(doubleFlipped.x).toBeLessThan(0); // the bug: pours left
    expect(correct.x).toBeCloseTo(-doubleFlipped.x, 6);
  });
});
