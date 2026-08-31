# ESP32-S3 timing lab

This directory is the ESP32-S3 pack's opt-in timing work. It does not change
Puck's default portable-C emulator. Every current aggregate timing result is
uncalibrated, the profile says `cycleAccurate: false`, and host trace time is
not simulated chip time.

[`../timing.json`](../timing.json) is the device profile and machine-readable
claim boundary. It records configured CPU, PSRAM, and flash clocks, the measured
panel bus clock, measured cache-line fill ladders, steady-state instruction
issue, independent SRAM access costs, and explicit calibration state. These
bounded costs do not calibrate cache hits, dependent pipeline hazards,
interrupts, peripherals, or the whole-machine result.

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
| Runtime replay CLI | [`runtime-report.ts`](runtime-report.ts) | Replays a strict JSON artifact of runtime instruction/read/write callbacks over exact caller-declared SRAM regions. It adopts only the profile's measured issue and independent SRAM costs, retains instruction-fetch costs as unknown, and emits the timing machine's partial claim. |
| Hardware receipt adoption | [`calibration.ts`](calibration.ts) | Strictly parses clean ESP32-S3 hardware receipts, exact 32-bit CCOUNT wraparound samples, metadata, and matching multi-boot cohorts. It emits deterministic candidate statistics only. |
| Evidence report CLI | [`calibration-report.ts`](calibration-report.ts) | Reads receipt JSON files or flat directories, retains receipt and boot-log hashes, and writes byte-stable candidate JSON with exact integers and rationals as decimal strings. Adoption stays `unreviewed`; cache and ISA calibration are not claimed. |
| Xtensa WebAssembly experiment | [`../../../experiments/esp32s3-flexe-wasm/`](../../../experiments/esp32s3-flexe-wasm/) | Executes a real TinyDraw RGB565 kernel through Puck's loader with a bounded instruction and data-access trace, then replays it through this timing machine. |

The neutral adapter's optional `cpuCost` is an additive local-core duration
after that instruction's fetch and data group. Its caller must exclude memory
work already modeled by those events. Omission becomes an explicit unknown
cost; the adapter does not decode an instruction or choose a fallback cycle
count.

## Store buffer boundary

An execution `store` remains blocking by default. A caller can opt it into the
one-entry buffer for its core by supplying `storeBuffer.retirementLatency`.
That explicit latency retires the store locally, while the store's ordinary
`latency` drains the entry through its normal SRAM or shared MSPI resource.
Independent work on the same core may proceed after retirement. A later
store and an explicit `memw` fence wait for the entry to drain. The fence also
carries a caller-supplied latency, and unknown retirement, drain, or fence costs
remain unknown.

The neutral trace adapter leaves this mode disabled unless its caller supplies
both `retirementLatency` and `memwLatency`. Enabling it requires a complete
non-overflow trace, an exact instruction word for every instruction, and the
issuing instruction PC for every data record. Only the three-byte instruction
word `0x0020c0` is classified as Xtensa `memw`; a width collision is rejected.
Every opted-in write must resolve to exactly one cache store emission. Split,
MMIO, write-through, or eviction cases that emit zero or multiple stores are
rejected because the one-entry model cannot represent them atomically.

## Line-fill burst boundary

`costs.lineFill` still accepts one known or unknown scalar cost, and still
accepts instruction/data costs scoped by flash/PSRAM. A scoped cost may now
provide `firstLineLatency` and `subsequentLineServiceInterval`. Both values are
ordinary explicit cache latencies with their own calibration and source.

A burst candidate is a maximal sequence of cache-miss line fills in the cache
machine's architectural issue order. The local hit emitted for a newly filled
segment does not break that candidate. A hit-only segment, address gap or
reversal, core change, instruction/data cache change, flash/PSRAM switch, SRAM
or uncached access, dirty writeback, write-through, or cache maintenance starts
a new candidate.

The execution scheduler selects the actual first-line or subsequent-line cost
when the fill starts service on the shared MSPI clock. A subsequent interval is
used only when the immediately preceding serviced MSPI event belongs to the
same candidate and its line address is exactly one line size lower. Intervening
DMA or another MSPI client therefore restarts the fill cost. This classifies
only requested misses. It does not add a prefetch or reserve MSPI beyond the
emitted events.

The ledger report consumes a built emulator:

```sh
bun run packs/esp32-s3-touch-amoled-18/timing/report.ts <emu.wasm>
```

The runtime replay CLI consumes a bounded callback artifact through the same
neutral adapter and timing machine used by interpreter experiments:

```sh
bun run pack:esp32:timing:replay runtime-trace.json
```

The version 1 artifact contains one source string, capacity and overflow,
exact internal-SRAM regions with permissions, and a total sequence of
instruction, read, and write observations. Addresses are canonical lowercase
hexadecimal strings. The interface intentionally does not describe flash,
PSRAM, MMIO, DMA, literal loads, store buffers, or pipeline dependencies.
Those facts are refused as schema drift until the runtime artifact can report
them exactly. A valid trace still reports internal-SRAM instruction-fetch cost
as unknown, so it emits no total cycle value and its claim remains partial,
uncalibrated, and `cycleAccurate: false`.

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

- A complete ESP32-S3 LX7 execution core is missing. The pinned flexe core has a
  bounded S3 patch and fail-closed markers for 1,985 decoded inventory gaps.
  Static inventory is not whole-program execution coverage.
- The flexe runner loads bounded real-ELF `PT_LOAD` pages and reaches 249 real
  instructions through 11 cache ROM callbacks and two source-backed SYSTEM
  reads. It does not provide the complete ESP32-S3 data map, interrupt matrix,
  peripherals, ESP-IDF boot, or real dual-core execution.
- Cache-store hits, dependent load-use modeling, dirty writeback, DMA ordering,
  interrupts, and dual-core correlation still need hardware-backed treatment.
  Hot zero-miss instruction fetches and flash/PSRAM loads have adopted zero
  additive costs. The exact opt-in Flexe classifier covers observed register
  dependencies, while general runtime traces still lack that vocabulary.
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
