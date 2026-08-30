# 0006: An opt-in ESP32-S3 timing lab with explicit claim boundaries

Date: 2026-08-30
Status: accepted

## Context

Decision 0003 rejected turning Puck's behavioural instrument into a
cycle-accurate chip emulator. Its reasons still hold. Puck runs firmware source
through a WebAssembly compiler, not the ESP32-S3 binary through an Xtensa LX7
core. Ordinary WebAssembly loads and stores also bypass a capability allocator
after allocation, so allocation tags alone cannot reveal their cost.

There is still useful work between no timing information and a claim of full
chip accuracy. A device-specific lab can count explicitly instrumented work,
apply measured hardware profiles, and show which work remains unaccounted. That
can make performance hypotheses cheaper to test without changing what the
default instrument promises.

## Decision

Add an explicitly opt-in ESP32-S3 timing lab alongside the behavioural
instrument. The lab begins as a shadow ledger. It observes instrumented events
and may derive modeled resource time from them, but it does not control firmware
execution and does not call its result total execution time.

The normal Puck path remains unchanged. In particular, `emu_tick(nowMs)` keeps
receiving trace time from the host. Trace time says when recorded input arrives.
A future simulated chip clock says when modeled hardware work completes. They
are distinct values and must never share one counter or silently advance one
another.

The first hardware profile lives with the ESP32-S3 device pack in
`packs/esp32-s3-touch-amoled-18/timing.json`. It records facts and unknowns, not
guesses:

- two CPU cores configured for 240 MHz;
- octal PSRAM configured for an 80 MHz interface, with no general throughput
  claim yet;
- QIO flash, with its operating frequency and throughput explicitly unknown;
- the panel's measured 40 MHz quad-SPI line clock, whose four data lanes and
  16-bit pixels give a raw payload ceiling of 20 MB/s before transaction,
  staging, queueing, and scan-out costs.

Flash and PSRAM eventually share an MSPI and cache model. They must not be
treated as independent bandwidth sources. Panel DMA is asynchronous work and
must be representable as submission plus completion or wait, rather than as a
synchronous addition to a single global clock. CPU0, CPU1, internal SRAM, the
shared external-memory path, and panel DMA remain separate resources even when
the first ledger does not yet exercise all of them.

## Claim boundary

The timing profile carries a machine-readable `claimBoundary` object. For the
initial lab it states:

- the mode is `shadow-ledger`;
- the result is not cycle accurate;
- only instrumented events are counted;
- host trace time is not simulated hardware time.

A report must expose unaccounted work. It must not turn a partial byte ledger or
a calibrated bulk-copy rate into a total cycle count. A rate measured for one
kernel, such as a byte-swapping PSRAM staging loop, applies only to that kernel
until hardware evidence supports a wider claim.

## Consequences

This decision supersedes decision 0003 only far enough to permit the opt-in lab.
It does not weaken the behavioural instrument's default documentation or the
differential harness's role.

The profile can improve as measurements arrive without baking device constants
into `src/`. The pack owns its hardware facts. Generic Puck code, if added later,
may consume timing events and profiles but must not name this device.

Honest instruction-level cycle accuracy still requires a different execution
foundation, such as an ESP32-S3 binary running through a sufficiently accurate
Xtensa and memory-system model, or compiler instrumentation whose coverage and
calibration are demonstrated against the board. The shadow ledger is useful
before that choice because it measures accounting coverage without pretending
the choice has already been made.
