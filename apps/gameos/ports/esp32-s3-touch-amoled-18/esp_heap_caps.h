/*
 * esp_heap_caps.h: not an ESP-IDF header, a compat stand-in with the same
 * name, quoted-#include'd by the real, unmodified
 * ../../reference/esp32-gameos/gfx.c (`#include "esp_heap_caps.h"`, one of
 * the two headers gfx.c pulls in only OUTSIDE its GOS_HOST_SIM branch,
 * beside "gos_hal.h" - see gfx.c's own `#ifndef GOS_HOST_SIM` guard).
 *
 * The one call site, `gos_gfx_fb565()`, is GOLF's own full-resolution
 * direct-mode framebuffer allocation, and GOLF is not part of this port
 * (see this port's NOTICE.md and
 * packs/esp32-s3-touch-amoled-18/docs/decisions/0003-... for the full
 * argument: GOLF's text renderer is welded to LVGL's font format in a way
 * that resists a thin shim). `gos_gfx_fb565()` is compiled in regardless
 * (it is part of gfx.c's own translation unit) but never CALLED by
 * anything this port actually runs - gunship.c and slots.c never declare
 * GOS_CAP_FB565 - so this only needs to link, not to work.
 */
#ifndef _GAMEOS_ESP32_SHIM_ESP_HEAP_CAPS_H_
#define _GAMEOS_ESP32_SHIM_ESP_HEAP_CAPS_H_

#include <stddef.h>
#include <stdint.h>

#define MALLOC_CAP_8BIT (1u << 0)

// Dead code on this port (see this file's header comment): never invoked,
// so a NULL stand-in costs nothing. A real implementation would need this
// port's own equivalent of GOLF's PSRAM-shaped mirror buffer, which is
// exactly the piece this port does not build.
static inline void *heap_caps_calloc(size_t n, size_t size, uint32_t caps) {
    (void)n; (void)size; (void)caps;
    return (void *)0;
}

#endif
