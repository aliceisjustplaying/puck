// A captured frame, in the one representation every part of this repo that
// compares or stores pixels agrees on: RGB, 3 bytes per pixel, row-major,
// top-left origin. Defined once, here, because two consumers need the exact
// same shape - the differential test harness (harness/types.ts re-exports
// this) and the in-page, hardware-free regression check (src/regression.ts)
// - and two copies of one shape agree with each other exactly once, at the
// moment the second copy gets written, then drift with nothing to notice.
// See docs/decisions/0002-two-compilers-not-one.md for the same argument
// made about firmware logic; it applies just as much to this repo's own
// code.
export interface CapturedFrame {
  width: number;
  height: number;
  rgb: Uint8Array; // width * height * 3 bytes
}
