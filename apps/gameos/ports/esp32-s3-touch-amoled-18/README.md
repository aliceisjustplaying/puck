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
| >=65536 bytes scratch per active game | met with wide margin - `gs_t`/`slots_t` are ~8.5KB/~1.4KB, plain static globals (same reasoning the rp2350 port gives: this port never performs a real puck-level app switch, so `app_alloc()`'s arena is not involved) |
| *(prefers)* 8-voice synth, save slot | absent, stated gaps - no sound HAL, no NVS-equivalent on this ABI (see `NOTICE.md`'s "Not carried at all" and `gos_hal_shim.c`) |
| *(prefers)* raw ~200Hz accel stream | **met** - the one Demand this port's pack extension actually satisfies, where the rp2350 sibling still cannot |

**GOLF is not part of this port**, the same way it is not part of this
bundle's `descriptor.md` at all (`apps/gameos/descriptor.md`'s Essence: "two
of the donor's six games"). See `NOTICE.md`'s "GOLF: stopped, not
attempted" for the two real blockers found (a genuine LVGL font-format
dependency in the donor's own `font565.c`, and several megabytes of
PSRAM-scale per-hole world state) and why neither was worked around with a
silent rewrite.

Verdict is `degraded`, not `go`: the 60fps Demand is unproven (never
`refuse` - nothing about this port's own correctness is in question, see
"What is real" below) and two Prefers stay stated gaps. `mode` is
`adaptation` (this bundle has no pixel-exact reference for gameos on any
pack to diff against - the rp2350 port is `adaptation` too - and BOOT is a
release-edge pulse on this ABI rather than a held level, the same honest
gap the rp2350 port's own aim-reconstruction already documents for a
different field).

## What is real

Every one of `apps/gameos/invariants.ts`'s five invariants passes against
this module, replaying `apps/gameos/traces/gameos-demo.trace.json`
unchanged (the same trace the rp2350 port's bundle entry uses), and every
one was proven red-before-green against THIS module specifically (not
inherited from the rp2350 port's own proof) by deliberately breaking this
port's own glue code - never the vendored engine or games - confirming the
intended failure, then restoring:

| invariant | broken by | caught it |
|---|---|---|
| (1) launcher draws real content | `launcher_render()` returns after the background clear | yes - all 3 boot captures |
| (2) tapping a card launches | `launcher_update()` always returns "stay" | yes - cascaded into (3)/(4) exactly as `invariants.ts`'s own header comment predicts |
| (3) simulation keeps advancing | skip `g->update()`, render only | yes - all 6 tick transitions |
| (4) GUNSHIP's thermal palette holds | force `gos_gfx_set_default_palette()` mid-play | yes - all 4 GUNSHIP captures |
| (5) returning to the launcher is exact | skip the palette/scanline/clip reset in `enter_launcher()` | yes |

## Reproducing this port

```
ZIG_EXE=<path to zig.exe> bun run packs/esp32-s3-touch-amoled-18/wasm/build.ts --app apps/gameos/ports/esp32-s3-touch-amoled-18/gameos_port.c
bun run dev   # http://127.0.0.1:5340 - launcher navigable, both games playable
bun run invariants wasm/dist/emu.wasm apps/gameos/traces/gameos-demo.trace.json apps/gameos/invariants.ts --at 16,48,80,192,304,700,1500,2316,2460,3212,4396,7004
```

## What is kept, what is adapted, what is genuinely new

Same shape as the rp2350 port's own table (`../rp2350-touch-amoled-18/
README.md`), restated for this port:

| | Kept (real, unmodified) | Adapted | New |
|---|---|---|---|
| **The engine** | `core.c`/`gfx.c`/`input.c`/`font.c` - the real indexed-framebuffer renderer, the real one-euro-filter aim math, all three aim modes | the present pass (`gos_gfx_present()` calling this port's `hal_display_present()`) is deferred to `draw_band()`, one band at a time - see `gos_hal_shim.c`'s header comment | the HAL implementation itself (touch/button/IMU/audio-stub) |
| **GUNSHIP's aim** | `GOS_AIM_TILT_ABS`, the donor's own default, unchanged | pose SOURCE: this pack's new raw accel stream, fused to pitch/roll by `gos_hal_shim.c` (a real board's own IMU task would do the identical fusion) | - |
| **LUCKY 7's pull** | the donor's own touch-drag fallback, unchanged | - | - |
| **Both games' escape** | the donor's own top-edge swipe-down gesture, exact thresholds | destination: the launcher, not a pause overlay | - |
| **The launcher** | - | - | byte-for-byte the same file as the rp2350 port's own |
| **Sound, save, GOLF** | - | - | absent - see `NOTICE.md` |
