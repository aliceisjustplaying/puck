// gfx, the browser edition: the framebuffer and the "push" bookkeeping,
// owned by the runtime.
//
// NOT vendored. gfx.h is (see its own note); this file is a
// reimplementation, because the sibling's gfx.c is two things at once - a
// clipper and a rasteriser, which is portable, and a driver call into
// AMOLED_1IN8_Display/AMOLED_1IN8_DisplayWindows, which is a QSPI panel
// this target does not have. What survives here is the first half,
// deliberately line-for-line: gfx_fill_rect's clip, gfx_push's 8-pixel
// widening and edge slide, and the landscape mapping are copied from
// packs/rp2350-touch-amoled-18/firmware/runtime/gfx.c (MIT, same
// repository) rather than re-derived, because a port that draws the same
// rectangles has to land on the same pixels here or this pack proves
// nothing. See NOTICE.md.
//
// The two real differences:
//
// 1. THE FRAMEBUFFER IS STATIC, not malloc'd. The sibling's gfx_init()
//    calls malloc() once for 368*448*2 = 330KB, which on the board is a
//    real budget decision (520KB of SRAM) and in a browser is not a
//    decision at all. device.json says so out loud: "a browser has no SRAM
//    budget; the rp2350 contract applies unchanged". A static array is
//    simply the honest shape of that here, and it removes the one
//    allocator the sibling's wasm shim had to invent to support it.
//
// 2. THE PUSH GOES TO A RECORDER, not a panel. panel_push() below is a
//    seam implemented by wasm/emu_shim.c, which records the rectangle for
//    the host to read through emu_push_count/emu_push_x/... (wasm/
//    emu_abi.h). The host uses those rectangles to blit only what changed
//    onto its canvas: the same dirty-rectangle discipline the board uses
//    to avoid a 12ms full-panel DMA, for the different reason that a
//    phone repainting 164,864 pixels per frame in JavaScript is how a
//    60fps app becomes a 40fps one.
//
// A pushed rectangle is therefore not decorative here. An app that draws
// without pushing draws into a framebuffer nobody blits, exactly as on the
// board, which is what keeps a port honest across both targets.
#include "gfx.h"

#include <stddef.h> // size_t, for the row arithmetic in gfx_fill_rect. The
                    // sibling got it transitively from <stdlib.h>/<stdio.h>,
                    // which this file does not need (no malloc, no printf).

// The panel seam, implemented by wasm/emu_shim.c. Takes the same (x, y, w,
// h) shape the sibling's AMOLED_1IN8_DisplayWindows call site produces, so
// the arithmetic in gfx_push below could stay identical to the sibling's.
void panel_push(int x, int y, int w, int h);

// One full 368*448*2 = 330KB buffer, static (see this file's header, point
// 1). Aligned to 8 so a host reading it as a typed array off emu_fb()
// never lands on an odd offset.
static uint16_t g_fb[PANEL_W * PANEL_H] __attribute__((aligned(8)));

uint16_t *gfx_fb = g_fb;

bool gfx_init(void) {
    for (int i = 0; i < PANEL_W * PANEL_H; i++) g_fb[i] = 0xFFFF;
    panel_push(0, 0, PANEL_W, PANEL_H);
    return true; // a static array cannot fail to exist; the sibling's
                 // `false` branch existed for malloc, which is gone.
}

/* ---- drawing, panel (portrait) coordinates -----------------------------
 *
 * Copied from the sibling's gfx.c, which itself lifted it from
 * apps/chrono/main.c's fill_rect(): clips to the panel, so callers may pass
 * rectangles that run off the edge without checking first.
 */
void gfx_fill_rect(int x, int y, int w, int h, uint16_t colorPx) {
    if (x < 0) { w += x; x = 0; }
    if (y < 0) { h += y; y = 0; }
    if (x + w > PANEL_W) w = PANEL_W - x;
    if (y + h > PANEL_H) h = PANEL_H - y;
    if (w <= 0 || h <= 0) return;
    for (int j = 0; j < h; j++) {
        uint16_t *row = gfx_fb + (size_t)(y + j) * PANEL_W + x;
        for (int i = 0; i < w; i++) row[i] = colorPx;
    }
}

/* ---- pushing to the panel ---------------------------------------------
 *
 * Row length granularity, in pixels. This is the SH8601's rule, not the
 * browser's, and it is kept here on purpose - see gfx.h's vendoring note
 * for why a browser pays an alignment it does not need rather than
 * quietly disagreeing with the board about what a push covers.
 */
#define PUSH_GRAN_W 8
#define PUSH_MIN_W  8

// Takes an INCLUSIVE dirty rectangle in panel coordinates. Arithmetic
// copied from the sibling's gfx_push(), comments included, so the widened
// window this pack reports is byte-identical to the one the board sends.
void gfx_push(int minX, int minY, int maxX, int maxY) {
    if (minX > maxX || minY > maxY) return;
    if (minX < 0) minX = 0;
    if (minY < 0) minY = 0;
    if (maxX > PANEL_W - 1) maxX = PANEL_W - 1;
    if (maxY > PANEL_H - 1) maxY = PANEL_H - 1;

    // x0 is only aligned to 2, not to 8: the board's own bisect showed an
    // unaligned start with a rounded row length is clean, so aligning the
    // start would only widen the window for nothing.
    int x0 = minX & ~1;
    int w = maxX + 1 - x0;
    w = (w + PUSH_GRAN_W - 1) & ~(PUSH_GRAN_W - 1);
    if (w < PUSH_MIN_W) w = PUSH_MIN_W;
    int x1 = x0 + w;
    if (x1 > PANEL_W) {
        // Slide the window left rather than clipping its width, since
        // shortening the row is exactly what corrupts it on the board. The
        // panel is 368 wide, a multiple of 8, so a left-slid window stays
        // aligned.
        x0 = PANEL_W - w;
        if (x0 < 0) { x0 = 0; w = PANEL_W; }
        x0 &= ~1;
        x1 = x0 + w;
        if (x1 > PANEL_W) { x0 = PANEL_W - w; x1 = PANEL_W; }
    }

    int y0 = minY & ~1;
    int y1 = maxY + 1;
    if (y1 & 1) y1++;
    if (y1 > PANEL_H) y1 = PANEL_H;
    if (y1 <= y0) y1 = y0 + 2;

    panel_push(x0, y0, x1 - x0, y1 - y0);
}

void gfx_push_all(void) {
    panel_push(0, 0, PANEL_W, PANEL_H);
}

/* ---- landscape helpers -------------------------------------------------
 *
 * Copied from the sibling's gfx.c unchanged. Mapping: landscape (lx, ly)
 * -> panel (PANEL_W - 1 - ly, lx), so a landscape rectangle (lx, ly, w, h)
 * becomes the panel rectangle (PANEL_W - (ly + h), lx, h, w).
 *
 * A phone has no buttons along a physical top edge to orient against, so
 * "landscape" here means exactly what it means on the board and nothing
 * more: the app draws into a 448x368 space and the runtime rotates its
 * rectangles. A person reads a landscape app by turning the phone, the
 * same thing they do with the puck.
 */
void gfx_land_rect(int lx, int ly, int w, int h,
                   int *px, int *py, int *pw, int *ph) {
    *px = PANEL_W - (ly + h);
    *py = lx;
    *pw = h;
    *ph = w;
}

void gfx_fill_rect_land(int lx, int ly, int w, int h, uint16_t colorPx) {
    int px, py, pw, ph;
    gfx_land_rect(lx, ly, w, h, &px, &py, &pw, &ph);
    gfx_fill_rect(px, py, pw, ph, colorPx);
}

// Landscape (lx, ly, w, h), NOT inclusive corners, unlike gfx_push (see
// gfx.h). Converted to a panel rectangle, then to the inclusive corners
// gfx_push wants, so the 8-pixel row-length rule still applies to the
// rotated (panel-space) width.
void gfx_push_land(int lx, int ly, int w, int h) {
    int px, py, pw, ph;
    gfx_land_rect(lx, ly, w, h, &px, &py, &pw, &ph);
    gfx_push(px, py, px + pw - 1, py + ph - 1);
}
