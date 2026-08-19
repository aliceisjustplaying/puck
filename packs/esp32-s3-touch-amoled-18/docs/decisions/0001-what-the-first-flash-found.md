# 0001: What the first flash found

Date: 2026-08-19
Status: accepted

## The claim being tested

This pack shipped with an `AGENTS.md` section titled "`main/` is written but
not yet flashed", and a file-by-file account of where each piece came from:
`display.c`, `button.c` and `imu.c`'s bring-up adapted "nearly verbatim" from
a separate project (`esp32-fluidbox`) that runs on this exact board, `touch.c`
carried over from this repository's RP2350 sibling, `main.c` new. The
inheritance was described carefully and honestly. The question this record
answers is what that careful inheritance was actually worth once an ESP-IDF
install existed and the board was on the desk.

Answer: the emulator half was right, the app was right, and the board half did
not link. Three separate defects, none of which reading could have settled,
and one of which nothing about the inherited code could have contained.

## 1. Two of the four platform hooks were never implemented

`firmware/runtime/runtime_core.h` declares four host-provided functions:
`plat_acquire_band`, `plat_flush_band`, `rt_log` and `rt_halt`. `main/`
implemented the first two, in `display.c`. It implemented neither of the other
two, anywhere. The wasm half (`wasm/emu_shim.c`) had all four from the start,
which is why nothing ever noticed.

```
runtime_core.c.obj:(.literal.app_alloc+0xc): undefined reference to `rt_log'
runtime_core.c.obj:(.literal.app_alloc+0x10): undefined reference to `rt_halt'
```

This is the shape of defect the "not yet flashed" warning existed for, and it
is worth naming precisely: it is not a subtle hardware mismatch or a wrong
register. It is a link error, the cheapest possible class of bug, sitting
undiscovered for the entire life of the file because the link was never run.
An unflashed firmware half is not "probably fine, unverified". It is a claim
with no compiler behind it.

## 2. The panel was never powered

`display.c` inherited fluidbox's SPI configuration, its init command list, its
band pipeline and its board-revision probe. It did not inherit any code that
touches the TCA9554 IO expander at I2C 0x20, because in the file it was adapted
from that work happens elsewhere. On this board bit 0 of that expander is the
LCD's reset line, bit 1 is display power and bit 2 is the touch controller's
reset. `esp_lcd_panel_dev_config_t.reset_gpio_num = GPIO_NUM_NC` in the
inherited configuration does not mean "this panel has no reset"; it means
"the reset is not somewhere this driver can reach".

The fix is `reset_panel_power()` in `main/display.c`, taken from tinydraw's
`esp32/main/co5300_panel_transport.cpp` (a separate local project, same
enclosure, measured receipts): drive the three lines low, wait 20ms, drive them
high, wait 150ms, retry up to three times with an I2C bus reset in between
because the expander does not always answer on a cold boot. `button.c` still
owns EXIO4 afterwards, so `display_init()` removes its own device handle from
the bus before returning.

**The wider lesson, which is the reason this record exists:** an adaptation
inherits what the source file DOES, never what its neighbours do for it. Both
halves of a peripheral's bring-up have to be accounted for, and the half that
lives somewhere else is exactly the half a careful reading of one file will
miss.

## 3. The QSPI clock was a number nobody had measured

The inherited configuration asks for 80MHz and the pack's own `gotchas.md`
explained the reasoning at length, including that these signals go through the
GPIO matrix rather than IOMUX. tinydraw's measurements on this panel say the
line rate lands at roughly 40MHz whatever is requested, and its own driver asks
for 40. The value is now 40 here too. Nothing about the picture changed; what
changed is that the constant in the source no longer claims a rate the wire
does not carry.

## What was inherited and turned out to be right

Said as plainly as the failures, because "the port was wrong" is not the
finding: the band pipeline is right. Two DMA buffers, a counting semaphore
initialised to 2, released by the panel's transfer-done interrupt, with
`plat_acquire_band()` blocking on it, produced a steady **50 frames per second
of full-panel repaint** on the first boot that got that far, with the loop
paced entirely by that semaphore. 50fps of 368x448 RGB565 is 8.2MB/s of pixels
out over QSPI, which is the same order as tinydraw's measured ~18ms full frame.
The memory model this whole pack exists to demonstrate works on the hardware it
was designed for.

The IMU came up on the first boot too and reports sane numbers (0.01-0.07 m/s2
of residual acceleration on a still desk).

## Consequences

- `AGENTS.md`'s "not yet flashed" section is replaced by what is now known.
- `main/touch.c`'s CST820 branch was replaced by the proven driver rather than
  fixed in place: see `gotchas.md` and that file's header comment.
- The pack now has a `gate/` (`bun run pack:esp32:gate`) whose first check is
  the one that would have caught defect 1 without a board: every symbol
  `runtime_core.h` declares as host-provided must be implemented by the board
  half's own sources.
