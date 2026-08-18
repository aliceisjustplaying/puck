// fluid.c: a 2D adaptation of esp32-fluidbox's Clavet double-density-
// relaxation particle solver (apps/fluidbox/reference/esp32-fluidbox/sim.c),
// ported to this pack's full-framebuffer app contract (enter/tick/leave,
// app_frame_t, gfx_fill_rect/gfx_push). See
// apps/fluidbox/ports/rp2350-touch-amoled-18/README.md for the verdict this
// implements (degraded, mode adaptation, verified by invariants) and the
// honesty requirements it documents in full: 2D rather than 3D, a reduced
// particle count, and an emulator that cannot prove a real-hardware fps
// floor.
//
// GRAVITY DIRECTION. In the EMULATOR, this now follows the rotation
// control's "kind": "vector" tilt sensor (wasm/emu_abi.h's emu_sensor_vector,
// packs/rp2350-touch-amoled-18/wasm/emu_shim.c's emu_shim_tilt_get - a
// private, non-ABI accessor scoped to this one --app build, NOT plumbed
// through app_frame_t/sensors.h, since those are pack firmware this task
// does not touch). ON REAL HARDWARE this still falls back to fixed-down
// gravity: wiring a real QMI8658 reading into every app via app_frame_t
// would mean editing firmware/runtime/app.h and sensors.c, out of scope
// here (see this port's README, "the missing ABI call" section, for the
// full honesty statement of what is and is not wired on which target).
//
// This file defines no app_t of its own (unlike firmware/apps/chrono.c):
// see packs/rp2350-touch-amoled-18/wasm/build.ts's --app header comment for
// why a single-app --app build on this pack wants plain port_enter()/
// port_tick() functions instead of a named app_t.
#include <math.h>
#include <stdbool.h>
#include <stdint.h>

#include "app.h"
#include "gfx.h"
#include "sensors.h"

// ONE .c, TWO TARGETS. This port also builds native, straight to the real
// board (packs/rp2350-touch-amoled-18/tools/build-native.ts's --app flag),
// and native has no emu_shim.c to link against at all - that file is
// wasm-only (packs/rp2350-touch-amoled-18/wasm/). A plain `extern` here
// would leave the native single-app link with an undefined reference.
//
// `weak` is the fix: the wasm build's real, STRONG emu_shim_tilt_get()
// (emu_shim.c) always overrides this weak default when both are linked
// together (that is exactly what `weak` means to the linker) - so the
// emulator's tilt-follows-rotation behaviour is unaffected. The native
// build links only this weak definition, since nothing else in that build
// provides the symbol, and gets a constant zero vector: exactly what
// update_gravity_direction() below already treats as "no tilt reading
// yet" and falls back on, straight-down gravity, this port's original
// behaviour and its ONLY behaviour on real hardware until a future
// firmware change (see this file's header comment) wires a real QMI8658
// read through app_frame_t. Nothing about the fallback threshold or logic
// needed to change; the weak symbol just makes that fallback the native
// build's only path rather than an unresolved symbol.
__attribute__((weak)) void emu_shim_tilt_get(float *x, float *y, float *z) {
    *x = 0.0f;
    *y = 0.0f;
    *z = 0.0f;
}

/* ===========================================================================
 * Particle count
 *
 * Donor (esp32-fluidbox, 3D, ESP32-S3 240MHz dual-core with hardware FPU):
 * 900 particles, an O(1)-per-pair uniform grid, measured 33-41 steps/s.
 * This port: RP2350 is single-core 150MHz Cortex-M33 (single-precision FPU,
 * no ESP32-S3-class SIMD tricks) and runs render and physics on the same
 * core, in the same tick - there is no second core to hide the solver's
 * cost behind. FLUID_N is picked at the small end of the port's own
 * plausible-particle-count budget (100-160) specifically so an O(n^2)
 * neighbour search - no grid, see below - stays cheap enough to be honest
 * about: see the README's per-tick op-count estimate for the arithmetic.
 * ======================================================================= */
#define FLUID_N 130

/* ===========================================================================
 * Neighbour search: O(n^2), not a grid.
 *
 * The donor's uniform grid (sim.c's GRID_CX/CY/CZ, counting-sort rebuild,
 * cached pair list) exists because 900 particles naively is 810,000 pairs a
 * frame. At FLUID_N=130 a full pairwise scan is 130*129/2 = 8,385 pairs, and
 * neighbour search happens twice a step (density+viscosity, then
 * relaxation) for at most 16,770 pair evaluations - cheaper outright than
 * building and walking a grid would be at this size, and it removes an
 * entire subsystem (cell indexing, counting sort, pair caching, the
 * per-particle memory reorder) that has no payoff below a few hundred
 * particles. This is a genuine simplification the reduced particle count
 * buys, not a corner cut: see the README's "kept vs lost" table.
 * ======================================================================= */

/* ===========================================================================
 * Box and wall constants, kept at the donor's own values where they are
 * physical/panel properties rather than 3D-specific: this panel is the same
 * ~322ppi / ~12.7 px-per-mm AMOLED family the donor was tuned against
 * (packs/rp2350-touch-amoled-18/AGENTS.md's own measurement), and
 * REST_SPACING/SMOOTH_RADIUS are panel-scale properties, not depth
 * properties, so reusing them keeps the LOCAL fluid behaviour (how a pair of
 * neighbours push apart) comparable even though the GLOBAL box is now a
 * rectangle, not a box.
 * ======================================================================= */
#define WALL_MARGIN       5.0f
#define PX_PER_MM         12.7f
#define BOX_CORNER_MM     4.5f
#define BOX_CORNER_R      (BOX_CORNER_MM * PX_PER_MM)  // ~57px, donor's own value

#define REST_SPACING      17.0f
#define SMOOTH_RADIUS     28.0f

#define TIME_SCALE        0.100f
#define SIM_DT_MAX        0.0022f

// Donor's real, unscaled gravity (9.81 * gain, in px/s^2 via this panel's own
// px-per-metre). Kept exactly: TIME_SCALE's effect on gravity comes entirely
// through the scaled dt multiplying it (see integrate_velocities below), the
// same mechanism the donor's own sim.c uses, so the physical magnitude does
// not need retuning on its own - only the box/particle-count context around
// it changed. This is now a MAGNITUDE only; the DIRECTION comes from
// s->gravX/gravY (see integrate_velocities and port_tick's tilt read below) -
// straight down, (0, 1), unless the emulator's tilt sensor overrides it.
#define PX_PER_METER      12677.0f
#define GRAVITY_MPS2      9.81f
#define GRAVITY_GAIN      2.2f
#define GRAVITY_PXS2      (GRAVITY_MPS2 * GRAVITY_GAIN * PX_PER_METER)

// Below this tilt magnitude (g), gravity direction falls back to fixed
// straight down rather than trusting a near-zero vector's direction (noise
// dominates a vector this small, and a near-zero magnitude is exactly what
// "no tilt reading yet" - the emu_shim.c default - looks like). Chosen well
// under the ~1g a live rotation reading actually sends (rotate.ts's
// gravityForQuickDeg always returns a unit vector) and well above 0, so the
// existing invariant trace (which never sends a vector event at all, see
// apps/fluidbox/ports/rp2350-touch-amoled-18/README.md) reads a magnitude of
// exactly 0 and takes this fallback every tick, UNCHANGED from this port's
// pre-tilt behaviour.
#define TILT_MIN_G        0.2f

#define K_PRESSURE        400000.0f
#define K_NEAR_PRESSURE   800000.0f
#define MAX_DISPLACEMENT  4.0f
#define WALL_JITTER       0.35f
#define VISC_SIGMA        45.0f
#define VISC_BETA         0.03f
#define WALL_RESTITUTION  0.25f
#define WALL_FRICTION     0.96f

// Shake: a one-shot impulse in a random direction per particle, since this
// pack's ABI hands the app a discrete event (f->shaken), not a continuous
// acceleration signal to integrate. Magnitude picked to read as a visible
// agitation (comfortably clears the invariant checker's shake-frame-diff
// threshold, see apps/fluidbox/invariants.ts) without being so large the
// solver's MAX_DISPLACEMENT clamp saturates every pair for several seconds.
#define SHAKE_IMPULSE_PXS 700.0f

// Touch: this pack HAS touch and the donor board could not use its own (see
// descriptor.md's Interactions - the donor never reads its touch
// controller). A finger drag within TOUCH_STIR_RADIUS of the contact point
// nudges nearby particles by the drag's own per-frame delta, falling off
// linearly with distance, so dragging feels like stirring rather than like
// a uniform gust.
#define TOUCH_STIR_RADIUS 70.0f
#define TOUCH_STIR_GAIN   9.0f

#define PARTICLE_HALF     3  // drawn as a (2*PARTICLE_HALF+1)-pixel square

// Speed thresholds for the flat 3-tier colour ramp (see color_for_speed()).
// Donor: a continuous LUT (config.h's SPEED_LEVELS x DEPTH_LEVELS table).
// This port has no depth axis and only 130 particles a frame, so a plain
// branch is simpler and does not need a precomputed table - not gold-plating
// a LUT this size does not need. Calibrated against this port's own settled
// speed (found empirically while proving the invariants, not copied from the
// donor's ~65px/s figure, which was tuned against a different box/particle
// count).
#define SPEED_CALM_MAX    260.0f
#define SPEED_FAST_MAX    900.0f

#define FLUID_BG          PX_BLACK

typedef struct {
    float x[FLUID_N], y[FLUID_N];
    float vx[FLUID_N], vy[FLUID_N];
    float oldx[FLUID_N], oldy[FLUID_N];
    float density[FLUID_N], densityNear[FLUID_N];
    float press[FLUID_N], pressNear[FLUID_N];
    float viscDx[FLUID_N], viscDy[FLUID_N];

    float restDensity;
    uint32_t rng;

    bool touchWasDown;
    int  touchLastX, touchLastY;

    // Current gravity DIRECTION (unit vector, panel coordinates), read once
    // per tick from emu_shim_tilt_get() and used by every integrate_velocities()
    // call until the next tick refreshes it - see port_tick and
    // integrate_velocities below.
    float gravX, gravY;
} fluid_state_t;

static fluid_state_t *s;

/* ---- deterministic RNG ---------------------------------------------------
 * Donor's own xorshift32, fixed seed. Replay determinism (harness/
 * invariantRun.ts replaying the same trace twice must produce the same
 * frames) depends on this being a pure function of the seed and the call
 * sequence - never a real entropy source, which this ABI has no call for
 * anyway.
 * ------------------------------------------------------------------- */
static inline float rand_unit(void) {
    s->rng ^= s->rng << 13;
    s->rng ^= s->rng >> 17;
    s->rng ^= s->rng << 5;
    return (float)(s->rng & 0xFFFFFFu) * (1.0f / 16777215.0f);
}

// Sums the density kernel over a 2D lattice at REST_SPACING, the same method
// sim.c's calibrate_rest_density() uses over a 3D one: this makes
// rest_density self-consistent with REST_SPACING/SMOOTH_RADIUS regardless of
// dimensionality, rather than a magic number carried over from a 3D result
// that would not mean the same thing here.
static void calibrate_rest_density(void) {
    const float h = SMOOTH_RADIUS;
    const int reach = (int)ceilf(h / REST_SPACING);
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

static void integrate_velocities(float dt) {
    const float ax = s->gravX * GRAVITY_PXS2 * dt;
    const float ay = s->gravY * GRAVITY_PXS2 * dt;
    for (int i = 0; i < FLUID_N; i++) {
        s->vx[i] += ax;
        s->vy[i] += ay;
    }
}

// Densities and viscosity in one O(n^2) pass, fused for the same reason
// sim.c's compute_densities_and_viscosity() fuses them: they need the same
// pairs and the same sqrt, and walking the pairs twice would cost more than
// the viscosity arithmetic itself. Viscosity is applied as a position
// offset, not a velocity change, because velocity is recovered from
// displacement at the end of the substep (see substep()) - identical
// reasoning to the donor.
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
// rectangle joining the four corner-arc centres, and whatever offset remains
// points straight out from the nearest part of the outline (sim.c's
// resolve_walls() first stage, unchanged - this port drops only the second,
// depth-fillet stage, since there is no depth axis to curve into).
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
// touchPressed just records a starting point) - the same "delta between two
// resolved samples" shape timer.c's own drag handling uses on this pack.
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

static inline uint16_t rgb565(int r, int g, int b) {
    if (r < 0) r = 0; else if (r > 255) r = 255;
    if (g < 0) g = 0; else if (g > 255) g = 255;
    if (b < 0) b = 0; else if (b > 255) b = 255;
    return (uint16_t)(((r & 0xF8) << 8) | ((g & 0xFC) << 3) | (b >> 3));
}

// Flat 3-tier ramp (see this file's SPEED_CALM_MAX/SPEED_FAST_MAX comment):
// calm blue, brighter blue, white for a hard shake. px_swap because the
// panel wants RGB565 byte-reversed from how the CPU stores a uint16_t
// (gfx.h) - PX_BLACK/PX_WHITE are byte-palindromes and skip this, but every
// other colour needs it.
static inline uint16_t color_for_speed(float speed) {
    if (speed < SPEED_CALM_MAX) return px_swap(rgb565(30, 90, 200));
    if (speed < SPEED_FAST_MAX) return px_swap(rgb565(120, 190, 250));
    return px_swap(rgb565(255, 255, 255));
}

static void draw_particles(void) {
    for (int i = 0; i < FLUID_N; i++) {
        const int cx = (int)(s->x[i] + 0.5f);
        const int cy = (int)(s->y[i] + 0.5f);
        const float speed = sqrtf(s->vx[i] * s->vx[i] + s->vy[i] * s->vy[i]);
        const uint16_t color = color_for_speed(speed);
        // gfx_fill_rect clips to the panel, so a particle sitting near an
        // edge (or, briefly, outside it before resolve_walls() catches up)
        // draws safely without a bounds check here.
        gfx_fill_rect(cx - PARTICLE_HALF, cy - PARTICLE_HALF,
                      2 * PARTICLE_HALF + 1, 2 * PARTICLE_HALF + 1, color);
    }
}

// Reads the emulator's tilt vector (if any) and resolves it to a unit
// gravity DIRECTION in s->gravX/gravY, falling back to fixed straight down
// when the reading is ~zero (see TILT_MIN_G's own comment for why that is
// exactly what "no reading yet" and every pre-tilt trace both look like).
// The z component (into-screen) is read and deliberately ignored: this is
// a 2D solver, gravity only ever pulls within the panel plane.
static void update_gravity_direction(void) {
    float tx, ty, tz;
    emu_shim_tilt_get(&tx, &ty, &tz);
    (void)tz;
    const float mag = sqrtf(tx * tx + ty * ty);
    if (mag > TILT_MIN_G) {
        s->gravX = tx / mag;
        s->gravY = ty / mag;
    } else {
        s->gravX = 0.0f;
        s->gravY = 1.0f; // fallback: fixed straight down, this port's original behaviour
    }
}

void port_enter(void) {
    s = APP_STATE(fluid_state_t);
    s->rng = 0x2545F491u; // fixed seed: replay determinism, see rand_unit()'s comment
    s->gravX = 0.0f;
    s->gravY = 1.0f; // straight down until the first tick reads a live tilt
    calibrate_rest_density();
    seed_block();

    // The runtime clears the panel to WHITE before calling enter() (app.h's
    // enter() contract) and pushes the whole panel once after this returns
    // - this app's own background is black, so the first thing enter() does
    // is repaint it, then draw the seeded fluid on top.
    gfx_fill_rect(0, 0, PANEL_W, PANEL_H, FLUID_BG);
    draw_particles();
}

void port_tick(const app_frame_t *f) {
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
    update_gravity_direction();

    // dtMs is already clamped upstream (runtime_core.c: max 250ms per tick),
    // and SIM_DT_MAX caps the physics step itself the same way sim.c's own
    // dt ceiling does - see that constant's comment for why this matters
    // more than any other constant here.
    float dt = ((float)f->dtMs / 1000.0f) * TIME_SCALE;
    if (dt > SIM_DT_MAX) dt = SIM_DT_MAX;
    if (dt > 0.0f) substep(dt);

    // Full-panel refresh every tick (this bundle's own Demand: the fluid can
    // move anywhere in the box between two frames, so no region of the
    // previous frame can be assumed still valid - see descriptor.md). Push
    // the whole panel: gfx_push widens to the 8px row rule regardless, and
    // at PANEL_W=368 (already a multiple of 8) a full-width push needs no
    // padding.
    gfx_fill_rect(0, 0, PANEL_W, PANEL_H, FLUID_BG);
    draw_particles();
    gfx_push(0, 0, PANEL_W - 1, PANEL_H - 1);
}
