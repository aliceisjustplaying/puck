import { join } from "node:path";

export const FLEXE_REPOSITORY = "https://github.com/levkropp/flexe.git";
export const FLEXE_COMMIT = "34ea9eb6eef921b59a55e6a435c7fc55c5727835";
export const DEFAULT_FLEXE_SOURCE = join("/private/tmp", `flexe-${FLEXE_COMMIT}`);
export const EXPECTED_RESULT = 42;
export const FLEXE_DISASSEMBLER_SHA256 =
  "68f98a684b964dd36d778f755441242496f624f0ffbc68c789c7c25e2862f3d0";

const TINYDRAW_ROOT = join(import.meta.dir, "../../../..");
export const DEFAULT_ESP32S3_OBJDUMP = process.env.ESP32S3_OBJDUMP ?? join(
  process.env.HOME ?? "/nonexistent",
  ".espressif/tools/xtensa-esp-elf/esp-15.2.0_20251204/xtensa-esp-elf/bin/xtensa-esp32s3-elf-objdump"
);
export const DEFAULT_TINYDRAW_ESP32S3_ELF = process.env.TINYDRAW_ESP32S3_ELF ?? join(
  TINYDRAW_ROOT,
  "out/build/esp32-panel-probe/tinydraw_esp32.elf"
);
export const DEFAULT_TINYDRAW_ESP32S3_FIXTURE_ELF = process.env.TINYDRAW_ESP32S3_FIXTURE_ELF ?? join(
  TINYDRAW_ROOT,
  "out/build/esp32-vector-v2-simd-probe/tinydraw_esp32.elf"
);
export const DEFAULT_TINYDRAW_ESP32S3_FIXTURE_SYMBOL = "tinydraw_stage_pixels_swapped_pie";
export const DEFAULT_TINYDRAW_ESP32S3_STAGING_ELF = process.env.TINYDRAW_ESP32S3_STAGING_ELF ?? join(
  TINYDRAW_ROOT,
  "out/build/esp32-vector-v2-gate-harness/tinydraw_esp32.elf"
);
export const DEFAULT_TINYDRAW_ESP32S3_FULL_ELF =
  process.env.TINYDRAW_ESP32S3_FULL_ELF ?? DEFAULT_TINYDRAW_ESP32S3_STAGING_ELF;
export const DEFAULT_TINYDRAW_ESP32S3_STAGING_SYMBOL =
  "_ZN8tinydraw5esp3212gate_harness12_GLOBAL__N_1L34stage_pixels_swapped_scalar_oracleEPKtPti";

export const SOURCE_HASHES = {
  "LICENSE": "de21f9882681b9d0861b19ae9c822732536d3c73f6e736957411534d7291a5ac",
  "src/elf_symbols.h": "b65c6a8ae1b14fe5c1d52448f280f1bed32d45cbd53fd8875d5514cb2e65e47a",
  "src/memory.c": "04fcb239a3a25a4796c67a1f900cda7dd62889e51733a9e213bce89698405757",
  "src/memory.h": "b79c09c2d0738b19858d93082f628d6714c9e1f0411e8ffbcd514ac939c0fe9f",
  "src/rom_stubs.h": "3b18edc0e077c5bead3de3db26ba30e0dc4b80ad8764d915a0bdd8a68ffeb48f",
  "src/xtensa.c": "3f4a25c85d88acdb79ebdddfaf87195d76761d4000b04d0b527e1c17eaf6d8c3",
  "src/xtensa.h": "03e0783787a589143b8b860ea3f58245030b436072efd2e462b78969d7963986"
} as const;

export const SOURCE_FILES = Object.keys(SOURCE_HASHES);

export const EXPECTED_WASI_IMPORTS = [
  "environ_get",
  "environ_sizes_get",
  "fd_close",
  "fd_seek",
  "fd_write",
  "proc_exit"
] as const;

export const PUCK_WASI_LITE_IMPORTS = ["clock_time_get", "fd_write", "proc_exit", "random_get"] as const;

export const EXPECTED_FREESTANDING_IMPORTS = ["env.js_log"] as const;
export const EXPECTED_FREESTANDING_EXPORTS = [
  "flexe_wasm_elf_begin",
  "flexe_wasm_elf_cache_state",
  "flexe_wasm_elf_rtc_mmio_state",
  "flexe_wasm_elf_regi2c_mmio_state",
  "flexe_wasm_elf_system_mmio_state",
  "flexe_wasm_elf_configure_rom",
  "flexe_wasm_elf_copy_page",
  "flexe_wasm_elf_load_page",
  "flexe_wasm_elf_memory_fault",
  "flexe_wasm_elf_memory_trace",
  "flexe_wasm_elf_memory_trace_bytes",
  "flexe_wasm_elf_memory_trace_capacity",
  "flexe_wasm_elf_page_capacity",
  "flexe_wasm_elf_page_input",
  "flexe_wasm_elf_rom_event_capacity",
  "flexe_wasm_elf_rom_event_count",
  "flexe_wasm_elf_rom_events",
  "flexe_wasm_elf_set_unsupported",
  "flexe_wasm_elf_trace",
  "flexe_wasm_elf_trace_capacity",
  "flexe_wasm_elf_trace_count",
  "flexe_wasm_elf_unsupported_capacity",
  "flexe_wasm_elf_unsupported_input",
  "flexe_wasm_data_capacity",
  "flexe_wasm_data_input",
  "flexe_wasm_data_output",
  "flexe_wasm_input",
  "flexe_wasm_input_capacity",
  "flexe_wasm_probe",
  "flexe_wasm_run",
  "flexe_wasm_run_auxiliary",
  "flexe_wasm_run_data",
  "flexe_wasm_trace",
  "flexe_wasm_trace_bytes",
  "flexe_wasm_trace_capacity",
  "flexe_wasm_run_elf",
  "memory"
] as const;
