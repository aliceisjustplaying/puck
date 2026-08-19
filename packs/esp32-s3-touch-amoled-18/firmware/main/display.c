/*
 * display: the band DMA pipeline, implementing runtime_core.h's
 * plat_acquire_band()/plat_flush_band() for the real board, plus the
 * one-frame greyscale capture devlink's SHOT is answered from.
 *
 * PROVENANCE, AND WHAT CHANGED THE DAY THIS WAS FIRST FLASHED. The band
 * pipeline (two DMA buffers, a counting semaphore released by the
 * transfer-done interrupt), the QSPI pin map, the init command sequence and
 * the board-revision probe came from esp32-fluidbox/fluidbox/main/display.c
 * (separate repository, same board). That inheritance was never run here
 * until now, and bringing it up against the physical board changed three
 * things, each taken from tinydraw's measured receipts for this exact panel
 * (C:/Users/sylve/projects/tinydraw/esp32/main/co5300_panel_transport.cpp
 * and docs/receipts/hardware/CO5300_PANEL_LIMITS_2026-08-15.md), not from
 * the inherited code:
 *
 * 1. THE PANEL IS POWERED AND RESET THROUGH THE TCA9554 IO EXPANDER, and
 *    nothing in the inherited file did it. Bit 0 is the LCD reset line, bit
 *    1 is display power, bit 2 is the touch controller's reset; the panel
 *    only comes up reliably after those are driven low and back high with a
 *    settle in between. `reset_gpio_num = GPIO_NUM_NC` in the panel config
 *    is not "this panel has no reset", it is "the reset is not on a GPIO
 *    this driver can reach", which is why it has to happen here first.
 * 2. THE QSPI CLOCK IS ASKED FOR AT 40MHz, not 80. tinydraw measured the
 *    actual line rate as ~40MHz whatever is requested (the SPI peripheral's
 *    divider off its 80MHz source), so 80 in the config was never 80 on the
 *    wire; asking for what is actually delivered keeps the number in the
 *    source honest. See gotchas.md.
 * 3. TEON (0x35) IS RE-ISSUED AFTER disp_on. It sits in the init list
 *    before sleep-out, where tinydraw measured it being silently ignored on
 *    marginal boots (whole sessions with no tearing-effect edge at all).
 *    This pack does not USE the TE signal - it paces on the DMA semaphore
 *    below, not on GPIO13 - but leaving the panel in a state the driver was
 *    told to put it in costs one register write.
 */
#include "display.h"

#include "esp_attr.h"
#include "esp_check.h"
#include "esp_heap_caps.h"
#include "esp_lcd_co5300.h"
#include "esp_lcd_panel_io.h"
#include "esp_lcd_panel_ops.h"
#include "esp_log.h"
#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"
#include "freertos/task.h"

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
#define LCD_CMD_TEON 0x35

// The IO expander that holds the panel's power and reset lines. Bit 7 is
// the SD card's chip select and is driven high (deselected) throughout, the
// same way tinydraw does: leaving it floating while power-cycling the panel
// is the one way this sequence could disturb something it does not own.
#define EXPANDER_ADDR 0x20
#define EXPANDER_REG_OUTPUT 0x01
#define EXPANDER_REG_CONFIG 0x03
#define EXPANDER_LCD_RESET (1u << 0)
#define EXPANDER_DISPLAY_POWER (1u << 1)
#define EXPANDER_TOUCH_RESET (1u << 2)
#define EXPANDER_SD_CS (1u << 7)
#define EXPANDER_OUTPUTS \
    (EXPANDER_LCD_RESET | EXPANDER_DISPLAY_POWER | EXPANDER_TOUCH_RESET | EXPANDER_SD_CS)
#define EXPANDER_RESET_ATTEMPTS 3

// Asked for, not necessarily delivered: see this file's header comment (2).
#define LCD_PIXEL_CLOCK_HZ (40 * 1000 * 1000)

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

/* ---- the devlink capture ------------------------------------------------
 *
 * NOT A FRAMEBUFFER, and the distinction is the pack's whole identity (see
 * AGENTS.md). Nothing draws into this and nothing reads it back to draw
 * from: it is one byte per pixel of finished picture, written only while a
 * capture is armed, only as each band goes out, and read only by devlink's
 * SHOT. It lives in PSRAM, where a real framebuffer could not (the CPU
 * writing pixels and the panel DMA reading them would fight over the same
 * external bus), precisely because this one is never on the DMA path: the
 * panel still streams out of the internal-SRAM band buffers above.
 *
 * The byte written is the wire format's own encoding, computed once here
 * rather than converted twice later: undo the panel's byte order, then take
 * the six green bits as the grey level. harness/links/devlinkLink.ts's
 * greyToRGB() is the exact inverse.
 */
static uint8_t *s_capture;
typedef enum {
    CAPTURE_IDLE = 0,
    CAPTURE_ARMED,     // waiting for the start of the next whole frame
    CAPTURE_RUNNING,   // mid-frame, filling s_capture
    CAPTURE_READY,     // a whole frame is in s_capture, unread
} capture_state_t;
static volatile capture_state_t s_capture_state = CAPTURE_IDLE;

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

// Drives display power and both reset lines off and back on through the
// TCA9554, then removes its own device handle from the bus so button.c can
// add its own at the same address. Adapted from tinydraw's
// reset_panel_power(), including the retry loop: the expander does not
// always answer on the first attempt of a cold boot.
static esp_err_t reset_panel_power(i2c_master_bus_handle_t bus)
{
    const i2c_device_config_t cfg = {
        .dev_addr_length = I2C_ADDR_BIT_LEN_7,
        .device_address = EXPANDER_ADDR,
        .scl_speed_hz = 400000,
    };
    i2c_master_dev_handle_t dev = NULL;
    esp_err_t ret = i2c_master_bus_add_device(bus, &cfg, &dev);
    if (ret != ESP_OK) {
        ESP_LOGE(TAG, "IO expander not reachable at 0x%02x: %s", EXPANDER_ADDR,
                 esp_err_to_name(ret));
        return ret;
    }

    esp_err_t last = ESP_FAIL;
    bool cycled = false;
    for (int attempt = 1; attempt <= EXPANDER_RESET_ATTEMPTS && !cycled; attempt++) {
        const uint8_t config[2] = {EXPANDER_REG_CONFIG, (uint8_t)~EXPANDER_OUTPUTS};
        const uint8_t down[2] = {EXPANDER_REG_OUTPUT, EXPANDER_SD_CS};
        const uint8_t up[2] = {EXPANDER_REG_OUTPUT, EXPANDER_OUTPUTS};

        last = i2c_master_transmit(dev, config, sizeof config, 100);
        if (last == ESP_OK) last = i2c_master_transmit(dev, down, sizeof down, 100);
        if (last == ESP_OK) {
            vTaskDelay(pdMS_TO_TICKS(20));
            last = i2c_master_transmit(dev, up, sizeof up, 100);
        }
        if (last == ESP_OK) {
            vTaskDelay(pdMS_TO_TICKS(150)); // the panel's own settle time
            cycled = true;
            break;
        }
        ESP_LOGW(TAG, "panel power cycle attempt %d failed: %s", attempt,
                 esp_err_to_name(last));
        i2c_master_bus_reset(bus);
        vTaskDelay(pdMS_TO_TICKS(10));
    }

    const esp_err_t removed = i2c_master_bus_rm_device(dev);
    if (removed != ESP_OK) {
        ESP_LOGW(TAG, "could not release the expander handle: %s", esp_err_to_name(removed));
    }
    return cycled ? ESP_OK : last;
}

esp_err_t display_init(i2c_master_bus_handle_t i2c_bus)
{
    s_is_v2 = detect_v2(i2c_bus);

    ESP_RETURN_ON_ERROR(reset_panel_power(i2c_bus), TAG, "panel power cycle failed");

    s_buffers_free = xSemaphoreCreateCounting(2, 2);
    if (s_buffers_free == NULL) {
        return ESP_ERR_NO_MEM;
    }

    // PSRAM first, internal SRAM only as a fallback: 165KB of internal is
    // most of what is left after the IDF's own stacks and the two DMA band
    // buffers, and losing the capture is a much smaller failure than losing
    // the board. A NULL capture is a supported state - devlink answers
    // "ERR no framebuffer" and everything else still works.
    s_capture = heap_caps_malloc(PANEL_W * PANEL_H, MALLOC_CAP_SPIRAM);
    if (s_capture == NULL) {
        s_capture = heap_caps_malloc(PANEL_W * PANEL_H, MALLOC_CAP_8BIT);
        ESP_LOGW(TAG, "devlink capture buffer is in internal SRAM (no PSRAM available)");
    }
    if (s_capture == NULL) {
        ESP_LOGE(TAG, "no memory for the devlink capture buffer: SHOT will answer ERR");
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
        .reset_gpio_num = GPIO_NUM_NC, // the reset is on the expander, not a GPIO
        .rgb_ele_order = LCD_RGB_ELEMENT_ORDER_RGB,
        .data_endian = LCD_RGB_DATA_ENDIAN_BIG,
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

    // See this file's header comment (3).
    const uint8_t teon = 0x00;
    (void)esp_lcd_panel_io_tx_param(s_io, LCD_CMD_TEON, &teon, 1);

    ESP_LOGI(TAG, "panel up: %dx%d, %d bands of %d rows, %d MHz requested",
             PANEL_W, PANEL_H, BAND_COUNT, BAND_ROWS, LCD_PIXEL_CLOCK_HZ / 1000000);
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

// Reads out of the band buffer BEFORE queuing the transfer, deliberately.
// After the queue call the buffer is still ours until it is acquired again
// (two buffers, one semaphore token each), so reading it later would also
// be correct - but doing it first means the capture can never be racing a
// DMA engine over the same words, which is a much shorter thing to have to
// be sure about.
static void capture_band(int band, const uint16_t *buffer)
{
    if (s_capture == NULL) return;
    if (s_capture_state == CAPTURE_ARMED && band == 0) {
        s_capture_state = CAPTURE_RUNNING;
    }
    if (s_capture_state != CAPTURE_RUNNING) return;

    uint8_t *out = &s_capture[(size_t)band * BAND_ROWS * PANEL_W];
    for (int i = 0; i < BAND_PIXELS; i++) {
        const uint16_t px = buffer[i];
        const uint16_t v = (uint16_t)((px >> 8) | (px << 8));
        out[i] = (uint8_t)(((v >> 5) & 0x3F) << 2);
    }
    if (band == BAND_COUNT - 1) {
        s_capture_state = CAPTURE_READY;
    }
}

void plat_flush_band(int band, const uint16_t *buffer)
{
    capture_band(band, buffer);
    const int y0 = band * BAND_ROWS;
    esp_lcd_panel_draw_bitmap(s_panel, 0, y0, PANEL_W, y0 + BAND_ROWS, buffer);
}

void display_capture_arm(void)
{
    if (s_capture == NULL) return;
    s_capture_state = CAPTURE_ARMED;
}

bool display_capture_ready(void)
{
    return s_capture != NULL && s_capture_state == CAPTURE_READY;
}

const uint8_t *display_capture_grey(void)
{
    return s_capture;
}

esp_err_t display_set_brightness(uint8_t level)
{
    return esp_lcd_panel_io_tx_param(s_io, LCD_CMD_BRIGHTNESS, &level, 1);
}
