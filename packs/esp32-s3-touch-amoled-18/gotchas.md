# Hardware gotchas

Everything below marked **measured here** was seen on the physical board on
2026-08-19, the day this pack's ESP-IDF half was first built and flashed. The
rest is inherited evidence and says whose.

**No full framebuffer fits in internal SRAM, so the panel is painted in 16 bands of 28 rows instead.**
368x448x2 bytes is 322KB against 512KB of internal SRAM, and PSRAM is not a substitute: the CPU writing pixels and the DMA engine reading them would fight over the same external bus.
This is this pack's entire reason for existing next to the RP2350 sibling, whose 520KB SRAM does fit a full 330KB framebuffer. See `AGENTS.md`'s "THE MEMORY MODEL" and `firmware/runtime/app.h`'s header comment.

**The band DMA pipeline is a counting semaphore initialised to 2, released by the transfer-done interrupt - never touch a band buffer the DMA still owns.**
`main/display.c`'s `plat_acquire_band()` blocks on that semaphore before handing back a buffer, and `esp_lcd_panel_draw_bitmap()` queues the transfer and returns immediately, so drawing band N+1 genuinely overlaps transmitting band N.
**Measured here:** this produces a steady 50 full-panel frames per second with the main loop paced entirely by that semaphore, which is 8.2MB/s of pixels out over QSPI.

**The panel has no power until the TCA9554 IO expander gives it some, and the display driver cannot do that for you.**
Bit 0 of the expander at I2C 0x20 is the LCD's reset line, bit 1 is display power, bit 2 is the touch controller's reset. `esp_lcd_panel_dev_config_t.reset_gpio_num = GPIO_NUM_NC` does not mean the panel has no reset, it means the reset is not somewhere `esp_lcd` can reach.
`main/display.c`'s `reset_panel_power()` drives those three lines low, waits 20ms, drives them high, waits 150ms, and retries up to three times with an I2C bus reset in between, because the expander does not always answer on a cold boot. It then removes its own device handle from the bus so `main/button.c` can add its own at the same address. Taken from tinydraw's `esp32/main/co5300_panel_transport.cpp` (same enclosure, measured receipts). See `docs/decisions/0001-what-the-first-flash-found.md`.

**The QSPI clock is asked for at 40MHz because that is what the wire carries.**
The ESP32-S3's SPI peripheral is specified to 80MHz and these signals route through the GPIO matrix rather than dedicated IOMUX pins. tinydraw's measurements on this panel put the actual line rate at roughly 40MHz whatever is requested, so `LCD_PIXEL_CLOCK_HZ` in `main/display.c` now asks for 40. If the panel ever tears or shows corrupted pixels, that constant is still the first knob, downward.

**TEON (0x35) is re-issued after `disp_on`.**
It sits in the init command list before sleep-out, where tinydraw measured it being silently ignored on marginal boots (whole sessions with no tearing-effect edge at all). This pack does not use the TE signal - it paces on the DMA semaphore, not on GPIO13 - but leaving the panel in the state the driver was told to put it in costs one register write. **If tearing ever needs fixing properly, TE is on GPIO13, rising edge, measured by tinydraw at 59.62Hz.**

**Two board revisions exist, and the display driver is the same for both.**
The original board has an SH8601 display and FT3168 touch; the V2 (shipping since May 2026) has a CO5300 and CST820, differing in touch controller I2C address and a 16-pixel horizontal panel offset.
`display_init()` probes for the CST820 at 0x15 and applies the offset if it answers; both revisions are driven through the same `espressif/esp_lcd_co5300` component and init command sequence, which is fluidbox's own tested approach. **Measured here:** the board this pack was brought up on is a V2 and reports itself as one. The SH8601 side remains inherited evidence only - no original-revision board has ever been in front of this pack.

**PWR is not a GPIO. It is EXIO4 on that same TCA9554, and holding it for six seconds is wired straight into the AXP2101 power chip in hardware.**
`main/button.c` only ever touches EXIO4's direction bit; every other pin on that expander drives the display and SD card resets and must be left exactly as found. The six-second hard power-off needs no firmware involvement at all and is deliberately not reimplemented here.

**BOOT is a plain GPIO0 strap, unlike the RP2350 sibling's BOOT, which is read by borrowing the flash chip select.**
`main.c`'s `boot_poll()` is an ordinary debounced `gpio_get_level()`, sampled every loop iteration with no rate limit needed.

**DTR IS THE BOOT BUTTON. Open this board's port without asserting DTR.**
The ESP32-S3's USB Serial/JTAG peripheral wires the host's DTR and RTS lines to the chip's own boot strap (GPIO0) and reset, which is how `esptool` reboots the board into download mode with no button pressed. A devlink client that opens the port with `DtrEnable = $true` - which is exactly what the RP2350 pack's serial bridge does, because that board's USB CDC stack looks dead without it - is holding this board's BOOT button down for the whole run.
`DEVLINK_DTR=0` is how a run against this board opens the port (`packs/rp2350-touch-amoled-18/tools/dev.ts`, and `harness/links/devlinkLink.ts`'s header). `main.c` logs every BOOT level change with both the pad level and the injected level, so a phantom press shows up as a line rather than as a mystery.

**The default USB Serial/JTAG console CANNOT READ, and the symptom lands on the host.**
With ESP-IDF v6.0.2 and no `usb_serial_jtag` driver installed, `read()` on `stdin` sizes every fetch from `usb_serial_jtag_get_read_bytes_available()`, which returns 0 flat unless the driver is installed (`components/esp_driver_usb_serial_jtag/src/usb_serial_jtag.c`). A non-blocking read therefore computes a fetch size of zero and returns without ever touching the RX FIFO.
**Measured here:** the board never drains its USB OUT endpoint, so the HOST blocks - a plain `pyserial` write timed out while the board went on logging happily. `main.c` installs the driver for RX and deliberately does not call `usb_serial_jtag_vfs_use_driver()`: that would move console writes onto the driver's TX ring, which blocks when full, and a board with nothing plugged into it would freeze instead of dropping its log.

**The console turns `\n` into `\r\n`, and devlink's replies already end in `\r\n`.**
Left alone, every devlink reply goes out as `\r\r\n` and arrives at the host with a stray carriage return attached, so every reply match fails for a reason that looks nothing like its cause. `main.c` calls `usb_serial_jtag_vfs_set_tx_line_endings(ESP_LINE_ENDINGS_LF)` before anything else.

**Touch is driven by Espressif's `esp_lcd_touch_cst816s` component now, not by a hand-copied register map.**
The CST820 on these boards answers the CST816S protocol, and tinydraw drives it that way on this exact enclosure (`esp32/main/physical_touch.cpp`): I2C 0x15 at 400kHz, interrupt on GPIO21 active low, coordinate space declared as 368x448, reset released by the expander power-cycle above. That replaced the commonly-published register map this pack shipped with, which had never been confirmed anywhere.
The FT3168 branch (original-revision boards) is unchanged and still inherited from this repository's RP2350 sibling pack, hardware-confirmed there on the same controller and panel family, on different silicon.

**Nobody has put a finger on this board through this pack.** Touch is exercised by devlink injection (`DOWN`/`MOVE`/`UP`), which enters the runtime at exactly the point `touch_poll()`'s result would, and therefore proves the runtime and the app, not the controller. A real contact producing a correct coordinate is still unverified here.

**The IMU shake threshold needs a human, and says so out loud.**
`main/imu.c`'s gravity/shake separation is adapted from fluidbox, proven there for a continuous fluid simulation. The threshold-and-cooldown detector on top of it (`SHAKE_THRESHOLD_MPS2` 14.0, `SHAKE_MIN_JOLTS` 3, `SHAKE_WINDOW_MS` 600) is this pack's own and **cannot be calibrated by anything automated**: devlink's `ERASE` injects the resulting event and never touches that code path at all.
So `imu_poll()` now reports the largest gravity-removed magnitude of each one-second window to the console. **Measured here:** 0.01-0.07 m/s2 with the board still on a desk, against a 14.0 threshold, which says the floor is quiet and says nothing yet about where a real shake lands. Pick the board up, shake it, read the numbers, then set the constant.

**Arduino was rejected because ESP-IDF measures 200-300fps against Arduino's 50-60fps on this exact panel.**
Waveshare's own LVGL demo comparison is the source (see `esp32-fluidbox/fluidbox/README.md`, "Why ESP-IDF and not Arduino"): the Arduino path goes through the Arduino TFT library rather than driving the panel with DMA directly, and this pack's band pipeline needs that direct control.

**`bun run harness:selftest` DIVERGES when `wasm/dist/emu.wasm` is this pack's demo app, and the app is why, not the harness.**
The self-test replays a synthetic trace through the emulator and through `harness/fixtures/loopbackLink.ts`, which is a second copy of the same module driven in REAL time rather than on the trace's synthetic clock. The demo app's square moves with `dtMs`, so the two sides legitimately disagree about where it is (measured: 356 mismatching pixels at t=32ms, 7200 at t=320ms). Build any time-independent app into the module - the chrono port, or the demo held under a finger, which is what `harness/inputs/esp32-demo-touch.trace.json` does - and it passes. The same applies to a hardware diff: a trace against this demo is only comparable while the square is being held still by a touch.

**A long build path can break the build before your code does.** ESP-IDF warns that `mbedtls`'s object directory exceeds CMake's 250-character path limit when this pack is built from inside a git worktree under `.claude/worktrees/`. It built anyway, but if it ever does not, `idf.py -B <short path>` is the answer, not a source change.

**`main/` has now been built, flashed and run.** See `docs/decisions/0001-what-the-first-flash-found.md` for what that first flash found, and `README.md` for exactly which claims are silicon-proven and which are still emulator-only.
