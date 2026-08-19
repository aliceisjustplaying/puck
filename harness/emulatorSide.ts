// Replays a trace against the emulator side of a comparison, headless: no
// browser, no canvas, no puppeteer. This file's only job now is the
// node:fs part (reading a wasm module off disk); the actual replay
// mechanism (instantiate, call the ABI functions in order, capture the
// framebuffer at each requested point) lives in src/replayCore.ts's
// replayFromBytes, shared with the in-page hardware-free regression check
// (src/regression.ts), which already has its module's bytes in memory and
// calls replayFromBytes directly - see that file's header comment for why
// this is one implementation, not two.

import { readFileSync } from "node:fs";
import { replayFromBytes, type ReplayResult, type ReplayOptions } from "../src/replayCore";
import type { TraceEvent } from "./types";

export type EmulatorReplayResult = ReplayResult;

// `options` is the replayed trace's own instantiation state (today: its
// seed, see src/replayCore.ts's ReplayOptions). Every caller that has a
// whole Trace in hand passes `{ seed: trace.seed }` rather than dropping
// it, so a trace recorded from a module that uses randomness replays the
// same way here as it did in the page.
export async function replayEmulator(wasmPath: string, events: TraceEvent[], capturePoints: number[], options: ReplayOptions = {}): Promise<ReplayResult> {
  const bytes = readFileSync(wasmPath).buffer as ArrayBuffer;
  return replayFromBytes(bytes, events, capturePoints, options);
}
