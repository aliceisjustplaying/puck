# ESP32-S3 browser-speed probes

Throwaway experiment code. It answers one question: is a real-time,
cycle-accounting ESP32-S3 emulator feasible in a browser on M1-class
hardware, and through which execution strategy?

Two probes, one specimen module:

- **Interpreter probe** (`bench_probe.c`): the pinned flexe interpreter
  (same checkout, same three patches as
  [`../esp32s3-flexe-wasm/`](../esp32s3-flexe-wasm/)), running the real
  TinyDraw RGB565 scalar staging kernel
  (`stage_pixels_swapped_scalar_oracle`, code SHA-256
  `a545acd197c5b75f0351256aa6a9c8a7028cb42f91e617c28317fa560d873877`, the
  same fixture the sibling experiment pins) in a re-arming loop. The kernel
  returns onto a flexe breakpoint at the code-page base, so a completed call
  stops cleanly with no trap logging, and the harness re-arms with
  `xtensa_cpu_init` (allocation-free at the pinned commit) and continues.
  2,048 pixels per call, 14,344 interpreted instructions per call, output
  verified byte-swapped every run.
- **JIT-ceiling probe** (`jit_ceiling.c`): the same kernel's semantics as
  straight-line compiled code over a memory-resident guest register file,
  with an inlined direct-mapped D-cache tag check on every load and store
  and an inlined cycle counter on every emulated instruction. Vectorization
  is disabled. This approximates the code a wasm-emitting JIT would produce
  for a block, so it is a CEILING for JIT throughput, not a design: a real
  JIT adds window guards, interrupt polls, and block dispatch.
- **Instantiate-cost specimen** (`tiny_block.c`): an 81-byte module with one
  exported function, for measuring `WebAssembly.Module` compile and
  instantiate cost at JIT-block granularity.

## Run it

```text
bun run experiments/esp32s3-browser-speed/build.ts    # needs zig and the pinned flexe checkout
bun run experiments/esp32s3-browser-speed/run.ts      # native + bun (JavaScriptCore)
bun run experiments/esp32s3-browser-speed/browser.ts  # real Chrome (V8), needs CHROME_PATH or a standard install
```

## Results, 2026-08-31

Environment: Apple M1 Pro, 32 GiB, macOS 27.0, Bun 1.4.0, Zig 0.16.0,
Chrome 151.0.7922.174, flexe at `34ea9eb6eef921b59a55e6a435c7fc55c5727835`
with patches 0001-0003.

| Probe | Native (arm64) | bun / JSC wasm | Chrome / V8 wasm |
| --- | --- | --- | --- |
| Interpreter, real kernel | 122.7 MIPS | 113.2 MIPS | 109.0 MIPS |
| JIT ceiling, emulated-instruction rate | 9,705 MIPS | 5,879 MIPS | 4,618 MIPS |

A same-day confirmation run is checked in under `results/` (interpreter
102 to 105 MIPS across all three runtimes, Chrome ceiling 4,393). Host-side
numbers vary 10 to 15 percent run to run with thermal and scheduling state;
every conclusion below rests on 4x to 10x margins, not on that precision.

Module cost in Chrome: the 81-byte block compiles and instantiates below
`performance.now()` resolution in headless Chrome (median 0 ms over 300
samples); the whole 56,070-byte interpreter module compiles in 0.2 ms.

Accounting notes, so nobody over-reads the ceiling: the ceiling probe
charges 8 emulated instructions per pixel plus 3 per call; the interpreted
kernel actually executes 7 per pixel plus a fixed prologue (14,344 for
2,048 pixels). Scaling the Chrome ceiling by 7/8 gives roughly 4,040
MIPS-equivalent. Wasm-to-native ratio for the interpreter is 0.89 (JSC)
and 0.83 (V8).

## What this answers

The dual-core worst case (both 240 MHz cores executing one instruction per
cycle with no stalls) needs 480M emulated instructions per second.

- The interpreter alone reaches about 23 percent of that worst case (about
  45 percent of one hot core). With idle skipping and free stall cycles it
  can carry light firmware, but it cannot carry hot rendering loops in real
  time. Interpreter-only real time is REFUTED for the worst case.
- The JIT ceiling is 8 to 10 times the worst case with cycle accounting and
  cache tag checks inlined. A real JIT that reaches 15 percent of this
  ceiling meets the worst case; anything above that is margin. JIT-first
  real time on M1-class hardware is FEASIBLE, subject to the usual caveat
  that a ceiling is not a design.
- Per-block wasm compilation cost is negligible at this granularity, so a
  translate-blocks-at-runtime architecture (the v86 approach) is not
  gated on compile latency.

## Boot-size measurement, same date

Reset-to-first-app-output on the physical board (USB Serial/JTAG,
RTS-pulse reset via the tinydraw repository's `tools/boot-time-probe.py`,
three runs): 0.577 s, 0.582 s, 0.595 s, including USB re-enumeration time. The board ran the tinydraw
`esp32s3-memory-timing` calibration firmware (ESP-IDF v6.0.2, 240 MHz).
At the app clock this bounds a full ESP-IDF boot at order 10^7 to 10^8
cycles, which places the full-ELF experiment's current 837-instruction
boundary at least four orders of magnitude short of a complete boot. That
is the sizing receipt for replacing per-access boot whitelists with
peripheral models and real-ROM execution.

## Existing-receipt spread analysis, same date

From the checked-in hardware receipts under
`../../packs/esp32-s3-touch-amoled-18/timing/evidence/receipts-bf169bc/`
(100 samples per cell, boots 1 and 2):

| Cell | Cycles (min = med = max unless noted) | Distinct values |
| --- | --- | --- |
| `psram_hot_sequential` | 4,114 | 1 |
| `psram_hot_random` | 40,985 | 1 |
| `sram_aligned_stream` | 49,172 | 1 |
| `sram_l32_independent` | 9,240 | 1 |
| `flash_mmap_hot_sequential` | 4,114 | 1 |
| `psram_cold_sequential` | 1,432,186 to 1,433,636 | 2 (spread 0.10 percent) |

Short, bounded, cache-warm windows are bit-repeatable across boots,
including miss-dominated random PSRAM access. Nondeterminism appears only
on the long cold window, at the 0.1 percent scale. Together with the
non-integer RTC read slopes already documented in the timing lab, this is
the empirical basis for a tiered cost vocabulary: exact costs for short
deterministic events, distributions for long-window aggregates and
cross-clock-domain accesses.

## License

flexe is MIT licensed, copyright 2026 Lev Kropp. The build copies
`LICENSE.flexe` beside the generated binaries.
