/*
 * string.h: a stand-in, same idea and same reason as this directory's own
 * math.h/stdio.h/stdlib.h and this app's rp2350 port's own
 * ports/rp2350-touch-amoled-18/string.h (see that file's header comment for
 * the full argument): zig's wasm32-freestanding target ships no
 * <string.h> at all, and the real, vendored
 * ../../reference/esp32-gameos/{core,gfx,input}.c and the vendored games
 * `#include` it as unmodified upstream code.
 *
 * memset()/memcpy() cover core.c/gfx.c/input.c/gunship.c/slots.c (checked
 * by grep, not guessed). strlen() is new versus the sibling port's own
 * string.h: gfx.c's real `gos_gfx_text_w()` calls it (the sibling port's
 * hand-written gos_runtime.c never did, since it computed text width
 * without strlen). strchr() is new for GOLF: golf_cards.c's own
 * card_text_in() calls it to find an embedded newline. Declared here,
 * DEFINED in gos_hal_shim.c - plain byte loops, no numerical-fidelity risk
 * the way math.h's transcendental functions carry.
 */
#ifndef _GAMEOS_ESP32_SHIM_STRING_H_
#define _GAMEOS_ESP32_SHIM_STRING_H_

#include <stddef.h>

void *memset(void *dst, int c, size_t n);
void *memcpy(void *dst, const void *src, size_t n);
size_t strlen(const char *s);
char *strchr(const char *s, int c);

#endif
