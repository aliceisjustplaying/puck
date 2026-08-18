#pragma once

#include "driver/i2c_master.h"
#include "esp_err.h"

// QMI8658 IMU: shake detection, fed into runtime_core.h's
// rtcore_sensor_event(RT_SENSOR_SHAKE). The bring-up (address probe, reset,
// range/ODR configuration) is adapted from
// esp32-fluidbox/fluidbox/main/imu.c, same chip, same board - see imu.c.
// The shake DETECTOR itself is new: fluidbox uses the IMU continuously to
// drive a fluid simulation and has no notion of a discrete "shake event";
// this pack needs exactly the one-shot event device.json's "shake" sensor
// declares, so imu_poll() below adds a simple threshold-and-cooldown
// detector on top of fluidbox's gravity/shake separation. It has not been
// tuned against real hardware - see this pack's gotchas.md.

esp_err_t imu_init(i2c_master_bus_handle_t bus);

// Call periodically (main.c's loop, at roughly the QMI8658's own output
// data rate or slower). Internally reads the sensor, updates the
// gravity/shake separation, and calls rtcore_sensor_event(RT_SENSOR_SHAKE)
// itself when a shake is accepted - callers do not need to inspect
// anything.
void imu_poll(void);
