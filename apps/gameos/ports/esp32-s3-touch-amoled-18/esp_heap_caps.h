/*
 * esp_heap_caps.h: not an ESP-IDF header, a compat stand-in with the same
 * name, quoted-#include'd by the real, unmodified
 * ../../reference/esp32-gameos/gfx.c (`#include "esp_heap_caps.h"`, one of
 * the two headers gfx.c pulls in only OUTSIDE its GOS_HOST_SIM branch,
 * beside "gos_hal.h" - see gfx.c's own `#ifndef GOS_HOST_SIM` guard).
 *
 * The one call site, `gos_gfx_fb565()`, is GOLF's own full-resolution
 * direct-mode framebuffer allocation: `heap_caps_calloc(GOS_PANEL_W *
 * GOS_PANEL_H, 2, MALLOC_CAP_8BIT)` = 368*448*2 = 329728 bytes, checked by
 * grep over gfx.c, not guessed - the only call site left once gunship.c and
 * slots.c (which never declare GOS_CAP_FB565) are the only OTHER games this
 * port ships. packs/esp32-s3-touch-amoled-18/docs/decisions/0003-... is
 * where this port's answer to "gos_gfx_fb565() wants PSRAM" was decided: a
 * plain static array living in this app's own module, the wasm equivalent
 * of what heap_caps_calloc(..., MALLOC_CAP_8BIT) would actually hand back
 * on real silicon - not a general allocator, sized to this one exact call
 * site. See this port's README, "GOLF's memory budget".
 */
#ifndef _GAMEOS_ESP32_SHIM_ESP_HEAP_CAPS_H_
#define _GAMEOS_ESP32_SHIM_ESP_HEAP_CAPS_H_

#include <stddef.h>
#include <stdint.h>

#define MALLOC_CAP_8BIT (1u << 0)

// GOS_PANEL_W * GOS_PANEL_H * 2 (gos.h), spelled as a literal rather than
// pulled from gos.h here: this header is included by gfx.c BEFORE gos.h's
// own macros would be back in scope from this translation unit's point of
// view is not guaranteed, and a mismatch would rather fail loudly (a
// too-small buffer overrun caught by inspection/review) than silently via
// a macro that quietly changed meaning. Cross-checked against gos.h's
// GOS_PANEL_W=368/GOS_PANEL_H=448 by grep, not guessed.
#define _GAMEOS_FB565_BYTES (368u * 448u * 2u)
static uint8_t s_fb565Backing[_GAMEOS_FB565_BYTES];
static int s_fb565Taken;

// calloc semantics (zeroed) satisfied for free: a plain module-static array
// is zero-initialized by the linker/loader, never written to by anything
// else, so no explicit memset is needed. Returns NULL past the one call
// this port's own gfx.c ever makes (n*size does not fit, or a second call
// after the first already claimed it) rather than silently handing back an
// undersized or aliased buffer.
static inline void *heap_caps_calloc(size_t n, size_t size, uint32_t caps) {
    (void)caps;
    if (s_fb565Taken || n * size > _GAMEOS_FB565_BYTES) return (void *)0;
    s_fb565Taken = 1;
    return s_fb565Backing;
}

#endif
