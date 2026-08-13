# The agent loop: freeze and annotate

**This layer is optional.** The emulator is fully usable, for every
capability described in [`requirements.md`](requirements.md), with this
layer absent: launching, iterating on a firmware, screenshotting, pausing,
stepping, recording and replaying a trace, and debugging all work without
anything described in this document existing. What follows is what gets
added on top for the specific case of a coding agent working alongside the
person using the emulator, and it is deliberately kept removable.

## Why this stays cleanly separated

The dependency arrow points one way only. `src/freeze.ts` reads the core's
state (the event log, the framebuffer, the device descriptor); the core
(`src/wasm.ts`, `src/panel.ts`, `server.ts`) has no import, no hook, and no
awareness of the freeze layer's existence.

That asymmetry is not a style preference, it is what makes a freeze useful
at all. A freeze is only worth having because it captures the input trace
that produced the frame, alongside the frame itself. A screenshot tool
built entirely outside the emulator (a browser extension, a separate CLI
that drives Puppeteer against the running page) can capture pixels, but it
has no access to the event log that lives inside the emulator's own
process, so it can only ever produce a picture with no story of how the
device got into that state.

## The freeze-and-annotate loop

1. **Freeze.** The "freeze" button in the page (`src/main.ts`'s
   `runFreeze`) captures a bundle: the current frame as a PNG, plus a JSON
   sidecar holding everything needed to understand how the frame came to
   look the way it does. See [the bundle shape](#the-bundle) below.
2. **Annotate.** The frozen frame is, by construction, a static image: the
   emulator is effectively paused for the duration of a freeze, so nothing
   repaints out from under a mark. The built-in annotation modal
   (`src/freeze.ts`'s `openAnnotationModal`) lets you draw on it and write
   notes directly: circle what's wrong, pick a type (fix / question /
   new), type in place. If your own project already has a page-annotation
   tool with a similar f/q/n vocabulary, the bundle's `journal` field
   (`src/journal.ts`) is compatible with reusing that instead - see "Where
   this stays narrow" below - but nothing in this repo requires one to
   exist.
3. **Pick up.** An agent reads the bundle from a predictable, gitignored
   path with a stable schema (see "Where an agent finds it" below).

## Where this stays narrow, and why

A frozen device screenshot is a much narrower thing than a live web page,
so its annotation vocabulary is narrower too, on purpose:

- **A flat list of marks, not a page-keyed map.** A freeze bundle is one
  frame, frozen at one instant; there is exactly one "page," so there is
  nothing to key marks by.
- **No in-place text editing.** A device panel's framebuffer is pixels a
  firmware wrote, not text a browser laid out; there is nothing to retype
  in place. A mark on a frozen panel is a note pointing at a rectangle of
  pixels, never a text rewrite.
- **No captured layout frame or attached-element selectors.** A frozen
  frame never reflows: it is a fixed-size PNG at a fixed pixel size, for as
  long as it exists. A mark's position is just `(x, y)` in that PNG's own
  pixel space, and never needs re-anchoring, because nothing about the
  frame ever moves under it.
- **Fields a page-annotation tool has no reason to carry, because they are
  specific to what makes a firmware frame debuggable rather than
  correctable**: `device` (the full `emu_device()` descriptor), `app` (the
  current app id, when the firmware declares apps), `pushes` (the recent
  push rectangles - the same data the live push overlay draws), `input`
  (the recorded sequence of touch/button/sensor events and tick
  timestamps that produced this exact frame), and `console` (the
  firmware's own log lines up to the freeze). These exist because an agent
  debugging a firmware regression needs the trace and the pushes at least
  as much as it needs the pixels.

## The bundle

One freeze produces two files, written together (`server.ts`'s
`saveFreeze`):

- **A PNG** of the panel at freeze time, at the panel's native resolution
  (`emu_device()`'s declared `panel.w` x `panel.h`), unrotated, matching
  what `emu_fb()` actually holds rather than whatever rotation the page
  happens to be displaying it at.
- **A JSON sidecar** (`src/freeze.ts`'s `FreezeBundle`) holding:
  - `schemaVersion`, `capturedAt`: the envelope.
  - `device`: the full `emu_device()` JSON, verbatim, so an agent reading
    the bundle in isolation knows what device this is without cross
    referencing anything else.
  - `currentApp`: the current app id, if the firmware declares apps
    (`null` otherwise).
  - `pushes`: the push rectangles from the tick(s) immediately preceding
    the freeze - so a partial-refresh bug is visible in the bundle itself,
    not only on screen at the moment someone was looking.
  - `input`: the recorded `(t, event)` sequence, most recent first, that
    produced this frame. This is what makes the bundle actionable rather
    than merely descriptive: an agent (or a person) can replay it against
    a rebuilt module and watch the same thing happen again,
    deterministically, per [`requirements.md`](requirements.md#determinism-as-the-foundation).
  - `console`: the firmware's own log lines emitted up to the freeze.
  - `journal`: `{ strokes, notes }` - empty until the annotation modal
    saves something (`src/journal.ts`).
  - `panelPngPath`: always `"panel.png"`, the sibling file.

## Where an agent finds it

A predictable path, gitignored and transient:

```
freezes/
  latest/
    panel.png
    bundle.json
  <id>/
    panel.png
    bundle.json
```

`freezes/latest/` is overwritten on every freeze, so an agent that just
wants "whatever was last frozen" has one fixed path to read with no
directory listing and no timestamp parsing. Every freeze also gets its own
timestamped (or explicitly-named) directory for cases that need more than
the most recent one - bisecting across a session, or being pointed at a
specific freeze by id.
