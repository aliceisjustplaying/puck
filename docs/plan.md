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

## Next Puck work

### Persistence host cache

Implement the optional storage group from
[decision 0006](decisions/0006-persistence-is-a-host-cache.md). Interactive
reload may restore a matching guest-owned snapshot after initialization and
before the first tick. Replay, regression, audit, hostile tests, verify, and
the harness keep isolated empty stores, and traces remain event-only.

### Battery input

Implement the optional latched battery input from
[decision 0007](decisions/0007-battery-is-a-latched-input.md). Battery state is
recorded in trace schema 3 and delivered before a tick like touch. The page
does not simulate voltage, dimming, sleep, or battery physics.

## Out of this campaign

### Shared kit extraction

The kit is explicitly outside this campaign.

**Unblocks when:** both TinyDraw V1 and V2 are real, working consumers with
concrete duplicated integration code. The kit must be born from those two
consumers, not designed speculatively from one.

## Parked work

### TinyDraw V2 port

**Unblocks when:** the V1 port is committed and hardened, so V2 can test the
same integration boundary rather than copy a moving target.

Landing V2 provides the second real consumer needed before extracting a shared
kit.

### RTC input

**Rejected for now:** no current application needs epoch time, and recorded
clock anchors would widen the deterministic trace contract without a concrete
consumer.

### Dim and sleep simulation

**Rejected for now:** browser dimming or tick suspension would invent display
and power-management behavior that Puck cannot claim matches hardware; see
[decision 0007](decisions/0007-battery-is-a-latched-input.md).

### Hardware differential link

**Unblocks when:** the device has a same-source reducer for injected events and
there is a real `HardwareLink` transport to exercise it. A loopback fixture is
not the hardware side of this work.

### `hardware_app.cpp` migration

**Unblocks when:** the platform-neutral interfaces exercised by the hardened
ports are stable enough to move application behavior without introducing
FreeRTOS, ESP-IDF, or other platform shims into Puck.
