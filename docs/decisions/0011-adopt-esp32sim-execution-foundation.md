# 0011: Adopt esp32sim as the execution foundation

Date: 2026-08-31
Status: accepted

## Context

Decision 0010 chose a Rust, JIT-first execution engine to be built in this
repository. Days later, [joakimeriksson/esp32sim](https://github.com/joakimeriksson/esp32sim)
surfaced: an MIT-licensed, instruction-level ESP32-S3 and C3 emulator in
Rust by the author of MSPSim. At the evaluated state (50 commits,
2026-08-25 to 2026-08-30) it already contains most of what roadmap lanes 1
and 3 planned to build:

- a dual-core LX7 core (windowed registers, loops, XEA2, FPU, MAC16, PIE
  SIMD) in about 3,000 lines, with the decoder verified against objdump
  over 977 thousand instructions with zero mismatches;
- real mask-ROM boot from the Apache-2.0 `esp-rom-elfs` images (decision
  0009's mechanism, implemented), through the real second-stage bootloader
  into FreeRTOS and unmodified application images;
- SoC models through cache MMU, flash and octal PSRAM, GDMA, LCD_CAM,
  per-core interrupt matrix, timers, regi2c, RTC watchdog, crypto, and the
  unmodified WiFi blob;
- a block interpreter plus an AArch64 JIT with the interpreter as a
  bit-identical oracle, idle skipping, and deterministic regression
  fixtures;
- silicon verification by JTAG lock-step single-stepping against a real
  chip (8,000 steps from reset, zero PC divergences) with efuse, strap,
  and reset-state adoption from the board.

It is explicitly not cycle accurate: CCOUNT advances one per instruction,
device time is delivered lazily, and its own comparison tooling
resynchronizes across CCOUNT-timed delay loops.

## Decision

Build on esp32sim instead of writing an execution engine here. The pinned
upstream commit and the fork-versus-upstream split are tracked in
`docs/roadmap.md`; the maintainer has opened contact with the author.

What this repository's project contributes on top, in order of ownership:

1. **The measured mode.** A cycle-accounting execution mode alongside
   upstream's fast mode, both from the same core. The graft points already
   exist upstream: `advance_ccount(cycles)` takes a cycle argument, every
   memory access crosses the `Bus` trait, and the block cache can carry
   precomputed per-block base costs. Measured mode adds the calibrated
   payload: per-instruction issue costs, the window overflow and underflow
   pair, the loop-alignment rule, cache and line-fill models, MSPI
   arbitration, and tighter dual-core quanta. Costs and tiers come from
   this project's timing lab and receipts under decision 0008; unknown
   costs stay explicit unknowns.
2. **The board.** A `BoardModel` implementation for the Waveshare
   ESP32-S3-Touch-AMOLED-1.8: SH8601-class QSPI panel, touch controller,
   QMI8658 IMU, TCA9554 (upstream already models a TCA9554 and I2C).
3. **The wasm JIT backend.** Upstream's roadmap wants it; this project's
   real-time browser requirement needs it; both measurement sets (this
   repository's browser-speed probes and upstream's own numbers) agree the
   interpreter alone cannot reach dual-core real time in a browser.
4. **The correlation suite.** Cycle-level acceptance on top of upstream's
   JTAG lock-step harness: CCOUNT-delta comparisons in measured mode
   against decision 0008's tiered bounds.

## What this supersedes and retires

- Decision 0010's build-the-engine-here scope is superseded; its
  architectural commitments (Rust, block translation, interpreter as
  oracle, determinism over host parallelism, idle skipping, real-time
  requirement on M1-class hardware) are all satisfied or carried forward
  by esp32sim plus the contributions above.
- The flexe experiment lane is retired to reference duty: its fixture
  corpus, ISA baselines, and bounded-boot evidence remain as test inputs
  and historical record. No further flexe capability work.
- Roadmap lanes 1 and 3 as previously scoped are closed; the QEMU oracle
  demotes to tie-breaker (upstream's objdump and JTAG verification cover
  most of its role).

## What is unchanged

- Decision 0008's tier vocabulary and acceptance bounds govern every cost
  the measured mode adopts.
- The timing lab, receipts pipeline, and hardware evidence remain this
  project's calibration source and are unaffected.
- The behavioural instrument documented in decisions 0003, 0006, and 0007
  keeps its claims; this decision concerns the opt-in cycle-model path.

## Risks

Single author, days old, no external contributors at evaluation time.
Licensing, resolved 2026-08-31 after the external review raised it: the
repository has no root LICENSE file yet, but the README declares MIT
twice and every crate declares `license = "MIT"` through the workspace
manifest; the maintainer accepts that in-repository declaration as the
basis for the fork, and the author will be asked to add the file. The
mitigations: the MIT declaration permits forking at the pinned commit; the author's
track record (MSPSim, maintained for decades) and the project's own
receipts-adjacent engineering culture (`docs/decisions.md` upstream) argue
for collaboration first. Contributions are shaped as upstream pull
requests where upstream wants them (wasm JIT, boards) and carried on a
fork where they may not (measured mode, if upstream prefers to stay
instruction-level).

Two technical caveats recorded so nobody rediscovers them: upstream's lazy
device-time delivery and block-batched CCOUNT advance are correct for fast
mode and wrong for measured mode, so measured mode must tighten event
delivery and per-block accounting deliberately; and cycle-honest dual-core
contention requires finer interleaving quanta than upstream's block
budgets, which costs speed. Both modes therefore coexist rather than
replacing one another.

## The role of puck

Amended 2026-08-31 by decision
[0013](0013-product-identity-fork-owns-the-product.md): the question
this section left open is now answered. The product is the fork's
browser emulator; puck is the donor, evidence, and decision repository
and does not carry an execution engine. The original text follows for
the record.

Puck remains the UI and verification layer for this effort: the panel
page, input recording and replay, the freeze bundle, the differential
harness, and the regression check can all wrap the esp32sim machine. How
much of puck survives into the final product is deliberately left open;
the conventions, the decision-record culture, the timing lab, and the
receipts are the durable assets either way.
