// Compiles the two WASI-lite fixture firmwares (test/wasi/firmware/) to
// wasm32-freestanding, into test/wasi/dist/. Same toolchain invocation and
// same retry loop as test/regression/build.ts and example/build.ts: zig cc
// crashes in its own linker roughly one run in three on this toolchain
// (AGENTS.md), clean on immediate retry.
//
// No -I for wasm/: these two fixtures deliberately do not include
// emu_abi.h, so that what they compile against is only "a C compiler and a
// target", the same position an external app's own repository is in.
//
// Run directly (`bun run test/wasi/build.ts`) or via test/wasi/run.ts,
// which calls buildWasiFixture() per module.
import { existsSync, mkdirSync, statSync } from "node:fs";
import { join } from "node:path";

const SRC_DIR = join(import.meta.dir, "firmware");
const DIST = join(import.meta.dir, "dist");

const ZIG = process.env.ZIG_EXE ?? "zig";

// Both fixtures implement the same (small) export set: no apps, no sound,
// no vector sensor. Exporting a symbol a fixture does not implement is a
// link error, which is why this list is shared rather than per-fixture.
const EXPORTS = [
  "emu_device",
  "emu_init",
  "emu_tick",
  "emu_fb",
  "emu_push_count",
  "emu_push_x",
  "emu_push_y",
  "emu_push_w",
  "emu_push_h",
  "emu_touch",
  "emu_button",
  "emu_button_verdict",
  "emu_sensor_event",
];

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
    ...EXPORTS.map((n) => `-Wl,--export=${n}`),
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
