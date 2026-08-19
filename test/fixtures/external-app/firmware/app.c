/*
 * A whole app, in one file, from a repository that is not puck.
 *
 * This is the fixture behind "an external port is verified exactly like
 * any other" (docs/decisions/0005-external-ports-are-reproduced.md): it
 * stands in for an app whose author keeps their own source, their own
 * build and their own history somewhere else, and lists a puck bundle
 * that points at it. Nothing here includes emu_abi.h or any other file
 * from puck, on purpose: what an external app depends on is the ABI, not
 * this repository's tree.
 *
 * What it draws: a 32x32 panel, and a 6x6 square that steps one cell to
 * the right every 100ms, wrapping. Deterministic in nowMs alone (no
 * randomness, no wall clock), so the same trace always produces the same
 * frames, which is what makes recorded frames a real check.
 */

#include <stdint.h>

/* Exported to the host by name, in the source rather than through a pile of
 * -Wl,--export= linker flags: fewer moving parts in the build command, and
 * the export list cannot drift from the functions it names. */
#define EXPORT(name) __attribute__((export_name(name)))

#define PANEL_W 32
#define PANEL_H 32
#define BOX 6
#define STEP_MS 100

static uint16_t g_fb[PANEL_W * PANEL_H];

static uint16_t rgb565be(uint8_t r, uint8_t g, uint8_t b) {
    uint16_t v = (uint16_t)(((r >> 3) << 11) | ((g >> 2) << 5) | (b >> 3));
    return (uint16_t)((v >> 8) | (v << 8));
}

static void fill_rect(int x, int y, int w, int h, uint16_t color) {
    if (x < 0) { w += x; x = 0; }
    if (y < 0) { h += y; y = 0; }
    if (x + w > PANEL_W) w = PANEL_W - x;
    if (y + h > PANEL_H) h = PANEL_H - y;
    if (w <= 0 || h <= 0) return;
    for (int row = 0; row < h; row++) {
        uint16_t *line = &g_fb[(y + row) * PANEL_W + x];
        for (int col = 0; col < w; col++) line[col] = color;
    }
}

static int g_pushX = 0, g_pushY = 0, g_pushW = 0, g_pushH = 0;
static int g_pushCount = 0;

static int g_touchY = PANEL_H / 2 - BOX / 2;

EXPORT("emu_device") const char *emu_device(void) {
    return "{\"name\":\"external-fixture\",\"panel\":{\"w\":32,\"h\":32,\"format\":\"rgb565be\"},"
           "\"buttons\":[{\"id\":\"a\",\"label\":\"A\",\"edge\":\"right\",\"at\":0.5}]}";
}

EXPORT("emu_init") int emu_init(void) {
    fill_rect(0, 0, PANEL_W, PANEL_H, rgb565be(0x10, 0x10, 0x18));
    return 1;
}

EXPORT("emu_tick") void emu_tick(uint32_t nowMs) {
    int x = (int)((nowMs / STEP_MS) % (uint32_t)(PANEL_W - BOX + 1));
    fill_rect(0, 0, PANEL_W, PANEL_H, rgb565be(0x10, 0x10, 0x18));
    fill_rect(x, g_touchY, BOX, BOX, rgb565be(0xe0, 0x60, 0x30));
    g_pushX = 0;
    g_pushY = 0;
    g_pushW = PANEL_W;
    g_pushH = PANEL_H;
    g_pushCount = 1;
}

EXPORT("emu_fb") uint16_t *emu_fb(void) { return g_fb; }

EXPORT("emu_push_count") int emu_push_count(void) { return g_pushCount; }
EXPORT("emu_push_x") int emu_push_x(int i) { (void)i; return g_pushX; }
EXPORT("emu_push_y") int emu_push_y(int i) { (void)i; return g_pushY; }
EXPORT("emu_push_w") int emu_push_w(int i) { (void)i; return g_pushW; }
EXPORT("emu_push_h") int emu_push_h(int i) { (void)i; return g_pushH; }

/* Touch moves the row the square travels along, so a trace with input in
 * it produces different frames from one without. */
EXPORT("emu_touch") void emu_touch(int down, int x, int y) {
    (void)x;
    if (!down) return;
    int top = y - BOX / 2;
    if (top < 0) top = 0;
    if (top > PANEL_H - BOX) top = PANEL_H - BOX;
    g_touchY = top;
}

EXPORT("emu_button") void emu_button(int index, int down) { (void)index; (void)down; }
EXPORT("emu_button_verdict") void emu_button_verdict(int index, int isLong) { (void)index; (void)isLong; }
EXPORT("emu_sensor_event") void emu_sensor_event(int index) { (void)index; }
