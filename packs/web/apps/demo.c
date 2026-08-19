// demo: this pack's one reference app, the thing `bun run pack:web:build`
// with no --app produces.
//
// Its whole job is to prove the contract end to end with nothing borrowed
// from another pack: enter() draws into a framebuffer the runtime just
// cleared, tick() gets a real app_frame_t, a PWR short press and a BOOT
// click both arrive, a finger drag lands in panel coordinates, and only
// the rectangles it dirtied are pushed. If this app runs, host/host.ts and
// wasm/emu_shim.c are wired correctly; if the ported apps then misbehave,
// the fault is in the port, not in the pack.
//
// Deliberately NOT a port of anything. apps/chrono and apps/fluidbox are
// where ported apps live (docs/convention/app-bundle.md); a device pack's
// own reference app exists to prove the pack.
#include <stdbool.h>
#include <stdint.h>

#include "app.h"
#include "gfx.h"
#include "sensors.h"

#define BOX 56
#define SPEED_PX_PER_S 140

typedef struct {
    // Position in tenths of a pixel, so a 140px/s drift at 60fps does not
    // vanish into integer truncation every frame.
    int32_t x10, y10;
    int32_t vx10, vy10;
    bool    running;
    int     lastX, lastY; // where the box was drawn last, to erase exactly that
} demo_state_t;

static demo_state_t *s;

static void reset_position(void) {
    s->x10 = (int32_t)((PANEL_W - BOX) / 2) * 10;
    s->y10 = (int32_t)((PANEL_H - BOX) / 2) * 10;
    s->vx10 = SPEED_PX_PER_S * 10 / 10; // per 100ms, see tick()
    s->vy10 = SPEED_PX_PER_S * 10 / 10;
}

static void draw_box(int x, int y) {
    gfx_fill_rect(x, y, BOX, BOX, PX_BLACK);
}

static void demo_enter(void) {
    s = APP_STATE(demo_state_t);
    s->running = true;
    reset_position();
    s->lastX = s->x10 / 10;
    s->lastY = s->y10 / 10;
    draw_box(s->lastX, s->lastY);
    // No push: the runtime pushes the whole panel once after enter()
    // returns (app.h).
}

static void demo_tick(const app_frame_t *f) {
    if (f->key & KEY_SHORT) s->running = !s->running;
    if (f->bootClicked) {
        reset_position();
        s->running = true;
    }

    if (f->touchDown) {
        // A finger takes the box outright, centred under the contact
        // point: the simplest possible proof that touch coordinates
        // arrive in panel space and are already clamped.
        s->x10 = (int32_t)(f->touchX - BOX / 2) * 10;
        s->y10 = (int32_t)(f->touchY - BOX / 2) * 10;
    } else if (s->running) {
        const int32_t dt = (int32_t)f->dtMs;
        s->x10 += s->vx10 * dt / 100;
        s->y10 += s->vy10 * dt / 100;
        if (s->x10 < 0) { s->x10 = 0; s->vx10 = -s->vx10; }
        if (s->y10 < 0) { s->y10 = 0; s->vy10 = -s->vy10; }
        const int32_t maxX10 = (int32_t)(PANEL_W - BOX) * 10;
        const int32_t maxY10 = (int32_t)(PANEL_H - BOX) * 10;
        if (s->x10 > maxX10) { s->x10 = maxX10; s->vx10 = -s->vx10; }
        if (s->y10 > maxY10) { s->y10 = maxY10; s->vy10 = -s->vy10; }
    }

    const int nx = s->x10 / 10, ny = s->y10 / 10;
    if (nx == s->lastX && ny == s->lastY) return;

    // Erase where it was, draw where it is, push the union of the two
    // rectangles once: fewer, larger pushes beat two small ones, and the
    // union is still a small fraction of the panel.
    gfx_fill_rect(s->lastX, s->lastY, BOX, BOX, PX_WHITE);
    draw_box(nx, ny);

    int minX = nx < s->lastX ? nx : s->lastX;
    int minY = ny < s->lastY ? ny : s->lastY;
    int maxX = (nx > s->lastX ? nx : s->lastX) + BOX - 1;
    int maxY = (ny > s->lastY ? ny : s->lastY) + BOX - 1;
    gfx_push(minX, minY, maxX, maxY);

    s->lastX = nx;
    s->lastY = ny;
}

// Portrait, and no shake: a reference app should opt into as little as
// possible, so what it proves is the baseline every port starts from.
const app_t g_webApp = {
    .name       = "demo",
    .enter      = demo_enter,
    .tick       = demo_tick,
    .leave      = NULL,
    .landscape  = false,
    .wantsShake = false,
};
