#pragma once

#include <stdbool.h>
#include <stdint.h>

#include "driver/i2c_master.h"
#include "esp_err.h"

// Owns the AMOLED panel and the pair of band buffers that feed it, adapted
// from esp32-fluidbox/fluidbox/main/display.c (same board, same panel link)
// - see this pack's AGENTS.md for exactly what changed and what did not.
//
// The screen is pushed out one horizontal band at a time. runtime_core.c
// calls plat_acquire_band()/plat_flush_band() (runtime_core.h's platform
// seam) once per band, every frame; this file is what makes those two calls
// real on the board. Acquiring blocks only if both buffers are still in
// flight, so drawing one band overlaps with transmitting the previous one.

esp_err_t display_init(i2c_master_bus_handle_t i2c_bus);

esp_err_t display_set_brightness(uint8_t level);
