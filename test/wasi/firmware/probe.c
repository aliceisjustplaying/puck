/*
 * A firmware that deliberately imports wasi_snapshot_preview1, to prove
 * this emulator's WASI-lite shims (src/wasiLite.ts) exist, are wired to
 * the right places, and are deterministic. Test material, not an example
 * to copy: a firmware written for this ABI needs NO wasi imports at all
 * (see example/firmware/main.c, which imports only env.js_log). This one
 * stands in for what some toolchains emit whether the program asked for
 * it or not.
 *
 * Deliberately declared with clang's import_module/import_name attributes
 * rather than by linking a WASI libc: that is the only way to control,
 * exactly and visibly, WHICH wasi symbols this module ends up importing,
 * which is the whole point of a test about a supported subset.
 *
 * What it does, all of it observable from a replay:
 *   - emu_init writes one line to fd 1 (stdout) with fd_write
 *   - every tick reads clock_time_get and logs the millisecond it got,
 *     so a test can assert the clock follows emu_tick's own nowMs
 *   - every tick draws an 8x8 square whose colour comes from three
 *     random_get bytes, so two replays with the same seed produce
 *     identical pixels and two different seeds do not
 *   - pressing button 0 makes the NEXT tick call proc_exit(3)
 */

#include <stdbool.h>
#include <stdint.h>

/* ---- the four wasi_snapshot_preview1 imports this emulator supports ---- */

#define WASI_IMPORT(name) __attribute__((import_module("wasi_snapshot_preview1"), import_name(name)))

typedef struct {
    const void *buf;
    uint32_t buf_len;
} wasi_iovec_t;

WASI_IMPORT("fd_write") extern int32_t fd_write(int32_t fd, const wasi_iovec_t *iovs, int32_t iovs_len, uint32_t *nwritten);
WASI_IMPORT("clock_time_get") extern int32_t clock_time_get(int32_t clock_id, uint64_t precision, uint64_t *out);
WASI_IMPORT("random_get") extern int32_t random_get(void *buf, uint32_t buf_len);
WASI_IMPORT("proc_exit") extern void proc_exit(int32_t code);

/* ---- a tiny stdout, since there is no libc here ----------------------- */

static int str_len(const char *s) {
    int n = 0;
    while (s[n]) n++;
    return n;
}

static void write_out(const char *s, int len) {
    wasi_iovec_t iov;
    uint32_t written = 0;
    iov.buf = (const void *)s;
    iov.buf_len = (uint32_t)len;
    fd_write(1, &iov, 1, &written);
}

static char g_line[64];

/* Appends an unsigned decimal to g_line at `at`, returns the new length. */
static int put_u32(int at, uint32_t v) {
    char digits[10];
    int n = 0;
    if (v == 0) digits[n++] = '0';
    while (v > 0 && n < 10) {
        digits[n++] = (char)('0' + (v % 10));
        v /= 10;
    }
    while (n > 0) g_line[at++] = digits[--n];
    return at;
}

static int put_str(int at, const char *s) {
    int i = 0;
    while (s[i]) g_line[at++] = s[i++];
    return at;
}

/* ---- panel ------------------------------------------------------------ */

#define PANEL_W 64
#define PANEL_H 64

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

/* ---- push windows ----------------------------------------------------- */

#define MAX_PUSHES 4
static int g_pushX[MAX_PUSHES], g_pushY[MAX_PUSHES], g_pushW[MAX_PUSHES], g_pushH[MAX_PUSHES];
static int g_pushCount = 0;

static void record_push(int x, int y, int w, int h) {
    if (g_pushCount >= MAX_PUSHES) return;
    g_pushX[g_pushCount] = x;
    g_pushY[g_pushCount] = y;
    g_pushW[g_pushCount] = w;
    g_pushH[g_pushCount] = h;
    g_pushCount++;
}

/* ---- state ------------------------------------------------------------ */

static bool g_exitRequested = false;

/* ---- emu_abi.h ---------------------------------------------------------
 * emu_abi.h itself is not included: this fixture is deliberately
 * self-contained so it compiles with nothing but a C compiler and a
 * target, exactly like an external app's own source would.
 * ---------------------------------------------------------------------- */

const char *emu_device(void) {
    return "{\"name\":\"wasi-probe\",\"panel\":{\"w\":64,\"h\":64,\"format\":\"rgb565be\"},"
           "\"buttons\":[{\"id\":\"exit\",\"label\":\"EXIT\",\"edge\":\"right\",\"at\":0.5}]}";
}

int emu_init(void) {
    fill_rect(0, 0, PANEL_W, PANEL_H, rgb565be(0xff, 0xff, 0xff));
    write_out("wasi probe: init\n", str_len("wasi probe: init\n"));
    return 1;
}

void emu_tick(uint32_t nowMs) {
    (void)nowMs; /* read back through clock_time_get instead, on purpose */
    g_pushCount = 0;

    if (g_exitRequested) {
        write_out("wasi probe: exiting\n", str_len("wasi probe: exiting\n"));
        proc_exit(3);
        return; /* never reached: proc_exit does not return */
    }

    uint64_t ns = 0;
    clock_time_get(0, 0, &ns);
    uint32_t ms = (uint32_t)(ns / 1000000u);
    int len = put_str(0, "clock=");
    len = put_u32(len, ms);
    g_line[len++] = '\n';
    write_out(g_line, len);

    uint8_t rnd[3] = { 0, 0, 0 };
    random_get(rnd, 3);
    fill_rect(0, 0, 8, 8, rgb565be(rnd[0], rnd[1], rnd[2]));
    record_push(0, 0, 8, 8);
}

uint16_t *emu_fb(void) { return g_fb; }

int emu_push_count(void) { return g_pushCount; }
int emu_push_x(int i) { return (i >= 0 && i < g_pushCount) ? g_pushX[i] : 0; }
int emu_push_y(int i) { return (i >= 0 && i < g_pushCount) ? g_pushY[i] : 0; }
int emu_push_w(int i) { return (i >= 0 && i < g_pushCount) ? g_pushW[i] : 0; }
int emu_push_h(int i) { return (i >= 0 && i < g_pushCount) ? g_pushH[i] : 0; }

void emu_touch(int down, int x, int y) { (void)down; (void)x; (void)y; }

void emu_button(int index, int down) {
    if (index == 0 && down) g_exitRequested = true;
}

void emu_button_verdict(int index, int isLong) { (void)index; (void)isLong; }
void emu_sensor_event(int index) { (void)index; }
