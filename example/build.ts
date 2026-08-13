// Compiles example/firmware/main.c to wasm32-freestanding with `zig cc`,
// writing the result to wasm/dist/emu.wasm - the exact path server.ts
// watches and serves. This is a real invocation of the same kind of build
// step your own firmware needs: zig (or any C-to-wasm32-freestanding
// toolchain) is a BINARY this script invokes, never a language this repo
// is written in. See AGENTS.md's "TypeScript only" rule.
//
// One command, per the README's promise: `bun run example/build.ts`.
//
// Toolchain notes, so your own firmware's build script doesn't have to
// rediscover these the hard way:
//
//   - `-Wl,--import-symbols` (a zig/lld wasm-specific flag, reachable
//     through -Wl, from the `cc` frontend) leaves undefined externs
//     (js_log, and any math function you use but don't define) as wasm
//     imports instead of a hard link error. `-Wl,--allow-undefined`,
//     which sounds like the right flag, is rejected by zig cc outright.
//   - `-Wl,--export-dynamic` ("export everything with default
//     visibility") is flaky for wasm32-freestanding on the zig/lld
//     versions this was tested against: it can silently fail to export
//     what you expect. One `-Wl,--export=<name>` per ABI symbol below is
//     deterministic instead: verified by inspecting the built module with
//     WebAssembly.Module.exports() in Chrome devtools if you ever need to
//     double check.
//   - The freestanding wasm32 target ships the C standard's REQUIRED
//     freestanding headers (stdint.h, stdbool.h, stddef.h, stdarg.h) but
//     NOT the hosted-only ones (stdlib.h, stdio.h, math.h). This example
//     firmware avoids all three, so it needs no shim headers at all. If
//     your firmware includes any of those, you'll need to provide a
//     stand-in header on your own include path - see docs/abi.md for
//     the shape of one.
import { existsSync, mkdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, ".."); // repo root
const SRC = join(ROOT, "example", "firmware", "main.c");
const ABI_DIR = join(ROOT, "wasm");
const DIST = join(ABI_DIR, "dist");
const OUT = join(DIST, "emu.wasm");

const ZIG = process.env.ZIG_EXE ?? "zig";

// Exactly the ABI symbols this example firmware implements. Deliberately
// NOT the full emu_abi.h list: apps and sound are optional, and this
// firmware declares neither (see main.c's header comment). Exporting a
// symbol that isn't implemented is a link error, which is the point: a
// forgotten export fails loudly here, not silently at runtime in the page.
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

if (!existsSync(SRC)) {
  console.error(`source not found: ${SRC}`);
  process.exit(1);
}

mkdirSync(DIST, { recursive: true });

const args = [
  "cc",
  "-target", "wasm32-freestanding",
  "-O2",
  "-nostdlib",
  "-Wl,--no-entry",
  "-Wl,--import-symbols",
  ...EMU_EXPORTS.map((name) => `-Wl,--export=${name}`),
  "-I", ABI_DIR, // emu_abi.h
  SRC,
  "-o", OUT,
];

console.log(`${ZIG} ${args.join(" ")}`);
const result = Bun.spawnSync([ZIG, ...args], { stdout: "inherit", stderr: "inherit" });

if (!result.success) {
  console.error(`zig cc exited ${result.exitCode}`);
  console.error(`(zig not found? set ZIG_EXE to its path, or install it: https://ziglang.org/download/)`);
  process.exit(result.exitCode ?? 1);
}

const size = statSync(OUT).size;
console.log(`built ${OUT} (${size} bytes)`);
