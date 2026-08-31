# 0009: Execute the real ESP32-S3 ROM instead of reimplementing it call by call

Date: 2026-08-31
Status: accepted

## Context

The full-ELF boot experiment reaches 837 instructions by reimplementing
each ROM entry point it meets as a hand-authored, fail-closed callback:
reset reason at `0x4000057c`, `memset` at `0x400011e8`, `rom_i2c_writeReg`
at `0x40005d60`, `_xtos_set_intlevel` at `0x40001c38`, each admitting one
exact call shape at a time. Eighteen unmeasured ROM callback durations are
among the costs that block a total cycle claim, and every additional boot
step extends the transcript by hand.

Espressif publishes the mask ROM contents of its chips as ELF files under
Apache-2.0: [`espressif/esp-rom-elfs`](https://github.com/espressif/esp-rom-elfs)
(`esp32s3_rev0_rom.elf` for this chip). The license permits vendoring with
attribution. The ROM address ranges are already inside the address ranges
the runner and timing machine model.

## Decision

Load and execute the real ROM image in the full-system path. Retire the
ROM-callback whitelist as the execution mechanism; keep its recorded call
shapes as differential checks that real-ROM execution must reproduce.

Consequences of the mechanism change:

- ROM behavior stops being transcribed and starts being executed, removing
  a whole class of fidelity risk (a mistranscribed argument, a missed side
  effect, an unmodeled early-out).
- ROM callback durations stop being opaque lump costs. ROM code becomes
  ordinary instructions priced by the same model as application code, so
  the blocked "callback duration" unknowns dissolve into already-modeled
  instruction, cache, and MMIO costs.
- The hand-authored surface shrinks to what it must be anyway: MMIO and
  peripheral behavior (see the peripheral-model direction in decision
  0007's blocker list). ROM code will read more registers than the
  callbacks did; those reads are the same peripheral-model work, not new
  transcription work.

The ROM ELF is vendored with its Apache-2.0 license text and pinned by
SHA-256, fetched by a build script the same way the pinned flexe checkout
is fetched and verified.

## Consequences

The ROM-callback lane's unintegrated checkpoints are not merged. Its tests
convert into a replay corpus: for each recorded call shape, real-ROM
execution must produce the same architectural effects. The ISA surface the
ROM exercises may exceed the current flexe patch set; unsupported
instructions keep their fail-closed markers and become ordinary ISA lane
work items.
