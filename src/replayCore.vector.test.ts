// Golden-trace proof that a "vector" TraceEvent (recorder.ts, the new event
// kind for a "kind": "vector" sensor's reading - see wasm/emu_abi.h's
// emu_sensor_vector) replays through replayCore.ts's replayFromBytes
// exactly the way every other event kind already does, and - the specific
// guarantee this ABI addition depends on - that a module with NO
// emu_sensor_vector export (every module built before this ABI addition,
// including the instrument's own example/ firmware) skips it silently and
// replays bit-identically to a trace that never had the event at all.
//
// example/firmware/main.c declares no "kind": "vector" sensor and exports
// no emu_sensor_vector, on purpose: that is exactly the "module lacks the
// export" case replayCore.ts's own comment describes, and using the
// instrument's own minimal reference firmware here (rather than a device
// pack's zig build) keeps this test self-contained - it only needs `bun run
// example:build` to have run first, the same precondition harness:selftest
// already documents.
//
// Run with: bun test src/replayCore.vector.test.ts

import { describe, expect, test } from "bun:test";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { replayFromBytes } from "./replayCore";
import type { TraceEvent } from "./recorder";

const ROOT = join(import.meta.dir, "..");
const WASM = join(ROOT, "wasm", "dist", "emu.wasm");

const baseEvents: TraceEvent[] = [
  { t: 0, k: "tick" },
  { t: 16, k: "touch", down: 1, x: 50, y: 50 },
  { t: 16, k: "tick" },
  { t: 32, k: "touch", down: 0, x: 50, y: 50 },
  { t: 32, k: "tick" },
];

// The same trace, PLUS one "vector" event inserted between two ticks - the
// golden snippet this file's own header comment promises. Against a module
// with no emu_sensor_vector export, replayCore.ts's own case
// (`emu.emu_sensor_vector?.(...)`) makes this call a guaranteed no-op.
const withVectorEvents: TraceEvent[] = [
  baseEvents[0]!,
  { t: 8, k: "vector", i: 0, x: 0, y: 1, z: 0 },
  ...baseEvents.slice(1),
];

describe("replayCore: 'vector' TraceEvent (wasm/emu_abi.h's emu_sensor_vector)", () => {
  test(`${WASM} exists (run "bun run example:build" first)`, () => {
    expect(existsSync(WASM)).toBe(true);
  });

  test("a module with no emu_sensor_vector export does not throw on a 'vector' event", async () => {
    const bytes = readFileSync(WASM).buffer as ArrayBuffer;
    const result = await replayFromBytes(bytes, withVectorEvents, [32]);
    expect(result.frames.length).toBe(1);
  });

  test("a trace with a 'vector' event replays BIT-IDENTICALLY to the same trace without one, against a module that lacks the export", async () => {
    const bytes = readFileSync(WASM).buffer as ArrayBuffer;
    const withVector = await replayFromBytes(bytes, withVectorEvents, [32]);
    const without = await replayFromBytes(bytes, baseEvents, [32]);

    expect(withVector.frames.length).toBe(without.frames.length);
    const a = withVector.frames[0]!.frame;
    const b = without.frames[0]!.frame;
    expect(a.width).toBe(b.width);
    expect(a.height).toBe(b.height);
    expect(a.rgb.length).toBe(b.rgb.length);
    let diff = 0;
    for (let i = 0; i < a.rgb.length; i++) if (a.rgb[i] !== b.rgb[i]) diff++;
    expect(diff).toBe(0);
  });
});
