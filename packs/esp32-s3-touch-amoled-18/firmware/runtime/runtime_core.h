/*
 * runtime_core: the portable half of this pack's firmware, compiles for
 * both the ESP32-S3 board (main/) and wasm32-freestanding (wasm/emu_shim.c),
 * the same split the RP2350 sibling pack documents in its own
 * runtime_core.h and decisions/0003-emulator-runs-the-real-apps.md. Holds
 * the arena, the single reference app, and the per-frame band loop.
 *
 * Depends on ONLY app.h, gfx_band.h and freestanding C headers - never
 * esp-idf, never anything under esp_lcd, driver or freertos. A platform
 * supplies exactly four hooks (rt_log, rt_halt, plat_acquire_band,
 * plat_flush_band) and this file does not know or care whether they end in
 * a real QSPI DMA transfer or a JS host recording a push window.
 *
 * INPUT. Unlike the RP2350 sibling, this file does not read sensors.h
 * directly - there is no i2c1 ownership rule to encode here, since this
 * board's single main loop (main/main.c) polls touch, IMU and the button
 * itself and hands results in through the rtcore_set_* / rtcore_sensor_event
 * functions below. Those names and shapes deliberately mirror
 * wasm/emu_abi.h's emu_touch/emu_button/emu_button_verdict/emu_sensor_event
 * exactly: the board's own polling loop and the wasm shim both end up
 * calling the identical four functions, so this file has exactly one input
 * path to reason about instead of two that could drift apart.
 */
#ifndef RUNTIME_CORE_H
#define RUNTIME_CORE_H

#include <stdint.h>

/* ---- panel geometry, shared by runtime_core.c and gfx_band.c ----------- */
#define PANEL_W 368
#define PANEL_H 448
#define BAND_ROWS 28
#define BAND_COUNT (PANEL_H / BAND_ROWS) // 16

/* ---- PWR key bits, mirroring the RP2350 sibling's sensors.h -----------
 *
 * Same values, on purpose: an app or a tool that already knows the sibling
 * pack's KEY_* bits does not have to learn a second set for this one. This
 * board's PWR sits behind a TCA9554 IO expander rather than a PMIC (see this
 * pack's gotchas.md), so the bits mean "the runtime's own hold-timing
 * decided this", not "a chip's hardware register said this" - but the shape
 * an app sees is identical either way.
 */
#define KEY_PRESS   0x02
#define KEY_LONG    0x04
#define KEY_SHORT   0x08
#define KEY_RELEASE 0x01

/* ---- host-provided ------------------------------------------------------
 *
 * See this file's header comment for why each exists: neither is an
 * esp-idf or pico-sdk call, so both are implemented per-platform (main/'s
 * board build, wasm/emu_shim.c's browser build), never imported through
 * emu_abi.h's own host-import list.
 */

// Diagnostic text, no trailing newline. The board's implementation wraps
// ESP_LOGI; wasm forwards to env.js_log.
void rt_log(const char *msg);

// Called only when app_alloc() detects the one app's state does not fit
// APP_ARENA_BYTES: a build-time bug, never a runtime condition (see app.h).
// Must not return.
void rt_halt(void);

/* ---- platform band hooks -------------------------------------------------
 *
 * The two calls that make this pack's memory model real. On the board
 * (main/display.c) these wrap the real double-buffered DMA pipeline this
 * pack's AGENTS.md and gotchas.md describe: a counting semaphore
 * initialised to 2, released by the panel's transfer-done interrupt, so
 * acquiring blocks only when both buffers are still in flight. In wasm
 * (wasm/emu_shim.c) there is no DMA and no second buffer to rotate; see that
 * file's own comment for what stands in for both.
 */

// Blocks until a band buffer is free, then returns it: PANEL_W * BAND_ROWS
// RGB565 pixels, in the panel's own byte order (see gfx_band.h), with
// UNDEFINED prior content. `band` is informational only on the board (the
// real rotation is by acquisition order, not band index - see
// display.c's header comment for why); the wasm side does not need it
// either, but both take it so a future platform that DOES want to key off
// the band index (a fixed-size buffer array, say) does not need the
// signature to change.
uint16_t *plat_acquire_band(int band);

// Hands a filled band buffer to the platform. Does not block: on the board
// this queues an asynchronous QSPI transfer and returns immediately, so
// the CPU can start drawing the next band while this one is still going
// out over the wire - see gotchas.md's "the band DMA pipeline" entry.
void plat_flush_band(int band, const uint16_t *buf);

/* ---- input: mirrors emu_abi.h's emu_touch/emu_button/emu_button_verdict/
 * emu_sensor_event exactly - see this file's header comment on INPUT for
 * why. Coordinates are panel (portrait) space, unrotated. Buttons are
 * identified the same way device.json orders them: 0 = boot, 1 = pwr. */
#define RT_BTN_BOOT 0
#define RT_BTN_PWR  1
#define RT_SENSOR_SHAKE 0

void rtcore_set_touch(int down, int x, int y);
void rtcore_set_button(int index, int down);
void rtcore_set_button_verdict(int index, int isLong);
void rtcore_sensor_event(int index);

/* ---- lifecycle: what the platform drives ----------------------------------
 *
 * rtcore_init() allocates and enters the one reference app. rtcore_tick() is
 * one frame: resolve input into an app_frame_t, call tick(), then call
 * draw_band() for every band 0..BAND_COUNT-1 and hand each to
 * plat_flush_band(). nowMs is the ONLY time source in here, same rule
 * emu_abi.h's emu_tick() documents: a firmware that reads its own clock
 * breaks reproducibility in the emulator, and this file is compiled into
 * both targets unmodified.
 */
void rtcore_init(void);
void rtcore_tick(uint32_t nowMs);

#endif // RUNTIME_CORE_H
