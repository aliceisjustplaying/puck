// gameos_port.c -- the ONE file
// packs/esp32-s3-touch-amoled-18/wasm/build.ts --app takes (this pack's
// single-app-slot contract: this file must define a symbol named
// `g_demoApp` of type `app_t`, see runtime_core.c's own `extern const
// app_t g_demoApp;` and that build script's own header comment on --app).
//
// Unlike this app's rp2350 port (a from-scratch reimplementation of gos.h
// against that pack's ABI, see ports/rp2350-touch-amoled-18/gos_runtime.c),
// THIS port compiles the donor's REAL, unmodified engine
// (../../reference/esp32-gameos/{core,gfx,input,font}.c) and the same
// real, unmodified games (gunship.c, slots.c) against a thin compat/shim
// layer (this directory's math.h/stdio.h/stdlib.h/string.h/esp_*.h/nvs*.h
// plus gos_hal_shim.c, the one file here that is genuinely new code) - see
// NOTICE.md for exactly what is vendored byte-for-byte versus new, and
// packs/esp32-s3-touch-amoled-18/docs/decisions/0003-... for why the real
// engine's own rendering pipeline (an indexed 184x224 buffer, upscaled
// through a palette LUT) needed no change to this pack's band contract at
// all to make that possible.
//
// A unity build, forced by --app's single-file contract, exactly like the
// rp2350 port's own gameos_port.c: everything below arrives through
// #include, in one translation unit.
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

// This port's own launcher (not vendored - see launcher.c's own header
// comment; byte-for-byte the same file as the rp2350 port's own).
#include "launcher.c"

// ===========================================================================
// Dispatcher: three screens (the launcher, and the two games), all inside
// ONE puck app slot - the same shape this app's rp2350 port's own
// gameos_port.c already uses, and for the identical reason: this pack's
// arena (app_alloc()/APP_STATE, app.h) resets only on a real puck-level app
// switch, and this port never performs one. Each game's state is a plain
// static, zeroed by hand on every (re)launch to reproduce esp32-gameos's
// own "launching a game is a calloc of its declared state" contract
// (docs/game-contract.md) without a real per-launch allocator underneath.
// ===========================================================================
typedef enum { SCREEN_LAUNCHER, SCREEN_GUNSHIP, SCREEN_SLOTS } screen_t;

static screen_t s_screen;
static gs_t s_gunshipState;    // gs_t: gunship.c's own state struct, same TU
static slots_t s_slotsState;   // slots_t: slots.c's own state struct, same TU
static gos_ctx_t s_gameCtx;

static const gos_game_t *active_game(void) {
    return s_screen == SCREEN_GUNSHIP ? &game_gunship
         : s_screen == SCREEN_SLOTS   ? &game_slots
         : (const gos_game_t *)0;
}

static void enter_launcher(void) {
    const gos_game_t *g = active_game();
    if (g && g->teardown) g->teardown(&s_gameCtx);
    s_screen = SCREEN_LAUNCHER;
    // esp32-gameos's own shell "restores the default palette automatically
    // when a game exits" (gos.h's own doc on GOS_BLACK..GOS_AMBER) -
    // gunship's init() overwrites indices 0..15 with its own thermal ramp
    // and turns scanlines on, neither of which its teardown() undoes (that
    // is the shell's job in the donor, this dispatcher's job here, exactly
    // like the rp2350 port's own enter_launcher()).
    gos_gfx_set_default_palette();
    gos_gfx_scanlines(false);
    gos_gfx_clear_clip();
    gos_input_set_aim_mode(GOS_AIM_TILT_ABS); // re-arms the euro filter (see input.c)
    launcher_reset();
}

static void enter_game(screen_t which, uint32_t nowMs) {
    s_screen = which;
    gos_input_set_aim_mode(GOS_AIM_TILT_ABS); // re-arms the euro filter (see input.c)
    if (which == SCREEN_GUNSHIP) {
        memset(&s_gunshipState, 0, sizeof s_gunshipState);
        s_gameCtx.state = &s_gunshipState;
        s_gameCtx.game = &game_gunship;
    } else {
        memset(&s_slotsState, 0, sizeof s_slotsState);
        s_gameCtx.state = &s_slotsState;
        s_gameCtx.game = &game_slots;
    }
    // Deterministic per-launch seed variety: a pure function of the trace's
    // own clock (nowMs) and which screen, never a real entropy source -
    // this ABI offers none, and none should be invented (a replay of the
    // same trace must reproduce the same run - docs/harness.md). Same
    // formula the rp2350 port already uses.
    s_gameCtx.rng.s = 0x9E3779B9u ^ (nowMs * 2654435761u) ^ (uint32_t)(which + 1u);
    s_gameCtx.game->init(&s_gameCtx);
}

// The "swipe down from the top edge" escape (docs/input-and-ux.md: press
// y<14, drag >40, RENDER space - i.e. this engine's 184x224 game space,
// which is exactly what gos_input_t.touch already is). The donor's own
// OS-level pause gesture, repurposed as this show-phase port's only way
// back to the launcher - same gesture, same thresholds, same destination
// choice the rp2350 port already makes.
static bool s_swipeArmed;
static int s_swipeStartY;
static bool s_swipeWasDown;

static bool swipe_exit(const gos_input_t *in) {
    int ry = in->touch.y;
    bool exitNow = false;
    if (in->touching) {
        if (!s_swipeWasDown) {
            s_swipeArmed = ry < 14;
            s_swipeStartY = ry;
        } else if (s_swipeArmed && ry - s_swipeStartY > 40) {
            exitNow = true;
            s_swipeArmed = false;
        }
    } else {
        s_swipeArmed = false;
    }
    s_swipeWasDown = in->touching;
    return exitNow;
}

// ---------------------------------------------------------------------------
// app_t
// ---------------------------------------------------------------------------

static void esp32gameos_enter(void) {
    gos_gfx_init();   // real engine: sin table, default palette, clears fb[2]
    gos_input_init(); // real engine: zeroes the input snapshot
    // GOS_AIM_TILT_ABS: the donor's own default aim mode (descriptor.md's
    // Interactions), unchanged - this pack publishes no fused gravity
    // vector (unlike the RP2350 sibling), only a raw accelerometer sample
    // stream, so gos_hal_shim.c's hal_imu_get() does the fusion into
    // pitch/roll itself, the same job a real board's IMU task would have
    // already done - see packs/esp32-s3-touch-amoled-18/docs/decisions/
    // 0003-... for the full argument. GOS_AIM_GYRO_RATE has no signal on
    // this ABI at all (no gyroscope); GOS_AIM_TOUCH_DRAG is the donor's own
    // named fallback for a device with neither, not needed here.
    gos_input_set_aim_mode(GOS_AIM_TILT_ABS);
    s_screen = SCREEN_LAUNCHER;
    launcher_reset();
    launcher_render();
}

static void esp32gameos_tick(const app_frame_t *f) {
    gosport_set_frame(f); // feeds gos_hal_shim.c's hal_touch_read/hal_button_down/hal_imu_get
    float dt = f->dtMs > 0 ? (float)f->dtMs / 1000.f : (1.f / 60.f);
    gos_input_update(dt); // real engine: builds this tick's gos_input_t from the HAL
    const gos_input_t *in = gos_input_get();

    // Caps masking (docs/input-and-ux.md: "the shell masks caps before
    // handing the snapshot over" so a screen without GOS_CAP_TOUCH_FIRE
    // never sees a stray FIRE bit): not needed on this port's own screen
    // roster - neither this launcher nor LUCKY 7 (slots.c) ever reads
    // GOS_BTN_FIRE at all, so an unmasked bit changes nothing either way.
    // GUNSHIP is the only screen that reads it, and it always declares the
    // cap. A future third screen without the cap would need this added.

    if (s_screen == SCREEN_LAUNCHER) {
        int pick = launcher_update(in);
        if (pick == 0 || pick == 1) {
            enter_game(pick == 0 ? SCREEN_GUNSHIP : SCREEN_SLOTS, f->nowMs);
            // init() itself draws nothing (NOTICE.md); run one update+render
            // immediately so the first tick after a launch shows the game's
            // own first frame instead of a stale launcher one.
            const gos_game_t *g = active_game();
            g->update(&s_gameCtx, dt, in);
            g->render(&s_gameCtx);
        } else {
            launcher_render();
        }
    } else {
        const gos_game_t *g = active_game();
        if (swipe_exit(in)) {
            enter_launcher();
            launcher_render();
        } else {
            g->update(&s_gameCtx, dt, in);
            g->render(&s_gameCtx);
        }
    }

    gos_gfx_present(); // real engine: hands this tick's finished indexed
                        // buffer + palette to gos_hal_shim.c's
                        // hal_display_present(), which just stashes the
                        // pointers - see that file's header comment.
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
