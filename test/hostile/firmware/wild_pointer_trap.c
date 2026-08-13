/*
 * Hostile firmware #4: emu_tick() writes through a wild pointer on its
 * first call, well past this module's own linear memory. This is a
 * genuine wasm trap ("RuntimeError: memory access out of bounds"), not a
 * JS-side type or range error -- no boundary validation on the host side
 * can ever prevent this, because it happens entirely inside the module's
 * own compiled code. This is exactly the case src/main.ts's
 * enterDeadState/stepOnce try-catch exists for.
 *
 * Before that guard existed, this reached the requestAnimationFrame
 * callback unguarded, identical in outcome to hostile firmware #3: the
 * page looked fine, then silently stopped ticking forever with nothing
 * saying why. See docs/findings-first-adversarial-pass.md.
 *
 * Expected behaviour now: the tick loop catches the trap, stops ticking
 * (the loop does not call emu_tick() again), and shows a distinct
 * #engineDead banner naming the exception, the tick it died on and the
 * last input event delivered -- visibly different from #wasmError (the
 * module DID come up first) and from a merely-frozen firmware (the panel
 * gets a hazard overlay painted over it). No uncaught page error reaches
 * the browser: the trap is caught, not left to escape.
 */
#include "emu_abi.h"
#include <stdint.h>

#define PANEL_W 32
#define PANEL_H 32
static uint16_t g_fb[PANEL_W * PANEL_H];
static uint32_t g_tick = 0;

int emu_init(void) {
    for (int i = 0; i < PANEL_W * PANEL_H; i++) g_fb[i] = 0;
    return 1;
}

void emu_tick(uint32_t nowMs) {
    (void)nowMs;
    g_tick++;
    if (g_tick == 1) {
        volatile int *wild = (volatile int *)(uintptr_t)0xFFFFFFF0u;
        *wild = 42; /* real wasm trap: nothing is mapped at this address */
    }
}

int emu_fb(void) { return (int)(intptr_t)g_fb; }

int emu_push_count(void) { return 0; }
int emu_push_x(int i) { (void)i; return 0; }
int emu_push_y(int i) { (void)i; return 0; }
int emu_push_w(int i) { (void)i; return 0; }
int emu_push_h(int i) { (void)i; return 0; }

void emu_touch(int down, int x, int y) { (void)down; (void)x; (void)y; }
void emu_button(int index, int down) { (void)index; (void)down; }
void emu_button_verdict(int index, int isLong) { (void)index; (void)isLong; }
void emu_sensor_event(int index) { (void)index; }

static const char g_deviceJson[] =
    "{\"name\":\"hostile-wild-pointer-trap\",\"panel\":{\"w\":32,\"h\":32,\"format\":\"rgb565be\"}}";
int emu_device(void) { return (int)(intptr_t)g_deviceJson; }
