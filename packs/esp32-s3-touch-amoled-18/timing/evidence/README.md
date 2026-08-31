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

Regenerate the report with:

```sh
bun run packs/esp32-s3-touch-amoled-18/timing/calibration-report.ts \
  --output candidate.json \
  receipts-bf169bc/boot-1 receipts-bf169bc/boot-2 receipts-bf169bc/boot-3
```
