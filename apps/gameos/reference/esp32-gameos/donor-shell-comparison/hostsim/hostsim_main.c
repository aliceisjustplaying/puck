// hostsim_main.c -- this bundle's OWN host-native frame-dump driver,
// written to answer the same question the donor's own
// docs/testing-and-verification.md documents ("Host simulator pattern":
// gos_core/gfx.c, font.c and game sources compile on a host with
// -DGOS_HOST_SIM, a small simN.c harness scripts input and dumps
// 2x-upscaled PPM frames). That harness's own source (simN.c, fakeinc/) is
// NOT part of the vendored donor repository - the donor's own doc says so
// plainly ("Working examples live in session scratchpads"), so there is
// nothing checked into MikeWilson/esp32-gameos to literally run. This file
// is a fresh, from-scratch equivalent, following the same documented idea
// (the real engine, compiled and run on a host, no ESP-IDF, dumping a
// frame), reusing this port's OWN existing HAL shim (gos_hal_shim.c)
// instead of the donor's undocumented -DGOS_HOST_SIM branches, because that
// shim is simpler (already handles touch/button/IMU/audio/power/heap) and
// already proven correct by this port's own wasm build.
//
// This is genuinely the SAME vendored source this port ships (core.c,
// gfx.c, input.c, font.c, gunship.c, slots.c, golf.c/golf_render.c/
// golf_cards.c, apps.c, registry.c, shell.c - all byte-for-byte, see
// NOTICE.md), compiled by a DIFFERENT compiler for a DIFFERENT target
// (host native, not wasm32-freestanding) - the same "two compilers, not
// one" spirit docs/decisions/0002-two-compilers-not-one.md states for the
// repository's own wasm/silicon split, one level further: a THIRD
// compilation of the identical donor source, to cross-check the wasm
// capture against, independent of this repository's own wasm toolchain
// and canvas pipeline entirely.
//
// Build (see this directory's own README for the exact command):
//   zig cc <this file> <gfx_band.c> -I <port dir> -I <reference dir>
//          -I <runtime dir> -o hostsim.exe
// Run: hostsim.exe out.ppm
//
// Does NOT use GOS_HOST_SIM at all (deliberately - see above): the full
// engine, unmodified, same as this port's own wasm build, just retargeted.
#include <stdint.h>
#include <stdbool.h>
#include <stddef.h>

// NOT <stdio.h>/<stdlib.h>: this compilation's own -I search list puts
// this port's freestanding stdio.h/stdlib.h shims (declaring only
// gosport_snprintf/vsnprintf/abs, no FILE, no fopen - see those files' own
// header comments) ahead of the host's real ones, on purpose, so the
// vendored engine below gets the SAME redirected snprintf/vsnprintf this
// port's own wasm build uses. This driver's own file I/O therefore
// declares the three real host libc entry points it needs by hand, typed
// with `void *` instead of `FILE *` (ABI-identical - a stream handle is an
// opaque pointer either way, and this driver never dereferences its
// fields) rather than pull in the real <stdio.h> and fight that shadowing.
extern void *fopen(const char *path, const char *mode);
extern unsigned long long fwrite(const void *ptr, unsigned long long size, unsigned long long n, void *stream);
extern int fclose(void *stream);
// No stderr/fprintf: mingw/UCRT's stderr is usually a macro over a
// runtime accessor function, not a plain exported symbol, so it is not
// safely hand-declarable the way fopen/fwrite/fclose are. This driver
// reports success purely by its own process exit code and the output
// file's existence - see this directory's own README for how it is run
// and checked.

// app.h/gfx_band.h/runtime_core.h: only for the app_frame_t shape
// gos_hal_shim.c's gosport_set_frame() expects and the PANEL_W/H
// constants - none of runtime_core.c's or gfx_band.c's own pack-glue
// machinery (app_alloc, rtcore_*, draw_band dispatch) is exercised by this
// driver. gfx_band.c itself IS linked (below) only because gos_hal_shim.c's
// own gosport_draw_band() references gfxb_fill() - this driver never calls
// gosport_draw_band(), but the symbol must still resolve at link time.
#include "app.h"
#include "runtime_core.h"

#include "gos_hal_shim.c"

#define snprintf(buf, cap, ...) gosport_snprintf(buf, cap, __VA_ARGS__)
#define vsnprintf(buf, cap, fmt, ap) gosport_vsnprintf(buf, cap, fmt, ap)
#include "core.c"
#include "gfx.c"
#include "input.c"
#include "font.c"
#undef snprintf
#undef vsnprintf

#define abs(x) gosport_abs(x)
#define snprintf(buf, cap, ...) gosport_snprintf(buf, cap, __VA_ARGS__)
#include "gunship.c"
#include "slots.c"
#undef abs
#undef snprintf

#define sfx_tap golf_sfx_tap
#define sfx_tap_n golf_sfx_tap_n
#define sfx_tick golf_sfx_tick
#define sfx_tick_n golf_sfx_tick_n
#define update_camera golf_update_camera
#define snprintf(buf, cap, ...) gosport_snprintf(buf, cap, __VA_ARGS__)
#include "golf.c"
#undef update_camera
#undef sfx_tick_n
#undef sfx_tick
#undef sfx_tap_n
#undef sfx_tap
#include "golf_render.c"
#include "golf_cards.c"
#undef snprintf
#include "font565_shim.c"

#include "apps.c"
#include "registry.c"

#define tap shell_tap
#define snprintf(buf, cap, ...) gosport_snprintf(buf, cap, __VA_ARGS__)
#include "shell.c"
#undef snprintf
#undef tap

// ---------------------------------------------------------------------------
// The dump itself: fb/lut/lut_dim/dst/draw_idx are gfx.c's own file-statics,
// visible here because this file (via the #include chain above) IS gfx.c's
// own translation unit, the same trick this port's whole unity build
// already relies on. gos_gfx_present() (gfx.c, #ifndef GOS_HOST_SIM, real
// and compiled here since this driver deliberately never defines
// GOS_HOST_SIM) already ran as shell_frame()'s own last line, every tick,
// and its OWN last two statements are `draw_idx ^= 1; dst = fb[draw_idx];`
// - by the time this dump runs, `dst` already points at the buffer for the
// NEXT, not-yet-drawn frame, not the one just presented. The buffer that
// WAS just handed to hal_display_present() is the other one:
// `fb[draw_idx ^ 1]`, which is what this dump actually reads - reading
// `dst` directly here would show last frame's stale content one tick late.
// ---------------------------------------------------------------------------

int main(int argc, char **argv) {
    const char *outPath = argc > 1 ? argv[1] : "hostsim_out.ppm";

    gos_gfx_init();
    gos_input_init();
    gos_mixer_init();
    shell_init();

    // Drive ticks exactly like esp32gameos_tick() (gameos_port.c): feed a
    // synthetic app_frame_t, advance gos_input_update(), then shell_frame().
    uint32_t nowMs = 0;
    app_frame_t f = { 0 };

    // Boot settle: three quiet ticks (mirrors this bundle's own
    // launcher16/48/80 boot captures - shell_init() lands on the
    // calibration wizard, not the grid, every session - see
    // ../README.md's "no NVS persistence" note).
    for (int i = 0; i < 3; i++) {
        nowMs += 16;
        f.nowMs = nowMs; f.dtMs = 16;
        gosport_set_frame(&f);
        gos_input_update(f.dtMs / 1000.f);
        shell_frame(gos_input_get(), 1);
    }

    // One tap, center of panel (render space 92,150 -> panel 184,300),
    // press then release next tick - dismisses SH_CALIB, same gesture
    // capture-gameos-esp32-shell-frame.ts uses.
    nowMs += 16;
    f.nowMs = nowMs; f.dtMs = 16; f.touchDown = true; f.touchX = 184; f.touchY = 300;
    gosport_set_frame(&f);
    gos_input_update(f.dtMs / 1000.f);
    shell_frame(gos_input_get(), 1);

    nowMs += 16;
    f.nowMs = nowMs; f.dtMs = 16; f.touchDown = false;
    gosport_set_frame(&f);
    gos_input_update(f.dtMs / 1000.f);
    shell_frame(gos_input_get(), 1);

    // Settle on the grid.
    for (int i = 0; i < 20; i++) {
        nowMs += 16;
        f.nowMs = nowMs; f.dtMs = 16; f.touchDown = false;
        gosport_set_frame(&f);
        gos_input_update(f.dtMs / 1000.f);
        shell_frame(gos_input_get(), 1);
    }

    // Dump: gfx.c's own `dst`/`lut` (indexed 184x224 + its RGB565 LUT,
    // panel byte order already applied by gos_gfx_set_palette's own
    // bswap16 - see gfx.c), 2x-upscaled to 368x448, matching the donor's
    // own doc ("dumps 2x-upscaled PPM frames") and this pack's own
    // draw_band 2x-nearest rule.
    void *fp = fopen(outPath, "wb");
    if (!fp) return 1;
    {
        static const char hdr[] = "P6\n368 448\n255\n";
        fwrite(hdr, 1, sizeof(hdr) - 1, fp);
    }
    const uint8_t *presented = fb[draw_idx ^ 1];
    for (int y = 0; y < 224; y++) {
        uint8_t row[368 * 3 * 2];
        for (int x = 0; x < 184; x++) {
            uint16_t px = lut[presented[y * 184 + x]];
            // px is panel byte order (bswap16 applied at palette-set time) -
            // undo it back to host order to read out R/G/B.
            uint16_t v = (uint16_t)((px >> 8) | (px << 8));
            uint8_t r = (uint8_t)(((v >> 11) & 31) * 255 / 31);
            uint8_t g = (uint8_t)(((v >> 5) & 63) * 255 / 63);
            uint8_t b = (uint8_t)((v & 31) * 255 / 31);
            row[(x * 2) * 3 + 0] = r; row[(x * 2) * 3 + 1] = g; row[(x * 2) * 3 + 2] = b;
            row[(x * 2 + 1) * 3 + 0] = r; row[(x * 2 + 1) * 3 + 1] = g; row[(x * 2 + 1) * 3 + 2] = b;
        }
        fwrite(row, 1, sizeof row, fp);
        fwrite(row, 1, sizeof row, fp);
    }
    fclose(fp);
    return 0;
}
