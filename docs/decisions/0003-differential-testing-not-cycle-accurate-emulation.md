# 0003: A differential test harness, not a push toward cycle-accurate chip emulation

Date: 2026-08-13
Status: accepted

## The question

Once an emulator exists and works, the obvious next ambition is "make it
more faithful": model the real chip's peripherals, its bus arbitration, its
timing, so more classes of bug show up here instead of only on hardware.
This decision records why that is explicitly NOT the direction this repo
took, in favour of the differential harness (`docs/harness.md`) instead.

## What the research behind this repo's source project found

Before this repo was extracted, its source project surveyed the actual
emulator landscape for its own microcontroller (an RP2350) as a concrete
test case, not a hypothetical one. The findings, condensed:

- Every project found that emulates that chip family stubs or omits
  exactly the peripherals real firmware depends on most (DMA, I2C, PIO,
  flash/XIP arbitration). The most complete one found is a single-author
  research project, weeks old at the time, explicitly labelled "no
  promises."
- Even Speculos - Ledger's own emulator, and the strongest fidelity claim
  found anywhere in that research (it runs the actual shipped binary) -
  gets there by trapping ONE instruction into a narrow OS syscall
  reimplementation, which works only because a Ledger app never touches
  hardware directly. It does not model any chip peripheral at all; there
  is nothing underneath the syscall trap to model, because BOLOS (the real
  OS) never runs inside it either.
- Every mature deterministic-replay tool surveyed (Renode, QEMU's
  record/replay, tool-assisted-speedrun tooling) treats determinism as a
  prerequisite, and is explicit that TIMING FIDELITY is not something it
  guarantees, even when it tries hard to. Wokwi's own cycle-accurate AVR
  core still has documented, user-reported timing divergence from real
  boards.

## The concrete test case

The source project's single hardest bug in its own history was a timing
race: one CPU core borrowing a flash chip-select for on the order of 100
microseconds, with interrupts disabled only on the calling core, racing a
second core's own instruction fetch over the same bus. No emulator
surveyed - including the most complete one found, and including Speculos's
architecture applied hypothetically to this problem - would have caught
it, because catching it needs a cycle-accurate model of that specific
chip's bus arbitration under concurrent access from two cores, which is a
different, much larger undertaking than an ABI-boundary emulator, and
nothing surveyed claims to have built it for any comparable chip.

## Decision

**Do not chase peripheral-level or cycle-accurate fidelity.** Keep the
ABI boundary this repo already has (an app never touches hardware
directly, only a documented set of host-supplied functions - see
`docs/abi.md`), and invest instead in the differential harness
(`docs/harness.md`): replay the same recorded input trace through the
emulator and through real hardware, and diff the resulting frames. This
is cheap (it reuses the recording/replay machinery the emulator core
already needs for its own debugging loop), catches real behavioural
divergence between the two builds, and makes no claim about timing at all
- which means it cannot mislead anyone into thinking it does.

## What this means in practice

- The emulator's clock stays exactly what it already is: whatever the
  host hands `emu_tick(nowMs)`. No cycle counter, no "instructions per
  tick" readout, nothing that could be read as a timing claim.
- The differential harness's own documentation states its bound
  explicitly (see `docs/harness.md`'s "What this catches, and what it
  cannot"), including the source project's own hardest bug as the concrete
  example of a real, shipped bug this approach would not have caught.
- If a future firmware built on this repo genuinely needs peripheral-level
  fidelity (a bus contention bug that keeps recurring, say), that is a
  different, much larger project - closer in scope to the "no promises"
  research emulator mentioned above than to anything this repo aims to be
  - and should be evaluated on its own, not folded into this repo's scope
  by increments.
