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
  // Validated on a physical iPhone on 2026-08-19: x (left/right) confirmed
  // correct BEFORE the y fix; y (up/down, pitch) was found inverted and is
  // now negated, matching the spec/Android convention for that axis only.
  test("flat, face-up on a table: raw gravity-direct z (0,0,-g), z untouched by the y fix -> ABI (0,0,-1)", () => {
    expectVectorClose(mapAccelerationToVector(0, 0, -G, true), { x: 0, y: 0, z: -1 });
  });

  test("upright, screen facing the user: raw (0,-g,0), y negated like spec/Android -> ABI (0,1,0)", () => {
    expectVectorClose(mapAccelerationToVector(0, -G, 0, true), { x: 0, y: 1, z: 0 });
  });

  test("y sign flip matters: a moderate top-away tilt pours the correct edge only once y is negated", () => {
    // Real-hardware pose: phone tilted so the top edge leans away from the
    // user. Under the corrected mapping (y negated) this must pour toward
    // the target edge (positive y, matching the (0,1,0) upright anchor's
    // sign); the OLD un-negated-y mapping (what isIOS=false-for-y would
    // have produced, i.e. leaving raw y unflipped) pours the opposite way -
    // exactly "tilting the phone's top away pours the wrong way".
    const raw = { x: 0, y: -0.87 * G, z: -0.5 * G };
    const correct = mapAccelerationToVector(raw.x, raw.y, raw.z, true);
    const oldUnNegatedY = { x: raw.x / G, y: raw.y / G, z: raw.z / G }; // pre-fix iOS branch, y left un-negated
    expect(correct.y).toBeGreaterThan(0); // correct, post-fix
    expect(oldUnNegatedY.y).toBeLessThan(0); // the bug this follow-up fixes
    expect(correct.y).toBeCloseTo(-oldUnNegatedY.y, 6);
  });
});

describe("mapAccelerationToVector: negating the WRONG convention reproduces the reported left/right bug", () => {
  test("applying the spec's negation to iOS's gravity-direct x reading flips it backwards (the double-flip bug)", () => {
    // iOS raw for "tilted right" (gravity now has a positive x component
    // pouring toward the right edge of the panel) is gravity-direct on x,
    // e.g. (+g*0.5, -g*small, -g*0.87) for a moderate rightward tilt off
    // flat. Mapping it with isIOS=false (the old, always-negate-everything
    // code path this fix replaces) pours x the OTHER way - this is the
    // left/right regression Sylve originally reported on his real iPhone
    // ("tilt doesn't work in the right direction... tilting right pours
    // left"), fixed before this y-only follow-up and unaffected by it.
    const iosRawTiltedRight = { x: 0.5 * G, y: -0.1 * G, z: -0.87 * G };
    const correct = mapAccelerationToVector(iosRawTiltedRight.x, iosRawTiltedRight.y, iosRawTiltedRight.z, true);
    const doubleFlipped = mapAccelerationToVector(iosRawTiltedRight.x, iosRawTiltedRight.y, iosRawTiltedRight.z, false);
    expect(correct.x).toBeGreaterThan(0); // correct: pours right, matching the tilt
    expect(doubleFlipped.x).toBeLessThan(0); // the bug: pours left
    expect(correct.x).toBeCloseTo(-doubleFlipped.x, 6);
  });
});
