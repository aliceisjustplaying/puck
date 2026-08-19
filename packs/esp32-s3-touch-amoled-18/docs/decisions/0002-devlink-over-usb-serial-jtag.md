# 0002: devlink speaks the sibling's protocol, over the native USB Serial/JTAG port

Date: 2026-08-19
Status: accepted

## The problem

`harness/diff.ts` replays one input trace through the emulator and through
real hardware and diffs the frames. The hardware side is a `HardwareLink`
(`harness/types.ts`), and the repository has exactly one real implementation:
`harness/links/devlinkLink.ts`, written against the RP2350 pack's `devlink`
protocol over that board's USB CDC port. Without an equivalent on this board,
this pack's firmware could only ever be verified by a person looking at it.

Three things had to be decided: what wire to use, what protocol to speak on it,
and how a screenshot can exist at all on a board that has no framebuffer.

## The wire: the native USB Serial/JTAG port, shared with the console

The ESP32-S3 has a USB Serial/JTAG peripheral built into the chip. It
enumerates as one plain CDC serial port with no external bridge chip, it is the
port `esptool` already flashes through, and it is the only USB the enclosure
exposes. The alternatives were a UART on broken-out pins (this enclosure breaks
out none), TinyUSB with a second CDC interface (a large dependency, and it
takes over the same peripheral), or WiFi (a network, a configuration, and a
second failure domain to debug a firmware through).

So: one port, shared between the console's own log output and devlink's
request/reply traffic. **This is the same arrangement the RP2350 pack has**,
where its runtime's `printf` debug lines share the port with devlink replies,
and the reasoning for leaving it that way carries over unchanged (see that
pack's `tools/README-devlink.md`, "Why this is a host-side fix, not a firmware
one"): the shared port is worth real money as a human-readable console, and the
host already has to tolerate interleaved noise by matching the reply shape it
is waiting for rather than trusting the first line back. `devlinkLink.ts` does
exactly that, by construction, for both boards.

`CONFIG_ESP_CONSOLE_USB_SERIAL_JTAG=y` in `firmware/sdkconfig.defaults` is what
puts the console on that port; the IDF default is UART0, on pins this board
does not break out.

### What that cost, measured rather than assumed

Two traps, both found on the bench, both now in `gotchas.md`:

1. **The default console cannot read.** With ESP-IDF v6.0.2 and no
   `usb_serial_jtag` driver installed, `read()` on `stdin` sizes every fetch
   from `usb_serial_jtag_get_read_bytes_available()`, which returns 0 flat
   unless the driver is installed. So a non-blocking read computes a fetch size
   of zero and returns without ever touching the RX FIFO. The symptom is not a
   quiet devlink: the board never drains its USB OUT endpoint, so the HOST
   blocks, and a plain `pyserial` write to the board times out. `main.c`
   installs the driver for RX and deliberately does NOT call
   `usb_serial_jtag_vfs_use_driver()`, because that would move console writes
   onto the driver's TX ring, which blocks when full - and a board that freezes
   when nobody is plugged into it would be a serious regression bought for
   nothing. The no-driver TX path drops output after 50ms of an unlistening
   host, which is the behaviour a standalone board needs.
2. **Line endings.** The console converts `\n` to `\r\n` by default. devlink's
   replies already end in `\r\n` per the protocol, which that default turns
   into `\r\r\n`: every reply then arrives at the host with a stray carriage
   return still attached and every match fails for a reason that looks nothing
   like its cause. `main.c` sets `ESP_LINE_ENDINGS_LF` so line endings pass
   through verbatim.

## The protocol: the sibling's, unchanged

`PING`, `SHOT`, `DOWN`/`MOVE`/`UP`/`TAP`, `ERASE`, `KEY`, `BOOT`, `CHORD`,
`APP`, `SWITCH`, `TUNE`, and the same reply grammar, byte for byte, documented
once in `packs/rp2350-touch-amoled-18/tools/README-devlink.md`.

The alternative was a protocol shaped around what this board actually has
(one app, no menu, no tunables), which would have been smaller and would have
cost a second `HardwareLink`, a second host CLI, and a second document. Two
copies of a wire protocol agree exactly once, on the day the second is written.
Speaking the existing one means `devlinkLink.ts` drives both boards, and the
only per-board configuration is two environment variables:

- `DEVLINK_PORT`, which already existed.
- `DEVLINK_DTR=0`, which did not. The RP2350's USB CDC stack looks dead unless
  DTR is asserted before the port is opened; on an ESP32-S3 the same line is
  wired by the USB Serial/JTAG peripheral to the chip's own boot strap, so
  asserting it presses a button nobody touched. That is a property of the
  transport, not of either firmware, which is why it is a parameter on the
  serial bridge rather than a branch anywhere.

Commands this board has nothing to do with are answered rather than removed:
`SWITCH` accepts index 0 only, `TUNE` answers `ERR no tunables` (a shape the
protocol already defines), `CHORD` composes `BOOT`+`KEY` faithfully even though
no app here reads it. A client can ask both boards the same question and read
the difference in the answer, which is worth more than a shorter table.

`SWITCH 0` is not a no-op even with one app. It calls `rtcore_reset()`, which
rewinds the arena and re-enters the app: that is what gives
`harness/hardwareSide.ts`'s reset step something to reset TO, so a differential
run starts from the state `emu_init()` starts from rather than from wherever
the last person left the board.

## The screenshot: captured at flush time, in the wire's own format

The RP2350's `SHOT` walks its framebuffer twice, inside the command's own
dispatch. **This board has no framebuffer** - that is the entire point of the
pack (`AGENTS.md`, `firmware/runtime/app.h`) - so there is nothing to walk. The
picture only exists as 16 band buffers streaming past `plat_flush_band()`.

Three options were considered:

1. **Add a framebuffer.** Rejected outright: it would delete the one claim this
   pack exists to make. 322KB of RGB565 does not fit twice in 512KB of internal
   SRAM, and in PSRAM the CPU writing pixels would fight the panel's DMA for
   the external bus.
2. **Re-render into a host-side buffer.** Would mean a second drawing path that
   is not the one the panel sees, which is precisely the kind of stand-in the
   harness exists to avoid.
3. **Capture what actually goes out.** `SHOT` arms a capture; each band, as it
   is handed to the panel, is also converted into 8-bit grey and written into a
   PSRAM buffer; when band 15 lands the frame is complete and the reply goes
   out. This is what was built.

Three properties make this honest rather than convenient. It captures the bytes
the panel is actually being sent, not a re-derivation. It costs nothing when no
capture is armed, which is almost always. And the buffer is never on the DMA
path (the panel still streams out of the internal-SRAM band buffers), which is
what makes PSRAM acceptable for it when a real framebuffer there would not be.

The stored byte is the wire format's own encoding, computed once at capture
rather than converted twice later: undo the panel's byte order, take the six
green bits as the grey level. `harness/links/devlinkLink.ts`'s `greyToRGB()` is
the exact inverse, so a matching frame matches at tolerance zero.

**The one visible consequence for a client: `SHOT` is answered one frame late.**
The command arms the capture and returns without printing anything; the reply
is emitted from the next `devlink_poll()`, after the tick that painted the
frame. A host sees a `SHOT` header tens of milliseconds later instead of
immediately, and needs no code to know that. It is why `main.c`'s loop order
(inputs, `rtcore_tick()`, `devlink_poll()`) is part of the contract and not a
style choice.

## What this still cannot test

Everything the sibling's `README-devlink.md` says under "What injection cannot
test", with this board's chips substituted. `KEY` hands the runtime a PWR
gesture without going near the TCA9554 read that a real thumb goes through;
`BOOT` skips the GPIO0 sample; `ERASE` bumps the shake counter without the
QMI8658 or `imu.c`'s threshold being involved at all. A green differential run
proves the runtime, the app and the band pipeline agree with the emulator. It
proves nothing about whether a real finger, a real button or a real shake ever
reaches that code.
