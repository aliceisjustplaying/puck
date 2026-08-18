/*
 * touch: FT3168 (original board) or CST820 (V2 board), by I2C probe -
 * exactly the same probe display.c already runs (CST820 at 0x15) to decide
 * the panel's gap offset, run again here for the touch read itself.
 *
 * PROVENANCE, READ BEFORE TRUSTING EITHER BRANCH EQUALLY.
 *
 * FT3168 branch: the register map (REG_FINGER_NUM 0x02, the X1_H..Y1_L
 * burst at 0x03, REG_POWER_MODE 0xA5) is lifted from this repository's
 * RP2350 sibling pack, firmware/lib/Touch/FT3168.h and FT3168.c, which is
 * hardware-confirmed on that board's touch controller - the same FT3168
 * part, on the same panel family, wired the same way (I2C, finger-count
 * register read first, then a burst read of X/Y). That confirmation was
 * earned on different silicon than this pack targets; it is the strongest
 * evidence available, not a guarantee this exact board behaves identically.
 *
 * CST820 branch: the register map (FingerNum at 0x02, an XposH/XposL/
 * YposH/YposL burst at 0x03) is the commonly published Hynitron CST820 map
 * used across a number of open-source projects for other boards. Nothing
 * in this repository or in esp32-fluidbox has run it against a real V2
 * board. Treat it as a documented starting point, not a proven driver - see
 * this pack's AGENTS.md, "not yet flashed", and gotchas.md.
 *
 * Both share one shape (finger count, then a 4-byte coordinate burst) and
 * one 12-bit coordinate mask, which is why this file reads as one function
 * with a controller-specific address and register set rather than two
 * unrelated drivers.
 */
#include "touch.h"

#include "esp_log.h"

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
// that file's own header comment names MONITOR as value 0x01 (the bug that
// header comment describes was writing 0x01 where FT3168_POWER_ACTIVE
// belonged) - so 0x00 is used here as ACTIVE, the conventional "off" value
// for a FocalTech power-mode field, not a value copied from that pack's own
// FT3168.h enum (which is not phrased as a literal here).
#define FT3168_POWER_ACTIVE 0x00

#define CST820_ADDR 0x15
#define CST820_REG_FINGER_NUM 0x02
#define CST820_REG_X_H        0x03

static const char *TAG = "touch";

static i2c_master_dev_handle_t s_dev;
static bool s_ready;
static bool s_is_cst820;

static esp_err_t read_reg_n(uint8_t reg, uint8_t *out, size_t len)
{
    return i2c_master_transmit_receive(s_dev, &reg, 1, out, len, 100);
}

static esp_err_t write_reg(uint8_t reg, uint8_t value)
{
    const uint8_t payload[2] = {reg, value};
    return i2c_master_transmit(s_dev, payload, sizeof(payload), 100);
}

esp_err_t touch_init(i2c_master_bus_handle_t bus)
{
    uint8_t addr;
    if (i2c_master_probe(bus, CST820_ADDR, 50) == ESP_OK) {
        s_is_cst820 = true;
        addr = CST820_ADDR;
    } else if (i2c_master_probe(bus, FT3168_ADDR, 50) == ESP_OK) {
        s_is_cst820 = false;
        addr = FT3168_ADDR;
    } else {
        ESP_LOGE(TAG, "no touch controller found at 0x%02x or 0x%02x", CST820_ADDR, FT3168_ADDR);
        return ESP_ERR_NOT_FOUND;
    }

    const i2c_device_config_t cfg = {
        .dev_addr_length = I2C_ADDR_BIT_LEN_7,
        .device_address = addr,
        .scl_speed_hz = 400000,
    };
    esp_err_t ret = i2c_master_bus_add_device(bus, &cfg, &s_dev);
    if (ret != ESP_OK) {
        ESP_LOGE(TAG, "touch controller not reachable: %s", esp_err_to_name(ret));
        return ret;
    }

    if (!s_is_cst820) {
        // FT3168 bring-up, per the RP2350 sibling's FT3168_Init() - normal
        // device mode, active power mode, a 10ms active-mode scan period.
        write_reg(FT3168_REG_DEVICE_MODE, 0x00);
        write_reg(FT3168_REG_POWER_MODE, FT3168_POWER_ACTIVE);
        write_reg(FT3168_REG_PERIOD_ACTIVE, FT3168_PERIOD_MS);
    }
    // CST820 needs no equivalent bring-up in the published map: it reports
    // finger state on plain register reads with no power-mode gate.

    ESP_LOGI(TAG, "touch ready: %s at 0x%02x", s_is_cst820 ? "CST820" : "FT3168", addr);
    s_ready = true;
    return ESP_OK;
}

bool touch_poll(int *x, int *y)
{
    if (!s_ready) {
        return false;
    }

    uint8_t fingerReg = s_is_cst820 ? CST820_REG_FINGER_NUM : FT3168_REG_FINGER_NUM;
    uint8_t fingers = 0;
    if (read_reg_n(fingerReg, &fingers, 1) != ESP_OK || fingers == 0) {
        return false;
    }

    uint8_t buf[4];
    uint8_t coordReg = s_is_cst820 ? CST820_REG_X_H : FT3168_REG_X1_H;
    if (read_reg_n(coordReg, buf, sizeof(buf)) != ESP_OK) {
        return false;
    }

    // Same 12-bit mask both controllers use: the top nibble of the "H"
    // byte carries touch-event/status bits, the low nibble is the
    // coordinate's high bits.
    *x = ((buf[0] & 0x0F) << 8) | buf[1];
    *y = ((buf[2] & 0x0F) << 8) | buf[3];
    return true;
}
