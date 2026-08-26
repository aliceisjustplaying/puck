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
real, unmodified engine AND real, unmodified shell instead** - `core.c`,
`gfx.c`, `input.c`, `font.c`, and (as of this task) `registry.c`/`apps.c`/
`shell.c` - against a thin compat/shim layer, because
`packs/esp32-s3-touch-amoled-18/docs/decisions/0003-...` found no reason it
couldn't: the real engine's own rendering pipeline (an indexed 184x224
buffer, upscaled through a palette LUT into DMA bands) is architecturally
the same shape this pack's `draw_band()` contract already wants fed to it.

## The real shell replaces this port's own former `launcher.c`

**This is the headline change of this task.** Every prior version of this
port shipped a bespoke, port-authored picker (`launcher.c`: three flat
cards on a dark navy field, "TAP A CARD TO LAUNCH") that never existed on
the donor's real device - a fact this bundle's own git history and README
already stated plainly, but a fact that also meant the screen this port
showed was NOT what a real board running this firmware actually shows.
Sylve flashed the donor's own firmware on his real board and confirmed:
the real shell is `components/gos_shell/{registry.c,apps.c,shell.c}`, a
Wii-menu-style tile grid with a settings screen, a pause overlay, and a
first-run tilt-calibration wizard - exactly what the donor's own
`media/launcher.png` (vendored below, byte-for-byte, at
`../../reference/esp32-gameos/media/launcher.png`) shows. `launcher.c` is
now **deleted** from this port. See `README.md`'s own "Donor-reference
comparison" section for the pixel-level proof this vendoring actually
reproduces that real screen.

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
| `apps.c` | `components/gos_shell/apps.c` | **new this task.** The donor's own two harness apps, AIM TEST and DIAG - unmodified, `#include`d bare |
| `registry.c` | `components/gos_shell/registry.c` | **new this task.** The donor's own game table (`g_games[]`) - unmodified, `#include`d bare (renamed-on-include for one colliding identifier, `tap` - see `gameos_port.c`'s own comment) |
| `shell.c` | `components/gos_shell/shell.c` | **new this task.** The donor's own real shell - grid, settings, pause overlay, calibration wizard, debug overlay, per-frame orchestration - unmodified, `#include`d bare |
| `media/launcher.png` | `media/launcher.png` | **new this task.** The donor's own reference screenshot, downloaded byte-for-byte, used as this port's donor-reference comparison target (`donor-shell-comparison/README.md`) |
| `testing-and-verification.md` | `docs/testing-and-verification.md` | **new this task.** The donor's own doc describing its host-side frame-dump pattern, vendored so `donor-shell-comparison/hostsim/` can be checked against it directly |

**Unmodified, compiled as-is.** All sixteen `.c`/`.h` files above `#include "gos.h"`/
`"gos_hal.h"`/etc. as bare quoted filenames, resolving to the copies
sitting beside them in the same directory (a plain vendor snapshot, not a
build-time substitution). `core.c`/`gfx.c`/`input.c`/`shell.c`/`apps.c`
additionally `#include` a handful of ESP-IDF system headers by name
(`"gos_hal.h"`, `"esp_heap_caps.h"`, `"nvs.h"`, `"nvs_flash.h"`,
`"esp_timer.h"`, `"esp_random.h"`, `"esp_log.h"`, `"esp_system.h"`,
`<math.h>`, `<stdio.h>`, `<stdlib.h>`, `<string.h>`) - none of which this
pack's wasm32-freestanding target or ESP-IDF itself provide here; this
port's own directory carries thin compat stand-ins for every one of them
(below), on the include search path via
`packs/esp32-s3-touch-amoled-18/wasm/build.ts`'s existing
`dirname(APP_SOURCE)` rule.

**On the `golf.c` rename note**: forcing five independently-designed donor
translation units (`core.c`/`gfx.c`/`input.c`/`font.c`, `gunship.c`,
`slots.c`, and `golf.c`/`golf_render.c`/`golf_cards.c`) into ONE unity
build (`--app`'s single-file contract) surfaces `static`-symbol collisions
the donor's own per-file CMake build never has to resolve. `gameos_port.c`
`#define`s three of golf.c's own identifiers to a unique name for the
duration of that one `#include` only (`sfx_tap`/`sfx_tick`, which collide
with slots.c's own SFX(sfx_tap, ...)/SFX(sfx_tick, ...) sound tables, and
`update_camera`, which collides with gunship.c's own static helper of the
same name but a different signature) and `#undef`s them immediately after -
the vendored `golf.c` file on disk is byte-for-byte unchanged; only what
the preprocessor substitutes while compiling it is affected. `font565_shim.c`
below needed one more such rename of its OWN code, `put_px` -> `put_px`
prefixed with `font565_`, since `golf_render.c` already has a static
`put_px` of its own. sfx_tap/sfx_tick rename the gos_sfx_t variable AND,
separately, sfx_tap_n/sfx_tick_n rename the backing note array the SFX()
macro pastes together (name##_n) - a ##-pasted use of a macro parameter is
NOT itself macro-expanded (C99 6.10.3.1), so `#define sfx_tap` alone would
rename golf.c's `sfx_tap` variable but leave its `sfx_tap_n` array still
colliding with slots.c's own; the pasted RESULT token IS rescanned for
further macro replacement afterward (6.10.3.4), which is what makes
defining sfx_tap_n/sfx_tick_n directly work.

**On the `shell.c` rename note (new this task)**: vendoring the real shell
surfaced ONE more same-shape collision, found by actually attempting this
build, not anticipated: `shell.c`'s own file-scope `static bool tap`
(its release-tap flag, set by `detect_tap()`) collides with `slots.c`'s
own file-scope `static void tap(gos_ctx_t*, int, int)` (LUCKY 7's own
lever-tap helper) - two independently-scoped, entirely correct `static`
declarations in the donor's own per-file build, made a real
same-translation-unit symbol collision by this port's forced unity build.
`gameos_port.c` renames `shell.c`'s own `tap` to `shell_tap` for the
duration of that one `#include` only, the identical macro-rename pattern
`golf.c`'s own three identifiers already use.

## Not carried at all

`components/gos_core/mixer.c` (the real 8-voice synth) is not vendored:
this pack has no sound HAL to drive it with (no I2S/ES8311 equivalent,
same stated gap this app's rp2350 port already carries). `gunship.c`/
`slots.c`/`golf.c` call `gos_audio_play/loop/stop/...` unconditionally
regardless, so `gos_hal_shim.c` stubs those seven functions directly
(silent, every handle `-1`) rather than vendoring the real mixer just to
leave it unpulled. `gos_mixer_init()` (`gos_core.h`'s own declaration,
called once at boot the same as a real board's `main.c` would) is likewise
stubbed - a pure no-op, since there is no mixer state anywhere on this
port for an init step to prepare.

`components/gos_core/font565.c` (GOLF's own Montserrat/LVGL text renderer)
and `components/gos_core/loop.c` are not vendored - see "GOLF: font and
memory, two declared substitutions" below for font565.c specifically (a
real, working replacement ships instead, `font565_shim.c`), and "Genuinely
new" below for how `loop.c`'s one relevant piece (the boot init order,
main.c's own `app_main()`) is reproduced by hand rather than vendored,
since the rest of it is FreeRTOS task machinery with no equivalent on this
ABI.

`main/main.c` itself is not vendored: `bsp_i2c_init()`, per-subsystem
`hal_*_init()` calls, and `gos_loop_start()` (a FreeRTOS task, never
returns) are all ESP-IDF/FreeRTOS-specific with no portable half. This
port's own `esp32gameos_enter()`/`esp32gameos_tick()` (`gameos_port.c`)
reproduce the one piece of `main.c` that has a real, portable equivalent -
its init call order (`gos_gfx_init()`, `gos_input_init()`,
`gos_mixer_init()`, `shell_init()`) and its per-tick shape (build the
input snapshot, hand it to the shell, present) - by hand, not vendored.

## Genuinely new (this port's own code)

| file | role |
|---|---|
| `gameos_port.c` | this pack's own dispatcher. AS OF THIS TASK: three thin forwarding calls (`esp32gameos_enter`/`_tick`/`_draw_band`) into the real, vendored shell's own `shell_init()`/`shell_frame()` - not a screen-switch dispatcher any more, since the real shell already owns that entirely. Compare this file's own git history before this task: a ~120-line hand-rolled `SCREEN_LAUNCHER/GUNSHIP/SLOTS/GOLF` dispatcher, with per-game static state and a bespoke `swipe_exit()`, is gone. |
| `gos_hal_shim.c` | this port's own implementation of `gos_hal.h`'s display/touch/button/IMU/power functions against this pack's `app.h`/`gfx_band.h`/`runtime_core.h`, `gos_mixer_init()`'s stub, `esp_restart()`'s stub, `esp_random()`'s deterministic body, and the `snprintf`/`vsnprintf`/`abs`/`memset`/`memcpy`/`strlen`/`strchr` bodies the compat headers below declare, plus GOLF's own direct565 present/draw_band path and its own local accel queue. The one file here with the most real design in it - see its own header comment for the present/draw_band seam and the accelerometer-to-pitch/roll fusion, and "The printf-subset formatter grew" below for what changed here this task. |
| `font565_shim.c` | this port's own, DECLARED substitution for the donor's LVGL-coupled `font565.c` - see "GOLF: font and memory, two declared substitutions" below |
| `math.h`, `stdio.h`, `stdlib.h`, `string.h`, `esp_heap_caps.h`, `nvs.h`, `nvs_flash.h`, `esp_timer.h`, `esp_random.h`, `esp_log.h`, `esp_system.h` | compat headers: declarations the vendored engine's/shell's `#include`s need, resolved by this pack's existing `--app` include-path rule rather than by editing the vendored sources. `esp_log.h` and `esp_system.h` are new this task (below); `esp_random.h` gained a real declaration this task (below); `esp_heap_caps.h` gained a second allocation class this task (below) |

## The printf-subset formatter grew (this task)

`gos_hal_shim.c`'s `gosport_vsnprintf()` (the redirect target for every
vendored `snprintf()`/`vsnprintf()` call, since this pack's freestanding
libc has neither) previously covered only `%d`/`%ld`/`%+d`/`%+ld`/`%s`/`%%`
- every format string `core.c`/`gfx.c`/`input.c`/`gunship.c`/`slots.c`/
`golf*.c` actually pass, checked by grep. Vendoring `apps.c`/`shell.c` this
task introduced real format strings that formatter could not parse at
all: `%u`/`%lu` (unsigned), `%02X` (zero-padded hex), width specifiers
(`%2d`/`%3d`), precision-capped strings (`%.9s`/`%.12s`), and - the
significant gap - **`%f`** with a width.precision and an optional `+`
(`%+7.2f`, `%+5.1f`, `%.2f`, and five more shapes, all checked by grep
across every vendored `.c` file, not guessed). DIAG's and the calibration
wizard's own pitch/roll/gyro/aim readouts are the first vendored code on
this port to need real float formatting at all.

**This was found empirically, not anticipated.** An early build of this
port's DIAG/calibration screens rendered `"PITCH .2f ROLL .2f"` instead of
real numbers - the old formatter silently consumed the `%` and any flags,
then fell through its own "any other conversion: silently skipped" branch
without consuming the width/precision digits, which then printed as
literal text on the NEXT iterations of its own character loop. Caught by
actually looking at a captured DIAG frame (this port's README, "What is
real"), not by inspection. `gosport_vsnprintf()` now implements the full
observed conversion set properly (width, precision, `+`/`0` flags, `d`/
`u`/`x`/`X`/`f`/`s`/`%`) rather than leaving `%f`/`%u` as a stated gap -
this is a genuine correctness bug in this port's own shim, not a hardware
capability honestly missing, so it is fixed, not declared.

## `esp_log.h`, `esp_system.h`: new compat headers (this task)

`shell.c` calls `ESP_LOGI`/`ESP_LOGE` at every touch edge, tap, launch,
quit, and pause/resume transition - real, donor-authored on-device
diagnostic logging (its own header comment: "this is how the touch-
parallax numbers were measured" on the real device's serial console). This
port has no serial console and no host-side log sink at all, so
`esp_log.h` compiles both macros to `((void)0)` - the format string and
arguments are still parsed (a real printf-format mistake would still
surface as a compiler warning), nothing is evaluated at runtime. This
SHIMS AWAY the donor's own on-device logging.

`shell.c`'s settings screen's factory-reset row (`R_RESET`, a 3s
press-and-hold) calls `nvs_flash_erase()` (already an honest always-fails
stub, `nvs_flash.h`) then `esp_restart()`. `esp_system.h` declares it,
`gos_hal_shim.c` defines it as a genuine no-op: this emulator module has no
reboot concept to invoke instead - the row still draws, still charges its
hold bar for 3s exactly as the real device does, and simply does nothing
further once it completes, rather than the real device's full reboot.

## `esp_random()`: a real body this task (was declaration-only)

`shell.c`'s `launch()` seeds a freshly launched game's RNG with
`esp_random()` directly (`.rng = { esp_random() }`) - `core.c` itself
never calls it (the old `esp_random.h` comment, still true for that one
file), so this port previously only needed the header to resolve, no body.
`gos_hal_shim.c` now defines it: a pure function of this port's own tick
clock and a per-call counter, the same deterministic-seeding doctrine this
port's prior dispatcher already stated for its own (now-removed) per-launch
seed formula, and the same reason `docs/harness.md` states repository-wide
- a replay of the same trace must reproduce the same run. A real board's
`esp_random()` reads a hardware TRNG; this is a stated, honest
substitution for it, never an attempt at real entropy.

## `esp_heap_caps.h`: a second allocation class (this task)

Previously ONE call site ever needed `heap_caps_calloc()`: `gos_gfx_fb565()`
(gfx.c), GOLF's own one-shot, permanent, 329728-byte full-resolution
framebuffer. `shell.c`'s real `launch()`/`quit_game()` add a SECOND, very
different usage: a per-launch game-state allocation (`heap_caps_calloc(1,
g->state_size, ...)`), freed and reallocated fresh on every launch (at most
one live at a time - `quit_game()` always frees before the next `launch()`
allocates, checked by grep). `esp_heap_caps.h` now carries two purpose-built
static arenas instead of one: the original 329728-byte fb565 buffer
(unchanged, matched by exact byte count) and a new 4 MiB game-state arena
(generous headroom over golf_t's own measured ~3.8MB - see this port's
README, "GOLF's memory budget" - the largest of this bundle's five game
states by a wide margin), plus a real `heap_caps_free()` (only ever called
on a game-state pointer; the fb565 buffer is never freed by any vendored
caller) and an honest `heap_caps_get_free_size()` stub (returns 0 - no real
heap here to measure, and both callers, `shell.c`'s debug overlay and
`apps.c`'s DIAG screen, only ever print it as diagnostic text for a human).

## No battery HAL (this task)

`shell.c`'s `draw_bottom_bar()` shows a battery percentage when
`hal_power_get()` reports one present, or "USB" when it does not - the
donor's own real fallback for a board with no PMIC wired, unchanged. This
pack declares no battery/PMIC sensor at all
(`packs/esp32-s3-touch-amoled-18/device.json`), so `gos_hal_shim.c`'s
`hal_power_init()`/`hal_power_poll()`/`hal_power_get()` are honest stubs:
`present` is unconditionally `false`. This is why the donor's own
`media/launcher.png` reference screenshot shows "USB" in that exact same
corner too (a real board plugged into USB with no battery inserted, or
none fitted) - see `donor-shell-comparison/README.md` for the pixel-exact
match this produces.

## No NVS persistence means the calibration wizard reappears every boot (this task)

Vendoring the real `shell.c` surfaced a genuinely new, honest gap this
port's own former `launcher.c` never had to declare: `shell_init()` enters
the first-run tilt-calibration wizard (`SH_CALIB`) whenever
`g_settings.calibrated` is false. On real silicon this happens exactly
once, ever - the setting persists in NVS. This port's own `nvs.h`/
`nvs_flash.h` shims always fail open (no persistence at all - `nvs_open()`
always returns failure, which every one of `core.c`'s/`input.c`'s/
`shell.c`'s own save/settings/calibration functions already treats as
"nothing to load/save" and returns cleanly from), so `g_settings.calibrated`
never sticks: **every fresh module boot shows the calibration wizard, not
the grid, until the first tap dismisses it.** This is a real, stated,
previously-undeclared divergence from a real device's two-thousandth boot
(though not from its very first) - recorded here, and accounted for by
every trace/demo/host-sim driver this bundle now ships (each performs one
dismissal tap as its first action).

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
   with, at native size, for the shell/GUNSHIP/LUCKY 7. `font565_shim.c`
   integer-scales that SAME table (`scale = round(px/7)`) to approximate
   GOLF's six requested point sizes (14/18/20/22/28/32px - the exact set
   `golf_render.c`/`golf_cards.c` call with, checked by grep). **What this
   changes on screen**: GOLF's title, scorecards and HUD numerals render in
   a bigger monospace dot font instead of Montserrat - text APPEARANCE
   only, never gameplay, layout, or timing (every `gos_gfx_text565_w/h()`
   caller still gets a real, if differently-shaped, measurement back, so
   text still centers and wraps correctly). A real silicon build would show
   the donor's own Montserrat here instead. This substitution is scoped to
   GOLF only - the shell's own grid/settings/overlay/calibration text and
   AIM TEST's/DIAG's own readouts all draw through the indexed `font.c`
   path directly, never through this shim.
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
   app's own module, not a new pack-level primitive. `shell.c`'s own
   per-launch game-state allocation (see "esp_heap_caps.h" above) is a
   SEPARATE arena from this one - GOLF's `golf_t` goes through the shell's
   own `heap_caps_calloc(1, g->state_size, ...)` call site exactly like
   every other game, landing in the 4 MiB game-state arena, not the
   329728-byte fb565 one.

Neither substitution touches the donor's own vendored sources: `golf.c`/
`golf_render.c`/`golf_cards.c`/`golf_int.h` are byte-for-byte, unmodified
(see "Byte-for-byte" above); `font565.c` itself is still not vendored (dead
weight, since this port never compiles it) and `GOS_CAP_FB565`'s
`heap_caps_calloc()` call site inside the real, vendored `gfx.c` is now
genuinely live, not linkable-but-dead.

## DIAG and AIM TEST, previously out of scope, now ship (this task)

Every prior pass at this port stated: "The donor's DIAG/AIM-TEST screens
... are not separate files in this donor snapshot at all - they live
inside `components/gos_shell/`, not `components/games/` - so 'include only
if free' resolves to: not free, not included." That reasoning applied to a
port that vendored the engine and games but reimplemented its own launcher
from scratch; it does not apply once `components/gos_shell/` itself is
vendored, which this task does. `apps.c` (real, unmodified) is now
compiled in, `registry.c` (real, unmodified) lists both alongside the
three games, and the real, unmodified `shell.c` is what makes them
reachable from the grid exactly as on the donor's own device - see
`README.md`'s "What is real" for this port's own invariant coverage
proving both actually open and return cleanly.

The sixth game (still in development upstream per `apps/gameos/descriptor.md`'s
Essence) remains out of scope for the same reason it always was: it is not
finished in the donor repository as cloned.
