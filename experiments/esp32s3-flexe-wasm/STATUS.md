# ESP32-S3 emulator status

This is the central ledger for the cycle-accurate ESP32-S3 work in this fork.
The canonical checkout is `/Users/sarah/src/a/puck-cycle-accurate`,
the integration branch is `codex/esp32s3-timing-model`, and the GitHub remote is
`aliceisjustplaying/puck`.

## 2026-08-31 course correction

All parallel lanes are STOPPED by the maintainer pending redirection. An
adversarial architecture review produced three accepted decisions and one
measurement experiment:

- [`0008-tiered-cost-vocabulary-and-acceptance-bounds.md`](../../docs/decisions/0008-tiered-cost-vocabulary-and-acceptance-bounds.md):
  exact/affine/interval/distribution/unexplained cost tiers, workload-tiered
  acceptance bounds (exact on SRAM kernels, 1 percent on frame workloads,
  distributions on RTC and long cold windows).
- [`0009-execute-the-real-rom.md`](../../docs/decisions/0009-execute-the-real-rom.md):
  vendor Espressif's Apache-2.0 `esp32s3_rev0_rom.elf` and execute it; the
  ROM-callback whitelist becomes a differential replay corpus. The ROM
  lane's unintegrated 943-instruction checkpoint is not merged.
- [`0010-jit-first-engine-real-time-requirement.md`](../../docs/decisions/0010-jit-first-engine-real-time-requirement.md):
  real time on M1-class hardware is a hard requirement; production engine
  is Rust-to-wasm with runtime block translation; flexe becomes the
  reference interpreter; the TypeScript timing machine becomes the
  reference model.
- [`../esp32s3-browser-speed/`](../esp32s3-browser-speed/README.md):
  measured V8 interpreter throughput (109 MIPS), JIT ceiling (about 4,600
  emulated MIPS), block compile cost (negligible), boot size (0.58 s to
  first app output, order 10^7 to 10^8 cycles), and cross-boot receipt
  spread (short windows bit-repeatable, long cold window 0.10 percent).

The core-timing hardware probes ran on 2026-08-31 (two boots, headline
numbers boot-identical): window overflow/underflow pair 35 cycles per
spilled frame past depth 6; straight-line ALU issue 1.000 cycles per
instruction regardless of width mix or serial dependency; zero-overhead
loop bodies at +3 mod 4 pay +1 cycle per iteration (+0/+1/+2 do not);
interrupt entry 228 cycles and resume 142 through the ESP-IDF level-1
dispatcher (223/138 at level 3), min = median across 33 samples. Method,
ELF-verified encodings, raw logs, and hashes:
`tinydraw/calibration/esp32s3-core-timing/README.md`. All remain
unreviewed candidates in decision 0008 tier terms.

The phase plan, agent-hour estimates, dependency graph, and restart lane
allocation live in [`docs/roadmap.md`](../../docs/roadmap.md).

2026-08-31, later the same day: decision
[`0011`](../../docs/decisions/0011-adopt-esp32sim-execution-foundation.md)
adopts [esp32sim](https://github.com/joakimeriksson/esp32sim) as the
execution foundation and supersedes the restart plan below where it
concerned building an engine here. This experiment is now REFERENCE
MATERIAL: its fixture corpus, baselines, and bounded-boot evidence feed
the esp32sim measured-mode work; no further flexe capability lanes. An
external adversarial review the same day
([`docs/reviews/2026-08-31-external/`](../../docs/reviews/2026-08-31-external/RESPONSE.md))
produced decision
[`0012`](../../docs/decisions/0012-trust-model-and-backend-adapter.md)
(trust model, backend adapter, CPU-level observation) and roadmap lanes G
and H. The roadmap's revision 3 is authoritative.

Lane redirections when work resumes: boot lane moves from MMIO whitelists
toward peripheral models with reset-value provenance; ROM lane moves to
real-ROM loading; ISA lane adds a silicon-oracle fixture corpus (the board
is the referee, one owner at a time); timing lane implements decision
0008's tiers.

## 2026-08-31 ESP-IDF 6.1 flag day

Lane zero rebuilt the panel, demo, gate-harness, timing, and core-timing
fixtures with ESP-IDF v6.1 and xtensa-esp-elf 15.2.0. The persistent fixture
hashes, code addresses, ISA inventories, direct-boot contracts, and execution
baselines now pin that toolchain. Historical v6.0.2 receipts remain scoped to
their original pins.

The silicon-architectural headlines remain 35 cycles per spilled window pair,
1.000 cycles per straight-line instruction, and the same loop-alignment and
MMIO slopes. IDF-owned timing changed as recorded: level-1 entry/resume moved
228/142 to 227/143, level-3 moved 223/138 to 222/139, and median boot to first
output moved from 0.582 s to 0.472351875 s. The cache ladders showed a
systematic one-cycle first-line probe shift that is retained as a diagnostic,
not adopted as a chip-cost change.

Four timing boots recovered 802 passing receipts across 210 identities. The
strict two-independent-receipt criterion is complete for 204 identities and
incomplete for six. Two have zero receipts and four have one receipt because
of repeated USB capture truncation. The exact identities, raw captures,
deterministic receipt archives, hashes, and toolchain delta are in
[`idf61-rebaseline-3db3985`](../../packs/esp32-s3-touch-amoled-18/timing/evidence/idf61-rebaseline-3db3985/README.md).

## Lane B handoff

The local esp32sim fork commit
`e22f971430bdd40681c729deebf93a3a6fe799cb` contains the interpreter-only,
networking-off interface specification against real esp32sim code. It defines
the fork-owned Rust adapter and browser interface, bounded artifact streaming,
pre-allocation quotas, primary guest-output validation before event
construction, persistent mid-instruction scheduling, typed device deadlines,
block-batched CCOUNT, CPU-backend observation, and a receipt-pinned timing
ledger. It contains no product implementation.

The contract carries the exact A-01/E raw efuse and strap, complete raw OpenOCD
reset-register capture, separately hash-pinned canonical applied subset, filter
receipt, and adoption-receipt identity. The raw capture is provenance and is
never applied; only the derived subset reaches `Peripherals::init_regs`.
Product boot requires the hash-pinned real mask ROM and exact complete flash
image. HLE direct-app boot is a distinct non-product capability. Pending data
access occurs after same-cycle device, DMA, and input events and fails closed on
an impact that could change its value, fault, match, or side effect. Per-call
ledger deltas extend a canonical cumulative chain independent of run slicing.

The companion decision draft remains explicitly unaccepted. It proposes exact
amendments to decision 0011's role of Puck, decision 0012's Puck-owned adapter
wording, and roadmap revision 4 for maintainer review. It assigns the web UI
shell to the esp32sim fork and recommends Puck `docs/decisions` as the
cross-lane decision home. Until accepted, the existing decisions and roadmap
remain authoritative. The schema-1 `timing.json` affine MMIO `3n - 8` claim
remains a fail-closed blocker because the scalar profile loses the intercept
and no reviewed event-scoped resolver exists.

Lane zero's ESP-IDF 6.1 rebaseline also leaves the pooled single-core first-line
cache class blocked pending probe diagnosis. The reported 204 to 203, 115 to
114, and 82 to 81 cycle shifts must not enter the importer. Subsequent-line
266, 473, and 170 cycle observations and unchanged MMIO observations remain
eligible only through committed, accepted, exact-toolchain receipts.

## Lane G handoff

Lane G's primary fork deliverable is on local esp32sim branch
`lane-g/ci-spec`: commit `196727d` adds mandatory Xtensa LX7 and RISC-V RV32IMC
objdump corpora with provenance, visible SHA-256 and executed-case counts, and
fail-closed handling; commit `6ba6a6d` adds the pinned Rust 1.98.0 CI matrix,
action and ROM pins, verification contract, and rustfmt receipt. The same work
is prepared without fork provenance on upstream-shaped branch
`lane-g/upstream-ci` at commits `4762edc` and `3b58cc6`.

A clean verification passed focused formatting, CI policy, workspace tests,
clippy, and both mandatory decoder jobs. The logs reported 10 Xtensa cases at
SHA-256
`7e684d22347931c81770ddbea6c7fb1878542c8fecc0dc51340edcfc8b1c591f`
and 9 RISC-V cases at SHA-256
`d6ee3d1719bd31eb878667c6b742d5597d50e73cc9bc75ce4ce1efade59933ab`,
with zero mismatches. Deliberate mutable-action, unverified-download,
missing-corpus, and empty-corpus defects all failed their boundary checks.

The sole lane G exit blocker is pre-existing whole-tree rustfmt debt. At fork
base `aa851249`, `cargo fmt --all -- --check` exits 1 with 893 diff hunks across
39 files. Lane G checks every Rust file it touched but does not claim the full
Rust-format exit criterion. Maintainer disposition is required for the
existing product-wide rewrite. Nothing was pushed and no hardware was used.

## Lane A handoff

The exact-board capture request
[`A-01`](../../docs/lanes/requests/A-01-v2-controller-and-identity.md) is
specified and executable. Its identity capture is accepted for the current
lane 0 device window. A logic-analyzer capture that resolves the approximately
40 MHz QSPI bus, TE, I2C, and touch interrupt remains required before panel or
touch controller modeling begins. The synchronous GP-SPI board-response hook
is an unmerged, upstream-shaped esp32sim candidate at commit `246c699`.

## Lane E handoff

The frontloaded silicon-oracle batch is specified in
[`E-01`](../../docs/lanes/requests/E-01-frontloaded-board-batch.md). The
esp32sim release build and the retained upstream 3,000-step comparison are
ready offline. Lane E validated the A-01 identity bundle and completed two
independent upstream 8,000-step JTAG sessions. Both had no PC divergence and
zero timing resynchronizations, and both retained the same one register
difference at step 15. The full result and claim boundary are in
[`E-01-jtag-lockstep`](../../docs/lanes/receipts/E-01-jtag-lockstep.md).
No flash write occurred. Lane E restarted the installed ESP-IDF 6.1 gate
harness and released the board.

Lane 0's four ESP-IDF 6.1 raw runs reached all 210 measurement-group starts.
Strict recovery gives at least two receipts to 204 groups: 186 have four and
18 have three. Contended `rtc_xtal_freq` and core1 reset-reason groups have
none. Contended `rtc_date`, single-core `rtc_date`, contended `rtc_store1`,
and contended core0 reset-reason groups have one each. The long-window PSRAM
cells appear complete in the raw logs; lane E will reuse them only after
strict assembly confirms at least two eligible boots. Arbitration
discrimination and cache store or writeback captures remain blocked on
reviewed probe code. CCOUNT comparison remains blocked on lane B's measured
mode. A-01 panel and touch capture still requires the external logic analyzer
and physical landmark evidence. No lane C request is currently filed.

## Integrated checkpoint

- Baseline commit: `c1b91b23` (QACC, ROM/REGI2C, and browser runner integrated).
- Real ESP-IDF boot: 940 instructions and 1,228 trace records, stopping at the
  eleventh `_xtos_set_intlevel` boundary.
- Timing replay: 2,288 events, 2,254 classified, 34 unknown, and 10 exact ROM
  callbacks.
- ISA coverage: 65,143 supported rows and 753 gaps in the panel corpus; 1,651
  unsupported rows in the full corpus.
- WebAssembly module: 93,998 bytes, SHA-256
  `27e547da2868c6661c7f397a43a9fb27c08c9c76b839d85ef9f0558e9777f366`.
- Browser smoke: a real browser loads the freestanding module and a bounded
  Xtensa ELF, executes one instruction, and returns `a3 = 40` at `0x40371003`.
- Gates: aggregate experiment suite, 293 Bun tests, headless Chrome verifier,
  root typecheck, and
  experiment typecheck pass.

The integrated boot now accepts the first `esp_rom_regi2c_write_mask` DR1
callback. All lanes are stopped; the course-correction section above and
[`docs/roadmap.md`](../../docs/roadmap.md) define the restart plan and
lane redirections.

## Persistent fixtures

- ESP-IDF v6.1 panel-probe ELF: SHA-256
  `143e9f5185d010a8b5344ee5ed2c82a99928dba6839a84d746219d9045de468f`.
- ESP-IDF v6.1 vector demo ELF: SHA-256
  `1b0475db6ab30e1e6b6ee07ae77ae46b21c874cac64a736e5ba86604a68234ce`.
- ESP-IDF v6.1 gate-harness ELF: SHA-256
  `4e121a3642a6f18766cfe96c2be6adc8a0017fba4afa82105d642168ea40e2c8`.
- All three fixtures pin TinyDraw `3db39856f0a04266a42aef8cd5ead1be6fc8eca4`.

The reboot removed temporary `/private/tmp` ELFs. Fixture provenance and code
addresses were rebaselined to the persistent clean builds; behavioral and code
byte assertions remain enforced.

## Verification

Run the complete experiment gate from the repository root:

```text
bun run experiments/esp32s3-flexe-wasm/test.ts
```

The experiment README contains the focused inventory, boot, replay, and build
commands.
