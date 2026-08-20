# NOTICE: what this pack vendors, and from where

`docs/convention/device-pack.md` requires a pack to be self-contained: the
folder, not this repository, is the unit of portability. So this pack
copies what it needs rather than reaching into a sibling pack's directory,
and this file is the record of every copy.

Everything below comes from **`packs/rp2350-touch-amoled-18/`** in this same
repository, MIT licensed (see the repository root's `LICENSE`), and every
copied file carries a note at its own top saying so. Nothing here is
third-party.

## Byte-for-byte, plus a vendoring note at the top

| this pack | source |
|---|---|
| `runtime/app.h` | `firmware/runtime/app.h` | `app_tilt_t` and `TILT_UP_*` are copied field for field (same units, same meaning), with two short adaptation notes added inline: `up` has no landscape-rotation runtime here to rotate it, and `coasting` is always false (no magnitude-trust gate on this pack - see `runtime/sensors.h` below). |
| `runtime/digits.h` | `firmware/apps/digits.h` |
| `runtime/digits.c` | `firmware/apps/digits.c` |
| `wasm/shim/math.h` | `wasm/shim/math.h` |
| `wasm/shim/stdio.h` | `wasm/shim/stdio.h` |
| `wasm/shim/stdlib.h` | `wasm/shim/stdlib.h` |

The RP2350 numbers and hardware arguments in `app.h`'s comments are kept
deliberately. They are the measurements that SHAPED the contract this pack
adopts, and paraphrasing them into browser terms would quietly turn a
vendored copy into a fork.

`digits.c`/`.h` are app-support code, not device code, and a pack would not
normally carry them. They are here because `apps/chrono`'s reference source
includes `"digits.h"` as a bare filename, and vendoring it is what makes
"a port compiles here unchanged" true for chrono rather than
true-except-for-one-header.

## Copied with one stated change

| this pack | source | the change |
|---|---|---|
| `runtime/gfx.h` | `firmware/runtime/gfx.h` | the two Waveshare vendor `#include`s are gone and `PANEL_W`/`PANEL_H` are the same two numbers written out, because a browser has no vendor driver header to read them from. Every declaration, constant and comment is otherwise the sibling's. |

## Reimplemented, not copied, and why a copy would have been wrong

| this pack | its counterpart | why |
|---|---|---|
| `runtime/gfx.c` | `firmware/runtime/gfx.c` | half of that file is a QSPI driver call. The portable half - `gfx_fill_rect`'s clip, `gfx_push`'s 8-pixel widening and edge slide, and the landscape mapping - is copied line for line, because a port that draws the same rectangles has to land on the same pixels. The framebuffer becomes a static array and the driver call becomes a `panel_push()` seam. |
| `runtime/sensors.h` | `firmware/runtime/sensors.h` | the sibling's is ~420 lines describing an FT3168, a QMI8658, an AXP2101 register map, a flash chip-select borrow and a devlink injection surface. None of it exists here. The four KEY_* bit VALUES, `touch_sample_t`, and every function name and signature are carried over exactly, because a port's `f->key & KEY_SHORT` must mean the same thing on both targets; the prose is this pack's own. This is the one file where copying would have been dishonest. `sensors_tilt(app_tilt_t *out)` is this pack's own addition (the sibling has no equivalent declaration here - its tilt signal lives in a separate `tilt.h`/`tilt.c`, read directly by `runtime_core.c`), added so this pack has somewhere to declare the one function `wasm/emu_shim.c` needs to hand `runtime_core.c` a real `app_tilt_t`. |
| `runtime/runtime_core.c` | `firmware/runtime/runtime_core.c` | roughly 400 of the sibling's 685 lines are the menu chord and the power-off gesture, both answers to hardware questions a browser does not ask (see `runtime/runtime_core.h`). Everything an app can observe through `app_frame_t` is carried over line for line, including one new line calling `sensors_tilt(&frame.tilt)` every frame - the same "read the published signal once per tick" shape the sibling's own `tilt_read()` call already has, just declared in `sensors.h` instead of a dedicated `tilt.h` (see that file's own NOTICE entry above). |
| `wasm/emu_shim.c` | `wasm/emu_shim.c` | same structure, same section order, same ring shapes, same `emu_device()` string builder including its apps-array dedup. The sound and tunables surfaces are absent (this pack declares neither). Both shims feed `app_frame_t.tilt` from their own vector-sensor state (the sibling's real QMI8658-through-`tilt.c` path on silicon, this pack's own `sensors_tilt()` from an already browser-filtered vector); that shared field, not a private accessor, is what lets `apps/fluidbox`'s rp2350 port file compile here unedited. |
| `host/host.ts` | `src/motion.ts`, `src/panel.ts` | the shared instrument, which a pack must not import. The RGB565-big-endian pixel read and the devicemotion sign mapping are duplicated with attribution; both are small, both are load-bearing, and a wrong copy of either is visible immediately (garbled colours; fluid pouring the wrong way), which is the property that makes duplicating them safe. |
