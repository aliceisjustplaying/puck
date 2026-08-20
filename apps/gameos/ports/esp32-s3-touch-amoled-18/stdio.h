/*
 * stdio.h: this pack's wasm32-freestanding target ships no <stdio.h>
 * (hosted-only, same fact as <math.h> - see this directory's math.h). The
 * real, vendored ../../reference/esp32-gameos/{core,gfx,input}.c
 * `#include <stdio.h>` as unmodified upstream code and call `snprintf()`
 * (core.c, input.c) / `vsnprintf()` (gfx.c's gos_gfx_text()); this port
 * redirects both to its own formatter at the unity-build include site
 * (see gameos_port.c's `#define snprintf/vsnprintf` bracket around those
 * three includes, the same trick this app's rp2350 port already uses for
 * slots.c's `abs()`/`snprintf()`), so the identifiers this header actually
 * needs to declare are `gosport_snprintf`/`gosport_vsnprintf`
 * (gos_hal_shim.c), not the standard names themselves.
 */
#ifndef _GAMEOS_ESP32_SHIM_STDIO_H_
#define _GAMEOS_ESP32_SHIM_STDIO_H_

#include <stdarg.h>
#include <stddef.h>

int gosport_snprintf(char *buf, size_t cap, const char *fmt, ...);
int gosport_vsnprintf(char *buf, size_t cap, const char *fmt, va_list ap);

#endif
