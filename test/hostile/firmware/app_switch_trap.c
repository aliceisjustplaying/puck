/*
 * Hostile firmware #7: emu_app_switch() writes through a wild pointer when
 * switching to app index 1 (index 0, the initial app, is left harmless so
 * the module comes up cleanly and only traps once someone actually clicks
 * the second app-strip button). Same shape and same reasoning as
 * button_trap.c: a direct ABI call from a DOM event handler
 * (appstrip.ts's click listener), never inside the tick loop, so it needs
 * its own guard rather than relying on stepOnce's.
 *
 * Before main.ts's guardedAbiCall existed (and appstrip.ts's click
 * listener called emu.emu_app_switch() directly, with nothing wrapping
 * it), clicking the second app-strip button reached the browser as a raw,
 * uncaught wasm RuntimeError. Expected behaviour now: the click goes
 * through guardedCall (appstrip.ts) -> guardedAbiCall (main.ts), which
 * catches the trap and enters #engineDead named "app switch to 1" -- the
 * whole engine is declared dead, not just "this app didn't load", because
 * per the wasm spec a trap in ANY export leaves the module's own memory
 * equally suspect, regardless of which export it happened in.
 */
#include "emu_abi.h"
#include <stdint.h>

#define PANEL_W 32
#define PANEL_H 32
static uint16_t g_fb[PANEL_W * PANEL_H];
static int g_currentApp = 0;

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
void emu_button(int index, int down) { (void)index; (void)down; }
void emu_button_verdict(int index, int isLong) { (void)index; (void)isLong; }
void emu_sensor_event(int index) { (void)index; }

int emu_app_current(void) { return g_currentApp; }
void emu_app_switch(int index) {
    if (index == 1) {
        volatile int *wild = (volatile int *)(uintptr_t)0xFFFFFFF0u;
        *wild = 9; /* real wasm trap: nothing is mapped at this address */
    }
    g_currentApp = index;
}

static const char g_deviceJson[] =
    "{\"name\":\"hostile-app-switch-trap\",\"panel\":{\"w\":32,\"h\":32,\"format\":\"rgb565be\"},"
    "\"apps\":[\"one\",\"two\"]}";
int emu_device(void) { return (int)(intptr_t)g_deviceJson; }
