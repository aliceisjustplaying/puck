# 0005: Do not shim RTOS or vendor APIs

Date: 2026-08-14
Status: accepted

## Context

A firmware application may be entangled with FreeRTOS, ESP-IDF, or another
board runtime. Reproducing those APIs in the wasm build can look like the
shortest path to compiling an existing firmware shell unchanged. It is not a
stable boundary: each shim inherits undocumented scheduling, driver, storage,
and lifecycle behavior, while still being unable to reproduce the hardware
that gives those calls their real meaning.

That approach would also invite fidelity claims Puck cannot support. Decision
[0003](0003-differential-testing-not-cycle-accurate-emulation.md) rejects
peripheral-level and cycle-accurate emulation in favor of explicit ABI behavior
and differential testing.

## Decision

Puck will never provide compatibility shims for FreeRTOS, ESP-IDF, or any other
RTOS or vendor platform API so a firmware shell can run unchanged.

The supported integration path is a platform-neutral application core behind
interfaces owned by the firmware project. The hardware build implements those
interfaces with its real RTOS, drivers, and services. The wasm build implements
the same firmware-owned interfaces using Puck's small ABI. MCU startup, tasks,
interrupts, peripheral drivers, and vendor lifecycle code remain outside the
portable core.

## Consequences

- Porting may require extracting application behavior from an existing
  platform shell before Puck can run it.
- Firmware projects keep control of their abstraction boundary instead of
  depending on a Puck-specific imitation of a vendor SDK.
- Scheduling, driver timing, and RTOS behavior remain hardware-only concerns.
- Puck can stay deterministic and device-agnostic while compiling the real
  application logic again for wasm.
