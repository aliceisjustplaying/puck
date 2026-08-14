# Plan

This plan records sequencing and the condition that makes each parked item
worth starting. It is not a promise to broaden Puck into an RTOS or hardware
emulator. See `docs/decisions/0005-no-rtos-api-shimming.md`.

## Phase 0: honest C++ and WASI support

Current work:

- load C++20/libc++ `wasm32-wasip1` reactors through the same raw wasm path as
  freestanding C
- keep the WASI import surface narrow and deterministic
- maintain a self-contained C++ reactor fixture and pinned toolchain record
- provide one strict ABI auditor for ecosystem modules
- stop trace recording at capacity and mark truncation explicitly
- document the platform-neutral application boundary

## Phase 1: harden the TinyDraw V1 port

Commit and harden the TinyDraw V1 Puck port in the TinyDraw repository. This
phase includes:

- collapse push overflow to one full-frame refresh so rendered output remains
  correct
- make and document the idle-tick decision
- handle timestamp wrap explicitly
- use one canonical shared trace artifact
- pin framebuffer hash `f5122b6b`

Phase 1 is complete only when those behaviors are tested in that repository,
not merely described here.

## Parked work

### TinyDraw V2 port

**Unblocks when:** the V1 port is committed and hardened, so V2 can test the
same integration boundary rather than copy a moving target.

Landing V2 provides the second real consumer needed before extracting a shared
kit.

### Shared kit extraction

**Unblocks when:** both TinyDraw V1 and V2 are real, working consumers with
concrete duplicated integration code. The kit must be born from those two
consumers, not designed speculatively from one.

### Epoch time and persistence ABI groups

**Unblocks when:** the first application has a concrete need for each group.
Epoch time will use recorded clock anchors. Persistence restore will happen
after initialization and before the first tick. Replay runs will use isolated
stores so one run cannot leak state into another.

### Hardware differential link

**Unblocks when:** the device has a same-source reducer for injected events and
there is a real `HardwareLink` transport to exercise it. A loopback fixture is
not the hardware side of this work.

### `hardware_app.cpp` migration

**Unblocks when:** the platform-neutral interfaces exercised by the hardened
ports are stable enough to move application behavior without introducing
FreeRTOS, ESP-IDF, or other platform shims into Puck.
