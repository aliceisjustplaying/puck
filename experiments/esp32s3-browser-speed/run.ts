// Runs the browser-speed probes under bun (JavaScriptCore wasm) and natively,
// using the real TinyDraw RGB565 scalar staging kernel extracted from the
// pinned gate-harness ELF. Prints one JSON report.
//
//   bun run experiments/esp32s3-browser-speed/build.ts
//   bun run experiments/esp32s3-browser-speed/run.ts

import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  DEFAULT_ESP32S3_OBJDUMP,
  DEFAULT_TINYDRAW_ESP32S3_STAGING_ELF,
  DEFAULT_TINYDRAW_ESP32S3_STAGING_SYMBOL
} from "../esp32s3-flexe-wasm/constants";
import { extractElfFunction } from "../esp32s3-flexe-wasm/elf-fixture";

// Pinned in the sibling experiment's README and dynamic baseline.
const EXPECTED_CODE_SHA256 = "a545acd197c5b75f0351256aa6a9c8a7028cb42f91e617c28317fa560d873877";
const PIXELS = 2048;

const here = import.meta.dir;
const dist = join(here, "dist");

export interface KernelFixture {
  pc: number;
  bytes: Uint8Array;
  codeSha256: string;
  elfSha256: string;
}

export function loadKernel(): KernelFixture {
  const extracted = extractElfFunction(
    DEFAULT_ESP32S3_OBJDUMP,
    DEFAULT_TINYDRAW_ESP32S3_STAGING_ELF,
    DEFAULT_TINYDRAW_ESP32S3_STAGING_SYMBOL
  );
  if (extracted.codeSha256 !== EXPECTED_CODE_SHA256) {
    throw new Error(`kernel bytes drifted: ${extracted.codeSha256}`);
  }
  return {
    pc: extracted.pc,
    bytes: extracted.bytes,
    codeSha256: extracted.codeSha256,
    elfSha256: extracted.elfSha256
  };
}

interface BenchExports {
  memory: WebAssembly.Memory;
  bench_input(): number;
  bench_input_capacity(): number;
  bench_dest(): number;
  bench_setup(pc: number, codeLength: number, pixels: number): number;
  bench_call_steps(): number;
  bench_run(budget: number): number;
}

interface JitExports {
  memory: WebAssembly.Memory;
  jit_setup(pixels: number): number;
  jit_run(iterations: number): number;
  jit_cycles_lo(): number;
  jit_cycles_hi(): number;
  jit_dest(): number;
}

function expectSwapped(destination: Uint8Array, pixels: number): void {
  for (let index = 0; index < pixels * 2; index += 2) {
    const low = (index * 31 + 7) & 0xff;
    const high = ((index + 1) * 31 + 7) & 0xff;
    if (destination[index] !== high || destination[index + 1] !== low) {
      throw new Error(`destination byte ${index} not swapped: ${destination[index]}, ${destination[index + 1]}`);
    }
  }
}

export interface ThroughputResult {
  perCallInstructions: number;
  executed: number;
  seconds: number;
  mips: number;
}

export async function benchInterpreter(
  moduleBytes: Uint8Array,
  kernel: KernelFixture,
  targetSeconds: number
): Promise<ThroughputResult> {
  const { instance } = await WebAssembly.instantiate(moduleBytes, {
    env: { js_log: () => {} }
  });
  const exports = instance.exports as unknown as BenchExports;
  const memory = new Uint8Array(exports.memory.buffer);
  if (kernel.bytes.length > exports.bench_input_capacity()) throw new Error("kernel too large");
  memory.set(kernel.bytes, exports.bench_input());
  const setup = exports.bench_setup(kernel.pc, kernel.bytes.length, PIXELS);
  if (setup !== 0) throw new Error(`bench_setup failed: ${setup}`);
  const perCall = exports.bench_call_steps();
  if (perCall === 0) throw new Error("bench_call_steps failed");

  // Correctness: one full call must byte-swap the source pattern.
  exports.bench_run(perCall);
  expectSwapped(new Uint8Array(exports.memory.buffer, exports.bench_dest(), PIXELS * 2), PIXELS);

  // Calibrate a budget for the target duration, then measure.
  const probe = 4 << 20;
  const probeStart = performance.now();
  if (exports.bench_run(probe) !== probe) throw new Error("probe run stopped early");
  const probeSeconds = (performance.now() - probeStart) / 1000;
  const budget = Math.min(0x7fffffff, Math.round((probe / probeSeconds) * targetSeconds));
  const start = performance.now();
  const executed = exports.bench_run(budget);
  const seconds = (performance.now() - start) / 1000;
  if (executed !== budget) throw new Error(`run stopped early: ${executed} of ${budget}`);
  return { perCallInstructions: perCall, executed, seconds, mips: executed / seconds / 1e6 };
}

export interface JitResult {
  emulatedInstructions: number;
  seconds: number;
  emulatedMips: number;
  modeledCycles: number;
}

export async function benchJitCeiling(
  moduleBytes: Uint8Array,
  targetSeconds: number
): Promise<JitResult> {
  const { instance } = await WebAssembly.instantiate(moduleBytes, {});
  const exports = instance.exports as unknown as JitExports;
  if (exports.jit_setup(PIXELS) !== 0) throw new Error("jit_setup failed");
  const perCall = 8 * PIXELS + 3;

  const check = exports.jit_run(1);
  const destination = new Uint8Array(exports.memory.buffer, exports.jit_dest(), PIXELS * 2);
  expectSwapped(destination, PIXELS);
  if (check === 0) throw new Error("jit_run returned zero checksum");

  const probeIterations = 2000;
  const probeStart = performance.now();
  exports.jit_run(probeIterations);
  const probeSeconds = (performance.now() - probeStart) / 1000;
  const iterations = Math.max(1, Math.round((probeIterations / probeSeconds) * targetSeconds));
  if (exports.jit_setup(PIXELS) !== 0) throw new Error("jit_setup failed");
  const start = performance.now();
  exports.jit_run(iterations);
  const seconds = (performance.now() - start) / 1000;
  const modeledCycles = exports.jit_cycles_hi() * 4294967296 + exports.jit_cycles_lo();
  const emulated = iterations * perCall;
  return {
    emulatedInstructions: emulated,
    seconds,
    emulatedMips: emulated / seconds / 1e6,
    modeledCycles
  };
}

async function runNative(binary: string, args: string[]): Promise<Record<string, number>> {
  const process = Bun.spawnSync([binary, ...args]);
  if (process.exitCode !== 0) {
    throw new Error(`${binary} failed: ${process.stderr.toString()}`);
  }
  return JSON.parse(process.stdout.toString());
}

if (import.meta.main) {
  const kernel = loadKernel();
  const benchWasm = new Uint8Array(readFileSync(join(dist, "bench-freestanding.wasm")));
  const jitWasm = new Uint8Array(readFileSync(join(dist, "jit-ceiling.wasm")));

  const codeFile = join(dist, "kernel-bytes.bin");
  await Bun.write(codeFile, kernel.bytes);

  const report = {
    kernel: {
      symbol: DEFAULT_TINYDRAW_ESP32S3_STAGING_SYMBOL,
      pc: `0x${kernel.pc.toString(16)}`,
      codeSha256: kernel.codeSha256,
      elfSha256: kernel.elfSha256,
      pixelsPerCall: PIXELS
    },
    interpreterNative: await runNative(join(dist, "bench-native"), [
      codeFile,
      kernel.pc.toString(16),
      String(PIXELS),
      String(512 << 20)
    ]),
    interpreterBunWasm: await benchInterpreter(benchWasm, kernel, 2.5),
    jitCeilingNative: await runNative(join(dist, "jit-native"), [String(PIXELS), String(120000)]),
    jitCeilingBunWasm: await benchJitCeiling(jitWasm, 2.5)
  };
  console.log(JSON.stringify(report, null, 2));
}
