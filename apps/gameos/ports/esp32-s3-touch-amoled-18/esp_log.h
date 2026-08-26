/*
 * esp_log.h: not an ESP-IDF header, a compat stand-in with the same name,
 * quoted-#include'd by the real, unmodified
 * ../../reference/esp32-gameos/shell.c ("esp_log.h", new with this port's
 * shell vendoring - core.c/gfx.c/input.c/gunship.c/slots.c/golf*.c never
 * pull this one in, checked by grep). shell.c calls ESP_LOGI/ESP_LOGE at
 * every touch edge, tap, launch, quit and pause/resume transition -
 * deliberately, per its own header comment ("this is how the touch-parallax
 * numbers were measured" on the real device's serial console).
 *
 * This port has no serial console and no host-side log sink at all (this
 * pack's wasm32-freestanding target has no I/O beyond the ABI's own
 * exported functions - see docs/abi.md), so both macros compile to nothing:
 * the format string and arguments are still parsed by the compiler (a
 * `(void)0` void-cast idiom, not a bare empty definition, so a real
 * printf-format mistake in the vendored source would still surface as a
 * compiler warning) but nothing is evaluated or emitted at runtime. This
 * SHIMS AWAY the donor's own on-device diagnostic logging, recorded here per
 * this port's own doctrine (NOTICE.md) rather than left undocumented.
 */
#ifndef _GAMEOS_ESP32_SHIM_ESP_LOG_H_
#define _GAMEOS_ESP32_SHIM_ESP_LOG_H_

#define ESP_LOGI(tag, fmt, ...) ((void)0)
#define ESP_LOGE(tag, fmt, ...) ((void)0)
#define ESP_LOGW(tag, fmt, ...) ((void)0)
#define ESP_LOGD(tag, fmt, ...) ((void)0)

#endif
