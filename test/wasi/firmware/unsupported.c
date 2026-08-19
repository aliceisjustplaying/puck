/*
 * The negative half of the WASI-lite fixture: a module importing two
 * wasi_snapshot_preview1 symbols this emulator deliberately does NOT
 * shim (fd_read, args_get). Loading it must fail with an error that names
 * both, and must fail BEFORE instantiation rather than at the first call,
 * because a stub returning zero would turn "this host cannot do that" into
 * wrong behaviour discovered much later. See
 * docs/decisions/0004-wasi-lite-not-wasi.md.
 *
 * Kept to the minimum a wasm module needs to exist at all: the load is
 * refused long before any of these exports would be called.
 */

#include <stdint.h>

#define WASI_IMPORT(name) __attribute__((import_module("wasi_snapshot_preview1"), import_name(name)))

/* Exported to the host by name from the source itself, so the build command
 * carries no -Wl,--export= flags: zig cc's wasm linker crashes on a pile of
 * those, deterministically when it is invoked from a nested bun process (the
 * shape `bun run test:wasi` produces). See
 * test/fixtures/external-app/README.md for the measurement. */
#define EXPORT(name) __attribute__((export_name(name)))

typedef struct {
    void *buf;
    uint32_t buf_len;
} wasi_iovec_t;

WASI_IMPORT("fd_read") extern int32_t fd_read(int32_t fd, const wasi_iovec_t *iovs, int32_t iovs_len, uint32_t *nread);
WASI_IMPORT("args_get") extern int32_t args_get(uint8_t **argv, uint8_t *argv_buf);

static uint16_t g_fb[8 * 8];
static uint8_t g_scratch[8];

EXPORT("emu_device") const char *emu_device(void) {
    return "{\"name\":\"wasi-unsupported\",\"panel\":{\"w\":8,\"h\":8,\"format\":\"rgb565be\"}}";
}

EXPORT("emu_init") int emu_init(void) {
    wasi_iovec_t iov;
    uint32_t n = 0;
    iov.buf = (void *)g_scratch;
    iov.buf_len = sizeof(g_scratch);
    fd_read(0, &iov, 1, &n);
    args_get((uint8_t **)0, g_scratch);
    return 1;
}

EXPORT("emu_tick") void emu_tick(uint32_t nowMs) { (void)nowMs; }
EXPORT("emu_fb") uint16_t *emu_fb(void) { return g_fb; }
EXPORT("emu_push_count") int emu_push_count(void) { return 0; }
EXPORT("emu_push_x") int emu_push_x(int i) { (void)i; return 0; }
EXPORT("emu_push_y") int emu_push_y(int i) { (void)i; return 0; }
EXPORT("emu_push_w") int emu_push_w(int i) { (void)i; return 0; }
EXPORT("emu_push_h") int emu_push_h(int i) { (void)i; return 0; }
EXPORT("emu_touch") void emu_touch(int down, int x, int y) { (void)down; (void)x; (void)y; }
EXPORT("emu_button") void emu_button(int index, int down) { (void)index; (void)down; }
EXPORT("emu_button_verdict") void emu_button_verdict(int index, int isLong) { (void)index; (void)isLong; }
EXPORT("emu_sensor_event") void emu_sensor_event(int index) { (void)index; }
