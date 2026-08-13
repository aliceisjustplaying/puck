/*
 * The tiny example firmware. Implements wasm/emu_abi.h directly, with no
 * dependency on anything else in this repo, so it doubles as the minimum
 * viable answer to "what does a firmware need to provide to show up in
 * this emulator". Read this file top to bottom before writing your own;
 * every ABI export is here, and nothing here is required beyond what
 * emu_abi.h documents.
 *
 * Deliberately excluded, to keep this genuinely small: apps (emu_app_*)
 * and sound (emu_sound_*). Both are optional per emu_abi.h ("a firmware
 * without a concept of apps/sound leaves these unimplemented and the
 * emulator will not call them"). See docs/abi.md for how to add either.
 *
 * What it does, so you know what you're looking at once it's running:
 *   - a 240x240 panel, filled with a paper colour on boot
 *   - touch draws a small filled square in the current ink colour,
 *     pushed as its own small rectangle (watch the "contact" overlay
 *     and the push-window overlay in the emulator page - each stroke
 *     is its own partial refresh, not a full-panel redraw)
 *   - button A (right edge): a short press cycles the ink colour; a
 *     long press (800ms, declared via longPressMs) clears the screen
 *   - button B (left edge): toggles a border, redrawing the whole panel
 *   - holding A and B together (the declared "chord" gesture) inverts
 *     the ink colour order
 *   - the declared "shake" sensor clears the screen, same as A's long
 *     press, so you can trigger it from the emulator's sensor button,
 *     the window-shake detector, or by dragging the puck itself
 *
 * No malloc, no libc math, no printf: the only host import this module
 * uses is js_log (see emu_abi.h's import list). The framebuffer is a
 * plain static array, since 240*240*2 bytes is small enough not to need
 * any allocator at all.
 */
#include "emu_abi.h"

#include <stdbool.h>
#include <stdint.h>

/* ---- the host's logging import -------------------------------------- */
extern void js_log(const char *ptr, int len);

static int str_len(const char *s) {
    int n = 0;
    while (s[n]) n++;
    return n;
}
static void log_msg(const char *s) {
    js_log(s, str_len(s));
}

/* ---- panel -------------------------------------------------------------
 *
 * "rgb565be" (declared in emu_device() below) means every stored uint16_t
 * has its two bytes in the opposite order from how the CPU would naturally
 * store an RGB565 value - see emu_abi.h's panel.format note. rgb565be()
 * below builds a pixel already in that swapped form, so the framebuffer
 * this firmware writes is exactly the bytes the emulator reads back.
 * ---------------------------------------------------------------------- */
#define PANEL_W 240
#define PANEL_H 240

static uint16_t g_fb[PANEL_W * PANEL_H];

static uint16_t rgb565be(uint8_t r, uint8_t g, uint8_t b) {
    uint16_t v = (uint16_t)(((r >> 3) << 11) | ((g >> 2) << 5) | (b >> 3));
    return (uint16_t)((v >> 8) | (v << 8)); /* swap bytes for panel DMA order */
}

#define COLOR_COUNT 3
static const uint8_t INK_R[COLOR_COUNT] = { 40, 90, 150 };
static const uint8_t INK_G[COLOR_COUNT] = { 40, 90, 150 };
static const uint8_t INK_B[COLOR_COUNT] = { 40, 90, 150 };

static void fill_rect(int x, int y, int w, int h, uint16_t color) {
    if (x < 0) { w += x; x = 0; }
    if (y < 0) { h += y; y = 0; }
    if (x + w > PANEL_W) w = PANEL_W - x;
    if (y + h > PANEL_H) h = PANEL_H - y;
    if (w <= 0 || h <= 0) return;
    for (int row = 0; row < h; row++) {
        uint16_t *line = &g_fb[(y + row) * PANEL_W + x];
        for (int col = 0; col < w; col++) line[col] = color;
    }
}

/* ---- what the last tick pushed, per emu_abi.h ------------------------- */
#define MAX_PUSHES 4
static int g_pushX[MAX_PUSHES], g_pushY[MAX_PUSHES], g_pushW[MAX_PUSHES], g_pushH[MAX_PUSHES];
static int g_pushCount = 0;

static void record_push(int x, int y, int w, int h) {
    if (g_pushCount >= MAX_PUSHES) return; /* drop past the cap, same as any bounded ring would */
    g_pushX[g_pushCount] = x;
    g_pushY[g_pushCount] = y;
    g_pushW[g_pushCount] = w;
    g_pushH[g_pushCount] = h;
    g_pushCount++;
}

static uint16_t paper_color(void) { return rgb565be(0xf5, 0xf1, 0xe8); }

static void redraw_full(bool borderOn, uint16_t ink) {
    fill_rect(0, 0, PANEL_W, PANEL_H, paper_color());
    if (borderOn) {
        const int t = 6; /* border thickness, px */
        fill_rect(0, 0, PANEL_W, t, ink);
        fill_rect(0, PANEL_H - t, PANEL_W, t, ink);
        fill_rect(0, 0, t, PANEL_H, ink);
        fill_rect(PANEL_W - t, 0, t, PANEL_H, ink);
    }
    record_push(0, 0, PANEL_W, PANEL_H);
}

/* ---- input state, latched by the emu_* calls below and consumed once
 * per emu_tick() - never drawn from directly inside an input call. This
 * mirrors emu_abi.h's own determinism rule: nowMs is the only clock, so
 * anything the module does in response to input happens at a tick, not at
 * the moment the host happened to call emu_touch/emu_button. ------------ */
#define BTN_A 0
#define BTN_B 1
#define SENSOR_SHAKE 0

static bool g_touchDown = false;
static int g_touchX = 0, g_touchY = 0;

static bool g_aDown = false, g_bDown = false;
static bool g_bWasDown = false;   /* to detect B's rising edge in tick() */
static int g_aVerdict = -1;       /* -1 none pending, 0 short, 1 long */
static bool g_chordConsumed = false;
static bool g_shakeRequested = false;

static int g_colorIndex = 0;
static bool g_invert = false;
static bool g_borderOn = false;

static uint16_t current_ink(void) {
    int idx = g_invert ? (COLOR_COUNT - 1 - g_colorIndex) : g_colorIndex;
    return rgb565be(INK_R[idx], INK_G[idx], INK_B[idx]);
}

/* ---- emu_abi.h: lifecycle ---------------------------------------------- */
int emu_init(void) {
    fill_rect(0, 0, PANEL_W, PANEL_H, paper_color());
    log_msg("example firmware: init");
    return 1;
}

void emu_tick(uint32_t nowMs) {
    (void)nowMs; /* this firmware has nothing time-based to do; a real one
                     would use nowMs for animation, debounce, etc. */
    g_pushCount = 0;

    if (g_shakeRequested) {
        g_shakeRequested = false;
        redraw_full(g_borderOn, current_ink());
        log_msg("shake: cleared");
        return;
    }

    if (g_aVerdict == 1) {
        g_aVerdict = -1;
        redraw_full(g_borderOn, current_ink());
        log_msg("button A: long press, cleared");
        return;
    }
    if (g_aVerdict == 0) {
        g_aVerdict = -1;
        g_colorIndex = (g_colorIndex + 1) % COLOR_COUNT;
        log_msg("button A: short press, ink color changed");
    }

    bool bRisingEdge = g_bDown && !g_bWasDown;
    g_bWasDown = g_bDown;
    if (bRisingEdge) {
        g_borderOn = !g_borderOn;
        redraw_full(g_borderOn, current_ink());
        log_msg(g_borderOn ? "button B: border on" : "button B: border off");
        return;
    }

    if (g_aDown && g_bDown) {
        if (!g_chordConsumed) {
            g_chordConsumed = true;
            g_invert = !g_invert;
            redraw_full(g_borderOn, current_ink());
            log_msg("chord: A+B held together, inverted ink order");
            return;
        }
    } else {
        g_chordConsumed = false;
    }

    if (g_touchDown) {
        const int half = 6;
        fill_rect(g_touchX - half, g_touchY - half, half * 2, half * 2, current_ink());
        record_push(g_touchX - half, g_touchY - half, half * 2, half * 2);
    }
}

/* ---- the panel ---------------------------------------------------------- */
int emu_fb(void) { return (int)(intptr_t)g_fb; }

int emu_push_count(void) { return g_pushCount; }
int emu_push_x(int i) { return g_pushX[i]; }
int emu_push_y(int i) { return g_pushY[i]; }
int emu_push_w(int i) { return g_pushW[i]; }
int emu_push_h(int i) { return g_pushH[i]; }

/* ---- input ---------------------------------------------------------------
 *
 * Every one of these ONLY latches state. See the comment above the state
 * variables for why: emu_tick() is the one place this firmware decides
 * anything, which is what keeps it deterministic and replayable. */
void emu_touch(int down, int x, int y) {
    g_touchDown = down != 0;
    g_touchX = x;
    g_touchY = y;
}

void emu_button(int index, int down) {
    if (index == BTN_A) g_aDown = down != 0;
    else if (index == BTN_B) g_bDown = down != 0;
}

void emu_button_verdict(int index, int isLong) {
    if (index == BTN_A) g_aVerdict = isLong ? 1 : 0;
    /* B has no longPressMs declared, so the emulator never calls this for
     * B - see emu_abi.h's note on emu_button_verdict. */
}

void emu_sensor_event(int index) {
    if (index == SENSOR_SHAKE) g_shakeRequested = true;
}

/* ---- emu_device(): a fixed string is enough here, since nothing about
 * this device's shape changes at runtime (contrast with a firmware that
 * declares a dynamic "apps" list, which has to build its JSON at runtime -
 * see docs/abi.md for that case). ---------------------------------------- */
static const char g_deviceJson[] =
    "{"
    "\"name\":\"puck-example\","
    "\"panel\":{\"w\":240,\"h\":240,\"format\":\"rgb565be\"},"
    "\"buttons\":["
    "{\"id\":\"a\",\"label\":\"A\",\"edge\":\"right\",\"at\":0.5,\"longPressMs\":800},"
    "{\"id\":\"b\",\"label\":\"B\",\"edge\":\"left\",\"at\":0.5}"
    "],"
    "\"touch\":{\"points\":1},"
    "\"sensors\":[{\"id\":\"shake\",\"kind\":\"event\",\"label\":\"Shake\"}],"
    "\"gestures\":[{\"id\":\"chord\",\"label\":\"chord\","
    "\"how\":\"Hold A, then also hold B. Holding both together inverts the ink colors.\","
    "\"script\":[{\"hold\":\"a\"},{\"hold\":\"b\"},{\"waitMs\":300},{\"release\":\"b\"},{\"release\":\"a\"}]}]"
    "}";

int emu_device(void) { return (int)(intptr_t)g_deviceJson; }
