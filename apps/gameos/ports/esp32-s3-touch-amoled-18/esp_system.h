/*
 * esp_system.h: not an ESP-IDF header, a compat stand-in with the same
 * name, quoted-#include'd by the real, unmodified
 * ../../reference/esp32-gameos/shell.c for `esp_restart()`, the settings
 * screen's factory-reset row (`R_RESET`, settings_frame(): a 3s press-and-
 * hold calls `nvs_flash_erase()` then `esp_restart()`, restarting into a
 * freshly wiped NVS).
 *
 * This port's own `nvs_flash_erase()` (nvs_flash.h) already always fails,
 * honestly: there is no real NVS here to erase (see that file's header
 * comment). `esp_restart()` below is a matching SHIM: a real device reboots
 * the whole SoC; this emulator module has no equivalent concept (no bootloader,
 * no reset vector, nothing to jump to), and rebuilding one just for a
 * settings-menu action neither this bundle's invariants nor its demo ever
 * reach would invent behavior no other part of this port needs. Declared
 * here, defined as a genuine no-op in gos_hal_shim.c, recorded per this
 * port's own doctrine (NOTICE.md) rather than left undocumented - holding
 * the reset row for 3s in this emulator does nothing, where a real board
 * would reboot with default settings.
 */
#ifndef _GAMEOS_ESP32_SHIM_ESP_SYSTEM_H_
#define _GAMEOS_ESP32_SHIM_ESP_SYSTEM_H_

void esp_restart(void);

#endif
