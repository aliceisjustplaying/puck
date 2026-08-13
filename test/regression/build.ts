// Compiles test/regression/firmware/fixture.c to wasm32-freestanding,
// twice: once plain (the "v1"/baseline build) and once with
// -DREGRESS_CHANGED (the "v2"/changed build, one draw call different - see
// fixture.c's header comment). Mirrors example/build.ts's and
// test/hostile/build.ts's toolchain invocation and retry logic exactly:
// zig cc segfaults roughly one attempt in four on this machine under cache
// contention, clean on immediate retry (see AGENTS.md's toolchain notes).
//
// Run directly (`bun run test/regression/build.ts`, builds both) or via
// test/regression/run.ts, which calls buildRegressionFixture() per build.
import { existsSync, mkdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..", "..");
const SRC = join(import.meta.dir, "firmware", "fixture.c");
const ABI_DIR = join(ROOT, "wasm");
const DIST = join(import.meta.dir, "dist");

const ZIG = process.env.ZIG_EXE ?? "zig";

// Exactly what fixture.c implements - deliberately a smaller set than
// example/build.ts's EMU_EXPORTS (no apps, no sound, and this fixture
// isn't meant to be read as a worked example).
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

export interface FixtureBuild {
  name: string;
  wasmPath: string;
}

// name: what to call the output .wasm (no extension). changed: whether to
// compile with -DREGRESS_CHANGED, selecting fixture.c's alternate flip
// colour. Throws (with zig's own stderr already printed) rather than
// returning a pass/fail flag: a build failure here means the test itself
// cannot run, categorically different from the regression check correctly
// reporting a real divergence between two successful builds.
export function buildRegressionFixture(name: string, changed: boolean): FixtureBuild {
  if (!existsSync(SRC)) throw new Error(`source not found: ${SRC}`);
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
    ...(changed ? ["-DREGRESS_CHANGED"] : []),
    "-I",
    ABI_DIR,
    SRC,
    "-o",
    out,
  ];

  const MAX_ATTEMPTS = 5; // zig cc's own cache-contention flakiness, see AGENTS.md
  let lastError: unknown;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    let result: ReturnType<typeof Bun.spawnSync>;
    try {
      result = Bun.spawnSync([ZIG, ...args], { stdout: "inherit", stderr: "inherit" });
    } catch (err) {
      throw new Error(
        `could not run "${ZIG}" building ${name}: ${err instanceof Error ? err.message : String(err)} ` +
          `(zig not found? set ZIG_EXE to its path)`
      );
    }
    if (result.success) return { name, wasmPath: out };
    lastError = new Error(`zig cc exited ${result.exitCode} building ${name}`);
    if (attempt < MAX_ATTEMPTS) {
      console.warn(`zig cc exited ${result.exitCode} building ${name} (attempt ${attempt}/${MAX_ATTEMPTS}), retrying...`);
      Bun.sleepSync(300); // a beat before retrying: documented as cache contention, not a code bug
    }
  }
  throw lastError;
}

// Runnable standalone: `bun run test/regression/build.ts` builds both
// fixtures and reports sizes, without running any comparison.
if (import.meta.main) {
  for (const [name, changed] of [["regress_v1", false], ["regress_v2", true]] as const) {
    const { wasmPath } = buildRegressionFixture(name, changed);
    console.log(`built ${wasmPath} (${statSync(wasmPath).size} bytes)`);
  }
}
