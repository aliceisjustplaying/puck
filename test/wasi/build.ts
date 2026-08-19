// Compiles the two WASI-lite fixture firmwares (test/wasi/firmware/) to
// wasm32-freestanding, into test/wasi/dist/. Same toolchain invocation and
// same retry loop as test/regression/build.ts and example/build.ts: zig cc
// crashes in its own linker roughly one run in three on this toolchain
// (AGENTS.md), clean on immediate retry.
//
// No -I for wasm/: these two fixtures deliberately do not include
// emu_abi.h, so that what they compile against is only "a C compiler and a
// target", the same position an external app's own repository is in. No
// -Wl,--export= flags either: both fixtures export the ABI from their own
// source with __attribute__((export_name(...))), which keeps zig cc off the
// linker path that crashes deterministically under a nested bun process
// (see test/fixtures/external-app/README.md for the measurement).
//
// Run directly (`bun run test/wasi/build.ts`) or via test/wasi/run.ts,
// which calls buildWasiFixture() per module.
import { existsSync, mkdirSync, statSync } from "node:fs";
import { join } from "node:path";

const SRC_DIR = join(import.meta.dir, "firmware");
const DIST = join(import.meta.dir, "dist");

const ZIG = process.env.ZIG_EXE ?? "zig";


const MAX_ATTEMPTS = 5;
const RETRY_PAUSE_MS = 300;
const ATTEMPT_TIMEOUT_MS = 120_000;

// name: the .c file's stem under firmware/, and the .wasm's stem under
// dist/. Throws (zig's own stderr already printed) rather than returning a
// flag: a build failure means the test cannot run at all, which is a
// different thing from the test running and reporting a failure.
export function buildWasiFixture(name: string): string {
  const src = join(SRC_DIR, `${name}.c`);
  if (!existsSync(src)) throw new Error(`source not found: ${src}`);
  mkdirSync(DIST, { recursive: true });
  const out = join(DIST, `${name}.wasm`);

  const args = [
    "cc",
    "-target",
    "wasm32-freestanding",
    "-O2",
    "-nostdlib",
    "-Wl,--no-entry",
    "-Wl,--import-symbols",
    src,
    "-o",
    out,
  ];

  let lastError: unknown;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    let result: ReturnType<typeof Bun.spawnSync>;
    try {
      result = Bun.spawnSync([ZIG, ...args], { stdout: "inherit", stderr: "inherit", timeout: ATTEMPT_TIMEOUT_MS });
    } catch (err) {
      throw new Error(
        `could not run "${ZIG}" building ${name}: ${err instanceof Error ? err.message : String(err)} ` +
          `(zig not found? set ZIG_EXE to its path)`
      );
    }
    if (result.success) return out;
    lastError = new Error(`zig cc exited ${result.exitCode} building ${name}`);
    if (attempt < MAX_ATTEMPTS) {
      console.warn(`zig cc exited ${result.exitCode} building ${name} (attempt ${attempt}/${MAX_ATTEMPTS}), retrying...`);
      Bun.sleepSync(RETRY_PAUSE_MS);
    }
  }
  throw lastError;
}

if (import.meta.main) {
  for (const name of ["probe", "unsupported"]) {
    const out = buildWasiFixture(name);
    console.log(`built ${out} (${statSync(out).size} bytes)`);
  }
}
