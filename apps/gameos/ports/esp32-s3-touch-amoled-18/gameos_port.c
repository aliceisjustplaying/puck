// gameos_port.c -- the ONE file
// packs/esp32-s3-touch-amoled-18/wasm/build.ts --app takes (this pack's
// single-app-slot contract: this file must define a symbol named
// `g_demoApp` of type `app_t`, see runtime_core.c's own `extern const
// app_t g_demoApp;` and that build script's own header comment on --app).
//
// This port compiles the donor's REAL, unmodified engine
// (../../reference/esp32-gameos/{core,gfx,input,font}.c), the same real,
// unmodified games (gunship.c, slots.c, golf.c/golf_render.c/golf_cards.c,
// apps.c's aimtest/diag), AND (as of this task) the donor's REAL, unmodified
// shell (registry.c/apps.c/shell.c) against a thin compat/shim layer (this
// directory's math.h/stdio.h/stdlib.h/string.h/esp_*.h/nvs*.h plus
// gos_hal_shim.c and font565_shim.c, the two files here that are genuinely
// new code) - see NOTICE.md for exactly what is vendored byte-for-byte
// versus new, and packs/esp32-s3-touch-amoled-18/docs/decisions/0003-... for
// why the real engine's own rendering pipeline needed no change to this
// pack's band contract at all to make that possible.
//
// THE SHELL REPLACES THIS PORT'S OWN FORMER launcher.c ENTIRELY (deleted -
// see NOTICE.md and this bundle's git history). Sylve flashed the donor
// firmware on his own real board: the shell shown there is the donor's own
// Wii-menu-style channel grid (shell.c), not a bespoke picker this port
// invented - so faithfulness here means running that real shell, not a
// from-scratch stand-in for it. registry.c's own game table
// (gunship/golf/slots/aimtest/diag, in that order) is what actually decides
// the grid's contents and layout; this file does not duplicate that
// decision anywhere.
//
// A unity build, forced by --app's single-file contract, exactly like
// before: everything below arrives through #include, in one translation
// unit.
#include "app.h"
#include "gfx_band.h"
#include "runtime_core.h"

// This port's own platform seam (gos_hal.h's implementation) - included
// FIRST so its snprintf/vsnprintf/memset/memcpy/strlen bodies exist before
// anything below needs to link against them.
#include "gos_hal_shim.c"

// The real, unmodified engine. snprintf()/vsnprintf() are redirected to
// this port's own formatter at this include site (gos_hal_shim.c's own
// header comment explains why: this pack's freestanding wasm32 libc has
// neither) - the same trick, one bracket wider, this app's rp2350 port
// already uses around slots.c's abs()/snprintf().
#define snprintf(buf, cap, ...) gosport_snprintf(buf, cap, __VA_ARGS__)
#define vsnprintf(buf, cap, fmt, ap) gosport_vsnprintf(buf, cap, fmt, ap)
#include "../../reference/esp32-gameos/core.c"
#include "../../reference/esp32-gameos/gfx.c"
#include "../../reference/esp32-gameos/input.c"
#include "../../reference/esp32-gameos/font.c"
#undef snprintf
#undef vsnprintf

// The real, unmodified games. abs() joins the redirect bracket here,
// exactly matching the rp2350 port's own precedent (both games call it,
// neither calls anything this bracket does not cover - checked by grep).
#define abs(x) gosport_abs(x)
#define snprintf(buf, cap, ...) gosport_snprintf(buf, cap, __VA_ARGS__)
#include "../../reference/esp32-gameos/gunship.c"
#include "../../reference/esp32-gameos/slots.c"
#undef abs
#undef snprintf

// GOLF: the real, unmodified engine's third game - golf.c/golf_render.c/
// golf_cards.c/golf_int.h, byte-for-byte from the same MIT donor repo as
// every file above (NOTICE.md; NOT from MikeWilson/infinite-golf, GOLF's
// own unlicensed standalone upstream - see that file's licensing note).
// Only snprintf needs redirecting here (checked by grep: none of the three
// files call abs()). font565_shim.c below - this port's own, DECLARED
// substitution for the donor's LVGL-coupled font565.c, deliberately NOT
// vendored - supplies gos_gfx_text565/_w/_h, which golf_render.c/
// golf_cards.c call directly (not through this snprintf bracket).
//
// Three identifiers golf.c defines collide with ones slots.c/gunship.c
// already defined earlier in this same unity-built translation unit -
// real in a forced single-TU build, invisible in the donor's own CMake
// build where each game is its own compilation unit. Renamed ONLY for
// this include (macro, not a source edit - golf.c itself stays
// byte-for-byte vendored): `sfx_tap`/`sfx_tick` (slots.c's own SFX(sfx_tap,
// ...)/SFX(sfx_tick, ...) sound tables, same names golf.c happens to pick
// for its own tap/tick sfx) and `update_camera` (gunship.c's own static
// void update_camera(gs_t*, float), a different signature entirely from
// golf.c's own static void update_camera(void) - a real conflicting-types
// error, not just a duplicate symbol). See NOTICE.md for the full argument,
// including the sfx_tap_n/sfx_tick_n token-pasting note.
#define sfx_tap golf_sfx_tap
#define sfx_tap_n golf_sfx_tap_n
#define sfx_tick golf_sfx_tick
#define sfx_tick_n golf_sfx_tick_n
#define update_camera golf_update_camera
#define snprintf(buf, cap, ...) gosport_snprintf(buf, cap, __VA_ARGS__)
#include "../../reference/esp32-gameos/golf.c"
#undef update_camera
#undef sfx_tick_n
#undef sfx_tick
#undef sfx_tap_n
#undef sfx_tap
#include "../../reference/esp32-gameos/golf_render.c"
#include "../../reference/esp32-gameos/golf_cards.c"
#undef snprintf
#include "font565_shim.c"

// apps.c: the donor's own two harness apps, AIM TEST and DIAG - real,
// unmodified, vendored with this task's shell work (previously not
// vendored at all - see NOTICE.md's git history). Neither calls abs() or
// snprintf() (checked by grep), so no redirect bracket is needed here.
#include "../../reference/esp32-gameos/apps.c"

// registry.c: the donor's own game table, real, unmodified. Decides the
// grid's contents and order (gunship, golf, slots, aimtest, diag) - this
// port does not restate that list anywhere else.
#include "../../reference/esp32-gameos/registry.c"

// shell.c: the donor's own real shell - launcher grid, settings, pause
// overlay, calibration wizard, debug overlay, and the per-frame
// orchestration of the running game. Real, unmodified. Only snprintf needs
// redirecting here for the same libc-shape reason as every other file in
// this unity build - but ONE more rename is needed, found by actually
// attempting this build (not guessed): shell.c's own file-scope `static
// bool tap` (its own release-tap flag, set by detect_tap()) collides with
// slots.c's own file-scope `static void tap(gos_ctx_t*, int, int)` (LUCKY
// 7's own lever-tap helper) - two independent, correctly-scoped `static`
// declarations in the donor's own per-file CMake build, made a real
// same-translation-unit symbol collision by this port's forced unity build,
// the exact same class of problem golf.c's own sfx_tap/sfx_tick/
// update_camera rename (above) already exists to solve - `tap` renamed to
// `shell_tap` for the duration of this one include only (macro, not a
// source edit - shell.c itself stays byte-for-byte vendored).
#define tap shell_tap
#define snprintf(buf, cap, ...) gosport_snprintf(buf, cap, __VA_ARGS__)
#include "../../reference/esp32-gameos/shell.c"
#undef snprintf
#undef tap

// ===========================================================================
// app_t: this port's own dispatcher is now three calls deep, because the
// real shell (just vendored above) already does everything this file's
// former launcher.c/screen-switch dispatcher used to do by hand: own the
// active game, allocate and free its state, decide when a tap launches or
// exits it, and reset the palette/clip/direct565 state on return. Compare
// this app_t to gameos_port.c's own git history before this task: what
// used to be a ~120-line dispatcher (SCREEN_LAUNCHER/GUNSHIP/SLOTS/GOLF,
// hand-managed static state per game, a bespoke swipe_exit()) is now three
// thin forwarding calls into shell_init()/shell_frame(), because the real
// shell already owns all of that - see NOTICE.md.
// ===========================================================================

static void esp32gameos_enter(void) {
    // Mirrors main.c's own app_main() init order exactly (gos_gfx_init,
    // gos_input_init, gos_mixer_init, shell_init) - main.c itself is not
    // vendored (ESP-IDF/FreeRTOS task setup, bsp_i2c_init, per-HAL
    // hal_*_init() calls with no equivalent on this ABI - see NOTICE.md),
    // but this four-call sequence is not FreeRTOS-specific at all, so it is
    // reproduced here by hand rather than skipped.
    gos_gfx_init();   // real engine: sin table, default palette, clears fb[2]
    gos_input_init(); // real engine: zeroes the input snapshot
    gos_mixer_init(); // stubbed (gos_hal_shim.c) - no sound HAL on this ABI
    shell_init();     // real shell: loads settings (fails open, see
                       // nvs.h), arms the first-run calibration wizard
                       // (g_settings.calibrated starts 0 - see shell.c)
}

static void esp32gameos_tick(const app_frame_t *f) {
    gosport_set_frame(f); // feeds gos_hal_shim.c's hal_touch_read/hal_button_down/hal_imu_get/hal_power_get
    float dt = f->dtMs > 0 ? (float)f->dtMs / 1000.f : (1.f / 60.f);
    gos_input_update(dt); // real engine: builds this tick's gos_input_t from the HAL
    // n_updates=1: this port ticks once per emulator frame at the ABI's own
    // nominal rate, the same "one logic step per tick" assumption this
    // port's prior dispatcher already made (gos_loop_start(), not vendored,
    // would otherwise decide n_updates from real elapsed wall time - see
    // NOTICE.md - which this ABI's determinism rule forbids reading anyway,
    // docs/harness.md). shell_frame() itself calls gos_gfx_present() as its
    // very last line - no separate present() call is needed here.
    shell_frame(gos_input_get(), 1);
}

static void esp32gameos_draw_band(int band, uint16_t *buf, int y0, int rows) {
    gosport_draw_band(band, buf, y0, rows);
}

const app_t g_demoApp = {
    .name = "gameos",
    .enter = esp32gameos_enter,
    .tick = esp32gameos_tick,
    .draw_band = esp32gameos_draw_band,
    .leave = NULL,
};
