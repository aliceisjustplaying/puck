# Port verdict: web (Web-Touch)

## Verdict: go, mode faithful

Comparing `apps/chrono/descriptor.md`'s `Demands` against
[`packs/web/device.json`](../../../../packs/web/device.json):

| Demand | device.json | Fit |
|---|---|---|
| Panel >= ~200x200, monochrome acceptable | `panel.w=368, panel.h=448, format=rgb565be` | exceeds; matches the *preferred* 368x448 colour panel exactly, because this pack deliberately declares the AMOLED siblings' panel |
| Touch or >= 2 buttons, with distinct start/stop and reset | `buttons: [boot, pwr]`, rendered on screen | `pwr` (index 1) toggles, `boot` (index 0) resets: the same two ids, the same two indices a recorded trace already names |
| A millisecond timebase as the sole elapsed-time source | `app_frame_t.nowMs`, fed from `performance.now()` through `emu_tick()` | matches, and is the only clock `tick()` reads |

Nothing in the Demands is unmet and nothing is reinterpreted, so the
verdict is **go** at **faithful**: the traces replay verbatim and
verification is pixel-exact at tolerance 0.

The two things worth naming, neither of which changes the verdict:

- **The buttons are drawn, not felt.** `boot` and `pwr` exist as on-screen
  ghost buttons under the panel, carrying the pack's declared ids, labels
  and `longPressMs`. The descriptor's Interactions section asks for "a
  short PWR press" and "a BOOT click"; it does not ask for a physical
  travel, and a tap resolves to the same `KEY_SHORT` / release-edge click
  the PMIC and the flash chip-select produce on the board. The intent
  behind each affordance is now written into the descriptor itself (see
  `docs/convention/app-bundle.md`, "Affordances carry their intent"), and
  both intents survive: the primary one-tap toggle is one tap, and the
  destructive reset is the other button, not a mode of the first.
- **The host presents it landscape; the module does not know.** chrono
  draws into a 448x368 landscape space that `gfx` rotates into the portrait
  panel, so its content sits sideways in the framebuffer. On the puck you
  turn the device. On a phone the page turns with you, so turning it
  achieves nothing, and the host rotates the presentation instead: built
  with `--landscape`, the page shows the panel quarter-turned and inverts
  that same transform when mapping a finger back to panel coordinates.
  This is exactly what the gallery already does for the same app on the
  chip packs (`site/build.ts` clicks the emulator's own -90 degree
  quick-rotate on every chrono run page), and it changes nothing the module
  computes: the framebuffer, the pushed rectangles and the pixel-exact
  proof below are all upstream of it.

## What changed against the reference

`apps/chrono/reference/rp2350-touch-amoled-18/chrono.c` is 171 lines. Lines
**1 to 157 appear here byte-for-byte**, including the `#include <stdio.h>`
and the three bare-filename includes (`app.h`, `digits.h`, `gfx.h`,
`sensors.h`) - no include path was retargeted, because the web pack vendors
all four under those exact names.

The only change is the tail:

- **removed**: the 8-line `const app_t g_chronoApp = { .name, .enter,
  .tick, .leave, .landscape, .wantsShake }` initializer.
- **added**: `void port_enter(void)` and `void port_tick(const app_frame_t
  *f)`, two one-line adapters.

That is the web pack's `--app` contract, and it is the RP2350 pack's `--app`
contract adopted unchanged: a port file supplies two plain functions and
the build generates the `app_t` around them, with `--landscape` and
`--shake` setting the two fields that vary. This port is built with
`--landscape` and without `--shake`, which sets exactly the two flags the
removed initializer set.

Nothing else moved. No layout constant, no arithmetic, no redraw strategy:
the port still repaints only the digit cells whose value changed and pushes
only those, which is what a `full-framebuffer` memory model buys on either
target.

## Proof

```
bun run packs/rp2350-touch-amoled-18/wasm/build.ts        # module A
bun run packs/web/wasm/build.ts --app apps/chrono/ports/web/chrono.c --landscape   # module B
bun run portdiff <A>.wasm <B>.wasm apps/chrono/traces/chrono-idle.trace.json --at 1008 --tolerance 0
bun run portdiff <A>.wasm <B>.wasm apps/chrono/traces/chrono-startstop.trace.json --at 1808,1888,2080 --tolerance 0
```

Both runs, 2026-08-19:

```
chrono-idle.trace.json: replaying 64 events, capturing at 1 point(s): 1008
RP2350-Touch-AMOLED-1.8 368x448, 1 frame(s) captured
Web-Touch 368x448, 1 frame(s) captured
-- comparison (tolerance 0) --
  t=1008ms  MATCH
PASS: 1 frame(s) compared (chrono-idle.trace.json)

chrono-startstop.trace.json: replaying 125 events, capturing at 3 point(s): 1808, 1888, 2080
RP2350-Touch-AMOLED-1.8 368x448, 3 frame(s) captured
Web-Touch 368x448, 3 frame(s) captured
-- comparison (tolerance 0) --
  t=1808ms  MATCH
  t=1888ms  MATCH
  t=2080ms  MATCH
PASS: 3 frame(s) compared (chrono-startstop.trace.json)
```

`bun run verify-bundle apps/chrono` is what actually decides this port is
listed; it replays the same traces against the bundle's recorded frames in
`apps/chrono/frames/`, which is the same comparison from the other side.

## What a pixel-exact match here does and does not prove

It proves the two runtimes agree, frame for frame, on everything an app can
observe: the arena, the dt clamp, the first-tick dt of 0, the button edges,
the read-and-clear key semantics, the click-on-release rule, and the
framebuffer's pixel format. Those are the parts a browser could plausibly
have gotten subtly wrong, and a stopwatch is an unusually good detector for
them because a one-tick timing difference moves a visible digit.

It does not prove anything about the host: the canvas scaling, the pointer
mapping, the DPR handling and the PWA install path are all outside the
module and outside this diff. Those are exercised by
`scripts/verify-site-embeds.ts`'s browser check of `/web/chrono/`, and the
install itself is still an untested claim until it is done on a real phone.

## No silicon attestation, and none is possible

`bundle.json` carries no `silicon` block for this port. A browser has no
silicon of its own to attest to: "run on real hardware" for this pack means
"run on a real phone", which is a different claim with a different meaning,
and inventing a field for it would blur the one distinction
`docs/convention/publishing.md` is careful about. What a real phone run
proves for this port is the HOST, not the module, and the honest place for
that is this README rather than a machine-readable attestation the verifier
cannot re-derive.
