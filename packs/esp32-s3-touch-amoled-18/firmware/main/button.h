#pragma once

#include "driver/i2c_master.h"
#include "esp_err.h"

// The PWR side button, read through pin 4 of the TCA9554 IO expander -
// adapted from esp32-fluidbox/fluidbox/main/button.c (same board, same
// expander, same pin). fluidbox only needed a short-press edge for its
// reset gesture; device.json declares longPressMs for pwr, so button_poll()
// here also derives the long-press verdict and feeds runtime_core.h's
// rtcore_set_button()/rtcore_set_button_verdict() directly - see button.c.
//
// Holding PWR for six seconds is wired straight into the AXP2101 power chip
// and cuts power in hardware, no firmware involved; that is deliberately
// left alone here too, same as fluidbox.

esp_err_t button_init(i2c_master_bus_handle_t bus);

// Call periodically (main.c's loop). Reads the expander, debounces, and
// calls rtcore_set_button()/rtcore_set_button_verdict() for RT_BTN_PWR as
// needed. Does not return anything: this pack's demo app only cares about
// the frame-level signals those two calls already produce.
void button_poll(void);
