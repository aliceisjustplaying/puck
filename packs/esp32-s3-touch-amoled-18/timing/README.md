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
| Resource execution scheduler | [`execution.ts`](execution.ts) | Orders explicit events from two cores and DMA, including shared MSPI use. Unknown durations block dependent work instead of becoming guessed cycles. |
| Address model | [`address-map.ts`](address-map.ts) | Resolves mapped, aliased, split, permission-checked SRAM, PSRAM, flash, and MMIO accesses. Its ESP32-S3 architecture source remains uncalibrated. |
| External-memory MMU | [`mmu.ts`](mmu.ts) | Translates explicit 512-entry, 64 KiB ESP32-S3 IROM/DROM page tables to flash or PSRAM without assuming reset mappings or adding latency. |
| Cache model | [`cache.ts`](cache.ts) | Maintains per-core instruction caches and the ESP32-S3's shared data cache, and emits hits, misses, fills, writebacks, and maintenance work. Geometry, policies, and costs are supplied explicitly and remain uncalibrated unless evidence says otherwise. |
| Timing machine | [`machine.ts`](machine.ts) | Composes an explicit two-core architectural interleave, address resolution, cache emissions, DMA, and resource scheduling into stable JSON with cost provenance and unknowns. It is not an instruction decoder or a full chip. |
| Runtime trace seam | [`runtime-trace.ts`](runtime-trace.ts) | Converts ordered interpreter fetch, load, store, and explicit DMA callbacks into immutable timing-machine input without inventing missing events or costs. |
| Hardware receipt adoption | [`calibration.ts`](calibration.ts) | Strictly parses clean ESP32-S3 hardware receipts, exact 32-bit CCOUNT wraparound samples, metadata, and matching multi-boot cohorts. It emits deterministic candidate statistics only. |
| Evidence report CLI | [`calibration-report.ts`](calibration-report.ts) | Reads receipt JSON files or flat directories, retains receipt and boot-log hashes, and writes byte-stable candidate JSON with exact integers and rationals as decimal strings. Adoption stays `unreviewed`; cache and ISA calibration are not claimed. |
| Xtensa WebAssembly experiment | [`../../../experiments/esp32s3-flexe-wasm/`](../../../experiments/esp32s3-flexe-wasm/) | Executes a real TinyDraw RGB565 kernel through Puck's loader with a bounded instruction and data-access trace, then replays it through this timing machine. |

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

The first hardware candidate is checked in as
[`evidence/esp32s3-rev02-tinydraw-d81e2ea-candidate.json`](evidence/esp32s3-rev02-tinydraw-d81e2ea-candidate.json).
It contains 56 receipts from two independent clean boots, 28 measurement
candidates, and 200 samples per candidate. It pins both boot IDs, receipt
hashes, and raw boot-log hashes. The source board ran at 240 MHz with 80 MHz
octal PSRAM and 80 MHz QIO flash. Its adoption status remains `unreviewed`.

## What remains before a cycle-accurate claim

- A complete ESP32-S3 LX7 execution core is missing. The pinned flexe core is
  LX6, and the current real-ELF inventory has 47 unsupported raw mnemonics,
  including 41 PIE `ee.*` forms. The `.byte` rows and dynamic instruction
  coverage still need resolution.
- The flexe runner has bounded code, source, and destination pages, not the
  ESP32-S3 data map, ROM, ESP-IDF boot, interrupt matrix, peripherals, or real
  dual-core execution.
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
