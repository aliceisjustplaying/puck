# 0007: A separate opt-in ESP32-S3 full-system cycle-model path

Date: 2026-08-31
Status: accepted

## Context

Decision 0003 keeps Puck's default emulator focused on fast, deterministic
execution of portable firmware C compiled to WebAssembly. Decision 0006
permits a separate ESP32-S3 shadow ledger, but that ledger sees only work the
portable build instruments. It does not execute the board's Xtensa object code
or observe every instruction fetch, load, store, interrupt, DMA transaction,
or shared-bus request.

The timing package now has deterministic components for explicit dual-core
event streams, address resolution, cache state, shared MSPI arbitration, DMA,
and evidence-carrying cost results. A WebAssembly feasibility experiment also
executes a small scalar function extracted from a real ESP32-S3 ELF. These are
useful foundations, not a full-system emulator and not a calibrated cycle
model.

## Decision

Permit a separate, explicitly opt-in ESP32-S3 full-system and cycle-model
path. It may execute the device's Xtensa object code and connect architectural
instruction fetches, data accesses, cache operations, DMA, MMIO, interrupts,
and both cores to the timing machine.

This path does not replace or slow the portable-C emulator. The portable-C
emulator remains the default browser instrument and retains the host-driven
`emu_tick(nowMs)` contract. The full-system path has its own entry point,
artifacts, dependencies, controls, and claim boundary.

Until the complete execution and memory-system model is calibrated and
validated against hardware, every result from this path must state:

- `cycleAccurate: false`;
- architecture and cost calibration are uncalibrated or unknown;
- which events were modeled, blocked, faulted, or left unaccounted;
- the source and review state of every adopted cost;
- that host trace time is not simulated chip time.

Hardware calibration receipts remain evidence, not automatic architectural
costs. A microbenchmark candidate may enter the model only after its mapping to
an architectural event has been reviewed. Candidate reports must keep
`microbenchmarkToArchitecturalCost: "unreviewed"`,
`cacheClaim: "not-claimed"`, and `isaClaim: "not-claimed"` until that review
happens.

## Supersession boundary

This decision supersedes decision 0003 only for this separate opt-in
full-system and cycle-model path. Decision 0003 continues to govern the default
portable-C emulator, its user interface, and the differential harness.
Decision 0006 continues to govern the shadow ledger and its accounted-events
claim.

No model output becomes a default UI performance measurement, a release
criterion, or a statement about real-device responsiveness until its coverage,
calibration, and hardware acceptance criteria are documented and satisfied.

## Current blockers

- The pinned flexe interpreter has a bounded ESP32-S3 patch, not a complete LX7
  core. The current ELF inventory contains 74 unsupported raw mnemonics: 38 PIE
  `ee.*` forms, 35 user-register forms, and undecodable `.byte` rows. Static
  decoder coverage is not execution coverage.
- The experiment loads bounded real-ELF `PT_LOAD` pages and reaches the first
  reset-path ROM call. It does not yet provide that ROM, the complete ESP32-S3
  data map, interrupt matrix, peripherals, or an ESP-IDF boot.
- The address, cache, and timing-machine components accept explicit
  architecture and cost sources, but their current ESP32-S3 claims remain
  uncalibrated. Cache geometry, fill latency, replacement behavior, write
  behavior, and shared MSPI arbitration still need silicon evidence.
- Dual-core architectural interleaving, interrupts, DMA ordering, cache
  coherence, and flash and PSRAM contention are not yet derived from a real
  instruction execution stream.
- Hardware receipts currently describe bounded CCOUNT microbenchmarks. Their
  translation into instruction, cache, memory, and arbitration costs remains
  unreviewed, and whole-program coverage has not been demonstrated.
- There is no silicon correlation suite with declared error bounds and pass or
  fail criteria for representative firmware workloads.

The [execution-core survey](../research/esp32s3-execution-core-survey.md) and
the [flexe experiment](../../experiments/esp32s3-flexe-wasm/) record the
current evidence and implementation gaps. Reaching `cycleAccurate: true`
requires closing these blockers with reproducible hardware results, not
changing the label.

## Consequences

The repo can develop the full-system path in small, testable pieces without
making the default emulator carry its complexity or claims. Structural model
results remain useful for exposing unknowns, contention, and accounting gaps
while their status remains explicit.

The board remains the authority. Differential tests continue to establish
behavioural agreement, and hardware receipts and correlation tests establish
the evidence boundary for any future timing claim.
