/*
 * Hostile firmware #6: emu_button() writes through a wild pointer the
 * instant the declared button is pressed down. This is the case the tick-
 * loop guard's own first pass scoped out on purpose and said so: a button
 * press is a direct ABI call from a DOM event handler (device.ts's
 * wireButton -> main.ts's emuButtonDown), never inside the self-
 * rescheduling requestAnimationFrame loop, so it cannot produce the
 * silent-freeze failure mode stepOnce's guard exists for. But it is still
 * the same class of unguarded direct ABI call, with its own bad outcome:
 * without a guard here, the page would show an uncaught exception (or, at
 * best, a button that silently does nothing forever), not the tick loop
 * quietly dying.
 *
 * Before main.ts's guardedAbiCall existed, pressing this button reached the
 * browser as a raw, uncaught wasm RuntimeError from inside the
 * pointerdown handler. Expected behaviour now: main.ts's emuButtonDown
 * calls emu_button() through guardedAbiCall, which catches the trap and
 * enters the SAME #engineDead state a tick-loop trap would (see
 * guardedAbiCall's own header comment for why a trap is a trap regardless
 * of which export it happened in) -- named "button[0] down" rather than
 * "tick N", ticking stops, and no uncaught page error reaches the browser.
 */
#include "emu_abi.h"
#include <stdint.h>

#define PANEL_W 32
#define PANEL_H 32
static uint16_t g_fb[PANEL_W * PANEL_H];

int emu_init(void) {
    for (int i = 0; i < PANEL_W * PANEL_H; i++) g_fb[i] = 0;
    return 1;
}

void emu_tick(uint32_t nowMs) { (void)nowMs; }

int emu_fb(void) { return (int)(intptr_t)g_fb; }

int emu_push_count(void) { return 0; }
int emu_push_x(int i) { (void)i; return 0; }
int emu_push_y(int i) { (void)i; return 0; }
int emu_push_w(int i) { (void)i; return 0; }
int emu_push_h(int i) { (void)i; return 0; }

void emu_touch(int down, int x, int y) { (void)down; (void)x; (void)y; }

void emu_button(int index, int down) {
    (void)index;
    if (down) {
        volatile int *wild = (volatile int *)(uintptr_t)0xFFFFFFF0u;
        *wild = 7; /* real wasm trap: nothing is mapped at this address */
    }
}
void emu_button_verdict(int index, int isLong) { (void)index; (void)isLong; }
void emu_sensor_event(int index) { (void)index; }

static const char g_deviceJson[] =
    "{\"name\":\"hostile-button-trap\",\"panel\":{\"w\":32,\"h\":32,\"format\":\"rgb565be\"},"
    "\"buttons\":[{\"id\":\"a\",\"label\":\"A\",\"edge\":\"right\",\"at\":0.5}]}";
int emu_device(void) { return (int)(intptr_t)g_deviceJson; }
