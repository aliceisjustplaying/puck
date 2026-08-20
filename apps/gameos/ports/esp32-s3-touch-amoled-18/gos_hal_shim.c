/*
 * gos_hal_shim: this port's own platform seam, implementing exactly the
 * gos_hal.h (../../reference/esp32-gameos/gos_hal.h, vendored unmodified)
 * functions the real, unmodified gos_core engine
 * (../../reference/esp32-gameos/{core,gfx,input}.c) actually calls, plus
 * the three libc-shape functions this port's math.h/stdio.h/stdlib.h/
 * string.h shims redirect to (gosport_snprintf/vsnprintf/abs) so the
 * vendored engine and games (gunship.c, slots.c) compile and run
 * unmodified. This file is the ONE place in this port that is genuinely
 * new code, not vendored from anywhere - see NOTICE.md.
 *
 * THE PRESENT/DRAW_BAND SEAM, the one piece of real design here: gos.h's
 * engine is "push style" - gos_gfx_present() hands the finished 184x224
 * indexed buffer plus the current palette LUT to hal_display_present() in
 * ONE call, once per tick. This pack's app.h contract is "pull style" -
 * runtime_core.c calls draw_band() sixteen times per tick, each time
 * asking for one 28-row slice. hal_display_present() below does NOT do any
 * pixel work: it just stashes the three pointers (fb, lut, lut_dim) and
 * the scanlines flag gos_gfx_present() handed it - zero bytes copied, safe
 * because gfx.c itself double-buffers `fb[2]` and only flips which one
 * `dst` points at on the NEXT present() call, so the buffer this port
 * stashed a pointer to is guaranteed untouched for the rest of this tick's
 * sixteen draw_band() calls. gosport_draw_band() (called FROM
 * gameos_port.c's own draw_band()) is what actually does the 2x-nearest,
 * palette-LUT upscale, scoped to just the rows one band covers - the same
 * arithmetic this app's rp2350 port's own gosrt_present() already does for
 * the WHOLE panel in one shot, here run once per band instead.
 */
#include "app.h"
#include "gfx_band.h"
#include "runtime_core.h"
#include "../../reference/esp32-gameos/gos.h"
#include "../../reference/esp32-gameos/gos_hal.h"

#include <stdarg.h>
#include <stddef.h>
#include <stdint.h>
#include <math.h>

/* ---- string.h: memset/memcpy/strlen -------------------------------------- */

void *memset(void *dst, int c, size_t n) {
    unsigned char *d = (unsigned char *)dst;
    for (size_t i = 0; i < n; i++) d[i] = (unsigned char)c;
    return dst;
}
void *memcpy(void *dst, const void *src, size_t n) {
    unsigned char *d = (unsigned char *)dst;
    const unsigned char *s = (const unsigned char *)src;
    for (size_t i = 0; i < n; i++) d[i] = s[i];
    return dst;
}
size_t strlen(const char *s) {
    size_t n = 0;
    while (s[n]) n++;
    return n;
}

/* ---- stdlib.h: abs -------------------------------------------------------- */

int gosport_abs(int x) { return x < 0 ? -x : x; }

/* ---- stdio.h: snprintf/vsnprintf ------------------------------------------
 *
 * A minimal printf-subset, the same one this app's rp2350 port's own
 * gos_runtime.c already carries (gosrt_vformat there): %d, %ld, %+d,
 * %+ld, %s, %%, plain text. Covers every format string the real, vendored
 * core.c/gfx.c/input.c/gunship.c/slots.c actually pass (checked by grep
 * over all five, not guessed) - core.c/input.c's own two NVS-key
 * snprintf() calls (the only ones using a width/precision spec, "%.12s")
 * are unreachable on this port: nvs_open() always fails first (see
 * nvs.h), so this formatter never has to parse one.
 */
int gosport_vsnprintf(char *buf, size_t cap, const char *fmt, va_list ap) {
    if (cap == 0) return 0;
    size_t n = 0;
    for (const char *s = fmt; *s && n < cap - 1; s++) {
        if (*s != '%') { buf[n++] = *s; continue; }
        s++;
        int forceSign = 0;
        if (*s == '+') { forceSign = 1; s++; }
        int isLong = 0;
        if (*s == 'l') { isLong = 1; s++; }
        char tmp[24];
        if (*s == 'd') {
            long v = isLong ? va_arg(ap, long) : va_arg(ap, int);
            int t = 0;
            int neg = v < 0;
            unsigned long uv = neg ? (unsigned long)(-v) : (unsigned long)v;
            do { tmp[t++] = (char)('0' + uv % 10); uv /= 10; } while (uv && t < (int)sizeof tmp);
            if (neg) tmp[t++] = '-';
            else if (forceSign) tmp[t++] = '+';
            while (t > 0 && n < cap - 1) buf[n++] = tmp[--t];
        } else if (*s == 's') {
            const char *sv = va_arg(ap, const char *);
            if (sv) while (*sv && n < cap - 1) buf[n++] = *sv++;
        } else if (*s == '%') {
            buf[n++] = '%';
        } else if (*s == 0) {
            break;
        }
        // any other conversion: silently skipped rather than misparsed -
        // none of the five files above use one (see this function's own
        // header comment).
    }
    buf[n] = 0;
    return (int)n;
}

int gosport_snprintf(char *buf, size_t cap, const char *fmt, ...) {
    va_list ap;
    va_start(ap, fmt);
    int n = gosport_vsnprintf(buf, cap, fmt, ap);
    va_end(ap);
    return n;
}

/* ---- gos_hal.h: display ----------------------------------------------------
 *
 * See this file's header comment for the present/draw_band split.
 */
static const uint8_t *s_pFb;
static const uint16_t *s_pLut;
static const uint16_t *s_pLutDim;
static int s_pScanlines;

void hal_display_present(const uint8_t *fb, const uint16_t *lut,
                          const uint16_t *lut_dim, bool scanlines) {
    s_pFb = fb;
    s_pLut = lut;
    s_pLutDim = lut_dim;
    s_pScanlines = scanlines ? 1 : 0;
}

// GOLF's full-res direct mode only (GOS_CAP_FB565) - dead on this port, see
// this port's NOTICE.md and packs/esp32-s3-touch-amoled-18/docs/decisions/
// 0003-...: no game this port ships ever calls gos_gfx_direct565(true), so
// gos_gfx_present() never takes the branch that reaches this.
void hal_display_present_565(const uint16_t *fb565) { (void)fb565; }

void hal_display_wait(void) { /* single frame in flight in this emulator port - see gos_hal.h's own comment; nothing to wait for. */ }
void hal_display_brightness(int pct) { (void)pct; /* no brightness concept on this ABI; core.c's gos_settings_apply() is never called by this port (see gameos_port.c), so this only needs to link. */ }

// GOS_SCREEN_W/H (184x224) match the panel exactly at half res (368x448),
// so a band's 28 panel rows always land on a whole number of source rows
// (14) - no fractional-row rounding anywhere in this loop.
void gosport_draw_band(int band, uint16_t *buf, int y0, int rows) {
    (void)band;
    if (!s_pFb) { gfxb_fill(buf, rows, PX_BLACK); return; } // present() not yet called this run (should not happen after enter(), defensive only)
    int srcY0 = y0 / 2;
    int srcRows = rows / 2;
    for (int sy = 0; sy < srcRows; sy++) {
        int oy = sy * 2;
        int dim0 = s_pScanlines && (((y0 + oy) % 3) == 2);
        int dim1 = s_pScanlines && (((y0 + oy + 1) % 3) == 2);
        const uint16_t *lut0 = dim0 ? s_pLutDim : s_pLut;
        const uint16_t *lut1 = dim1 ? s_pLutDim : s_pLut;
        const uint8_t *srow = s_pFb + (srcY0 + sy) * GOS_SCREEN_W;
        uint16_t *row0 = buf + oy * PANEL_W;
        uint16_t *row1 = row0 + PANEL_W;
        for (int sx = 0; sx < GOS_SCREEN_W; sx++) {
            int ox = sx * 2;
            row0[ox] = row0[ox + 1] = lut0[srow[sx]];
            row1[ox] = row1[ox + 1] = lut1[srow[sx]];
        }
    }
}

/* ---- gos_hal.h: touch/button, fed from this pack's own app_frame_t -------- */
static int s_touchDown;
static int s_touchX, s_touchY; // panel (368x448) space, per gos_hal.h's own
                                // doc comment on hal_touch_read - input.c
                                // itself does the /2 into game space.
static int s_bootPulse; // see this file's header comment on hal_button_down

bool hal_touch_read(int16_t *x, int16_t *y) {
    if (!s_touchDown) return false;
    *x = (int16_t)s_touchX;
    *y = (int16_t)s_touchY;
    return true;
}

// This ABI hands the runtime bootClicked as a one-tick release-EDGE pulse
// (app.h), not a held level like a real hal_button_down() would report -
// the SAME stated, honest gap this app's rp2350 port's own gosrt_build_input
// already documents for the identical reason (no live BOOT level on this
// ABI, only a pulse). Correct for every edge-triggered use (a menu tap);
// cannot reproduce a true HELD duration.
bool hal_button_down(void) { return s_bootPulse != 0; }

/* ---- gos_hal.h: IMU, fed from this pack's own raw accel stream ------------
 *
 * See packs/esp32-s3-touch-amoled-18/docs/decisions/0003-... for why this
 * pack's ABI has a raw accelerometer stream and not a fused gravity vector
 * like the RP2350 sibling's. This is the one place that difference is felt:
 * a fused hal_pose_t is exactly what a real hal_imu.c would compute from
 * the same raw accelerometer this pack's app_accel_read() now streams, so
 * this shim does the same fusion by hand - atan2f(ax, az) / atan2f(ay, az),
 * the identical formula shape this app's rp2350 port's own
 * gosrt_build_input already uses to turn a gravity vector into pitch/roll
 * (there, the vector arrived pre-fused; here, this shim is the fusion
 * step a real board's IMU task would already have done).
 */
static float s_lastAx, s_lastAy, s_lastAz; // unread while !s_haveAccel
static int s_haveAccel;
static int s_shakePulse;

void hal_imu_get(hal_pose_t *out) {
    app_accel_sample_t buf[APP_ACCEL_RING];
    int n = app_accel_read(buf, APP_ACCEL_RING);
    for (int i = 0; i < n; i++) {
        s_lastAx = buf[i].ax;
        s_lastAy = buf[i].ay;
        s_lastAz = buf[i].az;
        s_haveAccel = 1;
    }
    if (s_haveAccel) {
        out->roll = atan2f(s_lastAx, s_lastAz) * (180.0f / (float)M_PI);
        out->pitch = atan2f(s_lastAy, s_lastAz) * (180.0f / (float)M_PI);
        out->ok = true;
    } else {
        out->roll = 0.0f;
        out->pitch = 0.0f;
        out->ok = false;
    }
    // No gyroscope on this ABI's raw stream (accelerometer only) - GOS_AIM_GYRO_RATE
    // has no real signal here, the same stated gap this app's rp2350 port
    // already carries for the identical reason. gunship.c only reads
    // gx/gy/gz for its diagnostic HUD text and the GYRO_RATE branch this
    // port never selects (see gameos_port.c).
    out->gx = out->gy = out->gz = 0.0f;
    out->shake = s_shakePulse ? 1.0f : 0.0f;
}

int hal_imu_accel_read(hal_accel_sample_t *out, int max) {
    // GOLF-only (not part of this port - see NOTICE.md); the field shapes
    // are identical (gos_imu_accel_read()'s own header comment in
    // ../../reference/esp32-gameos/input.c says as much), so this is a
    // correct pass-through even though nothing on this port calls it today.
    app_accel_sample_t tmp[APP_ACCEL_RING];
    int n = app_accel_read(tmp, max < APP_ACCEL_RING ? max : APP_ACCEL_RING);
    for (int i = 0; i < n; i++) {
        out[i].t_us = (int64_t)tmp[i].tMs * 1000;
        out[i].ax = tmp[i].ax;
        out[i].ay = tmp[i].ay;
        out[i].az = tmp[i].az;
    }
    return n;
}

/* ---- gos.h: audio, stubbed --------------------------------------------
 *
 * gos_core/mixer.c (the real 8-voice synth) is deliberately not vendored
 * here - see NOTICE.md - because this pack has no sound HAL at all to
 * drive it with (no I2S/ES8311 equivalent, same stated gap this app's
 * rp2350 port already carries: "GOS_CAP_AUDIO... stubbed (silent / always-
 * empty)"). gunship.c and slots.c call these unconditionally (engine loop
 * sounds, coin drops, wins), not behind any capability check this port
 * could skip, so they need real, linkable bodies - silent ones. Every
 * handle returned is -1, which both games already treat as "did not
 * start" (see gos.h's own doc: "returns handle or -1"), so nothing here
 * risks a bad handle being fed back into gos_audio_stop()/set_vol() later.
 */
int gos_audio_play(const gos_sfx_t *s, uint8_t vol) { (void)s; (void)vol; return -1; }
int gos_audio_loop(const gos_sfx_t *s, uint8_t vol) { (void)s; (void)vol; return -1; }
void gos_audio_stop(int handle) { (void)handle; }
void gos_audio_set_vol(int handle, uint8_t vol) { (void)handle; (void)vol; }
void gos_audio_stop_all(void) { }
void gos_audio_master(int level) { (void)level; }
int gos_audio_master_get(void) { return 0; }

/* ---- esp_timer.h: this port's own tick clock, never a wall clock ---------- */
static uint32_t s_nowMs;
int64_t esp_timer_get_time(void) { return (int64_t)s_nowMs * 1000; }

/* ---- fed once per tick by gameos_port.c's tick(), before gos_input_update() */
void gosport_set_frame(const app_frame_t *f) {
    s_nowMs = f->nowMs;
    s_touchDown = f->touchDown ? 1 : 0;
    s_touchX = f->touchX;
    s_touchY = f->touchY;
    s_bootPulse = f->bootClicked ? 1 : 0;
    s_shakePulse = f->shaken ? 1 : 0;
}
