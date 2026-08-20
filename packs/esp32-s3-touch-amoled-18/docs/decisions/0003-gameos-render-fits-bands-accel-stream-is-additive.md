# 0003: esp32-gameos's render fits the band contract unchanged; a raw accel stream is the one real addition

Date: 2026-08-20
Status: accepted

## The problem

`apps/gameos` (MikeWilson/esp32-gameos) is porting to this pack. Its own
`README.md` says the donor targets 8MB PSRAM and its engine renders into an
off-screen framebuffer, which reads as a direct conflict with this pack's
whole reason for existing (`AGENTS.md`'s "THE MEMORY MODEL"): no framebuffer
anywhere, 16 bands of 20KB, double-buffered, `draw_band()` the entire
contract. Two options were on the table before writing any port code:

(a) rewrite gameos's runtime against the band contract, keeping this pack's
    ABI untouched;
(b) extend this pack with a PSRAM-backed full-framebuffer present mode,
    additive, so the existing (donor-shaped) runtime ports nearly as-is.

Reading the donor's actual `components/gos_hal/hal_display.c` before
choosing between them changed the question.

## What the donor's own HAL actually does

`hal_display.c`'s own header comment: *"The game renders 184x224 indexed-8
in internal SRAM. A dedicated flush task ... upscales 2x through the
palette LUT into two ping-pong DMA band buffers (368x32 RGB565 each) and
pushes them with async draw_bitmap calls, so the DMA of band N overlaps the
scaling of band N+1."* That is a band-DMA pipeline, in internal SRAM,
architecturally the same shape this pack already has (16 bands of 28 rows
vs. the donor's 14 bands of 16 source rows - different tiling, same idea).
**Five of the donor's six screens - GUNSHIP, LUCKY 7, the launcher, and the
DIAG/AIM-TEST dev screens - draw through this indexed path and never touch
PSRAM.** Only GOLF (a full-resolution procedural course renderer) declares
`GOS_CAP_FB565` and calls `hal_display_present_565()`, which hands the panel
driver one already-built 368x448 RGB565 buffer straight from
`gos_gfx_fb565()`'s `heap_caps_calloc()` - real PSRAM, on real silicon,
because that particular game's own rendering approach needs random access to
every full-resolution pixel gunship/slots/the launcher never do.

So the donor is not "a PSRAM app"; it is five band-shaped games and one
full-resolution game sharing one HAL interface. The premise that motivated
option (b) - "the donor renders into a full off-screen framebuffer, that is
how every real esp32 app on this board works" - is true of one screen out of
six, not the architecture as a whole.

## Decision: (a) for gunship/slots/launcher/diag, and no NEW pack primitive for GOLF either

**gunship.c, slots.c, the DIAG/AIM-TEST screens, and this port's own
launcher** compile against `gos_core`'s real, vendored `gfx.c` unmodified
(see this app's own `NOTICE.md` for what "compile the real engine, not a
reimplementation" means for this port). `gfx.c`'s indexed 184x224 buffer
(`gos_gfx_fb()`, 41KB) is exactly the same shape as this pack's own
`app.h`/`gfx_band.h` contract wants fed to it: this port's `draw_band()`
does the 2x-nearest-plus-palette-LUT upscale for just the rows a given band
covers, reading straight out of that 41KB buffer and the palette LUT `gfx.c`
handed to this port's `hal_display_present()` shim at the end of the tick
(stashed as three pointers plus a bool, zero bytes copied - see the port's
own `gos_hal_shim.c`). **`app.h`, `gfx_band.h` and `runtime_core.h`'s
`draw_band()` contract are unmodified by this.** The band contract was
already exactly what it needed to be.

**GOLF** needed more thought, because `gos_gfx_fb565()` really does want a
329KB buffer nothing in 512KB of internal SRAM can spare. The fix is still
not a pack-level change: `draw_band()` is a generic "give me these pixels,
in this byte order, for this row range" callback, and it does not care
whether an app computes them on the fly from a small buffer (five of the six
games) or slices them out of a bigger one the app itself chose to keep. This
port's own `gos_hal_shim.c` implements `heap_caps_calloc()` (`GOS_CAP_FB565`
is the only call site in the real, vendored `gfx.c`) by handing back a
plain static 329KB array **that lives in this app's own module**, the wasm
equivalent of the PSRAM `heap_caps_calloc()` would actually return on real
silicon, and `draw_band()` blits the relevant 28-row slice of it, byte-swapped,
same as any other band. Nothing about `app.h`/`gfx_band.h`/`runtime_core.h`
needed to grow a full-framebuffer mode for this either: the "framebuffer" is
a GOLF-shaped choice inside one app's own module, the same way it is a
`gos_gfx_fb565()`-shaped choice inside the donor's own `gos_core` on real
silicon - not a platform-level concept this pack's HAL has to know about.

This also lines up with a precedent already in this pack:
[0002](0002-devlink-over-usb-serial-jtag.md) rejected a PSRAM screenshot
buffer that would sit ON the DMA path, and accepted one that sits off it
("the buffer is never on the DMA path ... which is what makes PSRAM
acceptable for it when a real framebuffer there would not be"). GOLF's
mirror is the same shape: the CPU reads it and writes into a `draw_band()`
buffer that is itself the thing the real DMA (or, in wasm, `plat_flush_band()`)
moves; nothing ever asks the DMA engine to touch it directly, on real
silicon or in the emulator.

**Result: option (a), and there was no option (b) left to take once the
donor's own HAL was actually read.** This pack's device.json memory model
(`"model": "band"`) is unchanged, `app.h`/`gfx_band.h`/`runtime_core.h` are
unchanged, and every existing consumer of this pack (the reference demo, the
chrono port) is unaffected - the property this task's brief asked to be
protected either way.

## The one real, additive change: a raw accelerometer sample stream

GOLF's swing detector and GUNSHIP's tilt aim both want continuous motion
data this pack's ABI did not publish at all: `device.json` declared only a
`"shake"` event sensor before this change, no continuous signal of any
kind (unlike the RP2350 sibling, which declares a fused `"gravity"` vector -
see that pack's `device.json`). A per-tick fused reading would not have been
enough for GOLF either way: `gos_hal.h`'s own comment on
`hal_imu_accel_read()` is explicit that "frame-rate sampling aliases short
bursts", which is exactly what a swing or a yank is.

So this pack's device.json gains one new sensor, additively:

```json
{ "id": "accel", "kind": "stream", "rateHz": 200, "unit": "g" }
```

`"kind": "stream"` is a new sensor kind alongside the existing `"event"` and
`"vector"`, documented in `wasm/emu_abi.h` next to `emu_sensor_vector()`:
the host calls the new OPTIONAL `emu_accel_sample(index, tMs, ax, ay, az)`
once per raw sample, in order, however many arrive between two `emu_tick()`s
- unlike `"vector"`'s one continuous, level-triggered reading, replaced in
place. `runtime_core.h`/`.c` gained a small ring (`rtcore_accel_sample()` /
`app_accel_read()`, `APP_ACCEL_RING` = 64 samples) that a consuming app
drains with the exact pull shape `gos_imu_accel_read()`/`hal_imu_accel_read()`
already use, so the vendored donor code needed a type rename in the shim and
nothing else.

**Additive, checked three ways**: (1) `app.h`'s `app_frame_t` and
`draw_band()` contract are byte-for-byte unchanged - a consumer of the
existing contract (the reference demo, the chrono port) never sees this at
all. (2) `emu_accel_sample()` is OPTIONAL on the wasm ABI, same
"unimplemented means uncalled" rule `emu_sensor_vector()` already
established, so `src/replayCore.ts`/`src/replay.ts` call it unguarded with
`?.()` and a trace with no `"accel"` events (every trace recorded before
this change) replays identically. (3) `device.json` gained a sensor
declaration, never removed or renamed one.

**What this does not do.** `firmware/main/` (the ESP-IDF board build) is not
touched: this task's scope is the emulator/wasm half only (ESP-IDF is not
installed on the machine this was built on), so a real accelerometer sample
stream feeding `rtcore_accel_sample()` from `main/imu.c`'s existing 200Hz
task is real, plausible, and NOT attempted here - the emulator and any
recorded trace are the only source of `"accel"` events today. This mirrors
the existing, stated pattern in `AGENTS.md`/`gotchas.md` for what is
emulator-only versus silicon-proven on this pack; it should not be read as
more than that.
