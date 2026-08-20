/*
 * runtime_core: implementation. See runtime_core.h for what this file is,
 * why it depends on nothing but app.h, gfx_band.h and freestanding headers,
 * and why its input functions mirror emu_abi.h's shape directly instead of
 * going through a sensors.h-style abstraction the way the RP2350 sibling
 * does - this board's single polling loop (main/main.c) has no second core
 * and no i2c ownership rule to encode, so there is nothing that abstraction
 * would be buying here.
 */
#include "runtime_core.h"

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#include "app.h"

/* ---- the one reference app -----------------------------------------------
 *
 * device.json declares no "apps" array (this pack ships a single reference
 * app, see AGENTS.md), so there is no table and no switch function here,
 * unlike the RP2350 sibling's g_apps[]/app_switch_to(). If a second app is
 * ever added: add a g_apps[]/g_appCount pair exactly like the sibling's
 * runtime_core.c, an app_switch_to() that defers to the end of the current
 * frame the same way, and reset g_arenaUsed on switch (see app_alloc()'s
 * comment below for why that is currently skipped).
 */
extern const app_t g_demoApp;
static const app_t *g_app = &g_demoApp;

/* ---- the arena -------------------------------------------------------
 *
 * One static byte array, bump-allocated. Unlike the sibling pack, this is
 * never reset: rtcore_init() calls enter() exactly once, ever, since there
 * is no second app to switch to and reclaim the arena for.
 */
static uint8_t g_arena[APP_ARENA_BYTES] __attribute__((aligned(8)));
static size_t g_arenaUsed = 0;

static void arena_overflow_trap(void) {
    rt_log("FATAL: app arena overflow (see app.h's APP_ARENA_BYTES)");
    rt_halt(); // must not return
    for (;;) { } // unreachable if the platform's rt_halt() contract holds
}

void *app_alloc(size_t bytes) {
    size_t aligned = (g_arenaUsed + 7u) & ~(size_t)7u;
    if (bytes > APP_ARENA_BYTES || aligned > APP_ARENA_BYTES - bytes) {
        arena_overflow_trap();
    }
    void *p = &g_arena[aligned];
    g_arenaUsed = aligned + bytes;

    // Zeroed, per app.h's promise - only the bytes just handed out, not the
    // whole arena, same reasoning the sibling's app_alloc() gives.
    uint8_t *bytesOut = (uint8_t *)p;
    for (size_t i = 0; i < bytes; i++) bytesOut[i] = 0;

    return p;
}

/* ---- touch: latched directly, no ring -----------------------------------
 *
 * The RP2350 sibling drains a producer/consumer ring because its touch
 * reads happen on a second core racing the render loop. This board's
 * touch.c is polled once per iteration of the same single main loop that
 * calls rtcore_tick(), so there is only ever one reader and one writer, on
 * one core, and a ring would be buying nothing a plain latch does not
 * already give for free.
 */
static bool g_touchDown = false;
static int  g_touchX = 0, g_touchY = 0;
static bool g_touchWasDown = false;

void rtcore_set_touch(int down, int x, int y) {
    g_touchDown = down != 0;
    g_touchX = x;
    g_touchY = y;
}

/* ---- PWR key: bits latched the same shape emu_abi.h's emu_button/
 * emu_button_verdict deliver, read-and-clear once per tick. */
static uint8_t g_keyEvent = 0;

/* ---- BOOT: level tracked directly, click derived on release. This board's
 * BOOT is a plain GPIO0 strap button (see main/main.c), so unlike the
 * RP2350 sibling there is no borrowed-flash-chip-select sampling-rate
 * caveat to carry over here. */
static bool g_bootLevel = false;
static bool g_bootClickedPending = false;

void rtcore_set_button(int index, int down) {
    if (index == RT_BTN_BOOT) {
        bool wasDown = g_bootLevel;
        g_bootLevel = (down != 0);
        if (wasDown && !g_bootLevel) {
            g_bootClickedPending = true; // click on release
        }
    } else if (index == RT_BTN_PWR) {
        if (down) g_keyEvent |= KEY_PRESS;
        else g_keyEvent |= KEY_RELEASE;
    }
    // Any other index is a platform bug (device.json declares exactly two
    // buttons); ignored rather than trapped, same policy the sibling uses.
}

void rtcore_set_button_verdict(int index, int isLong) {
    if (index == RT_BTN_PWR) { // only pwr declares longPressMs
        g_keyEvent |= isLong ? KEY_LONG : KEY_SHORT;
    }
}

/* ---- shake: a monotonic counter, diffed once per tick - same shape the
 * sibling's sensors_erase_seq() uses, minus the wants_shake gate: this pack
 * has one app and no drawing surface an unwanted erase would threaten, so
 * shake is always delivered. */
static uint32_t g_shakeSeq = 0;
static uint32_t g_shakeSeqSeen = 0;

void rtcore_sensor_event(int index) {
    if (index == RT_SENSOR_SHAKE) g_shakeSeq++;
}

/* ---- raw accelerometer sample stream: a small ring, write side latches,
 * read side drains. See runtime_core.h's own comment for why this is a
 * ring and not a single latched value like touch/button. Overflow policy:
 * drop the OLDEST unread sample to make room for the newest, same "a slow
 * consumer sees a gap, never a stall" choice a real 200Hz-vs-60Hz producer/
 * consumer pair would force on real hardware too - a consumer that drains
 * every tick (GOLF's own budget) never gets close to APP_ACCEL_RING
 * anyway. */
static app_accel_sample_t g_accelRing[APP_ACCEL_RING];
static int g_accelHead = 0; // next write slot
static int g_accelCount = 0; // samples currently held, <= APP_ACCEL_RING

void rtcore_accel_sample(uint32_t tMs, float ax, float ay, float az) {
    g_accelRing[g_accelHead] = (app_accel_sample_t){ tMs, ax, ay, az };
    g_accelHead = (g_accelHead + 1) % APP_ACCEL_RING;
    if (g_accelCount < APP_ACCEL_RING) g_accelCount++;
    // else: ring was full, the write above just overwrote the oldest slot,
    // and the read side's tail implicitly advances with it (see below).
}

int app_accel_read(app_accel_sample_t *out, int max) {
    int n = g_accelCount < max ? g_accelCount : max;
    // Oldest-first: the oldest held sample sits `g_accelCount` slots behind
    // the next write position, wrapping.
    int start = (g_accelHead - g_accelCount + APP_ACCEL_RING) % APP_ACCEL_RING;
    for (int i = 0; i < n; i++) {
        out[i] = g_accelRing[(start + i) % APP_ACCEL_RING];
    }
    g_accelCount -= n;
    return n;
}

/* ---- lifecycle ------------------------------------------------------- */
static bool g_started = false;
static uint32_t g_lastNowMs = 0;

void rtcore_init(void) {
    if (g_app->enter != NULL) g_app->enter();
}

const char *rtcore_app_name(void) {
    return g_app->name;
}

// See runtime_core.h for what this does and does not restore. The arena
// rewind is the whole point: without it, re-entering would bump-allocate a
// second copy of the app's state and the next re-entry a third, so the one
// thing a reset is for (a board that starts the same way twice) would run
// out of arena instead.
void rtcore_reset(void) {
    if (g_app->leave != NULL) g_app->leave();

    g_arenaUsed = 0;

    g_touchDown = false;
    g_touchWasDown = false;
    g_touchX = 0;
    g_touchY = 0;
    g_keyEvent = 0;
    g_bootLevel = false;
    g_bootClickedPending = false;
    g_shakeSeqSeen = g_shakeSeq;
    g_started = false;
    g_accelHead = 0;
    g_accelCount = 0;

    if (g_app->enter != NULL) g_app->enter();
}

void rtcore_tick(uint32_t nowMs) {
    if (!g_started) {
        g_lastNowMs = nowMs;
        g_started = true;
    }

    uint32_t dtMs = nowMs - g_lastNowMs;
    if (dtMs > 250) dtMs = 250; // clamp a stall rather than hand the app a
                                // multi-second jump
    g_lastNowMs = nowMs;

    app_frame_t frame = { 0 };
    frame.nowMs = nowMs;
    frame.dtMs = dtMs;

    frame.touchDown = g_touchDown;
    frame.touchPressed = g_touchDown && !g_touchWasDown;
    frame.touchReleased = !g_touchDown && g_touchWasDown;
    frame.touchX = g_touchX;
    frame.touchY = g_touchY;
    g_touchWasDown = g_touchDown;

    frame.key = g_keyEvent;
    g_keyEvent = 0;

    frame.bootClicked = g_bootClickedPending;
    g_bootClickedPending = false;

    frame.shaken = (g_shakeSeq != g_shakeSeqSeen);
    g_shakeSeqSeen = g_shakeSeq;

    if (g_app->tick != NULL) g_app->tick(&frame);

    for (int band = 0; band < BAND_COUNT; band++) {
        uint16_t *buf = plat_acquire_band(band);
        if (g_app->draw_band != NULL) {
            g_app->draw_band(band, buf, band * BAND_ROWS, BAND_ROWS);
        }
        plat_flush_band(band, buf);
    }
}
