# Reference snapshot

The living source is [`s0lness/esp32-fluidbox`](https://github.com/s0lness/esp32-fluidbox) (local
checkout: `C:\Users\sylve\projects\esp32-fluidbox`), MIT licensed. `sim.c`/`sim.h`, `render.c`/
`render.h` and `config.h` beside this file are a snapshot of `fluidbox/main/`, copied at commit
`21d7516d143da25bab9176257131d01a66a2573d` (2026-08-06).

FluidBox predates this repository's app-bundle convention: it is custom ESP-IDF firmware for a
Waveshare ESP32-S3-Touch-AMOLED-1.8, a 3D-boxed particle fluid (Clavet double density relaxation)
driven by the onboard IMU, with no notion of a descriptor, a trace, or a device-agnostic ABI.
`apps/fluidbox/descriptor.md` was extracted from this snapshot (plus `README.md` and
`fluidbox/README.md` at the same commit) by reading, not by running the donor's own build: the
Essence, Interactions and Demands sections restate what the donor code and its own measurements
already say, in the convention's vocabulary.

`main.c`, `display.c`, `imu.c` and `button.c` are not snapshotted here: they are ESP32-S3-specific
(FreeRTOS tasks, QSPI band DMA, QMI8658 register access, a TCA9554 IO-expander button read) and
carry no portable logic a device-agnostic port needs to read. The physics (`sim.c`) and the
rendering approach (`render.c`, read for its ideas, not reused line for line) are the reusable
core; `config.h` is every tunable constant the physics and rendering depend on.
