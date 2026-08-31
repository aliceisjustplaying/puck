# ESP32-S3 timing lab

This directory is the ESP32-S3 pack's opt-in timing work. It does not change
Puck's default portable-C emulator. Every current aggregate timing result is
uncalibrated, the profile says `cycleAccurate: false`, and host trace time is
not simulated chip time.

[`../timing.json`](../timing.json) is the device profile and machine-readable
claim boundary. It records configured CPU, PSRAM, and flash clocks, the measured
panel bus clock, and explicit calibration state. A configured or measured clock
does not calibrate the scheduler, cache, ISA, memory latency, or whole-machine
result.

## What is here

| Surface | Files | Current claim |
| --- | --- | --- |
| Instrumented shadow ledger | [`consumer.ts`](consumer.ts), [`report.ts`](report.ts) | Strictly decodes optional `emu_timing_*` WebAssembly exports and reports allocation, memory, panel, and CPU observations. Only instrumented events are counted. Missing exports are reported as absent. |
| Producer and panel scheduler | [`model.ts`](model.ts) | Deterministically schedules strips on separate CPU-producer and panel-DMA clocks with bounded queue depth and exact rational time. Any unmeasured input keeps the result uncalibrated. |
| Resource execution scheduler | [`execution.ts`](execution.ts) | Orders explicit CPU and memory events from two cores plus DMA, including shared MSPI use. Unknown durations block dependent work instead of becoming guessed cycles. |
| Address model | [`address-map.ts`](address-map.ts) | Resolves mapped, aliased, split, permission-checked SRAM, PSRAM, flash, and MMIO accesses. Its ESP32-S3 architecture source remains uncalibrated. |
| External-memory MMU | [`mmu.ts`](mmu.ts) | Translates explicit 512-entry, 64 KiB ESP32-S3 IROM/DROM page tables to flash or PSRAM without assuming reset mappings or adding latency. |
| Cache model | [`cache.ts`](cache.ts) | Maintains per-core instruction caches and the ESP32-S3's shared data cache, and emits hits, misses, fills, writebacks, and maintenance work. Geometry, policies, and costs are supplied explicitly and remain uncalibrated unless evidence says otherwise. |
| Timing machine | [`machine.ts`](machine.ts) | Composes an explicit two-core architectural interleave, address resolution, cache emissions, DMA, and resource scheduling into stable JSON with cost provenance and unknowns. It is not an instruction decoder or a full chip. |
| Runtime trace seam | [`runtime-trace.ts`](runtime-trace.ts) | Converts ordered interpreter fetch, load, store, and explicit DMA callbacks into immutable timing-machine input without inventing missing events or costs. |
| Neutral trace adapter | [`trace-adapter.ts`](trace-adapter.ts) | Converts a bounded, provenance-carrying instruction/read/write trace with explicit cores and total order into the runtime trace seam. Each instruction group gets one local CPU event with caller-owned or explicitly unknown cost. Literal loads and DMA remain explicit extensions. |
| Hardware receipt adoption | [`calibration.ts`](calibration.ts) | Strictly parses clean ESP32-S3 hardware receipts, exact 32-bit CCOUNT wraparound samples, metadata, and matching multi-boot cohorts. It emits deterministic candidate statistics only. |
| Evidence report CLI | [`calibration-report.ts`](calibration-report.ts) | Reads receipt JSON files or flat directories, retains receipt and boot-log hashes, and writes byte-stable candidate JSON with exact integers and rationals as decimal strings. Adoption stays `unreviewed`; cache and ISA calibration are not claimed. |
| Xtensa WebAssembly experiment | [`../../../experiments/esp32s3-flexe-wasm/`](../../../experiments/esp32s3-flexe-wasm/) | Executes a real TinyDraw RGB565 kernel through Puck's loader with a bounded instruction and data-access trace, then replays it through this timing machine. |

The neutral adapter's optional `cpuCost` is an additive local-core duration
after that instruction's fetch and data group. Its caller must exclude memory
work already modeled by those events. Omission becomes an explicit unknown
cost; the adapter does not decode an instruction or choose a fallback cycle
count.

## Line-fill burst boundary

`costs.lineFill` still accepts one known or unknown scalar cost, and still
accepts instruction/data costs scoped by flash/PSRAM. A scoped cost may now
provide `firstLineLatency` and `subsequentLineServiceInterval`. Both values are
ordinary explicit cache latencies with their own calibration and source.

A burst is a maximal sequence of cache-miss line fills in the cache machine's
architectural issue order. The next fill uses the subsequent-line interval only
when it is for the same core, cache kind, and backing path, and its line address
is exactly one line size above the preceding fill. The local hit emitted for the
same newly filled segment does not break the sequence. A hit-only segment,
address gap or reversal, core change, instruction/data cache change,
flash/PSRAM switch, SRAM or uncached access, dirty writeback, write-through, or
cache maintenance starts a new burst. This classifies only requested misses. It
does not add a prefetch or reserve MSPI beyond the emitted events. The execution
scheduler continues to arbitrate every emitted flash and PSRAM event on its one
shared two-core MSPI clock.

The ledger report consumes a built emulator:

```sh
bun run packs/esp32-s3-touch-amoled-18/timing/report.ts <emu.wasm>
```

The calibration report accepts receipt files and flat directories. At least
two distinct boot IDs with matching cohort metadata are required for a
candidate:

```sh
bun run packs/esp32-s3-touch-amoled-18/timing/calibration-report.ts \
  receipt-a.json receipt-b.json
bun run packs/esp32-s3-touch-amoled-18/timing/calibration-report.ts \
  --output candidate.json receipts/
```

The receipt lane does not import TinyDraw. It consumes the documented JSON
boundary and rejects dirty builds, schema drift, mismatched toolchain or
sdkconfig metadata, duplicate boots or measurements, and unequal per-boot
sample counts. Candidate quantiles and cycles-per-byte ratios do not mutate
`timing.json`.

Samples may also carry strict ESP32-S3 cache-counter deltas as
`cacheCounters: { ibus: { accesses, misses }, dbus: { accesses, flashMisses,
psramMisses } }`. All five values are uint32, and every sample in a measurement
must either include the block or omit it. Bounded probes reject instruction
misses above instruction accesses and combined data misses above data accesses;
the receipts do not encode hardware-counter overflow. Counter-enabled candidate
reports add exact value quantiles, an ordered five-counter predictor vector, the
full symmetric predictor Gram matrix, and exact totals of counters, squared
counters, cycles, squared cycles, and counter-times-cycles. Together with the
sample count, these are the sufficient statistics for multivariate linear-model
coefficients and residual sums of squares. They do not make a cache calibration
claim. Reports from older receipts remain byte-identical.

The first hardware candidate is checked in as
[`evidence/esp32s3-rev02-tinydraw-d81e2ea-candidate.json`](evidence/esp32s3-rev02-tinydraw-d81e2ea-candidate.json).
It contains 56 receipts from two independent clean boots, 28 measurement
candidates, and 200 samples per candidate. It pins both boot IDs, receipt
hashes, and raw boot-log hashes. The source board ran at 240 MHz with 80 MHz
octal PSRAM and 80 MHz QIO flash. The exact input receipts are retained under
[`evidence/receipts/`](evidence/receipts/), so the report can be regenerated
byte for byte. Its adoption status remains `unreviewed`.

## What remains before a cycle-accurate claim

- A complete ESP32-S3 LX7 execution core is missing. The pinned flexe core now
  has a bounded S3 patch, but the current real-ELF inventory still has 74
  unsupported raw mnemonics: 38 PIE `ee.*` forms, 35 user-register forms, and
  undecodable `.byte` rows. Static inventory is not whole-program execution
  coverage.
- The flexe runner loads bounded real-ELF `PT_LOAD` pages and reaches the first
  reset-path ROM call. It does not provide that ROM, the complete ESP32-S3 data
  map, interrupt matrix, peripherals, ESP-IDF boot, or real dual-core execution.
- Cache geometry and behavior, SRAM latency, flash and PSRAM fills, shared MSPI
  arbitration, DMA ordering, interrupts, and dual-core interleaving need
  hardware-backed sources and correlation.
- Hardware receipts are bounded CCOUNT microbenchmarks. Mapping them to
  architectural instruction, cache, or bus costs remains
  `microbenchmarkToArchitecturalCost: "unreviewed"`.
- The current ledger observes explicit events only. There is no demonstrated
  whole-program coverage or silicon correlation suite with declared error
  bounds and acceptance criteria.

These blockers keep every whole-machine result uncalibrated and
`cycleAccurate: false`. Decisions
[`0006`](../../../docs/decisions/0006-opt-in-esp32s3-timing-lab.md) and
[`0007`](../../../docs/decisions/0007-opt-in-esp32s3-full-system-cycle-model.md)
define the shadow-ledger and full-system claim boundaries.

Run all timing tests from the repository root:

```sh
bun run pack:esp32:timing:test
```
