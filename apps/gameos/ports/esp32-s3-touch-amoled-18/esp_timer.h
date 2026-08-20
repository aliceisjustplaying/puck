/*
 * esp_timer.h: not an ESP-IDF header, a compat stand-in with the same name,
 * quoted-#include'd by the real, unmodified
 * ../../reference/esp32-gameos/core.c for `gos_time_ms()`/`gos_time_us()`.
 *
 * Declared here, DEFINED in gos_hal_shim.c against this port's own tick
 * clock (the puck ABI's app_frame_t.nowMs - the ONLY time source this
 * repository's firmware is allowed to read, per wasm/emu_abi.h's
 * determinism rule), never a real wall clock: a firmware that read its own
 * clock would not be reproducible against a replayed trace.
 */
#ifndef _GAMEOS_ESP32_SHIM_ESP_TIMER_H_
#define _GAMEOS_ESP32_SHIM_ESP_TIMER_H_

#include <stdint.h>

int64_t esp_timer_get_time(void);

#endif
