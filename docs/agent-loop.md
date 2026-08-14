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
  - `input`: the recent recorded `(t, event)` sequence in chronological
    order. `inputTruncated` is true whenever this bundle's list is incomplete,
    either because recorder capacity stopped the session trace or because the
    freeze includes only its recent input window. Freeze input is diagnostic
    history, not a promise that it can replay from fresh boot.
  - `console`: the firmware's own log lines emitted up to the freeze.
  - `journal`: `{ strokes, notes }` - empty until the annotation modal
    saves something (`src/journal.ts`).
  - `panelPngPath`: always `"panel.png"`, the sibling file.
  - `engine`: `{ alive: true }`, or `{ alive: false, error, diedOnTick,
    cause, lastInputEvent, diedAt }` when the module trapped before this
    freeze was taken (`src/main.ts`'s `enterDeadState`). A trap can happen
    inside `emu_tick()` itself (the ordinary tick loop, `cause: "tick"`) or
    inside a direct ABI call made from a DOM event handler entirely outside
    the tick loop - a button press, a sensor click, an app-strip click
    (`src/main.ts`'s `guardedAbiCall`) - and `cause` says precisely which
    one, e.g. `"button[0] down"` or `'app switch to 1 ("two")'`, rather than
    always claiming `"tick N"` regardless of what actually threw. Either
    way the whole module is considered dead, not just the one control that
    was pressed: per the wasm spec, a trap in ANY export leaves the
    instance's linear memory and globals in whatever partial state existed
    the instant execution stopped, exactly as suspect no matter which
    export it happened in. A freeze reads the last-painted canvas and the
    recorder's existing history, neither of which needs the module to still
    be alive, so without this field a freeze taken after a silent crash
    would look completely ordinary: valid pushes, a valid input trace,
    nothing anywhere saying the session that produced them is over. This
    field exists so this bundle can never make that claim by omission -
    always present, never optional, so absence is never how a reader is
    expected to infer health. Bundle `schemaVersion` is `3`: version `1`
    predates this field, and version `2` predates `inputTruncated`.

## A failed regression check, for an agent

A failed check from the hardware-free regression check (`src/regression.ts`,
see [`docs/harness.md`](harness.md#a-regression-check-with-no-hardware)) is
arguably the single most useful thing this repo can hand an agent: it
carries the exact input that provoked the problem, the frame that used to
be right, and the frame that is wrong now, all at once. It is exported in
the same spirit as a freeze bundle - a predictable path, self-contained,
honest about what it is - deliberately not forked into a different shape
just because it comes from a different button.

`server.ts`'s `/api/regression-result` route writes, on every check
(pass or fail):

```
regressions/
  latest/
    result.json
    t<atMs>.baseline.png   (only for a capture point that diverged)
    t<atMs>.current.png
    t<atMs>.diff.png
```

Like `freezes/latest/`, this is a single always-overwritten slot, not a
history: a regression result is a status report about "right now", and a
previous failing check's PNGs are deleted before a new result is written,
so nothing here can be mistaken for still applying after a later, clean
check.

`result.json` mirrors a freeze bundle's own fields on purpose - `device`,
`input` (the trace that produced every capture point, most-recent-event
semantics aside), `points` (one entry per capture point: match/diverge,
pixel counts, first divergent coordinate) - plus `diverged`, which names
which capture points failed and points at their three PNGs. There is no
`panelPngBase64` field here the way a freeze bundle has one: a regression
result can have zero, one, or several diverging frames, so the images live
as sibling files instead of a single embedded field.

**The same honesty bound applies here as everywhere else in this
document**: this compares the emulator against itself. A failed check means
your firmware draws something different than it used to, for the exact
same input - it says nothing about real hardware, and nothing about timing.
See `docs/harness.md`'s own statement of this, right where the feature is
introduced.

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
