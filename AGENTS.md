# AGENTS.md

## What this is

`puck` is a local development tool for people writing firmware for small
screen-and-buttons devices. The firmware compiles to WebAssembly; this
repo gives it a panel, input devices and a clock, in a browser page served
by a local CLI, so the app logic can be iterated on and debugged without a
flash cycle.

**It runs the firmware's own C, compiled again.** Same source, a different
compiler, a different target than what ships. NOT the same object code as
the shipped binary - see `docs/decisions/0002-two-compilers-not-one.md`
before assuming more than that. This distinction is load-bearing; do not
describe this tool as running "the exact binary" anywhere.

**The repository has two halves.** The root is that emulator, and it names
no device. `device/` is one real firmware: the puck itself, a stopwatch, a
sketchpad and a countdown timer for the Waveshare RP2350-Touch-AMOLED-1.8.
`device/` has its own `AGENTS.md`, and it is the first thing to read before
touching any C, any CMake, or anything about that board. The two are wired
together by exactly one artefact: `device/wasm/build.ts` writes this repo's
`wasm/dist/emu.wasm`.

## How to run it

```
bun install
bun run example:build   # compiles example/firmware/main.c -> wasm/dist/emu.wasm
bun run dev             # http://127.0.0.1:5340
```

`bun run device:build` swaps the example for the puck's real firmware,
writing the same `wasm/dist/emu.wasm`. It needs `zig`, and its wasm link
segfaults on roughly one run in three; that is a known zig bug, not your
change, so run it again. `bun run device:screens` regenerates
`device/README.md`'s screenshots from that module.

To point it at your own firmware instead: write a `build.ts` that compiles
your C to `wasm/dist/emu.wasm` (copy `example/build.ts`'s shape, see
`docs/abi.md`'s "Building your firmware to wasm"), run it, then `bun run
dev`. Live reload picks up a rebuilt module automatically.

`bun run typecheck` must pass before any change is considered done.
`bun run verify` drives the page headlessly with `puppeteer-core` against a
local Chrome install (no bundled download - set `CHROME_PATH` if it can't
find yours) and, if `wasm/dist/emu.wasm` exists, drives a real synthetic
touch stroke and confirms the panel actually changed.

`bun run harness:selftest` proves the differential test harness's own
mechanism works, with no real hardware required (see `harness/fixtures/loopbackLink.ts`'s
header comment for exactly what that does and does not prove).

`bun run test:regression` proves the in-page, hardware-free regression
check (`src/regression.ts`, the "baseline"/"check" buttons - see
`docs/harness.md`) actually catches a firmware regression: it builds two
tiny fixture firmwares that differ by one draw call, and confirms a check
fails and names the exact capture point that changed.

## Conventions

- **TypeScript only, for everything this repo owns.** The page, the wasm
  loader, the server, the build scripts, the tests, the harness, the CLI:
  every one of them is `.ts`. No `.js`, no `.mjs`, no shell scripts, no
  Python. If a runner can't execute TypeScript directly, it goes through
  `bun`, never a JS fallback. This is a hard rule, including for anything
  that looks like "just a build script" or "not really code."
- **Zig (or whatever C-to-wasm32-freestanding toolchain you use) is a
  binary this repo's build scripts invoke, exactly like `git` or `cmake`.
  It is never a language anything in this repo is authored in.**
- **C belongs to firmware, not to this repo's own tooling.** The only C
  this repo carries is `wasm/emu_abi.h` (the ABI contract) and
  `example/firmware/main.c` (a worked example of someone else's firmware,
  demonstrating the contract - not this repo's own code in the sense the
  rule above means). Anything under `example/` is written the way a
  firmware author would write it, not the way this repo's tooling is
  written.
- **Nothing names one device.** No hardcoded panel size, no hardcoded
  button name, anywhere in `src/`, `server.ts`, or `harness/`. A device
  declares its own shape through `emu_device()` (see `docs/abi.md`), and
  everything else is built from that JSON at runtime. If you're about to
  write `368` or `"PWR"` as a literal anywhere outside `example/` or
  `device/`, stop - that number or name belongs in a firmware's own
  `emu_device()`, not here. `device/` is allowed to name its own board
  because it IS one board's firmware; that is the whole point of the
  boundary, and it is why the emulator half must never import from it.
- **No em dashes**, anywhere, including code comments and docs. Use
  commas, colons, parentheses, or periods.
- **No ASCII art, no badges** in any markdown file.
- **`docs/decisions/`** carries the WHY. This file (AGENTS.md) says HOW.
  The README says WHAT. Keep new architectural choices in a decision
  record, not buried in a comment nobody will find later.

## Layout

```
src/            the page: wasm loader (wasm.ts), panel blitter (panel.ts),
                push-window overlay (overlay.ts), touch-contact overlay
                (touchoverlay.ts), touch defect simulation (touchsim.ts),
                input recorder/replay (recorder.ts/replay.ts), freeze
                bundle (freeze.ts/journal.ts), the hardware-free regression
                check (regression.ts, built on replayCore.ts and
                compare.ts - see docs/harness.md), console pane
                (consolelog.ts), puck chrome (device.ts), audio bridge
                (audio.ts), and main.ts which wires all of it together.
                Deliberately device-agnostic: nothing here should ever
                reference a specific device's panel size or button names.
                replayCore.ts, compare.ts and frame.ts also get imported
                from harness/ (never the other direction: harness/ depends
                on src/, src/ never depends on harness/), so the page and
                the differential test harness share one replay/compare
                mechanism instead of two that would drift apart.
wasm/           wasm/emu_abi.h: the ABI contract, the one file every
                firmware in this ecosystem depends on. wasm/dist/ is
                build output (gitignored).
example/        a tiny, self-contained example firmware (firmware/main.c)
                and its build script (build.ts). Read
                docs/decisions/0001-example-is-minimal-not-a-shim.md for
                why it's minimal rather than a full-featured demo.
harness/        the differential test harness: replay a trace through the
                emulator (emulatorSide.ts, a thin node:fs wrapper over
                src/replayCore.ts) and through a pluggable HardwareLink
                (hardwareSide.ts, types.ts), diff the results (src/compare.ts,
                diff.ts). fixtures/loopbackLink.ts is a FAKE link for
                testing the harness itself, not real hardware - see
                docs/harness.md.
test/regression/ builds two tiny fixture firmwares (one draw call
                different between them) and proves the hardware-free
                regression check actually catches the difference - see
                docs/harness.md and run.ts's own header comment.
docs/           abi.md (the ABI as a page), requirements.md, agent-loop.md
                (the optional freeze/annotate layer, plus the failed-
                regression-check export), harness.md (also covers the
                hardware-free regression check), and decisions/ (the why).
scripts/        scripts/verify.ts: headless proof the page works and, once
                a wasm module exists, that it actually renders in response
                to real input.
server.ts       the local dev server (127.0.0.1 only, see below). Also
                serves the hardware-free regression check's own routes
                (/api/baseline, /api/regression-result), backed by
                baselineStore.ts.
baselineStore.ts disk persistence for the regression check: where a saved
                baseline lives (baselines/latest/) and where a check's
                result gets exported for an agent (regressions/latest/,
                see docs/agent-loop.md). Kept out of server.ts itself so
                test/regression/run.ts can call it directly with no HTTP
                server and no browser.
build.ts        static dist/ build, for serving this page from something
                other than the dev server.
device/         the OTHER half of this repository: the puck's own firmware,
                for the Waveshare RP2350-Touch-AMOLED-1.8. It has its own
                README.md, AGENTS.md, NOTICE.md and docs/decisions/, and
                it is the one place in this repo that is allowed to name a
                specific board. `bun run device:build` compiles its C to
                wasm/dist/emu.wasm, which is how the page above ends up
                running a real firmware instead of example/. The
                dependency runs one way only: device/ builds into this
                repo's wasm/dist/, and nothing in src/, harness/ or
                server.ts may ever import from device/.
```

## Gotchas that bite

- **`server.ts` binds `127.0.0.1` explicitly.** `Bun.serve({ port })` with
  no `hostname` listens on every interface, which puts a local dev tool on
  the WiFi. Never remove the explicit `hostname`.
- **The dev server's live-reload debounces on file STABILITY, not just a
  filesystem event.** A build tool writes a `.wasm` file over time; an fs
  event fires the instant the OS creates or truncates it, long before the
  bytes are actually written. Broadcasting "reload" at that instant serves
  a half-written module, which looks exactly like a hung page. See
  `server.ts`'s `waitForStableFile`.
- **`wasm.ts`'s `instantiate()` validates before ever touching a module
  that's already running.** Magic bytes, then `WebAssembly.instantiate`,
  then (in `main.ts`) `emu_init()` and the device descriptor. A failure at
  any step must never tear down a session that was already working - see
  `main.ts`'s `bringUp`/`failReload`.
- **The freestanding wasm32 target has no `malloc`, `printf`, or
  `math.h`, but DOES have `stdint.h`/`stdbool.h`/`stddef.h`/`stdarg.h`**
  (the C standard's required freestanding headers). See `docs/abi.md`'s
  "No malloc, no libc" before adding a shim header for something that
  might already be available.
- **`--export-dynamic` is unreliable for `zig cc`'s `wasm32-freestanding`
  target** (verified by actually building, not assumed from docs): it can
  silently fail to export what you expect. Export each ABI symbol
  explicitly with `-Wl,--export=<name>` instead - see `example/build.ts`'s
  header comment.
- **`Bun.deflateSync` produces raw DEFLATE, not a zlib stream.** PNG's
  `IDAT` chunk needs the zlib wrapper (2-byte header, 4-byte Adler-32
  trailer) added by hand around it - see `harness/png.ts`.
- **`harness/hardwareSide.ts` never sends `"tick"` trace events to a
  `HardwareLink`.** Real hardware has no ABI-level concept of a
  host-driven synthetic clock tick; it runs its own loop, on its own
  clock, regardless. Tick events are only used as pacing/capture-point
  anchors. If you're writing a `HardwareLink` and touch state seems to
  vanish before your board ever sees it, check that your board (or your
  fake link, see `harness/fixtures/loopbackLink.ts`'s background-tick
  fix) is actually polling continuously rather than only reacting
  synchronously to `send()` calls.
- **On Windows, killing a spawned dev-server child needs the whole
  process tree, not just `kill()`.** `Bun.serve`'s `development.hmr`
  spawns a watcher that can outlive a plain `SIGTERM`. See
  `scripts/verify.ts`'s `finally` block (`taskkill /t /f`) for the
  pattern; it can make the script's own exit take longer than the actual
  test does, which is expected, not a hang.
