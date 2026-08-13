// Compiles every hostile firmware under test/hostile/firmware/*.c to
// wasm32-freestanding, one .wasm each, into test/hostile/dist/ (gitignored,
// same as wasm/dist/ - see .gitignore). Mirrors example/build.ts's toolchain
// invocation exactly (same flags, same reasoning; see that file's header
// comment for why each flag is there): the point of this suite is that
// these are REAL compiled modules driven through the REAL dev server, not
// TypeScript stand-ins for what a hostile module might do.
//
// Run directly (`bun run test/hostile/build.ts`) or via test/hostile/run.ts,
// which calls buildHostileFirmware() per case before driving it.
import { existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { join, resolve, basename } from "node:path";

const ROOT = resolve(import.meta.dir, "..", ".."); // repo root
const FIRMWARE_DIR = join(import.meta.dir, "firmware");
const ABI_DIR = join(ROOT, "wasm");
const DIST = join(import.meta.dir, "dist");

const ZIG = process.env.ZIG_EXE ?? "zig";

// The base ABI every hostile firmware implements (identical set to
// example/build.ts's EMU_EXPORTS). One case (audio_bad_buffer) also
// declares the optional sound exports; see SOUND_EXPORTS below.
const BASE_EXPORTS = [
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
const SOUND_EXPORTS = ["emu_sound_sample_rate", "emu_sound_play_seq", "emu_sound_stop_seq", "emu_sound_buffer", "emu_sound_frames"];

// Firmware files whose export list includes the optional sound ABI. Every
// other .c file in firmware/ gets BASE_EXPORTS only.
const SOUND_CASES = new Set(["audio_bad_buffer"]);

export interface BuildResult {
  name: string;
  wasmPath: string;
}

function exportsFor(name: string): string[] {
  return SOUND_CASES.has(name) ? [...BASE_EXPORTS, ...SOUND_EXPORTS] : BASE_EXPORTS;
}

// Compiles one firmware/<name>.c -> dist/<name>.wasm. Throws (with zig's
// own stderr already printed, per "inherit" below) rather than returning a
// pass/fail flag: a build failure here means the test suite itself cannot
// run, which is categorically different from a hostile firmware behaving
// hostilely at runtime, and must not be swallowed into a false pass.
export function buildHostileFirmware(name: string): BuildResult {
  const src = join(FIRMWARE_DIR, `${name}.c`);
  if (!existsSync(src)) throw new Error(`no such hostile firmware: ${src}`);
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
    ...exportsFor(name).map((n) => `-Wl,--export=${n}`),
    "-I",
    ABI_DIR,
    src,
    "-o",
    out,
  ];

  // zig cc on this machine is documented (AGENTS.md's toolchain notes,
  // docs/findings-first-adversarial-pass.md's "A note on the method") as
  // segfaulting roughly one attempt in four under cache contention, clean
  // on immediate retry -- a property of the local toolchain invocation,
  // unrelated to whether the source itself is correct. A real compile
  // error (bad C, a missing export) fails identically on every attempt, so
  // retrying costs a little time on the flaky case and changes nothing
  // about the outcome on a genuine one.
  const MAX_ATTEMPTS = 5;
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
      Bun.sleepSync(300); // a beat before retrying: the segfaults are documented as cache contention, not a code bug
    }
  }
  throw lastError;
}

export function listHostileFirmwareNames(): string[] {
  return readdirSync(FIRMWARE_DIR)
    .filter((f) => f.endsWith(".c"))
    .map((f) => basename(f, ".c"))
    .sort();
}

// Runnable standalone: `bun run test/hostile/build.ts` builds every case
// and reports sizes, without driving any of them through the browser.
if (import.meta.main) {
  for (const name of listHostileFirmwareNames()) {
    const { wasmPath } = buildHostileFirmware(name);
    console.log(`built ${wasmPath} (${statSync(wasmPath).size} bytes)`);
  }
}
