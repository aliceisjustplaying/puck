# ESP32-S3 emulator status

This is the central ledger for the cycle-accurate ESP32-S3 work in this fork.
The canonical checkout is `/Users/sarah/src/a/tinydraw/out/puck-cycle-accurate`,
the integration branch is `codex/esp32s3-timing-model`, and the GitHub remote is
`aliceisjustplaying/puck`.

## Integrated checkpoint

- Baseline commit: `8b141357` (QACC plus the next ROM/REGI2C slice integrated).
- Real ESP-IDF boot: 943 instructions and 1,233 trace records, stopping at the
  eleventh `_xtos_set_intlevel` boundary.
- Timing replay: 2,296 events, 2,263 classified, 33 unknown, and 12 exact ROM
  callbacks.
- ISA coverage: 63,567 supported rows and 709 gaps in the panel corpus; 3,857
  unsupported rows in the full corpus.
- WebAssembly module: 93,998 bytes, SHA-256
  `54c601ab9fa2a57f82c62e65f0d5810889055a09ffc209010f87ac00839dc3aa`.
- Gates: aggregate experiment suite, 290 Bun tests, root typecheck, and
  experiment typecheck pass.

The integrated boot now accepts the first `esp_rom_regi2c_write_mask` DR1
callback. Active parallel lanes cover remaining ISA families, later ROM/cache
boot callbacks, browser execution, cache and
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
