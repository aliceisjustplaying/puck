# ESP32-S3-Touch-AMOLED-1.8: a device pack with no framebuffer

The same 368x448 AMOLED panel and the same enclosure as this repository's
reference pack, on a different chip with a different memory story. The RP2350
sibling keeps one full 330KB framebuffer in 520KB of SRAM and pushes dirty
rectangles out of it. **This board cannot**, and that is the point of the pack:
a 368x448 RGB565 frame is 322KB against 512KB of internal SRAM, and PSRAM is
not an answer because the CPU writing pixels and the panel's DMA reading them
would fight over the same external bus.

So there is no framebuffer anywhere here, on the board or in the emulator. The
panel is painted in 16 horizontal bands of 28 rows, each a 20KB buffer,
double-buffered against DMA. An app implements
[`draw_band()`](firmware/runtime/app.h) and gets handed one band at a time,
sixteen times a frame, with undefined prior content and nothing to diff
against.

**This board is the Waveshare ESP32-S3-Touch-AMOLED-1.8, and nothing else.**
Not the RP2350 board of the same name, in the same case, sold on the same page.

## What is proven, and on what

| | |
|---|---|
| The band pipeline, on real silicon | **Yes.** 50 full-panel frames per second, paced entirely by the DMA semaphore. |
| The panel bring-up, on real silicon | **Yes**, once the TCA9554 power sequence the inherited code was missing was added (`docs/decisions/0001`). |
| The apps' pixels, against the emulator | **Yes, both apps, at tolerance zero.** The reference app under a held finger and the chrono port at rest each matched the emulator pixel-for-pixel over devlink, all 164,864 of them (`apps/chrono/bundle.json`'s `silicon` attestation cites the commit). |
| devlink, on real silicon | **Yes.** `PING`, `APP`, `SWITCH`, touch injection and `SHOT` all answered; a full screenshot round trip costs 0.08s and RLE-compresses a black-on-white screen to 1482 bytes. |
| Touch, from a real finger | **No.** devlink injection drives the runtime's touch path; nobody has put a finger on this board through this pack. |
| The shake threshold | **No, and it needs a human.** See `gotchas.md`. |
| Flashing from the website | **No, not yet on this board.** The images, the artifact index, the write plan and the page's failure states are all checked without hardware; the serial round trip needs one human, one board and one click. |

## Building it

Two halves, two toolchains, one source of truth for the parts that matter.

**The emulator half** (`zig`, from the repository root):

```
bun run pack:esp32:build     # portable firmware + wasm/emu_shim.c -> wasm/dist/emu.wasm
bun run dev                  # http://127.0.0.1:5340
```

`--app <path.c>` swaps the reference app for another single C file filling this
pack's one app slot, which is how a port from `apps/` gets built:

```
bun run pack:esp32:build --app apps/chrono/ports/esp32-s3-touch-amoled-18/chrono.c
```

**The board half** (ESP-IDF v6.0.2, from `firmware/`):

```
idf.py set-target esp32s3
idf.py build
idf.py -DPUCK_APP_SOURCE=<absolute path to a .c> build   # the same app swap
```

`firmware/sdkconfig.defaults` is the only configuration input (the generated
`sdkconfig` is not committed). Flashing is `esptool` over the board's own USB
port; there is no drag-and-drop `.uf2` here the way there is on the RP2350:

```
cd build
python -m esptool --chip esp32s3 --port <PORT> -b 460800 \
    --before default-reset --after hard-reset write-flash "@flash_args"
```

**The website's artifact** (`tools/build-native.ts`) is the same build with two
steps after it: `esptool merge-bin` folds the three parts into one image at
offset 0, and a `manifest.json` records the chip, the flash parameters and each
image's MD5 so a browser can write it without reading `flasher_args.json`
itself.

```
bun run packs/esp32-s3-touch-amoled-18/tools/build-native.ts \
  --app apps/chrono/ports/esp32-s3-touch-amoled-18/chrono.c \
  --id chrono-esp32 --out site/flash-artifacts/esp32/chrono-esp32.bin \
  --manifest site/flash-artifacts/esp32/manifest.json
```

The run pages flash that image over Web Serial with Espressif's own esptool-js
(`site/flasher/esp32.ts`). Nothing on this board has answered that path yet:
see the table above.

## Driving it without a human: devlink

The board speaks the RP2350 pack's own
[devlink protocol](../rp2350-touch-amoled-18/tools/README-devlink.md), byte for
byte, over its native USB Serial/JTAG port - the same port the console logs to.
That is what lets `harness/links/devlinkLink.ts` drive both boards with one
adapter, and it is worth reading
[`docs/decisions/0002`](docs/decisions/0002-devlink-over-usb-serial-jtag.md)
before using it, because two of its details are not obvious:

- **`DEVLINK_DTR=0` is required.** This chip's USB Serial/JTAG peripheral wires
  the host's DTR line to GPIO0, which on this board is the BOOT button.
- **`SHOT` is answered one frame late.** There is no framebuffer to walk, so a
  screenshot arms a capture that fills as the next frame's bands go out to the
  panel.

```
DEVLINK_PORT=<PORT> DEVLINK_DTR=0 bun run harness:hardware:esp32
```

## The gate

```
bun run pack:esp32:gate
```

Five checks, no board and no toolchain needed, each one something this pack can
get wrong on its own. Every one of them was shown RED before it was shown
green, by breaking the thing it checks:

| Check | Broken by | What it printed |
|---|---|---|
| The platform seam is implemented for the board AND for wasm | deleting `rt_log()`'s body from `main/main.c` | `the board half (firmware/main/, firmware/devlink.c) does not implement: rt_log` |
| `device.json` matches `emu_device()`'s JSON on every ABI field | changing `device.json`'s panel width to 369 | `"panel": device.json has {"w":369,"h":448,"format":"rgb565be"}, emu_device() has {"w":368,...}` (the geometry check catches it too, which is the point of having both) |
| The band geometry in `runtime_core.h` is the one `device.json` declares | changing `BAND_ROWS` to 32 | `device.json says 28 rows per band, the C says 32; device.json says 16 bands, the C's geometry gives 14; device.json says a 20KB band buffer, the C's geometry gives 23KB` |
| No full-panel pixel buffer exists in the firmware | adding `static uint16_t g_fb[PANEL_W * PANEL_H];` to `main/display.c` | `a full-panel buffer of pixel-sized elements exists, which is the one thing this pack is built not to have` |
| The timing profile keeps its shadow-ledger claim boundary | changing `claimBoundary.cycleAccurate` to `true` | `timing.json differs from the pinned schema or values` |

The first of those is the check that would have caught the defect
`docs/decisions/0001` is about, with no board involved at all.

## Timing lab

[`timing.json`](timing.json) is the hardware profile and claim boundary.
[`timing/model.ts`](timing/model.ts) schedules CPU production and panel DMA on
separate clocks, while [`timing/consumer.ts`](timing/consumer.ts) strictly
decodes the optional `emu_timing_*` ledger exports. The report remains labeled
uncalibrated anywhere the profile or cycle costs are not measurements.

```
bun run pack:esp32:timing:test
bun run pack:esp32:gate
bun run packs/esp32-s3-touch-amoled-18/timing/report.ts <emu.wasm>
```

The last command emits stable JSON containing the accounted ledger and the
deterministic schedule. A module without timing exports produces an explicit
`"timingExports": "absent"` report and exits successfully.

## Layout

```
device.json           the emu_device() descriptor plus convention/memory metadata
firmware/
  runtime/            app.h (the band contract), runtime_core.h/.c (portable
                       frame loop: arena, the one app slot, input latching,
                       the per-band dispatch), gfx_band.h/.c
  apps/demo.c         the reference app: a bouncing square
  devlink.c/.h        the agent-facing command protocol (see decisions/0002)
  main/               the ESP-IDF half: main.c (loop + devlink wiring),
                       display.c (band DMA + the screenshot capture),
                       touch.c, button.c, imu.c
  sdkconfig.defaults  the only configuration input the board build takes
gate/run.ts           the pack checks above; gate/all.ts also runs timing tests
timing.json           hardware timing profile and claim boundary
timing/               deterministic scheduler, ledger consumer, CLI and tests
wasm/                 build.ts and emu_shim.c: the browser side
docs/decisions/       why
gotchas.md            what bites, and which claims are measured on this board
```
