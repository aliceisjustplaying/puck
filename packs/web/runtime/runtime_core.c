// runtime_core: implementation. See runtime_core.h for what this file is,
// what it deliberately drops from the sibling pack's version, and why.
//
// Depends on ONLY app.h, gfx.h, sensors.h and freestanding C headers.
#include "runtime_core.h"

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#include "app.h"
#include "gfx.h"
#include "sensors.h"

/* ---- the app table -------------------------------------------------------
 *
 * ONE slot. The sibling declares three named apps plus a menu because its
 * firmware ships all of them in one image; this pack builds one app per
 * module (wasm/build.ts), so the table has exactly one entry and
 * app_switch_to() has nowhere else to go.
 *
 * g_webApp is defined either by apps/demo.c (the default build) or by the
 * roster wasm/build.ts generates for --app. Declared here as a bare
 * extern, the same extern-per-app pattern the sibling uses.
 */
extern const app_t g_webApp;

const app_t *const g_apps[] = { &g_webApp };
const int g_appCount = sizeof(g_apps) / sizeof(g_apps[0]);

/* ---- tiny text formatting, because this file has no stdio.h ------------- */
static char *fmt_append_str(char *out, const char *s) {
    while (*s) *out++ = *s++;
    return out;
}

static char *fmt_append_u32(char *out, uint32_t v) {
    char tmp[10];
    int n = 0;
    if (v == 0) tmp[n++] = '0';
    while (v > 0) {
        tmp[n++] = (char)('0' + (v % 10u));
        v /= 10u;
    }
    while (n > 0) *out++ = tmp[--n];
    return out;
}

/* ---- the arena -----------------------------------------------------------
 *
 * Carried over from the sibling unchanged, INCLUDING the 64KB budget
 * (app.h's APP_ARENA_BYTES) that a browser has no reason to enforce.
 * Keeping it is the point: an app that fits the arena here fits it on the
 * chip, so a port developed in a browser cannot silently grow past what
 * the RP2350's 520KB of SRAM allows and discover it only on silicon.
 * device.json says the same thing in one line: "a browser has no SRAM
 * budget; the rp2350 contract applies unchanged."
 */
static uint8_t g_arena[APP_ARENA_BYTES] __attribute__((aligned(8)));
static size_t g_arenaUsed = 0;

// Not a well-behaved allocator, deliberately, and for the sibling's exact
// reason: a NULL returned to APP_STATE()'s caller (which dereferences it
// immediately, unchecked, in every app written against app.h) turns a
// precise build-time bug into a null dereference somewhere else. So it
// traps loudly instead. The sibling paints the panel red first; that is
// kept here, because a person running this on a phone has no console open
// and a red screen is the only thing that reaches them.
static void arena_overflow_trap(size_t requested) {
    char msg[96];
    char *p = msg;
    p = fmt_append_str(p, "FATAL: app arena overflow: requested ");
    p = fmt_append_u32(p, (uint32_t)requested);
    p = fmt_append_str(p, " bytes, ");
    p = fmt_append_u32(p, (uint32_t)g_arenaUsed);
    p = fmt_append_str(p, " of ");
    p = fmt_append_u32(p, (uint32_t)APP_ARENA_BYTES);
    p = fmt_append_str(p, " already used");
    *p = '\0';
    rt_log(msg);

    uint16_t alarm = px_swap(0xF800); // pure red, byte-swapped for the panel format
    gfx_fill_rect(0, 0, PANEL_W, PANEL_H, alarm);
    gfx_push_all();

    rt_halt(); // must not return
    for (;;) { } // unreachable if rt_halt()'s contract holds; a safety net
}

void *app_alloc(size_t bytes) {
    size_t aligned = (g_arenaUsed + 7u) & ~(size_t)7u;
    if (bytes > APP_ARENA_BYTES || aligned > APP_ARENA_BYTES - bytes) {
        arena_overflow_trap(bytes);
    }
    void *p = &g_arena[aligned];
    g_arenaUsed = aligned + bytes;

    // Zero only the bytes just handed out, not the whole arena: app.h
    // promises app_alloc() returns zeroed memory and chrono.c leans on it
    // explicitly ("lastDigit[i] is already 0"). Rewinding the bump
    // pointer alone would hand the next app the previous one's bytes,
    // which is the bug the sibling documents at length here.
    uint8_t *bytesOut = (uint8_t *)p;
    for (size_t i = 0; i < bytes; i++) bytesOut[i] = 0;

    return p;
}

/* ---- the shared touch resolver's state, reset on every switch -----------
 *
 * File-scope, not function-local statics, for the sibling's reason: input
 * state that belongs to a run of an app must not outlive that run. With
 * one app per module there is exactly one switch (at boot) and this is
 * consequently unobservable today - kept anyway, because the alternative
 * is a port behaving differently on the two targets the day a second
 * switch exists, and that is precisely what this pack is for.
 */
static bool g_touchWasDown = false;
static int g_touchLastX = 0, g_touchLastY = 0;

static void touch_resolver_reset(void) {
    g_touchWasDown = false;
    g_touchLastX = 0;
    g_touchLastY = 0;
}

/* ---- switching ---------------------------------------------------------- */

#define APP_INDEX_NONE (-2) // startup sentinel: nothing entered yet

static int g_currentIndex = APP_INDEX_NONE;
static const app_t *g_currentApp = NULL;
static bool g_switchPending = false;
static int g_switchTarget = 0;

static void do_switch(int target) {
    const app_t *from = g_currentApp;
    const app_t *to = g_apps[target];

    if (from != NULL && from->leave != NULL) from->leave();
    g_arenaUsed = 0; // rewinds the bump pointer only; app_alloc() is what
                      // zeroes, and only what it hands out
    touch_resolver_reset();
    gfx_fill_rect(0, 0, PANEL_W, PANEL_H, PX_WHITE);
    if (to->enter != NULL) to->enter();
    gfx_push_all();

    char msg[64];
    char *p = msg;
    p = fmt_append_str(p, "switch: ");
    p = fmt_append_str(p, to->name);
    *p = '\0';
    rt_log(msg);
    // No microsecond cost logged, unlike the sibling: rt_time_us() is gone
    // with the profiler that read it (runtime_core.h). A switch cost
    // measured against a host-supplied millisecond clock would read 0
    // anyway, which is worse than not claiming a number.

    g_currentIndex = target;
    g_currentApp = to;
}

// Only ever records a request. An app's tick() is not a safe place to tear
// down that same app, so the switch is applied once, after tick() returns.
void app_switch_to(int index) {
    if (index < 0 || index >= g_appCount) return; // one app per module: any
        // other index is a host bug, ignored rather than trapped, the same
        // policy emu_button() uses for a bad button index
    g_switchPending = true;
    g_switchTarget = index;
}

int app_current(void) {
    return g_currentIndex;
}

/* ---- lifecycle ---------------------------------------------------------- */

// Whether this is the very first tick, so dtMs reads 0 for it instead of
// being computed against an uninitialised previous timestamp. Same as the
// sibling, and load-bearing for replay: a trace's first tick must produce
// the same dt on both targets.
static bool g_started = false;
static uint32_t g_lastNowMs = 0;
static uint32_t g_lastEraseSeq = 0;

void rtcore_init(void) {
    do_switch(0);
    g_started = false;
}

void rtcore_tick(uint32_t nowMs) {
    if (!g_started) {
        g_lastNowMs = nowMs;
        g_started = true;
    }

    // Clamped so a slow one-off (a backgrounded tab, a phone that stopped
    // firing rAF for three seconds) hands the next tick a sane dt instead
    // of a multi-second jump a solver would explode on. 250ms is the
    // sibling's number, kept: a browser tab needs this MORE than a board
    // does, not less.
    uint32_t dtMs = nowMs - g_lastNowMs;
    if (dtMs > 250) dtMs = 250;
    g_lastNowMs = nowMs;

    app_frame_t frame = { 0 };
    frame.nowMs = nowMs;
    frame.dtMs = dtMs;

    // ---- touch: drain the whole backlog, then resolve one down/pressed/
    // released/x/y for this frame. No raw-stream escape hatch here: the
    // sibling has one because its sketchpad reconstructs strokes from raw
    // samples, and this pack ships no such app.
    {
        touch_sample_t s;
        bool down = g_touchWasDown;
        int x = g_touchLastX, y = g_touchLastY;
        while (sensors_touch_next(&s)) {
            down = (s.fingers != 0);
            x = s.x;
            y = s.y;
        }
        if (x < 0) x = 0; else if (x > PANEL_W - 1) x = PANEL_W - 1;
        if (y < 0) y = 0; else if (y > PANEL_H - 1) y = PANEL_H - 1;

        frame.touchPressed = down && !g_touchWasDown;
        frame.touchReleased = !down && g_touchWasDown;
        frame.touchDown = down;
        frame.touchX = x;
        frame.touchY = y;

        g_touchWasDown = down;
        g_touchLastX = x;
        g_touchLastY = y;

        sensors_set_finger_down(down);
    }

    // ---- power key: exactly one read-and-clear per loop. Everything the
    // host resolved passes through to the app unchanged, including
    // KEY_LONG: this runtime has no menu chord to consume it with (see
    // runtime_core.h).
    frame.key = sensors_key_take();

    frame.bootClicked = sensors_boot_clicked();

    // ---- tilt: always present, no opt-in flag, same as the sibling
    // (app.h's own comment on app_frame_t.tilt). Read fresh every frame:
    // see sensors.h's own comment on why this pack has no filter of its
    // own to run here.
    sensors_tilt(&frame.tilt);

    {
        uint32_t seq = sensors_erase_seq();
        // Advance the tracked sequence every frame regardless of whether
        // the app wants shake, so an app that opts in later is not handed
        // a stale "shaken" for a jolt that happened before it ran.
        bool bumped = (seq != g_lastEraseSeq);
        g_lastEraseSeq = seq;
        frame.shaken = bumped && g_currentApp->wantsShake;
    }

    g_currentApp->tick(&frame);

    if (g_switchPending) {
        g_switchPending = false;
        do_switch(g_switchTarget);
    }
}
