#pragma once

#include "driver/i2c_master.h"
#include "esp_err.h"

// Touch: FT3168 (original board) or CST820 (V2 board), autodetected by I2C
// probe - see touch.c for exactly what is proven and what is not.
//
// esp32-fluidbox never drives its own touch controller (its README notes
// the CST820 probe exists purely to tell the two board revisions apart for
// display.c's gap offset), so unlike display.c/button.c/imu.c this file has
// no fluidbox counterpart to adapt. The FT3168 register map below is
// carried over from the RP2350 sibling pack's firmware/lib/Touch/FT3168.h,
// hardware-confirmed on that board's identical touch controller (same
// panel family). The CST820 register map is the commonly published one for
// that part, NOT independently confirmed against this board's silicon by
// this pack - see touch.c's header comment and this pack's gotchas.md.

esp_err_t touch_init(i2c_master_bus_handle_t bus);

// Call periodically (main.c's loop). Returns true and fills *x/*y (panel,
// portrait coordinates) while a finger is down; returns false otherwise.
bool touch_poll(int *x, int *y);
