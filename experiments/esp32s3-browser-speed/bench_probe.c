/* Throwaway interpreter-throughput probe for the pinned flexe core.
 *
 * This file is staged into a patched flexe checkout by build.ts and compiled
 * together with src/xtensa.c and src/memory.c (plus src/wasm_compat.c for the
 * wasm32-freestanding build). It measures ONE thing: how many real Xtensa
 * instructions per second the pinned interpreter executes on this machine,
 * running the real TinyDraw RGB565 scalar staging kernel in a tight loop.
 *
 * It deliberately reuses the exact CPU setup of the sibling experiment's
 * flexe_wasm_run_data (patch 0001's run_internal): same synthetic call8
 * frame, same source/destination pages, same PS/window state. The only
 * difference: the kernel's return address points at a mapped address inside
 * the code page with a flexe breakpoint on it, so a completed call stops
 * cleanly (no invalid-PC trap, no fprintf) and the harness re-arms and
 * continues until the step budget is spent.
 *
 * No timing model, no trace, no claim beyond host interpreter throughput.
 */

#include <stdbool.h>
#include <stdint.h>
#include <string.h>

#include "memory.h"
#include "xtensa.h"

#if defined(BENCH_NATIVE)
#define BENCH_EXPORT(name)
#else
#define BENCH_EXPORT(name) __attribute__((export_name(name)))
#endif

#define PAGE_BYTES 4096u
#define INITIAL_STACK 0x3fcaffc0u
#define INITIAL_SOURCE 0x3fca1000u
#define INITIAL_DESTINATION 0x3fca2000u
#define WINDOW_CALLINC 2u
#define RUN_CHUNK (1 << 26)

static uint8_t code_input[PAGE_BYTES];
static uint8_t code_page[PAGE_BYTES] __attribute__((aligned(4096)));
static uint8_t source_page[PAGE_BYTES] __attribute__((aligned(4096)));
static uint8_t destination_page[PAGE_BYTES] __attribute__((aligned(4096)));
static uint8_t stack_page[PAGE_BYTES] __attribute__((aligned(4096)));

static xtensa_mem_t *mem;
static xtensa_cpu_t cpu;
static uint32_t bench_pc;
static uint32_t bench_code_length;
static uint32_t bench_pixels;
static uint32_t bench_return_target;

BENCH_EXPORT("bench_input")
uint32_t bench_input(void) {
    return (uint32_t)(uintptr_t)code_input;
}

BENCH_EXPORT("bench_input_capacity")
uint32_t bench_input_capacity(void) {
    return PAGE_BYTES;
}

BENCH_EXPORT("bench_dest")
uint32_t bench_dest(void) {
    return (uint32_t)(uintptr_t)destination_page;
}

BENCH_EXPORT("bench_setup")
uint32_t bench_setup(uint32_t pc, uint32_t code_length, uint32_t pixels) {
    if (code_length == 0 || code_length > PAGE_BYTES) return 1;
    if (pixels == 0 || pixels * 2u > PAGE_BYTES) return 2;
    uint32_t page_offset = pc & (PAGE_BYTES - 1u);
    if (page_offset + code_length > PAGE_BYTES) return 3;
    /* The return target must be a mapped executable byte that the kernel
     * itself does not occupy. The page base is below the kernel entry for
     * every fixture this probe accepts. */
    if (page_offset == 0) return 4;

    if (!mem) mem = mem_create();
    if (!mem) return 5;
    mem_reset(mem);

    memset(code_page, 0, sizeof(code_page));
    memcpy(code_page + page_offset, code_input, code_length);
    for (uint32_t i = 0; i < PAGE_BYTES; i++) {
        source_page[i] = (uint8_t)(i * 31u + 7u);
    }
    memset(destination_page, 0, sizeof(destination_page));
    memset(stack_page, 0, sizeof(stack_page));

    mem->page_table[pc >> 12] = code_page;
    mem->page_table[INITIAL_SOURCE >> 12] = source_page;
    mem->page_table[INITIAL_DESTINATION >> 12] = destination_page;
    mem->page_table[INITIAL_STACK >> 12] = stack_page;

    bench_pc = pc;
    bench_code_length = code_length;
    bench_pixels = pixels;
    bench_return_target = pc & ~(PAGE_BYTES - 1u);
    return 0;
}

static void bench_arm(void) {
    xtensa_cpu_init(&cpu);
    cpu.mem = mem;
    cpu.pc = bench_pc;
    cpu.running = true;
    cpu.ps = (1u << 18) | (WINDOW_CALLINC << 16);
    cpu.windowbase = 0;
    cpu.windowstart = 1;
    cpu.window_callsize[0] = WINDOW_CALLINC;
    cpu.external_exec_begin = bench_pc & ~(PAGE_BYTES - 1u);
    cpu.external_exec_end = cpu.external_exec_begin + PAGE_BYTES;
    cpu.breakpoints[0] = bench_return_target;
    cpu.breakpoint_count = 1;
    ar_write(&cpu, 1, INITIAL_STACK);
    ar_write(&cpu, 8, (WINDOW_CALLINC << 30) | (bench_return_target & 0x3fffffffu));
    ar_write(&cpu, 10, INITIAL_SOURCE);
    ar_write(&cpu, 11, INITIAL_DESTINATION);
    ar_write(&cpu, 12, bench_pixels);
}

/* Run one complete kernel call and return its exact instruction count, or
 * zero if the call did not stop at the expected return breakpoint. */
BENCH_EXPORT("bench_call_steps")
uint32_t bench_call_steps(void) {
    if (!mem || bench_pc == 0) return 0;
    bench_arm();
    uint32_t executed = 0;
    while (executed < (1u << 24)) {
        int stepped = xtensa_run(&cpu, RUN_CHUNK);
        if (stepped < 0) return 0;
        executed += (uint32_t)stepped;
        if (cpu.breakpoint_hit) return executed;
        if (!cpu.running) return 0;
        if (stepped == 0) return 0;
    }
    return 0;
}

/* Execute approximately `budget` instructions by running the armed kernel to
 * completion repeatedly. Returns the number of instructions actually
 * executed, or zero on any unexpected stop. */
BENCH_EXPORT("bench_run")
uint32_t bench_run(uint32_t budget) {
    if (!mem || bench_pc == 0 || budget == 0 || budget > 0x7fffffffu) return 0;
    uint32_t executed = 0;
    bench_arm();
    while (executed < budget) {
        uint32_t remaining = budget - executed;
        int chunk = remaining > RUN_CHUNK ? RUN_CHUNK : (int)remaining;
        int stepped = xtensa_run(&cpu, chunk);
        if (stepped < 0) return 0;
        executed += (uint32_t)stepped;
        if (cpu.breakpoint_hit) {
            bench_arm();
            continue;
        }
        if (!cpu.running) return 0;
        if (stepped == 0 && cpu.pc != bench_return_target) return 0;
    }
    return executed;
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
    if (argc != 5) {
        fprintf(stderr, "usage: %s <code-file> <pc-hex> <pixels> <budget>\n", argv[0]);
        return 2;
    }
    FILE *file = fopen(argv[1], "rb");
    if (!file) {
        fprintf(stderr, "cannot open %s\n", argv[1]);
        return 2;
    }
    size_t length = fread(code_input, 1, sizeof(code_input), file);
    fclose(file);
    uint32_t pc = (uint32_t)strtoul(argv[2], NULL, 16);
    uint32_t pixels = (uint32_t)strtoul(argv[3], NULL, 10);
    uint32_t budget = (uint32_t)strtoul(argv[4], NULL, 10);
    uint32_t setup = bench_setup(pc, (uint32_t)length, pixels);
    if (setup != 0) {
        fprintf(stderr, "bench_setup failed: %u\n", setup);
        return 2;
    }
    uint32_t per_call = bench_call_steps();
    /* Warmup, then timed run. */
    bench_run(budget / 4u);
    double start = now_seconds();
    uint32_t executed = bench_run(budget);
    double elapsed = now_seconds() - start;
    printf("{\"perCall\":%u,\"executed\":%u,\"seconds\":%.6f,\"mips\":%.2f}\n",
           per_call, executed, elapsed, executed / elapsed / 1e6);
    return executed == 0 ? 1 : 0;
}
#endif
