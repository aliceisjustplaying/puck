# Port verdict: esp32-s3-touch-amoled-18

**The featured module for this bundle's gallery card.** This is the chip
family (ESP32-S3) esp32-gameos itself targets, and this port compiles the
donor's own real engine, games, AND (as of this task) real shell,
unmodified - see `NOTICE.md` for exactly what is vendored byte-for-byte
versus new. The sibling `rp2350-touch-amoled-18` port stays listed as the
cross-chip port (a from-scratch reimplementation of the same `gos.h`
contract, and its own bespoke picker, on different silicon).

## What changed: the real shell replaces `launcher.c`

Every prior pass at this port shipped its own picker (`launcher.c`: three
flat cards, "TAP A CARD TO LAUNCH") - port-authored glue that never existed
on the donor's own device. Sylve flashed the donor's real firmware on his
own board and confirmed the actual shell: a light-gray, Wii-menu-style
grid of white rounded tiles with cyan letter icons, empty gray slots, a
bottom bar with a round SET button, a "GAMEOS" label, and a battery/USB
indicator. That is `components/gos_shell/{registry.c,apps.c,shell.c}`
(the donor's own real launcher grid, settings, pause overlay, first-run
calibration wizard, and per-frame orchestration), now vendored
byte-for-byte (`NOTICE.md`). `launcher.c` is deleted from this port.

## Verdict: degraded

Comparing `apps/gameos/descriptor.md`'s `Demands` against this pack's
`device.json` (`packs/esp32-s3-touch-amoled-18/device.json`):

| Demand | Fit |
|---|---|
| **60fps** | unproven - the emulator cannot measure timing (same honesty standard every port in this repository states; see `docs/harness.md`'s "What this catches, and what it cannot"). Unlike the rp2350 port, there is no cross-architecture compute gap to worry about here: this pack's board IS the chip family the donor benchmarked 60fps on, running the donor's own unmodified code. No silicon run of this exact build exists, so "plausible" is the honest ceiling, not "proven." |
| Colour panel, >=256-entry palette | `panel.format = "rgb565be"`, true colour - met exactly |
| Single-point touch | `touch.points: 1` - met exactly |
| Continuous gravity/tilt vector | not declared as such - `device.json` instead declares a raw ~200Hz accelerometer sample stream (`{"id":"accel","kind":"stream"}`), fused to pitch/roll by this port's own `gos_hal_shim.c`. Functionally met: GUNSHIP's `GOS_AIM_TILT_ABS` mode (the donor's own default, unchanged) reads the exact same `in->aim_x`/`in->aim_y` fields it always has. |
| >=65536 bytes scratch per active game | met with wide margin for GUNSHIP/LUCKY 7/AIM TEST/DIAG - all four states are well under half that budget, now allocated through `shell.c`'s own real `heap_caps_calloc()` per launch (`NOTICE.md`) rather than plain static globals, matching the donor's own real allocation shape. GOLF's own per-hole procedural state is a different order of magnitude entirely - see "GOLF's memory budget" below - but it lives in this module's own sized wasm linear memory, not this Demand's 65536-byte figure |
| *(prefers)* 8-voice synth, save slot | absent, stated gaps - no sound HAL, no NVS-equivalent on this ABI (see `NOTICE.md`'s "Not carried at all" and "No NVS persistence") |
| *(prefers)* raw ~200Hz accel stream | **met** - GUNSHIP's tilt aim (fused to pitch/roll), and GOLF's own swing detector, both unmodified from the donor |

**GOLF, AIM TEST and DIAG all ship on this port.** AIM TEST/DIAG are new
this task - vendoring the real shell means vendoring the real
`components/gos_shell/apps.c` alongside it, which is where the donor keeps
them (not `components/games/`, where a from-scratch port would have had no
reason to look). GOLF still ships esp32-only, unchanged from before this
task - see `NOTICE.md`'s "GOLF: font and memory, two declared
substitutions" for the full argument, restated below in "GOLF's memory
budget."

Verdict is `degraded`, not `go`: the 60fps Demand is unproven (never
`refuse` - nothing about this port's own correctness is in question) and
two Prefers stay stated gaps. `mode` is `adaptation` (this bundle has no
pixel-exact reference for gameos on any pack to diff against from WITHIN
this repository's own harness - the rp2350 port is `adaptation` too. This
task adds a SECOND, independent kind of proof this port did not have
before: a pixel comparison against the donor's own reference material,
external to this repository entirely - see "Donor-reference comparison"
below).

## GOLF's memory budget

`golf_t` (`golf_int.h`), the whole of GOLF's own per-hole procedural state,
sized exactly against its own field list:

| field | size |
|---|---|
| `green_grid`/`sand_grid`/`water_grid` (3x `GRID_W*GRID_H` float, `GRID_W=736/4+2=186`, `GRID_H=896/4+2=226`) | 3 x 186x226x4 = 504,432 B |
| `mottle` (`WORLD_W*WORLD_H` int8, `736x896`) | 659,456 B |
| `rough`/`background` (2x `WORLD_W*WORLD_H` uint16) | 2 x 736x896x2 = 2,637,824 B |
| `band_lut`, player/hazard/confetti/board arrays, scalars | ~10 KB |
| **`golf_t` total** | **~3.8 MB** |

Plus GOLF's own full-resolution direct-mode framebuffer (`gos_gfx_fb565()`,
`esp_heap_caps.h`'s static backing array): `368 x 448 x 2 = 329,728 B`
(~322 KB). As of this task, `esp_heap_caps.h` carries a SECOND static
arena too - a 4 MiB pool for `shell.c`'s own real per-launch game-state
allocation (`NOTICE.md`), sized with generous headroom over `golf_t`'s own
~3.8MB (the largest of this bundle's five game states by a wide margin,
generously rounded rather than computed to the exact byte since that type
is not visible from `esp_heap_caps.h`'s own include position - see that
file's own header comment). Together with the rest of this port's own
static state (`gfx.c`'s double-buffered 184x224 indexed `fb[2]`, the
palette LUTs, `runtime_core.c`'s 8KB arena), this port's build command
(below) pins the module's wasm linear memory EXPLICITLY at **8 MB**
(`packs/esp32-s3-touch-amoled-18/wasm/build.ts --wasm-memory-mb 8`) -
matching the donor's own stated 8MB PSRAM target
(`packs/esp32-s3-touch-amoled-18/docs/decisions/0003-...` cites it), a
round, documented ceiling this task's own larger game-state arena still
fits inside. `--wasm-memory-mb` is opt-in and additive to
`packs/esp32-s3-touch-amoled-18/wasm/build.ts`: no other app built against
this pack (the reference demo, chrono) is affected unless it also passes
the flag.

## Donor-reference comparison

This task re-anchored verification on the DONOR, not on this port's own
prior captures - two independent checks, both attempted for real:

**(a) Pixel comparison against the donor's own reference screenshot.**
`apps/gameos/reference/esp32-gameos/media/launcher.png`, downloaded
byte-for-byte from the donor repository, versus this module's own captured
shell frame (`scripts/capture-gameos-esp32-shell-frame.ts` ->
`apps/gameos/reference/esp32-gameos/donor-shell-comparison/
our-shell-boot.png`), compared structurally and at the pixel level
(`scripts/compare-gameos-esp32-shell-vs-donor.ts`). Result: **every
region both images share draws pixel-identical**, at 5/6/5 (RGB565)
precision (one expected, explained gap - a channel-expansion rounding
convention difference between the donor's own screenshot tool and this
repository's own canvas capture, not a rendering difference - see the
comparison's own README for the measured per-channel offset that proves
it):

```
GUNSHIP tile (grid slot 0): 0/19488 px differ (0.0%)
bottom bar (SET/GAMEOS/USB): 0/19136 px differ (0.0%)
```

The two images' TILE CONTENT differs (three tiles in the donor's own
screenshot versus five in this port's capture) - explained fully in
`apps/gameos/reference/esp32-gameos/donor-shell-comparison/README.md`:
the donor's own `media/launcher.png` predates `golf.c`/`slots.c` being
wired into `registry.c`'s `g_games[]` at all (checked against the donor
repository's own git history, not assumed), so it is the donor's own
reference material that is stale, not a divergence this port introduced -
this port compiles the CURRENT, real `registry.c`, unmodified.

**(b) The donor's own host-side frame-dump method.** Documented in
`docs/testing-and-verification.md` (vendored, `../../reference/
esp32-gameos/testing-and-verification.md`), but its actual harness code
(`simN.c`, `fakeinc/`) is not part of the vendored repository (session
scratchpads only, per the donor's own doc). A from-scratch equivalent
(`apps/gameos/reference/esp32-gameos/donor-shell-comparison/hostsim/
hostsim_main.c`) was written for this task, reusing this port's own real
vendored source and its own `gos_hal_shim.c`. **It compiles cleanly for a
host-native target. It could not be linked into a runnable executable on
this machine** - `zig cc` segfaults deterministically at the link step,
reproduced against this driver AND against a one-line `int
main(void){return 0;}` control case, isolating the cause to this
machine's own native-link path, not this driver or the donor's method (the
wasm32-freestanding path this whole repository actually depends on is
unaffected - only the host-native link is broken here). **Not runnable in
this environment**, stated plainly per `hostsim/README.md`'s own attempt
log, not faked or silently skipped.

## What is real

Every one of `apps/gameos/invariants.ts`'s eight invariants (the launcher-
related ones, (1)/(2)/(5), REWRITTEN this task against the real shell; the
game invariants (3)/(4)/(6)/(7) re-verified, unchanged in shape, against
the rebuilt module; (8) NEW this task for AIM TEST/DIAG) passes against
this module, replaying this port's own `apps/gameos/traces/
gameos-demo-esp32.trace.json` - a FRESH recording this task (the real
shell's five-tile grid, pause-overlay-then-QUIT exit flow, and mandatory
first-run calibration tap all mean the prior recording's touch coordinates
no longer land correctly - see that trace's own recording script,
`scripts/record-gameos-shell-trace.ts`, for the full argument, including
one real bug that recording caught: the pause overlay's own QUIT and
CALIBRATE hit-zones overlap by 4px once `shell.c`'s own 12px touch-Y bias
is applied, so an earlier tap coordinate silently re-entered calibration
instead of quitting - fixed by moving the tap 20px lower, comfortably
inside QUIT's zone only).

Every invariant was proven red-before-green against THIS rebuilt module,
by deliberately breaking this port's own glue code - never the vendored
shell, engine, or games:

| invariant | broken by | caught it |
|---|---|---|
| (1) grid draws real content | `esp32gameos_tick()` stops calling `shell_frame()` entirely | yes - all three grid16/48/80 captures failed on the cyan-icon sub-check specifically (0px cyan: an unpainted panel reads as solid black, which still has plenty of "dark" pixels but none of the tile icons' cyan) |
| (2) tapping a tile launches | `gosport_set_frame()` forces every touch to panel (0,0), outside every tile's own hit zone (isolated from (1): a tap still registers, so the calibration wizard still dismisses and the grid still renders correctly - only WHERE a tap lands is broken) | yes - launch transition read 0px, cascading into every downstream GUNSHIP/LUCKY 7/GOLF/AIM TEST/DIAG check exactly as this file's own header comment predicts, since none of them can ever be reached |
| (3) simulation keeps advancing | (unchanged from before this task - not re-broken, since its own shape did not change; re-verified green against the rebuilt module, see the PASS run in this bundle's own reproduction log) | - |
| (4) GUNSHIP's thermal palette holds | (unchanged from before this task; re-verified green) | - |
| (5) exiting GUNSHIP/LUCKY 7 reproduces the grid exactly | `hal_power_get()` reports a battery percentage that drifts with elapsed time instead of this port's real, honest "no battery HAL" (always absent) - `shell.c`'s own `draw_bottom_bar()` (vendored, unmodified) reads it on every grid render, so a later return shows a different percentage than grid80's own earlier one | yes - backToGrid/backToGridFromLucky7 read 68px/96px instead of 0 (this same break also tripped the shell's own real low-battery auto-pause logic mid-GUNSHIP-play, a genuine, honest side effect of a fake battery reading crossing the shell's real 1-5% threshold, caught by invariant (3) at the same time - a legitimate double catch, not a flaw in the isolation) |
| (6) GOLF's swing changes ball state | (unchanged from before this task; re-verified green) | - |
| (7) GOLF's own return to the grid is exact | same `hal_power_get()` break as (5) | yes - backToGridFromGolf read 768px instead of 0 |
| (8) AIM TEST and DIAG each open and return to the grid exactly | same `hal_power_get()` break as (5)/(7) | yes - both open+return checks failed (792px/780px instead of 0 on the return side) |

## Reproducing this port

```
ZIG_EXE=<path to zig.exe> bun run packs/esp32-s3-touch-amoled-18/wasm/build.ts --app apps/gameos/ports/esp32-s3-touch-amoled-18/gameos_port.c --wasm-memory-mb 8
bun run dev   # http://127.0.0.1:5340 - grid navigable (past the first-run calibration tap), all five tiles playable
bun run invariants wasm/dist/emu.wasm apps/gameos/traces/gameos-demo-esp32.trace.json apps/gameos/invariants.ts --at 1378,1629,1882,2331,2883,3396,4212,5188,5829,6257,7025,8157,10601,12005,45455,47862,49663,50087,51432,51873,53231
```

Donor-reference comparison:

```
CHROME_PATH=<path to chrome.exe> bun run scripts/capture-gameos-esp32-shell-frame.ts
bun run scripts/compare-gameos-esp32-shell-vs-donor.ts
```

## What is kept, what is adapted, what is genuinely new

| | Kept (real, unmodified) | Adapted | New |
|---|---|---|---|
| **The engine** | `core.c`/`gfx.c`/`input.c`/`font.c` - the real indexed-framebuffer renderer, the real one-euro-filter aim math, all three aim modes | the present pass (`gos_gfx_present()` calling this port's `hal_display_present()`) is deferred to `draw_band()`, one band at a time - see `gos_hal_shim.c`'s header comment | the HAL implementation itself (touch/button/IMU/audio/power-stub) |
| **The shell** | `registry.c`/`apps.c`/`shell.c` - the real launcher grid, settings, pause overlay, calibration wizard, debug overlay, per-frame orchestration, ALL real and unmodified as of this task | - | nothing - the real shell replaces every bit of this port's own former hand-rolled dispatcher (see this port's own git history before this task) |
| **GUNSHIP's aim** | `GOS_AIM_TILT_ABS`, the donor's own default, unchanged | pose SOURCE: this pack's raw accel stream, fused to pitch/roll by `gos_hal_shim.c` | - |
| **LUCKY 7's pull** | the donor's own touch-drag fallback, unchanged | - | - |
| **AIM TEST, DIAG** | `apps.c` - the donor's own two harness apps, real and unmodified | - | reachable from the grid because the real `registry.c` lists them - not this port's own decision |
| **GOLF** | `golf.c`/`golf_render.c`/`golf_cards.c`/`golf_int.h` - the real course generator, physics, swing detector, cards/flow, all unmodified | text: `font565_shim.c` substitutes for the LVGL-coupled `font565.c`; world state: `golf_t` lives in this module's own sized wasm memory instead of real PSRAM | `font565_shim.c`, `esp_heap_caps.h`'s real backing arrays, `gos_hal_shim.c`'s direct565 present/draw_band path |
| **All three games' escape** | the donor's own top-edge swipe-down gesture, exact thresholds, now pausing into the REAL shell's own overlay (RESUME/RESTART/CALIBRATE/QUIT) rather than exiting directly | destination on QUIT: the grid | - |
| **Sound, save** | - | - | absent - see `NOTICE.md` |
