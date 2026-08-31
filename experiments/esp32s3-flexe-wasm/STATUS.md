# ESP32-S3 emulator status

This is the central ledger for the cycle-accurate ESP32-S3 work in this fork.
The canonical checkout is `/Users/sarah/src/a/tinydraw/out/puck-cycle-accurate`,
the integration branch is `codex/esp32s3-timing-model`, and the GitHub remote is
`aliceisjustplaying/puck`.

## Integrated checkpoint

- Baseline commit: `f9c61d1e` (QACC QUP load/MAC family integrated).
- Real ESP-IDF boot: 837 instructions and 1,105 trace records, stopping at the
  ninth `_xtos_set_intlevel` boundary.
- Timing replay: 2,049 events, 2,017 classified, 32 unknown, and 9 exact ROM
  callbacks.
- ISA coverage: 63,567 supported rows and 709 gaps in the panel corpus; 3,857
  unsupported rows in the full corpus.
- WebAssembly module: 92,802 bytes, SHA-256
  `cf24d125e02486a0eb8334d942c6a86a032ba47c41198c4bacd63c9a9f1608c9`.
- Gates: aggregate experiment suite, 289 Bun tests, root typecheck, and
  experiment typecheck pass.

The ROM lane has an unintegrated 943-instruction checkpoint that accepts the
first `esp_rom_regi2c_write_mask` DR1 callback. Active parallel lanes cover
remaining ISA families, ROM/cache boot callbacks, browser execution, cache and
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
bun run experiments/esp32s3-flexe-wasm/aggregate-test.ts
```

The experiment README contains the focused inventory, boot, replay, and build
commands.
