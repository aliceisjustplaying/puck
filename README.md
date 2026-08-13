# puck

A local emulator for small screen-and-buttons devices. Your firmware's C
compiles to WebAssembly; this gives it a panel, buttons, touch and a clock
in a browser page, served by a local dev server with live reload.

(Working name. Trivially renamed later; nothing about how it works depends
on the name.)

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
server.ts       the local dev server. Binds 127.0.0.1 explicitly.
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
- **Push-window overlay**: every rectangle your firmware's push path
  actually sent gets drawn as a fading outline. A partial-refresh bug is a
  bug about window geometry, and it is invisible until this exists.
- **Touch-contact overlay**: shows the actual fingertip-sized contact disc
  against your layout, not a one-pixel mouse click, plus a fading trail.
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
- **Console pane**: your firmware's own `js_log`/printf-equivalent output.

## Conventions

TypeScript only for everything this repo owns; C only for the ABI header
and firmware (yours, or the example); a build toolchain like `zig` is
invoked as a binary, never authored as a language here. See
[`AGENTS.md`](AGENTS.md) for the full set of conventions and the gotchas
that bite.
