// Runs the same two throughput probes inside real Chrome (V8), plus a
// WebAssembly compile/instantiate cost measurement at JIT-block granularity.
//
//   bun run experiments/esp32s3-browser-speed/build.ts
//   bun run experiments/esp32s3-browser-speed/browser.ts
//
// Chrome resolution follows scripts/verify.ts: CHROME_PATH, then the usual
// install locations.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import puppeteer from "puppeteer-core";
import { loadKernel } from "./run";

const here = import.meta.dir;
const dist = join(here, "dist");

function findChrome(): string {
  const candidates = [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium"
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  throw new Error("no local Chrome found; set CHROME_PATH");
}

const CHROME = process.env.CHROME_PATH || findChrome();
const PIXELS = 2048;

function toBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64");
}

const kernel = loadKernel();
const payload = {
  benchB64: toBase64(new Uint8Array(readFileSync(join(dist, "bench-freestanding.wasm")))),
  jitB64: toBase64(new Uint8Array(readFileSync(join(dist, "jit-ceiling.wasm")))),
  tinyB64: toBase64(new Uint8Array(readFileSync(join(dist, "tiny-block.wasm")))),
  kernelB64: toBase64(kernel.bytes),
  kernelPc: kernel.pc,
  pixels: PIXELS,
  targetSeconds: 2.5
};

const browser = await puppeteer.launch({ executablePath: CHROME, headless: true });
try {
  const page = await browser.newPage();
  const result = await page.evaluate(async (input) => {
    const decode = (b64: string): Uint8Array<ArrayBuffer> => {
      const raw = atob(b64);
      const bytes = new Uint8Array(new ArrayBuffer(raw.length));
      for (let index = 0; index < raw.length; index++) bytes[index] = raw.charCodeAt(index);
      return bytes;
    };
    const benchBytes = decode(input.benchB64);
    const jitBytes = decode(input.jitB64);
    const tinyBytes = decode(input.tinyB64);
    const kernelBytes = decode(input.kernelB64);

    const expectSwapped = (destination: Uint8Array, pixels: number): void => {
      for (let index = 0; index < pixels * 2; index += 2) {
        const low = (index * 31 + 7) & 0xff;
        const high = ((index + 1) * 31 + 7) & 0xff;
        if (destination[index] !== high || destination[index + 1] !== low) {
          throw new Error(`destination byte ${index} not swapped`);
        }
      }
    };

    // Interpreter probe.
    const bench = await WebAssembly.instantiate(benchBytes, { env: { js_log: () => {} } });
    const b = bench.instance.exports as Record<string, CallableFunction> & {
      memory: WebAssembly.Memory;
    };
    new Uint8Array(b.memory.buffer).set(kernelBytes, b.bench_input() as number);
    if (b.bench_setup(input.kernelPc, kernelBytes.length, input.pixels) !== 0) {
      throw new Error("bench_setup failed");
    }
    const perCall = b.bench_call_steps() as number;
    if (perCall === 0) throw new Error("bench_call_steps failed");
    b.bench_run(perCall);
    expectSwapped(
      new Uint8Array(b.memory.buffer, b.bench_dest() as number, input.pixels * 2),
      input.pixels
    );
    const probe = 4 << 20;
    let start = performance.now();
    if (b.bench_run(probe) !== probe) throw new Error("probe run stopped early");
    const probeSeconds = (performance.now() - start) / 1000;
    const budget = Math.min(0x7fffffff, Math.round((probe / probeSeconds) * input.targetSeconds));
    start = performance.now();
    const executed = b.bench_run(budget) as number;
    const interpreterSeconds = (performance.now() - start) / 1000;
    if (executed !== budget) throw new Error("run stopped early");

    // JIT-ceiling probe.
    const jit = await WebAssembly.instantiate(jitBytes, {});
    const j = jit.instance.exports as Record<string, CallableFunction> & {
      memory: WebAssembly.Memory;
    };
    if (j.jit_setup(input.pixels) !== 0) throw new Error("jit_setup failed");
    j.jit_run(1);
    expectSwapped(
      new Uint8Array(j.memory.buffer, j.jit_dest() as number, input.pixels * 2),
      input.pixels
    );
    const probeIterations = 2000;
    start = performance.now();
    j.jit_run(probeIterations);
    const jitProbeSeconds = (performance.now() - start) / 1000;
    const iterations = Math.max(1, Math.round((probeIterations / jitProbeSeconds) * input.targetSeconds));
    if (j.jit_setup(input.pixels) !== 0) throw new Error("jit_setup failed");
    start = performance.now();
    j.jit_run(iterations);
    const jitSeconds = (performance.now() - start) / 1000;
    const perIteration = 8 * input.pixels + 3;

    // Compile and instantiate cost at JIT-block granularity.
    const compileSamples: number[] = [];
    const instantiateSamples: number[] = [];
    let tinyModule = new WebAssembly.Module(tinyBytes);
    for (let index = 0; index < 300; index++) {
      const compileStart = performance.now();
      tinyModule = new WebAssembly.Module(tinyBytes);
      compileSamples.push(performance.now() - compileStart);
      const instantiateStart = performance.now();
      void new WebAssembly.Instance(tinyModule, {});
      instantiateSamples.push(performance.now() - instantiateStart);
    }
    compileSamples.sort((left, right) => left - right);
    instantiateSamples.sort((left, right) => left - right);
    const median = (samples: number[]): number => samples[Math.floor(samples.length / 2)];

    const bigCompileStart = performance.now();
    void new WebAssembly.Module(benchBytes);
    const bigCompileMs = performance.now() - bigCompileStart;

    return {
      interpreter: {
        perCallInstructions: perCall,
        executed,
        seconds: interpreterSeconds,
        mips: executed / interpreterSeconds / 1e6
      },
      jitCeiling: {
        emulatedInstructions: iterations * perIteration,
        seconds: jitSeconds,
        emulatedMips: (iterations * perIteration) / jitSeconds / 1e6
      },
      moduleCost: {
        tinyBlockBytes: tinyBytes.length,
        compileMedianMs: median(compileSamples),
        instantiateMedianMs: median(instantiateSamples),
        benchModuleBytes: benchBytes.length,
        benchModuleCompileMs: bigCompileMs
      }
    };
  }, payload);

  console.log(
    JSON.stringify(
      {
        chrome: await browser.version(),
        kernel: { pc: `0x${kernel.pc.toString(16)}`, codeSha256: kernel.codeSha256 },
        ...result
      },
      null,
      2
    )
  );
} finally {
  await browser.close();
}
