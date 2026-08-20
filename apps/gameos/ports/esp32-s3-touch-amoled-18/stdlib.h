/*
 * stdlib.h: this pack's wasm32-freestanding target ships no <stdlib.h>
 * (hosted-only - see this directory's math.h). ../../reference/esp32-gameos/
 * gfx.c `#include`s it (for `calloc()`, only inside its `GOS_HOST_SIM`
 * branch, which this port never defines - see gameos_port.c's header
 * comment) and ../../reference/esp32-gameos/slots.c calls `abs()`,
 * redirected at the unity-build include site to `gosport_abs()`
 * (gos_hal_shim.c), the same trick this app's rp2350 port already uses.
 * Nothing here needs a real `calloc` declaration: the only call site is
 * dead code on this port (see this port's NOTICE.md, "not carried").
 */
#ifndef _GAMEOS_ESP32_SHIM_STDLIB_H_
#define _GAMEOS_ESP32_SHIM_STDLIB_H_

int gosport_abs(int x);

#endif
