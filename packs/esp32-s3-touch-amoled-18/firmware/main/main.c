/*
 * main: brings the board up, drives the portable runtime, and owns the
 * devlink wiring.
 *
 * INIT ORDER, per esp32-fluidbox/fluidbox/main/main.c and confirmed on this
 * board: one shared I2C bus, then display_init() (which probes the bus to
 * tell the two board revisions apart AND power-cycles the panel and touch
 * controller through the TCA9554 IO expander - see display.c), then the
 * remaining I2C peripherals (touch, IMU, PWR button), then the loop.
 * fluidbox splits simulation and rendering across the two cores because its
 * fluid solver and its renderer both have real work to do concurrently;
 * this pack has neither, so everything - polling touch/button/IMU, calling
 * rtcore_tick(), and servicing devlink - runs from one task on one core.
 * rtcore_tick() itself paces the loop: plat_acquire_band() (display.c)
 * blocks on the same counting semaphore fluidbox's own
 * display_acquire_band() does, so this loop naturally runs no faster than
 * the panel's own QSPI link can drain band buffers.
 *
 * THE LOOP ORDER IS PART OF DEVLINK'S CONTRACT: inputs, then
 * rtcore_tick(), then devlink_poll(). devlink answers a SHOT with the frame
 * the tick immediately before it painted, and releases a CHORD's BOOT one
 * iteration after asserting it, both of which depend on being called after
 * the tick and not before (see devlink.h).
 *
 * INJECTION VERSUS THE REAL SENSORS. devlink can put a touch, a PWR
 * gesture or a BOOT press into the runtime with nobody in the room. Those
 * cannot simply call rtcore_set_touch() from inside devlink_poll(): this
 * loop calls rtcore_set_touch() itself every iteration from the physical
 * controller, so an injected finger would be overwritten by the real
 * "nothing is touching the glass" a few hundred microseconds later. The
 * injection state below is what resolves that - while a devlink finger is
 * down the physical controller is not consulted, and the injected finger
 * survives exactly one further tick after UP so the app sees its release.
 * BOOT is OR'd rather than replaced, since a level that is held by either
 * source is held.
 */
#include <stdio.h>
#include <stdlib.h>

#include "button.h"
#include "devlink.h"
#include "display.h"
#include "driver/gpio.h"
#include "driver/usb_serial_jtag.h"
#include "driver/usb_serial_jtag_vfs.h"
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
//
// IT IS ALSO THE PIN THE USB SERIAL/JTAG PERIPHERAL DRIVES FROM THE HOST'S
// DTR LINE, which is the one trap in sharing this port with devlink. See
// gotchas.md, "DTR is the BOOT button".
#define BOOT_GPIO GPIO_NUM_0
#define BOOT_DEBOUNCE_SAMPLES 2

static const char *TAG = "main";

static i2c_master_bus_handle_t s_i2c_bus;

/* ---- devlink injection state (see this file's header comment) ---------- */
static bool s_inj_touch_active;  // devlink owns the touch input right now
static bool s_inj_touch_down;
static int s_inj_touch_x, s_inj_touch_y;
static bool s_inj_boot_level;
static bool s_inj_boot_click_pending;

/* ---- runtime_core.h's platform seam -------------------------------------
 *
 * FOUND BY THE FIRST REAL BUILD, not by reading. runtime_core.h declares
 * four host-provided functions; main/ implemented two of them
 * (plat_acquire_band/plat_flush_band, in display.c) and simply never
 * implemented the other two, which nothing noticed because this half of the
 * pack had never been linked. The wasm side had both from the start
 * (wasm/emu_shim.c). That is exactly the class of gap "not yet flashed"
 * was warning about.
 */
void rt_log(const char *msg)
{
    ESP_LOGI("app", "%s", msg);
}

void rt_halt(void)
{
    // Must not return (runtime_core.h). abort() panics into the same
    // backtrace-printing path any other fatal error takes, on the console
    // devlink is already sharing, so an arena overflow is visible rather
    // than a board that silently stops drawing.
    abort();
}

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
// side. An injected level is OR'd in: BOOT is held if either the pad or
// devlink says so.
static void boot_poll(void)
{
    static bool stable = false;
    static int agree = 0;

    bool pressed = (gpio_get_level(BOOT_GPIO) == 0) || s_inj_boot_level; // active low

    if (s_inj_boot_click_pending && !pressed) {
        // A BOOT CLICK is a complete press and release delivered in one
        // command; the runtime derives "clicked" from the release edge, so
        // it needs both levels, one tick apart at minimum.
        s_inj_boot_click_pending = false;
        rtcore_set_button(RT_BTN_BOOT, 1);
        rtcore_set_button(RT_BTN_BOOT, 0);
        return;
    }

    if (pressed == stable) {
        agree = 0;
        return;
    }
    if (++agree >= BOOT_DEBOUNCE_SAMPLES) {
        agree = 0;
        stable = pressed;
        // Said out loud because this is the one signal a devlink client can
        // move without meaning to: if a host opens the port with DTR
        // asserted and this line appears, the USB Serial/JTAG peripheral is
        // driving GPIO0 and the run has a phantom button held down. See
        // gotchas.md, "DTR is the BOOT button".
        ESP_LOGI(TAG, "BOOT %s (pad=%d injected=%d)", stable ? "down" : "up",
                 gpio_get_level(BOOT_GPIO) == 0, (int)s_inj_boot_level);
        rtcore_set_button(RT_BTN_BOOT, stable ? 1 : 0);
    }
}

// Resolves the frame's touch state out of the injected stream when devlink
// owns it, and out of the physical controller otherwise.
static void touch_step(void)
{
    if (s_inj_touch_active) {
        rtcore_set_touch(s_inj_touch_down ? 1 : 0, s_inj_touch_x, s_inj_touch_y);
        if (!s_inj_touch_down) {
            // The release has now been handed to one tick; give the glass
            // back to the physical controller from the next one.
            s_inj_touch_active = false;
        }
        return;
    }

    int tx, ty;
    if (touch_poll(&tx, &ty)) {
        rtcore_set_touch(1, tx, ty);
    } else {
        rtcore_set_touch(0, 0, 0);
    }
}

/* ---- devlink wiring ---------------------------------------------------
 *
 * Every hook devlink calls lives here, the same way the RP2350 sibling
 * keeps all twelve of its hooks in runtime.c: devlink.c itself knows
 * nothing about this board's touch controller, IO expander or app table.
 */

static void dl_inject_down(int x, int y)
{
    s_inj_touch_active = true;
    s_inj_touch_down = true;
    s_inj_touch_x = x;
    s_inj_touch_y = y;
}

static void dl_inject_move(int x, int y)
{
    dl_inject_down(x, y);
}

static void dl_inject_up(void)
{
    s_inj_touch_active = true;
    s_inj_touch_down = false;
}

static void dl_erase(void)
{
    // A synthetic shake, exactly what the IMU's own detector would report,
    // and deliberately nothing further down: this proves the runtime and
    // the app handle a shake, and proves nothing about the QMI8658 or the
    // threshold in imu.c. See gotchas.md.
    rtcore_sensor_event(RT_SENSOR_SHAKE);
}

static void dl_inject_key(devlink_key_t which)
{
    switch (which) {
    case DEVLINK_KEY_PRESS:
        rtcore_set_button(RT_BTN_PWR, 1);
        break;
    case DEVLINK_KEY_RELEASE:
        rtcore_set_button(RT_BTN_PWR, 0);
        break;
    case DEVLINK_KEY_LONG:
        rtcore_set_button_verdict(RT_BTN_PWR, 1);
        break;
    case DEVLINK_KEY_SHORT:
        rtcore_set_button_verdict(RT_BTN_PWR, 0);
        break;
    }
}

static void dl_inject_boot(bool down)
{
    s_inj_boot_level = down;
}

static void dl_inject_boot_click(void)
{
    s_inj_boot_click_pending = true;
}

static int dl_app_current(void)
{
    return 0; // one wired app slot; see devlink.h
}

static const char *dl_app_name(int index)
{
    return index == 0 ? rtcore_app_name() : NULL;
}

static bool dl_app_switch(int index)
{
    if (index != 0) return false;
    // Not a no-op even though there is only one app: this is what puts the
    // board back into the state the emulator side always starts from. See
    // runtime_core.h's rtcore_reset().
    rtcore_reset();
    s_inj_touch_active = false;
    s_inj_touch_down = false;
    s_inj_boot_level = false;
    s_inj_boot_click_pending = false;
    return true;
}

// Once a second, on the same port devlink uses. The RP2350 sibling's
// profiler line is what harness/links/devlinkLink.ts reads to notice a
// board that rebooted under a run, so this one carries the same two things
// that detector needs: which app is running, and a counter that only ever
// climbs. `uptime` replaces the sibling's `core1restarts` (there is no
// second core here to restart) and is the stronger signal of the two
// anyway: it goes backwards on any reset, not just on a core dying.
static void prof_tick(uint32_t nowMs, uint32_t frames)
{
    static uint32_t lastMs;
    static uint32_t lastFrames;
    if (nowMs - lastMs < 1000u) return;
    const uint32_t elapsed = nowMs - lastMs;
    lastMs = nowMs;
    const uint32_t delta = frames - lastFrames;
    lastFrames = frames;
    printf("prof app=%s fps=%lu | shot drops=%lu | uptime=%lu\r\n",
           rtcore_app_name(),
           (unsigned long)((delta * 1000u) / (elapsed ? elapsed : 1u)),
           (unsigned long)devlink_dropped_shots(),
           (unsigned long)(nowMs / 1000u));
    fflush(stdout);
}

void app_main(void)
{
    // The console writes "\n" and the VFS layer turns it into "\r\n" by
    // default. devlink's replies already end in "\r\n" (the wire protocol
    // says so), which that default would turn into "\r\r\n" - a line the
    // host's reader sees with a stray carriage return still attached, so
    // every reply match fails for a reason that looks nothing like its
    // cause. Sending line endings through verbatim is the fix; ESP_LOG's
    // own "\n" endings are handled by the host reader either way.
    usb_serial_jtag_vfs_set_tx_line_endings(ESP_LINE_ENDINGS_LF);

    // THE RX SIDE NEEDS THE DRIVER, THE TX SIDE MUST NOT HAVE IT. Without
    // the driver installed, ESP-IDF v6.0.2's console read path can never
    // return a byte (it sizes every fetch from a "bytes available" counter
    // that is hard-zero unless the driver is there), so the board never
    // drains its USB OUT endpoint and the HOST blocks trying to write - the
    // failure looks like a dead devlink but is measured, on the bench, as a
    // pyserial write timeout. Installing the driver fixes reads.
    //
    // usb_serial_jtag_vfs_use_driver() is deliberately NOT called with it:
    // that would move console output onto the driver's TX ring, which
    // blocks once full, and a board with nothing plugged into it would
    // freeze instead of dropping its log. The no-driver TX path drops after
    // 50ms of an unlistening host, which is the behaviour a standalone
    // board needs. See devlink.c's header comment (2) and gotchas.md.
    usb_serial_jtag_driver_config_t usj = USB_SERIAL_JTAG_DRIVER_CONFIG_DEFAULT();
    usj.rx_buffer_size = 512;
    usj.tx_buffer_size = 256; // allocated, never used: TX stays off the driver
    ESP_ERROR_CHECK(usb_serial_jtag_driver_install(&usj));

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

    const devlink_hooks_t hooks = {
        .w = PANEL_W,
        .h = PANEL_H,
        .shot_arm = display_capture_arm,
        .shot_ready = display_capture_ready,
        .shot_grey = display_capture_grey,
        .inject_down = dl_inject_down,
        .inject_move = dl_inject_move,
        .inject_up = dl_inject_up,
        .erase = dl_erase,
        .inject_key = dl_inject_key,
        .inject_boot = dl_inject_boot,
        .inject_boot_click = dl_inject_boot_click,
        .app_current = dl_app_current,
        .app_name = dl_app_name,
        .app_switch = dl_app_switch,
    };
    devlink_init(&hooks);
    ESP_LOGI(TAG, "devlink ready on the USB Serial/JTAG console");

    uint32_t frames = 0;
    for (;;) {
        touch_step();
        button_poll();
        boot_poll();
        imu_poll();

        const uint32_t nowMs = (uint32_t)(esp_timer_get_time() / 1000);
        rtcore_tick(nowMs);
        frames++;

        devlink_poll();
        prof_tick(nowMs, frames);

        // The band DMA pipeline (display.c) is what actually paces this
        // loop; yielding one tick here keeps the idle task fed so the
        // watchdog stays happy, same reasoning fluidbox's own render_task()
        // gives for its own vTaskDelay(1).
        vTaskDelay(1);
    }
}
