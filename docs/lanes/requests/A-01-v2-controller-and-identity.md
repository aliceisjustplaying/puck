# A-01: V2 controller and identity capture

Date: 2026-08-31
Owner: lane E or the current board owner
Requester: lane A
Target: the maintainer's Waveshare ESP32-S3-Touch-AMOLED-1.8 V2 only

Lane A must receive this evidence before it models the CO5300-class panel
or CST816S-family touch device. This request does not cover the original
SH8601/FT3168 revision.

## Provenance envelope

Record these fields once for the whole capture:

- board product name, V2 revision confirmation, and any board serial;
- firmware ELF and binary SHA-256;
- `sdkconfig` SHA-256, ESP-IDF version, compiler version, and git commit;
- capture commands, tool versions, UTC start time, and operator;
- analyzer model, channel map, sample rate, voltage threshold, and probe
  ground location;
- SHA-256 for every raw and normalized artifact.

Retain native analyzer files and raw JTAG output. Normalized exports are
additional evidence, not replacements for the source captures.

## Identity bundle

Use esp32sim's JTAG adoption flow and preserve:

1. the raw OpenOCD `mdw 0x60007000 128` efuse dump;
2. the raw strap word at `0x60004038` from the same reset-halt session;
3. the reset-halt peripheral register dump in esp32sim's
   `hw/reset-regs.txt` format;
4. `espefuse summary`, including MAC, chip revision, and efuse block
   revision;
5. the exact flash image used for the capture.

Do not reduce the bundle to interpreted fields. Lane A needs the raw
words as input to `--efuse-regs`, `--strap`, and `--regs-init`.

Run the identity commands with the board idle and retain complete stdout
and stderr from each command:

```sh
python -m esptool --port PORT chip_id
python -m esptool --port PORT flash_id
python -m espefuse --port PORT summary
python -m esptool --port PORT --baud 921600 read_flash 0 0x1000000 flash-16M.bin
```

In one OpenOCD connection, issue `init`, `reset halt`, wait for the halt,
then issue these reads in order before `shutdown`:

```text
mdw 0x60007000 128
mdw 0x60004038 1
mdw 0x60008000 768
mdw 0x60009000 64
mdw 0x600c0000 64
mdw 0x60026000 64
mdw 0x600c4000 96
mdw 0x60002000 64
mdw 0x60003000 64
mdw 0x6001f000 64
mdw 0x60020000 64
mdw 0x60023000 64
mdw 0x60004000 112
mdw 0x600c1000 64
mdw 0x60038008 6
mdw 0x600c2000 128
mdw 0x6000e000 32
```

The register ranges match upstream esp32sim's
`hw/atech/reset-regs.txt`. Replace `PORT` with the enumerated serial
port and record it in the provenance envelope. The 16 MB flash length
comes from the target firmware's `CONFIG_ESPTOOLPY_FLASHSIZE_16MB`; if
`flash_id` contradicts that capacity, stop before `read_flash` and report
the detected capacity.

## Panel and bus capture

Capture these signals simultaneously from a cold reset through the first
complete known frame:

| Signal | GPIO |
| --- | ---: |
| QSPI chip select | 12 |
| QSPI clock | 11 |
| QSPI data 0 through 3 | 4, 5, 6, 7 |
| Panel TE | 13 |
| I2C SDA | 15 |
| I2C SCL | 14 |
| Touch interrupt | 21 |

The analyzer must resolve the measured approximately 40 MHz QSPI line.
Retain its native session plus raw VCD or CSV and decoded I2C exports.
Record the precise sample rate so the QSPI capture's limits are explicit.

The capture must contain:

- the TCA9554 transaction sequence at address `0x20`, including the
  config write, reset and power low, 20 ms hold, release, and 150 ms
  settle;
- panel identification and configuration responses, including every
  MISO value returned to firmware;
- the complete panel initialization command and data stream;
- CASET, RASET, RAMWR, and the complete pixel payload for all 16 bands of
  one known gate-harness frame;
- the corresponding SPI2 or GDMA submission and completion boundaries;
- at least 120 TE rising edges after TEON;
- a serial log containing the firmware's
  `TINYDRAW_VECTOR_V2_PRESENTATION` contract and final `TINYDRAW_LIVE_*`
  result;
- the expected frame or scene description that identifies the captured
  pixels.

DMA descriptors are internal and cannot be recovered from panel pins.
If an existing capture hook emits them, include the raw descriptor chain,
SPI2 or GDMA register state, transfer lengths, buffer order, and
submission and completion timestamps keyed to the logic capture. Do not
add a new logger during an unrelated hardware session. Report this part
as unavailable so lane A can prepare a separately reviewed probe.

## Touch capture

Preserve every I2C transaction at address `0x15` and every GPIO21 edge
during:

1. boot-time identification and configuration;
2. an idle poll with no contact;
3. held contacts at panel coordinates `(16,16)`, `(351,16)`, `(16,431)`,
   `(351,431)`, and `(184,224)`;
4. a slow diagonal stroke from the top left landmark to the bottom right
   landmark;
5. release and at least two subsequent polls.

Each landmark needs a serial or analyzer marker and a photo or fixture
note establishing its physical location. Hold each contact long enough
for at least two controller polls. This evidence must identify register
addressing, byte layout, interrupt polarity, transform, latching, and
release behavior without relying on a published CST816S register map.

## Acceptance of the capture

The bundle is complete when another agent can reproduce the decoded I2C
transactions from the raw capture, delimit every panel command and frame
band from the raw QSPI signals, associate the TE edges with that frame,
and load the raw chip identity into esp32sim's existing identity flags.

Radio, battery, analog, temperature, measured-mode timing, and other board
revisions are outside this request.
