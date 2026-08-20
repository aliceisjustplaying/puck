# Reference snapshot

The living source is [`MikeWilson/esp32-gameos`](https://github.com/MikeWilson/esp32-gameos),
MIT licensed (`LICENSE` beside this file, copied unchanged). `gos.h`, `gunship.c` and `slots.c`
are a byte-for-byte snapshot of `components/gos_core/include/gos.h`,
`components/games/gunship/gunship.c` and `components/games/slots/slots.c`, copied at commit
`93d0063156a548d2fb1ffea1adb2f88af93dff08` (branch `main`, cloned 2026-08-20).

gameos is a handheld game OS for the Waveshare ESP32-S3-Touch-AMOLED-1.8 (368x448 AMOLED, touch,
IMU, speaker, 8MB PSRAM): a game contract (`gos.h`) over a shell/core/HAL stack, six procedural
games, no engine, no asset files. `apps/gameos/descriptor.md` was extracted from this snapshot
(plus `README.md` and `docs/game-contract.md`/`docs/input-and-ux.md` at the same commit) by
reading, not by running the donor's own ESP-IDF build: the Essence, Interactions and Demands
sections restate what the donor code and its own docs already say, in this repository's
vocabulary.

**Only `gos.h` (the contract) and two of the six games are snapshotted here.** The launcher
(`gos_shell/`), the OS-internal engine (`gos_core/`, minus the font table and RNG/grid, see the
port's own `NOTICE.md`) and the HAL (`gos_hal/`) are ESP-IDF/FreeRTOS-specific (NVS, I2S, a QMI8658
register map, an LVGL font blob, an AXP2101 PMIC) and carry no portable logic a device-agnostic
port needs to read; this repository's port (`apps/gameos/ports/rp2350-touch-amoled-18/`) is its own
new implementation of the same `gos.h` contract, not a port of that internal engine. `golf.c`
(the third game, IMU-swing-driven, full-res RGB565) is not snapshotted: see
`apps/gameos/descriptor.md`'s Demands and the port README for why it was not one of the two picked
for this show-phase port.

**Unmodified.** `gunship.c` and `slots.c` compile against this repository's own `gos.h`
implementation (`apps/gameos/ports/rp2350-touch-amoled-18/gos_runtime.h`/`.c`) with zero source
changes: both files `#include "gos.h"` as a bare quoted filename, which resolves to the copy in
this same directory, so the port's `#include "../../reference/esp32-gameos/gunship.c"` (a unity
build, forced by `packs/rp2350-touch-amoled-18/wasm/build.ts --app`'s single-file contract) pulls
in the donor's real game logic untouched.
