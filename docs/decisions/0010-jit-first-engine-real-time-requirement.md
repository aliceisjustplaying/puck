# 0010: A JIT-first engine in Rust, with real time as a hard requirement

Date: 2026-08-31
Status: accepted

## Context

The maintainer set real-time execution on M1-class hardware as a hard
requirement for the full-system path: the emulated board must be usable
interactively in the browser, not only analytically at reduced speed.

The browser-speed probes
([`experiments/esp32s3-browser-speed/`](../../experiments/esp32s3-browser-speed/README.md))
measured, on an Apple M1 Pro with Chrome 151:

- pinned flexe interpreter, real TinyDraw kernel: 109 MIPS in V8 wasm;
- a JIT-ceiling model of the same kernel (compiled block over a
  memory-resident register file, inlined per-access D-cache tag check,
  inlined cycle counter): about 4,600 emulated MIPS in V8 wasm;
- wasm module compile cost at block granularity: below timer resolution
  for an 81-byte block, 0.2 ms for a 56 KiB module.

The dual-core worst case is 480M emulated instructions per second. The
interpreter reaches about a quarter of it; the ceiling exceeds it eight to
ten times. An interpreter-only engine therefore cannot meet the
requirement, and a runtime-translation engine can, with margin, if it
retains a usable fraction of the ceiling.

## Decision

The production execution engine for the full-system path:

- is written in Rust and compiled to WebAssembly (a deliberate exception
  to the repository's TypeScript-only rule, recorded here; the engine is
  neither firmware nor page tooling, and the TypeScript rule continues to
  govern everything else this repository owns);
- translates Xtensa basic blocks to wasm at runtime, v86-style, with
  timing compiled into the generated code: per-block base cycle counts and
  inlined cache and bus accounting at memory operations, because separate
  instrumentation calls would forfeit the measured headroom;
- keeps an interpreter tier as first execution, fallback, and semantic
  referee, with differential testing between tiers;
- runs single-threaded and deterministic. Cores interleave in bounded
  quanta under one scheduler; shared-resource arbitration and interrupt
  delivery are resolved by the timing model, which drives execution rather
  than pricing a finished trace. Determinism and replay outrank host
  parallelism.
- detects idle (`waiti`) and skips to the next timer or injected event, so
  realistic firmware costs only its busy fraction.

The existing TypeScript timing machine
(`packs/esp32-s3-touch-amoled-18/timing/`) becomes the reference model: the
Rust engine's accounting is differentially tested against it on shared
traces, the same pattern the repository already uses where one mechanism
must not drift from another. The TypeScript code is not the production
path and is not deleted.

## What this does not decide

Block-cache geometry, quantum length, the executor-to-timing interface,
and self-modifying-code handling are design work, to be settled through a
small throwaway co-simulation prototype (two cores, a shared resource, one
timer interrupt) before the real engine is wired. A ceiling measurement is
not a design; the engine must re-measure against the same probes as it
grows guards and dispatch.

## Consequences

The flexe lane's value shifts from "future engine" to "reference
interpreter and ISA test corpus". Rust toolchain requirements enter the
build the same way zig does: an invoked binary, pinned and checked.
Real-time claims are made only against measured M1-class results, and the
requirement does not extend to arbitrary slower hosts.
