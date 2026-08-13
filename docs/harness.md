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
(see `harness/types.ts`). You do not have real hardware handy right now,
so start with the harness's own self-test instead:

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

## A worked reference: the project this repo was extracted from

This repo did not invent its own hardware transport; it was extracted from
a project that already had one. That project's own link
(`tools/dev.ts`/`firmware/devlink.c` in that repo, documented in
`tools/README-devlink.md` there) is a small line-based command protocol
over the same USB-serial port a board's runtime already prints debug
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
decodes the RLE+base64 reply, and returns the decoded pixels as RGB (a
greyscale panel converts trivially: `r = g = b = grey`).

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
