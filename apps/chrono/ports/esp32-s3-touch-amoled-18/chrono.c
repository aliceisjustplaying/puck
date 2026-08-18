/*
 * chrono: stopwatch, ported to the esp32-s3-touch-amoled-18 pack's band
 * contract. See README.md (this directory) for the porting verdict and for
 * exactly what came from apps/chrono/descriptor.md versus what had to be
 * pinned from the reference snapshot
 * (apps/chrono/reference/rp2350-touch-amoled-18/chrono.c and
 * packs/rp2350-touch-amoled-18/firmware/apps/digits.c/.h).
 *
 * THE BAND DIFFERENCE FROM THE REFERENCE. The rp2350 reference owns a
 * persistent 368x448 framebuffer and repaints only the digit cells that
 * changed value, each redraw followed by its own small panel push
 * (gfx_push_land). This pack has no framebuffer at all (app.h, this pack's
 * AGENTS.md): draw_band() gets a 28-row band with UNDEFINED prior content
 * and must repaint every pixel of it, every call, 16 calls a frame. So
 * tick() here only updates state (running/elapsedMs/runStartMs and the six
 * digit values); draw_band() recomputes the whole 448x368-landscape face
 * fresh every time from that state, clipped to whichever band it was
 * handed. The descriptor's Demands never mention partial refresh, only the
 * pixels actually on screen, so this strategy difference does not affect
 * the port's faithful/pixel-exact verdict (see README.md).
 *
 * THE ROTATION. This app thinks entirely in LANDSCAPE coordinates (448 wide
 * x 368 tall), exactly like the reference. land_fill_rect() is the one
 * place a landscape rectangle becomes a panel (portrait, 368x448)
 * rectangle, using the same mapping
 * packs/rp2350-touch-amoled-18/firmware/runtime/gfx.h's gfx_land_rect()
 * documents: landscape (lx, ly, w, h) -> panel (PANEL_W - (ly + h), lx, h,
 * w). Every other drawing function in this file (land_draw_digit,
 * land_draw_colon) works purely in landscape space and only ever reaches
 * the panel through that one function, the same discipline gfx.h's header
 * comment describes ("gfx rotates rectangles, not pixels").
 */
#include "app.h"
#include "gfx_band.h"

/* ---------------------------------------------------------------------
 * Layout, in LANDSCAPE coordinates (448 wide x 368 tall) - identical to
 * the reference (apps/chrono/reference/rp2350-touch-amoled-18/chrono.c),
 * and, per README.md, independently re-derivable from
 * apps/chrono/descriptor.md's stated margins/widths/gaps.
 * ------------------------------------------------------------------- */
#define DIGIT_W 48
#define DIGIT_H 120
#define SEG_T   18   // not stated in the descriptor; pinned from digits.c
#define SEP_W   24
#define Y0      124  // (368 - DIGIT_H) / 2, landscape y

#define X_MM_TENS  14
#define X_MM_UNITS 74
#define X_COLON1   134
#define X_SS_TENS  170
#define X_SS_UNITS 230
#define X_COLON2   290
#define X_CS_TENS  326
#define X_CS_UNITS 386

static const int DIGIT_X[6] = { X_MM_TENS, X_MM_UNITS, X_SS_TENS, X_SS_UNITS, X_CS_TENS, X_CS_UNITS };

/* ---------------------------------------------------------------------
 * Seven-segment digits, pinned from packs/rp2350-touch-amoled-18/firmware/
 * apps/digits.c: standard layout, a=top, b=top-right, c=bottom-right,
 * d=bottom, e=bottom-left, f=top-left, g=middle. Not derivable from the
 * descriptor (see README.md).
 * ------------------------------------------------------------------- */
static const uint8_t SEVEN_SEG[10] = {
    0x3F, // 0: a b c d e f
    0x06, // 1: b c
    0x5B, // 2: a b d e g
    0x4F, // 3: a b c d g
    0x66, // 4: b c f g
    0x6D, // 5: a c d f g
    0x7D, // 6: a c d e f g
    0x07, // 7: a b c
    0x7F, // 8: all
    0x6F, // 9: a b c d f g
};

/* ---------------------------------------------------------------------
 * State. One struct from the arena (app.h), zeroed by APP_STATE, entered
 * once at boot. digits[] holds the currently-displayed value of each of
 * the 6 cells (recomputed every tick from elapsed time), which draw_band()
 * reads fresh on every one of its 16 calls a frame - there is no
 * "lastDigit" dirty-tracking here, unlike the reference: with no
 * persistent framebuffer there is nothing to diff against, so every band
 * draw repaints from this state regardless of whether a digit changed.
 * ------------------------------------------------------------------- */
typedef struct {
    bool     running;
    uint32_t elapsedMs;  // accumulated across all completed run segments
    uint32_t runStartMs; // f->nowMs at the start of the current segment
    int      digits[6];
} chrono_state_t;

static chrono_state_t *s_state;

static void chrono_enter(void) {
    s_state = APP_STATE(chrono_state_t);
    // digits[] is already all-zero: APP_STATE zeroes the allocation, and
    // "00:00:00" is exactly six zero digits.
}

/* ---------------------------------------------------------------------
 * tick(): update state only, per app.h's contract - no drawing here.
 * Mirrors the reference's chrono_tick() arithmetic exactly (same order:
 * BOOT reset first, then the PWR short-press toggle, both before computing
 * this tick's shown value), except it recomputes ALL SIX digits into
 * state every tick rather than tracking which changed, since draw_band()
 * has no "changed" concept to exploit.
 * ------------------------------------------------------------------- */
static void chrono_tick(const app_frame_t *f) {
    chrono_state_t *s = s_state;

    if (f->bootClicked) {
        s->running = false;
        s->elapsedMs = 0;
    }

    if (f->key & KEY_SHORT) {
        // Toggle on the press edge, and do the elapsed-time arithmetic
        // right here, before this tick's digit recompute below - same
        // responsiveness fix the reference documents (freeze/resume shows
        // at once, not on the next tick).
        if (s->running) {
            s->elapsedMs += f->nowMs - s->runStartMs;
            s->running = false;
        } else {
            s->runStartMs = f->nowMs;
            s->running = true;
        }
    }

    uint32_t shownMs = s->running ? s->elapsedMs + (f->nowMs - s->runStartMs) : s->elapsedMs;
    uint32_t totalCs = shownMs / 10; // 1 centisecond = 10ms
    uint32_t mm = (totalCs / 6000) % 100; // wraps at 100, same as the reference
    uint32_t ss = (totalCs / 100) % 60;
    uint32_t cs = totalCs % 100;

    s->digits[0] = (int)(mm / 10);
    s->digits[1] = (int)(mm % 10);
    s->digits[2] = (int)(ss / 10);
    s->digits[3] = (int)(ss % 10);
    s->digits[4] = (int)(cs / 10);
    s->digits[5] = (int)(cs % 10);
}

/* ---------------------------------------------------------------------
 * Drawing. Every function below takes (buf, band_y0, rows) - the same
 * triple draw_band() was handed - and works in LANDSCAPE coordinates
 * until the one call to land_fill_rect(), which is the only place the
 * landscape->panel rotation happens.
 * ------------------------------------------------------------------- */

// landscape (lx, ly, w, h) -> panel (PANEL_W - (ly + h), lx, h, w), the
// mapping packs/rp2350-touch-amoled-18/firmware/runtime/gfx.h's
// gfx_land_rect() documents. gfxb_fill_rect() then clips that panel
// rectangle to [band_y0, band_y0 + rows), same as any other band draw.
static void land_fill_rect(uint16_t *buf, int band_y0, int rows,
                            int lx, int ly, int w, int h, uint16_t colorPx) {
    int px = PANEL_W - (ly + h);
    int py = lx;
    int pw = h;
    int ph = w;
    gfxb_fill_rect(buf, band_y0, rows, px, py, pw, ph, colorPx);
}

// One decimal digit (0..9) in a w x h landscape cell at (lx, ly), segment
// thickness t. Pinned from digits.c's digits_draw(), including its two
// documented corrections: a vertical segment runs to the cell edge when
// the horizontal that would cap it is absent (rule 1, so "4" is not
// visibly shorter than "0"), and an upper/lower vertical pair on one side
// joins into one stroke when the middle bar is absent (rule 2, so "1" is
// not two disconnected ticks). See digits.h's header comment for why both
// rules exist.
static void land_draw_digit(uint16_t *buf, int band_y0, int rows,
                             int lx, int ly, int w, int h, int t, int value, uint16_t colorPx) {
    int x0 = lx, y0 = ly;
    uint8_t segs = SEVEN_SEG[value];
    int midY = y0 + h / 2 - t / 2;

    int topY = (segs & 0x01) ? (y0 + t) : y0;
    int topH = midY - topY;
    int botY = midY + t;
    int botH = ((segs & 0x08) ? (y0 + h - t) : (y0 + h)) - botY;

    bool hasG = (segs & 0x40) != 0;
    int fullY = topY;
    int fullH = (botY + botH) - topY;

    if (segs & 0x01) land_fill_rect(buf, band_y0, rows, x0,     y0,     w, t, colorPx); // a
    if (hasG)        land_fill_rect(buf, band_y0, rows, x0,     midY,   w, t, colorPx); // g
    if (segs & 0x08) land_fill_rect(buf, band_y0, rows, x0,     y0+h-t, w, t, colorPx); // d

    // Left side: f (upper) and e (lower).
    if (!hasG && (segs & 0x20) && (segs & 0x10)) {
        land_fill_rect(buf, band_y0, rows, x0, fullY, t, fullH, colorPx);
    } else {
        if (segs & 0x20) land_fill_rect(buf, band_y0, rows, x0, topY, t, topH, colorPx); // f
        if (segs & 0x10) land_fill_rect(buf, band_y0, rows, x0, botY, t, botH, colorPx); // e
    }

    // Right side: b (upper) and c (lower).
    if (!hasG && (segs & 0x02) && (segs & 0x04)) {
        land_fill_rect(buf, band_y0, rows, x0 + w - t, fullY, t, fullH, colorPx);
    } else {
        if (segs & 0x02) land_fill_rect(buf, band_y0, rows, x0+w-t, topY, t, topH, colorPx); // b
        if (segs & 0x04) land_fill_rect(buf, band_y0, rows, x0+w-t, botY, t, botH, colorPx); // c
    }
}

// Two stacked t x t dots, centred in a w x h landscape cell. Pinned from
// digits.c's digits_draw_colon(): always ":", never a comma (the
// descriptor's Essence section is explicit about this too).
static void land_draw_colon(uint16_t *buf, int band_y0, int rows,
                             int lx, int ly, int w, int h, int t, uint16_t colorPx) {
    int dotX = lx + (w - t) / 2;
    land_fill_rect(buf, band_y0, rows, dotX, ly + h/3 - t/2,     t, t, colorPx);
    land_fill_rect(buf, band_y0, rows, dotX, ly + (2*h)/3 - t/2, t, t, colorPx);
}

/* ---------------------------------------------------------------------
 * draw_band(): called once per band, every frame (app.h). Repaints the
 * whole band white, then redraws whatever part of the two colons and six
 * digits (if any) falls inside this band's rows - gfxb_fill_rect (via
 * land_fill_rect) clips each call to [y0, y0+rows), so most of the ~28
 * rectangle calls below touch nothing in a given band and cost only the
 * clip check.
 * ------------------------------------------------------------------- */
static void chrono_draw_band(int band, uint16_t *buf, int y0, int rows) {
    (void)band;
    chrono_state_t *s = s_state;

    gfxb_fill(buf, rows, PX_WHITE);

    land_draw_colon(buf, y0, rows, X_COLON1, Y0, SEP_W, DIGIT_H, SEG_T, PX_BLACK);
    land_draw_colon(buf, y0, rows, X_COLON2, Y0, SEP_W, DIGIT_H, SEG_T, PX_BLACK);

    for (int i = 0; i < 6; i++) {
        land_draw_digit(buf, y0, rows, DIGIT_X[i], Y0, DIGIT_W, DIGIT_H, SEG_T, s->digits[i], PX_BLACK);
    }
}

// Shake does nothing here, same as the reference (wantsShake = false there,
// and this pack's app_frame_t.shaken is simply never read below): the
// descriptor is explicit that carrying the stopwatch must not erase it.
//
// Symbol name is g_demoApp, not g_chronoApp: runtime_core.c (unmodified,
// see README.md's "Implementation note") declares
// `extern const app_t g_demoApp;` as this pack's one wired app slot. Only
// the .name string below actually says "chrono".
const app_t g_demoApp = {
    .name      = "chrono",
    .enter     = chrono_enter,
    .tick      = chrono_tick,
    .draw_band = chrono_draw_band,
    .leave     = NULL,
};
