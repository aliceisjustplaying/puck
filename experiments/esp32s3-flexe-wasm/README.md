# flexe WebAssembly feasibility probe

This is throwaway experiment code. It answers one question: can the pinned
flexe interpreter execute real Xtensa instructions after being compiled to
WebAssembly with the toolchain already used by Puck?

The answer is yes. At flexe commit
`34ea9eb6eef921b59a55e6a435c7fc55c5727835`, the interpreter and memory
implementation compile with Zig 0.16.0 as `wasm32-freestanding` after applying
a small hosted-C compatibility patch. A six-byte fixture executes `movi a3,
40` and `addi a3, a3, 2`. Native, WASI, and freestanding builds all return 42
from architectural register `a3`. The freestanding module is loaded by Puck's
real `src/wasm.ts` `instantiate()` function in the executable test.

The dynamic runner also executes actual functions extracted from current
ESP32-S3 ELFs at their original PCs. A sparse runner parses all `PT_LOAD`
segments from the real TinyDraw gate-harness ELF, loads 625 pages, starts at
its ELF entry point, and reaches a deterministic unloaded-ROM stop. Both paths
return the visible register file, PC, step count, and stop reason through a
versioned record.

This does not demonstrate ESP32-S3 support, LX7 or PIE instructions, a browser
page, timing, caches, dual-core scheduling, or an ESP-IDF boot. It proves that
flexe's direct interpreter can cross Puck's current WebAssembly loader boundary
without expanding WASI-lite.

## Run it

Requirements: Bun, Git, and Zig. The first command needs network access.

```text
bun run experiments/esp32s3-flexe-wasm/fetch.ts
bun run experiments/esp32s3-flexe-wasm/test.ts
bun run experiments/esp32s3-flexe-wasm/isa-inventory.ts
```

`FLEXE_SOURCE` can point at an existing clean checkout. It must be at the exact
commit and every file in the dependency closure must match its recorded SHA-256.
`ZIG_EXE` can select another Zig executable. Generated binaries live in ignored
`dist/` and include the upstream MIT license.

The ISA inventory additionally needs Espressif's
`xtensa-esp32s3-elf-objdump` and the two named TinyDraw ELFs below. Override
their paths with `ESP32S3_OBJDUMP`, `TINYDRAW_ESP32S3_ELF`, and
`TINYDRAW_ESP32S3_FIXTURE_ELF`. The generated JSON stays in ignored `dist/`.

## ESP32-S3 ISA gap inventory

`isa-inventory.ts` validates the ELF format, Xtensa architecture, ESP32-S3
IRAM, flash, and DRAM address ranges, and the architecture-specific objdump
name before disassembling anything. Missing files, a generic or wrong-target
objdump, and non-ESP32-S3 ELFs are rejected. The report records every
objdump encoding and mnemonic pair, counts it, and compares its normalized
mnemonic to the exact pinned flexe decoder source. Special-register forms such
as `rsr.ccount` normalize to flexe's generic `rsr` decoder entry.

The current input is
`out/build/esp32-panel-probe/tinydraw_esp32.elf`, 5,567,916 bytes, SHA-256
`87d6a00ffdf18c9bcb7dd3742658b5a1786212f939f5cbafe1b82562a350f70f`.
The tool is GNU objdump 2.45 from Espressif crosstool-NG
`esp-15.2.0_20251204`, SHA-256
`90a91caa519b895bd457f4eb7c5fd6b14a9c64c0c7d946e78e7f332ea57d7466`.
The flexe decoder is `src/xtensa_disasm.c` at the pinned commit, SHA-256
`68f98a684b964dd36d778f755441242496f624f0ffbc68c789c7c25e2862f3d0`.

That ELF yields 64,262 objdump rows and 343 raw mnemonics. The pinned flexe
decoder surface has 319 normalized mnemonics. It covers 63,193 rows and 296
raw mnemonics; 1,069 rows and 47 raw mnemonics are gaps. The 47 gaps are 41
`ee.*` PIE mnemonics covering 349 rows, 689 undecodable `.byte` rows, plus
`ld.qr` (8), `lsip` (6), `s32nb` (1), `ssip` (8), and `st.qr` (8).

These are static surface counts. `objdump -d` linearly interprets executable
sections, including unreachable padding and literal pools, so the row ratio is
not execution coverage. The JSON retains first addresses, symbols, exact
encodings, and counts so each gap can be separated from false static decodes.
`esp32s3-isa-baseline.json` tracks every unsupported mnemonic and row count;
the integration test rejects any unreviewed ELF, toolchain, decoder, coverage,
gap, or first-fixture-instruction change.
Only factual disassembly rows and hashes are retained. No GNU or Espressif
source or binary is copied into the experiment.

The executable fixture is
`out/build/esp32-vector-v2-simd-probe/tinydraw_esp32.elf`, SHA-256
`2293fb3d35ba2f785e4dce5dfb35d2f33e452150167dc8d24f0e091cfa3e6d53`.
With `a4` nonzero, `tinydraw_stage_pixels_swapped_pie` executes flexe-supported
`entry`, `nop.n`, and `loopnez`, then reaches the first decoder gap at
`0x40377a54`: objdump encoding `830124`, `ee.vld.128.ip q0, a2, 16`. This is a
real named TinyDraw PIE kernel, not a linear decode from a literal pool.

## Dynamic ELF execution

`elf-fixture.ts` extracts contiguous function bytes directly from Espressif
objdump output and reverses each displayed encoding into target memory order.
`dynamic-runner-test.ts` writes those caller-supplied bytes into the module's
exported 4 KiB input buffer, then calls `flexe_wasm_run(pc, length, max_steps,
unsupported_offset, unsupported_encoding)` through Puck's unchanged real
`instantiate()` path. `flexe_wasm_run_data` additionally copies caller bytes
into an emulated source page and copies the destination page back to an
exported output buffer. Every fixture runs in a fresh WebAssembly instance.

The temporary flexe patch maps one 4 KiB code page at the supplied ESP32-S3
executable PC, including IRAM and flash ranges. It establishes a deterministic
call8 frame with stack pointer `0x3fcaffc0`, source `0x3fca1000`, destination
`0x3fca2000`, and count 1 for code-only runs. The
versioned 108-byte stop record contains reason, steps, start, current and return
PCs, unsupported instruction details, current stack pointer, and registers
`a0` through `a15`. Data runs map separate 4 KiB source and destination pages
at those S3-style addresses and derive the pixel count from the even input byte
length. This is a bounded experiment mapping, not a complete ESP32-S3 memory
map.

The scalar fixture is `tlsf_alloc_overhead` from the current panel-probe ELF,
at `0x403808f4`. Its seven bytes have SHA-256
`cebc5d75741ee728f371bf15e6f834d1cacd50ce35b264385313c30b542ee7b7` and
decode as `entry`, `movi.n`, `retw.n`. flexe executes all three, returns to the
synthetic caller, restores its stack, and exposes the return value 4 in caller
register `a10`. A separate fresh run capped at two instructions stops at
`0x403808f9` before `retw.n`, proving the bound is active.

The PIE fixture has code SHA-256
`f0503e09af131793fa0dfdf9077a9d433225c08962672d7f492f1496b15d1c75`.
flexe executes the supported `entry`, `nop.n`, and `loopnez`, then its
experiment-only instruction hook stops before `ee.vld.128.ip` at `0x40377a54`,
objdump encoding `830124`. The hook is configured by the host from the pinned
ISA inventory's exact offset and encoding. It is intentionally not presented
as an automatic LX7 decoder. This prevents flexe from silently treating the
colliding encoding as an LX6 MAC16 instruction.

The RGB565 fixture is the local
`stage_pixels_swapped_scalar_oracle` function from
`out/build/esp32-vector-v2-gate-harness/tinydraw_esp32.elf`, SHA-256
`51cc322381bce60347ca322506c411af17f6b73ef366f3e440d6fdf5c1d5a8e5`.
Its 41 code bytes start at `0x420d4e10` and have SHA-256
`a545acd197c5b75f0351256aa6a9c8a7028cb42f91e617c28317fa560d873877`.
The fixture executes loads, stores, shifts, byte combination, pointer updates,
and a zero-overhead loop over five pixels. Input bytes
`3412cdabff001ff8e007` become `1234abcd00fff81f07e0` after 43 instructions;
the output SHA-256 is
`6d007b52dcec2b7b879b7a749e164e7991fd49e44d05edd26b2a3675805b7581`.
Every mnemonic in this function is present in the pinned flexe decoder, and
the execution returns normally, so its first recoverable ISA gap is `null`.

The same run exports a bounded binary execution trace from the interpreter.
Its 24-byte version 1 header contains the ABI version, header and record sizes,
record count, capacity, and overflow flag. Each 24-byte record contains kind,
executing PC, guest address, value, width, and instruction encoding. Instruction
records carry PC, width, and encoding. Read and write records carry the issuing
PC, guest address, width, and value. Instruction widths are two or three bytes;
data widths are one, two, or four bytes. Instruction fetches are not classified
as data accesses.

The trace hook sits in flexe's real `mem_read8/16/32` and
`mem_write8/16/32` paths. The five-pixel run produces 53 records: 43
instructions, five 16-bit reads from `0x3fca1000` through `0x3fca1008`, and
five 16-bit writes to `0x3fca2000` through `0x3fca2008`. The test asserts the
complete interleaved PC, instruction, address, width, and value sequence. The
1,296-byte trace has SHA-256
`ae24fd0b6d4e84dcbbad7e393c0be39058e5a04b2386f099bde1e0127103b9b4`
and is written to ignored `dist/rgb565-execution-trace.bin`.

Capacity is fixed at 128 records. A separate 14-pixel run with three prefixed
`nop.n` instructions reaches capacity while issuing a 16-bit read. The runner
rolls the whole instruction back, retains the 127 records for 101 completed
instructions, and stops at the instruction boundary `0x420d4e24` with
`traceOverflow`. The overflowing read does not update registers or memory and
no partial instruction enters the trace. These records are execution facts
only; they contain no cycle counts or timing estimates.

Two boundary controls compare the visible general-register snapshot
against a max-step run at the same PC. Both an unsupported-instruction hook and
an instruction-record overflow preserve that snapshot and the committed trace
count; overflow keeps its explicit flag. A traced access with no page-table
mapping stops as `unmappedAccess` before flexe's slow/MMIO callback. The MMIO
fixture's callback counter remains zero, so peripheral side effects cannot
escape an instruction rollback. With no access hook installed, flexe's normal
slow/MMIO path is unchanged.

## TimingMachine replay experiment

`timing-replay-test.ts` decodes the 53-record binary trace again and turns
every instruction into an instruction fetch and every data record into a load
or store. It submits that exact single-core order to the ESP32-S3 pack's
unchanged `TimingMachine`. The generated
`dist/rgb565-timing-replay.json` exposes address resolution, physical backing,
cache emission, resource, cost provenance, and execution status for each trace
record.

The replay uses the gate-harness sdkconfig at SHA-256
`65cfb5deebc36666fb3247ec5bc91aaf9de2d9a8c2642eb1666ec5b3e485bb92`:
16 KiB, 8-way, 32-byte-line instruction cache and 32 KiB, 8-way,
64-byte-line data cache. IROM MMU entry 13 is mapped to flash physical page 0
only to exercise the flash, cache, and MSPI route. That physical page is an
experiment input, not an observed hardware MMU snapshot. The two 4 KiB runner
data pages are covered by one explicit internal-SRAM experiment region.

The replay resolves all 43 instruction fetches, five loads, and five stores.
It emits 44 instruction-cache hits, two line fills on MSPI, and ten SRAM bypass
events. There are 44 hit emissions because the three-byte instruction at
`0x420d4e1e` crosses the 32-byte cache-line boundary and touches both lines.
The per-record evidence SHA-256 is
`33f124d74e42944bb6901970c6c1cf674b92f5b78a579bc82963b6b33edc2462`.

The timing profile supplies no adopted instruction-cache, line-fill, or SRAM
cycle costs. Every one of the 56 issued costs stays explicitly unknown, the
machine result is `blocked`, and total cycles are `null`. The replay establishes
the deterministic accounting path and the exact evidence still needed. It
does not estimate latency or make a cycle-accuracy claim.

`esp32s3-dynamic-baseline.json` pins all three ELF hashes, extracted-code and
staging-output and trace hashes, patch hashes, objdump hash, module hash, stop
results, access counts, and overflow result. The detailed generated record and
toolchain provenance live in ignored `dist/dynamic-execution.json`.
`esp32s3-timing-replay-baseline.json` separately pins the replay configuration,
source hashes, classification counts, null total, and per-record evidence hash.

## Sparse full ELF execution

`elf-image.ts` strictly accepts 32-bit little-endian Xtensa executable images
and validates every `PT_LOAD` file range, 32-bit memory range, alignment, and
entry-point permission. `full-elf-runner.ts` expands those segments into
sorted 4 KiB pages, zero-fills `p_memsz - p_filesz`, merges overlapping load
segments, and preserves the union of their ELF permissions. The module clears
flexe's default page table before loading the image, so memory that the ELF did
not declare is absent. It does not supply ROM, MMIO, flash-controller, or
peripheral behavior.

The gate-harness image is 21,598,616 bytes with SHA-256
`51cc322381bce60347ca322506c411af17f6b73ef366f3e440d6fdf5c1d5a8e5`.
Its eight load segments become 625 sparse pages. Execution begins at its ELF
entry `0x40375c9c`, `call_start_cpu0`. flexe executes `entry`, `l32r`,
`wsr.vecbase`, `movi.n`, `l32r`, and `callx8`, then stops before fetching the
undeclared ESP32-S3 ROM target `0x4000057c`. The result is `unloadedPage`, six
executed instructions, and a six-PC trace. This is the first honest boundary,
not a boot claim.

Full-image runs accept at most 768 pages, 2,048 caller-identified unsupported
instruction markers, and 256 executed instructions. The trace contains one PC
per successfully executed instruction. Oversized bounds, duplicate markers,
out-of-order pages, invalid permissions, and capacity overruns are refused.
An executable-permission miss and an unloaded page have distinct recoverable
stop reasons. `esp32s3-full-elf-baseline.json` pins the image, module, patch,
page count, bounded trace, unsupported-instruction refusal, and first stop,
including all six instruction encodings and the call-site register state.

## Minimal interpreter dependency closure

The successful build copies six upstream implementation files and headers:

- `src/xtensa.c`
- `src/xtensa.h`
- `src/memory.c`
- `src/memory.h`
- `src/rom_stubs.h`
- `src/elf_symbols.h`

`rom_stubs.h` is needed only for its inline hook-bitmap test, and it pulls in
the forward declarations from `elf_symbols.h`. No JIT, JIT stub, loader,
peripheral model, ROM stub implementation, session layer, flexe OpenSSL,
pthread, socket, VFS, or file loader implementation is linked.
`PREDECODE_FLASH_MB=0` removes the optional large predecode allocation. The
patches add the probe entry point and compatibility boundary to a temporary
copy. No upstream source is vendored here.

The ISA inventory reads and hashes upstream `src/xtensa_disasm.c` as an
analysis input. It is not copied into the build closure or linked into either
probe.

## Loader result and remaining blockers

The stripped freestanding module is 41,765 bytes with Zig 0.16.0, SHA-256
`c96e17ac183fbcb37262579ee755623585e646816cfef52ff07c3f98b044aa49`.
It imports only `env.js_log` and exports `memory`, `flexe_wasm_probe`,
the code input and capacity functions, `flexe_wasm_run`, the data input, output,
and capacity functions, `flexe_wasm_run_data`, the instruction and memory trace
functions, and the bounded sparse ELF load, PC trace, refusal, and run
functions. Those names are audited before the tests pass the bytes to Puck's
real loader. It has no WASI imports, and Puck's loader surface is unchanged.

The WASI build remains as a comparison. Zig's WASI libc introduces six imports.
Puck supports `fd_write` and `proc_exit`, but correctly rejects `environ_get`,
`environ_sizes_get`, `fd_close`, and `fd_seek`. `test.ts` asserts that exact
boundary without weakening the loader.

The unmodified source does not compile for `wasm32-freestanding` because
`src/memory.h` includes `string.h`, which the freestanding target does not
provide. `freestanding-blocker.ts` executes the raw upstream compile and
asserts the exact diagnostic. `0002-add-freestanding-shim.patch` supplies:

- local `memcpy` and `memset` loops;
- a fixed 20 MiB bump allocator for `calloc`, with `free` as a no-op;
- an empty environment that disables flexe's debug constructor settings;
- raw format-string logging through Puck's existing `env.js_log` import;
- WebAssembly-backed floating-point helpers for the LX6 FPU instructions;
- a trapping `abort` implementation.

The fixed heap and bounded sparse page pool make the module's minimum memory
385 WebAssembly pages, about 24.06 MiB. It is enough for this pinned
`mem_create()` layout and 768 ELF pages, and is not a production ownership
model. A real backend should let the host size and own the regions, replace
no-op `free`, and give diagnostic logging structured arguments.

That is a bounded portability patch around the core. The bigger project risk
remains architectural: this commit models ESP32 LX6 addresses and instructions,
not the ESP32-S3 LX7, PIE extension, memory map, caches, or timing.

## License

flexe is MIT licensed, copyright 2026 Lev Kropp. `LICENSE.flexe` is the exact
license from the pinned commit. The build copies it beside the generated module.
