// build.ts: compiles this pack's portable firmware (runtime_core.c,
// gfx_band.c, apps/demo.c) plus this directory's emu_shim.c to a single
// wasm32-freestanding module, the same approach the RP2350 sibling's
// wasm/build.ts documents in full (docs/decisions/0003-emulator-runs-the-
// real-apps.md). TypeScript, run with `bun run pack:esp32:build` from the
// repo root, never .js/.mjs (AGENTS.md: TypeScript only, build scripts
// included).
//
// --app <path-to-c-file>: swaps apps/demo.c for a different single C file
// implementing this pack's one app slot (added for the first cross-device
// port, apps/chrono/ports/esp32-s3-touch-amoled-18/chrono.c - see that
// directory's README.md). Additive only: the default with no --app is
// still exactly apps/demo.c, and runtime_core.c (this pack's runtime,
// never touched by a port) is unmodified either way - it declares `extern
// const app_t g_demoApp;` regardless of which .c file defines that symbol,
// so a replacement app file must define a symbol of that same name (see
// the chrono port's own header comment for why that is a wart worth
// naming, not hiding).
//
// This pack needs no shim/ directory at all, unlike the RP2350 sibling: its
// firmware sources (runtime_core.c, gfx_band.c, apps/demo.c, emu_shim.c)
// include nothing beyond app.h, gfx_band.h, runtime_core.h and emu_abi.h -
// no vendor display headers, no libc headers (no malloc, no printf, no
// math.h). See the sibling's build.ts header comment for the toolchain
// notes this file still relies on (why --import-symbols and not
// --allow-undefined, why one --export= per symbol and not
// --export-dynamic, why zig ships no stdlib.h/math.h/stdio.h for this
// target at all) - none of it needed re-discovering here, all of it still
// applies.
import { existsSync, mkdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const WASM_DIR = import.meta.dir; // packs/esp32-s3-touch-amoled-18/wasm
const DEVICE_ROOT = resolve(WASM_DIR, ".."); // packs/esp32-s3-touch-amoled-18/
const REPO_ROOT = resolve(DEVICE_ROOT, "..", ".."); // the puck repo root
const FIRMWARE = join(DEVICE_ROOT, "firmware");

// Exactly one module for the whole repo, wasm/dist/emu.wasm (server.ts,
// README): writing there rather than into a device-local dist/ is what
// makes `bun run pack:esp32:build && bun run dev` show this firmware, no
// wiring step in between.
const DIST = join(REPO_ROOT, "wasm", "dist");
const OUT = join(DIST, "emu.wasm");

// The ABI header lives once, at the repo root, so this pack's firmware
// cannot compile against a stale private fork of the contract.
const ABI_DIR = join(REPO_ROOT, "wasm");

// zig is a binary this script invokes, exactly like cmake or idf.py
// (AGENTS.md). No machine-specific default: PATH unless ZIG_EXE overrides.
const ZIG = process.env.ZIG_EXE ?? "zig";

// Every symbol this pack's firmware implements. Deliberately NOT the full
// emu_abi.h list: this pack declares no "apps" array and no sound, so
// emu_app_*/emu_sound_* are left unexported - exporting a symbol that is
// not implemented is a link error, which is the point (a forgotten export
// fails loudly here, not silently at runtime in the page).
const EMU_EXPORTS = [
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

// --app <path> overrides which single C file supplies this pack's one app
// slot (default: firmware/apps/demo.c). Resolved relative to cwd, same as
// any other path a person types on a command line - not relative to this
// script's own directory, which would be surprising for a flag whose whole
// point is pointing somewhere else in the tree (e.g.
// apps/chrono/ports/esp32-s3-touch-amoled-18/chrono.c).
function parseAppArg(argv: string[]): string {
  const defaultApp = join(FIRMWARE, "apps", "demo.c");
  const i = argv.indexOf("--app");
  if (i === -1) return defaultApp;
  const value = argv[i + 1];
  if (!value) {
    console.error("--app needs a path argument (a single .c file implementing this pack's app.h contract)");
    process.exit(1);
  }
  return resolve(process.cwd(), value);
}

const APP_SOURCE = parseAppArg(process.argv.slice(2));

const SOURCES = [
  join(WASM_DIR, "emu_shim.c"),
  join(FIRMWARE, "runtime", "runtime_core.c"),
  join(FIRMWARE, "runtime", "gfx_band.c"),
  APP_SOURCE,
];

// dirname(APP_SOURCE) is included too, and comes first, so a ported app
// living outside firmware/apps/ (e.g. under apps/<name>/ports/) can #include
// a private helper header of its own without needing one added by hand
// here; the chrono port doesn't need this today (it includes only app.h and
// gfx_band.h) but a later port might.
const INCLUDES = [
  dirname(APP_SOURCE),
  join(FIRMWARE, "runtime"),
  join(FIRMWARE, "apps"),
  ABI_DIR, // emu_abi.h, included bare from emu_shim.c
];

if (ZIG.includes("/") || ZIG.includes("\\")) {
  if (!existsSync(ZIG)) {
    console.error(`zig not found at ${ZIG} (set ZIG_EXE to override)`);
    process.exit(1);
  }
}
for (const src of SOURCES) {
  if (!existsSync(src)) {
    console.error(`source not found: ${src}`);
    process.exit(1);
  }
}

mkdirSync(DIST, { recursive: true });

const args = [
  "cc",
  "-target", "wasm32-freestanding",
  "-O2",
  "-nostdlib",
  "-Wl,--no-entry",
  "-Wl,--import-symbols", // undefined externs (js_log) become wasm imports
                           // instead of a hard link error
  ...EMU_EXPORTS.map((name) => `-Wl,--export=${name}`),
  ...INCLUDES.flatMap((dir) => ["-I", dir]),
  ...SOURCES,
  "-o", OUT,
];

console.log(`${ZIG} ${args.join(" ")}`);

// zig cc crashes inside its own linker roughly one run in three with this
// many -Wl,--export= flags (verified against this exact toolchain by the
// RP2350 sibling's build.ts): exit code 5, no diagnostic, and the very next
// attempt with identical arguments succeeds. Retried here, with a pause
// between attempts, for the same reason that file gives: the failure rate
// is far worse under concurrent contention, and the person most likely to
// hit this is running the command for the first time with no reason yet to
// believe the repository works.
const MAX_ATTEMPTS = 8;
const RETRY_PAUSE_MS = 400;

let result: ReturnType<typeof Bun.spawnSync>;
try {
  result = Bun.spawnSync([ZIG, ...args], { stdout: "inherit", stderr: "inherit" });
} catch (err) {
  console.error(`could not run "${ZIG}": ${err instanceof Error ? err.message : String(err)}`);
  console.error(`(zig not found? set ZIG_EXE to its path, or install it: https://ziglang.org/download/)`);
  process.exit(1);
}
for (let attempt = 2; !result.success && attempt <= MAX_ATTEMPTS; attempt++) {
  console.error(`zig cc exited ${result.exitCode}, retrying (${attempt}/${MAX_ATTEMPTS}) - see this file's header comment`);
  Bun.sleepSync(RETRY_PAUSE_MS);
  result = Bun.spawnSync([ZIG, ...args], { stdout: "inherit", stderr: "inherit" });
}

if (!result.success) {
  console.error(`zig cc exited ${result.exitCode} on all ${MAX_ATTEMPTS} attempts, so this is a real build failure`);
  process.exit(result.exitCode ?? 1);
}

const size = statSync(OUT).size;
console.log(`built ${OUT} (${size} bytes)`);
