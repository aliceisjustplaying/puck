# Port verdict: esp32-s3-touch-amoled-18

**The featured module for this bundle's gallery card.** This is the chip
family (ESP32-S3) esp32-gameos itself targets, and this port compiles the
donor's own real engine and games, unmodified - see `NOTICE.md` for exactly
what is vendored byte-for-byte versus new. The sibling `rp2350-touch-amoled-18`
port stays listed as the cross-chip port (a from-scratch reimplementation of
the same `gos.h` contract on different silicon).

## Verdict: degraded

Comparing `apps/gameos/descriptor.md`'s `Demands` against this pack's
`device.json` (`packs/esp32-s3-touch-amoled-18/device.json`):

| Demand | Fit |
|---|---|
| **60fps** | unproven - the emulator cannot measure timing (same honesty standard every port in this repository states; see `docs/harness.md`'s "What this catches, and what it cannot"). Unlike the rp2350 port, there is no cross-architecture compute gap to worry about here: this pack's board IS the chip family the donor benchmarked 60fps on, running the donor's own unmodified code. No silicon run of this exact build exists, so "plausible" is the honest ceiling, not "proven." |
| Colour panel, >=256-entry palette | `panel.format = "rgb565be"`, true colour - met exactly |
| Single-point touch | `touch.points: 1` - met exactly |
| Continuous gravity/tilt vector | not declared as such - `device.json` instead declares a raw ~200Hz accelerometer sample stream (`{"id":"accel","kind":"stream"}`, new this task - see `packs/esp32-s3-touch-amoled-18/docs/decisions/0003-...`), fused to pitch/roll by this port's own `gos_hal_shim.c`. Functionally met: GUNSHIP's `GOS_AIM_TILT_ABS` mode (the donor's own default, unchanged) reads the exact same `in->aim_x`/`in->aim_y` fields it always has. |
| >=65536 bytes scratch per active game | met with wide margin for GUNSHIP/LUCKY 7 - `gs_t`/`slots_t` are ~8.5KB/~1.4KB, plain static globals (same reasoning the rp2350 port gives: this port never performs a real puck-level app switch, so `app_alloc()`'s arena is not involved). GOLF's own `golf_t` is a different story entirely - see "GOLF's memory budget" below - but it lives in this module's own sized wasm linear memory, not this Demand's 65536-byte figure (which descriptor.md states per-game, against the ORIGINAL games' own scratch needs; GOLF is new surface this pack extension had to answer for on its own terms) |
| *(prefers)* 8-voice synth, save slot | absent, stated gaps - no sound HAL, no NVS-equivalent on this ABI (see `NOTICE.md`'s "Not carried at all" and `gos_hal_shim.c`) |
| *(prefers)* raw ~200Hz accel stream | **met** - the Demand this port's pack extension satisfies, where the rp2350 sibling still cannot: GUNSHIP's tilt aim (fused to pitch/roll), and now GOLF's own swing detector (integrated directly, unmodified, the donor's own preferred input) |

**GOLF ships on this port** (the launcher's third card) - the rp2350
sibling still does not carry it, and `apps/gameos/descriptor.md`'s Essence
now names it a bundle-level game rather than out of scope entirely. Two
real blockers a prior pass at this port found (recorded in this bundle's
git history, since resolved) each needed a real, honestly-declared
substitution, never a silent rewrite - see `NOTICE.md`'s "GOLF: font and
memory, two declared substitutions" for the full argument:

- **Font**: GOLF's full-resolution text (`gos_gfx_text565`) reads Montserrat
  glyphs out of LVGL's own font format on real silicon; this port has no
  LVGL. `font565_shim.c` substitutes the SAME 5x7 dot font this port
  already draws the launcher/GUNSHIP/LUCKY 7 with, integer-scaled to
  GOLF's six requested point sizes. Text appearance only differs; nothing
  else does.
- **Memory**: GOLF's per-hole procedural world state (`golf_int.h`'s
  `golf_t`) plus its own full-resolution RGB565 framebuffer come to several
  megabytes of static state, living in this module's own wasm linear
  memory, sized explicitly - see "GOLF's memory budget" below.

Verdict is `degraded`, not `go`: the 60fps Demand is unproven (never
`refuse` - nothing about this port's own correctness is in question, see
"What is real" below) and two Prefers stay stated gaps. `mode` is
`adaptation` (this bundle has no pixel-exact reference for gameos on any
pack to diff against - the rp2350 port is `adaptation` too - and BOOT is a
release-edge pulse on this ABI rather than a held level, the same honest
gap the rp2350 port's own aim-reconstruction already documents for a
different field).

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
(~322 KB). Together with the rest of this port's own static state
(`gs_t`/`slots_t`, `gfx.c`'s double-buffered 184x224 indexed `fb[2]`, the
palette LUTs, `runtime_core.c`'s 8KB arena) the module's actual measured
wasm linear memory, letting wasm-ld size it however it needs to
(no `--wasm-memory-mb` flag), comes to **5.44 MB**. This port's own build
command (below) instead pins it EXPLICITLY at **8 MB**
(`packs/esp32-s3-touch-amoled-18/wasm/build.ts --wasm-memory-mb 8`) -
matching the donor's own stated 8MB PSRAM target
(`packs/esp32-s3-touch-amoled-18/docs/decisions/0003-...` cites it), a
round, documented ceiling with real headroom over the measured 5.44MB
rather than the linker's own tightest-fit default. `--wasm-memory-mb` is
opt-in and additive to `packs/esp32-s3-touch-amoled-18/wasm/build.ts`: no
other app built against this pack (the reference demo, chrono) is affected
unless it also passes the flag.

## What is real

Every one of `apps/gameos/invariants.ts`'s seven invariants passes against
this module, replaying this port's own `apps/gameos/traces/
gameos-demo-esp32.trace.json` (SEPARATE from the rp2350 port's shared
`gameos-demo.trace.json` - this port's launcher.c laid out three cards
instead of two, moving the GUNSHIP/LUCKY 7 card positions, so replaying the
old shared trace's touch events against the new layout would not reliably
land on the right card any more; see `launcher.c`'s own header comment).
Every one was proven red-before-green against THIS module specifically by
deliberately breaking this port's own glue code - never the vendored
engine or games - confirming the intended failure, then restoring:

| invariant | broken by | caught it |
|---|---|---|
| (1) launcher draws real content | `launcher_render()` returns after the background clear | yes - all 3 boot captures |
| (2) tapping a card launches | `launcher_update()` always returns "stay" | yes - cascaded into (3)/(4) exactly as `invariants.ts`'s own header comment predicts |
| (3) simulation keeps advancing | skip `g->update()`, render only | yes - all 6 GUNSHIP/LUCKY 7 tick transitions |
| (4) GUNSHIP's thermal palette holds | force `gos_gfx_set_default_palette()` mid-play | yes - all 4 GUNSHIP captures |
| (5) returning to the launcher is exact | skip the palette/scanline/clip reset in `enter_launcher()` | yes |
| (6) GOLF's swing changes ball state | starve `gos_hal_shim.c`'s `hal_imu_accel_read()` (return 0 samples always) | yes - `swing_poll()` never leaves `SWING_WAIT`, `fire_shot()` never runs |
| (7) GOLF's own return to the launcher is exact | drop the new `gos_gfx_direct565(false)` call from `enter_launcher()` | yes - the launcher renders behind GOLF's still-active direct565 framebuffer instead of replacing it |

## Reproducing this port

```
ZIG_EXE=<path to zig.exe> bun run packs/esp32-s3-touch-amoled-18/wasm/build.ts --app apps/gameos/ports/esp32-s3-touch-amoled-18/gameos_port.c --wasm-memory-mb 8
bun run dev   # http://127.0.0.1:5340 - launcher navigable, all three games playable
bun run invariants wasm/dist/emu.wasm apps/gameos/traces/gameos-demo-esp32.trace.json apps/gameos/invariants.ts --at 586,821,1073,1533,2099,2603,3404,4362,4771,5492,6603,9015,43535,45955,47342
```

## What is kept, what is adapted, what is genuinely new

Same shape as the rp2350 port's own table (`../rp2350-touch-amoled-18/
README.md`), restated for this port:

| | Kept (real, unmodified) | Adapted | New |
|---|---|---|---|
| **The engine** | `core.c`/`gfx.c`/`input.c`/`font.c` - the real indexed-framebuffer renderer, the real one-euro-filter aim math, all three aim modes | the present pass (`gos_gfx_present()` calling this port's `hal_display_present()`) is deferred to `draw_band()`, one band at a time - see `gos_hal_shim.c`'s header comment | the HAL implementation itself (touch/button/IMU/audio-stub) |
| **GUNSHIP's aim** | `GOS_AIM_TILT_ABS`, the donor's own default, unchanged | pose SOURCE: this pack's new raw accel stream, fused to pitch/roll by `gos_hal_shim.c` (a real board's own IMU task would do the identical fusion) | - |
| **LUCKY 7's pull** | the donor's own touch-drag fallback, unchanged | - | - |
| **GOLF** | `golf.c`/`golf_render.c`/`golf_cards.c`/`golf_int.h` - the real course generator, physics, swing detector (fed by this pack's raw accel stream, its own preferred input, unchanged math), cards/flow, all unmodified | text: `font565_shim.c` substitutes for the LVGL-coupled `font565.c` (see `NOTICE.md`); world state: `golf_t` lives in this module's own sized wasm memory instead of real PSRAM (`heap_caps_calloc`) | `font565_shim.c`, `esp_heap_caps.h`'s now-real backing array, `gos_hal_shim.c`'s direct565 present/draw_band path |
| **All three games' escape** | the donor's own top-edge swipe-down gesture, exact thresholds | destination: the launcher, not a pause overlay | - |
| **The launcher** | - | a third card (GOLF), re-laid-out card geometry - no longer byte-for-byte the rp2350 port's own file, see `launcher.c`'s header comment | - |
| **Sound, save** | - | - | absent - see `NOTICE.md` |
