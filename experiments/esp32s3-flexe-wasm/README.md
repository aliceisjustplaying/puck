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
its ELF entry point, and reaches deterministic unloaded-ROM and unmapped-data
stops. Both paths
return the visible register file, PC, step count, and stop reason through a
versioned record.

This now demonstrates a bounded ESP32-S3 LX7 subset, including the real
TinyDraw PIE byte-swap kernel. It does not demonstrate complete LX7 or PIE
support, a browser page, timing, caches, dual-core scheduling, or an ESP-IDF
boot. The direct interpreter crosses Puck's current WebAssembly loader boundary
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
`TINYDRAW_ESP32S3_FIXTURE_ELF`. Dynamic staging and the pinned full-image
fixture can be selected independently with `TINYDRAW_ESP32S3_STAGING_ELF` and
`TINYDRAW_ESP32S3_FULL_ELF`. Generated JSON stays in ignored `dist/`.

## ESP32-S3 ISA gap inventory

`isa-inventory.ts` validates the ELF format, Xtensa architecture, ESP32-S3
IRAM, flash, and DRAM address ranges, and the architecture-specific objdump
name before disassembling anything. Missing files, a generic or wrong-target
objdump, and non-ESP32-S3 ELFs are rejected. The report records every
objdump encoding and mnemonic pair, counts it, and compares its normalized
mnemonic to the exact pinned flexe decoder source. Special-register forms such
as `rsr.ccount` normalize to flexe's generic `rsr` decoder entry.

The current input is
`out/build/esp32-panel-probe/tinydraw_esp32.elf`, 5,571,516 bytes, SHA-256
`a46349d9bc5eb3e58fad64f95e433c0b505ea3fa9737664d2d0f4945534b9644`.
The tool is GNU objdump 2.45 from Espressif crosstool-NG
`esp-15.2.0_20251204`, SHA-256
`90a91caa519b895bd457f4eb7c5fd6b14a9c64c0c7d946e78e7f332ea57d7466`.
The flexe decoder is `src/xtensa_disasm.c` at the pinned commit, SHA-256
`68f98a684b964dd36d778f755441242496f624f0ffbc68c789c7c25e2862f3d0`.

That ELF yields 64,276 objdump rows and 341 raw mnemonics. The pinned flexe
decoder plus this experiment's explicit ESP32-S3 patch surface has 347
normalized mnemonics. With user-register operands distinguished, it covers
63,415 rows and 316 raw mnemonics; 861 rows and 25 raw mnemonics remain gaps.
Those gaps are 24 unimplemented `ee.*` PIE forms covering 162 rows and 699
undecodable `.byte` rows. No
known scalar, QR load/store, THREADPTR, ACCX, QACC, SAR_BYTE, or FFT_BIT_WIDTH
mnemonic remains in the gap list, and every named user-register form is covered.

`0003-add-esp32s3-lx7-subset.patch` implements `s32nb`, `lsip`, `ssip`,
`ld.qr`, `st.qr`, `ee.vld.128.ip`, `ee.vld.128.xp`, `ee.vst.128.ip`,
`ee.vld.l.64.ip`, `ee.vld.h.64.ip`, `ee.vst.h.64.ip`, `ee.vunzip.8`, and
`ee.vzip.8`, `ee.ldf.64.xp`, `ee.stf.64.xp`, `ee.ld.accx.ip`, and
`ee.st.accx.ip`, all eight `ee.[ld/st].qacc_[h/l].[h.32/l.128].ip`
transfers, `ee.ld.128.usar.ip`, `ee.vldbc.32.ip`, and `ee.ldqa.s16.128.ip`. It selects
those semantics only for the ESP32-S3 experiment
profile. `s32nb` preserves the data-store effect; non-buffered ordering is not
represented by flexe's core. The profile also implements per-core UR0/UR1
ACCX, UR2 through UR11 QACC, UR13 SAR_BYTE, UR14 FFT_BIT_WIDTH, UR15 through
UR18 UA_STATE, and UR231 THREADPTR state and refuses unknown user-register
targets as step errors. No
instruction or timing cost is assigned here.

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
`out/build/esp32-vector-v2-demo/tinydraw_esp32.elf`, SHA-256
`591c4d9b5ade8f978f2a910e48e2bf9af345c781bdbed1ac6f1ffa2383c7a742`.
With `a4` nonzero, `tinydraw_stage_pixels_swapped_pie` executes `entry`,
`nop.n`, `loopnez`, two vector loads, unzip, zip, two vector stores, and
`retw.n`. It returns after ten instructions and transforms RGB565 bytes `3412`
to `1234`. This is a real named TinyDraw PIE kernel, not a linear decode from
a literal pool.

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

Nine raw conformance fixtures cover the remaining implemented data operations.
The scalar fixture copies `0x12345678` with `l32i.n` and `s32nb`, then executes
`lsip` and `ssip`; both base registers advance by four and the run returns
after six instructions. The QR fixture copies 16 deterministic bytes with
`ld.qr` and `st.qr` and returns after four instructions. A register-postincrement
fixture loads q7 through an intentionally unaligned base and proves that the
aligned access and AR increment are independent. A half-QR fixture
proves low-half load, high-half load, and high-half store preservation, forced
eight-byte address alignment, and sign-extended negative post-increments. The
adjacent unimplemented `ee.vld.l.64.xp` encoding stops before execution with
unchanged registers,
trace, and output. Exact code
hashes, outputs, step counts, and post-incremented registers are pinned in the
dynamic baseline.

The floating-register pair fixture round-trips an exact NaN payload and a
second arbitrary 32-bit word through `ee.ldf.64.xp` and `ee.stf.64.xp`. It
proves forced eight-byte alignment, low/high register order, bit preservation,
and independent register postincrements. The adjacent four-byte
`ee.ldf.128.xp` form remains a fail-closed two-byte decoder collision.

The ACCX memory fixture loads an unaligned 64-bit word into the 40-bit ACCX
state, reads both user-register halves back, and stores the zero-extended value.
It proves the upper word is masked to eight bits and negative immediates update
the original unaligned bases. The QACC memory fixture round-trips both banks'
low 128 bits and upper 32-bit words, proving forced 16-byte/four-byte alignment
plus signed scaled postincrements for every load and store form.

The aligned-load fixture proves `ee.ld.128.usar.ip` loads from a forced
16-byte boundary, saves the original low address nibble in SAR_BYTE, and applies
its signed scaled immediate to the unaligned base. It also proves
`ee.vldbc.32.ip` broadcasts one aligned word to all four QR lanes. The adjacent
register-postincrement USAR form remains fail-closed.

The signed QACC lane fixture loads eight deliberately mixed-sign 16-bit lanes,
sign-extends each to 40 bits, and pins their exact packed QACC_L/QACC_H user
register words. The adjacent unsigned lane form remains fail-closed.

The THREADPTR fixture executes the real reset-path `l32r` and
`wur.threadptr a8` encoding at `0x40375ce4`, reads UR231 back with
`rur.threadptr`, and returns the pinned CPU0 value `0x3fcabf20`. A separate
fixture writes distinct values through `wur.accx_0` and `wur.accx_1`, then
reads back the 32-bit ACCX_0 and architecturally masked 8-bit ACCX_1 values.
The QACC fixture round-trips distinct values through every high and low bank
register. The SAR/FFT fixture proves both 4-bit masks. A `wur.ua_state_0`
through `wur.ua_state_3` fixture round-trips four distinct 32-bit values. An
encoding targeting the unassigned UR12 slot stops with `stepError` before
counting the instruction, so unknown user registers cannot silently become
no-ops.

The PIE fixture starts at `0x40377698` and has code SHA-256
`f0503e09af131793fa0dfdf9077a9d433225c08962672d7f492f1496b15d1c75`.
Its first former gap is objdump encoding `830124`, `ee.vld.128.ip q0, a2,
16`. The S3 profile handles the exact vector encodings before the colliding
LX6 MAC16 decoder and completes the ten-instruction function.

The RGB565 fixture is the local
`stage_pixels_swapped_scalar_oracle` function from
`out/build/esp32-vector-v2-gate-harness/tinydraw_esp32.elf`, SHA-256
`522b33cb491bbc9c8a61a364b3c986c7f1d013bcdf228f79791981f7fcad1491`.
Its 41 code bytes start at `0x42058230` and have SHA-256
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
`5de26fe4432e5af5c95d99d32ee0d3d68260e712bb5dd20c60eb1315f295c4eb`
and is written to ignored `dist/rgb565-execution-trace.bin`.

Capacity is fixed at 128 records. A separate 14-pixel run with three prefixed
`nop.n` instructions reaches capacity while issuing a 16-bit read. The runner
rolls the whole instruction back, retains the 127 records for 101 completed
instructions, and stops at the instruction boundary `0x42058244` with
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

`trace-timing-adapter.ts` is the experiment-only bridge from the flexe ABI to
the ESP32-S3 pack's bounded neutral trace adapter. It supplies the ABI's
instruction PC or data address explicitly, preserves all 53 records in their
single-core observation order, and classifies every instruction as a fetch and
every data record as a load or store. `timing-replay-test.ts` submits the
resulting `RuntimeTimingTrace` to the pack's `TimingMachine`. The generated
`dist/rgb565-timing-replay.json` exposes address resolution, physical backing,
cache emission, resource, cost provenance, and execution status for each trace
record.

The bridge now retains the existing ABI instruction word and data-record PC at
the neutral boundary. No binary ABI field was added. Store-buffer replay is
opt-in and requires caller-supplied instruction, store-retirement, and `memw`
costs. In that mode each write carries the retirement cost, and only the exact
three-byte Flexe trace word `0x0020c0` becomes a fence. The default replay does
not enable this mode, so its event accounting and unknown-cost boundary remain
unchanged.

Dependent internal-SRAM load-use replay is separately opt-in. The caller must
provide one exact SRAM range or an ordered list of exact non-overlapping ranges,
the one-cycle measured hazard cost, and a known instruction issue cost.
`flexe-load-use.ts` then requires a complete trace,
matches every data record to its instruction by the ABI issuer PC, decodes a
bounded set of scalar load destinations and immediate consumer source
registers, and adds one cycle only on an exact register dependency. Unsupported
register forms, nonsequential successors, multi-access load instructions, and
accesses that enter an undeclared range gap are refused. The default bridge
remains unchanged.

The replay uses the gate-harness sdkconfig at SHA-256
`ac1749b0f5b9c54e3e8e5ffc045b37a434d6b289420a8f9cf0f37fe8a3173d9b`:
16 KiB, 8-way, 32-byte-line instruction cache and 32 KiB, 8-way,
64-byte-line data cache. IROM MMU entry 5 is mapped to flash physical page 0
only to exercise the flash, cache, and MSPI route. That physical page is an
experiment input, not an observed hardware MMU snapshot. The two 4 KiB runner
data pages are covered by one explicit internal-SRAM experiment region.

The replay resolves all 43 instruction fetches, five loads, and five stores.
It also emits 43 per-core CPU execution events with the calibrated one-cycle
steady-state issue cost. The memory path emits
44 instruction-cache hits, two line fills on MSPI, and ten SRAM bypass events.
There are 44 hit emissions because the three-byte instruction at
`0x4205823e` crosses the 32-byte cache-line boundary and touches both lines.
The path-independent per-record evidence SHA-256, including each instruction's
CPU event, is
`b6f14edb9237cf68deceb8ef92e56e247830671a310cb55306024994393f60c4`.

The timing profile supplies calibrated instruction-cache flash line fills,
one-cycle steady-state instruction issue, zero additive independent SRAM
instruction fetch, load, and store costs, and zero additive hot zero-miss
instruction-cache and data-load hit costs. The exact classifier finds no
dependent pair among this trace's five SRAM loads. All 99 issued costs are
known, so the bounded caller-reported trace completes at 451 cycles. The trace
still lacks whole-program and peripheral coverage, so the replay remains
explicitly non-cycle-accurate.

`esp32s3-dynamic-baseline.json` pins all three ELF hashes, extracted-code and
staging-output and trace hashes, patch hashes, objdump hash, module hash, stop
results, access counts, and overflow result. The detailed generated record and
toolchain provenance live in ignored `dist/dynamic-execution.json`.
`esp32s3-timing-replay-baseline.json` separately pins the replay configuration,
source hashes, classification counts, scoped total, and per-record evidence hash.

## Sparse full ELF execution

`elf-image.ts` strictly accepts 32-bit little-endian Xtensa executable images
and validates every `PT_LOAD` file range, 32-bit memory range, alignment, and
entry-point permission. `full-elf-runner.ts` expands those segments into
sorted 4 KiB pages, zero-fills `p_memsz - p_filesz`, merges overlapping load
segments, and preserves the union of their ELF permissions. The module clears
flexe's default page table before loading the image, so memory that the ELF did
not declare is absent unless the host supplies a page-aligned zero range with
provenance. By default it supplies no ROM, MMIO, flash-controller, or
peripheral behavior; each modeled direct-boot dependency is opt-in and
fail-closed.

The gate-harness image is 21,598,616 bytes with SHA-256
`51cc322381bce60347ca322506c411af17f6b73ef366f3e440d6fdf5c1d5a8e5`.
Its eight load segments become 625 sparse pages. Execution begins at its ELF
entry `0x40375c9c`, `call_start_cpu0`. flexe executes `entry`, `l32r`,
`wsr.vecbase`, `movi.n`, `l32r`, and `callx8`, then stops before fetching the
undeclared ESP32-S3 ROM target `0x4000057c`. The result is `unloadedPage`, six
executed instructions, and a six-PC trace. This is the first honest boundary,
not a boot claim.

The initial stack is a required runner input. The gate-harness baseline uses
`0x3fce9700` from `bootloader_usable_dram_end` in its bootloader map and adds
three explicit zeroed writable pages at `0x3fce7000..0x3fcea000`. These are
bootloader-inherited state, not app ELF pages.

The host may explicitly configure narrow ROM ABI callbacks. Reset reason
at `0x4000057c` returns one caller-supplied value per core. `memset` at
`0x400011e8` accepts at most 64 KiB, validates every destination page and its
write permission before changing memory, and returns the destination pointer.
Neither callback is enabled by default. Calls appear only as typed, bounded ROM
events; they do not enter the instruction PC trace or decoded-instruction count.
The event records summarize reset-reason arguments and results or the full
`memset` destination, byte value, and length. They assign no timing to the bulk
operation. Every ROM event also records `afterInstructionCount`, the exact
committed instruction count after its preceding call, so timing replay can
attach the callback at the correct boundary without inventing a duration.

The opt-in cache bootstrap accepts 11 exact ROM invocations across nine
addresses. It follows the observed call order through cache disable/enable,
16 KiB 8-way 32-byte-line instruction geometry, 32 KiB 8-way 64-byte-line
data geometry, data suspend/resume, and MMU table sizes. It then maps only two
source-backed SYSTEM registers: the 80 MHz
PLL source value `0x400` at `0x600c0060`, read from PC `0x403771a5` before and
after the crystal-frequency query, and
the 80 MHz CPU period value `0x4` at `0x600c0010`, read in order from PCs
`0x403771d6` and `0x403771ff`. All are aligned 32-bit reads after MMU setup.
Other registers, access shapes, readers, orderings, and additional accesses are
refused. After the first SYSTEM sequence, the runner exposes one
ordered 32-bit read of RTCCNTL `RTC_XTAL_FREQ_REG` at `0x600080c0` from PC
`0x40377159`. TinyDraw configures a 40 MHz crystal and keeps ROM logging on, so
the bootloader-persisted duplicated-half value is `0x00280028`. After the clock
switch, the runner admits the exact `RTC_CNTL_DATE_REG` read at `0x600081fc`
from PC `0x40377301`. Its source-backed value is the documented raw reset
value `0x02101271`; the following RMW installs the XTAL LDO slave field.
The subsequent BBPLL-disable RMW reads `RTC_CNTL_OPTIONS0_REG` at
`0x60008000` from PC `0x4037f7df`. The documented reset fields produce
`0x1c00a000`, and the bootloader's default RTC initialization clears
`XTL_FORCE_PU`, yielding the inherited `0x1c008000`; the write at
`0x4037f7e8` ORs the documented force-PD mask `0x540` to produce
`0x1c008540`.
Other RTCCNTL addresses, access shapes, readers, orderings, and repeats
are refused. The next
exact ROM callback, `esp_rom_set_cpu_ticks_per_us` at `0x40001a4c`,
accepts argument 40 with CALLINC 2 only after both clock-query cycles. The real
image now executes 376 instructions and stops on the following
`SYSTEM_SYSCLK_CONF_REG` read at `0x600c0060` from PC `0x4037f5df`; the typed event log
contains the CPU-ticks callback, nine SYSTEM reads, three SYSTEM writes, three
RTCCNTL reads, and the source-backed DATE and OPTIONS0 writes.

With host-supplied power-on reset value 1 for both cores and `memset` enabled,
the real entry performs two reset-reason calls, clears 21,216 bytes at
`0x3fcabe60`, and records the real zero-length clear at `0x50000000`. A refusal
control deliberately marks `wur.threadptr` at `0x40375ce7` and stops after 27
decoded instructions. The integrated LX7 run executes that instruction,
persists user register 231, reaches 34 decoded instructions, and refuses the
first undeclared 32-bit MMIO read at
`0x600c4064` with flags zero. No cache or MMIO behavior is implied.

Full-image runs accept at most 768 pages, 2,048 unsupported instruction
markers, 64 ROM events, and 512 executed instructions. The pinned TinyDraw ELF
automatically installs the tracked 1,069-instruction ESP32-S3 ISA gap set before
execution. Each marker must match the decoder-width bytes in loaded executable
memory during setup; stale, mismatched, unloaded, and non-executable markers are
refused. Once bound, reaching a marked PC stops before LX6 decoding, including
four-byte `ee.*` forms whose first two bytes collide with an LX6 encoding. The
trace contains one PC per successfully executed instruction. Oversized bounds,
duplicate markers, out-of-order pages, invalid permissions, unwritable ROM bulk
destinations, and capacity overruns are refused.

The full-image runner also exports a separate 1,024-record version 1 memory
trace using the dynamic runner's existing binary ABI. It records each committed
instruction plus mapped 8-, 16-, and 32-bit reads and writes with issuing PC,
address, value, and width. ROM callbacks do not enter this trace. A fault,
unsupported instruction, decoder failure, or overflow restores the CPU and
trace checkpoint together, so no partial instruction survives. The 376-step
cache-bootstrap boundary produces 524 records with a pinned SHA-256, and a
cross-page SRAM regression checks the exact 32-bit value and address.

`full-elf-timing-replay-test.ts` feeds that committed boot trace through the
same neutral adapter and `TimingMachine` used by the RGB565 replay. Its address
map contains only the nine SRAM pages, two flash pages, and three controller
MMIO pages observed in the trace, with their ELF or inherited permissions.
Those nine exact 4 KiB SRAM ranges opt into the
measured one-cycle dependent load-use hazard without classifying their gaps.
Exact three-byte `L32R` encodings classify their owned reads as instruction-side
literal loads. The 524 records issue 948 timing events: 483 memory-system
events, 44 MMIO accesses, 376 calibrated CPU issue events, and 29 calibrated
dependent load-use events, plus 16 configured ROM callback boundaries with
explicitly unknown CPU durations. Exactly 909 events have adopted costs, including
21 exact MMIO reads, three exact not-taken `beqz` paths, three flash line
fills, and every zero-miss cache hit. The baseline pins the branch classifier,
hazard count, and a projection hash of their schedule, consumer IDs, registers,
and producer/consumer PCs, plus the ROM callback boundary provenance. The 23
controller MMIO costs and 16 ROM callback durations keep the replay blocked
with no total cycle claim. The baseline also pins the exact
address, direction, width, peripheral, and count of all observed MMIO access
classes so hardware-adopted costs cannot silently broaden their scope.
An executable-permission miss and an unloaded page have distinct recoverable
stop reasons. `esp32s3-full-elf-baseline.json` pins the image, module, patch,
page count, bounded trace, unsupported-instruction refusal, and first stop,
including all six instruction encodings and the call-site register state.
The runner regression also executes a three-byte instruction beginning at
`0x40370fff` across two adjacent executable pages and refuses the same fetch
before execution when the trailing page lacks execute permission. Ordinary
ELF-run data reads and writes enforce PT_LOAD permissions with distinct stop
reasons and fault metadata. Regressions cover 8-, 16-, and 32-bit accesses,
including fully unmapped addresses and mapped-to-unmapped cross-page refusal
without partial writes. The trace-only runner is unchanged.

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

The stripped freestanding module is 71,007 bytes with Zig 0.16.0, SHA-256
`f240e4d63a5c2fca3285eda66d864212b88cb00762ed3725a33c1747cde007d5`.
It imports only `env.js_log` and exports `memory`, `flexe_wasm_probe`,
the code input and capacity functions, `flexe_wasm_run`, the data input, output,
and capacity functions, `flexe_wasm_run_data`, the memory trace surface, and
the bounded sparse ELF load, trace, refusal, page-capture, fault, and run
functions. Those names are
audited before the tests pass the bytes to Puck's real loader. It has no WASI
imports, and Puck's loader surface is unchanged.

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

That is a bounded portability and ISA patch around the core. The remaining
project risk is architectural: 30 observed PIE forms and undecodable `.byte`
rows remain explicit gaps, ROM is absent at the first
reset-path call, and the memory map, caches, peripherals, dual-core scheduling,
and timing remain unmodeled.

## License

flexe is MIT licensed, copyright 2026 Lev Kropp. `LICENSE.flexe` is the exact
license from the pinned commit. The build copies it beside the generated module.
