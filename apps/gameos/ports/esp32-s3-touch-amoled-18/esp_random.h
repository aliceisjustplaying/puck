/*
 * esp_random.h: not an ESP-IDF header, a compat stand-in with the same
 * name, quoted-#include'd by the real, unmodified
 * ../../reference/esp32-gameos/core.c. Nothing in core.c actually calls a
 * function from it (checked by grep, not guessed) - the `#include` alone
 * needs a file to resolve to, and this port's own RNG path is entirely
 * `gos_rand()`'s xorshift32 (vendored verbatim in core.c, seeded once per
 * launch by this port's own gameos_port.c, the exact same deterministic
 * seeding this app's rp2350 port already uses and for the same reason:
 * a replay of the same trace must reproduce the same run - see
 * docs/harness.md).
 */
#ifndef _GAMEOS_ESP32_SHIM_ESP_RANDOM_H_
#define _GAMEOS_ESP32_SHIM_ESP_RANDOM_H_
#endif
