/*
 * gfx_band: drawing helpers that operate WITHIN one band buffer.
 *
 * This is what makes app code written against app.h's draw_band() contract
 * readable: without it, every app would reimplement "clip a full-screen
 * rectangle to whichever 28-row slice I've been handed, then remember the
 * panel's byte-swapped pixel format" - exactly the kind of thing the RP2350
 * sibling's gfx.h header comment describes copy-pasted into four places
 * before it got centralised there. Centralising it here from the start
 * means an app drawing a full-screen rectangle never has to know it is
 * actually being drawn 16 times, once per band, clipped a different way
 * each time.
 */
#ifndef GFX_BAND_H
#define GFX_BAND_H

#include <stdint.h>

#include "runtime_core.h" // PANEL_W, PANEL_H, BAND_ROWS

/* ---- pixel format --------------------------------------------------------
 *
 * Same as the RP2350 sibling's gfx.h: the panel wants RGB565 with the
 * opposite byte order to how the CPU stores a uint16_t (device.json's
 * panel.format: "rgb565be"). Pure black and pure white are byte-palindromes
 * and look right unswapped too, which is exactly why this is easy to get
 * wrong until a colour that isn't one of those two shows up on screen.
 */
static inline uint16_t px_swap(uint16_t v) {
    return (uint16_t)((v >> 8) | (v << 8));
}

static inline uint16_t rgb565be(uint8_t r, uint8_t g, uint8_t b) {
    uint16_t v = (uint16_t)(((r >> 3) << 11) | ((g >> 2) << 5) | (b >> 3));
    return px_swap(v);
}

#define PX_WHITE 0xFFFF
#define PX_BLACK 0x0000

/* ---- band-local drawing --------------------------------------------------
 *
 * Both take a band buffer of PANEL_W * rows pixels. gfxb_fill covers the
 * whole thing in one call - the usual first line of any draw_band()
 * implementation, since a band buffer's prior content is undefined (app.h).
 * gfxb_fill_rect takes a rectangle in FULL-SCREEN (panel) coordinates,
 * exactly the space an app already thinks in for touch and layout, and
 * clips it to [band_y0, band_y0 + rows) itself - callers never do that
 * arithmetic by hand.
 */
void gfxb_fill(uint16_t *buf, int rows, uint16_t px);

void gfxb_fill_rect(uint16_t *buf, int band_y0, int rows,
                     int x, int y, int w, int h, uint16_t px);

#endif // GFX_BAND_H
