#include "gfx_band.h"

void gfxb_fill(uint16_t *buf, int rows, uint16_t px) {
    int n = PANEL_W * rows;
    for (int i = 0; i < n; i++) buf[i] = px;
}

void gfxb_fill_rect(uint16_t *buf, int band_y0, int rows,
                     int x, int y, int w, int h, uint16_t px) {
    // Clip the full-screen rectangle to the panel first, same as any
    // rect-fill would, then clip what remains to this band's row range.
    if (x < 0) { w += x; x = 0; }
    if (y < 0) { h += y; y = 0; }
    if (x + w > PANEL_W) w = PANEL_W - x;
    if (y + h > PANEL_H) h = PANEL_H - y;
    if (w <= 0 || h <= 0) return;

    int bandLo = band_y0;
    int bandHi = band_y0 + rows; // exclusive
    int rowLo = y > bandLo ? y : bandLo;
    int rowHi = (y + h) < bandHi ? (y + h) : bandHi;
    if (rowLo >= rowHi) return; // rectangle does not touch this band at all

    for (int row = rowLo; row < rowHi; row++) {
        uint16_t *line = &buf[(row - band_y0) * PANEL_W + x];
        for (int col = 0; col < w; col++) line[col] = px;
    }
}
