# The ABI

This page is the readable version of [`wasm/emu_abi.h`](../wasm/emu_abi.h). The
header is the actual contract (read it, it is heavily commented and this
page does not repeat every word of it); this page exists because "read a
C header" is a worse first experience than a page, and because some of
this is easier to say with an example than with a comment.

The working example is [`example/firmware/main.c`](../example/firmware/main.c).
Every function below links back to where that file implements it.

## The one idea

Your firmware's own C compiles to WebAssembly, unmodified in spirit (same
source, same logic), and this page supplies what your board would have
supplied: a surface to push pixels at, input devices, and a clock. See
[`docs/decisions/0002-two-compilers-not-one.md`](decisions/0002-two-compilers-not-one.md)
for exactly what that guarantees and what it does not: this is the same C,
compiled by a different compiler, to a different target than what ships.
Application logic cannot drift, because there is one source. Compiler-level
identity was never on offer.

## What your firmware exports

Thirteen required exports, plus two optional groups (apps, sound). Every
export name below is exactly what `wasm/emu_abi.h` declares and exactly
what your build script must pass to `-Wl,--export=`.

### `emu_device()` - your device's shape

Returns a byte offset into your module's linear memory, pointing at a
NUL-terminated JSON string. Read once, at startup. This is the entire
reason nothing in this repo hardcodes a panel size or a button: everything
the page builds - the puck's dimensions, its buttons, its sensors, its
touch capability, its optional apps and gestures - comes from this string.

```json
{
  "name": "puck-example",
  "panel": { "w": 240, "h": 240, "format": "rgb565be" },
  "buttons": [
    { "id": "a", "label": "A", "edge": "right", "at": 0.5, "longPressMs": 800 },
    { "id": "b", "label": "B", "edge": "left", "at": 0.5 }
  ],
  "touch": { "points": 1 },
  "sensors": [{ "id": "shake", "kind": "event", "label": "Shake" }],
  "gestures": [
    {
      "id": "chord",
      "label": "chord",
      "how": "Hold A, then also hold B. Holding both together inverts the ink colors.",
      "script": [{ "hold": "a" }, { "hold": "b" }, { "waitMs": 300 }, { "release": "b" }, { "release": "a" }]
    }
  ]
}
```

Field notes, the ones easy to get wrong:

- **`panel.format`** - `"rgb565be"` means the framebuffer holds RGB565 with
  bytes in panel-DMA order, which on a little-endian CPU is the opposite of
  how a `uint16_t` is normally stored. `"rgb565"` (no byte swap) is also
  implemented (`src/panel.ts`'s `PIXEL_READERS`). An unrecognised format
  throws rather than silently misrendering; add a reader in `src/panel.ts`
  if you need a third one.
- **`buttons[].at`** - where the button sits along its edge, `0` at the top
  (left/right edges) or left (top/bottom edges). This is real geometry, not
  decoration: it draws the button where it physically is, because a
  diagram beats a paragraph for "which button is this".
- **`buttons[].longPressMs`** - only declare this if YOUR hardware itself
  decides what counts as a long press (a PMIC that reports a verdict,
  say). If you declare it, the emulator calls `emu_button_verdict()` once
  the threshold is reached and again on release; if you don't, a button is
  just a level switch and your firmware decides click-vs-hold itself,
  exactly like a raw GPIO.
- **`apps`** - optional, an array of app names. Only present if your
  firmware has a concept of switchable apps. Enables a jump-to-app strip
  and `emu_app_current()`/`emu_app_switch()`. Omit it entirely if you have
  no such concept; nothing calls those two functions then.
- **`gestures`** - optional. A compound gesture across more than one input
  (a chord, a hold-then-release sequence) doesn't belong to any single
  button, so it lives here. `how` is prose for a human. `script` (also
  optional) is a small machine-readable sequence the page can actually
  execute through the real button path (see `example/firmware/main.c`'s
  `chord` gesture for a full example); a gesture with no script still
  shows its `how` text, with an honestly-disabled "perform" button instead
  of a guess.

Implementation note: if your device's shape is fixed at compile time (as
`example/firmware/main.c`'s is), a plain `static const char[]` string
literal is all you need - see that file. If it's dynamic (an app list built
from a runtime table, say), build the JSON at init time into a static
buffer instead; there is no dynamic allocation available on this target
(see "No malloc, no libc" below).

### `emu_init()` - bring-up

Returns `1` on success, `0` on failure (log why through `js_log` first).
Called once. See `example/firmware/main.c`'s `emu_init()`: it fills the
framebuffer with a background colour and returns `1`. A real firmware
would run whatever init path the board itself runs.

### `emu_tick(nowMs)` - advance one frame

`nowMs` is the host's clock, and it is the ONLY time source inside your
module. This single decision is what makes everything else in this repo
possible: an input trace becomes a file that reproduces a bug exactly,
every time it's replayed, because replaying the same `(call, nowMs)`
sequence against a freshly booted module produces bit-identical output.
**A firmware that reads its own wall clock, or seeds a PRNG from one, has
broken this and will not be reproducible.** See
`example/firmware/main.c`'s input-latching pattern: every `emu_*` input
call only records state, and `emu_tick()` is the one place that state gets
acted on - never draw directly from inside `emu_touch()`/`emu_button()`.

### `emu_fb()` - the framebuffer

Returns a byte offset to the framebuffer, in the format `emu_device()`
declared. The page reads this directly out of your module's linear memory;
there is no copy step.

### The push log - what the last tick actually drew

```c
int emu_push_count(void);
int emu_push_x(int i);
int emu_push_y(int i);
int emu_push_w(int i);
int emu_push_h(int i);
```

Your firmware's own push/redraw path records every rectangle it sent to
the (real or emulated) panel, cleared at the start of every `emu_tick()`.
The page blits ONLY these rectangles, never the whole panel per frame, so
it exercises your actual partial-refresh path, and draws them as a fading
outline overlay. This is arguably the single highest-value feature in the
whole tool: a partial-refresh bug is a bug about window geometry, and it
is invisible until the windows themselves are visible. See
`example/firmware/main.c`: a touch stamp calls `record_push()` with just
its own small rectangle; a full clear calls it with the whole panel. Watch
the difference in the page's push overlay.

### Input

```c
void emu_touch(int down, int x, int y);
void emu_button(int index, int down);
void emu_button_verdict(int index, int isLong);
void emu_sensor_event(int index);
```

Coordinates are always in the panel's own, unrotated space - if your
device is used rotated, mapping the pointer back is the PAGE's job
(`src/rotate.ts`), not yours, because your own coordinate handling is what
is under test here.

Buttons are identified by their index in `emu_device()`'s `buttons` array.
`emu_button` reports plain level changes; `emu_button_verdict` only fires
for a button that declared `longPressMs`. Sensor events are identified by
index in the `sensors` array, and only ever fire for a sensor declared
`"kind": "event"` - "it happened", not a continuous value.

**The rule this whole ABI exists to enforce**: the host must never deliver
an input your hardware cannot produce. If a real button, sensor, or touch
report has a shape your ABI doesn't reproduce (a release edge, a specific
verdict timing, a defect a real controller has), fix the ABI or the
emulator's model of it, not the other way around. See `wasm/emu_abi.h`'s
own header comment for the worked example of this rule biting in both
directions on the project this repo was extracted from.

### Optional: apps

```c
int  emu_app_current(void);
void emu_app_switch(int index);
```

Only called if `emu_device()` declared a non-empty `apps` array. Leave
these unimplemented (don't export them) if your firmware has no such
concept - `example/firmware/main.c` does exactly that.

### Optional: sound

```c
int      emu_sound_sample_rate(void);
uint32_t emu_sound_play_seq(void);
uint32_t emu_sound_stop_seq(void);
int      emu_sound_buffer(void);
int      emu_sound_frames(void);
```

Sound is an OUTPUT, never something the host calls into - your firmware's
own logic (an alarm, a notification) calls its own play/stop functions on
its own, and the host's only job is noticing via two counters it diffs
against what it last saw. See `wasm/emu_abi.h`'s "sound" section for the
full shape (sample rate, a fixed PCM buffer, the two sequence counters) and
what it is honest about (the tune, never the timbre - a laptop speaker
will always flatter what a real device's tiny speaker actually does).
`example/firmware/main.c` does not implement sound, to stay small; add it
the same way as apps, by implementing and exporting the five functions
above.

## What your module imports from the host

The freestanding-C route receives:

- **`env.js_log(ptr, len)`** - UTF-8 diagnostic text, your firmware's
  `printf`. Shown in the page's console pane.
- **`env.sinf, cosf, atan2f, sqrtf, fabsf, floorf, fmodf, powf, expf`** -
  single-precision math, mapped to the host's own `Math.*`. Deliberately
  not reimplemented inside your module: they would be a second source of
  numerical difference between your two targets.

Puck also accepts a WASI Preview 1 **reactor** for C++20/libc++ firmware. It
calls the reactor's optional `_initialize` export before `emu_init` can run
and provides only `fd_write` for stdout/stderr, rejects `fd_close` and
`fd_seek`, and surfaces `proc_exit` as a host error. Diagnostic writes are limited to
1,024 iovecs and 1 MiB per call; larger calls return `E2BIG`. This is enough
for the packaged libc++ allocator/runtime and its terminal diagnostic path. It
intentionally
does not provide a clock, randomness, environment, networking, or filesystem:
those would violate deterministic host-driven input and time.

If your build asks for any other import, `WebAssembly.instantiate` throws
naming exactly what it wanted and did not get. Treat that as an import-policy
decision, not a reason to add a broad WASI polyfill.

## Allocation and standard libraries

The default `wasm32-freestanding` C target has no libc or allocator.
`example/firmware/main.c` therefore uses a static framebuffer and logs through
`js_log`. Small C firmware can use the same approach or provide a narrow bump
allocator.

C++ firmware that needs `std::vector`, `std::span`, `std::optional`, or other
hosted C++20 facilities should instead build a `wasm32-wasip1` reactor against
libc++. On macOS, `brew install llvm wasi-libc wasi-runtimes` supplies the
matching pieces; `test/wasi/build.ts` is a working build and loader regression
fixture. Build with `-mexec-model=reactor`, export the required `emu_*` names,
and use `extern "C"` linkage. The reactor owns its allocator and can grow its
linear memory; Puck still owns all external time and input.

## Building your firmware to wasm

`example/build.ts` is a complete, working reference: it invokes `zig cc`
(a self-contained C-to-`wasm32-freestanding` cross-compiler with no sysroot
to install) with the flags this target actually needs, verified against a
real build rather than assumed from docs - read that file's header comment
for the toolchain notes (which linker flag actually leaves an import
undefined, why `--export-dynamic` is unreliable for this target, and so
on). Copy its shape for your own firmware: point `SOURCES`/`INCLUDES` at
your own files, and `EMU_EXPORTS` at whichever ABI functions you actually
implemented.
