# NOTICE: what this port vendors, and from where

Everything below comes from **[`MikeWilson/esp32-gameos`](https://github.com/MikeWilson/esp32-gameos)**
(commit `93d0063156a548d2fb1ffea1adb2f88af93dff08`), MIT licensed (`../../reference/esp32-gameos/LICENSE`,
copied unchanged). Nothing here is third-party beyond that one donor repository.

## Byte-for-byte

| this port | source | via |
|---|---|---|
| (compiled in unmodified) | `components/gos_core/include/gos.h` | `../../reference/esp32-gameos/gos.h`, `#include`d bare by the two game files below and by `gos_runtime.c` |
| (compiled in unmodified) | `components/games/gunship/gunship.c` | `../../reference/esp32-gameos/gunship.c`, `#include`d by `gameos_port.c` |
| (compiled in unmodified) | `components/games/slots/slots.c` | `../../reference/esp32-gameos/slots.c`, `#include`d by `gameos_port.c` |

`gunship.c` and `slots.c` compile against this port's own `gos.h` implementation with **zero
source changes** - see `gameos_port.c`'s own header comment for the two libc functions
(`abs()`/`snprintf()`) it `#define`s around the `#include` of `slots.c` because this pack's
freestanding wasm32 target does not declare them, and `gos_runtime.c`'s own comment on why that
is the only accommodation either game file needed.

`gos_runtime.c`'s 5x7 bitmap font table (`s_font5x7`) is copied from the donor's
`components/gos_core/font.c`, which is itself "classic public-domain 5x7 monospace font, ASCII
32..126" per that file's own header comment - not GameOS's own original work, but reproduced
here exactly as GameOS itself carries it.

`gos_runtime.c`'s spatial hash grid (`gos_grid_init/clear/insert/query`) and RNG
(`gos_rand/gos_rand_range/gos_randf`) are copied line-for-line from the donor's
`components/gos_core/core.c` - pure data structures and math with no HAL dependency, so a
differently-behaving grid or a differently-seeded RNG would be a silent behavioural fork of the
donor's own game logic (GUNSHIP's spatial queries and both games' RNG-seeded content are tuned
against these exact functions), not a legitimate reimplementation.

`gos_runtime.c`'s indexed-framebuffer primitives (`gos_gfx_clear/pixel/hline/vline/line/rect/
rect_fill/circle/circle_fill/circle_soft/quad_fill/blit/blit_rot`, the default palette, and the
5x7 glyph draw) are copied line-for-line from the donor's `components/gos_core/gfx.c` for the
same reason: this is pure rasterization math, and a differently-rounded circle or a
differently-clipped fill would visibly diverge from what the donor's own games were tuned to
draw.

## Reimplemented, not copied, and why a copy would have been wrong

| this port | its counterpart | why |
|---|---|---|
| `gos_runtime.c`'s present pass (2x upscale + `gfx_push`), palette LUT byte-swap, and scanline row rule | `gos_core/gfx.c`'s `gos_gfx_present()` (calls `hal_display_present()`) | half of the donor's version is a call into `gos_hal`'s QSPI/DMA driver and a hardware palette-LUT upscale unit. The portable half - which output row gets the dim LUT when scanlines are on - is kept exactly; the driver call becomes this pack's own `gfx_push()`. |
| `gos_runtime.c`'s input snapshot builder (`gosrt_build_input`), the one-euro filter and pow-1.4 aim curve | `gos_core/input.c` | the donor's version reads `hal_imu_get()`/`hal_touch_read()`/`hal_button_down()` (ESP-IDF/FreeRTOS HAL calls) and a `GOS_AIM_GYRO_RATE` mode this ABI has no signal for at all (no gyro, only a filtered gravity vector - see the port README's Demands table). The **filter and curve math** (one-euro, `pow(m, 1.4)`, the deadzone, the exact constants) is kept exactly, because that is the felt character of GUNSHIP's aim; the **pose source** is this pack's own `app_frame_t.tilt`, reconstructed to pitch/roll via `atan2f`, the same formula shape `hal_imu.c`'s own accelerometer fusion uses. |
| `gos_runtime.c`'s `gosrt_swipe_exit()` | `gos_shell/shell.c`'s own top-edge swipe detector (the donor's OS-level pause gesture) | the donor's shell (a 694-line Wii-menu launcher with settings, a pause overlay and a first-run calibration wizard) is not ported at all - see `README.md`'s Essence note on why. The **gesture itself** (press `y<14`, drag past `40` render px, both render-space numbers from `docs/input-and-ux.md`) is kept exactly and repurposed as this show-phase port's only way back to the launcher. |
| `launcher.c` (the whole file) | `gos_shell/shell.c` + `gos_shell/apps.c` (960 lines together) | a new, small picker against the same `gos.h` primitives the two games already use - not a port of the donor's own launcher. See `README.md`. |
| `gameos_port.c` (the whole file) | `main/main.c` + `gos_core/loop.c` (the donor's own boot/frame-loop glue) | this pack's own dispatcher: three screens in one puck app slot, built against `app.h`/`gfx.h` directly. Nothing here is a port of ESP-IDF `app_main()` or FreeRTOS task setup, neither of which has an equivalent on this ABI. |

## Not carried at all

`gos_core/mixer.c` (the 8-voice synth), `gos_hal/*` (every driver: display, touch, IMU fusion,
audio, power, button), and `gos_core/core.c`'s NVS-backed save/settings functions are ESP-IDF/
FreeRTOS-specific and have no portable half to extract - see `gos_runtime.c`'s own header
comment. `gos_audio_*`/`gos_save_*` are stubbed (silent / always-empty) rather than wired to
this pack's own `sound_synth.c`/`storage.c`, a stated show-phase gap, not a silent one - see
`README.md`'s Demands table.
