/*
 * imu: QMI8658 bring-up adapted from
 * esp32-fluidbox/fluidbox/main/imu.c (same chip, same board) - address
 * probe (QMI8658_ADDRESS_HIGH/LOW), the reset-then-CTRL1 sequence, and the
 * accel/gyro range and ODR configuration are copied nearly verbatim from
 * that file. What is NOT reused: fluidbox turns every sample into
 * continuous gravity/rotation forces for a fluid solver; this pack has no
 * solver, only device.json's one-shot "shake" sensor, so gravity/shake
 * separation here exists purely to feed a threshold detector, not a
 * simulation - and that detector is new, unverified on hardware code, see
 * this pack's gotchas.md and AGENTS.md.
 */
#include "imu.h"

#include <math.h>
#include <string.h>

#include "esp_log.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"

// qmi8658.h defines its own single-precision M_PI, which collides with the
// one math.h already provided - same trap fluidbox's imu.c documents.
#undef M_PI
#include "qmi8658.h"

#include "runtime_core.h"

#define IMU_PROBE_TIMEOUT_MS 100
#define QMI8658_RESET_REGISTER 0x60
#define QMI8658_RESET_COMMAND 0xB0
#define QMI8658_CTRL1_VALUE 0x60
#define QMI8658_RESET_DELAY_MS 20

#define TWO_PI 6.28318530718f

// Cutoff of the low-pass that separates steady gravity from motion, same
// constant fluidbox's config.h ships (GRAVITY_LP_HZ) - it is a property of
// how fast a real shake happens relative to gravity, not of the fluid
// simulation fluidbox built on top of it, so it carries over unchanged.
#define GRAVITY_LP_HZ 1.2f

// ---- shake detector (new to this pack, not from fluidbox) -----------------
//
// A single acceleration spike is indistinguishable from a firm tap or a
// bump of the desk it is sitting on, so this requires several spikes inside
// a short rolling window before calling it a shake - the same rationale the
// RP2350 sibling's sensors.h gives for its own shake gate, though this is
// an independent implementation, not a port of that file's C.
#define SHAKE_THRESHOLD_MPS2 14.0f  // residual (gravity removed) magnitude
#define SHAKE_WINDOW_MS      600u
#define SHAKE_MIN_JOLTS      3
#define SHAKE_COOLDOWN_MS    800u

static const char *TAG = "imu";

static qmi8658_dev_t s_dev;
static bool s_ready;

static float s_lp[3]; // low-passed accelerometer, i.e. the gravity part
static bool s_lp_primed;
static int64_t s_last_sample_us;

static float s_peak_mag;
static uint32_t s_peak_reported_ms;

static int s_jolt_count;
static uint32_t s_jolt_window_start_ms;
static uint32_t s_last_shake_ms;

static esp_err_t detect_address(i2c_master_bus_handle_t bus, uint8_t *address)
{
    const uint8_t candidates[] = {QMI8658_ADDRESS_HIGH, QMI8658_ADDRESS_LOW};

    for (size_t i = 0; i < sizeof(candidates) / sizeof(candidates[0]); i++) {
        if (i2c_master_probe(bus, candidates[i], IMU_PROBE_TIMEOUT_MS) == ESP_OK) {
            *address = candidates[i];
            return ESP_OK;
        }
    }
    return ESP_ERR_NOT_FOUND;
}

static esp_err_t configure(void)
{
    esp_err_t ret = qmi8658_write_register(&s_dev, QMI8658_RESET_REGISTER, QMI8658_RESET_COMMAND);
    if (ret != ESP_OK) {
        return ret;
    }
    vTaskDelay(pdMS_TO_TICKS(QMI8658_RESET_DELAY_MS));

    ret = qmi8658_write_register(&s_dev, QMI8658_CTRL1, QMI8658_CTRL1_VALUE);
    if (ret != ESP_OK) {
        return ret;
    }

    // 8g covers a hard shake without clipping; 250Hz is comfortably above
    // this detector's polling rate. Gyro is left enabled (fluidbox's own
    // default) even though this pack's shake detector does not use it,
    // since disabling it saves nothing this pack currently needs and
    // matches the proven fluidbox configuration exactly.
    if ((ret = qmi8658_set_accel_range(&s_dev, QMI8658_ACCEL_RANGE_8G)) != ESP_OK) return ret;
    if ((ret = qmi8658_set_accel_odr(&s_dev, QMI8658_ACCEL_ODR_250HZ)) != ESP_OK) return ret;
    if ((ret = qmi8658_set_gyro_range(&s_dev, QMI8658_GYRO_RANGE_512DPS)) != ESP_OK) return ret;
    if ((ret = qmi8658_set_gyro_odr(&s_dev, QMI8658_GYRO_ODR_250HZ)) != ESP_OK) return ret;

    qmi8658_set_accel_unit_mps2(&s_dev, true);
    qmi8658_set_gyro_unit_dps(&s_dev, true);

    return qmi8658_enable_sensors(&s_dev, QMI8658_ENABLE_ACCEL | QMI8658_ENABLE_GYRO);
}

esp_err_t imu_init(i2c_master_bus_handle_t bus)
{
    uint8_t address = 0;
    esp_err_t ret = detect_address(bus, &address);
    if (ret != ESP_OK) {
        ESP_LOGE(TAG, "QMI8658 not found on I2C");
        return ret;
    }

    ret = qmi8658_init(&s_dev, bus, address);
    if (ret != ESP_OK) {
        ESP_LOGE(TAG, "init failed: %s", esp_err_to_name(ret));
        return ret;
    }

    ret = configure();
    if (ret != ESP_OK) {
        ESP_LOGE(TAG, "configure failed: %s", esp_err_to_name(ret));
        return ret;
    }

    ESP_LOGI(TAG, "QMI8658 ready at 0x%02x", address);
    s_ready = true;
    return ESP_OK;
}

void imu_poll(void)
{
    if (!s_ready) {
        return;
    }

    bool data_ready = false;
    if (qmi8658_is_data_ready(&s_dev, &data_ready) != ESP_OK || !data_ready) {
        return;
    }

    qmi8658_data_t data;
    if (qmi8658_read_sensor_data(&s_dev, &data) != ESP_OK) {
        return;
    }

    int64_t now_us = esp_timer_get_time();
    float dt = s_last_sample_us == 0 ? 0.004f : (float)(now_us - s_last_sample_us) * 1e-6f;
    s_last_sample_us = now_us;
    if (dt <= 0.0f || dt > 0.2f) dt = 0.004f; // guard the first sample and any stall

    const float ax = data.accelX, ay = data.accelY, az = data.accelZ;

    if (!s_lp_primed) {
        s_lp[0] = ax; s_lp[1] = ay; s_lp[2] = az;
        s_lp_primed = true;
        return; // nothing to compare the first sample against yet
    }

    // One-pole low pass, same derivation fluidbox's imu.c uses: the
    // coefficient comes from the cutoff, not the loop rate, so the feel
    // does not change if polling speeds up or slows down.
    const float k = 1.0f - expf(-TWO_PI * GRAVITY_LP_HZ * dt);
    s_lp[0] += k * (ax - s_lp[0]);
    s_lp[1] += k * (ay - s_lp[1]);
    s_lp[2] += k * (az - s_lp[2]);

    // What's left after removing the steady (gravity) part is the board's
    // own acceleration - a shake, in this pack's case, since there is no
    // fluid to push around.
    const float rx = ax - s_lp[0], ry = ay - s_lp[1], rz = az - s_lp[2];
    const float mag = sqrtf(rx * rx + ry * ry + rz * rz);

    uint32_t nowMs = (uint32_t)(now_us / 1000);

    // THE THRESHOLD ABOVE IS STILL A GUESS, AND THIS IS HOW IT STOPS BEING
    // ONE. Nothing in this repository can shake a board; devlink's ERASE
    // injects the resulting event and never touches this code path (see
    // firmware/devlink.h), so SHAKE_THRESHOLD_MPS2 cannot be calibrated by
    // any automated run. What can be done is to make the missing
    // measurement one line of console output away: this reports the largest
    // gravity-removed magnitude seen in each one-second window, on the same
    // port devlink uses, so a human who picks the board up and shakes it
    // reads the number the threshold should be set against instead of
    // guessing a second time. See gotchas.md, "the shake threshold needs a
    // human".
    if (mag > s_peak_mag) s_peak_mag = mag;
    if (nowMs - s_peak_reported_ms >= 1000u) {
        s_peak_reported_ms = nowMs;
        ESP_LOGI(TAG, "accel peak residual %d.%02d m/s2 over the last second (shake threshold %d.%02d)",
                 (int)s_peak_mag, (int)((s_peak_mag - (float)(int)s_peak_mag) * 100.0f),
                 (int)SHAKE_THRESHOLD_MPS2,
                 (int)((SHAKE_THRESHOLD_MPS2 - (float)(int)SHAKE_THRESHOLD_MPS2) * 100.0f));
        s_peak_mag = 0.0f;
    }

    if (mag < SHAKE_THRESHOLD_MPS2) {
        return;
    }

    if (s_jolt_count == 0 || (nowMs - s_jolt_window_start_ms) > SHAKE_WINDOW_MS) {
        s_jolt_window_start_ms = nowMs;
        s_jolt_count = 0;
    }
    s_jolt_count++;

    if (s_jolt_count >= SHAKE_MIN_JOLTS && (nowMs - s_last_shake_ms) > SHAKE_COOLDOWN_MS) {
        s_jolt_count = 0;
        s_last_shake_ms = nowMs;
        rtcore_sensor_event(RT_SENSOR_SHAKE);
    }
}
