/*
 * runtime_core: the frame loop, browser edition.
 *
 * NOT vendored, and this is the file where that decision has to be
 * defended. The sibling's runtime_core.c
 * (packs/rp2350-touch-amoled-18/firmware/runtime/runtime_core.c, MIT) is
 * 685 lines, and roughly 400 of them are two gestures - the BOOT+PWR
 * menu chord, and the PWR-held-alone power-off with its brightness ramp,
 * its taint rule and its "the shutdown did not take" recovery ceiling.
 * Both are answers to hardware questions:
 *
 *   - the menu chord exists because that pack ships three apps in one
 *     image and needs a way to switch between them with two buttons. This
 *     pack ships ONE app per build (see wasm/build.ts): a browser's unit
 *     of "which app" is a URL, and the menu's job is already done by the
 *     address bar.
 *   - the power-off gesture ends in an AXP2101 register write that cuts
 *     the rails. A browser tab has no rails. Reimplementing the FADE
 *     without the cut would be a UI animation pretending to be a power
 *     state, which is exactly the kind of "the emulator is more generous
 *     than the hardware" dishonesty wasm/emu_abi.h warns against.
 *
 * What IS carried over, deliberately line-for-line, is everything an app
 * can actually observe: the arena and its zero-on-handout rule, the
 * deferred switch, the 250ms dt clamp, the first-tick dt of 0, the touch
 * drain and its pressed/released edges, the single read-and-clear
 * sensors_key_take() per frame, the BOOT click, and the shake sequence
 * diff gated on wantsShake. A port cannot tell the two runtimes apart
 * through app_frame_t, which is the whole claim this pack makes, and
 * apps/chrono/ports/web's pixel-exact portdiff against the rp2350 module
 * is what proves it rather than this comment.
 *
 * Depends on ONLY app.h, gfx.h, sensors.h and freestanding C headers,
 * the same rule the sibling states: if the core only ever reaches outside
 * itself through those seams, supplying them from a browser is enough to
 * run the real apps there.
 */
#ifndef RUNTIME_CORE_H
#define RUNTIME_CORE_H

#include <stdint.h>

/* ---- host-provided ------------------------------------------------------
 *
 * Two hooks, not the sibling's four. rt_time_us() is gone with the switch
 * profiler that was its only caller (one app per build, one switch ever,
 * at boot). rt_set_brightness() is gone with the power-off ramp, see this
 * file's header comment.
 */

// Diagnostic text, no trailing newline. Forwarded to env.js_log by
// wasm/emu_shim.c; the host prints it to the browser console.
void rt_log(const char *msg);

// Called only when app_alloc() detects an app's state does not fit
// APP_ARENA_BYTES: a build-time bug, never a condition a session can
// trigger. Must not return.
void rt_halt(void);

/* ---- lifecycle: what the host drives ------------------------------------
 *
 * rtcore_init() enters the one app. rtcore_tick() is one frame: resolve
 * input, hand the app its turn, apply a deferred switch if tick()
 * requested one. nowMs is the ONLY time source in here - see
 * wasm/emu_abi.h's emu_tick() comment for why a firmware reading its own
 * clock breaks reproducibility, which matters more here than anywhere:
 * the headless harness replays traces through this exact function.
 */
void rtcore_init(void);
void rtcore_tick(uint32_t nowMs);

#endif // RUNTIME_CORE_H
