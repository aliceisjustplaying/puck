/*
 * button: PWR via the TCA9554 IO expander.
 *
 * ADAPTED FROM esp32-fluidbox/fluidbox/main/button.c (same board, same
 * expander at 0x20, same EXIO4 pin, same "only touch pin 4's direction bit,
 * leave the rest of the expander's config alone" caution - the other pins
 * hold the display and SD card resets). fluidbox only ever needed a short
 * press to reset its fluid; this pack's device.json declares longPressMs
 * for pwr (matching the RP2350 sibling's PWR semantics, see
 * runtime_core.h's KEY_* bits), so button_poll() below adds the long-press
 * timing fluidbox's button_take_short_press() did not need, on top of the
 * same debounced expander read.
 */
#include "button.h"

#include "esp_log.h"
#include "esp_timer.h"

#include "runtime_core.h"

#define EXPANDER_ADDR 0x20
#define EXPANDER_SPEED_HZ 400000
#define EXPANDER_REG_INPUT 0x00
#define EXPANDER_REG_CONFIG 0x03

#define PWR_BIT (1 << 4) // EXIO4, reads high while the button is held

#define DEBOUNCE_SAMPLES 2
#define LONG_PRESS_MS 1500 // matches device.json's pwr.longPressMs

static const char *TAG = "button";

static i2c_master_dev_handle_t s_dev;
static bool s_stable_state;
static int s_agree_count;
static int64_t s_press_started_us;
static bool s_long_fired;

static esp_err_t read_reg(uint8_t reg, uint8_t *value)
{
    return i2c_master_transmit_receive(s_dev, &reg, 1, value, 1, 100);
}

static esp_err_t write_reg(uint8_t reg, uint8_t value)
{
    const uint8_t payload[2] = {reg, value};
    return i2c_master_transmit(s_dev, payload, sizeof(payload), 100);
}

esp_err_t button_init(i2c_master_bus_handle_t bus)
{
    const i2c_device_config_t cfg = {
        .dev_addr_length = I2C_ADDR_BIT_LEN_7,
        .device_address = EXPANDER_ADDR,
        .scl_speed_hz = EXPANDER_SPEED_HZ,
    };

    esp_err_t ret = i2c_master_bus_add_device(bus, &cfg, &s_dev);
    if (ret != ESP_OK) {
        ESP_LOGE(TAG, "IO expander not reachable: %s", esp_err_to_name(ret));
        return ret;
    }

    // Only force EXIO4 to be an input. The other pins drive the display and
    // SD card resets, so their direction and level are left exactly as
    // found - same caution fluidbox's button_init() documents.
    uint8_t config = 0xFF;
    ret = read_reg(EXPANDER_REG_CONFIG, &config);
    if (ret != ESP_OK) {
        ESP_LOGE(TAG, "config read failed: %s", esp_err_to_name(ret));
        return ret;
    }

    if ((config & PWR_BIT) == 0) {
        ret = write_reg(EXPANDER_REG_CONFIG, (uint8_t)(config | PWR_BIT));
        if (ret != ESP_OK) {
            ESP_LOGE(TAG, "config write failed: %s", esp_err_to_name(ret));
            return ret;
        }
    }

    ESP_LOGI(TAG, "PWR button ready on EXIO4 (config 0x%02x)", config);
    return ESP_OK;
}

void button_poll(void)
{
    uint8_t input = 0;
    if (read_reg(EXPANDER_REG_INPUT, &input) != ESP_OK) {
        return;
    }

    const bool pressed = (input & PWR_BIT) != 0;

    if (pressed == s_stable_state) {
        s_agree_count = 0;
    } else if (++s_agree_count >= DEBOUNCE_SAMPLES) {
        s_agree_count = 0;
        s_stable_state = pressed;

        if (pressed) {
            s_press_started_us = esp_timer_get_time();
            s_long_fired = false;
            rtcore_set_button(RT_BTN_PWR, 1);
        } else {
            rtcore_set_button(RT_BTN_PWR, 0);
            if (!s_long_fired) {
                // Released before the long-press threshold: a short-press
                // verdict, same shape emu_button_verdict(index, 0) gives
                // the emulator side.
                rtcore_set_button_verdict(RT_BTN_PWR, 0);
            }
        }
    }

    // Long-press verdict fires once, while still held, the moment the hold
    // crosses the threshold - mirrors the RP2350 sibling's AXP2101 KEY_LONG
    // behaviour (a level-triggered verdict at 1.5s), not a release-time
    // decision.
    if (s_stable_state && !s_long_fired) {
        const int64_t held_ms = (esp_timer_get_time() - s_press_started_us) / 1000;
        if (held_ms >= LONG_PRESS_MS) {
            s_long_fired = true;
            rtcore_set_button_verdict(RT_BTN_PWR, 1);
        }
    }
}
