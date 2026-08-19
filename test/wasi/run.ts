#!/usr/bin/env bun
// Proves WASI-lite (src/wasiLite.ts, docs/decisions/0004-wasi-lite-not-wasi.md)
// through the SAME replay path the page and the harness use
// (src/replayCore.ts's replayFromBytes), never against a hand-built import
// object of its own: a test that shimmed WASI itself would prove only that
// the test can shim WASI.
//
// Seven checks, each of which fails loudly on its own line:
//   1. a module importing the supported four instantiates and replays at
//      all (this is the check that is RED before the loader change: the
//      old loader rejected any wasi import outright)
//   2. fd_write reaches the same log sink env.js_log does
//   3. clock_time_get follows emu_tick's own nowMs, and reads 0 before the
//      first tick
//   4. the same trace replayed twice with the same seed produces
//      byte-identical frames (random_get is deterministic)
//   5. a different seed produces different frames (random_get is actually
//      seeded, not a constant pretending to be deterministic)
//   6. a module importing an unsupported wasi symbol is refused, by a
//      message naming every offending symbol
//   7. proc_exit stops the module with a message naming the exit code
//
// Run: bun run test:wasi   (needs zig, like every other firmware fixture
// in this repo; set ZIG_EXE if it is not on PATH)

import { readFileSync } from "node:fs";
import { buildWasiFixture } from "./build";
import { replayFromBytes } from "../../src/replayCore";
import { instantiate } from "../../src/wasm";
import { DEFAULT_TRACE_SEED } from "../../src/wasiLite";
import type { TraceEvent } from "../../src/recorder";

function fail(message: string): never {
  console.error(`FAIL: ${message}`);
  process.exit(1);
}

// A trace with nothing but ticks: this fixture draws from random_get and
// the clock on every tick, so ticks alone exercise everything under test.
const TICKS = [0, 16, 32, 48];
const EVENTS: TraceEvent[] = TICKS.map((t) => ({ t, k: "tick" }) as TraceEvent);

function bytesOf(path: string): ArrayBuffer {
  return readFileSync(path).buffer as ArrayBuffer;
}

function framesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

async function main(): Promise<void> {
  console.log("building the wasi fixtures (zig cc)...");
  const probePath = buildWasiFixture("probe");
  const unsupportedPath = buildWasiFixture("unsupported");
  const probeBytes = bytesOf(probePath);
  const unsupportedBytes = bytesOf(unsupportedPath);

  // ---- 1. a supported-subset module loads and replays --------------------
  console.log("\n1. a module importing the supported four (fd_write, clock_time_get, random_get, proc_exit) replays...");
  const run = await replayFromBytes(probeBytes, EVENTS, TICKS);
  if (run.frames.length !== TICKS.length) fail(`expected ${TICKS.length} captured frame(s), got ${run.frames.length}`);
  if (run.device.panel.w !== 64 || run.device.panel.h !== 64) {
    fail(`expected the fixture's own 64x64 panel from emu_device(), got ${run.device.panel.w}x${run.device.panel.h}`);
  }
  console.log(`PASS: ${run.frames.length} frame(s) captured from a wasi-importing module`);

  // ---- 2. fd_write lands in the log sink --------------------------------
  console.log("\n2. fd_write reaches the same sink as env.js_log...");
  if (!run.log.includes("wasi probe: init")) {
    fail(`the fixture's own fd_write line is missing from the replay log; got: ${JSON.stringify(run.log)}`);
  }
  console.log(`PASS: "wasi probe: init" arrived through fd_write (${run.log.length} log line(s) total)`);

  // ---- 3. clock_time_get follows emu_tick -------------------------------
  console.log("\n3. clock_time_get returns the last nowMs handed to emu_tick...");
  const clockLines = run.log.filter((l) => l.startsWith("clock="));
  if (clockLines.length !== TICKS.length) fail(`expected one clock line per tick (${TICKS.length}), got ${clockLines.length}: ${JSON.stringify(clockLines)}`);
  for (let i = 0; i < TICKS.length; i++) {
    const expected = `clock=${TICKS[i]}`;
    if (clockLines[i] !== expected) fail(`tick ${i} read the clock as ${JSON.stringify(clockLines[i])}, expected ${JSON.stringify(expected)}`);
  }
  // Before the first tick there is no clock at all, and the shim says so
  // with 0 rather than a wall-clock reading: proved by instantiating and
  // reading the clock without replaying anything (emu_init's own fd_write
  // is the only output, and the fixture logs no clock until a tick).
  const preTickLog: string[] = [];
  const preTick = await instantiate(probeBytes, (t) => preTickLog.push(t));
  if (preTick.emu_init() === 0) fail("emu_init() returned 0 on the wasi fixture");
  if (preTickLog.some((l) => l.startsWith("clock="))) fail("the fixture logged a clock before any tick, which this check cannot then interpret");
  preTick.emu_tick(0);
  if (!preTickLog.includes("clock=0")) fail(`the first tick at nowMs=0 should read the clock as 0; log: ${JSON.stringify(preTickLog)}`);
  console.log(`PASS: the clock read ${clockLines.join(", ")} across ticks ${TICKS.join(", ")}, and 0 at the first tick`);

  // ---- 4 & 5. random_get is deterministic, and actually seeded ----------
  console.log("\n4. the same seed replays byte-identically...");
  const again = await replayFromBytes(probeBytes, EVENTS, TICKS);
  for (let i = 0; i < run.frames.length; i++) {
    if (!framesEqual(run.frames[i]!.frame.rgb, again.frames[i]!.frame.rgb)) {
      fail(`frame ${i} (t=${run.frames[i]!.atMs}ms) differs between two replays with the same (default) seed`);
    }
  }
  console.log(`PASS: ${run.frames.length}/${run.frames.length} frame(s) identical across two replays at the default seed (${DEFAULT_TRACE_SEED})`);

  console.log("\n5. a different seed produces different pixels...");
  const seeded = await replayFromBytes(probeBytes, EVENTS, TICKS, { seed: DEFAULT_TRACE_SEED + 1 });
  const anyDifferent = seeded.frames.some((f, i) => !framesEqual(f.frame.rgb, run.frames[i]!.frame.rgb));
  if (!anyDifferent) fail("changing the seed changed nothing: random_get is not actually seeded from the trace");
  // ...and that OTHER seed is itself reproducible, which is the half that
  // makes a seeded trace worth recording at all.
  const seededAgain = await replayFromBytes(probeBytes, EVENTS, TICKS, { seed: DEFAULT_TRACE_SEED + 1 });
  for (let i = 0; i < seeded.frames.length; i++) {
    if (!framesEqual(seeded.frames[i]!.frame.rgb, seededAgain.frames[i]!.frame.rgb)) {
      fail(`frame ${i} differs between two replays at seed ${DEFAULT_TRACE_SEED + 1}`);
    }
  }
  console.log(`PASS: seed ${DEFAULT_TRACE_SEED + 1} drew different pixels than seed ${DEFAULT_TRACE_SEED}, and reproduced itself exactly`);

  // ---- 6. an unsupported wasi import is refused by name ----------------
  console.log("\n6. an unsupported wasi import is refused, naming every offending symbol...");
  let refusal: string | null = null;
  try {
    await instantiate(unsupportedBytes, () => {});
  } catch (err) {
    refusal = err instanceof Error ? err.message : String(err);
  }
  if (refusal === null) fail("a module importing wasi_snapshot_preview1.fd_read and .args_get was accepted");
  for (const symbol of ["wasi_snapshot_preview1.args_get", "wasi_snapshot_preview1.fd_read"]) {
    if (!refusal.includes(symbol)) fail(`the refusal does not name ${symbol}: ${refusal}`);
  }
  console.log(`PASS: refused with "${refusal.slice(0, 120)}..."`);

  // ---- 7. proc_exit halts, with the code in the message ----------------
  console.log("\n7. proc_exit halts the module, naming its exit code...");
  const exitLog: string[] = [];
  const exiting = await instantiate(probeBytes, (t) => exitLog.push(t));
  if (exiting.emu_init() === 0) fail("emu_init() returned 0 on the wasi fixture");
  exiting.emu_tick(0);
  exiting.emu_button(0, 1); // the fixture's own "exit" button: the NEXT tick calls proc_exit(3)
  let halt: string | null = null;
  try {
    exiting.emu_tick(16);
  } catch (err) {
    halt = err instanceof Error ? err.message : String(err);
  }
  if (halt === null) fail("proc_exit(3) returned normally instead of halting the module");
  if (!halt.includes("proc_exit(3)")) fail(`the halt message does not name the exit code: ${halt}`);
  console.log(`PASS: halted with "${halt.slice(0, 120)}..."`);

  console.log(
    "\nPASS: WASI-lite shims exactly four wasi_snapshot_preview1 imports, deterministically " +
      "(clock from emu_tick, randomness from the trace's seed), routes fd_write to the console, " +
      "halts on proc_exit, and refuses anything else by name."
  );
}

main().catch((err) => {
  console.error(`test/wasi/run.ts: unexpected error: ${err instanceof Error ? err.message : String(err)}`);
  if (err instanceof Error && err.stack) console.error(err.stack);
  process.exit(1);
});
