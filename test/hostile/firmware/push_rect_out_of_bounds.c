/*
 * Hostile firmware #3: the module comes up cleanly and paints a normal
 * first tick, then on the SECOND tick reports a push rectangle at
 * y=1000000 -- far outside the declared panel. From the third tick
 * onward it goes back to reporting a normal, valid push, so a passing
 * test here proves not just "didn't crash once" but "kept ticking and
 * painting correctly afterward."
 *
 * Before src/panel.ts's readPushes validated each rectangle, this reached
 * the requestAnimationFrame callback as a raw
 * `new Uint16Array(memory.buffer, fbPtr, panelW * (y + h))`, "RangeError:
 * invalid typed array length." The page had already loaded and painted a
 * normal first frame, so nothing on screen suggested anything was wrong --
 * the tick counter just silently stopped forever. This is the worst of
 * the four in docs/findings-first-adversarial-pass.md, and the whole
 * reason "the tick loop must not be able to die silently" is requirement
 * #1 of the fix.
 *
 * Expected behaviour now: the bad rectangle is skipped and reported as a
 * "firmware bug:" console line; ticking and painting continue normally
 * afterward; #wasmError and #engineDead both stay hidden; no uncaught page
 * error reaches the browser.
 */
#include "emu_abi.h"
#include <stdint.h>

#define PANEL_W 32
#define PANEL_H 32
static uint16_t g_fb[PANEL_W * PANEL_H];
static uint32_t g_tick = 0;
static int g_pushCount = 0;
static int g_pushX[1], g_pushY[1], g_pushW[1], g_pushH[1];

int emu_init(void) {
    for (int i = 0; i < PANEL_W * PANEL_H; i++) g_fb[i] = 0xFFFF;
    return 1;
}

void emu_tick(uint32_t nowMs) {
    (void)nowMs;
    g_tick++;
    g_pushX[0] = 0;
    g_pushW[0] = 4;
    g_pushH[0] = 4;
    if (g_tick == 2) {
        g_pushY[0] = 1000000; /* the hostile rectangle, second tick only */
    } else {
        g_pushY[0] = 0;
    }
    g_pushCount = 1;
}

int emu_fb(void) { return (int)(intptr_t)g_fb; }

int emu_push_count(void) { return g_pushCount; }
int emu_push_x(int i) { (void)i; return g_pushX[0]; }
int emu_push_y(int i) { (void)i; return g_pushY[0]; }
int emu_push_w(int i) { (void)i; return g_pushW[0]; }
int emu_push_h(int i) { (void)i; return g_pushH[0]; }

void emu_touch(int down, int x, int y) { (void)down; (void)x; (void)y; }
void emu_button(int index, int down) { (void)index; (void)down; }
void emu_button_verdict(int index, int isLong) { (void)index; (void)isLong; }
void emu_sensor_event(int index) { (void)index; }

static const char g_deviceJson[] =
    "{\"name\":\"hostile-push-rect-out-of-bounds\",\"panel\":{\"w\":32,\"h\":32,\"format\":\"rgb565be\"}}";
int emu_device(void) { return (int)(intptr_t)g_deviceJson; }
