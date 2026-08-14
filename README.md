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

A stopwatch, a sketchpad and a countdown timer, chosen from a menu of three
pictures. Hold BOOT and PWR together to open it.

What each one does, how it is played and why it behaves the way it does:
**[`device/firmware/apps/README.md`](device/firmware/apps/README.md)**, next to
the source, one file per app.

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
your source to `wasm/dist/emu.wasm` and implement the ABI it needs
(`wasm/emu_abi.h`, or the readable version at `docs/abi.md`). Copy
`example/build.ts` for freestanding C. C++20 firmware can instead use a
`wasm32-wasip1` reactor with libc++; `test/wasi/build.ts` is the executable
reference and documents its toolchain dependencies. Live reload picks up a
rebuilt module automatically, no manual browser refresh.

## MCU and board support

Puck does not emulate an instruction set or run a shipped microcontroller
binary. It hosts portable application and runtime source through a separate
wasm build that implements the ABI. MCU startup, GPIO, DMA, RTOS integration,
panel-controller drivers, and touch-controller drivers stay in the firmware
project. The wasm adapter replaces or isolates those dependencies and exposes
shared behavior as a framebuffer, push windows, and logical inputs.

Board revisions that use different physical controllers usually share one
Puck device description when their logical panel and inputs are the same. Keep
revision detection and driver selection in the firmware project. Use separate
wasm builds or descriptors only when a revision changes behavior visible at
the ABI. The smallest reference build is freestanding C. For C++20 firmware,
Puck also loads WASI Preview 1 reactors backed by libc++; install a matching
Clang, `wasi-libc`, and libc++ runtime (on macOS with Homebrew: `brew install
llvm wasi-libc wasi-runtimes`). This route supplies containers and allocation
while Puck deliberately implements only the runtime's terminal stdout/stderr
file calls, not clocks, randomness, networking, environment, or a filesystem.
C++ ABI implementations must use C linkage so their exported names match
`wasm/emu_abi.h` exactly.

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
bun run harness:hardware                     # the real thing, against the puck on USB
bun run harness/diff.ts trace.json --link ./myBoardLink.ts
```

Your hardware side is a small interface (`harness/types.ts`'s
`HardwareLink`: connect, disconnect, send an event, take a screenshot) you
implement against whatever transport you actually have. Nothing in
`harness/` is hardwired to one device; `harness/links/devlinkLink.ts` is
this repo's own implementation of it, over the USB-serial link in
`device/`.

**It has been run against the real board, and the results are in the
docs.** The idle stopwatch screen matches pixel for pixel with zero
tolerance. A drawn stroke does not: the same trace, replayed three times,
lost half the stroke once, broke it into three pieces once, and got the
edges wrong the third time. The full account, the screenshot pacing that
was measured rather than guessed, and an honest list of what this catches
and what it cannot (it does not eliminate the two-compilers problem above,
it cannot see colour, it cannot prove any real button or fingertip reaches
the firmware, and it will not catch timing or CPU-level bugs) is in
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
example/        a tiny, real, working freestanding-C firmware (see below)
                and its build script.
test/wasi/      a C++20/libc++ reactor fixture and loader regression test.
harness/        the differential test harness. links/ holds the real
                HardwareLink for the puck (over device/'s USB devlink),
                inputs/ the traces it replays, fixtures/ the no-hardware
                fake the self-test uses.
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

TypeScript only for the emulator implementation; C/C++ is limited to the ABI
header and firmware fixtures (yours, the example, or the C++ reactor test). A
build toolchain like `zig` or Clang is invoked as a binary, never authored as
a language here. See
[`AGENTS.md`](AGENTS.md) for the full set of conventions and the gotchas
that bite.
