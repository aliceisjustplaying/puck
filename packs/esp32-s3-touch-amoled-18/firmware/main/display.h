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

// The devlink screenshot capture. NOT a framebuffer, and display.c's own
// comment says at length why the distinction matters here: nothing draws
// into this, nothing draws from it, and it is only written while a capture
// is armed. See firmware/devlink.h for what SHOT does with it.
//
// display_capture_arm() asks for the next WHOLE frame, so a capture armed
// halfway through one waits for the following band 0 rather than returning
// a picture stitched from two frames.
void display_capture_arm(void);
bool display_capture_ready(void);

// PANEL_W * PANEL_H bytes, row-major, one 8-bit grey level per pixel, or
// NULL if the buffer could not be allocated at init.
const uint8_t *display_capture_grey(void);
