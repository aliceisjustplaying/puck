/*
 * Hostile firmware #2: emu_device()'s JSON declares a "sensors" entry with
 * no "id" field.
 *
 * Before src/wasm.ts's readDeviceDescriptor validated sensor shape, this
 * reached main.ts's buildChrome() as `s.id.toLowerCase()` on an undefined
 * `s.id`, a raw TypeError, again after `emu` had already been reassigned.
 * See docs/findings-first-adversarial-pass.md.
 *
 * Expected behaviour now: readDeviceDescriptor() throws BEFORE bringUp()
 * ever swaps this module in. #wasmError shows a message naming
 * sensors[0]'s missing "id"; no uncaught page error reaches the browser.
 */
#include "emu_abi.h"
#include <stdint.h>

static uint16_t g_fb[32 * 32];

int emu_init(void) {
    for (int i = 0; i < 32 * 32; i++) g_fb[i] = 0;
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
void emu_button(int index, int down) { (void)index; (void)down; }
void emu_button_verdict(int index, int isLong) { (void)index; (void)isLong; }
void emu_sensor_event(int index) { (void)index; }

static const char g_deviceJson[] =
    "{\"name\":\"hostile-sensor-missing-id\",\"panel\":{\"w\":32,\"h\":32,\"format\":\"rgb565be\"},"
    "\"sensors\":[{\"kind\":\"event\",\"label\":\"Shake\"}]}";
int emu_device(void) { return (int)(intptr_t)g_deviceJson; }
