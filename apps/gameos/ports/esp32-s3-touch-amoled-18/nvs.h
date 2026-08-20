/*
 * nvs.h / nvs_flash.h: not ESP-IDF headers, compat stand-ins with the same
 * names, quoted-#include'd by the real, unmodified
 * ../../reference/esp32-gameos/{core,input}.c for save-slot and per-game
 * neutral-pose persistence (`gos_save_write/read`, `gos_settings_load/save`,
 * `gos_input_save/load_neutral`).
 *
 * This port never calls gos_save_init() (see gameos_port.c: no equivalent
 * of the donor's own gos_core/loop.c or main.c task setup is vendored -
 * see NOTICE.md), so `nvs_open()` here always fails, which every one of
 * those functions already treats as "no data" / "nothing to persist" and
 * returns cleanly from - the SAME stated gap this app's rp2350 port already
 * carries ("no save slot", descriptor.md's Demands), now true for a real
 * reason (an always-failing open) instead of a stub function body.
 */
#ifndef _GAMEOS_ESP32_SHIM_NVS_H_
#define _GAMEOS_ESP32_SHIM_NVS_H_

#include <stddef.h>

typedef int esp_err_t;
#define ESP_OK 0
#define ESP_FAIL (-1)
#define ESP_ERR_NVS_NO_FREE_PAGES 0x1101
#define ESP_ERR_NVS_NEW_VERSION_FOUND 0x1102

typedef int nvs_handle_t;
typedef enum { NVS_READONLY = 0, NVS_READWRITE = 1 } nvs_open_mode_t;

// Always fails: see this file's header comment. `out` is left untouched,
// matching real nvs_open()'s own contract on failure.
static inline esp_err_t nvs_open(const char *ns, nvs_open_mode_t mode, nvs_handle_t *out) {
    (void)ns; (void)mode; (void)out;
    return ESP_FAIL;
}
static inline void nvs_close(nvs_handle_t h) { (void)h; }
static inline esp_err_t nvs_commit(nvs_handle_t h) { (void)h; return ESP_FAIL; }
static inline esp_err_t nvs_set_blob(nvs_handle_t h, const char *key, const void *v, size_t len) {
    (void)h; (void)key; (void)v; (void)len;
    return ESP_FAIL;
}
static inline esp_err_t nvs_get_blob(nvs_handle_t h, const char *key, void *out, size_t *len) {
    (void)h; (void)key; (void)out; (void)len;
    return ESP_FAIL;
}

#endif
