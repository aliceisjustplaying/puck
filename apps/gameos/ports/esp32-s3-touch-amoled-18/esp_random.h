/*
 * esp_random.h: not an ESP-IDF header, a compat stand-in with the same
 * name, quoted-#include'd by the real, unmodified
 * ../../reference/esp32-gameos/core.c and (new with this port's shell
 * vendoring) ../../reference/esp32-gameos/shell.c. core.c itself never calls
 * a function from it (checked by grep, not guessed) - only the `#include`
 * needs a file to resolve to there. shell.c DOES call one: `launch()` seeds
 * a freshly launched game's RNG with `esp_random()` directly
 * (`ctx = (gos_ctx_t){ ..., .rng = { esp_random() }, ... }`), so this port
 * now needs a real, linkable body.
 *
 * `esp_random()` is declared here and DEFINED in gos_hal_shim.c as a pure
 * function of this port's own tick clock (s_nowMs) and a per-call counter,
 * never a real entropy source - the SAME deterministic-seeding doctrine this
 * port's own gameos_port.c already states for its prior (pre-shell)
 * dispatcher's per-launch seed formula, and the same reason
 * docs/harness.md gives for it repository-wide: a replay of the same trace
 * must reproduce the same run. A real board's `esp_random()` reads a
 * hardware TRNG; this is a stated, honest substitution for it, not an
 * attempt to reproduce real entropy.
 */
#ifndef _GAMEOS_ESP32_SHIM_ESP_RANDOM_H_
#define _GAMEOS_ESP32_SHIM_ESP_RANDOM_H_

#include <stdint.h>

uint32_t esp_random(void);

#endif
