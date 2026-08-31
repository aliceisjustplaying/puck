# ESP32-S3 timing evidence

The `receipts/` directory and `esp32s3-rev02-tinydraw-d81e2ea-candidate.json`
are the original counter-free cohort.

`receipts-bf169bc/` contains 118 receipts from three boots of TinyDraw commit
`bf169bc0e2e3f7cb3cff9b8bbda2861ec436be7d`. That firmware records ESP32-S3
instruction and data cache counters, configures the DBUS flash classifier to
the exact data-mapped flash interval, and adds bounded SRAM assembly probes.
Boots 1 and 2 each lost one USB Serial/JTAG fragment. TinyDraw's opt-in recovery
mode omitted the affected measurement and ran every retained group through the
strict receipt assembler. Boot 3 passed the strict whole-log collector. Every
measurement identity therefore retains at least two independent complete boots.

The original raw logs are stored in `captures-bf169bc/` with deterministic gzip
headers. Their decompressed SHA-256 values are the `bootLogSha256` values in the
receipts. `esp32s3-rev02-tinydraw-bf169bc-counters-candidate.json` is the stable
118-receipt report. It retains exact cache-counter moments and remains an
unreviewed candidate. It does not adopt cycle costs or claim cache or ISA
calibration.

The corrected counters give useful bring-up values without making them adopted
costs. Long sequential D-cache fills average about 415 CPU cycles per flash
line and 111 cycles per PSRAM line. Random cold samples suggest isolated-line
candidates near 465 and 162 cycles, respectively. These map naturally to the
model's subsequent-line and first-line burst fields, but interrupt traffic and
the random working-set shape still confound a calibrated fit. Two different
two-line instruction probes measured 424 and 501 excess cycles, so instruction
flash remains context-dependent and instruction PSRAM is unmeasured.

The SRAM assembly probes measure one instruction per cycle steady-state issue,
8 independent loads or stores per 9-cycle body, and a 3-cycle dependent
`addx4` plus `l32i` recurrence. The current scalar timing algebra cannot express
both throughput and the load-use bubble, so the SRAM instruction, load, and
store costs remain unknown.

`captures-a91d1d7/` contains three raw boot logs from TinyDraw commit
`a91d1d74af0ff4c1b55aebc3ed584e9074821394`, built with ESP-IDF 6.0.2 for an
ESP32-S3 revision 0.2 at 240 MHz, QIO flash at 80 MHz, and octal DTR PSRAM at
80 MHz. The logs have deterministic gzip headers. Their decompressed SHA-256
values are, in boot order, `396a188e4eea3663cc3c90e6e647264ce9684cb68c4c51a39591022ddf8f5c74`,
`f7f23872490223437313b00a12b9833802ae51481fab4505389092db6ad0fb33`, and
`6cbf1b1c8380bbf57850c272be86a6f47a303eab8668939329c56729b9796ecd`.
Recovery retained 93, 94, and 96 of 96 measurement groups. Every newly added
cache-burst cell is complete in boots 2 and 3. `receipts-a91d1d7/` keeps only
the instruction and data cache burst receipts used by the analyses.

The instruction-cache flash ladder measured cold-minus-hot penalties of 204,
469, 1002, and 2065 cycles for 1, 2, 4, and 8 cache lines. The adopted burst
cost is 204 cycles for the first line and 266 cycles for each subsequent line.
The rounded least-squares tail has a maximum ladder residual of one cycle.

The data-cache flash ladder measured penalties of 115, 588, 1532, 3425, and
7209 cycles for 1, 2, 4, 8, and 16 lines. The adopted cost is 115 cycles for
the first line and 473 cycles for each subsequent line, with a maximum rounded
fit residual of two cycles. The PSRAM ladder measured 82, 252, 590, 1271, and
2631 cycles and adopts 82 plus 170 cycles, also with a maximum residual of two
cycles. These burst ladders supersede the earlier long-sequential and random
estimates. Instruction PSRAM, cache-hit latency, writeback latency, and scalar
SRAM costs remain uncalibrated.

`esp32s3-rev02-tinydraw-a91d1d7-cache-burst-adoption.json` records the adopted
values and claim boundaries. The adjacent instruction-cache and data-cache
analysis files contain the complete fitted ladders and source receipt hashes.

Regenerate the report with:

```sh
bun run packs/esp32-s3-touch-amoled-18/timing/calibration-report.ts \
  --output candidate.json \
  receipts-bf169bc/boot-1 receipts-bf169bc/boot-2 receipts-bf169bc/boot-3
```
