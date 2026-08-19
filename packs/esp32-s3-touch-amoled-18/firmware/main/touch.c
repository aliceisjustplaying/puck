/*
 * touch: CST820 (V2 board) through Espressif's esp_lcd_touch_cst816s
 * component, or FT3168 (original board) through a direct register read,
 * chosen by the same I2C probe display.c already runs to decide the panel's
 * gap offset.
 *
 * PROVENANCE, READ BEFORE TRUSTING EITHER BRANCH EQUALLY.
 *
 * CST820 branch: this is the board in front of us, and it no longer uses
 * the commonly-published register map this file shipped with. That map was
 * never confirmed anywhere in this repository or in fluidbox; what IS
 * confirmed on this exact enclosure is tinydraw's
 * esp32/main/physical_touch.cpp, which drives the same part through
 * Espressif's esp_lcd_touch_cst816s component (the CST820 on these boards
 * answers the CST816S protocol) at I2C address 0x15, 400kHz, with the
 * controller's interrupt on GPIO21 active low and the coordinate space
 * declared as 368x448. Using the proven driver rather than a hand-rolled
 * copy of a published register table is the whole reason this file changed
 * during silicon bring-up. The touch controller's own reset line is bit 2
 * of the TCA9554 IO expander and is released by display.c's power-cycle,
 * which runs first (see main.c's init order).
 *
 * FT3168 branch: unchanged, and still unproven ON THIS BOARD. Its register
 * map (REG_FINGER_NUM 0x02, the X1_H..Y1_L burst at 0x03, REG_POWER_MODE
 * 0xA5) comes from this repository's RP2350 sibling pack,
 * firmware/lib/Touch/FT3168.c, hardware-confirmed there on the same FT3168
 * part and the same panel family, on different silicon. No original-
 * revision board has been available to this pack, so this branch is
 * inherited evidence, not a local result. See gotchas.md.
 */
#include "touch.h"

#include "esp_lcd_touch_cst816s.h"
#include "esp_log.h"

#include "runtime_core.h" // PANEL_W, PANEL_H: the coordinate space the
                          // controller is told to report in

#define FT3168_ADDR 0x38
#define FT3168_REG_DEVICE_MODE 0x00
#define FT3168_REG_FINGER_NUM  0x02
#define FT3168_REG_X1_H        0x03
#define FT3168_REG_POWER_MODE  0xA5
#define FT3168_REG_PERIOD_ACTIVE 0x88
#define FT3168_PERIOD_MS 10
// Inferred, not read from a vendor header on this side: the RP2350 sibling
// pack's FT3168.c writes DEV_I2C_Write_Byte(FT3168_I2C_ADDR, REG_POWER_MODE,
// FT3168_POWER_ACTIVE) to bring the controller out of MONITOR mode, and
// that file's own header comment names MONITOR as value 0x01 - so 0x00 is
// used here as ACTIVE, the conventional "off" value for a FocalTech
// power-mode field.
#define FT3168_POWER_ACTIVE 0x00

#define CST820_ADDR 0x15
#define TOUCH_INT_GPIO GPIO_NUM_21

static const char *TAG = "touch";

static i2c_master_dev_handle_t s_ft_dev;    // FT3168 branch only
static esp_lcd_touch_handle_t s_cst_touch;  // CST820 branch only
static bool s_ready;
static bool s_is_cst820;

static esp_err_t ft_read_reg_n(uint8_t reg, uint8_t *out, size_t len)
{
    return i2c_master_transmit_receive(s_ft_dev, &reg, 1, out, len, 100);
}

static esp_err_t ft_write_reg(uint8_t reg, uint8_t value)
{
    const uint8_t payload[2] = {reg, value};
    return i2c_master_transmit(s_ft_dev, payload, sizeof(payload), 100);
}

static esp_err_t cst820_init(i2c_master_bus_handle_t bus)
{
    esp_lcd_panel_io_i2c_config_t io_config = {
        .dev_addr = ESP_LCD_TOUCH_IO_I2C_CST816S_ADDRESS,
        .scl_speed_hz = 400000,
        .control_phase_bytes = 1,
        .lcd_cmd_bits = 8,
        .flags.disable_control_phase = true,
    };
    esp_lcd_panel_io_handle_t io = NULL;
    esp_err_t ret = esp_lcd_new_panel_io_i2c(bus, &io_config, &io);
    if (ret != ESP_OK) {
        ESP_LOGE(TAG, "touch panel io failed: %s", esp_err_to_name(ret));
        return ret;
    }

    const esp_lcd_touch_config_t cfg = {
        .x_max = PANEL_W,
        .y_max = PANEL_H,
        // The controller's reset is bit 2 of the TCA9554, not a GPIO this
        // driver can toggle; display.c has already released it.
        .rst_gpio_num = GPIO_NUM_NC,
        .int_gpio_num = TOUCH_INT_GPIO,
        .levels = {
            .reset = 0,
            .interrupt = 0,
        },
    };
    ret = esp_lcd_touch_new_i2c_cst816s(io, &cfg, &s_cst_touch);
    if (ret != ESP_OK) {
        ESP_LOGE(TAG, "CST820 init failed: %s", esp_err_to_name(ret));
    }
    return ret;
}

esp_err_t touch_init(i2c_master_bus_handle_t bus)
{
    if (i2c_master_probe(bus, CST820_ADDR, 50) == ESP_OK) {
        s_is_cst820 = true;
        const esp_err_t ret = cst820_init(bus);
        if (ret != ESP_OK) return ret;
        ESP_LOGI(TAG, "touch ready: CST820 at 0x%02x (esp_lcd_touch_cst816s)", CST820_ADDR);
        s_ready = true;
        return ESP_OK;
    }

    if (i2c_master_probe(bus, FT3168_ADDR, 50) != ESP_OK) {
        ESP_LOGE(TAG, "no touch controller found at 0x%02x or 0x%02x", CST820_ADDR, FT3168_ADDR);
        return ESP_ERR_NOT_FOUND;
    }
    s_is_cst820 = false;

    const i2c_device_config_t cfg = {
        .dev_addr_length = I2C_ADDR_BIT_LEN_7,
        .device_address = FT3168_ADDR,
        .scl_speed_hz = 400000,
    };
    esp_err_t ret = i2c_master_bus_add_device(bus, &cfg, &s_ft_dev);
    if (ret != ESP_OK) {
        ESP_LOGE(TAG, "touch controller not reachable: %s", esp_err_to_name(ret));
        return ret;
    }

    // FT3168 bring-up, per the RP2350 sibling's FT3168_Init(): normal device
    // mode, active power mode, a 10ms active-mode scan period.
    ft_write_reg(FT3168_REG_DEVICE_MODE, 0x00);
    ft_write_reg(FT3168_REG_POWER_MODE, FT3168_POWER_ACTIVE);
    ft_write_reg(FT3168_REG_PERIOD_ACTIVE, FT3168_PERIOD_MS);

    ESP_LOGI(TAG, "touch ready: FT3168 at 0x%02x (register map inherited, unproven here)",
             FT3168_ADDR);
    s_ready = true;
    return ESP_OK;
}

bool touch_poll(int *x, int *y)
{
    if (!s_ready) {
        return false;
    }

    if (s_is_cst820) {
        if (esp_lcd_touch_read_data(s_cst_touch) != ESP_OK) {
            return false;
        }
        uint16_t px = 0, py = 0, strength = 0;
        uint8_t count = 0;
        if (!esp_lcd_touch_get_coordinates(s_cst_touch, &px, &py, &strength, &count, 1) ||
            count == 0) {
            return false;
        }
        *x = px;
        *y = py;
        return true;
    }

    uint8_t fingers = 0;
    if (ft_read_reg_n(FT3168_REG_FINGER_NUM, &fingers, 1) != ESP_OK || fingers == 0) {
        return false;
    }

    uint8_t buf[4];
    if (ft_read_reg_n(FT3168_REG_X1_H, buf, sizeof(buf)) != ESP_OK) {
        return false;
    }

    // The top nibble of each "H" byte carries touch-event/status bits, the
    // low nibble is the coordinate's high bits.
    *x = ((buf[0] & 0x0F) << 8) | buf[1];
    *y = ((buf[2] & 0x0F) << 8) | buf[3];
    return true;
}
