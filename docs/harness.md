# The differential test harness

This answers the question a working emulator raises immediately: how do
you know the emulator actually follows your firmware, rather than quietly
drifting from it? The pattern is [Ragger's](https://github.com/LedgerHQ/ragger)
- Ledger's pytest framework for their hardware wallet apps, which runs
the same navigation script against their Speculos emulator and two real
hardware transports, diffing a screenshot at each step against a checked-in
golden image. Adapted here to a general ABI instead of one company's SDK:

1. **record an input trace once** - the live page's "save" button writes
   the same `Trace` shape `src/recorder.ts` produces, or build one by hand
   (see `harness/selftest.ts` for a worked minimal example)
2. **replay it through the emulator**, capturing the framebuffer at
   defined points (`harness/emulatorSide.ts`)
3. **replay the SAME trace against real hardware**, over YOUR OWN
   transport, capturing its screen at the same points
   (`harness/hardwareSide.ts`)
4. **diff them**, and report where and when they diverge
   (`harness/diff.ts`, `harness/compare.ts`)

## Run it

```
bun run harness/diff.ts <trace.json> --link <path-to-your-link.ts> [options]
```

Full option list is documented at the top of `harness/diff.ts`. The
`--link` module must export a factory function returning a `HardwareLink`
(see `harness/types.ts`).

**This repo now ships a real one.** `harness/links/devlinkLink.ts` drives
the RP2350 board `device/` is the firmware for, over devlink
(`device/tools/README-devlink.md`), and `bun run harness:hardware` is a
complete run against it:

```
bun run device:build          # the board's firmware, compiled to wasm
bun run harness:hardware      # replay one trace both ways and diff
```

It needs a board. With none attached it fails in about a second with a
message naming the port it tried and why it gave up, and exits `2` (the
comparison never happened), never `1` (the comparison ran and diverged).
See "Against the real board" below for what it actually found.

With no hardware, start with the harness's own self-test instead:

```
bun run harness:selftest
```

This proves the harness MECHANISM works (pacing, capture points, pixel
comparison, PNG output) using a fake link
(`harness/fixtures/loopbackLink.ts`) that is just a second instance of the
same wasm module. **Read that file's header comment. It is not a
substitute for real hardware and must never be read as evidence about
one** - a clean self-test proves this repo's own code isn't broken, nothing
more.

## The pluggable side: `HardwareLink`

```ts
export interface HardwareLink {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  reset?(): Promise<void>;
  send(event: TraceEvent): Promise<void>;
  screenshot(): Promise<CapturedFrame>;
}
```

This is deliberately the entire surface. Nothing in `harness/` knows or
cares whether your transport is a USB-serial link, a debug probe, a raw
SPI tap, or a camera pointed at the panel with autocrop. Implement these
five methods against whatever you have, and the rest of the harness (trace
replay, pacing, comparison, reporting) works unchanged.

`send()` gets called once per non-tick trace event (`touch`, `button`,
`verdict`, `sensor`), in order, paced in real wall-clock time at the same
relative spacing the trace was originally recorded at - see
`harness/hardwareSide.ts`'s header comment for exactly why "tick" events
are never sent (there is no ABI equivalent of a synthetic clock tick on
real hardware; it runs on its own).

`screenshot()` must return `{ width, height, rgb }` with `rgb` as plain
RGB, 3 bytes per pixel, row-major, top-left origin - already decoded from
whatever your transport's wire format is. The harness makes no assumption
about that wire format; decoding it is entirely your adapter's job.

Before capturing, `screenshot()` must ensure the board has observed every
preceding `send()` event. A transport write completing does not prove a queued
input has reached the firmware loop. Use an acknowledgement, flush command, or
another device-specific barrier so a capture cannot race the input it is meant
to show.

## Against the real board

Everything below this line was measured, on 2026-08-14, against the
RP2350-Touch-AMOLED-1.8 on `COM4`, through
`harness/links/devlinkLink.ts`. Until that day this document described a
`HardwareLink` nobody had written and a comparison nobody had run; the
paragraphs that said so have been replaced by what happened.

### What was run

| Trace | Capture points | Result |
| --- | --- | --- |
| `harness/inputs/chrono-idle.trace.json` (64 events, ticks only) | 1, at t=1008 | **MATCH**, byte-identical at tolerance 0, repeatedly |
| `harness/inputs/draw-stroke.trace.json` (193 events: the menu chord, a tap on the "draw" icon, an 11-sample stroke) | 2, at t=1600 and t=2800 | **DIVERGE** at the stroke, every time, by a different amount every time |
| `harness/inputs/menu-chord.trace.json` (160 events: the chord alone) | 1, at t=2000 | **never compared**: the board physically cannot send that screenshot, see "the payload ceiling" |

**The idle screen matches exactly.** The stopwatch at `00:00:00`, freshly
entered, is the same 164,864 pixels on both sides, with zero tolerance.
That is a real result and a bigger one than it looks: it means the wasm
build and the ARM build agree pixel for pixel on `digits.c`'s seven-bar
numerals, `gfx.c`'s rotation and the whole RGB565 pipeline, and it means
this harness's own pixel path (the emulator's framebuffer reader, devlink's
RLE stream, the greyscale reconstruction in `devlinkLink.ts`) is exact
rather than approximately right.

**The stroke does not match, and does not fail the same way twice.** Three
runs of the identical trace, on the same board, minutes apart:

1. the board drew the stroke as **three disconnected fragments**, plus one
   mark in a corner no trace event asked for (2,300 px, 1.40%)
2. the board drew **only the second half** of the stroke, starting at
   sample 5 of 11, ending exactly where the emulator's did (928 px, 0.56%)
3. the board drew **the whole stroke**, and what was left was the
   anti-aliased edge along one side of it and the end cap (670 px, 0.41%)

The emulator drew the same clean line all three times. So the best case is
still a divergence: two builds of one `sketch.c`, fed one trace, agree on
where a stroke goes and disagree on its coverage. The worst case loses half
the stroke.

**This is decision 0008 arriving on schedule**
([`device/docs/decisions/0008-the-emulator-seam-is-in-the-wrong-place.md`](../device/docs/decisions/0008-the-emulator-seam-is-in-the-wrong-place.md)).
Both sides run the same `sketch.c` - it is above the seam - so identical
input has to produce identical pixels, and these pixels differ. Therefore
the input differed. `emu_shim.c` pushes an `emu_touch()` straight into a
queue drained once per 16ms tick; the board's injected sample goes into a
core0 ring merged by timestamp into the real stream and drained by a loop
running about 217,000 times a second, so one injected report is re-observed
at the same coordinates thousands of times before the next one arrives -
which is the shape of the real controller's behaviour decision 0008
measured ("about sixty repeated reports per new position"), reproduced here
by accident. `sketch.c`'s stroke-start confirmation and dropout tolerances
read that cadence, and the two cadences are not the same cadence.

The instability across runs is the other half of the finding and the more
uncomfortable one: **a single clean run of this harness against this app
would have meant nothing.** Run 3 alone looks like a rounding difference.

### The screenshot pacing, measured

A screenshot is the expensive thing here and it is the one that has
rebooted this board before, so `harness/hardwarePacing.ts` measures it
rather than assuming:

```
bun run harness:hardware:pacing          # ladder of gaps: 1000, 500, 250, 100, 0 ms
bun run harness:hardware:pacing 0 250    # explicit gaps
```

Six shots at each gap, on two different screens (60 shots), watching for a
truncated payload and for the board changing app underneath the run:

| screen | RLE payload | shot cost, median | worst | truncated | reboots |
| --- | --- | --- | --- | --- | --- |
| chrono, idle | 2,162 B | 281-295 ms | 530 ms | 0/30 | 0 |
| timer | 3,854 B | 482-535 ms | 596 ms | 0/30 | 0 |

**Nothing failed, at any gap, down to zero.** Back-to-back screenshots with
no pause at all did not truncate, did not change the app, and left the
profiler's `shot drops` counter at 0. That is not what the folklore around
this board said, and the reason is in the firmware: `devlink.c` caps one
reply at `DEVLINK_SHOT_BUDGET_US` (750 ms) and closes it with `END`
regardless, so a shot can no longer hold the main loop long enough to
starve the 4 s watchdog. The reboots that motivated that cap happened
before it existed. `DEFAULT_SHOT_MIN_MS` still ships at 250 ms, as margin
on somebody else's board, not because zero was observed to fail.

The cost fits `20 ms + 0.12 ms per RLE byte`, which is 11.2 KB/s of base64
- the byte rate of 115200 8N1, to two digits. Screenshot cost is serial
transmit time and nothing else.

### The payload ceiling, which is the real limit

The 750 ms budget converts directly into **a screen complexity limit of
about 6.3 KB of RLE**, and past it the screenshot is not slow, it is
impossible. The menu trace found it immediately:

```
SHOT truncated: header promised 7784 RLE bytes, 6327 arrived
```

The app menu does not compress small enough to leave the board inside its
own budget, so **this harness cannot compare the menu screen at all** at
115200. The link reports that as a truncation naming the budget, not as a
corrupt image and not as a divergence, and the run exits `2`. Whether a
higher `DEVLINK_BAUD` moves the ceiling was not tested: the emulator dev
server owned the port at 115200 throughout, and evicting it to find out was
not worth the risk to a board somebody else was using.

Practical consequence: point this harness at screens that are mostly one
colour. That is most of this device's apps, and it is not a coincidence -
the same run-length structure that makes a screenshot cheap is what makes
the panel pushes cheap.

### How a reset is detected

A board that reboots mid-run comes back in app 0 with a zeroed arena, and
diffing frames across that is exactly the instrument that lies
([`device/docs/decisions/0004`](../device/docs/decisions/0004-the-day-the-instruments-lied.md)).
Two readings, both over devlink, both free:

1. **Which app is running.** Every capture is followed by `APP`. `reset()`
   deliberately parks the board in a known app first, so "not that app any
   more" is a signal rather than a shrug. This is the strong one, and it is
   why the shipped smoke-test trace does not switch apps.
2. **The profiler's cumulative counters going backwards.** This firmware's
   `prof` line has no absolute uptime field (`loops=` and `core1=` are
   per-second rates), but `core1restarts=` and `shot drops=` count from
   boot, so either one decreasing is a reboot. The link reads them off the
   shared port for free, on its way past the noise to every reply, and a
   `shot drops` that goes UP is reported too - that is the board telling
   you it truncated something.

A trace that drives its own app switch has to relax the first one
(`PUCK_HW_APP_TRACKING=follow`), which genuinely weakens reset detection to
the counters alone. What backs it up there is the comparison itself: a
board that reset would be showing app 0 while the emulator side shows
whatever the trace navigated to, and that is not a subtle diff.

### Two things this run found that were not the firmware

**The board and the emulator were not built from the same source, and the
harness could not have told you.** The board answers `SWITCH 3` with `OK`
and reports `APP 3 four`; `device/firmware`'s `g_apps[]` has three entries.
Nothing in devlink carries a build identity - `PING` returns a protocol
version and the panel size - so a differential run cannot verify that the
two sides are the same program, which is a strictly larger hole than the
two-compilers problem below. It surfaced only because the menu's touch
columns are `LAND_W / g_appCount` wide, so one tap coordinate selected
`draw` on a three-app build and `timer` on the four-app one, and the run
diverged by 28% of the panel. If you get a divergence that large, check
this first.

**`harness/diff.ts` was writing zero-byte PNGs.** `writePng` did not await
`Bun.write`, and `main()` ends in `process.exit()`, so all three images the
tool announced on a divergence lost the race - at exactly the moment the
images are the only thing that can say which side is wrong. Fixed here,
found by the first real divergence.

## A worked reference: how the shipped link maps onto devlink

This repo's `HardwareLink` implementation is
`harness/links/devlinkLink.ts`, over the protocol
`device/tools/README-devlink.md` documents: a small line-based command
protocol over the same USB-serial port the runtime already prints debug
output to:

- `PING` - liveness and protocol version
- `SHOT` - a screenshot: the framebuffer, walked once to count runs and
  once to stream them, RLE-encoded then base64, because a full raw
  framebuffer dump would be too slow over a serial link and a mostly-flat
  panel compresses to almost nothing
- `DOWN <x> <y>` / `MOVE <x> <y>` / `UP` / `TAP <x> <y>` - touch injection
- `KEY <name>` / `BOOT <name>` - button injection, named forms only (not a
  raw bitmask), so a typo fails to parse instead of silently injecting the
  wrong gesture
- `APP` / `SWITCH <index>` - read and change which app is running, for a
  firmware with the optional `apps` concept

A `HardwareLink` adapter over a protocol like this is almost entirely
mechanical: `send()` maps a `TraceEvent` to the matching command line(s)
(`touch` down → `DOWN x y`, `button` → `KEY`/`BOOT`, `sensor` → whatever
your device injects for that sensor id), and `screenshot()` sends `SHOT`,
decodes the RLE+base64 reply, and returns the decoded pixels as RGB.

**One line of that is a trap, and it cost the first exact match here.** A
greyscale panel does NOT convert to RGB as `r = g = b = grey`. This board
stores RGB565 and `SHOT` sends `px_to_gray()`, the 6-bit green channel
shifted up by two, while the emulator side reads the same framebuffer word
and expands each field with bit replication (`src/panel.ts`). Expanding the
byte naively gives 252 where the emulator gives 255 for white, so every
pixel of a perfectly correct frame is off by three and no run ever matches
at tolerance 0. Reversing the panel's own packing instead - green is
`byte >> 2`, red and blue are `byte >> 3` for a neutral pixel - reconstructs
the emulator's exact triple, which is why the idle screen above matches with
zero tolerance rather than needing a fudge factor. Do the algebra for your
own panel; do not reach for `--tolerance`.

**The one thing worth calling out explicitly, because it is not obvious
from the protocol alone**: button/key injection like this proves your
runtime and app logic handle an input correctly. It does NOT prove the
real chip that produces that input (a PMIC's register read, a flash
chip-select borrow, whatever your board's own button path involves)
actually works, because injection skips that chip entirely and hands your
firmware the bits as if the real transaction had already happened cleanly.
This is the same shape of caveat `wasm/emu_abi.h` documents for the
emulator side ("the emulator must never deliver an input the hardware
cannot produce") but the other direction: injection through a real link
drives REAL firmware on REAL hardware, with no simulated chip to blame, so
the gap it leaves is a gap in what the TEST proves, not a dishonesty in a
stand-in board. Keep this in mind when a differential run comes back clean
- see the next section.

## What this catches, and what it cannot

**Catches**: behavioural divergence between your emulator build and your
real build, at the framebuffer, for a given input sequence, at whatever
capture points you chose. If your wasm build draws a different pixel than
your board does for the exact same trace, this finds it and shows you
both images plus a diff heatmap.

**Does not check that the two sides are the same program.** Nothing in
devlink carries a build identity, so the harness will happily diff a wasm
module built from your working tree against whatever firmware happens to be
flashed. That happened on the first real run here (three apps against four)
and it produced a 28%-of-the-panel divergence that looked like a rendering
bug. Before believing any large divergence, confirm the board is running
the commit you built. This is a bigger hole than the two-compilers problem
below, and unlike that one it is entirely avoidable by reflashing.

**Does not see colour.** `SHOT`'s wire format is one greyscale byte per
pixel, because this panel is used as monochrome. The sketchpad's palette,
`sketch.c`'s `tint_to_px`, and `runtime.c`'s red core1-dead screen all
arrive as a green channel and come back out as grey. A coloured screen
diffed this way reports a divergence that is in the WIRE FORMAT, not in the
firmware. Do not point this at a coloured screen and believe the number.

**Does not prove the input path.** Every input this link delivers is
injected downstream of the silicon that produces it: `KEY` skips the
AXP2101's register read and its write-1-to-clear, `BOOT` skips the flash
chip-select borrow, and `DOWN`/`MOVE`/`UP` skip the FT3168 entirely. See
`device/tools/README-devlink.md`'s "What injection cannot test" and
[`device/docs/decisions/0004`](../device/docs/decisions/0004-the-day-the-instruments-lied.md),
where a whole day was lost to a rig that injected downstream of the layer
that had failed: every hardware verification run passed while the device
was unusable by hand. **A green run of this harness is not evidence that a
real finger or a real thumb reaches the firmware.** Concretely, on this
device it cannot see: the touch threshold register `FT3168_Init()` never
writes, the PMIC's read-and-clear timing, the BOOT pad's chip-select
borrow, or anything core1 does - and the first of those is half of the
worst bug this project has shipped.

**Does not eliminate the two-compilers problem.** See
[`docs/decisions/0002-two-compilers-not-one.md`](decisions/0002-two-compilers-not-one.md):
the wasm module and your real firmware are the same C, compiled by two
different compilers, to two different targets. A clean differential run is
strong evidence your application logic hasn't drifted between the two
builds; it is not proof the two compilers agree on every code-generation
detail, integer-width edge case, or float-precision corner your firmware
might be sensitive to. Most application logic doesn't care. Some does.

**Does not catch timing or CPU-level bugs**, ever, by construction. The
emulator's clock is whatever the host hands `emu_tick()`; nothing about
this harness makes that timing real, and a divergence caused purely by
real-world timing (a race, an interrupt landing at the wrong moment, a bus
contention issue) has no reason to show up in a framebuffer diff even
though it is a completely real bug on the actual board.

**The known bound, stated plainly rather than left as an abstract
caveat**: the hardest bug in the history of the project this repo was
extracted from was a flash chip-select borrow on one CPU core racing the
second core's own instruction fetch - a timing race at the memory
controller, between two cores, with no software-visible signal at the
point of failure (see that project's own decision record, referenced in
[`docs/decisions/0002-two-compilers-not-one.md`](decisions/0002-two-compilers-not-one.md)).
**This differential harness would not have caught it. Neither would any
emulator surveyed while researching this project's own architecture**
(see that same decision record for what was actually surveyed). Catching
that class of bug needs a cycle-accurate model of the real chip's own bus
arbitration, at a fidelity nothing reviewed for this project claims to
have, for any two-core microcontroller. The fix for that bug was a hazard
analysis and a documentation discipline (a decision record durable enough
to survive a refactor), not more testing infrastructure - and no amount of
investment in this harness changes that. A tool that oversells what it
catches costs more than one that plainly says what it doesn't.

## Exit codes

`harness/diff.ts` exits with one of three distinct codes, because CI reads
the exit code, not the console text: `0` means the comparison ran and every
frame matched, `1` means the comparison ran and at least one frame
diverged, and `2` means the comparison never happened at all (bad
arguments, a malformed or out-of-order trace, an uncaught exception from
either replay side, a `HardwareLink` that failed to connect). A `2` is
never a failed comparison and must not be read as one; it means the tool
itself couldn't finish.

Trace timestamps (`TraceEvent.t`) must be non-decreasing across the whole
`events` array (ties are fine - a touch and the tick it's latched by
commonly share one `t`). This matters most for a hand-built trace (see
`harness/selftest.ts` for a worked example): both replay sides pace and
choose capture points off this ordering, and an out-of-order trace used to
produce a silently wrong or skipped capture point rather than an error.
`harness/diff.ts` now checks this up front and exits `2` with the exact
index and timestamps involved if it finds a violation.

## A regression check with no hardware

Everything above needs a `HardwareLink`. Most people, most of the time -
and the entire early life of any device that doesn't have a board yet -
don't have one, and the question they actually keep asking isn't "does the
emulator match my hardware", it's "did I just break something that used to
work". `src/regression.ts` answers that, from inside the page, using
nothing this repo didn't already build for the section above:

1. **baseline**: replays your current input trace against a fresh instance
   of the current module (`src/replayCore.ts`'s `replayFromBytes`, the same
   function `replayEmulator` above is now a thin wrapper around) and saves
   the trace plus a frame at each of a handful of capture points
   (`src/regression.ts`'s `pickCapturePoints`), persisted to
   `baselines/latest/` (see `server.ts` / `baselineStore.ts`) so it survives
   a live reload - the page reloading is exactly the moment this question
   gets asked, and an in-memory baseline would already be gone.
2. **check**: replays the SAME saved trace against the CURRENT module
   (which may be a fresh rebuild) and diffs the result against the saved
   frames with this same file's `compareFrames` (moved to `src/compare.ts`
   specifically so the page can call it with no dependency on anything
   under `harness/`).

In the page: two buttons ("baseline", "check") and, on a failure, a small
modal showing the baseline frame, the current frame and a diff heatmap for
every capture point that diverged - the same visual a `--out` divergence
from `harness/diff.ts` writes to disk, just shown in place. A failed check
is also written to `regressions/latest/` in the same shape a freeze bundle
uses, so an agent can pick it up - see
[`docs/agent-loop.md`](agent-loop.md#a-failed-regression-check-for-an-agent).

**Read this bound before trusting a clean check more than it has earned:
this compares the emulator against ITSELF, at two points in time.** There
is no hardware anywhere in this path, not even the loopback fake above. A
clean check is evidence the emulator draws the same thing for the same
input as when the baseline was saved - nothing more. It catches a firmware
regression in your application logic. It says nothing about whether the
emulator still agrees with real hardware (that's what the rest of this
document is for), and nothing about timing, for exactly the same reason
stated in "What this catches, and what it cannot" below: the emulator's
clock is whatever the host hands `emu_tick()`, on both sides of this
comparison, always.

## Capture points

The harness never captures every tick - that would be far too slow for
most real hardware transports (a single screenshot over a slow serial link
can easily cost hundreds of milliseconds). You choose when to look:

- `--at 500,1200,4000` - explicit trace-relative millisecond timestamps
- `--every 1000` - a fixed interval across the trace's span
- neither - captures once, at the trace's final tick (the default: "does
  the end state match")

Pick capture points around whatever you're actually trying to verify: the
moment right after a gesture completes, a few points across an animation,
or just the final frame for a quick regression check.
