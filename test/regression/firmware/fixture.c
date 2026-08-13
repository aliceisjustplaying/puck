/*
 * The regression-check test fixture: one tiny firmware, built twice by
 * test/regression/build.ts (once plain, once with -DREGRESS_CHANGED),
 * purely to give test/regression/run.ts a REAL pair of compiled modules
 * where exactly one draw call is different, so it can prove the
 * hardware-free regression check (src/regression.ts) actually catches a
 * real behavioural change and not just a hypothetical one.
 *
 * Deliberately smaller than example/firmware/main.c (that file exists to
 * be read as a worked example of the ABI; this one exists only to be
 * compiled and diffed) - see AGENTS.md's note that test fixtures under
 * test/ are allowed to carry their own small firmware C files, same as the
 * hostile-firmware regression suite under test/hostile/firmware/ already
 * does.
 *
 * Behaviour: boots to a paper-coloured panel. A short press of button A
 * (index 0) flips the WHOLE panel to a solid colour on the very next tick,
 * then flips it back on the tick after the next short press, and so on.
 * The colour it flips TO is the one line that differs between builds - see
 * emu_tick() below. Nothing else about the two builds differs, so a trace
 * that captures a frame before the first flip and a frame after it gives a
 * regression check exactly one matching point and exactly one diverging
 * one, deterministically.
 */
#include "emu_abi.h"

#include <stdbool.h>
#include <stdint.h>

#define PANEL_W 64
#define PANEL_H 64

static uint16_t g_fb[PANEL_W * PANEL_H];

static uint16_t rgb565be(uint8_t r, uint8_t g, uint8_t b) {
    uint16_t v = (uint16_t)(((r >> 3) << 11) | ((g >> 2) << 5) | (b >> 3));
    return (uint16_t)((v >> 8) | (v << 8)); /* swap bytes for panel DMA order */
}

static void fill_all(uint16_t color) {
    for (int i = 0; i < PANEL_W * PANEL_H; i++) g_fb[i] = color;
}

static uint16_t paper_color(void) { return rgb565be(0xf5, 0xf1, 0xe8); }

static int g_pushX = 0, g_pushY = 0, g_pushW = 0, g_pushH = 0;
static int g_pushCount = 0;

#define BTN_A 0

static bool g_flipped = false;
static int g_aVerdict = -1; /* -1 none pending, 0 short, 1 long */

int emu_init(void) {
    fill_all(paper_color());
    return 1;
}

void emu_tick(uint32_t nowMs) {
    (void)nowMs;
    g_pushCount = 0;
    if (g_aVerdict != 0) return;
    g_aVerdict = -1;
    g_flipped = !g_flipped;
    if (g_flipped) {
#ifdef REGRESS_CHANGED
        fill_all(rgb565be(0x20, 0x60, 0xa0)); /* the one line that differs: a different flip colour */
#else
        fill_all(rgb565be(0xc4, 0x62, 0x1f));
#endif
    } else {
        fill_all(paper_color());
    }
    g_pushX = 0;
    g_pushY = 0;
    g_pushW = PANEL_W;
    g_pushH = PANEL_H;
    g_pushCount = 1;
}

int emu_fb(void) { return (int)(intptr_t)g_fb; }

int emu_push_count(void) { return g_pushCount; }
int emu_push_x(int i) { (void)i; return g_pushX; }
int emu_push_y(int i) { (void)i; return g_pushY; }
int emu_push_w(int i) { (void)i; return g_pushW; }
int emu_push_h(int i) { (void)i; return g_pushH; }

void emu_touch(int down, int x, int y) { (void)down; (void)x; (void)y; }
void emu_button(int index, int down) { (void)index; (void)down; }
void emu_button_verdict(int index, int isLong) {
    if (index == BTN_A) g_aVerdict = isLong ? 1 : 0;
}
void emu_sensor_event(int index) { (void)index; }

static const char g_deviceJson[] =
    "{"
    "\"name\":\"regression-check-fixture\","
    "\"panel\":{\"w\":64,\"h\":64,\"format\":\"rgb565be\"},"
    "\"buttons\":[{\"id\":\"a\",\"label\":\"A\",\"edge\":\"right\",\"at\":0.5}]"
    "}";

int emu_device(void) { return (int)(intptr_t)g_deviceJson; }
