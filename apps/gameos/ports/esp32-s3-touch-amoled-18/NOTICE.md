# NOTICE: what this port vendors, and from where

Everything below comes from **[`MikeWilson/esp32-gameos`](https://github.com/MikeWilson/esp32-gameos)**
(commit `93d0063156a548d2fb1ffea1adb2f88af93dff08`), MIT licensed
(`../../reference/esp32-gameos/LICENSE`, copied unchanged). Nothing here is
third-party beyond that one donor repository.

**GOLF's own standalone upstream, `MikeWilson/infinite-golf`, is NOT that
repository and is NOT used here.** `esp32-gameos`'s own `golf.c`/
`golf_render.c`/`golf_cards.c`/`golf_int.h` (vendored below, MIT, same as
every other file in this NOTICE) are a port of that standalone game onto
the `gos.h` contract - but `infinite-golf` itself has no declared license
(`licenseInfo: null`), so nothing from it was read, copied, or adapted for
this task: only the MIT `esp32-gameos` copy touched this repository. The
font substitution below (`font565_shim.c`) is entirely this port's own new
code for the same reason - not a translation of anything from either
upstream.

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
| `golf.c` | `components/games/golf/golf.c` | unmodified, `#include`d bare (renamed-on-include for three colliding identifiers only - see `gameos_port.c`'s own comment at that include site; the vendored file on disk is untouched) |
| `golf_render.c` | `components/games/golf/golf_render.c` | unmodified, `#include`d bare |
| `golf_cards.c` | `components/games/golf/golf_cards.c` | unmodified, `#include`d bare |
| `golf_int.h` | `components/games/golf/golf_int.h` | golf.c/golf_render.c/golf_cards.c's shared internal header, unmodified |

**Unmodified, compiled as-is.** All thirteen files above `#include "gos.h"`/
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

**On the `golf.c` rename note**: forcing five independently-designed donor
translation units (`core.c`/`gfx.c`/`input.c`/`font.c`, `gunship.c`,
`slots.c`, and now `golf.c`/`golf_render.c`/`golf_cards.c`) into ONE unity
build (`--app`'s single-file contract) surfaces `static`-symbol collisions
the donor's own per-file CMake build never has to resolve. `gameos_port.c`
`#define`s three of golf.c's own identifiers to a unique name for the
duration of that one `#include` only (`sfx_tap`/`sfx_tick`, which collide
with slots.c's own SFX sound-table names, and `update_camera`, which
collides with gunship.c's own static helper of the same name but a
different signature) and `#undef`s them immediately after - the vendored
`golf.c` file on disk is byte-for-byte unchanged; only what the
preprocessor substitutes while compiling it is affected. `font565_shim.c`
below needed one more such rename of its OWN code, `put_px` -> `put_px`
prefixed with `font565_`, since `golf_render.c` already has a static
`put_px` of its own.

## Not carried at all

`components/gos_core/mixer.c` (the real 8-voice synth) is not vendored:
this pack has no sound HAL to drive it with (no I2S/ES8311 equivalent,
same stated gap this app's rp2350 port already carries). `gunship.c`/
`slots.c`/`golf.c` call `gos_audio_play/loop/stop/...` unconditionally
regardless, so `gos_hal_shim.c` stubs those seven functions directly
(silent, every handle `-1`) rather than vendoring the real mixer just to
leave it unpulled.

`components/gos_core/font565.c` (GOLF's own Montserrat/LVGL text renderer)
and `components/gos_core/loop.c` are not vendored - see "GOLF: font and
memory, two declared substitutions" below for font565.c specifically (a
real, working replacement ships instead, `font565_shim.c`) and "What is
genuinely new" for why `loop.c` still has no equivalent on this ABI.

`components/gos_shell/*` (the donor's own 694-line Wii-menu launcher,
settings, pause overlay, first-run calibration wizard) is not vendored -
ESP-IDF/FreeRTOS-specific with no portable half, same as this app's rp2350
port already found.

## Genuinely new (this port's own code)

| file | role |
|---|---|
| `gameos_port.c` | this pack's own dispatcher (four screens, one puck app slot) - not a port of `main/main.c` or `gos_core/loop.c`, neither of which has an equivalent on this ABI |
| `gos_hal_shim.c` | this port's own implementation of `gos_hal.h`'s display/touch/button/IMU functions against this pack's `app.h`/`gfx_band.h`/`runtime_core.h`, plus the `snprintf`/`vsnprintf`/`abs`/`memset`/`memcpy`/`strlen`/`strchr` bodies the compat headers below declare, plus GOLF's own direct565 present/draw_band path and its own local accel queue (`hal_imu_get()`'s pitch/roll fusion and `hal_imu_accel_read()`'s raw stream for GOLF's swing detector are two independent consumers of one underlying ring, at two different polling rates - see `hal_imu_get()`'s own header comment for the real bug this caused and how it was found). The one file here with the most real design in it - see its own header comment for the present/draw_band seam and the accelerometer-to-pitch/roll fusion. |
| `font565_shim.c` | this port's own, DECLARED substitution for the donor's LVGL-coupled `font565.c` - see "GOLF: font and memory, two declared substitutions" below |
| `launcher.c` | a picker against the same `gos.h` primitives the three games use. NO LONGER byte-for-byte the same file as this app's rp2350 port's own `launcher.c` (a third card, GOLF, plus a re-laid-out card geometry - see that file's own header comment for why and what it cost) |
| `math.h`, `stdio.h`, `stdlib.h`, `string.h`, `esp_heap_caps.h`, `nvs.h`, `nvs_flash.h`, `esp_timer.h`, `esp_random.h` | compat headers, same idea as this app's rp2350 port's own `string.h` and that pack's `wasm/shim/{math,stdio,stdlib}.h`: declarations the vendored engine's `#include`s need, resolved by this pack's existing `--app` include-path rule rather than by editing the vendored sources. `math.h` gained `fminf`/`fmaxf` and `esp_heap_caps.h` gained a real (not dead-code) `heap_caps_calloc()` for GOLF - see both files' own header comments |

## GOLF: font and memory, two declared substitutions

GOLF shipped, after the two blockers a prior pass at this port found (see
this bundle's git history for that pass's own NOTICE.md, since superseded)
were each resolved with a real, working, HONESTLY DECLARED substitution -
never a fabrication pretending to be the donor's own asset, per this task's
own doctrine.

1. **Font: `font565_shim.c` replaces `components/gos_core/font565.c`.**
   The real `font565.c` renders Montserrat text by reading glyph data
   straight out of LVGL's own `lv_font_fmt_txt_t` format (`#include
   "lvgl.h"`), which this repository does not vendor - pulling in LVGL just
   for this would mean either standing up a genuine LVGL font-format reader
   (a real, multi-day dependency this task's scope does not budget for) or
   fabricating Montserrat glyph bitmap data by hand (a silent,
   unverifiable divergence from upstream this task's doctrine forbids
   outright). `font565_shim.c` instead REUSES a real font already vendored
   byte-for-byte into this exact bundle: `font.c`'s own `gos_font5x7`, the
   same public-domain 5x7 dot font the indexed-buffer path already draws
   with, at native size, for the launcher/GUNSHIP/LUCKY 7. `font565_shim.c`
   integer-scales that SAME table (`scale = round(px/7)`) to approximate
   GOLF's six requested point sizes (14/18/20/22/28/32px - the exact set
   `golf_render.c`/`golf_cards.c` call with, checked by grep). **What this
   changes on screen**: GOLF's title, scorecards and HUD numerals render in
   a bigger monospace dot font instead of Montserrat - text APPEARANCE
   only, never gameplay, layout, or timing (every `gos_gfx_text565_w/h()`
   caller still gets a real, if differently-shaped, measurement back, so
   text still centers and wraps correctly). A real silicon build would show
   the donor's own Montserrat here instead.
2. **Memory: GOLF's per-hole world state lives in this module's own wasm
   linear memory, sized explicitly.** `golf_int.h`'s `golf_t` carries three
   `GRID_W*GRID_H` float grids, a `WORLD_W*WORLD_H` int8 mottle map and TWO
   `WORLD_W*WORLD_H` uint16 canvases (`rough`, `background`) - `736*896`
   each - plus GOLF's own full-resolution 368x448 RGB565 direct-mode
   framebuffer (`gos_gfx_fb565()`, `esp_heap_caps.h`'s now-real
   `heap_caps_calloc()`). Together, several megabytes of static state -
   see this port's own README, "GOLF's memory budget", for the exact byte
   accounting and the explicit wasm memory ceiling this port's build now
   sets (`packs/esp32-s3-touch-amoled-18/wasm/build.ts --wasm-memory-mb`).
   `packs/esp32-s3-touch-amoled-18/docs/decisions/0003-...` is where this
   was decided in principle before any of this port's own code touched it:
   the wasm equivalent of what `heap_caps_calloc(..., MALLOC_CAP_8BIT)`
   would hand back from real PSRAM is a plain static array living in this
   app's own module, not a new pack-level primitive.

Neither substitution touches the donor's own vendored sources: `golf.c`/
`golf_render.c`/`golf_cards.c`/`golf_int.h` are byte-for-byte, unmodified
(see "Byte-for-byte" above); `font565.c` itself is still not vendored (dead
weight, since this port never compiles it) and `GOS_CAP_FB565`'s
`heap_caps_calloc()` call site inside the real, vendored `gfx.c` is now
genuinely live, not linkable-but-dead.

The donor's DIAG/AIM-TEST screens (mentioned in `apps/gameos/descriptor.md`)
are not separate files in this donor snapshot at all - they live inside
`components/gos_shell/` (not vendored, see above), not `components/games/`
- so "include only if free" resolves to: not free, not included. The sixth
game (still in development upstream per `apps/gameos/descriptor.md`'s
Essence) remains out of scope for the same reason it always was: it is not
finished in the donor repository as cloned.
