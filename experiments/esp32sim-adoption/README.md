# esp32sim adoption: first boot receipt

Date: 2026-08-31. The lane A baseline measurement for decision
[0011](../../docs/decisions/0011-adopt-esp32sim-execution-foundation.md):
what happens when TinyDraw's real, unmodified ESP32-S3 firmware runs on
esp32sim today, before any of this project's contributions.

## Command

esp32sim at commit `2114ffc`, built with `cargo build --release`
(clean check on this machine), run against the TinyDraw gate-harness
build (IDF v6.0.2, `tinydraw_esp32.bin`, ELF SHA-256 `51cc3223...` as
printed by the app itself) with the Espressif `esp32s3_rev0_rom.elf`
(esp-rom-elfs 20241011):

```sh
esp32sim --board none --boot rom --console usb \
  --bootloader .../bootloader/bootloader.bin \
  --ptable .../partition_table/partition-table.bin \
  --app .../tinydraw_esp32.bin --elf .../tinydraw_esp32.elf \
  --flash-mb 16 --psram-mb 8 --log-periph --max-seconds 15
```

## Result ([`tinydraw-first-boot.log`](tinydraw-first-boot.log))

Boots completely: mask ROM, IDF v6.0.2 second-stage bootloader, QIO
flash, octal PSRAM (vendor negotiation, MSPI timing tuning, memory test
OK, 8 MB added to heap), both cores, FreeRTOS, `app_main()`, TinyDraw's
workspace allocator and coverage instrumentation, autosave restore, and a
clean return into the dual-core idle loop. 64.9 Minsn/s combined on this
machine, 15 emulated seconds in 0.9 s wall.

The firmware's own bootstrap diagnosis names the gap exactly:

```
TINYDRAW_PANEL_HARD_RESET=0 attempts=3 ... first_failure_stage=configure
E CST816S: touch_cst816s_read_id(200): I2C read failed
TINYDRAW_LIVE_FAIL reason=bootstrap canvas=1 log=1 presenter=0 touch=0 builder=1 producer=1
```

## What this proves for lane A

- ESP-IDF v6.0.2 boots unmodified (previously an open question; esp32sim's
  own examples are IDF 5.5).
- Octal PSRAM, QIO flash, USB console, and the whole boot path need no
  work.
- The complete missing list for a drawing, touchable TinyDraw is:
  the GP-SPI (SPI2) master, an SH8601-class QSPI panel model plus the
  board's TE line, and the touch controller as an I2C device (the firmware
  also expects the PCF85063A RTC, whose driver already initializes against
  the current I2C model). Unknown-register traffic during boot is limited
  to SENSITIVE, APB_SARADC, ASSIST_DEBUG, and radio blocks, all tolerating
  the log-and-ignore default.
- The firmware states its own panel expectations in the log
  (`te_edge=rising clock_mhz=40`), matching the pack's measured receipts.
