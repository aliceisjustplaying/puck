# Port verdict: esp32-s3-touch-amoled-18

## Verdict: go, mode faithful

Comparing the descriptor's `Demands` against this pack's `device.json`:

| Demand | device.json | Fit |
|---|---|---|
| Panel >= ~200x200, monochrome acceptable | `panel.w=368, panel.h=448, format=rgb565be` | exceeds; matches the *preferred* 368x448 color panel exactly |
| Touch or >= 2 buttons with distinct start/stop and reset | `buttons: [boot, pwr]`, no touch zones needed | `pwr` (index 1) drives start/stop, `boot` (index 0) drives reset; same two buttons the reference uses |
| Millisecond timebase as sole elapsed-time source | `app_frame_t.nowMs` (uint32, ms), the only clock `tick()` ever reads | matches |

Same panel (368x448, rgb565be) as the reference `rp2350-touch-amoled-18` pack. `boot` and `pwr`
are present with identical ids/semantics (`pwr` declares `longPressMs: 1500`, so the runtime
resolves `KEY_SHORT` for us exactly the way the reference relies on). Nothing in the Demands is
unmet, and the pack's declared shape is a superset of what's required, so the verdict is **go**
at **faithful**: the trace replays verbatim, no gesture or timing gets reinterpreted, and
verification is pixel-exact.

The one real constraint this pack adds that the reference didn't have: no persistent
framebuffer. `draw_band()` gets a 28-row band with undefined prior content and must repaint
every pixel of it, every frame, 16 times a frame (`app.h`). The reference's chrono only repaints
digit cells that changed and pushes just those. That's an implementation-strategy difference the
port must absorb; it is not a Demand and does not change the verdict, because the descriptor
never demands partial-refresh behavior, only the final pixels on screen.

## What came from the descriptor vs. what had to be pinned from the reference

Pixel-exact verification (`portMode: "faithful"`, `verification: "pixel-exact"`, `bundle.json`)
means matching the reference bit-for-bit, so the reference snapshot
(`apps/chrono/reference/rp2350-touch-amoled-18/chrono.c` and
`packs/rp2350-touch-amoled-18/firmware/apps/digits.c`/`.h`) was read as evidence for exact
geometry. Most of the coarse layout turned out to already be in the descriptor and only needed
confirming by arithmetic; the seven-segment glyph shape did not.

**From the descriptor directly** (`apps/chrono/descriptor.md`'s Essence section states these in
prose): digit cell 48x120px, separator cell 24x120px, 12px gaps between every element, 14px
margin on both sides, row starts at landscape y=124. Re-deriving the six digit x-positions from
margin(14) + widths(48,48,24,48,48,24,48,48) + gaps(12 between each) reproduces the reference's
`X_MM_TENS=14, X_MM_UNITS=74, X_COLON1=134, X_SS_TENS=170, X_SS_UNITS=230, X_COLON2=290,
X_CS_TENS=326, X_CS_UNITS=386` exactly, and 14+448 (sum of every width and gap) lands on the
448px landscape width with the same 14px margin on the right, confirming the numbers rather than
requiring a separate source. `Y0=124` also checks out as `(368 - 120) / 2`, the vertical centering
the Essence text describes. The `MM:SS:CC` grouping, "colons only, never a comma", "digits change
in place while colons stay fixed", the PWR-toggles / BOOT-resets interaction split, and the
"stopped at 00:00:00 on entry" starting state are all descriptor text, reimplemented directly
without consulting the reference source.

**Had to pin from the reference** (the descriptor is silent on these, so pixel-exactness was not
achievable from the descriptor alone):

- **Segment thickness, 18px.** Never stated in the descriptor; taken from `digits.c`'s `SEG_T`.
- **The seven-segment bit table** mapping each digit 0-9 to which of the 7 bars are lit
  (`SEVEN_SEG[]` in `digits.c`). This is the actual glyph shape and has no textual description
  anywhere in the descriptor.
- **Two rendering corrections documented in `digits.h`'s header comment**, both invisible unless
  you already know to look for them: (1) a vertical segment extends to the full cell edge when
  the horizontal bar that would have capped it is absent (otherwise "4" and any digit missing its
  top or bottom bar reads visibly shorter than its neighbours), and (2) an upper/lower vertical
  pair on the same side merges into one continuous stroke when the middle bar is absent (otherwise
  "1" reads as two disconnected ticks with a gap where the middle bar's row would be).
- **The colon's exact construction**: two `t x t` squares, horizontally centered in the 24px
  separator cell (`(w-t)/2` offset), vertically at `h/3 - t/2` and `2h/3 - t/2` from the cell top.
  Nothing in the descriptor specifies "thirds of the cell height" as the dot spacing.
- **The landscape-to-panel rotation formula**: landscape `(lx, ly, w, h)` becomes panel
  `(PANEL_W - (ly + h), lx, h, w)` (`packs/rp2350-touch-amoled-18/firmware/runtime/gfx.h`'s
  `gfx_land_rect` comment). The descriptor says the app "renders landscape" and gives landscape
  coordinates, but never states which way the 90-degree rotation goes; getting this backwards
  produces a valid-looking but upside-down or mirrored image, matched only by cross-checking
  against the reference's own comment and the resulting frames.

This list is the underspecification report: a descriptor-only port (no reference available)
could have built a plausible chrono at the right size and cadence, but would not have reproduced
the reference's exact glyph shapes, the two silent rendering corrections, or the rotation
direction, without guessing.

## Implementation note: the runtime's app symbol

`packs/esp32-s3-touch-amoled-18/firmware/runtime/runtime_core.c` (unmodified, per the porting
rules) declares `extern const app_t g_demoApp;` and wires that one symbol as the pack's single
app. Swapping which `.c` file gets compiled in (this port's `chrono.c` in place of
`firmware/apps/demo.c`, via `wasm/build.ts --app`) only works if the replacement file also
defines a symbol named `g_demoApp`; the name is a leftover from the pack's one shipped reference
app, not a menu entry, since this pack declares no `"apps"` array (`device.json`) and has no
switch machinery. This port's `chrono.c` therefore exports `const app_t g_demoApp = { .name =
"chrono", ... }`, keeping the linkage symbol as-is and only changing the app's own declared
`name` string. Renaming the symbol itself would require touching `runtime_core.c`, which is out
of scope for a port (see the task's porting rules); it's a one-line, well-contained wart worth
naming rather than hiding.

## Reproducing the pixel-exact proof

```
ZIG_EXE=C:\Users\sylve\tools\zig\zig.exe bun run pack:build
cp wasm/dist/emu.wasm /tmp/rp2350-chrono.wasm
ZIG_EXE=C:\Users\sylve\tools\zig\zig.exe bun run packs/esp32-s3-touch-amoled-18/wasm/build.ts --app apps/chrono/ports/esp32-s3-touch-amoled-18/chrono.c
cp wasm/dist/emu.wasm /tmp/esp32-chrono.wasm
bun run portdiff /tmp/rp2350-chrono.wasm /tmp/esp32-chrono.wasm apps/chrono/traces/chrono-idle.trace.json --every 100
bun run portdiff /tmp/rp2350-chrono.wasm /tmp/esp32-chrono.wasm apps/chrono/traces/chrono-startstop.trace.json --write-frames apps/chrono/frames
```

Both traces compared pixel-identical at every capture point (see the final report for verbatim
output). `apps/chrono/frames/` holds the rp2350 (first-module) frames from the second command,
written as this bundle's expected frames; `bundle.json`'s `provenPacks` now lists
`esp32-s3-touch-amoled-18` alongside the reference pack.
