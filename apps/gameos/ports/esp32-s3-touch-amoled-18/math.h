/*
 * math.h: this pack's wasm32-freestanding target ships no <math.h> at all
 * (a hosted-only header the C standard does not require a freestanding
 * implementation to provide - the same fact
 * packs/rp2350-touch-amoled-18/wasm/shim/math.h's own header comment
 * documents, confirmed empirically there first). The real, vendored
 * ../../reference/esp32-gameos/{gfx,input}.c `#include <math.h>` as
 * unmodified upstream code, so they need a declaration to compile against.
 *
 * sinf/cosf/atan2f/sqrtf/fabsf/floorf/fmodf/powf/expf are declared `extern`
 * with no body: instrument-level host imports (src/wasm.ts's `env.sinf`
 * etc., backed by JS `Math.*`), the SAME nine every pack in this repository
 * already relies on - not reimplemented here, so this port carries no
 * second, hand-rolled source of numerical divergence from them.
 * ceilf/lrintf are composed locally from floorf, the same "exact,
 * non-transcendental, safe to define" reasoning the sibling shim gives for
 * its own ceilf/fminf/lroundf (this port needs lrintf, not lroundf -
 * ../../reference/esp32-gameos/gfx.c's sin-table precompute is the one
 * caller, rounding to the nearest integer, which is what lrintf and the
 * simpler lroundf shape agree on for every value that table ever produces).
 */
#ifndef _GAMEOS_ESP32_SHIM_MATH_H_
#define _GAMEOS_ESP32_SHIM_MATH_H_

#define M_PI 3.14159265358979323846

extern float sinf(float x);
extern float cosf(float x);
extern float atan2f(float y, float x);
extern float sqrtf(float x);
extern float fabsf(float x);
extern float floorf(float x);
extern float fmodf(float x, float y);
extern float powf(float x, float y);
extern float expf(float x);

static inline float ceilf(float x) {
    return -floorf(-x);
}

static inline long lrintf(float x) {
    return (long)(x >= 0.0f ? floorf(x + 0.5f) : -floorf(-x + 0.5f));
}

// fminf/fmaxf: added for GOLF (../../reference/esp32-gameos/golf_render.c
// calls both - checked by grep, not guessed; neither gfx.c nor input.c nor
// gunship.c/slots.c use either). Same "exact, non-transcendental, safe to
// define" reasoning this file already gives ceilf/lrintf, composed locally
// rather than imported - no numerical-fidelity risk a host Math.min/max
// import could introduce differently.
static inline float fminf(float a, float b) { return a < b ? a : b; }
static inline float fmaxf(float a, float b) { return a > b ? a : b; }

#endif
