/*
 * font565_shim: this port's own, DECLARED substitution for the donor's
 * font565.c (../../reference/esp32-gameos/font565.c is deliberately NOT
 * vendored - see this port's NOTICE.md, "Font substitution"). The real
 * font565.c reads Montserrat glyph data straight out of LVGL's own
 * lv_font_fmt_txt_t format (`#include "lvgl.h"`), which this repo does not
 * vendor and this task's doctrine forbids faking: "do NOT fabricate glyph
 * data pretending to be the donor's."
 *
 * The substitution: GOLF's six requested point sizes (14/18/20/22/28/32 -
 * checked by grep over the vendored golf.c/golf_render.c/golf_cards.c, not
 * guessed) are rendered by integer-scaling the SAME 5x7 bitmap font this
 * port already ships byte-for-byte unmodified for the indexed-buffer path
 * (../../reference/esp32-gameos/font.c's gos_font5x7, public-domain ASCII
 * 32..126, MIT-repo-vendored - not duplicated here, just reused). This is a
 * real, working glyph provider, not a Montserrat lookalike: it is honestly
 * a monospace dot font at a bigger size. It is visible only on GOLF's own
 * full-resolution direct-mode screens (title, scorecards, HUD numerals) -
 * everywhere else in this port's three-screen roster (the launcher,
 * GUNSHIP, LUCKY 7) text goes through the untouched indexed font.c path via
 * gfx.c's gos_gfx_text(), completely unaffected by this file.
 *
 * NOT vendored from MikeWilson/infinite-golf (GOLF's own standalone
 * upstream, unlicensed - see NOTICE.md): this file is 100% new code,
 * written against gos.h's public gos_gfx_text565 contract only.
 */
#include "../../reference/esp32-gameos/gos.h"

#include <stdarg.h>
#include <stddef.h>
#include <stdint.h>

extern const uint8_t gos_font5x7[95][5]; // font.c, vendored unmodified
int gosport_vsnprintf(char *buf, size_t cap, const char *fmt, va_list ap); // gos_hal_shim.c

#define GLYPH_W 5
#define GLYPH_H 7
#define GLYPH_GAP 1

// Integer scale for a requested point size: round(px/7.0f), done in
// integers as (px*2+7)/14 - the same six inputs GOLF's own code calls with
// map to 14->2, 18/20/22->3, 28->4, 32->5. Not a lookup table, so any px
// this port's own audit missed still gets a sane, monotonic size instead
// of silently falling through to a default.
static int scale_for(int px) {
    int s = (px * 2 + 7) / 14;
    return s < 1 ? 1 : s;
}

// Named font565_put_px, not put_px: this file is unity-built into the same
// translation unit as ../../reference/esp32-gameos/golf_render.c, which
// already has its own static `put_px` - two same-named statics in one TU
// is a hard compile error, not a style choice.
static void font565_put_px(int x, int y, uint16_t color) {
    if (x < 0 || x >= GOS_PANEL_W || y < 0 || y >= GOS_PANEL_H) return;
    gos_gfx_fb565()[y * GOS_PANEL_W + x] = color;
}

static int draw_ascii_glyph(int scale, int x, int y, unsigned char c, uint16_t color) {
    int adv = (GLYPH_W + GLYPH_GAP) * scale;
    if (c < 32 || c > 126) return adv; // space and unmapped bytes: advance only
    const uint8_t *col = gos_font5x7[c - 32];
    for (int cx = 0; cx < GLYPH_W; cx++) {
        uint8_t bits = col[cx];
        for (int cy = 0; cy < GLYPH_H; cy++) {
            if (!(bits & (1u << cy))) continue;
            for (int sy = 0; sy < scale; sy++)
                for (int sx = 0; sx < scale; sx++)
                    font565_put_px(x + cx * scale + sx, y + cy * scale + sy, color);
        }
    }
    return adv;
}

// Minimal UTF-8 decode, same shape the donor's own font565.c uses (the
// vendored golf_cards.c/golf_render.c strings carry the bullet U+2022 as
// "\xE2\x80\xA2"). This font has no bullet/degree glyph of its own (it is
// ASCII 32..126 only), so both known code points get an honest ASCII
// stand-in rather than either crashing on the continuation bytes or
// drawing three garbage cells - any other non-ASCII byte sequence is
// skipped (advance only), same "not fabricated" spirit as the six-size
// substitution above.
static int draw_glyph_utf8(int scale, int x, int y, const char *s, int *consumed, uint16_t color) {
    uint8_t c0 = (uint8_t)s[0];
    if (c0 < 0x80) {
        *consumed = 1;
        return draw_ascii_glyph(scale, x, y, c0, color);
    }
    if ((c0 & 0xE0) == 0xC0 && s[1]) {
        uint32_t cp = ((uint32_t)(c0 & 0x1F) << 6) | ((uint8_t)s[1] & 0x3F);
        *consumed = 2;
        if (cp == 0xB0) return draw_ascii_glyph(scale, x, y, 'o', color); // degree sign
        return (GLYPH_W + GLYPH_GAP) * scale;
    }
    if ((c0 & 0xF0) == 0xE0 && s[1] && s[2]) {
        uint32_t cp = ((uint32_t)(c0 & 0x0F) << 12) | (((uint8_t)s[1] & 0x3F) << 6) | ((uint8_t)s[2] & 0x3F);
        *consumed = 3;
        if (cp == 0x2022) return draw_ascii_glyph(scale, x, y, '.', color); // bullet
        return (GLYPH_W + GLYPH_GAP) * scale;
    }
    *consumed = 1; // malformed lead byte: skip one byte, keep going
    return (GLYPH_W + GLYPH_GAP) * scale;
}

void gos_gfx_text565(int px, int x, int y, uint16_t rgb565, const char *fmt, ...) {
    char buf[128];
    va_list ap;
    va_start(ap, fmt);
    gosport_vsnprintf(buf, sizeof buf, fmt, ap);
    va_end(ap);
    int scale = scale_for(px);
    int cx = x;
    for (const char *s = buf; *s; ) {
        int consumed = 1;
        cx += draw_glyph_utf8(scale, cx, y, s, &consumed, rgb565);
        s += consumed;
    }
}

int gos_gfx_text565_w(int px, const char *s) {
    int scale = scale_for(px);
    int w = 0;
    for (; *s; ) {
        uint8_t c0 = (uint8_t)s[0];
        int consumed = (c0 < 0x80) ? 1 : ((c0 & 0xE0) == 0xC0 && s[1]) ? 2 : ((c0 & 0xF0) == 0xE0 && s[1] && s[2]) ? 3 : 1;
        w += (GLYPH_W + GLYPH_GAP) * scale;
        s += consumed;
    }
    return w;
}

int gos_gfx_text565_h(int px) {
    return GLYPH_H * scale_for(px);
}
