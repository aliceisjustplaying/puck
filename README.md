# puck

A small touchscreen toy, and the tools that made it.

![Playing with the puck: picking the sketchpad from the menu, drawing a
face, opening the colour palette and picking red, drawing again in red,
holding both side buttons to get back to the menu, running the stopwatch,
winding the timer's dial](device/preview/demo.gif)

The puck is a plastic disc the size of a large coin with a 368x448 AMOLED in
it: a stopwatch, a sketchpad and a countdown timer, for a child who cannot
read yet. You pick between them by touching one of three pictures.

That recording is not a mockup and not a screen capture of a design tool. It
is this repository's firmware, compiled to WebAssembly, running in this
repository's emulator, driven by a script that presses one mouse and two
keys ([`device/tools/demo.ts`](device/tools/demo.ts) regenerates it). The
finger and its trail are the emulator's own touch-contact overlay; the two
side buttons are its chrome, filling as a hold approaches its threshold.
Everything else on the panel was drawn by the firmware.

This repository is two halves of the same thing.

| | |
|---|---|
| **[`device/`](device/)** | The firmware. Real C for a real board (the Waveshare RP2350-Touch-AMOLED-1.8, and nothing else). One binary, three apps, a picture menu. |
| the root | An emulator. It compiles that same firmware's own C a second time, to WebAssembly, and runs it in a browser page with a panel, buttons, touch and a clock. |

**Just want it on your board?** Download the `.uf2` from
[Releases](../../releases), hold the upper side button, plug in the USB
cable, and drag the file onto the drive that appears.
[`device/README.md`](device/README.md) has the four steps in full, and what
to do if it ever stops responding.

**Want to try it without buying anything?** `bun install && bun run
device:build && bun run dev` gives you the puck in a browser page. Same
apps, same rasteriser, same app-switching logic, because it is the same C.
The one thing it can never answer is whether the real thing feels fast.

## The three apps

All three live in [`device/firmware/apps/`](device/firmware/apps/), one file
each, and they ship as one binary: switching between them is a function
call, not a reboot. Hold **both side buttons** together for about a second
and a half and the three pictures appear. Touch one. The same chord closes
the menu again and goes back to what was running.

![The menu: a stopwatch, a pencil, an hourglass](device/preview/screen-menu.png)

That chord is the only way in and out, and it is the only navigation the
device has. No app carries a back arrow, a clock, a battery indicator or its
own name anywhere on screen, on purpose:
[decision 0002](device/docs/decisions/0002-runtime-architecture.md) argues
it, and the case gets a physical mark instead. **PWR is the lower side
button, BOOT the upper one.**

| | | |
|---|---|---|
| ![](device/preview/screen-chrono.png) | ![](device/preview/screen-sketch.png) | ![](device/preview/screen-timer.png) |

### The stopwatch, `apps/chrono.c`

Six digits, `MM:SS:CC`, and nothing else on the screen. **PWR starts and
stops it. BOOT resets it to zero**, from any state.

A stop is applied in the same tick the press arrives, before that tick
redraws, because a stopwatch that freezes a frame late is a stopwatch that
reads wrong. It is also the one app deliberately deaf to the shake sensor:
shaking is how the sketchpad erases, and a number a child is carrying across
a room should not be destroyed by a jolt.

### The sketchpad, `apps/sketch.c`

Draw with a finger. The ink varies in width and tapers at both ends like a
real pen, but this panel has no pressure to report (the touch controller
answers zero to its own weight and area registers, always, however hard you
press), so the width comes from how fast the stroke is moving: fast is
light. Overlapping segments composite darkest-wins rather than blending,
which is what keeps a slow stroke from compounding into the hard, pixelated
edge the anti-aliasing exists to avoid.

**Shake the puck to erase.** It wipes in sixteen bands rather than blanking,
and a touch during the wipe stops it part way.

**Hold a finger still** for half a second, without moving more than about
12 pixels, and the whole screen becomes a grid of nine colours. Slide onto
one and lift to pick it; lift in a gap between two and nothing changes.
Black sits in the middle, because that is the device's own ink. The dot that
hold would otherwise have drawn is rolled back, so opening the palette never
marks the page.

![The palette: nine colours over the whole screen, black in the middle](device/preview/palette-open.png)

### The timer, `apps/timer.c`

A dial you wind, not a number you type. Drag a finger around the ring:
**one full turn is fifteen minutes**, and carrying on past twelve o'clock
winds a second, inner band, up to a **thirty minute** maximum. Every part of
the dial is worth the same five seconds per step, everywhere, which matters
for someone who cannot yet read the digits in the middle: an earlier version
had three different step sizes at three different radii, and the same finger
movement meaning different things in different places is what made it
unusable.

**PWR starts it and pauses it. BOOT resets** it to the value you set, and
from a blank dial recalls the last one, so "again" is a single press.

At zero it flashes black and white twice a second and rings: four rising
notes, synthesised sample by sample rather than stored, because a stored
phrase would cost tens of kilobytes of SRAM this device does not have. Any
touch and any button stops it, since a child reaching for a beeping object
should not have to remember which one.

## The emulator

It is not specific to this device. It is built entirely from what a
firmware's `emu_device()` declares at runtime, so it will run yours too;
everything below is about that, and `device/` is the worked example that
proves it carries a real firmware rather than a toy one.

## Run it

```
bun install
bun run example:build
bun run dev
```

Open `http://127.0.0.1:5340`. You should see a small device panel with an
A and a B button. Touch the panel to draw; press A to cycle ink colour or
hold it to clear; press B to toggle a border; hold both together to invert
the colours. That's the example firmware running for real, through the
same ABI your own firmware will use.

Needs [Bun](https://bun.sh) and [zig](https://ziglang.org/download/) (or
another C-to-`wasm32-freestanding` compiler; `example/build.ts` uses `zig
cc` and documents why). Set `ZIG_EXE` if it isn't at `zig` on your `PATH`.

To run the puck's own firmware instead of the example, `bun run
device:build` (which also needs zig) and reload. That is the same command
`device/README.md` gives, and it writes to the same `wasm/dist/emu.wasm`,
so there is no wiring step between the two.

To point this at your own firmware, write a build script that compiles
your C to `wasm/dist/emu.wasm` (copy `example/build.ts`, which is a real,
working reference, not a stub) and implement the ABI it needs
(`wasm/emu_abi.h`, or the readable version at `docs/abi.md`). Live reload
picks up a rebuilt module automatically, no manual browser refresh.

## What this actually guarantees, read before you trust it

**It runs your firmware's own C, compiled again, not a reimplementation.**
Application logic, layout, and redraw decisions cannot silently drift from
your real firmware, because there is one source feeding both builds.

**It does NOT run the same object code your device runs.** Your wasm build
and your real build are the same C, compiled by two different compilers,
to two different targets. A bug that depends on code generation, integer
width, float precision, or undefined-behaviour resolution differing
between the two compilers is out of reach here. See
[`docs/decisions/0002-two-compilers-not-one.md`](docs/decisions/0002-two-compilers-not-one.md)
for exactly why this distinction is real and worth stating plainly rather
than letting a reader assume more.

**Timing is never modeled, anywhere, on purpose.** The browser's clock
drives the tick loop. Nothing here reproduces bus latency, real interrupt
timing, or a second CPU core. Any question of the shape "is this
responsive" or "does this feel laggy" is a question only real hardware can
answer, always. See [`docs/requirements.md`](docs/requirements.md)'s "What
this emulator does not model."

**The emulator must never deliver an input your hardware cannot produce.**
Where the two disagree, the emulator's model changes to match the
hardware, never the reverse - see `wasm/emu_abi.h`'s header comment for the
rule and a worked example of it mattering in both directions.

## The headline feature: a differential test harness

The real question a working emulator raises is "how do I know it follows
my firmware." This repo answers it the way [Ragger](https://github.com/LedgerHQ/ragger)
(Ledger's own testing framework) does: record an input trace once, replay
it through the emulator, replay the SAME trace against real hardware over
your own transport, and diff the resulting frames.

```
bun run harness:selftest                     # proves the mechanism works, no hardware needed
bun run harness/diff.ts trace.json --link ./myBoardLink.ts
```

Your hardware side is a small interface (`harness/types.ts`'s
`HardwareLink`: connect, disconnect, send an event, take a screenshot) you
implement against whatever transport you actually have. Nothing in
`harness/` is hardwired to one device. Full explanation, a worked reference
implementation description, and - importantly - an honest account of what
this catches and what it cannot (it does not eliminate the two-compilers
problem above, and it will not catch timing or CPU-level bugs, stated with
a concrete real-world example) is in
[`docs/harness.md`](docs/harness.md).

## Layout

```
src/            the page itself: wasm loader, panel blitter, push-window
                overlay, touch-contact overlay, input recorder/replay,
                freeze bundle, console pane, puck chrome, audio bridge.
                Device-agnostic: built entirely from whatever emu_device()
                declares at runtime.
wasm/           wasm/emu_abi.h, the ABI contract every firmware in this
                ecosystem implements.
example/        a tiny, real, working example firmware (see below) and
                its build script.
harness/        the differential test harness.
docs/           docs/abi.md (the ABI as a page), docs/requirements.md,
                docs/agent-loop.md (the optional freeze/annotate layer for
                a coding agent working alongside you), docs/harness.md,
                and docs/decisions/ (the why behind the choices above).
scripts/        headless verification (puppeteer-core against a local
                Chrome install).
server.ts       the local dev server. Binds 127.0.0.1 explicitly. Also
                backs the hardware-free regression check's persistence
                (baselineStore.ts).
device/         the puck's own firmware: the C that runs on the board, the
                build that turns it into a .uf2, the build that turns the
                same files into wasm/dist/emu.wasm for the page above, the
                regression tests, the USB link that drives a real board
                headlessly, and the decision records. Read
                device/README.md first.
```

## The example firmware

`example/firmware/main.c` is one small, self-contained file: no `malloc`,
no libc, no dependency on anything outside `wasm/emu_abi.h`. It implements
enough of the ABI to be worth looking at (touch, two buttons with a
long-press verdict and a two-button chord gesture, one sensor event) and
deliberately skips the optional parts (apps, sound) to stay readable in one
sitting. Read it before writing your own; `docs/abi.md` walks through every
function it implements and links back to where.

## Debugging and iteration

- **Pause / step** a frame at a time (bottom bar).
- **Push-window overlay** (the "pushes" switch): every rectangle your
  firmware's push path actually sent gets drawn as a fading outline. A
  partial-refresh bug is a bug about window geometry, and it is invisible
  until this exists.
- **Touch-contact overlay** (the "contact" switch): shows the actual
  fingertip-sized contact disc against your layout, not a one-pixel mouse
  click, plus a fading trail. Its own switch, not the one above: one
  answers "where is the finger", the other "what geometry went out", and
  they share nothing but a canvas.
- **Simulated touch-controller defects** (report rate, dropped contact,
  stray reports), off by default, for exercising the robustness code a
  real touch controller's imperfections force your firmware to carry.
- **Record and replay**: every input call is recorded; save a trace, load
  it back, and it replays bit-for-bit deterministically, because
  `emu_tick(nowMs)` is your firmware's only clock.
- **Freeze**: a screenshot plus everything around it (device descriptor,
  recent pushes, recent input, recent console output), written to a
  predictable path a coding agent can read directly. See
  [`docs/agent-loop.md`](docs/agent-loop.md).
- **Regression check, no hardware required**: "baseline" saves your current
  input trace and the frames it produces; "check" replays that same trace
  against whatever module is loaded now (a fresh rebuild, usually) and
  shows you exactly which capture point, if any, drew something different.
  Survives a live reload (the baseline lives on disk, not in the page). It
  compares the emulator against itself, so it catches a firmware
  regression and proves nothing about real hardware or timing - see
  [`docs/harness.md`](docs/harness.md#a-regression-check-with-no-hardware).
- **Console pane**: your firmware's own `js_log`/printf-equivalent output.

## Conventions

TypeScript only for everything this repo owns; C only for the ABI header
and firmware (yours, or the example); a build toolchain like `zig` is
invoked as a binary, never authored as a language here. See
[`AGENTS.md`](AGENTS.md) for the full set of conventions and the gotchas
that bite.
