/*
 * display: the band DMA pipeline, implementing runtime_core.h's
 * plat_acquire_band()/plat_flush_band() for the real board.
 *
 * ADAPTED FROM esp32-fluidbox/fluidbox/main/display.c, same board (Waveshare
 * ESP32-S3-Touch-AMOLED-1.8), same panel link, same driver. Copied nearly
 * verbatim - the init command sequence, the QSPI pin map, the 80MHz clock,
 * the counting semaphore band pipeline, and the board-revision probe are
 * all fluidbox's, proven on real hardware by that project. The only real
 * changes: the two public entry points are renamed to this pack's
 * plat_acquire_band(int)/plat_flush_band(int, const uint16_t *) shape (see
 * runtime_core.h) instead of fluidbox's own display_acquire_band()/
 * display_flush_band(int, const uint16_t*), and the band size comes from
 * runtime_core.h's PANEL_W/BAND_ROWS rather than a local config.h.
 *
 * BOTH BOARD REVISIONS GO THROUGH THE SAME esp_lcd_co5300 DRIVER. This is
 * fluidbox's own approach, not an invention of this pack: the original
 * board (SH8601 display, FT3168 touch) and the V2 board (CO5300 display,
 * CST820 touch) differ, on the display side, only by a 16-pixel horizontal
 * gap and are driven by the same init command sequence and the same
 * component. Detection is via I2C-probing for the CST820 touch controller
 * at 0x15 (touch.c also probes it, for its own purposes) - if it answers,
 * this is a V2 board and the gap is applied; if not, this is treated as the
 * original SH8601 board. This pack has not been flashed to hardware to
 * confirm the SH8601 side of that claim independently: it inherits
 * fluidbox's own tested claim rather than a new one - see this pack's
 * AGENTS.md, "not yet flashed".
 */
#include "display.h"

#include "esp_attr.h"
#include "esp_check.h"
#include "esp_lcd_co5300.h"
#include "esp_lcd_panel_io.h"
#include "esp_lcd_panel_ops.h"
#include "esp_log.h"
#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"

#include "runtime_core.h" // PANEL_W, PANEL_H, BAND_ROWS, BAND_COUNT

#define LCD_HOST SPI2_HOST
#define LCD_CS GPIO_NUM_12
#define LCD_PCLK GPIO_NUM_11
#define LCD_DATA0 GPIO_NUM_4
#define LCD_DATA1 GPIO_NUM_5
#define LCD_DATA2 GPIO_NUM_6
#define LCD_DATA3 GPIO_NUM_7

#define TOUCH_ADDR_CST820 0x15
#define V2_PANEL_X_GAP 0x10

#define LCD_CMD_BRIGHTNESS 0x51

// Drop to 40MHz if the panel ever shows tearing or corrupted pixels; these
// signals go through the GPIO matrix rather than dedicated IOMUX pins - see
// this pack's gotchas.md, "80MHz QSPI via the GPIO matrix".
#define LCD_PIXEL_CLOCK_HZ (80 * 1000 * 1000)

#define BAND_PIXELS (PANEL_W * BAND_ROWS)

static const char *TAG = "display";

// Two buffers, alternating by acquisition order, so one can be filled while
// the other is being transmitted. DMA_ATTR keeps them in DMA-capable
// internal SRAM - see this pack's gotchas.md, "no full framebuffer in
// internal SRAM".
static DMA_ATTR uint16_t s_band_buf[2][BAND_PIXELS];

static esp_lcd_panel_handle_t s_panel;
static esp_lcd_panel_io_handle_t s_io;
static SemaphoreHandle_t s_buffers_free;
static bool s_is_v2;

// Same power-on sequence fluidbox uses, itself Waveshare's own: pixel
// format RGB565, brightness and HBM registers open, full-window address
// set, sleep out, display on.
static const co5300_lcd_init_cmd_t s_init_cmds[] = {
    {0xFE, (uint8_t[]){0x00}, 1, 0},
    {0xC4, (uint8_t[]){0x80}, 1, 0},
    {0x3A, (uint8_t[]){0x55}, 1, 0},
    {0x35, (uint8_t[]){0x00}, 1, 0},
    {0x53, (uint8_t[]){0x20}, 1, 0},
    {0x51, (uint8_t[]){0xFF}, 1, 0},
    {0x63, (uint8_t[]){0xFF}, 1, 0},
    {0x2A, (uint8_t[]){0x00, 0x00, 0x01, 0x6F}, 4, 0},
    {0x2B, (uint8_t[]){0x00, 0x00, 0x01, 0xBF}, 4, 0},
    {0x11, NULL, 0, 100},
    {0x29, NULL, 0, 0},
};

static bool IRAM_ATTR on_trans_done(esp_lcd_panel_io_handle_t io,
                                    esp_lcd_panel_io_event_data_t *event,
                                    void *user_ctx)
{
    (void)io;
    (void)event;
    (void)user_ctx;

    BaseType_t higher_priority_woken = pdFALSE;
    xSemaphoreGiveFromISR(s_buffers_free, &higher_priority_woken);
    return higher_priority_woken == pdTRUE;
}

static bool detect_v2(i2c_master_bus_handle_t bus)
{
    if (bus == NULL) {
        return false;
    }
    const bool is_v2 = i2c_master_probe(bus, TOUCH_ADDR_CST820, 50) == ESP_OK;
    ESP_LOGI(TAG, "detected %s board revision",
             is_v2 ? "V2 (CO5300/CST820)" : "original (SH8601/FT3168)");
    return is_v2;
}

esp_err_t display_init(i2c_master_bus_handle_t i2c_bus)
{
    s_is_v2 = detect_v2(i2c_bus);

    s_buffers_free = xSemaphoreCreateCounting(2, 2);
    if (s_buffers_free == NULL) {
        return ESP_ERR_NO_MEM;
    }

    const spi_bus_config_t bus_config = CO5300_PANEL_BUS_QSPI_CONFIG(
        LCD_PCLK, LCD_DATA0, LCD_DATA1, LCD_DATA2, LCD_DATA3,
        BAND_PIXELS * sizeof(uint16_t));
    ESP_RETURN_ON_ERROR(spi_bus_initialize(LCD_HOST, &bus_config, SPI_DMA_CH_AUTO),
                        TAG, "spi bus init failed");

    esp_lcd_panel_io_spi_config_t io_config =
        CO5300_PANEL_IO_QSPI_CONFIG(LCD_CS, on_trans_done, NULL);
    io_config.pclk_hz = LCD_PIXEL_CLOCK_HZ;
    ESP_RETURN_ON_ERROR(
        esp_lcd_new_panel_io_spi((esp_lcd_spi_bus_handle_t)LCD_HOST, &io_config, &s_io),
        TAG, "panel io init failed");

    const co5300_vendor_config_t vendor_config = {
        .init_cmds = s_init_cmds,
        .init_cmds_size = sizeof(s_init_cmds) / sizeof(s_init_cmds[0]),
        .flags.use_qspi_interface = 1,
    };
    const esp_lcd_panel_dev_config_t panel_config = {
        .reset_gpio_num = GPIO_NUM_NC,
        .rgb_ele_order = LCD_RGB_ELEMENT_ORDER_RGB,
        .bits_per_pixel = 16,
        .vendor_config = (void *)&vendor_config,
    };
    ESP_RETURN_ON_ERROR(esp_lcd_new_panel_co5300(s_io, &panel_config, &s_panel),
                        TAG, "panel init failed");

    ESP_RETURN_ON_ERROR(esp_lcd_panel_reset(s_panel), TAG, "panel reset failed");
    ESP_RETURN_ON_ERROR(esp_lcd_panel_init(s_panel), TAG, "panel setup failed");
    ESP_RETURN_ON_ERROR(esp_lcd_panel_set_gap(s_panel, s_is_v2 ? V2_PANEL_X_GAP : 0, 0),
                        TAG, "panel gap failed");
    ESP_RETURN_ON_ERROR(esp_lcd_panel_disp_on_off(s_panel, true), TAG, "display on failed");

    return ESP_OK;
}

uint16_t *plat_acquire_band(int band)
{
    (void)band; // rotation is by acquisition order, not band index - see
                // runtime_core.h's plat_acquire_band() comment on why both
                // still take it.
    xSemaphoreTake(s_buffers_free, portMAX_DELAY);

    static unsigned next;
    return s_band_buf[next++ & 1];
}

void plat_flush_band(int band, const uint16_t *buffer)
{
    const int y0 = band * BAND_ROWS;
    esp_lcd_panel_draw_bitmap(s_panel, 0, y0, PANEL_W, y0 + BAND_ROWS, buffer);
}

esp_err_t display_set_brightness(uint8_t level)
{
    return esp_lcd_panel_io_tx_param(s_io, LCD_CMD_BRIGHTNESS, &level, 1);
}
