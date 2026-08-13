/*
 * Hostile firmware #5: declares sound support, and every 20 ticks bumps
 * emu_sound_play_seq() while emu_sound_frames() claims 100,000,000 frames
 * -- a 200MB region that could never fit in this tiny module's own linear
 * memory, no matter where emu_sound_buffer() points.
 *
 * Found by inspection during the first adversarial pass, not built at the
 * time: src/audio.ts's play() constructed `new Int16Array(memory.buffer,
 * framesPtr, frameCount)` straight from these ABI-returned values, with no
 * bounds checking, every tick a play event fires. Same shape as the other
 * four, same fix (src/abiGuard.ts's validateAudioBuffer, called from
 * audio.ts's play() before any typed array is built).
 *
 * Expected behaviour now: the bad sound_play() call is skipped and
 * reported as a "firmware bug:" console line; ticking, painting and (for
 * a well-behaved sound event) playback all continue normally otherwise; no
 * uncaught page error reaches the browser.
 */
#include "emu_abi.h"
#include <stdint.h>

#define PANEL_W 32
#define PANEL_H 32
static uint16_t g_fb[PANEL_W * PANEL_H];
static uint32_t g_tick = 0;
static uint32_t g_playSeq = 0;
static uint32_t g_stopSeq = 0;

int emu_init(void) {
    for (int i = 0; i < PANEL_W * PANEL_H; i++) g_fb[i] = 0;
    return 1;
}

void emu_tick(uint32_t nowMs) {
    (void)nowMs;
    g_tick++;
    if (g_tick > 0 && g_tick % 20 == 0) g_playSeq++;
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

int      emu_sound_sample_rate(void) { return 8000; }
uint32_t emu_sound_play_seq(void) { return g_playSeq; }
uint32_t emu_sound_stop_seq(void) { return g_stopSeq; }
int      emu_sound_buffer(void) { return 0; }
int      emu_sound_frames(void) { return 100000000; } /* absurd: far past this module's own memory */

static const char g_deviceJson[] =
    "{\"name\":\"hostile-audio-bad-buffer\",\"panel\":{\"w\":32,\"h\":32,\"format\":\"rgb565be\"}}";
int emu_device(void) { return (int)(intptr_t)g_deviceJson; }
