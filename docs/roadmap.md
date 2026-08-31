# ESP32-S3 cycle-model roadmap

Date: 2026-08-31, revision 3. Revision 2 followed decision
[0011](decisions/0011-adopt-esp32sim-execution-foundation.md) adopted
[esp32sim](https://github.com/joakimeriksson/esp32sim) as the execution
foundation. Companion to decisions
[0008](decisions/0008-tiered-cost-vocabulary-and-acceptance-bounds.md)
(cost tiers), [0009](decisions/0009-execute-the-real-rom.md) (real ROM),
[0010](decisions/0010-jit-first-engine-real-time-requirement.md)
(engine requirements, now satisfied through 0011), and to
[`experiments/esp32s3-flexe-wasm/STATUS.md`](../experiments/esp32s3-flexe-wasm/STATUS.md).

## Definition of done (unchanged)

The product boots the board's real merged firmware image (real ELF plus
the real mask ROM) on an emulated dual-core ESP32-S3 with display, touch,
and IMU, at real time on M1-class hardware in a browser, with cycle
accounting that passes a silicon correlation suite at the decision-0008
tiers: exact on SRAM-resident kernels, within 1 percent on frame-scale
workloads, distribution agreement on RTC and long-window PSRAM paths.

## Architecture after 0011

- **Execution:** esp32sim's `xtensa-lx7` core and `esp32s3` SoC, pinned by
  commit. Fast mode is upstream's behavior, unchanged. **Measured mode**
  is this project's addition: calibrated cycle accounting through
  `advance_ccount`, per-block base costs in the block cache, cache and
  MSPI models, window-exception costs, and tighter dual-core interleaving
  quanta. Both modes share one core; fast mode's speed is never taxed by
  measured mode's bookkeeping. Observation is defined at the CPU backend
  level per decision 0012: the native JIT fast path bypasses the `Bus`
  trait (review F-031, `xtensa-lx7/src/block.rs:143,187`), so measured
  mode is interpreter-first and a cross-mode conformance program gates
  any JIT participation.
- **Calibration:** this repository's timing lab, receipts, and tier
  vocabulary are the only source of measured-mode costs. Unknown costs
  stay unknowns; totals stay blocked until their events are costed.
- **Verification:** upstream's JTAG lock-step harness for architectural
  agreement; this project's correlation suite for cycle-level agreement in
  measured mode; the interpreter-versus-JIT bit-identity rule for engine
  changes; the puck differential harness for pixel-level behavior.
- **UI:** puck's page, recorder, freeze, and regression layers wrap the
  machine where useful. Upstream ships its own web UI; convergence or
  replacement is decided late, on merit (see 0011, "The role of puck").
- **Upstream relationship:** contributions upstream where wanted (wasm
  JIT backend, boards, peripheral gaps), fork-carried where not (measured
  mode, if upstream prefers staying instruction-level). Contact with the
  author is open.

## Lane plan at a glance

| Lane | Scope | Agent-hours | Cloud-viable | Blocked by |
| --- | --- | --- | --- | --- |
| 0 | ESP-IDF 6.1 rebaseline of this project's receipts and fixtures (checklist below) | 2 to 4, plus one board session | No, needs the board | Nothing; unchanged by 0011 |
| A | Adoption and exact-board fidelity: pin esp32sim and fork; the `--board none` boot baseline is already recorded (`experiments/esp32sim-adoption/`). Implement the AMOLED-1.8 `BoardModel` for the maintainer's board revision exactly: CO5300-class QSPI panel device with GRAM, TE timing, and scan-out position (the GP-SPI2 master itself is already modeled upstream) (validated against the firmware's stated `te_edge=rising clock_mhz=40` contract, the measured 40 MHz receipts, and tinydraw's tearing classifiers), CST816S-family touch, QMI8658, PCF85063A, TCA9554 (upstream has it); adopt chip identity (efuses, strap, MAC, revision 2) from the physical board via upstream's JTAG flow. Radio, battery analog, and temperature stay out of scope. | 8 to 16 | Mostly; identity adoption and visual checks local | Nothing |
| B | Measured mode and the backend adapter (decision 0012): the Puck-owned adapter contract, observation defined at the CPU backend level (a `Bus` wrapper alone is insufficient, review F-031), interpreter-first execution, per-block cost sums, cache and line-fill models, window-exception and loop-alignment costs, tier-carrying cost types per decision 0008; differential-tested against the TypeScript timing machine on shared traces, with a cross-mode conformance program gating any JIT participation | 10 to 20 | Fully | Nothing (design spike first, see below) |
| C | Contention and co-simulation: measured-mode dual-core quanta, MSPI arbitration, interrupt-delivery timing; correlate against the contended receipt cohorts | 8 to 16 | Authoring yes; correlation runs local | Lane B core |
| D | wasm JIT backend, upstream-shaped: reach browser real time; re-measure against the browser-speed probes as guards accrue | 12 to 24, long-tail risk | Correctness yes; M1 perf gates local | Lane A working browser baseline |
| E | Silicon oracle operations: run upstream's JTAG lock-step harness against this project's board; extend it with CCOUNT-delta comparison for measured mode; remaining probe families (arbitration discrimination, PSRAM long-window distributions, cache store and writeback) | 6 to 12, hardware-serialized | Authoring and analysis only | Lane B for CCOUNT comparisons |
| F | Integration and ship: puck UX wrap (or successor UI), correlation suite passing at the 0008 bounds, docs, publishing; the external review's release-gate battery (SBOM, attestations, secret scanning, CSP, branch-policy audit, capability matrix) is this lane's checklist | 8 to 14 | Mostly | Lanes C, D |
| G | CI as the executable specification: required jobs for typecheck, unit, hostile, regression, browser smoke, Rust fmt/test/clippy, and fail-closed decoder conformance with committed mandatory corpus and case counts (review F-047/F-048/F-052/F-053/F-054) | 4 to 8 | Fully | Nothing |
| H | Boundary hardening scoped by decision 0012's trust model: one shared guest-output validator across live, headless, replay, and verifier paths; WASI-lite hardening; quotas; memory-view refresh; panic-free untrusted paths (review F-011 through F-014, F-074) | 6 to 12 | Fully | Nothing |

Total roughly 45 to 90 agent-hours (revision 1 estimated 50 to 100; lanes
1 and 3 collapsed into lane A's adoption cost; lanes G and H were added
from the accepted external-review findings, see
[`docs/reviews/2026-08-31-external/RESPONSE.md`](reviews/2026-08-31-external/RESPONSE.md)). The critical path is
B then C for accuracy, and D for browser real time; the two paths are
independent of each other. **Demo milestone: lane A alone boots the real
board image with the panel drawing in the browser at interpreter speed,
6 to 12 agent-hours in.**

The lane B design spike replaces the old co-simulation toy: a short,
throwaway branch in the esp32sim fork answering how timing-driven
execution, lazy device-time delivery, and block-batched CCOUNT reconcile
in measured mode, and where decision 0012's adapter and CPU-level
observation seams land in real code. Its deliverable is still an
interface spec, now written against real code instead of a toy, run
interpreter-only with networking off per the review's Milestone 3 shape.

## What retired, what carries over

Retired by 0011: the old lanes 1 (ROM and peripherals) and 3 (build the
interpreter), the flexe capability lanes (frozen as reference corpus and
oracle), the QEMU oracle as primary semantics referee (now tie-breaker).

Carried over unchanged: decision 0008's tiers and every adopted cost; the
timing lab and its evidence; the receipts pipeline and one-owner board
rule; the browser-speed probes as the performance yardstick; lane zero;
the hardware-versus-cloud boundaries below.

## Toolchain currency

The project tracks the latest stable ESP-IDF. The board and fixtures
currently build with v6.0.2; v6.1 is already installed through eim. An IDF
bump is a provenance event, not a chore: every hardware receipt pins the
IDF version, sdkconfig hash, and compiler, and a new compiler changes
codegen and can shift measured costs.

The bump is lane zero of the restart, while rebaselining is still a two to
four agent-hour job plus one board session. Checklist:

- rebuild the fixture ELFs under 6.1 and re-pin hashes, addresses, and
  the ISA inventory;
- rerun the existing receipt cohorts and confirm the silicon-architectural
  numbers (window pair, issue rate, loop alignment, cache ladders, MMIO
  costs) are bit-identical: they are chip claims and should not move, and
  any shift is a probe diagnostic, not a chip change;
- re-measure and re-pin everything that times IDF's own code (interrupt
  entry and resume through the dispatcher, boot-to-app_main), which is
  expected to change;
- one flag day, no mixing: v6.0.2 receipts remain valid historical
  evidence for their pinned toolchain, all new evidence is 6.1, and the
  6.0.2-versus-6.1 delta is retained as a toolchain-sensitivity receipt.

esp32sim itself is version-agnostic about application firmware (it boots
unmodified images), so lane zero concerns this project's receipts and
fixtures, not the emulator.

## Hardware access and cloud lanes

Coding lanes may run on cloud agents with no board access. The board gates
verification loops, not development:

| Lane | Cloud-agent viable | What still needs the board |
| --- | --- | --- |
| 0 | No | The rebaseline session itself |
| A | Mostly | Final panel and touch checks against the real device |
| B | Fully | Nothing; costs come from committed receipts |
| C | Authoring | Contended-cohort correlation runs |
| D | Correctness | M1 performance gates (cloud numbers are directional) |
| E | Authoring and analysis | The JTAG lock-step and probe sessions |
| F | Mostly | Final differential-harness runs |

The receipts pipeline remains the interface: cloud lanes consume
committed, hash-pinned evidence from git and emit hardware request specs;
the single board-owner lane services the queue. The fixture-distribution
enabler from revision 1 still applies (fixture ELFs as release artifacts
or committed extracts) and now also covers the esp32sim fork's test
firmware. A second board serves the lane E queue first.

## Standing rules

- Every adopted number keeps its receipt; refusals name their decision-0008
  tier candidate.
- The board is a one-owner-at-a-time resource.
- Fast mode is never slowed by measured mode; the two modes' outputs are
  differentially compared where they should agree (architectural state)
  and documented where they should not (time).
- Engine changes preserve upstream's interpreter-versus-JIT bit-identity
  rule; measured mode adds its own rule: same trace in, same cycle ledger
  out, deterministically.
- Upstream courtesy: fixes and capabilities upstream wants go upstream
  first; the fork carries only what upstream declines, in a clean patch
  stack with `PROVENANCE.md` from day one.
- Emulator networking defaults to none; live egress is opt-in and never
  available to gallery or external-bundle execution (decision 0012).
- No product code outside the adapter imports esp32sim internals; a
  dependency lint enforces it.
- Goldens carry semantic assertions and provenance sidecars; a
  conformance test whose corpus is missing fails, never skips.
- The correlation suite's first pass is scheduled; its residue is not.
