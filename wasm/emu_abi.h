/*
 * emu_abi: the contract between a firmware compiled to WebAssembly and the
 * emulator that runs it in a browser.
 *
 * THE ONE IDEA. The emulator runs the REAL firmware. Application code
 * compiles to wasm unmodified, and the browser supplies what the board would
 * have supplied: a surface to push pixels at, input devices, and a clock. Not
 * "the same algorithm" as the device. The same object code.
 *
 * The alternative, a careful reimplementation in TypeScript, was tried here
 * first and is what this replaces. It was correct on the day it was written
 * and stale by the next commit, which is the predictable behaviour of two
 * implementations of one thing: they agree exactly once, and drift from then
 * on with no test that can notice. The moment that became concrete was a real
 * bug on real hardware that the emulator was asked to reproduce, and could
 * not, because it was a bug in C and the emulator was not running any C. See
 * docs/decisions/0003-emulator-runs-the-real-apps.md.
 *
 * NOTHING BELOW NAMES THIS PARTICULAR DEVICE. A firmware declares its own
 * shape through emu_device(), and the emulator builds its chrome from that
 * declaration: panel size, buttons, sensors, and whatever else. That is not
 * generality for its own sake. An emulator that hardcodes a 368x448 panel and
 * two buttons called PWR and BOOT is a tool exactly one project can use, and
 * the cost of not doing this now is that it can never be done later.
 *
 * WHAT IS REAL, AND WHAT IS NOT
 *
 * Real, because it is the same object code: all application logic, layout and
 * redraw decisions; the framebuffer and its pixel format; whatever partial
 * refresh rules the firmware's own push path enforces.
 *
 * NOT real, and never to be trusted here:
 *   - Timing. The browser's clock drives emu_tick(). Nothing reproduces bus
 *     latency, panel push cost, or a second core. Any question about
 *     responsiveness is a question for the hardware. Always.
 *   - Input device defects. Real touch controllers drop contact mid stroke
 *     and emit strays, and firmware carries a lot of code that exists only
 *     because of that. A clean mouse drag exercises none of it. The emulator
 *     can synthesise those defects, and should, but off by default and
 *     clearly labelled when on.
 *   - The display as a physical object: no burn-in, no brightness, no
 *     tearing.
 *
 * THE RULE THIS FILE EXISTS TO ENFORCE, A.K.A. KEEPING THE EMULATOR HONEST
 *
 * The emulator must never deliver an input the hardware cannot produce.
 * Where the two disagree, the emulator changes to match the hardware, never
 * the reverse. THE ONE IDEA above ("the emulator runs the real firmware")
 * is worthless as a guarantee if the browser then hands that firmware
 * inputs no board could ever generate: an emulator that is MORE GENEROUS
 * than the device it stands in for is worse than no emulator at all,
 * because it lets an app get built and tested against something that will
 * never happen on the device, and the gap does not surface until someone
 * is holding real hardware.
 *
 * Worked example, now historical but kept because it shows the rule biting
 * in both directions. sensors.h declares KEY_PRESS, KEY_LONG and KEY_SHORT
 * for the PWR key, all genuinely delivered by the AXP2101. For a while it did
 * NOT declare KEY_RELEASE: pmic_poll_core1() (firmware/runtime/sensors.c)
 * masked that bit out of every PMIC read before an app could ever see it, on
 * purpose, because nothing read it. An earlier version of emu_shim.c got this
 * backwards: it OR'd a synthetic release bit into the emulator's key event on
 * every button-up, so an app built and tested only in the browser could come
 * to depend on a signal that silently did nothing on the device. The fix then
 * was not to make the board deliver it, it was to stop the emulator inventing
 * what the board did not have.
 *
 * The requirement later changed for an unrelated reason (the PWR-held-alone
 * power-off gesture needs to know when a hold ENDS, which only the release
 * edge can say), so the board's own mask widened to deliver KEY_RELEASE for
 * real, and emu_shim.c changed to match: this is the rule's other direction,
 * an emulator that is LESS capable than the hardware it stands in for is just
 * as dishonest as one that is more generous. See sensors.h's PWR key section
 * ("KEY_RELEASE WAS DELETED FROM THIS FILE EARLIER, AND IS BACK") for the
 * full story, and emu_shim.c's PWR key section for the emulator's side of it.
 */
#ifndef EMU_ABI_H
#define EMU_ABI_H

#include <stdint.h>

/*
 * Everything here is exported to JavaScript. Anything that is not a scalar is
 * returned as a byte offset into the module's linear memory, which is the
 * only thing a wasm export can hand back.
 */

/* ---- what this device is ------------------------------------------------
 *
 * Returns a NUL-terminated JSON string. The emulator reads it once at
 * startup and builds everything it shows from it. Unknown fields are ignored,
 * so a firmware may declare more than a given emulator version understands.
 *
 * {
 *   "name":  "RP2350-Touch-AMOLED-1.8",
 *   "panel": { "w": 368, "h": 448, "format": "rgb565be" },
 *   "buttons": [
 *     { "id": "boot", "label": "BOOT", "edge": "right", "at": 0.38 },
 *     { "id": "pwr",  "label": "PWR",  "edge": "right", "at": 0.62,
 *       "longPressMs": 1500 }
 *   ],
 *   "touch":   { "points": 1 },
 *   "sensors": [
 *     { "id": "shake", "kind": "event" },
 *     { "id": "tilt", "kind": "vector" }
 *   ],
 *   "apps":    [ "chrono", "draw", "timer" ],
 *   "gestures": [
 *     { "id": "menu", "label": "menu",
 *       "how": "Hold BOOT, then also hold PWR. Keep both held until PWR "
 *              "registers a long press (about 1.5s): that opens the app "
 *              "menu. Do the same chord again to close it and return to "
 *              "what was running." }
 *   ]
 * }
 *
 * Notes on the fields that are easy to get wrong:
 *
 *   panel.format  "rgb565be" means the framebuffer holds RGB565 with the
 *                 bytes in the order the panel's DMA wants, which on a
 *                 little-endian CPU is the opposite of how a uint16_t is
 *                 stored. The emulator unswaps when blitting rather than the
 *                 firmware handing over a tidied copy, so that what the page
 *                 displays really is the device's memory.
 *
 *   buttons[].at  where the button sits along that edge, 0 at the top. The
 *                 emulator draws it there. This exists because button
 *                 position is a real source of confusion when a device is
 *                 held rotated, and a diagram beats a paragraph.
 *
 *   buttons[].longPressMs
 *                 if the hardware itself decides what a long press is (a PMIC
 *                 that reports "long press" rather than a raw level, say),
 *                 declare its threshold so the emulator reproduces the same
 *                 verdict instead of inventing its own.
 *
 *   sensors[].kind
 *                 "event" is a one-shot "it happened" signal, delivered via
 *                 emu_sensor_event() below. "vector" is a continuous 3-float
 *                 signal, delivered via the OPTIONAL emu_sensor_vector()
 *                 below (a firmware that does not implement it simply does
 *                 not export it, and the host never calls it - same
 *                 "unimplemented means uncalled" contract emu_app_switch()
 *                 and the sound exports already use). A vector sensor's
 *                 "id" says what physical quantity it carries (e.g. "tilt"
 *                 for a gravity direction); the host must not special-case
 *                 a particular id, only the "kind", so a future second
 *                 vector sensor (a compass heading, say) works with no host
 *                 change.
 *
 *   apps          optional. Purely so the emulator can offer a jump-to-app
 *                 control. A firmware with no such concept omits it, and the
 *                 emulator shows no strip.
 *
 *   gestures      optional. A compound gesture recognised across more than
 *                 one input (a chord, a hold-then-something) belongs to no
 *                 single button or sensor, so there is nowhere else in this
 *                 JSON to hang a description of it on. "how" is prose
 *                 describing the physical gesture in device terms (which
 *                 buttons, held how); it is NOT expected to name a
 *                 particular emulator's keyboard shortcuts, since those are
 *                 assigned dynamically per session (see the emulator's
 *                 shortcuts.ts) and would go stale here. A firmware with no
 *                 gesture beyond its individual buttons/sensors omits this,
 *                 and the emulator says plainly that none is declared
 *                 rather than guessing at one.
 */
int emu_device(void);

/* ---- lifecycle ---------------------------------------------------------- */

// Brings the firmware up, through the same path the board takes. Returns 1 on
// success, 0 on failure (and should have logged why through the host's log
// import). Call once.
int emu_init(void);

// Advances one frame. nowMs is the host's clock and is the ONLY time source
// inside the module, so a test harness can drive it deterministically rather
// than in real time. A firmware that reads its own clock has broken this and
// will not be reproducible.
void emu_tick(uint32_t nowMs);

/* ---- the panel ---------------------------------------------------------- */

// The framebuffer, in the format declared by emu_device().
int emu_fb(void);

/* ---- what the last tick pushed ------------------------------------------
 *
 * The firmware's push path records every window it sent to the panel, AFTER
 * whatever rounding or alignment that path applies. The emulator blits only
 * these, so it exercises the real partial-refresh path, and draws them as an
 * overlay.
 *
 * That overlay is the single most useful thing here. A partial-refresh bug is
 * a bug about window geometry, and on the device project this emulator was
 * extracted from it cost days of bisection precisely because the windows
 * were invisible: that panel corrupted any window whose row length was not
 * a multiple of 8 pixels, a device-specific hazard whose own decision
 * record lives in that project's repo, not this one (see this file's own
 * header comment: nothing here names one device). Making the windows
 * visible turns that class of bug from a bisection into a glance.
 *
 * Cleared at the start of every emu_tick().
 */
int emu_push_count(void);
int emu_push_x(int i);
int emu_push_y(int i);
int emu_push_w(int i);
int emu_push_h(int i);

/* ---- input --------------------------------------------------------------
 *
 * Coordinates are always in the panel's own, unrotated space. If a device is
 * used rotated, mapping the pointer back is the emulator's job, because the
 * firmware's own coordinate handling is under test and must not be helped.
 */
void emu_touch(int down, int x, int y);

// Buttons are identified by their index in emu_device()'s buttons array. The
// emulator reports level changes; anything derived (click, long press) is the
// firmware's business, exactly as on hardware, unless the device declared a
// longPressMs, in which case the emulator also calls emu_button_verdict().
void emu_button(int index, int down);
void emu_button_verdict(int index, int isLong);

// Sensor events declared with "kind": "event", by index into the sensors
// array. A shake, a tap, a step: anything the firmware receives as "it
// happened" rather than as a continuous value.
void emu_sensor_event(int index);

// OPTIONAL. Only meaningful for a sensor declared "kind": "vector" (see
// emu_device()'s field notes above). The host calls this whenever the
// vector sensor's current reading changes; a firmware without a continuous
// signal to feed leaves this unimplemented (unexported) and the host will
// not call it, same as emu_app_switch()/the sound exports.
//
// AXIS CONVENTION, for a "tilt" vector sensor specifically (the one kind
// this repo's reference pack declares today): the gravity direction, in
// DEVICE coordinates, units of g (1.0 = 9.81 m/s^2). x points to the
// panel's right, y points down the panel, z points into the screen (from
// the glass toward the back of the case). Flat on a table, screen facing
// up, is approximately (0, 0, -1). A device held upright in portrait, not
// tilted, reads approximately (0, 1, 0) - gravity pulling straight down the
// panel. This is the SAME convention a firmware's own app_frame_t tilt
// field documents (see a device pack's sensors.h/app.h) - the host must
// reproduce exactly this, never a different handedness or axis order, per
// this file's own "keeping the emulator honest" rule: an emulator that
// hands an app a gravity vector in the wrong axes is exactly the kind of
// dishonesty that rule exists to catch, just for a continuous signal
// instead of a discrete one.
void emu_sensor_vector(int index, float x, float y, float z);

/* ---- optional: what the app was last handed -------------------------------
 *
 * The vector sensor's value AS THE CURRENT APP SAW IT on the last emu_tick():
 * filtered, axis-mapped, and rotated into whatever coordinate space that app
 * draws in. A TEST ORACLE, never an input.
 *
 * It exists because everything that can actually go wrong with a continuous
 * orientation signal happens BETWEEN the sensor and the app: a swapped axis,
 * an inverted sign, a rotation applied the wrong way, a filter that never
 * converges. A test that asserted on what it had just passed to
 * emu_sensor_vector() would be reading upstream of every one of those, and so
 * would validate nothing.
 *
 * `field` selects a scalar, so this needs no struct across the wasm boundary:
 * 0/1/2 are the vector's x/y/z, 3 the angle from flat in degrees, 4 which edge
 * is up as a small integer, 5 whether the reading is valid at all, 6 whether
 * the filter is coasting on its last belief. A firmware with no continuous
 * sensor leaves this unimplemented and the host never calls it.
 */
float emu_tilt(int field);

/* ---- optional: apps -----------------------------------------------------
 *
 * Only meaningful if emu_device() declared an "apps" array. A firmware
 * without a concept of apps leaves these unimplemented and the emulator will
 * not call them.
 */
int  emu_app_current(void);
void emu_app_switch(int index);

/* ---- optional: the menu's own roster ---------------------------------------
 *
 * Which of emu_device()'s "apps" the firmware's own on-device picker actually
 * shows, and in what order: emu_menu_app_index(slot) is an index INTO the
 * apps array, for slot in [0, emu_menu_app_count()).
 *
 * A separate oracle from "apps" on purpose. Taking an app off the picker is a
 * product decision and never a deletion, so a firmware can perfectly well
 * carry eleven apps and show five, and a test that read the roster off the
 * apps array would then be asserting something the device does not do. A
 * firmware whose picker shows everything reports the identity mapping, and a
 * firmware with no picker leaves these unimplemented.
 */
int emu_menu_app_count(void);
int emu_menu_app_index(int slot);

/* ---- optional: the app arena ----------------------------------------------
 *
 * How many bytes of its fixed per-app allocation arena the running app has
 * taken, and how large that arena is. Both in bytes; used together they are a
 * headroom check a gate can fail on BEFORE a flash, rather than a red screen
 * discovered on the device.
 *
 * Only meaningful for a firmware whose app contract has a bump-allocated arena
 * at all. One that allocates differently, or not at all, leaves these
 * unimplemented.
 */
int emu_arena_used(void);
int emu_arena_capacity(void);

/* ---- sound ----------------------------------------------------------------
 *
 * GENUINE, not simulated, in the one sense that matters most here: the
 * samples the host plays are computed by firmware/runtime/sound_synth.c,
 * compiled into this module unmodified - the exact same object code that
 * generates the samples the board's own DMA hands to the ES8311 (see
 * firmware/runtime/sound.c). Nothing in emu_shim.c re-derives the chime in
 * JavaScript; the module hands the host raw PCM it already computed, the
 * same way emu_fb() hands over a framebuffer the module already rendered.
 * That is the same "same object code, not a reimplementation" argument
 * decision 0003 makes for the graphics and app logic, extended to sound.
 *
 * NOT real, and this belongs next to the timing and input-device caveats
 * above, not hidden below them: the device's speaker is a small, cheap part
 * that will distort and lose bass in ways whatever speaker plays this
 * browser tab will not. The emulator will always flatter the sound. It is
 * for judging the TUNE - the notes, the shape, the pacing, whether the idea
 * is right - not the TIMBRE - whether it is harsh or pleasant coming out of
 * this specific tiny speaker. That second question can only be answered on
 * the real board.
 *
 * SHAPE. sound_play()/sound_stop() (firmware/runtime/sound.h) are called by
 * firmware logic (the timer's alarm), never by the host directly - sound is
 * an output, not an input device, so there is no emu_sound_play() the host
 * calls. Instead, two counters the host diffs against what it last saw, the
 * same pattern app_current() and emu_push_count() already use:
 *
 *   emu_sound_play_seq()   bumped once per sound_play() call (once per
 *                          alarm start, not once per sample or per tick).
 *                          On a change, the host should fetch the buffer
 *                          below and start playing it.
 *   emu_sound_stop_seq()   bumped once per sound_stop() call. On a change,
 *                          the host should stop whatever is currently
 *                          playing, immediately - this is what makes
 *                          dismissal (any button, touch or shake, per
 *                          timer.c) silence the browser's audio right away
 *                          rather than letting an already-started buffer
 *                          finish, matching sound.h's "immediate" claim for
 *                          the real hardware.
 *
 * The buffer itself is fixed-length mono PCM, valid only immediately after
 * emu_sound_play_seq() has just changed (the next sound_play() call
 * overwrites it - there is one buffer, not a queue):
 *
 *   emu_sound_sample_rate()  Hz, constant.
 *   emu_sound_buffer()       byte offset into linear memory.
 *   emu_sound_frames()       sample count at that offset. int16, signed,
 *                            native (little-endian) byte order.
 *
 * The module decides how many seconds to generate up front (a fixed preview
 * length, several repeats of the chime's own phrase - see emu_shim.c),
 * independent of the real device's 30-second self-limit (timer.c's own
 * ALARM_MAX_MS, which this module does not know about: that is the TIMER's
 * self-limit, not the sound service's - see sound.h). A finite buffer the
 * host just plays once, rather than a streaming pull protocol, is enough
 * here: unlike the board (SRAM-constrained, see sound.c's header comment on
 * why IT streams sample-by-sample into a small ring instead), a browser's
 * wasm linear memory has no comparable budget problem for a few seconds of
 * mono int16 audio.
 */
int      emu_sound_sample_rate(void);
uint32_t emu_sound_play_seq(void);
uint32_t emu_sound_stop_seq(void);
int      emu_sound_buffer(void);
int      emu_sound_frames(void);

/* ---- what the module imports from the host ------------------------------
 *
 * Freestanding wasm has no libc, so the host provides these. Kept to the
 * smallest set that real firmware actually needs, since every import is
 * something a new host has to implement:
 *
 *   env.js_log(ptr, len)   UTF-8 diagnostic text. This is the firmware's
 *                          printf, and the emulator shows it in a console
 *                          pane. A device with a serial port has one; this is
 *                          the same thing.
 *
 *   env.sinf, cosf, atan2f, sqrtf, fabsf, floorf, fmodf, powf, expf
 *                          math, mapped to the host's own. Deliberately not
 *                          reimplemented in the module: they would be a
 *                          second source of numerical difference between the
 *                          two targets, on top of the one that already exists
 *                          (the device's FPU is single precision, the host's
 *                          Math is double), and the host's are at least
 *                          correct. expf joined this list for the alarm
 *                          chime's decay envelope (sound_synth.c); it was not
 *                          needed before sound existed.
 */

#endif // EMU_ABI_H
