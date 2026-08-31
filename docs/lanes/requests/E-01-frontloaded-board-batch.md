# E-01: frontloaded silicon-oracle batch

Date: 2026-08-31
Owner: lane E after explicit coordinator handoff
Target: the maintainer's Waveshare ESP32-S3-Touch-AMOLED-1.8 V2

This batch consumes lane 0's ESP-IDF 6.1 receipts and the identity portion of
[`A-01`](A-01-v2-controller-and-identity.md). It does not mix ESP-IDF 6.0.2 and
6.1 evidence. Lane E must not open serial or JTAG, reset, halt, or flash the
board until the coordinator confirms that lane 0 has released it.

## Immutable inputs

Lane 0 must hand off these artifacts as one hash-pinned bundle:

- the complete ESP-IDF 6.1 timing-probe logs and strict receipts, including at
  least two complete boots for each retained measurement;
- raw OpenOCD efuse, strap, and reset-state dumps from one reset-halt session;
- complete `espefuse summary`, `esptool chip_id`, and `esptool flash_id`
  output;
- the exact 16 MB flash image, v6.1 gate-harness ELF and binary, `sdkconfig`,
  source commit, compiler version, tool versions, capture commands, UTC times,
  and SHA-256 hashes;
- the board product and V2 revision confirmation.

Lane E copies the bundle into its own result directory and never edits the
source artifacts. Before board work, validate every declared SHA-256, confirm
that all metadata says ESP-IDF 6.1, confirm chip revision 2 and 16 MB flash,
and verify that the raw reset-state file covers the register ranges required
by A-01. A capacity mismatch or mixed toolchain stops the batch.

The current lane 0 captures already report three complete 210-measurement,
100-sample boots at ESP-IDF 6.1. They contain complete
`psram_cold_sequential` and `psram_cold_random` cells in both `single_core`
and `core1_contended` modes. Treat those cells as reusable input. Repeat them
only if strict receipt assembly leaves fewer than two eligible boots.

## Readiness by work item

| Work item | Current executable surface | Disposition |
| --- | --- | --- |
| Identity adoption | A-01's existing esptool, espefuse, and OpenOCD commands | Ready through lane 0. No probe change. Preserve raw output, not only interpreted fields. |
| Upstream JTAG lock-step | esp32sim `hw/difftest.sh`, `hw/steptrace.py`, and `hw/compare.py`; release build verified locally | Ready after identity validation and board handoff. Use the exact A-01 flash, efuse, strap, and reset-state inputs. |
| Arbitration discrimination | The existing strict timing probe compares `single_core` with one `core1_contended` mode whose aggressor performs PSRAM reads | Blocked on reviewed probe code. The existing pair does not distinguish core scheduling, shared D-cache effects, or MSPI service, and has no aggressor progress count. Current tier is `unexplained`, not adoptable. |
| PSRAM long-window distributions | Lane 0's v6.1 strict `psram_cold_sequential` and `psram_cold_random` receipts, 100 samples per cell | Reuse and disposition as `distribution` candidates after strict cohort validation. No board repeat is currently planned. |
| Cache store hit | The old memory harness has a PSRAM sequential-write aggregate; the strict timing probe has only an internal-SRAM store-completion kernel | Blocked on reviewed probe code. Neither isolates a hot external-cache store hit. Candidate tier is `exact`. |
| Dirty writeback | Existing code can call `esp_cache_msync`, but no measured matched clean-versus-dirty line ladder exists | Blocked on reviewed probe code. Add 1, 2, 4, 8, and 16 dirty-line cells with a matched clean baseline and post-write verification. Candidate tier is `affine`; retain `unexplained` if residuals or cross-boot variance are not diagnosed. |
| A-01 panel and touch | Existing v6.1 gate harness plus external logic analyzer and physical touch landmarks | Firmware is ready. Capture is blocked until a ten-signal analyzer setup can resolve the approximately 40 MHz QSPI bus and the operator can record landmark notes or photos. A missing DMA descriptor hook is reported unavailable and requires a separately reviewed probe. |
| Lane C requests | No request file exists in `docs/lanes/requests/` | Nothing to capture. Recheck the directory immediately before the board session. |
| CCOUNT lock-step | No accepted measured-mode comparison interface exists | Blocked on lane B. Upstream `compare.py` deliberately resynchronizes CCOUNT-timed loops, so its current result is architectural only. |

## Board order

### 1. Validate identity, then run upstream JTAG lock-step

Resolve and record the exact OpenOCD and Xtensa GDB binaries before the run.
The machine currently has multiple OpenOCD installations, while upstream's
script selects the first glob match. Pin the resolved paths in the receipt and
retain complete stdout and stderr in addition to the script's filtered files.

Prepare a new result directory containing immutable copies of
`flash-16M.bin`, `efuse.txt`, `reset-regs.txt`, and the strap word. Run the
unmodified upstream flow with `FLASH_MB=16`, `FLASH_IMAGE` set explicitly, and
`DIFF_DIR` set to that directory. Capture two independent 8,000-step reset
sessions. Each session retains:

- raw identity and reset-state input hashes;
- full OpenOCD and GDB logs;
- `hw-trace.txt`, `emu-trace.txt`, and compare output;
- command line, tool versions, UTC start and end, source commits, host OS, and
  SHA-256 for every artifact;
- the compared step count, first PC divergence if any, register differences,
  and timing resynchronization count.

The milestone is no PC divergence in both sessions. Register differences are
reported and dispositioned, not erased. The flow halts and resets the chip but
does not write flash.

### 2. Disposition the existing arbitration evidence

Do not improvise a new arbitration capture in this window. Retain lane 0's
`single_core` and `core1_contended` receipts as input to the reviewed probe
spec. The new probe must add matched aggressors for internal-only work and
external-memory work, an explicit start barrier, an aggressor progress count
covering each victim window, and victim-side cache-counter evidence wherever
the counters remain attributable. The reviewed spec decides the exact flash
and PSRAM aggressor matrix before any firmware is flashed.

### 3. Adopt the lane 0 PSRAM long-window cohort

Run the strict collector and cohort checker offline. Retain min, median, p90,
p99, and max over the stated 100 samples and at least two boots for both cold
sequential and cold random cells. Preserve separate single-core and contended
distributions. No scalar cost may be derived from these cells.

### 4. Prepare cache store and writeback probes

Do not capture until the source, ELF instruction windows, cache-state
preconditions, receipt schema, and analysis have review. One future firmware
image should contain all approved arbitration, store-hit, and writeback cells
so those families cost one flash and one two-boot cohort. Flash only after the
complete image passes its offline checks.

### 5. Service filed lane A and lane C requests

After the ordered timing work, restore the exact v6.1 gate-harness image if a
future unified probe image was flashed. Complete A-01's panel, TE, I2C, touch
interrupt, landmark, and slow-stroke capture without changing firmware during
the request. Preserve the analyzer's native session, raw export, decoded I2C,
serial log, markers, notes or photos, and all hashes. There is currently no
lane C request.

## Board time and state effects

The immediate post-handoff work is identity validation plus two upstream
lock-step sessions: about 5 minutes of board ownership after lane 0's identity
capture. The existing PSRAM receipt disposition is offline. A-01's panel and
touch capture needs about 15 to 25 minutes once the analyzer and physical
landmarks are ready.

The later reviewed arbitration, store, and writeback image is expected to use
one flash, two clean boots, and about 15 to 25 minutes of capture time. Restoring
the v6.1 gate harness adds one final flash. The complete immediate and future
queue is therefore about 35 to 55 minutes of board ownership, excluding logic
analyzer wiring.

Identity reads do not write flash, but esptool and JTAG reset or halt the chip.
Lock-step also resets and single-steps it. A future timing image replaces the
installed application and destroys its volatile state. A-01 touch actions
change the running gate-harness scene. Keep one request active at a time, and
finish by restoring the exact v6.1 gate-harness image named in the provenance
bundle.
