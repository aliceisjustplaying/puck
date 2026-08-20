/*
 * fluid.c: fluidbox on the esp32-s3-touch-amoled-18 pack's BAND contract.
 *
 * The solver is the one apps/fluidbox/ports/rp2350-touch-amoled-18/fluid.c
 * already carries (itself a 2D adaptation of the donor's Clavet double-
 * density-relaxation solver, apps/fluidbox/reference/esp32-fluidbox/sim.c):
 * same 130 particles, same O(n^2) neighbour search, same constants, same
 * fixed RNG seed, same substep order. Nothing about the physics changed and
 * nothing about it should have: what changed is where the pixels go. See
 * README.md (this directory) for the verdict this implements (go, mode
 * adaptation, verified by invariants) and for the donor-comparison.
 *
 * THE BAND DIFFERENCE. The rp2350 sibling owns a persistent 368x448
 * framebuffer: its port_tick() clears it, draws every particle into it, and
 * pushes the whole panel. This pack has no framebuffer anywhere (app.h, the
 * pack's AGENTS.md): tick() updates state only, then draw_band() is called
 * once for EVERY one of the 16 bands with a 28-row buffer whose prior
 * content is UNDEFINED, and must write every pixel of it. So the split here
 * is:
 *
 *   tick()       runs the solver (shake impulse, touch stir, substep) and
 *                nothing else, then refreshes one colour per particle so
 *                the 16 draw_band() calls that follow do not each recompute
 *                130 square roots for the same unchanged velocities.
 *   draw_band()  repaints the band's background, then offers all 130
 *                particles to gfxb_fill_rect(), which clips each 7x7 square
 *                to this band's rows. 130 clip checks per band, 2080 a
 *                frame, is nothing next to the ~285,000 floating-point
 *                operations the solver itself already does per step, so
 *                there is no per-band particle bucketing here: it would be
 *                a data structure earning less than it costs.
 *
 * GRAVITY IS FIXED DOWN, and this file is SIMPLER for it. The rp2350 and
 * web ports both read f->tilt (app_frame_t.tilt, app.h) every tick, because
 * those two packs declare a {"id":"tilt","kind":"vector"} sensor and wire a
 * real gravity direction into that field (the rp2350 pack's own QMI8658
 * through firmware/runtime/tilt.c, or the same field fed from a browser's
 * motion path). This pack's app.h declares no such field at all
 * (packs/esp32-s3-touch-amoled-18/firmware/runtime/app.h's app_frame_t) and
 * its device.json declares exactly one sensor, {"id":"shake","kind":"event"}
 * - there is no tilt signal to read, in the emulator or on the board, so
 * reading one here would not compile, let alone mean anything. Gravity is
 * simply the constant (0, +1) this port's whole invariant trace already
 * runs under on the other two packs when their own tilt reading is near
 * zero (that trace contains no vector event at all), so this is not a
 * missing feature so much as the one fixed state the other ports already
 * fall back to. The interaction surface this port DOES have is the same
 * one the rp2350 port has: gravity down, shake, and a touch stir the
 * donor's own firmware never implemented.
 *
 * MATH, and why there are four bare externs below instead of an #include.
 * This pack ships no shim/ directory (see wasm/build.ts's header comment):
 * its sources include nothing beyond app.h, gfx_band.h, runtime_core.h and
 * emu_abi.h, and zig's wasm32-freestanding target has no <math.h> to
 * include. The four functions declared below are all on wasm/emu_abi.h's
 * own documented host-import list, so -Wl,--import-symbols turns them into
 * exactly the env.sqrtf / env.sinf / env.cosf / env.floorf imports
 * src/wasm.ts already supplies to every module in this repository. No new
 * ABI surface, no second hand-rolled sqrt to diverge from the board's.
 */
#include "app.h"
#include "gfx_band.h"

// See this file's header comment, MATH. Declared, never defined here:
// undefined externs become wasm imports the host fills in, and on a real
// ESP-IDF build they would resolve to newlib's own.
extern float sqrtf(float x);
extern float sinf(float x);
extern float cosf(float x);
extern float floorf(float x);

// Composed from floorf() alone, exactly as the rp2350 pack's own
// wasm/shim/math.h composes it (and bit-identically so): ceilf is not on
// emu_abi.h's import list, and an exact, non-transcendental operation that
// falls out of an import already present is the one case that file names as
// safe to define locally rather than invent a fifth undocumented import.
static inline float ceil_f(float x) {
    return -floorf(-x);
}

/* ===========================================================================
 * Particle count: 130, the bundle's own established adaptation.
 *
 * Donor (esp32-fluidbox, 3D, this exact ESP32-S3 board, 240MHz dual-core
 * with hardware FPU): 900 particles, uniform grid, measured 33-41 steps/s
 * with the solver on one core and rendering on the other. This port is the
 * bundle's 2D adaptation at FLUID_N=130 and runs solver AND render in the
 * same single-core loop (main/main.c is one task), which is affordable by a
 * wide margin: the web port measured this same solver at 0.186ms/tick for
 * 130 particles and 2.653ms/tick at the donor's own 900 (see
 * apps/fluidbox/ports/web/README.md's table). FLUID_N is NOT re-tuned here,
 * on purpose: apps/fluidbox/invariants.ts's thresholds are calibrated
 * against a 130-particle build, and passing a threshold calibrated for a
 * different build is not the same as being checked.
 * ======================================================================= */
#define FLUID_N 130

/* ===========================================================================
 * Every constant below is the rp2350 port's, unchanged. They are physical
 * or panel properties (this is the same 368x448 ~322ppi AMOLED panel, in
 * the same enclosure family), so re-deriving them for this pack would mean
 * changing the fluid, not porting it. See that port's README for where each
 * came from and which are the donor's own.
 * ======================================================================= */
#define WALL_MARGIN       5.0f
#define PX_PER_MM         12.7f
#define BOX_CORNER_MM     4.5f
#define BOX_CORNER_R      (BOX_CORNER_MM * PX_PER_MM)  // ~57px, donor's own value

#define REST_SPACING      17.0f
#define SMOOTH_RADIUS     28.0f

#define TIME_SCALE        0.100f
#define SIM_DT_MAX        0.0022f

// Donor's real, unscaled gravity (9.81 * gain, in px/s^2 via this panel's
// own px-per-metre). TIME_SCALE reaches it through the scaled dt that
// multiplies it in integrate_velocities(), the donor's own mechanism.
#define PX_PER_METER      12677.0f
#define GRAVITY_MPS2      9.81f
#define GRAVITY_GAIN      2.2f
#define GRAVITY_PXS2      (GRAVITY_MPS2 * GRAVITY_GAIN * PX_PER_METER)

#define K_PRESSURE        400000.0f
#define K_NEAR_PRESSURE   800000.0f
#define MAX_DISPLACEMENT  4.0f
#define WALL_JITTER       0.35f
#define VISC_SIGMA        45.0f
#define VISC_BETA         0.03f
#define WALL_RESTITUTION  0.25f
#define WALL_FRICTION     0.96f

// Shake: a one-shot impulse in a random direction per particle, since this
// pack's ABI hands the app a discrete event (app_frame_t.shaken), not a
// continuous acceleration signal. This pack delivers shaken unconditionally
// (runtime_core.c: no wants_shake gate, one app and no drawing surface to
// protect), so unlike the rp2350 port there is no --shake build flag to
// pass and no bundle.json buildArgs entry for it.
#define SHAKE_IMPULSE_PXS 700.0f

// Touch: this pack has a digitizer the donor's firmware never read
// (descriptor.md's Interactions). A finger drag within TOUCH_STIR_RADIUS
// nudges nearby particles by the drag's own per-frame delta, falling off
// linearly, so dragging stirs rather than gusts.
#define TOUCH_STIR_RADIUS 70.0f
#define TOUCH_STIR_GAIN   9.0f

#define PARTICLE_HALF     3  // drawn as a (2*PARTICLE_HALF+1)-pixel square

// Speed thresholds for the flat 3-tier colour ramp (see color_for_speed()).
#define SPEED_CALM_MAX    260.0f
#define SPEED_FAST_MAX    900.0f

#define FLUID_BG          PX_BLACK

/* ===========================================================================
 * State, from the arena (app.h). APP_ARENA_BYTES is 8192 on this pack (the
 * rp2350 sibling's is 65536), so the budget is worth counting rather than
 * assuming: 12 float[130] arrays is 6,240 bytes, the colour cache below
 * adds 130 uint16_t (260), and the scalars add ~20, for roughly 6,520 of
 * 8,192. It fits with room, and it is the colour cache that makes this
 * worth stating at all - see this file's header comment for why that cache
 * exists.
 * ======================================================================= */
typedef struct {
    float x[FLUID_N], y[FLUID_N];
    float vx[FLUID_N], vy[FLUID_N];
    float oldx[FLUID_N], oldy[FLUID_N];
    float density[FLUID_N], densityNear[FLUID_N];
    float press[FLUID_N], pressNear[FLUID_N];
    float viscDx[FLUID_N], viscDy[FLUID_N];

    // One panel-format colour per particle, refreshed once per tick from
    // that particle's post-substep speed and then read unchanged by all 16
    // draw_band() calls of that frame.
    uint16_t color[FLUID_N];

    float restDensity;
    uint32_t rng;

    bool touchWasDown;
    int  touchLastX, touchLastY;
} fluid_state_t;

static fluid_state_t *s;

/* ---- deterministic RNG ---------------------------------------------------
 * Donor's own xorshift32, fixed seed. Replay determinism (the invariant
 * runner replaying the same trace twice must produce the same frames)
 * depends on this being a pure function of the seed and the call sequence.
 * ------------------------------------------------------------------- */
static inline float rand_unit(void) {
    s->rng ^= s->rng << 13;
    s->rng ^= s->rng >> 17;
    s->rng ^= s->rng << 5;
    return (float)(s->rng & 0xFFFFFFu) * (1.0f / 16777215.0f);
}

// Sums the density kernel over a 2D lattice at REST_SPACING, the same
// method sim.c's calibrate_rest_density() uses over a 3D one, so
// restDensity stays self-consistent with REST_SPACING/SMOOTH_RADIUS rather
// than being a magic number carried over from a 3D result.
static void calibrate_rest_density(void) {
    const float h = SMOOTH_RADIUS;
    const int reach = (int)ceil_f(h / REST_SPACING);
    float rho = 0.0f;
    for (int i = -reach; i <= reach; i++) {
        for (int j = -reach; j <= reach; j++) {
            if (i == 0 && j == 0) continue;
            const float d = REST_SPACING * sqrtf((float)(i * i + j * j));
            if (d >= h) continue;
            const float q = 1.0f - d / h;
            rho += q * q;
        }
    }
    s->restDensity = rho;
}

// Re-seeds the fluid as a settled block resting on the bottom of the panel,
// on a lattice at rest spacing so the solver starts already close to
// relaxed - same idea as sim.c's sim_reset(), one axis fewer.
static void seed_block(void) {
    const float spacing = REST_SPACING;
    int nx = (int)((PANEL_W - 2.0f * WALL_MARGIN) / spacing);
    if (nx < 1) nx = 1;
    const float x0 = 0.5f * (PANEL_W - (float)(nx - 1) * spacing);

    for (int i = 0; i < FLUID_N; i++) {
        const int row = i / nx;
        const int col = i % nx;
        const float y = PANEL_H - WALL_MARGIN - spacing * 0.5f - (float)row * spacing;

        s->x[i] = x0 + (float)col * spacing + (rand_unit() - 0.5f) * spacing * 0.2f;
        s->y[i] = y + (rand_unit() - 0.5f) * spacing * 0.2f;
        s->vx[i] = 0.0f;
        s->vy[i] = 0.0f;
        s->oldx[i] = s->x[i];
        s->oldy[i] = s->y[i];
    }
}

// Gravity is the constant (0, +1) direction on this pack - see this file's
// header comment. Kept as its own function anyway, so the one place a
// direction enters the solver stays named.
static void integrate_velocities(float dt) {
    const float ay = GRAVITY_PXS2 * dt;
    for (int i = 0; i < FLUID_N; i++) {
        s->vy[i] += ay;
    }
}

// Densities and viscosity in one O(n^2) pass, fused for the same reason
// sim.c's compute_densities_and_viscosity() fuses them: same pairs, same
// sqrt. Viscosity is applied as a position offset, not a velocity change,
// because velocity is recovered from displacement at the end of the substep.
static void compute_density_and_viscosity(float dt) {
    const float h2 = SMOOTH_RADIUS * SMOOTH_RADIUS;
    const float invH = 1.0f / SMOOTH_RADIUS;

    for (int i = 0; i < FLUID_N; i++) {
        s->density[i] = 0.0f;
        s->densityNear[i] = 0.0f;
        s->viscDx[i] = 0.0f;
        s->viscDy[i] = 0.0f;
    }

    for (int i = 0; i < FLUID_N; i++) {
        const float xi = s->x[i], yi = s->y[i];
        const float vxi = s->vx[i], vyi = s->vy[i];

        for (int j = i + 1; j < FLUID_N; j++) {
            const float dx = s->x[j] - xi;
            const float dy = s->y[j] - yi;
            const float r2 = dx * dx + dy * dy;
            if (r2 >= h2 || r2 < 1e-6f) continue;

            const float r = sqrtf(r2);
            const float invR = 1.0f / r;
            const float q = 1.0f - r * invH;
            const float q2 = q * q;

            s->density[i] += q2;
            s->density[j] += q2;
            s->densityNear[i] += q2 * q;
            s->densityNear[j] += q2 * q;

            const float ux = dx * invR, uy = dy * invR;
            const float u = (vxi - s->vx[j]) * ux + (vyi - s->vy[j]) * uy;
            if (u <= 0.0f) continue; // only damp approach, never pull apart

            float dv = 0.5f * dt * q * (VISC_SIGMA * u + VISC_BETA * u * u);
            if (dv > 0.5f * u) dv = 0.5f * u;
            const float imp = dv * dt;

            s->viscDx[i] -= imp * ux;
            s->viscDy[i] -= imp * uy;
            s->viscDx[j] += imp * ux;
            s->viscDy[j] += imp * uy;
        }
    }

    for (int i = 0; i < FLUID_N; i++) {
        s->x[i] += s->viscDx[i];
        s->y[i] += s->viscDy[i];
    }
}

// Double density relaxation: pushes are applied immediately (Gauss-Seidel),
// same as sim.c's relax_positions() - later pairs in the same pass see
// already-corrected positions, which converges faster in dense regions.
static void relax_positions(float dt) {
    const float h2 = SMOOTH_RADIUS * SMOOTH_RADIUS;
    const float invH = 1.0f / SMOOTH_RADIUS;
    const float dt2 = dt * dt;

    for (int i = 0; i < FLUID_N; i++) {
        s->press[i] = K_PRESSURE * (s->density[i] - s->restDensity);
        s->pressNear[i] = K_NEAR_PRESSURE * s->densityNear[i];
    }

    for (int i = 0; i < FLUID_N; i++) {
        const float xi = s->x[i], yi = s->y[i];
        const float pi = s->press[i], pni = s->pressNear[i];
        float mx = 0.0f, my = 0.0f;

        for (int j = i + 1; j < FLUID_N; j++) {
            const float dx = s->x[j] - xi;
            const float dy = s->y[j] - yi;
            const float r2 = dx * dx + dy * dy;
            if (r2 >= h2 || r2 < 1e-6f) continue;

            const float r = sqrtf(r2);
            const float invR = 1.0f / r;
            const float q = 1.0f - r * invH;
            const float q2 = q * q;

            const float pj = s->press[j], pnj = s->pressNear[j];
            float d = 0.5f * dt2 * ((pi + pj) * q + (pni + pnj) * q2);
            if (d > MAX_DISPLACEMENT) d = MAX_DISPLACEMENT;
            else if (d < -MAX_DISPLACEMENT) d = -MAX_DISPLACEMENT;

            const float sx = dx * invR * d;
            const float sy = dy * invR * d;
            s->x[j] += sx;
            s->y[j] += sy;
            mx -= sx;
            my -= sy;
        }

        s->x[i] += mx;
        s->y[i] += my;
    }
}

// The panel's rounded-rectangle interior, one stage: clamp to the inner
// rectangle joining the four corner-arc centres, and whatever offset
// remains points straight out from the nearest part of the outline (sim.c's
// resolve_walls() first stage; this port drops only the second, depth-
// fillet stage, since there is no depth axis to curve into).
static void resolve_walls(void) {
    const float loX = BOX_CORNER_R, hiX = PANEL_W - BOX_CORNER_R;
    const float loY = BOX_CORNER_R, hiY = PANEL_H - BOX_CORNER_R;
    const float sideR = BOX_CORNER_R - WALL_MARGIN;

    for (int i = 0; i < FLUID_N; i++) {
        const float x = s->x[i], y = s->y[i];
        const float ax = x < loX ? loX : (x > hiX ? hiX : x);
        const float ay = y < loY ? loY : (y > hiY ? hiY : y);
        float ux = x - ax, uy = y - ay;
        const float r = sqrtf(ux * ux + uy * uy);
        if (r <= sideR) continue; // inside the wall, nothing to resolve

        if (r > 1e-6f) { ux /= r; uy /= r; } else { ux = 0.0f; uy = 0.0f; }

        // Land a random fraction of a pixel inside the surface, not exactly
        // on it, so a corner cannot stack particles onto one point (same
        // reasoning as sim.c's WALL_JITTER).
        const float land = sideR - WALL_JITTER * rand_unit();
        s->x[i] = ax + ux * land;
        s->y[i] = ay + uy * land;

        const float vn = s->vx[i] * ux + s->vy[i] * uy;
        if (vn > 0.0f) {
            const float k = (1.0f + WALL_RESTITUTION) * vn;
            s->vx[i] -= k * ux;
            s->vy[i] -= k * uy;
        }

        // Damp the whole velocity, then restore the normal component, so
        // friction acts only tangentially and never fights the restitution
        // just applied.
        const float keep = s->vx[i] * ux + s->vy[i] * uy;
        const float restore = keep * (1.0f - WALL_FRICTION);
        s->vx[i] = s->vx[i] * WALL_FRICTION + restore * ux;
        s->vy[i] = s->vy[i] * WALL_FRICTION + restore * uy;
    }
}

static void substep(float dt) {
    integrate_velocities(dt);

    for (int i = 0; i < FLUID_N; i++) {
        s->oldx[i] = s->x[i];
        s->oldy[i] = s->y[i];
        s->x[i] += s->vx[i] * dt;
        s->y[i] += s->vy[i] * dt;
    }

    compute_density_and_viscosity(dt);
    relax_positions(dt);

    const float invDt = 1.0f / dt;
    for (int i = 0; i < FLUID_N; i++) {
        s->vx[i] = (s->x[i] - s->oldx[i]) * invDt;
        s->vy[i] = (s->y[i] - s->oldy[i]) * invDt;
    }

    resolve_walls();
}

// One shake event: an impulse in a random direction per particle, rather
// than a burst read from an accelerometer this ABI does not expose
// continuously. See SHAKE_IMPULSE_PXS's comment.
static void apply_shake(void) {
    for (int i = 0; i < FLUID_N; i++) {
        const float angle = rand_unit() * 6.28318530718f;
        const float mag = SHAKE_IMPULSE_PXS * (0.5f + rand_unit());
        s->vx[i] += cosf(angle) * mag;
        s->vy[i] += sinf(angle) * mag;
    }
}

// A finger drag stirs nearby particles by the drag's own per-frame motion,
// falling off linearly with distance from the contact point. Only the
// SECOND and later frames of a drag carry a delta (the first frame after
// touchPressed just records a starting point).
static void handle_touch(const app_frame_t *f) {
    if (!f->touchDown) {
        s->touchWasDown = false;
        return;
    }
    if (!s->touchWasDown) {
        s->touchWasDown = true;
        s->touchLastX = f->touchX;
        s->touchLastY = f->touchY;
        return;
    }

    const float dx = (float)(f->touchX - s->touchLastX);
    const float dy = (float)(f->touchY - s->touchLastY);
    s->touchLastX = f->touchX;
    s->touchLastY = f->touchY;

    if (dx * dx + dy * dy < 0.01f) return; // no meaningful movement this frame

    const float r2 = TOUCH_STIR_RADIUS * TOUCH_STIR_RADIUS;
    for (int i = 0; i < FLUID_N; i++) {
        const float px = s->x[i] - (float)f->touchX;
        const float py = s->y[i] - (float)f->touchY;
        const float d2 = px * px + py * py;
        if (d2 >= r2) continue;
        const float falloff = 1.0f - sqrtf(d2) / TOUCH_STIR_RADIUS;
        s->vx[i] += dx * TOUCH_STIR_GAIN * falloff;
        s->vy[i] += dy * TOUCH_STIR_GAIN * falloff;
    }
}

// Flat 3-tier ramp: calm blue, brighter blue, white for a hard shake. Same
// three colours the rp2350 port produces - rgb565be() (gfx_band.h) is the
// byte-swapping form of that port's own rgb565() + px_swap() pair, so the
// pixel values are identical, expressed through this pack's own helper.
static inline uint16_t color_for_speed(float speed) {
    if (speed < SPEED_CALM_MAX) return rgb565be(30, 90, 200);
    if (speed < SPEED_FAST_MAX) return rgb565be(120, 190, 250);
    return PX_WHITE;
}

// Colour is a pure function of a particle's speed, and speed does not change
// between tick() and that frame's 16 draw_band() calls: computing it once
// here saves 15 of every 16 square roots the naive version would take. See
// this file's header comment.
static void refresh_colors(void) {
    for (int i = 0; i < FLUID_N; i++) {
        s->color[i] = color_for_speed(sqrtf(s->vx[i] * s->vx[i] + s->vy[i] * s->vy[i]));
    }
}

/* ---- the app.h contract ------------------------------------------------ */

static void fluid_enter(void) {
    s = APP_STATE(fluid_state_t);
    s->rng = 0x2545F491u; // fixed seed: replay determinism, see rand_unit()
    calibrate_rest_density();
    seed_block();
    refresh_colors();
    // No drawing here, and no panel clear either: this pack has no
    // framebuffer for enter() to paint into (app.h). The first picture
    // appears when the runtime's first frame calls draw_band() 16 times.
}

static void fluid_tick(const app_frame_t *f) {
    if (f->key & KEY_SHORT) {
        // A short PWR press resets the fluid, mirroring the donor's own PWR
        // behaviour (fluidbox/README.md: "press the case's PWR button
        // briefly to reset the simulation").
        seed_block();
    }
    if (f->shaken) {
        apply_shake();
    }
    handle_touch(f);

    // dtMs is already clamped upstream (runtime_core.c: max 250ms per tick),
    // and SIM_DT_MAX caps the physics step itself the same way sim.c's own
    // dt ceiling does.
    float dt = ((float)f->dtMs / 1000.0f) * TIME_SCALE;
    if (dt > SIM_DT_MAX) dt = SIM_DT_MAX;
    if (dt > 0.0f) substep(dt);

    refresh_colors();
}

// Called once per band, every frame, 16 times (app.h). The band buffer's
// prior content is undefined, so this repaints the background first and
// then offers every particle to gfxb_fill_rect(), which clips each square
// to [y0, y0+rows) and to the panel - a particle sitting near an edge, or
// briefly outside it before resolve_walls() catches up, therefore needs no
// bounds check here.
static void fluid_draw_band(int band, uint16_t *buf, int y0, int rows) {
    (void)band;

    gfxb_fill(buf, rows, FLUID_BG);

    for (int i = 0; i < FLUID_N; i++) {
        const int cx = (int)(s->x[i] + 0.5f);
        const int cy = (int)(s->y[i] + 0.5f);
        gfxb_fill_rect(buf, y0, rows,
                       cx - PARTICLE_HALF, cy - PARTICLE_HALF,
                       2 * PARTICLE_HALF + 1, 2 * PARTICLE_HALF + 1,
                       s->color[i]);
    }
}

// Symbol name is g_demoApp, not g_fluidApp: runtime_core.c (this pack's
// runtime, unmodified by this port) declares `extern const app_t g_demoApp;`
// as its one wired app slot, so a replacement app file must define that
// exact name. Only .name below says "fluidbox". Same wart the chrono port
// names rather than hides.
const app_t g_demoApp = {
    .name      = "fluidbox",
    .enter     = fluid_enter,
    .tick      = fluid_tick,
    .draw_band = fluid_draw_band,
    .leave     = NULL,
};
