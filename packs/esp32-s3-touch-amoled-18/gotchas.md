# Hardware gotchas

**No full framebuffer fits in internal SRAM, so the panel is painted in 16 bands of 28 rows instead.**
368x448x2 bytes is 322KB against 512KB of internal SRAM, and PSRAM is not a substitute: the CPU writing pixels and the DMA engine reading them would fight over the same external bus.
This is this pack's entire reason for existing next to the RP2350 sibling, whose 520KB SRAM does fit a full 330KB framebuffer. See `AGENTS.md`'s "THE MEMORY MODEL" and `firmware/runtime/app.h`'s header comment.

**The band DMA pipeline is a counting semaphore initialised to 2, released by the transfer-done interrupt - never touch a band buffer the DMA still owns.**
`main/display.c`'s `plat_acquire_band()` blocks on that semaphore before handing back a buffer, and `esp_lcd_panel_draw_bitmap()` queues the transfer and returns immediately, so drawing band N+1 genuinely overlaps transmitting band N.
Writing into a buffer before its semaphore slot has been released is a race with the DMA engine, not a logic bug a debugger will show cleanly. Adapted from `esp32-fluidbox/fluidbox/main/display.c`, proven on this exact board.

**Two board revisions exist, and the display driver is the same for both.**
The original board has an SH8601 display and FT3168 touch; the V2 (shipping since May 2026) has a CO5300 and CST820, differing in touch controller I2C address and a 16-pixel horizontal panel offset.
`display_init()` probes for the CST820 at 0x15 and applies the offset if it answers; both revisions are driven through the same `espressif/esp_lcd_co5300` component and init command sequence, which is fluidbox's own tested approach, not an invention of this pack - see `main/display.c`'s header comment for exactly what that claim does and does not cover for the SH8601 side.

**QSPI runs at 80MHz through the GPIO matrix, not dedicated IOMUX pins - drop to 40MHz first if the panel ever tears or shows corrupted pixels.**
The ESP32-S3's SPI peripheral supports 80MHz, doubling the ~52fps a 322KB frame gets at the driver's 40MHz default, but because these signals route through the GPIO matrix rather than IOMUX, they are more sensitive to layout and cable length than a dedicated-pin bus would be. `LCD_PIXEL_CLOCK_HZ` in `main/display.c` is the knob.

**PWR is not a GPIO. It is EXIO4 on a TCA9554 IO expander over I2C, and holding it for six seconds is wired straight into the AXP2101 power chip in hardware.**
`main/button.c` only ever touches EXIO4's direction bit; every other pin on that expander drives the display and SD card resets and must be left exactly as found, or those subsystems come up in a wrong reset state. The six-second hard power-off needs no firmware involvement at all and is deliberately not reimplemented here.

**BOOT is a plain GPIO0 strap, unlike the RP2350 sibling's BOOT, which is read by borrowing the flash chip select.**
There is no shared-bus caution to carry over for this board's BOOT: `main.c`'s `boot_poll()` is an ordinary debounced `gpio_get_level()`, sampled every loop iteration with no rate limit needed.

**Arduino was rejected because ESP-IDF measures 200-300fps against Arduino's 50-60fps on this exact panel.**
Waveshare's own LVGL demo comparison is the source (see `esp32-fluidbox/fluidbox/README.md`, "Why ESP-IDF and not Arduino"): the Arduino path goes through the Arduino TFT library rather than driving the panel with DMA directly, and this pack's band pipeline needs that direct control.

**The touch register maps are proven on different silicon than they are used against here, and are not evenly trusted.**
The FT3168 branch (`main/touch.c`) is hardware-confirmed on this repository's RP2350 sibling pack, same controller and panel family, different board. The CST820 branch is the commonly published Hynitron register map, not confirmed anywhere in this repository or in `esp32-fluidbox` (which never reads a touch coordinate at all - it only probes for the CST820's presence to pick a board revision). See `touch.c`'s header comment before trusting either branch past what it has actually earned.

**The IMU shake detector is new to this pack and untuned against real hardware.**
`main/imu.c`'s gravity/shake separation (a one-pole low-pass isolating steady gravity from motion) is adapted from `esp32-fluidbox/fluidbox/main/imu.c`, proven there for a continuous fluid simulation. The threshold-and-cooldown logic that turns that residual into a one-shot `device.json` "shake" event is this pack's own, unverified addition - expect to retune `SHAKE_THRESHOLD_MPS2`/`SHAKE_MIN_JOLTS`/`SHAKE_WINDOW_MS` once this is actually flashed.

**`main/` as a whole has not been flashed.** See `AGENTS.md`'s "not yet flashed" section before treating any claim above about the board's *own* behaviour (as opposed to what fluidbox already proved) as settled.
