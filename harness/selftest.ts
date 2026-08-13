// Proves the harness mechanism itself works, with no real hardware
// attached: builds a small synthetic trace against the example firmware,
// replays it through both emulatorSide.ts AND the fake loopback link
// (fixtures/loopbackLink.ts, which is just a second instance of the same
// wasm module - see that file's header comment for exactly what this does
// and does not prove), and asserts the frames match.
//
// This is NOT a test that your differential harness setup will work
// against real hardware. It is a test that this repo's own harness code
// (pacing, capture points, pixel comparison) is not broken. Run it after
// any change to harness/*.ts; run `bun run example:build` first if
// wasm/dist/emu.wasm doesn't exist yet.
//
//   bun run harness:selftest

import { existsSync } from "node:fs";
import { join } from "node:path";
import { replayEmulator } from "./emulatorSide";
import { replayHardware } from "./hardwareSide";
import { compareFrames } from "../src/compare";
import makeLoopbackLink from "./fixtures/loopbackLink";
import type { TraceEvent } from "./types";

const ROOT = join(import.meta.dir, "..");
const WASM = join(ROOT, "wasm", "dist", "emu.wasm");

function fail(msg: string): never {
  console.error(`FAIL: ${msg}`);
  process.exit(1);
}

if (!existsSync(WASM)) {
  fail(`${WASM} does not exist. Run "bun run example:build" first.`);
}

// A small hand-built trace exercising touch (a partial-refresh push) and a
// button short-press (a full-panel push), against the example firmware's
// declared button/sensor indices (see example/firmware/main.c: BTN_A = 0).
// Timestamps are milliseconds, matching performance.now()'s unit.
const events: TraceEvent[] = [
  { t: 0, k: "tick" },
  { t: 16, k: "touch", down: 1, x: 100, y: 100 },
  { t: 16, k: "tick" },
  { t: 32, k: "touch", down: 0, x: 100, y: 100 },
  { t: 32, k: "tick" },
  { t: 300, k: "button", i: 0, down: 1 },
  { t: 300, k: "tick" },
  { t: 320, k: "button", i: 0, down: 0 },
  { t: 320, k: "verdict", i: 0, long: 0 },
  { t: 320, k: "tick" },
];

const capturePoints = [32, 320];

console.log(`replaying ${events.length} synthetic events against ${WASM}`);

const emuResult = await replayEmulator(WASM, events, capturePoints);
console.log(`emulator side: ${emuResult.frames.length} frame(s), device "${emuResult.device.name}"`);

const hwResult = await replayHardware(makeLoopbackLink(WASM), events, capturePoints);
console.log(`loopback side: ${hwResult.frames.length} frame(s)`);

if (emuResult.frames.length !== hwResult.frames.length) {
  fail(`frame count mismatch: ${emuResult.frames.length} vs ${hwResult.frames.length}`);
}

let allMatch = true;
for (let i = 0; i < emuResult.frames.length; i++) {
  const a = emuResult.frames[i]!;
  const b = hwResult.frames[i]!;
  const d = compareFrames(a.frame, b.frame, 0);
  if (d.match) {
    console.log(`  t=${a.atMs}ms  MATCH`);
  } else {
    allMatch = false;
    console.log(`  t=${a.atMs}ms  DIVERGE  ${d.diffPixels}/${d.totalPixels} px`);
  }
}

if (!allMatch) fail("harness self-test diverged against its own loopback link; the harness mechanism itself is broken (see harness/compare.ts, harness/emulatorSide.ts, harness/hardwareSide.ts)");

console.log("\nPASS: harness mechanism verified (emulator replay, loopback replay, pacing, capture points and pixel comparison all agree)");
console.log("Reminder: this used the fake loopback link, not real hardware - see fixtures/loopbackLink.ts's header comment.");
