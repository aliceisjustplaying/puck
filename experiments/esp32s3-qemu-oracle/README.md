# ESP32-S3 QEMU oracle

This experiment keeps Espressif QEMU outside Puck and uses it only as an
external correctness oracle for the flexe ESP32-S3 spike. Puck ships a
versioned JSON corpus, a comparator, and an opt-in live runner that drives the
exact pinned QEMU build through GDB. No QEMU source, binary, or copied GPL
implementation is carried here.

## Provenance

- flexe: `https://github.com/levkropp/flexe` at `34ea9eb6eef921b59a55e6a435c7fc55c5727835`
- Espressif QEMU: `https://github.com/espressif/qemu`, branch `esp-develop`,
  commit `febae182e132e4055529be423a818225ebddaa3a`
- target machine: `esp32s3`
- contract scope: bounded instruction PCs, architectural register values, and
  memory bytes only

The corpus makes no timing or cycle claims.

## Corpus

`fixtures/flexe-corpus.json` currently pins two cases taken from the existing
flexe experiment surface:

- `scalar_probe`: the six-byte `movi` plus `addi` probe from `flexe_wasm_probe`
- `qr_bitwise_logic`: the current ten-step PIE/QR logic fixture with fixed
  source and destination pages at `0x3fca1000` and `0x3fca2000`

Each case records code bytes, initial architectural state, memory pages to
seed, registers and memory to observe, and the reference flexe observation.
`compare.ts` accepts only exact agreement.

## Run

Deterministic contract checks work without QEMU:

```text
bun run experiments/esp32s3-qemu-oracle/test.ts
bun run experiments/esp32s3-qemu-oracle/compare.ts
```

Live verification needs an external Espressif QEMU build plus Xtensa GDB:

```text
export ESP32S3_QEMU_COMMIT=febae182e132e4055529be423a818225ebddaa3a
export ESP32S3_QEMU_EXE=/path/to/qemu-system-xtensa
export ESP32S3_GDB_EXE=/path/to/xtensa-esp32s3-elf-gdb
bun run experiments/esp32s3-qemu-oracle/run.ts > /tmp/esp32s3-qemu-observation.json
bun run experiments/esp32s3-qemu-oracle/compare.ts --observation /tmp/esp32s3-qemu-observation.json
```

`run.ts` launches `qemu-system-xtensa -machine esp32s3 -S`, connects through a
private GDB socket, writes the bounded corpus state, single-steps the pinned
instruction budget, and emits a stable observation JSON record.
