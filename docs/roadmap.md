# ESP32-S3 cycle-model roadmap

Date: 2026-08-31. Companion to decisions
[0008](decisions/0008-tiered-cost-vocabulary-and-acceptance-bounds.md),
[0009](decisions/0009-execute-the-real-rom.md), and
[0010](decisions/0010-jit-first-engine-real-time-requirement.md), and to the
course-correction section of
[`experiments/esp32s3-flexe-wasm/STATUS.md`](../experiments/esp32s3-flexe-wasm/STATUS.md).

## Definition of done

The puck page boots the board's real merged firmware image (real ELF plus
the vendored Apache-2.0 ROM ELF) on an emulated dual-core ESP32-S3 with
display, touch, and IMU, at real time on M1-class hardware, with cycle
accounting that passes a silicon correlation suite at the decision-0008
tiers: exact on SRAM-resident kernels, within 1 percent on frame-scale
workloads, distribution agreement on RTC and long-window PSRAM paths.

## Estimation basis

Estimates are in agent-hours, calibrated against measured throughput: the
entire current fork state (timing machine and tests, the flexe ISA patch
surface with fixtures, the 837-instruction boot, the receipt pipeline, the
device pack and ports) took about 12 agent-hours across parallel lanes, and
the 2026-08-31 review round (adversarial review, browser-speed benchmarks,
a flashed and debugged four-family hardware probe run) took about 2. Those
hours were mostly greenfield and parallel; two phases below are explicitly
serial and do not convert linearly.

## Phases

| Phase | Scope | Agent-hours | Parallelizes across lanes? |
| --- | --- | --- | --- |
| 1 | Vendor and execute the real ROM ELF; convert boot whitelists to a differential replay corpus; peripheral models (SYSTEM, EXTMEM, RTC_CNTL, REGI2C/BBPLL, interrupt matrix, TIMG, USB-SJ stub) from TRM reset values plus receipts; close ISA gaps the boot path hits. Milestone: the flexe path reaches the real image's `app_main`. | 8 to 16 | Yes, one lane per peripheral cluster |
| 2 | Throwaway co-simulation prototype (two cores, one shared resource, one timer interrupt) whose deliverable is the executor-to-timing interface spec: quantum length, arbitration resolution point, interrupt delivery point. Timing drives execution. | 1 to 3 | No, one designer |
| 3 | Rust engine, interpreter tier: Xtensa base ISA, windowed registers, loops, exceptions, the PIE subset the firmware uses; memory system, MMU, caches, MSPI ported from the TypeScript reference model; dual-core quantum scheduler per the phase 2 spec. Differential-tested against the TS machine, flexe, QEMU, and silicon fixtures. Milestone: reproduces the flexe boot replay and its timing event stream exactly; flexe retires to oracle duty. | 12 to 24 | Yes, per ISA family and per subsystem |
| 4 | JIT tier: block discovery, runtime wasm codegen with inlined cycle and cache accounting, window-pressure tracking (35 cycles per spilled frame), the loop-alignment rule (+1 cycle per iteration at +3 mod 4), idle skip on `waiti`, interpreter fallback. Milestone: real time on the hot-path benchmark; the measured 4,600 emulated-MIPS ceiling means 15 percent retention suffices. Checkpoint: a first measured version under about 500 emulated MIPS stops the lane for profiling before features. | 12 to 24, long-tail risk | Poorly: one artifact, debugging-heavy |
| 5 | Board peripherals for the UX goal: QSPI panel controller model with TE signal feeding puck's panel blitter, GDMA, touch controller on I2C, QMI8658 IMU, TCA9554 expander; wiring into the puck page. | 8 to 16 | Yes for the standalone models; wiring waits on phase 3 |
| 6 | Calibration completion (arbitration discrimination, ISA-on-silicon fixture corpus, PSRAM long-window distributions, cache store and writeback classes) and the correlation suite: representative workloads, declared bounds, pass or fail. Milestone: frame-render workload within 1 percent on the first honest run. | 6 to 12, hardware-serialized | No: one board, one owner, minutes per build-flash-capture cycle |
| 7 | Integration and ship: cycle emulator behind puck's freeze, replay, and regression UX; performance display; docs; publishing. | 4 to 8 | Partly |

Total: roughly 50 to 100 agent-hours. Demo milestone (real ELF plus real
ROM booting in a browser tab, panel drawing, interpreter speed): about 10
to 20 agent-hours in, at the end of phase 1 plus a thin display path.

## Toolchain currency

The project tracks the latest stable ESP-IDF. The board and fixtures
currently build with v6.0.2; v6.1 is already installed through eim. An IDF
bump is a provenance event, not a chore: every hardware receipt pins the
IDF version, sdkconfig hash, and compiler, and a new compiler changes
codegen and can shift measured costs.

The bump is lane zero of the restart, before phase 1 builds its corpus
and before phase 6 mass calibration, while rebaselining is still a two to
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

## Dependency graph and parallelism

There are only two hard blocking edges:

- Phase 2's interface spec blocks phase 3's scheduler sub-lane (and only
  that sub-lane; ISA and memory-system lanes start immediately).
- Phase 3's stabilized interpreter blocks phase 4 (the JIT needs a correct
  differential referee). Early JIT scaffolding against the browser-speed
  probe subset is permitted but carries rework risk.

Phase 3 does not wait for phase 1: the Rust ISA lanes work against the
existing fixture corpus and oracles, and the two phases meet later at the
"boot the real image in Rust" milestone. Phase 6's ISA-on-silicon corpus
is an accelerant for phase 3, since every silicon-verified fixture is a
Rust conformance test for free. Phase 5's models start immediately; only
their engine wiring waits. Running the correlation suite end to end waits
for phase 3; designing it does not.

The critical path is 2, then 3, then 4: roughly 25 to 50 agent-hours of
the total. Wall-clock completion is the critical path plus maintainer
review bandwidth plus the hardware queue, not the sum of the table.

Suggested restart allocation, chosen for near-zero file overlap between
lanes: two or three lanes on phase 1 (one per peripheral cluster), one on
phase 2 rolling into phase 3's scheduler, two or three on phase 3 ISA
families plus one on the memory-system port, one on phase 5 models, one
owning the board for phase 6 probes.

## Hardware access and cloud lanes

Coding lanes may run on cloud agents with no board access. The board gates
verification loops, not development, and those batch cleanly:

| Phase | Cloud-agent viable | What still needs the board |
| --- | --- | --- |
| 1 | About 95 percent: the ROM ELF is a download, reset values come from the TRM, the replay corpus is in git | Confirming a modeled reset value on silicon, batched as a receipt request |
| 2 | Fully | Nothing |
| 3 | About 90 percent: fixture corpus, TS reference model, flexe and QEMU oracles all build without hardware | Silicon-oracle ISA runs: cloud lanes author fixtures, the board owner executes them in batches |
| 4 | Fully for correctness | Performance gates: cloud Chrome numbers are directional only; the real-time requirement is defined on the maintainer's M1-class machine, so perf validation runs locally |
| 5 | Fully for the models (datasheets plus receipted facts) | Visual and tear-signal validation against the real panel, batched |
| 6 | Authoring and analysis only | The build-flash-capture loop itself; this phase is the hardware queue |
| 7 | Mostly | Final differential-harness runs against the board |

The receipts pipeline is the interface between the two worlds: cloud lanes
emit hardware request specs (probe firmware, fixture batches), the single
board-owner lane services the queue, and results land as committed,
hash-pinned receipt JSON that cloud lanes consume from git. No cloud lane
ever blocks on a cable.

One enabler must land before cloud lanes start on phase 3: the fixture
ELFs live in the tinydraw repository's machine-local `out/fixtures/`
worktrees, so a fresh clone holds hash-pinned references to files it
cannot obtain. Either attach the fixture ELFs to a release on the fork
with a download-and-verify path in
`experiments/esp32s3-flexe-wasm/constants.ts`, or commit pre-extracted
function bytes as small fixtures. `constants.ts` already honors a
`TINYDRAW_ROOT` override for checkouts that do have the sibling repo.
Cloud toolchain needs are all installable: bun, zig, Rust, the Xtensa
objdump, optionally an Espressif QEMU build. No hardware, no secrets.

## Standing rules

- Every adopted number keeps its receipt; refusals name their decision-0008
  tier candidate.
- The board is a one-owner-at-a-time resource; a second board, when
  connected, serves the phase 6 queue first.
- Phases 4 and 6 are scheduled, not parallelized. Adding lanes to phase 4
  produces merge conflicts, not speed.
- The correlation suite's first pass is scheduled; its residue is not. A
  workload missing its bound for an unmet reason is new work, and no past
  throughput calibration shrinks it in advance.
