# Requirements: what a good emulator like this needs to be

This tool exists to run your firmware's own C, compiled to WebAssembly, not
a reimplementation (see
[`docs/decisions/0002-two-compilers-not-one.md`](decisions/0002-two-compilers-not-one.md)).
Everything below asks what follows from that: what makes a tool like this
actually useful to someone iterating on firmware, day to day, optionally
with a coding agent alongside them.

## Four requirements, in order of importance

1. Very easy to launch.
2. Very fast to iterate on apps.
3. Easy screenshots, optional annotations, and a "freeze" that produces
   something an agent can act on.
4. Debugging capability.

Everything that follows is either in direct service of one of these four,
or a foundation several of them stand on.

## What research into mature emulators says

A grounding pass across the tools people actually rely on for embedded
development and debugging - [Wokwi](https://docs.wokwi.com/) (a
browser-embedded simulator real teams use for daily Arduino/ESP32/Pico
work), [Renode](https://renode.io/) (Antmicro's deterministic, multi-node
embedded simulator, built specifically for testing),
[QEMU's record/replay](https://www.qemu.org/docs/master/system/replay.html)
and [gdbstub](https://qemu-project.gitlab.io/qemu/system/gdb.html), the
tool-assisted-speedrun community's decades of practice on save states and
input movies, [Chrome DevTools' DWARF support for wasm](https://developer.chrome.com/docs/devtools/wasm),
and the CI practice of hashing framebuffers against golden images - turned
up a few things worth stating plainly, because they cut against the
assumption that "more fidelity is always better":

- **Every one of these tools treats determinism as a prerequisite, not a
  feature.** Renode's own description of its "superpower" is representing
  the whole system in one deterministic simulation so it fits a normal CI
  workflow. QEMU's record/replay only works at all because `-icount` makes
  execution deterministic in the first place. This repo's ABI already has
  determinism for free: `emu_tick(nowMs)` takes the host's clock as its
  only time source (`wasm/emu_abi.h`). That single ABI decision is what
  makes everything else in this document cheap.
- **DWARF debugging of wasm in Chrome is real, but reported as fragile in
  practice.** Multiple open issues describe the "C/C++ DevTools Support
  (DWARF)" extension breaking across Chrome releases or failing to load
  sources. It should be offered, not relied on as the primary debugging
  path.
- **Even the tools with the best claim to fidelity are explicit that
  timing is not one of the things they guarantee.** Wokwi's own AVR core
  is cycle-accurate, but real discrepancies between board and simulation
  show up around interrupt timing and real-time peripherals like the RTC.
  This lines up exactly with what
  [`docs/decisions/0003-differential-testing-not-cycle-accurate-emulation.md`](decisions/0003-differential-testing-not-cycle-accurate-emulation.md)
  already concludes: timing is a question for the board, always.
- **CI-grade regression testing for emulators is done with framebuffer
  hashing against golden references**, not visual inspection: a per-frame
  hash written during the run, diffed against a checked-in golden hash,
  fails the build on divergence. The differential harness (`docs/harness.md`)
  is the natural extension of this idea against real hardware, not just a
  golden image.
- **Fault injection is an established, separate discipline from normal
  emulation.** The pattern that recurs is: inject a *misbehaviour* (a
  dropped byte, a stuck register, a bit flip), not a different ideal
  input. That is precisely what this repo's own touch-controller
  simulation does (`src/touchsim.ts`).

## Ranked capabilities

Ranked by value against effort, in the order a project like this should
actually build them. "Effort" accounts for what the ABI already gives for
free (`wasm/emu_abi.h` already exports the push-window log and takes an
explicit `nowMs`), not effort in the abstract.

| # | Capability | Value | Effort | Why | In this repo |
|---|---|---|---|---|---|
| 0 | Determinism (host tick is the only clock) | Foundation | Already paid for | Every other row is cheap or expensive *because* of this row | `wasm/emu_abi.h`'s `emu_tick(nowMs)` |
| 1 | Peripheral push-window overlay | Very high | Near zero | The ABI already exports `emu_push_*`; drawing them is the single highest-value line item, because a partial-refresh bug is invisible without it | `src/overlay.ts` |
| 2 | Structured, filterable guest logging | High | Low | `env.js_log` already exists as an import; a console pane is the same idea every mature tool ships | `src/consolelog.ts` |
| 3 | Freeze bundle (screenshot + JSON) | Very high | Low-medium | The emulator already renders to a canvas, so a PNG capture is nearly free | `src/freeze.ts`, [`docs/agent-loop.md`](agent-loop.md) |
| 4 | Differential testing against real hardware | Very high | Medium | Turns "does the emulator follow the firmware" from a question into a report | `harness/` |
| 5 | Record and replay of input traces | Very high | Medium | This is what determinism buys: an input trace becomes a file that reproduces a bug exactly, every time | `src/recorder.ts`, `src/replay.ts` |
| 6 | Pause / single-step by frame | High | Low | `emu_tick` is already called from a loop; stepping is "call it once, then stop" | `main.ts`'s pause/step controls |
| 7 | Fault injection for peripherals (touch dropouts/strays) | High | Medium | Firmware that handles a real controller's defects only exercises that code against input that actually misbehaves | `src/touchsim.ts` |
| 8 | Save states / snapshot-restore | Medium-high | Medium-high | Compounds with row 5; a snapshot with no trace of how you got there is just a memory dump | Not built - see below |
| 9 | Rewind via a snapshot ring | Medium | High | Very likely not worth building standalone given row 5 - see below | Not built |
| 10 | Source-level DWARF debugging in Chrome DevTools | High when it works | Medium-high, fragile | Real, but upstream reports call the extension unreliable across Chrome versions | Not built into this repo; works if you compile with `-g` and don't strip |
| 11 | Hot reload that preserves app state | Medium | High if done "properly," low if done honestly | See below | Live reload rebuilds + replays rather than preserving live memory |

A cross-cutting note that changes several of these effort estimates at
once: **rows 1, 2, 5, and the differential harness's own trace format are
one mechanism, not four.** All of them are views over the same underlying
thing: a log of `(nowMs, event)` pairs (`emu_touch`, `emu_button`,
`emu_sensor_event`) plus the push-window list each tick produces. Building
that log once (`src/recorder.ts`) is what makes the push overlay, the
record/replay trace, the freeze bundle's `input` field, and the
differential harness's own trace format all just different views of it.

## Determinism as the foundation

The guest's only clock is the host's tick (`emu_tick(uint32_t nowMs)`,
`wasm/emu_abi.h`). A firmware that reads its own clock has broken the
contract and will not be reproducible; the header says so in as many
words. This buys exactly one thing, but it is the thing everything else in
this document depends on: **an input trace makes a bug a file.** Not a
description of a bug, an actual sequence of `(nowMs, event)` pairs that,
replayed against the same wasm module, produces bit-identical framebuffer
output every time.

## Pause, single-step, and rewind via a snapshot ring

Pause and single-step are nearly free: the page already drives `emu_tick`
from a loop, so pausing is "stop calling it" and stepping is "call it
exactly once." Rewind is the interesting case, and mature tools argue
against building it the obvious way (a dense ring of full memory
snapshots, one per frame): TAS tooling, Renode's reverse execution, and
QEMU's reverse-step all instead take periodic SPARSE snapshots and replay
forward from the nearest one, because replaying is cheap when the target
is deterministic and memory is not free.

Given this repo already has the record/replay trace as a cheaper
prerequisite, the recommendation - not yet built here, deliberately left
as a documented option rather than half-built - is: implement rewind as
"restart from `emu_init`, replay the trace up to frame N-1" first, and
only invest in an actual ring of periodic snapshots if replay-from-zero
turns out to be too slow in practice for how large your own sessions get.

## Source-level debugging of the C through DWARF

The concrete build requirement, if you want this:

1. **Compile with debug info and don't strip it.** `zig cc` uses LLVM's
   backend, which supports DWARF generation; passing `-g` embeds it as
   custom sections in the `.wasm` binary. Do not run a stripping pass
   (`wasm-opt -strip-debug`, `strip`) on a build variant meant for
   debugging.
2. **Install the "C/C++ DevTools Support (DWARF)" Chrome extension.** This
   is what actually reads those sections and maps wasm offsets back to
   your `.c` line numbers, breakpoints, and locals.
3. **Serve the `.wasm` and your original `.c` sources from a stable local
   path** so DevTools' Sources panel can fetch what it needs; this repo's
   own dev server (`server.ts`) already satisfies this by construction.
4. **Treat this as best-effort, not load-bearing.** Multiple open issues
   against Emscripten's own DWARF pipeline describe the extension breaking
   across Chrome releases. The push overlay, guest logging, and
   pause/step should stay trustworthy independent of whether DWARF
   debugging works on any given Chrome version.

## Headless mode, framebuffer hashing, golden-image diffs

`emu_fb()` already returns the framebuffer as a wasm memory offset, so a
headless runner (`harness/emulatorSide.ts`, which loads and replays a wasm
module with no browser at all, or `scripts/verify.ts`'s
`puppeteer-core`-driven check) can drive a replay trace, hash or compare
the resulting framebuffer, and fail a run the moment a change silently
alters what a firmware renders for a fixed input sequence. `harness/diff.ts`
does exactly this against real hardware rather than a checked-in golden
image; nothing stops you from also keeping golden images for the emulator
side alone as a faster, hardware-independent CI gate, if your project wants
one.

## Hot reload that preserves app state, honestly

The tempting version of this feature serializes the wasm module's live
memory, rebuilds, and pokes the old state back into the new module. Game
developers who have actually shipped hot-reloadable native code warn
against exactly this: when a struct's layout changes between reloads, the
new code reads old memory with the wrong shape, and the result is silent
corruption or a crash with no useful signal.

This repo's live reload (`server.ts`'s wasm-file watcher, `src/main.ts`'s
`reloadModule`) does the honest, cheaper thing instead: a rebuild plus
`emu_init()` re-derives state through the same code path a real boot
would take, with no memory-layout assumptions and no silent corruption
mode. The cost is losing in-session state across a reload (mitigated for
apps specifically: the currently-selected app index is preserved, since
that's just "which app," not "where it was" - see `main.ts`'s `bringUp`);
the trade is worth it for a tool whose whole job is trustworthy behaviour,
not the illusion of continuity.

## A peripheral access log, and making push windows visible

The push-window overlay (row 1 above) is not a generic feature request; it
is a direct response to the single highest-value bug class this kind of
emulator can surface: your own push/redraw path's window geometry, made
visible instead of invisible. The general form of this (Renode's
peripheral access log, which records address, register name, and value
for every access) does not have a direct analogue here, because the ABI
deliberately abstracts away registers; the closest equivalent this repo
has is the same `(nowMs, event)` log described above, filtered to the
calls that cross the ABI boundary.

## What this emulator does not model, and must say so

Stated once, plainly, because everything above depends on nobody
forgetting it: **timing is not modeled.** The browser's clock drives the
tick; nothing here reproduces bus latency, panel push cost, or a second
core. This is not a gap to be closed later, it is a category this tool
does not claim, and
[`docs/decisions/0003-differential-testing-not-cycle-accurate-emulation.md`](decisions/0003-differential-testing-not-cycle-accurate-emulation.md)
records exactly why chasing it was rejected. An emulator and the real
device are different failure modes, not degrees of the same one; a fast,
faithful functional tool is not a substitute for the one question only
real hardware can answer.

## What a good emulator refuses to do

- **It never implies timing fidelity it does not have.** No frame-rate
  counter, no "cycles per tick," no UI element that looks like a
  performance measurement, because every one would be read as a claim
  about the real device this tool cannot back.
- **It never silently diverges from the real target.** A reimplementation
  of your firmware's logic in TypeScript would agree with your C exactly
  once, at the moment the second copy is written, and drift from then on
  with no test that can notice - the entire reason this tool compiles
  your real C instead (see
  [`docs/decisions/0002-two-compilers-not-one.md`](decisions/0002-two-compilers-not-one.md)).
  The same discipline applies to every feature in this document: an
  injected fault must be visibly labelled when active, and nothing here
  should ever produce output that looks identical to the real device's
  when it is not.
