// Builds the throwaway browser-speed probes.
//
// Stages the pinned flexe checkout exactly the way the sibling experiment's
// build does (same SOURCE_FILES, same three patches), adds bench_probe.c,
// and compiles:
//   dist/bench-native            native interpreter probe (with main)
//   dist/bench-freestanding.wasm wasm32-freestanding interpreter probe
//   dist/jit-native              native JIT-ceiling probe (with main)
//   dist/jit-ceiling.wasm        wasm32-freestanding JIT-ceiling probe
//   dist/tiny-block.wasm         instantiate-cost specimen module
//
// Reuses the sibling experiment's pin verification, so a wrong or dirty
// flexe checkout is refused before anything compiles.

import { cpSync, copyFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { DEFAULT_FLEXE_SOURCE, SOURCE_FILES } from "../esp32s3-flexe-wasm/constants";
import { commandVersion, requireSuccess, run, verifySource } from "../esp32s3-flexe-wasm/lib";

const here = import.meta.dir;
const sibling = resolve(here, "../esp32s3-flexe-wasm");
const source = resolve(process.env.FLEXE_SOURCE ?? DEFAULT_FLEXE_SOURCE);
const output = resolve(join(here, "dist"));
const zig = process.env.ZIG_EXE ?? "zig";

verifySource(source);
console.log(`zig ${commandVersion(zig)}`);

const stage = mkdtempSync(join(tmpdir(), "puck-esp32s3-speed-"));
const cache = join(stage, "zig-cache");
const zigEnv = {
  ZIG_GLOBAL_CACHE_DIR: join(cache, "global"),
  ZIG_LOCAL_CACHE_DIR: join(cache, "local")
};

const benchExports = [
  "bench_input",
  "bench_input_capacity",
  "bench_dest",
  "bench_setup",
  "bench_call_steps",
  "bench_run"
];

const jitExports = ["jit_setup", "jit_run", "jit_cycles_lo", "jit_cycles_hi", "jit_dest"];

try {
  for (const relative of SOURCE_FILES) {
    const destination = join(stage, relative);
    mkdirSync(dirname(destination), { recursive: true });
    cpSync(join(source, relative), destination);
  }
  for (const patch of [
    join(sibling, "patches", "0001-add-wasi-probe.patch"),
    join(sibling, "patches", "0002-add-freestanding-shim.patch"),
    join(sibling, "patches", "0003-add-esp32s3-lx7-subset.patch")
  ]) {
    requireSuccess(run(["git", "apply", "--check", patch], stage));
    requireSuccess(run(["git", "apply", patch], stage));
  }
  copyFileSync(join(here, "bench_probe.c"), join(stage, "src", "bench_probe.c"));
  copyFileSync(join(here, "jit_ceiling.c"), join(stage, "src", "jit_ceiling.c"));
  copyFileSync(join(here, "tiny_block.c"), join(stage, "src", "tiny_block.c"));

  mkdirSync(output, { recursive: true });
  const common = [
    "cc",
    "-std=c17",
    "-O2",
    "-DPREDECODE_FLASH_MB=0",
    "-Isrc",
    "src/xtensa.c",
    "src/memory.c",
    "src/bench_probe.c"
  ];

  requireSuccess(
    run(
      [zig, ...common, "-DBENCH_NATIVE=1", "-lm", "-o", join(output, "bench-native")],
      stage,
      zigEnv
    )
  );
  requireSuccess(
    run(
      [
        zig,
        ...common,
        "src/wasm_compat.c",
        "-target",
        "wasm32-freestanding",
        "-ffreestanding",
        "-fno-builtin",
        "-Isrc/wasm_compat/include",
        "-Wl,--no-entry",
        ...benchExports.map((name) => `-Wl,--export=${name}`),
        "-Wl,--export-memory",
        "-Wl,--strip-all",
        "-o",
        join(output, "bench-freestanding.wasm")
      ],
      stage,
      zigEnv
    )
  );
  requireSuccess(
    run(
      [
        zig,
        "cc",
        "-std=c17",
        "-O2",
        "src/jit_ceiling.c",
        "-DBENCH_NATIVE=1",
        "-o",
        join(output, "jit-native")
      ],
      stage,
      zigEnv
    )
  );
  requireSuccess(
    run(
      [
        zig,
        "cc",
        "-std=c17",
        "-O2",
        "src/jit_ceiling.c",
        "-target",
        "wasm32-freestanding",
        "-ffreestanding",
        "-fno-builtin",
        "-Wl,--no-entry",
        ...jitExports.map((name) => `-Wl,--export=${name}`),
        "-Wl,--export-memory",
        "-Wl,--strip-all",
        "-o",
        join(output, "jit-ceiling.wasm")
      ],
      stage,
      zigEnv
    )
  );
  requireSuccess(
    run(
      [
        zig,
        "cc",
        "-std=c17",
        "-O2",
        "src/tiny_block.c",
        "-target",
        "wasm32-freestanding",
        "-ffreestanding",
        "-fno-builtin",
        "-Wl,--no-entry",
        "-Wl,--export=block",
        "-Wl,--strip-all",
        "-o",
        join(output, "tiny-block.wasm")
      ],
      stage,
      zigEnv
    )
  );
  copyFileSync(join(stage, "LICENSE"), join(output, "LICENSE.flexe"));
  console.log(output);
} finally {
  rmSync(stage, { recursive: true, force: true });
}
