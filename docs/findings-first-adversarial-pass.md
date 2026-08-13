# First adversarial pass

Date: 2026-08-14
Method: hostile firmware modules built for real as `wasm32-freestanding`, driven
through the actual dev server in headless Chrome, reading real `pageerror`
events. Not inspection. Where a finding rests on inspection alone, it says so.

## The headline

**The emulator can die and go on looking alive.**

There is no exception boundary around the tick loop. `src/wasm.ts` states the
contract plainly: "a failure here must never tear down a module that was
already working." `bringUp()` honours it for exactly three failures, and those
three were verified good: an invalid device descriptor and a missing panel both
produce the clean `#wasmError` banner the docs promise.

Nothing after that is guarded. Not the tail of `bringUp()`, not `frame()`, not
`stepOnce()`, not `afterTick()`.

Four modules, four ways in, one outcome:

| What the firmware does | What is thrown | Where |
| --- | --- | --- |
| `emu_fb()` returns `0x7FFFFFFF` | `RangeError`, offset not a multiple of 2 | `bringUp()`'s unguarded `blitAll()` |
| a sensor entry omits `"id"` | `TypeError` on `s.id.toLowerCase()` | `buildChrome()` |
| a push rectangle at `y=1000000` on tick 2 | `RangeError`, invalid typed array length | inside the `requestAnimationFrame` callback |
| `emu_tick()` writes through a wild pointer | `RuntimeError`, memory access out of bounds | the same callback |

The third is the worst of them, and it is worth being precise about why. The
rectangle arrives on the **second** tick, so the page loads, paints, and looks
entirely healthy first. Then the tick counter freezes and stays frozen, with
the device name still on screen and the last frame still painted. Nothing says
anything happened.

A fifth path has the same shape and was found by inspection rather than built:
`src/audio.ts`'s `play()` constructs an `Int16Array` over `emu.memory.buffer`
from an ABI-returned pointer and frame count, with no bounds checking, on every
tick.

## Why this particular defect matters more than its size

The docs call the push-window overlay this tool's single highest-value feature,
and they are right to, **because bad push geometry is the characteristic bug of
a young firmware**. That is the same class of bug that silently freezes the
tool built to catch it, in a newcomer's first hour.

Their honest first reaction will be to suspect their own C. They will be
looking in the wrong place, and the emulator will be quietly agreeing with
them, because a frozen tick counter under a correctly painted panel is
indistinguishable from firmware that has stopped drawing.

This is the same failure the device project spent a day on and wrote up in
`0004-the-day-the-instruments-lied.md`: an instrument that reports health while
broken is worse than no instrument. It has reappeared here, in the instrument
built in response.

## The consequence that reaches an agent

`docs/agent-loop.md` sells the freeze bundle as the artefact you hand to an
agent. A freeze taken **after** a silent death still succeeds, because it reads
the last painted canvas and the recorder's existing history, neither of which
needs the loop to be alive. It produces a bundle that looks completely
ordinary: valid pushes, a valid input trace, and nothing anywhere saying this
session died N events ago or why.

An agent reading it will conclude the firmware stopped drawing. The bundle will
have misled it, in the format designed to inform it.

## Claim violations, both fixed

Two things the repo said about itself were false.

`src/touchoverlay.ts` derived `DEFAULT_PX_PER_MM` from `sqrt(368² + 448²) / 1.8`,
which is the exact panel geometry and screen size of the one real device this
repo was extracted from. `AGENTS.md` is explicit and even names the tell: "if
you're about to write 368 as a literal anywhere outside `example/`, stop." The
derivation is gone; the constant is unchanged.

`wasm/emu_abi.h` cited `docs/decisions/0001-push-min-width.md`, which does not
exist in this repo. It was left behind by the extraction. The story is now
attributed without a broken local path.

## Fixed during the pass

`example/build.ts` printed a helpful `"zig not found? set ZIG_EXE..."` message
that could never run: `Bun.spawnSync` **throws** when the binary is missing
rather than returning a failed result, so the help was dead code on the single
most likely way a newcomer's first build fails. Verified three ways after the
fix (zig off `PATH`, `ZIG_EXE` unset, `ZIG_EXE` pointing at nothing): the
intended message prints every time.

## Open, in the maintainer's court

- `harness/diff.ts`'s `main()` has no top-level catch, so a truncated trace or
  a `HardwareLink` timeout prints a raw stack trace instead of the tool's own
  error style. **An infra failure is never mislabeled as a firmware
  divergence**, which was the thing most worth checking, and it holds: a crash
  looks nothing like the `FAIL: N frame(s) compared` report.
- That same path exits `1`, the same code as a real divergence. The text
  distinguishes them; the exit code does not, and CI reads exit codes.
- No timestamp monotonicity check anywhere in `harness/`. `docs/harness.md`
  anticipates hand-built traces, and an out-of-order one silently produces a
  wrong or skipped capture point.
- `emu_push_count()` has no upper bound in `readPushes()`, so an absurd count
  drives an unbounded per-tick loop before a bad rectangle gets its chance to
  throw.

## The newcomer path, timed

`bun install` to a painted panel is well under a minute, **given zig already
installed**. Every step downstream of that matched the docs exactly, including
the missing-wasm-module state, which shows a correct banner rather than a blank
page.

Zig is the whole risk in that sentence. It was found at a path not on `PATH` by
default, and until the fix above, that case printed nothing useful.

## What a first-hour user reaches for and does not find

1. **Any sign the emulator itself died**, as distinct from a stuck firmware.
   The defect above, restated as a product gap.
2. **One step backward.** Pause and step-forward exist; rewind is honestly
   scoped out in `docs/requirements.md`. Documented absence is still absence,
   and it compounds with the first: the moment you most want to step back is
   the moment the tool has already frozen.
3. **A regression check that needs no hardware.** Every ingredient exists and
   is tested (the recorder, `emulatorSide.ts` replay, `compare.ts`, and
   `harness:selftest` proves the mechanism works against the emulator alone),
   but it is wired together only for the emulator-versus-hardware CLI. Someone
   iterating before a board exists has no in-page "compare against my last
   known-good trace".

## A note on the method

`zig cc` failed on roughly one first attempt in four on this machine and was
clean on immediate retry. That matches what the source project already
documents and looks like local cache contention, not a defect here. It was not
chased.
