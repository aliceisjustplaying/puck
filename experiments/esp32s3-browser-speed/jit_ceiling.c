/* Throwaway JIT-ceiling model.
 *
 * Approximates the code a wasm-emitting JIT would generate for the TinyDraw
 * RGB565 scalar staging kernel, with cycle accounting inlined the way a
 * cycle-tracking JIT must inline it:
 *
 *   - the guest register file lives in memory (ar[]), and every emulated
 *     instruction round-trips its operands through it, which is what
 *     straightforward per-instruction JIT output does;
 *   - every emulated load and store performs an inlined direct-mapped
 *     D-cache tag check (ESP32-S3 geometry: 32 KiB, 64-byte lines as the
 *     index space of a one-way model) and charges a miss cost;
 *   - every emulated instruction adds its issue cost to a cycle counter.
 *
 * This is a CEILING estimate for interpreter-replacement throughput, not an
 * emulator: eight fixed emulated instructions per pixel, no decode, no
 * window model, no exceptions. A real JIT block would carry more guard code
 * (window checks, interrupt polls at block edges), so the true number lies
 * between the interpreter measurement and this one.
 *
 * Compiled standalone to wasm32-freestanding and natively. No libc calls.
 */

#include <stdint.h>

#if defined(BENCH_NATIVE)
#define BENCH_EXPORT(name)
#else
#define BENCH_EXPORT(name) __attribute__((export_name(name)))
#endif

#define GUEST_SOURCE 0x3fca1000u
#define GUEST_DESTINATION 0x3fca2000u
#define DCACHE_LINES 512u
#define DCACHE_LINE_SHIFT 6u
#define MISS_CYCLES 82u /* profile's calibrated PSRAM first-line fill */

static uint32_t ar[16];
static uint8_t guest_src[4096];
static uint8_t guest_dst[4096];
static uint32_t dcache_tag[DCACHE_LINES];
static uint64_t cycles;
static uint32_t jit_pixels;

BENCH_EXPORT("jit_setup")
uint32_t jit_setup(uint32_t pixels) {
    if (pixels == 0 || pixels * 2u > sizeof(guest_src)) return 1;
    jit_pixels = pixels;
    for (uint32_t i = 0; i < sizeof(guest_src); i++) {
        guest_src[i] = (uint8_t)(i * 31u + 7u);
        guest_dst[i] = 0;
    }
    for (uint32_t i = 0; i < DCACHE_LINES; i++) dcache_tag[i] = 0xffffffffu;
    cycles = 0;
    return 0;
}

static inline void dcache_access(uint32_t guest_address) {
    uint32_t line = guest_address >> DCACHE_LINE_SHIFT;
    uint32_t index = line & (DCACHE_LINES - 1u);
    if (dcache_tag[index] != line) {
        dcache_tag[index] = line;
        cycles += MISS_CYCLES;
    }
}

/* One emulated kernel call: entry overhead plus, per pixel, the eight
 * instructions of the measured scalar loop body (load, three ALU ops, store,
 * two pointer updates, loop). */
BENCH_EXPORT("jit_run")
uint32_t jit_run(uint32_t iterations) {
    if (jit_pixels == 0 || iterations == 0) return 0;
    for (uint32_t call = 0; call < iterations; call++) {
        ar[10] = 0;
        ar[11] = 0;
        ar[12] = jit_pixels;
        cycles += 3;
#pragma clang loop vectorize(disable) unroll(disable)
        while (ar[12] != 0) {
            uint32_t src_offset = ar[10];
            dcache_access(GUEST_SOURCE + src_offset);
            uint32_t low = guest_src[src_offset];
            ar[2] = low;
            uint32_t high = guest_src[src_offset + 1u];
            ar[3] = high;
            uint32_t swapped = (ar[2] << 8) | ar[3]; /* ar[2]=low, ar[3]=high; swapped low byte = high */
            ar[4] = swapped;
            uint32_t dst_offset = ar[11];
            dcache_access(GUEST_DESTINATION + dst_offset);
            guest_dst[dst_offset] = (uint8_t)ar[4]; /* high source byte first */
            guest_dst[dst_offset + 1u] = (uint8_t)(ar[4] >> 8);
            ar[10] = src_offset + 2u;
            ar[11] = dst_offset + 2u;
            ar[12] -= 1u;
            cycles += 8;
        }
    }
    return guest_dst[0] | ((uint32_t)guest_dst[1] << 8);
}

BENCH_EXPORT("jit_cycles_lo")
uint32_t jit_cycles_lo(void) {
    return (uint32_t)cycles;
}

BENCH_EXPORT("jit_cycles_hi")
uint32_t jit_cycles_hi(void) {
    return (uint32_t)(cycles >> 32);
}

BENCH_EXPORT("jit_dest")
uint32_t jit_dest(void) {
    return (uint32_t)(uintptr_t)guest_dst;
}

#if defined(BENCH_NATIVE)
#include <stdio.h>
#include <stdlib.h>
#include <time.h>

static double now_seconds(void) {
    struct timespec ts;
    clock_gettime(CLOCK_MONOTONIC, &ts);
    return (double)ts.tv_sec + (double)ts.tv_nsec / 1e9;
}

int main(int argc, char **argv) {
    if (argc != 3) {
        fprintf(stderr, "usage: %s <pixels> <iterations>\n", argv[0]);
        return 2;
    }
    uint32_t pixels = (uint32_t)strtoul(argv[1], NULL, 10);
    uint32_t iterations = (uint32_t)strtoul(argv[2], NULL, 10);
    if (jit_setup(pixels) != 0) return 2;
    jit_run(iterations / 4u + 1u);
    jit_setup(pixels);
    double start = now_seconds();
    uint32_t check = jit_run(iterations);
    double elapsed = now_seconds() - start;
    double emulated = (double)iterations * (8.0 * pixels + 3.0);
    printf("{\"check\":%u,\"seconds\":%.6f,\"emulatedMips\":%.2f}\n",
           check, elapsed, emulated / elapsed / 1e6);
    return 0;
}
#endif
