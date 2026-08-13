/*
 * Hostile firmware #1: emu_fb() hands back a pointer no sane framebuffer
 * could live at (0x7FFFFFFF), regardless of what the declared panel needs.
 *
 * Before src/abiGuard.ts's validateFbPtr existed, this reached
 * bringUp()'s unguarded blitAll() as a raw
 * `new Uint16Array(memory.buffer, 0x7FFFFFFF, ...)`, which throws
 * "RangeError: start offset of Uint16Array should be a multiple of 2" --
 * well after `emu` had already been reassigned to this module. The page
 * showed the device name and then never painted or ticked again, with
 * nothing saying why. See docs/findings-first-adversarial-pass.md.
 *
 * Expected behaviour now: bringUp() never swaps this module in at all.
 * #wasmError shows a message naming emu_fb()'s bad return value; no
 * uncaught page error reaches the browser.
 */
#include "emu_abi.h"
#include <stdint.h>

int emu_init(void) { return 1; }
void emu_tick(uint32_t nowMs) { (void)nowMs; }

int emu_fb(void) { return 0x7FFFFFFF; }

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
    "{\"name\":\"hostile-fb-out-of-bounds\",\"panel\":{\"w\":32,\"h\":32,\"format\":\"rgb565be\"}}";
int emu_device(void) { return (int)(intptr_t)g_deviceJson; }
