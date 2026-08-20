/*
 * string.h: a stand-in, same idea and same reason as this pack's own
 * packs/rp2350-touch-amoled-18/wasm/shim/{math,stdio,stdlib}.h (see those
 * files' own header comments): zig 0.16's wasm32-freestanding target ships
 * no <string.h> at all ("file not found", confirmed empirically by actually
 * building, not assumed from docs) - that tracks the C standard's own split,
 * a freestanding implementation is only required to provide <stddef.h>,
 * <stdint.h>, <stdbool.h>, <stdarg.h> and a few others, not <string.h>.
 *
 * gos_runtime.c and the vendored ../../reference/esp32-gameos/{gunship,slots}.c
 * `#include <string.h>` as real, unmodified code (the game files are a
 * byte-for-byte donor snapshot, never edited to route around this - see
 * NOTICE.md) and between them call exactly memset()/memcpy() (checked by
 * grep over both files, not guessed). This directory is on the include path
 * for exactly this purpose - packs/rp2350-touch-amoled-18/wasm/build.ts's
 * --app mode adds dirname(APP_PATH) "so a ported app living outside
 * firmware/apps/ can #include a private helper header of its own" (that
 * script's own comment).
 *
 * Declared here, DEFINED in gos_runtime.c (this port's own code, not a
 * vendored copy of anything - a byte-loop memset/memcpy carries no
 * numerical-fidelity risk the way a hand-rolled sinf() would, unlike
 * shim/math.h's transcendental functions which stay real host imports).
 */
#ifndef _GOS_PORT_STRING_H_
#define _GOS_PORT_STRING_H_

#include <stddef.h>

void *memset(void *dst, int c, size_t n);
void *memcpy(void *dst, const void *src, size_t n);

#endif
