/*
 * main: brings the board up and drives the portable runtime.
 *
 * INIT ORDER, per esp32-fluidbox/fluidbox/main/main.c: one shared I2C bus,
 * then display_init() (which itself probes the bus to tell the two board
 * revisions apart), then the remaining I2C peripherals (touch, IMU, PWR
 * button), then the loop. fluidbox splits simulation and rendering across
 * the two cores because its fluid solver and its renderer both have real
 * work to do concurrently; this pack has neither, so everything - polling
 * touch/button/IMU and calling rtcore_tick() - runs from one task on one
 * core. rtcore_tick() itself already paces the loop: plat_acquire_band()
 * (display.c) blocks on the same counting semaphore fluidbox's own
 * display_acquire_band() does, so this loop naturally runs no faster than
 * the panel's own QSPI link can drain band buffers.
 *
 * NOT YET FLASHED. This file, and everything else under main/, has not
 * been built or run against real hardware - there is no ESP-IDF install on
 * the machine this pack was written on. See this pack's AGENTS.md before
 * treating it as proven the way display.c/button.c/imu.c's fluidbox-derived
 * halves are.
 */
#include "button.h"
#include "display.h"
#include "driver/gpio.h"
#include "esp_err.h"
#include "esp_log.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "imu.h"
#include "runtime_core.h"
#include "touch.h"

#define I2C_PORT I2C_NUM_0
#define I2C_SDA GPIO_NUM_15
#define I2C_SCL GPIO_NUM_14

// GPIO0, the ESP32-S3's own bootloader-select strap, doubles as this
// board's BOOT button (active low, same convention as every ESP32-S3 dev
// board that breaks it out). Unlike the RP2350 sibling's BOOT - read by
// borrowing the flash chip select, see that pack's gotchas.md - this is a
// plain GPIO read with nothing to protect a shared bus from, so it needs
// none of that caution.
#define BOOT_GPIO GPIO_NUM_0
#define BOOT_DEBOUNCE_SAMPLES 2

static const char *TAG = "main";

static i2c_master_bus_handle_t s_i2c_bus;

static esp_err_t i2c_init(void)
{
    const i2c_master_bus_config_t cfg = {
        .i2c_port = I2C_PORT,
        .sda_io_num = I2C_SDA,
        .scl_io_num = I2C_SCL,
        .clk_source = I2C_CLK_SRC_DEFAULT,
        .glitch_ignore_cnt = 7,
        .flags.enable_internal_pullup = true,
    };
    return i2c_new_master_bus(&cfg, &s_i2c_bus);
}

static void boot_gpio_init(void)
{
    const gpio_config_t cfg = {
        .pin_bit_mask = 1ULL << BOOT_GPIO,
        .mode = GPIO_MODE_INPUT,
        .pull_up_en = GPIO_PULLUP_ENABLE,
        .pull_down_en = GPIO_PULLDOWN_DISABLE,
        .intr_type = GPIO_INTR_DISABLE,
    };
    gpio_config(&cfg);
}

// Debounced level poll, matching button.c's own DEBOUNCE_SAMPLES pattern:
// two agreeing reads in a row before the level is trusted. rtcore_set_button
// derives the click edge itself (runtime_core.c) from the level this
// reports, the same shape emu_button(RT_BTN_BOOT, down) drives on the wasm
// side.
static void boot_poll(void)
{
    static bool stable = false;
    static int agree = 0;

    bool pressed = gpio_get_level(BOOT_GPIO) == 0; // active low

    if (pressed == stable) {
        agree = 0;
        return;
    }
    if (++agree >= BOOT_DEBOUNCE_SAMPLES) {
        agree = 0;
        stable = pressed;
        rtcore_set_button(RT_BTN_BOOT, stable ? 1 : 0);
    }
}

void app_main(void)
{
    ESP_LOGI(TAG, "esp32-s3-touch-amoled-18: starting");

    ESP_ERROR_CHECK(i2c_init());
    ESP_ERROR_CHECK(display_init(s_i2c_bus));

    if (touch_init(s_i2c_bus) != ESP_OK) {
        ESP_LOGW(TAG, "continuing without touch");
    }
    if (imu_init(s_i2c_bus) != ESP_OK) {
        ESP_LOGW(TAG, "continuing without the IMU (no shake events)");
    }
    if (button_init(s_i2c_bus) != ESP_OK) {
        ESP_LOGW(TAG, "continuing without PWR");
    }
    boot_gpio_init();

    rtcore_init();

    for (;;) {
        int tx, ty;
        if (touch_poll(&tx, &ty)) {
            rtcore_set_touch(1, tx, ty);
        } else {
            rtcore_set_touch(0, 0, 0);
        }

        button_poll();
        boot_poll();
        imu_poll();

        rtcore_tick((uint32_t)(esp_timer_get_time() / 1000));

        // The band DMA pipeline (display.c) is what actually paces this
        // loop; yielding one tick here keeps the idle task fed so the
        // watchdog stays happy, same reasoning fluidbox's own render_task()
        // gives for its own vTaskDelay(1).
        vTaskDelay(1);
    }
}
