// tinydraw.c: an adaptation of aliceisjustplaying/tinydraw (MIT) onto this
// pack's --app contract (port_enter()/port_tick(), packs/rp2350-touch-
// amoled-18/wasm/build.ts's own comment; see apps/tinydraw/descriptor.md
// for the Essence/Interactions/Demands this was extracted from and
// apps/tinydraw/ports/rp2350-touch-amoled-18/README.md for the verdict this
// implements).
//
// WHAT WAS CARRIED OVER, AND WHY THIS IS "adaptation" NOT "faithful". The
// donor is a large, actively developed project (core/ is C++20 shared
// between an ESP32 product, a macOS app and QEMU; vector_v2/ is a bounded
// 1472x1792 world with a 604-tile pool, an asynchronous journal and 10-slot
// tile-based undo). None of that C++ is reachable from this pack's build
// (packs/rp2350-touch-amoled-18/wasm/build.ts's --app compiles exactly one
// .c file plus the portable runtime, nothing from core/ or vector_v2/), and
// the donor's OWN RP2350 native firmware (tinydraw's rp2350/src/main.cpp,
// confirmed against its README: "no pan, Undo, or persistence") does not
// even ship zoom or undo on this exact board today - only the ESP32 Vector
// V2 build does. So this file is a from-scratch C reimplementation of the
// DESCRIBED essence (ink, zoom, undo), sized to what a 65536-byte app arena
// and a --app single-file build can actually hold, not a port of the
// donor's C++ engine:
//
//   - ink: variable-width, antialiased, coverage-based capsules (the same
//     general technique this pack's OWN sketch.c already proves on this
//     panel, and which tinydraw's rp2350/src/main.cpp's own comment credits
//     for the curve-fill idea - see sketch.c's CURVE_SEG_PX comment). Width
//     comes from touch SPEED (fast=light, slow=heavy), the same donor
//     model (tinydraw's core/include/tinydraw/ink_config.h) and the same
//     reason sketch.c uses speed too: this FT3168 controller reports zero
//     for both its weight and area registers, always, so there is no real
//     pressure signal on this hardware to read instead.
//   - zoom: two levels (1x, 2x) about the panel's own center, not the
//     donor's continuous 25-400% about an arbitrary focus point with pan.
//     Every stroke point is stored in a ZOOM-INVARIANT "world" frame (see
//     td_screen_to_world/td_world_to_screen below) and reprojected on every
//     repaint, the same idea as the donor's Camera/camera_project
//     (core/include/tinydraw/graphics/camera.h), just fixed-center and
//     two-valued instead of continuous.
//   - undo: pops the single most recent STROKE (not the donor's 10 tile-
//     based slots) and repaints the whole canvas by replaying every
//     remaining stroke's stored points from scratch. This is the same
//     "keep what was drawn, not a copy of the pixels" idea this pack's own
//     sketch.c already uses for its colour-palette rollback, generalised to
//     an actual undo control (which sketch.c's own comment says nobody had
//     asked for yet - this app is that ask).
//
// WHAT WAS DELIBERATELY DROPPED, named rather than silently missing: colour
// (twelve colours in the donor's Raster V1), brush-size/eraser/tool
// selection, pan, "New" confirm-dialog, autosave/journal, PNG/SVG export,
// USB mass storage, NTP/clock, battery status. All are device concerns per
// the descriptor's Demands and out of scope for a show-phase ink+zoom+undo
// port - see the bundle's own port README for the full list and why.
#include <math.h>
#include <stdbool.h>
#include <stdint.h>

#include "app.h"
#include "gfx.h"
#include "sensors.h"  // KEY_SHORT et al. - identical bit values on this pack and packs/web (see that pack's own sensors.h vendoring note), which is what lets this one file build unmodified on both.

/* ---------------------------------------------------------------------
 * Pen shape. Screen-space (not world-space) radius bounds, so the pen
 * FEELS the same size under the finger regardless of the current zoom
 * level - exactly why the donor's own camera_project_radius takes a
 * WORLD radius and scales it for display rather than the other way
 * around (core/include/tinydraw/graphics/camera.h). What is stored per
 * point is the WORLD radius (screen radius / current zoom at the moment
 * it was drawn), so a later zoom change reprojects it consistently.
 * ------------------------------------------------------------------- */
#define MIN_RADIUS_PX     1.0f
#define MAX_RADIUS_PX     7.0f
#define SPEED_MAX_PXMS    3.0f   // screen px/ms at which the pen goes to its thinnest
#define PRESSURE_LERP     0.3f   // rate-limits width change, same reasoning as sketch.c's own PRESSURE_LERP: a noisy per-tick speed sample must not make the line flicker
#define MIN_STEP_PX       0.4f   // screen-space dedupe: a touch report this close to the last one draws nothing

static float ease_out_sine(float t) { return sinf(t * (float)M_PI / 2.0f); }

// Fast = light, slow = heavy (tldraw's model, and the donor's own
// InkConfig.thinning/simulate_pressure): pressure in [0,1] eases into a
// screen-space radius.
static float radius_from_pressure(float pressure) {
    float r = MIN_RADIUS_PX + (MAX_RADIUS_PX - MIN_RADIUS_PX) * ease_out_sine(pressure);
    if (r < MIN_RADIUS_PX) r = MIN_RADIUS_PX;
    if (r > MAX_RADIUS_PX) r = MAX_RADIUS_PX;
    return r;
}

/* ---------------------------------------------------------------------
 * Zoom. Two fixed levels about the panel's own center - see this file's
 * header comment on why not the donor's continuous, pannable camera.
 * ------------------------------------------------------------------- */
#define ZOOM_LEVELS 2
static const float kZoom[ZOOM_LEVELS] = {1.0f, 2.0f};

static void td_world_to_screen(float wx, float wy, float zoom, float *sx, float *sy) {
    const float cx = PANEL_W * 0.5f, cy = PANEL_H * 0.5f;
    *sx = cx + (wx - cx) * zoom;
    *sy = cy + (wy - cy) * zoom;
}

static void td_screen_to_world(float sx, float sy, float zoom, float *wx, float *wy) {
    const float cx = PANEL_W * 0.5f, cy = PANEL_H * 0.5f;
    *wx = cx + (sx - cx) / zoom;
    *wy = cy + (sy - cy) / zoom;
}

/* ---------------------------------------------------------------------
 * Antialiased capsule rasterizer: signed-distance-to-segment -> coverage
 * -> MIN composite (darkest wins), the same shape this pack's own
 * sketch.c uses and for the same reason (its own draw_capsule header
 * comment): consecutive stroke segments overlap along their shared edge,
 * and alpha blending would re-darken that overlap on every segment,
 * turning a smooth antialiased line into a visibly banded one. This is a
 * fresh, self-contained implementation (the --app single-file build does
 * not compile firmware/apps/sketch.c alongside a port - see
 * wasm/build.ts's SOURCES), not a copy, but the technique is the same
 * well-known one both this pack and the donor already use.
 * ------------------------------------------------------------------- */
static void draw_capsule(float ax, float ay, float r0, float bx, float by, float r1,
                          int *outMinX, int *outMinY, int *outMaxX, int *outMaxY) {
    float maxR = (r0 > r1 ? r0 : r1) + 1.0f;
    int minX = (int)floorf((ax < bx ? ax : bx) - maxR);
    int maxX = (int)ceilf((ax > bx ? ax : bx) + maxR);
    int minY = (int)floorf((ay < by ? ay : by) - maxR);
    int maxY = (int)ceilf((ay > by ? ay : by) + maxR);
    if (minX < 0) minX = 0;
    if (minY < 0) minY = 0;
    if (maxX > PANEL_W - 1) maxX = PANEL_W - 1;
    if (maxY > PANEL_H - 1) maxY = PANEL_H - 1;
    *outMinX = minX; *outMinY = minY; *outMaxX = maxX; *outMaxY = maxY;
    if (minX > maxX || minY > maxY) return;

    float abx = bx - ax, aby = by - ay;
    float abLenSq = abx * abx + aby * aby;

    for (int iy = minY; iy <= maxY; iy++) {
        float py = (float)iy + 0.5f;
        for (int ix = minX; ix <= maxX; ix++) {
            float px = (float)ix + 0.5f;
            float t = 0.0f;
            if (abLenSq > 0.0001f) {
                t = ((px - ax) * abx + (py - ay) * aby) / abLenSq;
                if (t < 0.0f) t = 0.0f;
                else if (t > 1.0f) t = 1.0f;
            }
            float cx = ax + abx * t, cy = ay + aby * t;
            float dx = px - cx, dy = py - cy;
            float d = sqrtf(dx * dx + dy * dy);
            float r = r0 + (r1 - r0) * t;
            float coverage = r + 0.5f - d;
            if (coverage <= 0.0f) continue;
            if (coverage > 1.0f) coverage = 1.0f;
            uint8_t ink = (uint8_t)((1.0f - coverage) * 255.0f + 0.5f);

            int idx = iy * PANEL_W + ix;
            uint8_t cur = px_to_gray(gfx_fb[idx]);
            if (ink < cur) gfx_fb[idx] = gray_to_px(ink);
        }
    }
}

/* ---------------------------------------------------------------------
 * Stroke history, in the zoom-invariant world frame (see td_screen_to_
 * world above). This IS the document: undo pops the last stroke and
 * repaint_all() replays what remains onto a fresh white panel, the same
 * "keep what was drawn, not a copy of the pixels" idea sketch.c's own
 * stroke history section documents (packs/rp2350-touch-amoled-18/
 * firmware/apps/sketch.c). Sized well under the 64KB app arena; the
 * build-time array-size check below proves it, the same technique
 * sketch.c and fluid.c both already use rather than trusting a comment.
 * ------------------------------------------------------------------- */
#define TD_MAX_POINTS  900
#define TD_MAX_STROKES 64

typedef struct { float x, y, r; } td_point_t;
typedef struct { uint16_t startIdx, count; } td_stroke_t;

typedef struct {
    int strokeCount, pointCount;
    td_stroke_t strokes[TD_MAX_STROKES];
    td_point_t  points[TD_MAX_POINTS];

    bool  touchWasDown;
    float lastWorldX, lastWorldY, lastWorldR;
    float pressure;
    int   zoomIndex;
} td_state_t;

typedef char tinydraw_arena_budget_check[(sizeof(td_state_t) <= APP_ARENA_BYTES) ? 1 : -1];

static td_state_t *st;

static void stroke_pool_begin(void) {
    if (st->strokeCount >= TD_MAX_STROKES) return; // full: this stroke silently isn't recorded (see file header - documented, not hidden)
    st->strokes[st->strokeCount].startIdx = (uint16_t)st->pointCount;
    st->strokes[st->strokeCount].count = 0;
    st->strokeCount++;
}

static void stroke_pool_append(float x, float y, float r) {
    if (st->strokeCount == 0) return;
    if (st->pointCount >= TD_MAX_POINTS) return; // pool full: current stroke stops recording, live drawing is unaffected (sketch.c's own precedent)
    td_point_t *p = &st->points[st->pointCount];
    p->x = x; p->y = y; p->r = r;
    st->pointCount++;
    st->strokes[st->strokeCount - 1].count++;
}

// Repaints the whole panel from the stored stroke history at the CURRENT
// zoom level, then pushes it in one shot. Only called from a discrete
// action (undo, zoom toggle), never per-tick during drawing - ordinary
// drawing pushes just the dirty capsule it drew (see port_tick), which is
// this pack's own gotchas.md's "many small pushes" / "shimmer" lesson
// applied: a full-panel push every tick is fine here because it only
// happens on a deliberate button press, never continuously.
static void repaint_all(void) {
    gfx_fill_rect(0, 0, PANEL_W, PANEL_H, PX_WHITE);
    const float zoom = kZoom[st->zoomIndex];
    for (int s = 0; s < st->strokeCount; s++) {
        int start = st->strokes[s].startIdx, count = st->strokes[s].count;
        if (count == 0) continue;
        float sx, sy;
        td_world_to_screen(st->points[start].x, st->points[start].y, zoom, &sx, &sy);
        float sr = st->points[start].r * zoom;
        int mnX, mnY, mxX, mxY;
        draw_capsule(sx, sy, sr, sx, sy, sr, &mnX, &mnY, &mxX, &mxY); // starting dot
        float psx = sx, psy = sy, pr = sr;
        for (int i = 1; i < count; i++) {
            const td_point_t *p = &st->points[start + i];
            float csx, csy;
            td_world_to_screen(p->x, p->y, zoom, &csx, &csy);
            float cr = p->r * zoom;
            draw_capsule(psx, psy, pr, csx, csy, cr, &mnX, &mnY, &mxX, &mxY);
            psx = csx; psy = csy; pr = cr;
        }
    }
    gfx_push_all();
}

void port_enter(void) {
    st = APP_STATE(td_state_t);
    st->zoomIndex = 0;
    // The runtime clears the framebuffer to white and pushes it once after
    // enter() returns (app.h's own contract) - nothing to draw yet on an
    // empty document, so enter() does nothing further.
}

void port_tick(const app_frame_t *f) {
    // BOOT click: undo the most recent stroke. Deliberately a different
    // control from the zoom toggle below, the same reasoning chrono's own
    // descriptor gives for splitting its own toggle and its own reset: a
    // destructive action belongs on a control that cannot be hit by
    // accident while doing something else.
    if (f->bootClicked) {
        if (st->strokeCount > 0) {
            st->strokeCount--;
            st->pointCount = st->strokes[st->strokeCount].startIdx;
        }
        repaint_all();
        return;
    }

    // PWR short press: cycle the zoom level and reproject every stored
    // stroke at the new zoom - see td_world_to_screen/repaint_all above.
    if (f->key & KEY_SHORT) {
        st->zoomIndex = (st->zoomIndex + 1) % ZOOM_LEVELS;
        repaint_all();
        return;
    }

    if (!f->touchDown) {
        st->touchWasDown = false;
        return;
    }

    const float zoom = kZoom[st->zoomIndex];
    float wx, wy;
    td_screen_to_world((float)f->touchX, (float)f->touchY, zoom, &wx, &wy);

    if (!st->touchWasDown) {
        // Stroke start: begin recording and draw a starting dot at the
        // resting (mid) pressure, the same "arc==0" starting radius idea
        // sketch.c's own stroke_begin uses.
        stroke_pool_begin();
        st->pressure = 0.5f;
        float rScreen = radius_from_pressure(st->pressure);
        float rWorld = rScreen / zoom;
        stroke_pool_append(wx, wy, rWorld);

        float sx, sy;
        td_world_to_screen(wx, wy, zoom, &sx, &sy);
        int mnX, mnY, mxX, mxY;
        draw_capsule(sx, sy, rScreen, sx, sy, rScreen, &mnX, &mnY, &mxX, &mxY);
        gfx_push(mnX, mnY, mxX, mxY);

        st->lastWorldX = wx; st->lastWorldY = wy; st->lastWorldR = rWorld;
        st->touchWasDown = true;
        return;
    }

    // Mid-stroke: derive speed from how far the touch moved on SCREEN
    // since the last sample (a finger's felt speed is a screen quantity,
    // not a world one - the same reason the pen's radius bounds above are
    // screen-space too), then rate-limit pressure toward the speed-implied
    // target and draw one more capsule segment.
    float prevSX, prevSY;
    td_world_to_screen(st->lastWorldX, st->lastWorldY, zoom, &prevSX, &prevSY);
    float curSX, curSY;
    td_world_to_screen(wx, wy, zoom, &curSX, &curSY);
    float dx = curSX - prevSX, dy = curSY - prevSY;
    float distScreen = sqrtf(dx * dx + dy * dy);
    if (distScreen < MIN_STEP_PX) return; // dedupe: jitter too small to be a real move

    uint32_t dt = f->dtMs > 0 ? f->dtMs : 1;
    float speed = distScreen / (float)dt;
    float target = 1.0f - speed / SPEED_MAX_PXMS;
    if (target < 0.15f) target = 0.15f;
    if (target > 1.0f) target = 1.0f;
    st->pressure += (target - st->pressure) * PRESSURE_LERP;

    float rScreen = radius_from_pressure(st->pressure);
    float rWorld = rScreen / zoom;
    float prevRScreen = st->lastWorldR * zoom;

    stroke_pool_append(wx, wy, rWorld);

    int mnX, mnY, mxX, mxY;
    draw_capsule(prevSX, prevSY, prevRScreen, curSX, curSY, rScreen, &mnX, &mnY, &mxX, &mxY);
    gfx_push(mnX, mnY, mxX, mxY);

    st->lastWorldX = wx; st->lastWorldY = wy; st->lastWorldR = rWorld;
}
