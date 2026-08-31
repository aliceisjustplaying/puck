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

Lane redirections when work resumes: boot lane moves from MMIO whitelists
toward peripheral models with reset-value provenance; ROM lane moves to
real-ROM loading; ISA lane adds a silicon-oracle fixture corpus (the board
is the referee, one owner at a time); timing lane implements decision
0008's tiers.

## Integrated checkpoint

- Baseline commit: `c1b91b23` (QACC, ROM/REGI2C, and browser runner integrated).
- Real ESP-IDF boot: 943 instructions and 1,233 trace records, stopping at the
  eleventh `_xtos_set_intlevel` boundary.
- Timing replay: 2,296 events, 2,263 classified, 33 unknown, and 12 exact ROM
  callbacks.
- ISA coverage: 63,567 supported rows and 709 gaps in the panel corpus; 3,857
  unsupported rows in the full corpus.
- WebAssembly module: 93,998 bytes, SHA-256
  `54c601ab9fa2a57f82c62e65f0d5810889055a09ffc209010f87ac00839dc3aa`.
- Browser smoke: a real browser loads the freestanding module and a bounded
  Xtensa ELF, executes one instruction, and returns `a3 = 40` at `0x40371003`.
- Gates: aggregate experiment suite, 293 Bun tests, headless Chrome verifier,
  root typecheck, and
  experiment typecheck pass.

The integrated boot now accepts the first `esp_rom_regi2c_write_mask` DR1
callback. Active parallel lanes cover remaining ISA families, later ROM/cache
boot callbacks, resumable cycle feedback, flash-image boot mapping, cache and
MSPI timing, FFT workload execution, hardware calibration corpus generation,
and physical ESP32-S3 measurements.

## Persistent fixtures

- `out/fixtures/esp32s3-timing`: clean panel-probe ELF from TinyDraw `4b5385a`.
- `out/fixtures/main-flash`: clean vector demo ELF from TinyDraw `7d37d76`.
- `out/fixtures/puck-staging`: clean gate harness from TinyDraw `a91d1d7`.
- `out/build/esp32-vector-v2-gate-harness`: full current gate-harness ELF.

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
