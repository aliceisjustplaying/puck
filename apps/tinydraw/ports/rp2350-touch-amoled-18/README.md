# tinydraw on rp2350-touch-amoled-18 (SHOW PHASE)

Verdict: **degraded** (mode: adaptation, once proven - see "Not yet verified" below).

## Why degraded, not go

The pack fits the descriptor's Requires cleanly: the panel is fine-grained enough
for antialiased variable-width ink, touch is continuous with a timebase, and BOOT
(undo) / PWR (zoom) are two distinct, low-accident controls. What it cannot give
without a real cost is the Prefers list:

- **Zoom is two fixed levels (1x, 2x) about the panel's own center, not a
  continuous, pannable camera.** `tinydraw.c`'s header comment has the full
  reasoning; this pack's `--app` single-file build has no access to the donor's
  C++ `Camera`/tile system, and a 64KB app arena has no room for a 1472x1792
  world's worth of tiles regardless.
- **Undo is one stroke deep, not the donor's ten tile-based slots.** Cheap here
  because the whole document is kept as stroke geometry (points + radii) in the
  arena, not as pixel copies - see `tinydraw.c`'s stroke-pool comment.
- **No colour, pen size, eraser, or toolbar.** Out of scope by the descriptor's
  own Demands section, not merely dropped along the way.
- **No curve fitting between touch samples.** This pack's own `sketch.c` and the
  donor both subdivide long jumps into a curve so a fast stroke does not read as
  straight facets; this port draws a straight capsule per sample instead. Not
  visible in the demo trace (its synthetic samples are close enough together),
  but would show up on a real finger's fast strokes - flagged rather than left
  silent, and a natural next step in the lock phase.
- **No end taper.** `sketch.c`'s pen model tapers a stroke's very end down toward
  zero width; this port ends at whatever radius the last sample computed.

## What was verified this pass (show phase only)

`bun run packs/rp2350-touch-amoled-18/wasm/build.ts --app
apps/tinydraw/ports/rp2350-touch-amoled-18/tinydraw.c` compiles clean (first
attempt, no zig retries needed). One hand-built trace,
`apps/tinydraw/traces/tinydraw-demo.trace.json`, replayed headlessly against the
built module (the same mechanism `harness/selftest.ts` uses, no browser) and
captured four frames in `apps/tinydraw/frames/`:

| Frame | What it shows |
| --- | --- |
| `tinydraw-demo.t750.png` | A single stroke, drawn fast-slow-fast: visibly thin at both ends, thick in the middle - variable width from speed alone. |
| `tinydraw-demo.t1050.png` | The SAME stroke after a PWR short press, reprojected at 2x about the panel center - larger, same shape, no distortion. |
| `tinydraw-demo.t1350.png` | A second, short stroke drawn while zoomed, alongside the first. |
| `tinydraw-demo.t1600.png` | After a BOOT click: identical to the zoomed frame before the second stroke - undo removed exactly the most recent stroke and nothing else. |

All four were looked at, not just diffed to zero pixels changed - see
`AGENTS.md`'s "regarding renders" rule in the parent conversation this port was
built from.

## Not yet verified (deliberately left for the lock phase)

Per this repo's `skills/puck-publish/SKILL.md`, listing is a reproduction, not a
submission: nothing here is a `bundle.json` entry yet, no `verify-bundle` run has
happened, and no invariants checker exists. The natural next step is an
`apps/tinydraw/invariants.ts` in `apps/fluidbox/invariants.ts`'s shape (mass/ink
proxy, a flatness- or bounds-style geometric check, a zoom-scale check, an
undo-removes-exactly-one-stroke check), proven red-before-green, before any
`bundle.json` claims this port as `adaptation`/`degraded`.
