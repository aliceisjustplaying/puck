# Hardware gotchas

**Every pushed window row must be a multiple of 8 pixels, or the transfer corrupts.**
Round the row length up, and slide the window left at the right edge instead of shortening it.
The start column does not need 8-pixel alignment, and a 64-pixel minimum is an obsolete workaround. See [decision 0001](docs/decisions/0001-push-min-width.md).

**Keep the local off-by-one patch in `AMOLED_1IN8_DisplayWindows`, and never replace the driver with a fresh vendor copy.**
The vendor loop sends one fewer row than the programmed window, so the bottom row of each partial refresh is lost.
This is separate from the 8-pixel row-width rule, and re-copying upstream restores the bug. See [decision 0001](docs/decisions/0001-push-min-width.md).

**Use a full framebuffer on this RP2350 pack, not the band renderer required by a lower-memory sibling.**
The 368 by 448 RGB565 framebuffer costs about 330 KB and fits in the RP2350's 520 KB SRAM.
The runtime owns that buffer and pushes dirty rectangles from it. See [decision 0002](docs/decisions/0002-runtime-architecture.md).

**Keep touch, IMU, and PMIC work on core1 after sensor startup.**
A touch read measured about 695 microseconds, roughly 98 percent of the old frame time, so core1 owns `i2c1` and publishes signals to core0.
Core0 must not touch that bus after ownership transfers. See [decision 0002](docs/decisions/0002-runtime-architecture.md).

**Treat the XIP window as the active partition's flash mapping, not as an independent safe copy of code.**
Core0 borrows the flash chip select to read BOOT, so either core fetching through XIP during that window can receive garbage.
The shipped defense is whole-image `copy_to_ram`, checked on the linked artifact. See [decision 0004](docs/decisions/0004-the-day-the-instruments-lied.md) and [decision 0005](docs/decisions/0005-rca-core1-dies-on-first-button.md).

**Recover a non-booting board by removing power long enough for the PMIC to drop the rails.**
Unplug USB, hold PWR for at least 12 seconds until the screen goes black, then hold BOOT while plugging USB back in.
Replugging alone is not a reset because the PMIC keeps the board powered. See [decision 0002](docs/decisions/0002-runtime-architecture.md).
