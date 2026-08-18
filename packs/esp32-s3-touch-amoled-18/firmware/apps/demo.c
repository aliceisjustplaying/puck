/*
 * demo: the one reference app this pack ships, proving app.h's band
 * contract with the smallest thing that can bounce, pause, reset and drag.
 *
 * White panel, a 60px filled black square bouncing off the four edges.
 * PWR short press pauses/resumes the bounce. BOOT click resets the square
 * to the centre with its default velocity. While a finger is on the glass,
 * the square follows it directly instead of bouncing.
 *
 * Written band-style throughout: tick() only ever updates state.square_x/y,
 * never touches a pixel. draw_band() is called 16 times a frame (once per
 * band, app.h) and, each time, fills its band white and then asks
 * gfxb_fill_rect() to draw whatever part of the square (if any) falls
 * inside that band's rows - the same square rectangle, computed once in
 * tick(), gets clipped differently by every one of the 16 calls.
 */
#include "app.h"
#include "gfx_band.h"

#define SQUARE_SIZE 60

// px/s. Chosen to cross the panel in a couple of seconds, not so fast the
// bounce looks like a glitch at 16 bands * a few hundred Hz of tick rate.
#define DEFAULT_VX 140
#define DEFAULT_VY 110

typedef struct {
    int squareX, squareY; // top-left, full-screen coordinates
    int vx, vy;            // px/s
    bool paused;
} demo_state_t;

static demo_state_t *s;

static void reset_position(void) {
    s->squareX = (PANEL_W - SQUARE_SIZE) / 2;
    s->squareY = (PANEL_H - SQUARE_SIZE) / 2;
    s->vx = DEFAULT_VX;
    s->vy = DEFAULT_VY;
}

static void demo_enter(void) {
    s = APP_STATE(demo_state_t);
    reset_position();
}

static void demo_tick(const app_frame_t *f) {
    if (f->key & KEY_SHORT) {
        s->paused = !s->paused;
    }
    if (f->bootClicked) {
        reset_position();
        s->paused = false;
    }

    if (f->touchDown) {
        // Follow the finger directly; the centre tracks the touch point.
        s->squareX = f->touchX - SQUARE_SIZE / 2;
        s->squareY = f->touchY - SQUARE_SIZE / 2;
        if (s->squareX < 0) s->squareX = 0;
        if (s->squareY < 0) s->squareY = 0;
        if (s->squareX > PANEL_W - SQUARE_SIZE) s->squareX = PANEL_W - SQUARE_SIZE;
        if (s->squareY > PANEL_H - SQUARE_SIZE) s->squareY = PANEL_H - SQUARE_SIZE;
        return;
    }

    if (s->paused) return;

    // dtMs is clamped upstream (runtime_core.c), so a stall never produces a
    // jump large enough to tunnel through an edge.
    int dx = (s->vx * (int)f->dtMs) / 1000;
    int dy = (s->vy * (int)f->dtMs) / 1000;
    s->squareX += dx;
    s->squareY += dy;

    if (s->squareX < 0) { s->squareX = 0; s->vx = -s->vx; }
    if (s->squareY < 0) { s->squareY = 0; s->vy = -s->vy; }
    if (s->squareX > PANEL_W - SQUARE_SIZE) { s->squareX = PANEL_W - SQUARE_SIZE; s->vx = -s->vx; }
    if (s->squareY > PANEL_H - SQUARE_SIZE) { s->squareY = PANEL_H - SQUARE_SIZE; s->vy = -s->vy; }
}

static void demo_draw_band(int band, uint16_t *buf, int y0, int rows) {
    (void)band;
    gfxb_fill(buf, rows, PX_WHITE);
    gfxb_fill_rect(buf, y0, rows, s->squareX, s->squareY, SQUARE_SIZE, SQUARE_SIZE, PX_BLACK);
}

const app_t g_demoApp = {
    .name = "demo",
    .enter = demo_enter,
    .tick = demo_tick,
    .draw_band = demo_draw_band,
    .leave = NULL,
};
