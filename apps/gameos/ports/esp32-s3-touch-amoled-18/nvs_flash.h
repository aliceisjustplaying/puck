/*
 * nvs_flash.h: see this directory's nvs.h for the full argument. Only
 * `gos_save_init()` (../../reference/esp32-gameos/core.c) calls into this
 * one, and this port never calls gos_save_init() at all - see
 * gameos_port.c - so these bodies exist only to satisfy the link.
 */
#ifndef _GAMEOS_ESP32_SHIM_NVS_FLASH_H_
#define _GAMEOS_ESP32_SHIM_NVS_FLASH_H_

#include "nvs.h"

static inline esp_err_t nvs_flash_init(void) { return ESP_FAIL; }
static inline esp_err_t nvs_flash_erase(void) { return ESP_FAIL; }

#endif
