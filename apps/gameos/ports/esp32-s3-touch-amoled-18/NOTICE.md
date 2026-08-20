# NOTICE: what this port vendors, and from where

Everything below comes from **[`MikeWilson/esp32-gameos`](https://github.com/MikeWilson/esp32-gameos)**
(commit `93d0063156a548d2fb1ffea1adb2f88af93dff08`), MIT licensed
(`../../reference/esp32-gameos/LICENSE`, copied unchanged). Nothing here is
third-party beyond that one donor repository.

This port differs from this app's own rp2350 port
(`../rp2350-touch-amoled-18/`) in one deliberate way: that port is a
from-scratch reimplementation of the `gos.h` contract
(`gos_runtime.c`), because it needed one. **This port compiles the donor's
real, unmodified engine instead** - `core.c`, `gfx.c`, `input.c`, `font.c` -
against a thin compat/shim layer, because `packs/esp32-s3-touch-amoled-18/
docs/decisions/0003-...` found no reason it couldn't: the real engine's own
rendering pipeline (an indexed 184x224 buffer, upscaled through a palette
LUT into DMA bands) is architecturally the same shape this pack's
`draw_band()` contract already wants fed to it.

## Byte-for-byte (`../../reference/esp32-gameos/`)

| file | source | notes |
|---|---|---|
| `gos.h` | `components/gos_core/include/gos.h` | the public game contract, unmodified |
| `gos_core.h` | `components/gos_core/include/gos_core.h` | OS-internal engine interfaces |
| `gos_hal.h` | `components/gos_hal/include/gos_hal.h` | the HAL interface this port's own `gos_hal_shim.c` implements |
| `core.c` | `components/gos_core/core.c` | save/settings/RNG/spatial grid/timing - unmodified |
| `gfx.c` | `components/gos_core/gfx.c` | the real indexed-framebuffer renderer - unmodified |
| `input.c` | `components/gos_core/input.c` | the real input snapshot builder: one-euro filter, aim curve, all three aim modes - unmodified |
| `font.c` | `components/gos_core/font.c` | the 5x7 font table `gfx.c` draws with - unmodified |
| `gunship.c` | `components/games/gunship/gunship.c` | unmodified, `#include`d bare - resolves to this directory's `gos.h` |
| `slots.c` | `components/games/slots/slots.c` | unmodified, `#include`d bare |

**Unmodified, compiled as-is.** All nine files above `#include "gos.h"`/
`"gos_hal.h"`/etc. as bare quoted filenames, resolving to the copies
sitting beside them in the same directory (a plain vendor snapshot, not a
build-time substitution). `core.c`/`gfx.c`/`input.c` additionally
`#include` a handful of ESP-IDF system headers by name
(`"gos_hal.h"`, `"esp_heap_caps.h"`, `"nvs.h"`, `"nvs_flash.h"`,
`"esp_timer.h"`, `"esp_random.h"`, `<math.h>`, `<stdio.h>`, `<stdlib.h>`,
`<string.h>`) - none of which this pack's wasm32-freestanding target or
ESP-IDF itself provide here; this port's own directory carries thin
compat stand-ins for every one of them (below), on the include search path
via `packs/esp32-s3-touch-amoled-18/wasm/build.ts`'s existing
`dirname(APP_SOURCE)` rule.

## Not carried at all

`components/gos_core/mixer.c` (the real 8-voice synth) is not vendored:
this pack has no sound HAL to drive it with (no I2S/ES8311 equivalent,
same stated gap this app's rp2350 port already carries). `gunship.c`/
`slots.c` call `gos_audio_play/loop/stop/...` unconditionally regardless,
so `gos_hal_shim.c` stubs those seven functions directly (silent, every
handle `-1`) rather than vendoring the real mixer just to leave it unpulled.

`components/gos_core/font565.c` and `components/gos_core/loop.c` are not
vendored either (see this port's `README.md`, "GOLF: stopped, not
attempted" and "What is genuinely new", below).

`components/gos_shell/*` (the donor's own 694-line Wii-menu launcher,
settings, pause overlay, first-run calibration wizard) is not vendored -
ESP-IDF/FreeRTOS-specific with no portable half, same as this app's rp2350
port already found.

## Genuinely new (this port's own code)

| file | role |
|---|---|
| `gameos_port.c` | this pack's own dispatcher (three screens, one puck app slot) - not a port of `main/main.c` or `gos_core/loop.c`, neither of which has an equivalent on this ABI |
| `gos_hal_shim.c` | this port's own implementation of `gos_hal.h`'s display/touch/button/IMU functions against this pack's `app.h`/`gfx_band.h`/`runtime_core.h`, plus the `snprintf`/`vsnprintf`/`abs`/`memset`/`memcpy`/`strlen` bodies the compat headers below declare. The one file here with real design in it - see its own header comment for the present/draw_band seam and the accelerometer-to-pitch/roll fusion. |
| `launcher.c` | a new, small picker against the same `gos.h` primitives the two games already use - byte-for-byte the same file as this app's rp2350 port's own `launcher.c` (see that file's header comment for why one file serves both ports) |
| `math.h`, `stdio.h`, `stdlib.h`, `string.h`, `esp_heap_caps.h`, `nvs.h`, `nvs_flash.h`, `esp_timer.h`, `esp_random.h` | compat headers, same idea as this app's rp2350 port's own `string.h` and that pack's `wasm/shim/{math,stdio,stdlib}.h`: declarations the vendored engine's `#include`s need, resolved by this pack's existing `--app` include-path rule rather than by editing the vendored sources |

## GOLF: stopped, not attempted

Per this task's own scope ("if the shim layer turns out to be a multi-day
rabbit hole ... STOP and report the exact blocker"), GOLF
(`components/games/golf/{golf,golf_cards,golf_render}.c`, 3552 lines) was
investigated and not built. Two independent, real blockers, not a size
concern alone:

1. **`font565.c`'s text renderer is welded to LVGL.** GOLF's full-resolution
   direct-mode screens render text through `gos_gfx_text565()`
   (`components/gos_core/font565.c`), which reads Montserrat glyph data
   straight out of LVGL's own `lv_font_fmt_txt_t` format
   (`#include "lvgl.h"` and `src/font/fmt_txt/lv_font_fmt_txt.h"`).
   `font565.c`'s own header comment documents a `GOS_HOST_SIM` path against
   a `lv_shim.h` plus "copies of the font data files" for exactly this kind
   of non-ESP-IDF build - but neither `lv_shim.h` nor the font data copies
   exist anywhere in the donor repository as cloned (checked by search, not
   assumed): that host-sim path is documented, not shipped. Shimming this
   for real would mean either standing up a genuine LVGL font-format
   reader or fabricating Montserrat glyph bitmap data by hand, and a
   fabricated font is exactly the kind of silent, unverifiable divergence
   from upstream this task was told not to paper over with a rewrite.
2. **GOLF's own per-hole world state is PSRAM-scale**, independent of (1):
   `golf_int.h`'s `golf_t` carries three `GRID_W*GRID_H` float grids, a
   `WORLD_W*WORLD_H` int8 mottle map and TWO `WORLD_W*WORLD_H` uint16
   canvases (`rough`, `background`) - `736*896` each - several megabytes of
   procedurally-built course art per hole, built up over hundreds of ticks
   by its own `bg_phase_t` state machine (`golf_int.h`'s own comment:
   "state lands in PSRAM via the shell's 8BIT fallback"). Real, and not
   fundamentally unshimmable the way (1) is - GOLF's `heap_caps_calloc()`
   call sites could get the same treatment this port's own `gos_hal_shim.c`
   already gives GUNSHIP/LUCKY 7 - but combined with (1) unresolved, this
   is real additional surface this task's time budget did not cover.

Neither `golf.c`/`golf_cards.c`/`golf_render.c`/`golf_int.h` nor `font565.c`
are vendored into `../../reference/esp32-gameos/` for this reason - copying
files this port does not build would be dead weight, not evidence.
`GOS_CAP_FB565`'s one real call site remains linkable-but-dead in this
port's own `gfx.c` (see this file's "Not carried at all" and
`esp_heap_caps.h`'s own header comment) for exactly the reason a future
attempt at GOLF would want it there already.

The donor's DIAG/AIM-TEST screens (mentioned in `apps/gameos/descriptor.md`)
are not separate files in this donor snapshot at all - they live inside
`components/gos_shell/` (not vendored, see above), not `components/games/`
- so "include only if free" resolves to: not free, not included.
