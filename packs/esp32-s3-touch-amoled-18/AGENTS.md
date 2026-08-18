# AGENTS.md - the device firmware

Firmware for the **Waveshare ESP32-S3-Touch-AMOLED-1.8**, the same 368x448
AMOLED panel and the same enclosure family as this repository's reference
pack, [`packs/rp2350-touch-amoled-18`](../rp2350-touch-amoled-18/). Different
MCU, different memory story: read this file before assuming anything here
works the way the sibling pack does.

`emu_device()` in [`wasm/emu_shim.c`](wasm/emu_shim.c) is the source of
truth for the emulator descriptor. [`device.json`](device.json) is the
comment-free documentation copy, with convention and memory metadata added,
and must match the ABI-relevant fields (`name`, `panel`, `buttons`, `touch`,
`sensors`) whenever `emu_device()` changes. `device.json` also carries
`"convention"` and `"memory"`, which are pack metadata rather than part of
the wire ABI, so they do not appear in `emu_device()`'s own JSON - the same
split the sibling pack's `device.json`/`emu_shim.c` pair uses.

## THE MEMORY MODEL: no framebuffer, and this is the whole point of the pack

The sibling RP2350 pack keeps one full 330KB framebuffer in its 520KB of
SRAM and pushes dirty rectangles out of it. This board's ESP32-S3 has 512KB
of internal SRAM and a 368x448 RGB565 frame is 322KB - it does not fit
twice, and PSRAM is not an answer either: the CPU writing pixels and the
DMA engine reading them would fight over the same external bus (see
`esp32-fluidbox/fluidbox/README.md`, section 2, "No framebuffer", in the
separate `s0lness/esp32-fluidbox` repository this pack's `main/` is adapted
from - this pack's board is the exact board that README is written
against).

So there is no framebuffer anywhere in this pack, board or emulator. The
panel is painted in **16 horizontal bands of 28 rows**, each a 20KB RGB565
buffer, double-buffered against DMA: `main/display.c` keeps two band
buffers and a counting semaphore initialised to 2, released by the panel's
transfer-done interrupt, so the CPU can be drawing band N+1 while band N is
still going out over QSPI. `firmware/runtime/app.h`'s `draw_band()` callback
is the entire contract this pack's apps write against - see that file's
header comment for exactly what a band buffer's undefined prior content
means for what `draw_band()` must do. `device.json`'s `"memory"` block
(`"model": "band"`, 16 bands of 28 rows, 20KB each, double-buffered) is
this pack's declared identity; nothing here should ever grow a persistent
framebuffer without renegotiating that block first.

## Building the wasm half

```
bun run pack:esp32:build   # from the repository root; needs zig
bun run dev                  # http://127.0.0.1:5340
```

Compiles `firmware/runtime/runtime_core.c`, `firmware/runtime/gfx_band.c`,
`firmware/apps/demo.c` and `wasm/emu_shim.c` to `wasm32-freestanding` and
writes the repository root's `wasm/dist/emu.wasm` - the one module the
emulator loads, so `pack:esp32:build && dev` shows this firmware with no
wiring step in between. `zig` comes off `PATH` unless `ZIG_EXE` says
otherwise. `wasm/build.ts`'s header explains why this pack needs no
`shim/` directory at all (unlike the sibling pack): its portable sources
include nothing beyond `app.h`, `gfx_band.h`, `runtime_core.h` and
`emu_abi.h` - no vendor display headers, no libc.

The wasm link segfaults intermittently for the same reason the sibling
pack's does (`zig cc`'s own linker bug under many `-Wl,--export=` flags,
verified by actually building rather than assumed from docs) - `build.ts`
retries automatically; this is not your change.

## `main/` is written but not yet flashed

Everything under `firmware/main/` - `main.c`, `display.c`, `touch.c`,
`button.c`, `imu.c`, and their CMake/component files - targets ESP-IDF
v5.5.5 and has **not been built or run against real hardware**. There is no
ESP-IDF installation on the machine this pack was written on, so this half
has none of the sibling pack's "confirmed working" weight behind it yet.
Treat it as a careful port, not a proven one, until someone flashes it and
updates this note.

What that means concretely, file by file:

- `display.c` is adapted **nearly verbatim** from
  `esp32-fluidbox/fluidbox/main/display.c` (separate repository,
  `s0lness/esp32-fluidbox`) -
  same board, same panel link, same `espressif/esp_lcd_co5300` driver, same
  80MHz QSPI clock, same board-revision probe. Only the two public entry
  points changed shape, to match `runtime_core.h`'s
  `plat_acquire_band()`/`plat_flush_band()` platform seam instead of
  fluidbox's own `display_acquire_band()`/`display_flush_band()`. This file
  inherits fluidbox's own proven claim about the display pipeline; it has
  not been independently reproven by this pack.
- `button.c` is adapted from `esp32-fluidbox/fluidbox/main/button.c` -
  same TCA9554 IO expander, same EXIO4 pin, same "leave every other pin's
  config alone" caution. Extended with the long-press verdict timing
  fluidbox's plain short-press reset never needed, since `device.json`
  declares `longPressMs` for `pwr` (mirroring the sibling pack's PWR
  semantics) and fluidbox's button never had to report one.
- `imu.c`'s bring-up (address probe, reset, range/ODR configuration) is
  adapted from `esp32-fluidbox/fluidbox/main/imu.c` -
  same QMI8658, same board. The shake DETECTOR built on top of that
  bring-up is new to this pack (fluidbox uses the IMU continuously for its
  fluid solver and has no discrete "shake" event) and has not been tuned
  against real hardware - see `gotchas.md`.
- `touch.c` has **no fluidbox counterpart at all**: that project probes for
  the CST820 only to tell the two board revisions apart, and never reads a
  touch coordinate. The FT3168 branch's register map is carried over from
  this repository's own RP2350 sibling pack
  (`packs/rp2350-touch-amoled-18/firmware/lib/Touch/FT3168.h`/`.c`),
  hardware-confirmed there on the same touch controller and panel family.
  The CST820 branch is the commonly published register map for that part,
  not confirmed anywhere in this repository or in fluidbox. See `touch.c`'s
  own header comment for the full provenance split.
- `main.c` is a new, single-task main loop (this pack has no fluid solver
  needing a second core the way fluidbox does): poll touch, PWR, BOOT and
  the IMU, then call `rtcore_tick()`, which itself paces the loop through
  `display.c`'s DMA semaphore.

## Layout

```
device.json          the emu_device() descriptor plus convention/memory metadata
firmware/
  runtime/            app.h (the band contract), runtime_core.h/.c (portable
                       frame loop: arena, the one reference app, input
                       latching, the per-band dispatch - compiles for both
                       the board and wasm32-freestanding), gfx_band.h/.c
                       (fill/fill-rect helpers that clip full-screen
                       coordinates into one band)
  apps/demo.c         the one reference app: a bouncing square, proving
                       tick()/draw_band(), PWR short press, BOOT click and
                       touch drag
  main/               the ESP-IDF half - see "not yet flashed" above
docs/                 none yet; see "What this pack does not have yet" below
wasm/
  build.ts            compiles the portable firmware + emu_shim.c to
                       wasm/dist/emu.wasm
  emu_shim.c           the browser side: emu_abi.h, the platform seam
                       (rt_log/rt_halt/plat_acquire_band/plat_flush_band),
                       and a shadow framebuffer that DOES NOT EXIST ON THE
                       REAL CHIP - see that file's header comment for why
                       the emulator host still needs one
gotchas.md            hardware traps, most inherited from fluidbox
```

## What this pack does not have yet

Unlike the RP2350 sibling, this pack has no `docs/decisions/`, no `gate/`
invariant checker, and no README with screenshots/GIFs. It ships one
reference app and `device.json` declares no `"apps"` array, so there is
nothing yet worth a menu, a decision record, or a static-invariant checker
of its own - the repository root's `bun run typecheck` / `bun run verify`
already cover what this pack's own gate would check today (that the wasm
module builds, exports the right symbols, and the emulator can drive it).
Add these the day a second app or a real flash makes them earn their keep.

## Conventions

Same as the rest of this repository (root `AGENTS.md`): TypeScript only for
anything that is not firmware, no `.js`/`.mjs`, no em dashes anywhere,
`zig`/`cmake`/`idf.py` are binaries this pack's scripts invoke, never a
language anything here is authored in.
