// gameos_port.c -- the ONE file packs/rp2350-touch-amoled-18/wasm/build.ts
// --app takes (its single-app-slot contract: this file defines exactly
// `void port_enter(void)` and `void port_tick(const app_frame_t *f)`, see
// that script's own header comment). Everything this port needs - the
// gos.h engine, the launcher, and the two vendored games - arrives through
// the #include chain below: a unity build, forced by --app's one-file
// contract, not a style choice. See this directory's README.md for the
// per-pack verdict this file implements (go/degraded/refuse) and NOTICE.md
// for exactly what below is vendored verbatim versus this port's own code.
#include "app.h"
#include "gfx.h"
#include "gos_runtime.c"
#include "launcher.c"

// gunship.c and slots.c (../../reference/esp32-gameos/, vendored byte-for-
// byte - see that directory's README.md) call abs()/snprintf(). Neither is
// declared by this pack's freestanding wasm32 libc shim
// (packs/rp2350-touch-amoled-18/wasm/shim/{stdio,stdlib}.h declare only
// printf/malloc - see those files' own header comments for why stdio.h/
// stdlib.h/math.h are hosted-only headers zig's freestanding target does
// not fully ship). Redirected here, once, immediately before the only two
// files that need them, rather than in gos_runtime.c itself, so nothing
// else in this port silently inherits a libc-shape macro it never asked
// for. gosrt_abs()/gosrt_snprintf() (gos_runtime.c) are the real bodies.
#define abs(x) gosrt_abs(x)
#define snprintf(buf, cap, ...) gosrt_snprintf(buf, cap, __VA_ARGS__)
#include "../../reference/esp32-gameos/gunship.c"
#include "../../reference/esp32-gameos/slots.c"
#undef abs
#undef snprintf

// ===========================================================================
// Dispatcher: three screens (the launcher, and the two games), all inside
// ONE puck app slot. This pack's own arena (app_alloc()/APP_STATE, app.h)
// resets only on a real puck-level app switch, and this port never performs
// one - it IS a single puck app that does its own internal screen
// switching - so each game's state lives in a plain static (allocated once,
// for the process lifetime) and is zeroed BY HAND on every (re)launch to
// reproduce esp32-gameos's own "launching a game is a calloc of its
// declared state" contract (docs/game-contract.md) without a real per-
// launch allocator underneath.
// ===========================================================================
typedef enum { SCREEN_LAUNCHER, SCREEN_GUNSHIP, SCREEN_SLOTS } screen_t;

static screen_t s_screen;
static gs_t s_gunshipState;       // gs_t: gunship.c's own state struct, same TU
static slots_t s_slotsState;      // slots_t: slots.c's own state struct, same TU
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
    gosrt_reset_shell_palette(); // esp32-gameos's own shell "restores the
                                  // default palette automatically when a
                                  // game exits" (gos.h's own doc on
                                  // GOS_BLACK..GOS_AMBER) - gunship's
                                  // init() overwrites indices 0..15 with
                                  // its own thermal ramp and turns
                                  // scanlines on, neither of which its
                                  // teardown() undoes (that is the shell's
                                  // job in the donor, this dispatcher's
                                  // job here).
    gosrt_reset_aim_filters();
    launcher_reset();
}

static void enter_game(screen_t which, uint32_t nowMs) {
    s_screen = which;
    gosrt_reset_aim_filters();
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
    // own clock (nowMs, app.h) and which screen, never a real entropy
    // source - this ABI offers none, and none should be invented (a replay
    // of the same trace must reproduce the same run, see docs/harness.md).
    s_gameCtx.rng.s = 0x9E3779B9u ^ (nowMs * 2654435761u) ^ (uint32_t)(which + 1u);
    s_gameCtx.game->init(&s_gameCtx);
}

void port_enter(void) {
    gosrt_boot();
    s_screen = SCREEN_LAUNCHER;
    launcher_reset();
    launcher_render();
}

void port_tick(const app_frame_t *f) {
    float dt = f->dtMs > 0 ? (float)f->dtMs / 1000.f : (1.f / 60.f);

    if (s_screen == SCREEN_LAUNCHER) {
        const gos_input_t *in = gosrt_build_input(f, dt, 0);
        int pick = launcher_update(in);
        if (pick == 0 || pick == 1) {
            enter_game(pick == 0 ? SCREEN_GUNSHIP : SCREEN_SLOTS, f->nowMs);
            const gos_game_t *g = active_game();
            // Rebuild with the just-launched game's real caps (GOS_CAP_TOUCH_FIRE
            // only applies once a game that asked for it is active) and run
            // one update+render immediately: init() itself draws nothing (see
            // NOTICE.md), so without this the FIRST tick after a launch would
            // present a stale launcher frame instead of the game's own.
            const gos_input_t *in2 = gosrt_build_input(f, dt, g->caps);
            g->update(&s_gameCtx, dt, in2);
            g->render(&s_gameCtx);
        } else {
            launcher_render();
        }
    } else {
        const gos_game_t *g = active_game();
        if (gosrt_swipe_exit(f)) {
            enter_launcher();
            launcher_render();
        } else {
            const gos_input_t *in = gosrt_build_input(f, dt, g->caps);
            g->update(&s_gameCtx, dt, in);
            g->render(&s_gameCtx);
        }
    }

    gosrt_present();
}
