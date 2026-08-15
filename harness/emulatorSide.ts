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
import { replayFromBytes, type ReplayResult } from "../src/replayCore";
import type { TraceEvent, TraceSchemaVersion } from "../src/recorder";

export type EmulatorReplayResult = ReplayResult;

export async function replayEmulator(wasmPath: string, schemaVersion: TraceSchemaVersion, events: TraceEvent[], capturePoints: number[]): Promise<ReplayResult> {
  const bytes = readFileSync(wasmPath).buffer as ArrayBuffer;
  return replayFromBytes(bytes, schemaVersion, events, capturePoints);
}
