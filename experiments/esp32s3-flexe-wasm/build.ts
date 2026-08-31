import { cpSync, copyFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { DEFAULT_FLEXE_SOURCE, SOURCE_FILES } from "./constants";
import { commandVersion, requireSuccess, run, verifySource } from "./lib";

const here = import.meta.dir;
const source = resolve(process.env.FLEXE_SOURCE ?? DEFAULT_FLEXE_SOURCE);
const output = resolve(process.env.FLEXE_WASM_DIST ?? join(here, "dist"));
const zig = process.env.ZIG_EXE ?? "zig";

verifySource(source);
console.log(`zig ${commandVersion(zig)}`);

const stage = mkdtempSync(join(tmpdir(), "puck-flexe-wasm-"));
const cache = join(stage, "zig-cache");
const zigEnv = {
  ZIG_GLOBAL_CACHE_DIR: join(cache, "global"),
  ZIG_LOCAL_CACHE_DIR: join(cache, "local")
};

try {
  for (const relative of SOURCE_FILES) {
    const destination = join(stage, relative);
    mkdirSync(dirname(destination), { recursive: true });
    cpSync(join(source, relative), destination);
  }

  const patches = [
    join(here, "patches", "0001-add-wasi-probe.patch"),
    join(here, "patches", "0002-add-freestanding-shim.patch")
  ];
  for (const patch of patches) {
    requireSuccess(run(["git", "apply", "--check", patch], stage));
    requireSuccess(run(["git", "apply", patch], stage));
  }

  mkdirSync(output, { recursive: true });
  const common = [
    "cc",
    "-std=c17",
    "-O2",
    "-DPREDECODE_FLASH_MB=0",
    "-Isrc",
    "src/xtensa.c",
    "src/memory.c",
    "src/wasm_probe.c"
  ];

  requireSuccess(
    run(
      [zig, ...common, "-DFLEXE_PROBE_NATIVE=1", "-lm", "-o", join(output, "flexe-probe-native")],
      stage,
      zigEnv
    )
  );
  requireSuccess(
    run(
      [
        zig,
        ...common,
        "-target",
        "wasm32-wasi",
        "-mexec-model=reactor",
        "-Wl,--export=flexe_wasm_probe",
        "-Wl,--export=flexe_wasm_input",
        "-Wl,--export=flexe_wasm_input_capacity",
        "-Wl,--export=flexe_wasm_run",
        "-Wl,--export=flexe_wasm_data_input",
        "-Wl,--export=flexe_wasm_data_output",
        "-Wl,--export=flexe_wasm_data_capacity",
        "-Wl,--export=flexe_wasm_run_data",
        "-Wl,--export=flexe_wasm_trace",
        "-Wl,--export=flexe_wasm_trace_bytes",
        "-Wl,--export=flexe_wasm_trace_capacity",
        "-Wl,--export=flexe_wasm_elf_begin",
        "-Wl,--export=flexe_wasm_elf_load_page",
        "-Wl,--export=flexe_wasm_elf_page_capacity",
        "-Wl,--export=flexe_wasm_elf_page_input",
        "-Wl,--export=flexe_wasm_elf_set_unsupported",
        "-Wl,--export=flexe_wasm_elf_trace",
        "-Wl,--export=flexe_wasm_elf_trace_capacity",
        "-Wl,--export=flexe_wasm_elf_trace_count",
        "-Wl,--export=flexe_wasm_elf_unsupported_capacity",
        "-Wl,--export=flexe_wasm_elf_unsupported_input",
        "-Wl,--export=flexe_wasm_run_elf",
        "-Wl,--export-memory",
        "-Wl,--strip-all",
        "-o",
        join(output, "flexe-probe.wasm")
      ],
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
        "-Wl,--export=flexe_wasm_probe",
        "-Wl,--export=flexe_wasm_input",
        "-Wl,--export=flexe_wasm_input_capacity",
        "-Wl,--export=flexe_wasm_run",
        "-Wl,--export=flexe_wasm_data_input",
        "-Wl,--export=flexe_wasm_data_output",
        "-Wl,--export=flexe_wasm_data_capacity",
        "-Wl,--export=flexe_wasm_run_data",
        "-Wl,--export=flexe_wasm_trace",
        "-Wl,--export=flexe_wasm_trace_bytes",
        "-Wl,--export=flexe_wasm_trace_capacity",
        "-Wl,--export=flexe_wasm_elf_begin",
        "-Wl,--export=flexe_wasm_elf_load_page",
        "-Wl,--export=flexe_wasm_elf_page_capacity",
        "-Wl,--export=flexe_wasm_elf_page_input",
        "-Wl,--export=flexe_wasm_elf_set_unsupported",
        "-Wl,--export=flexe_wasm_elf_trace",
        "-Wl,--export=flexe_wasm_elf_trace_capacity",
        "-Wl,--export=flexe_wasm_elf_trace_count",
        "-Wl,--export=flexe_wasm_elf_unsupported_capacity",
        "-Wl,--export=flexe_wasm_elf_unsupported_input",
        "-Wl,--export=flexe_wasm_run_elf",
        "-Wl,--export-memory",
        "-Wl,--strip-all",
        "-o",
        join(output, "flexe-probe-freestanding.wasm")
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
