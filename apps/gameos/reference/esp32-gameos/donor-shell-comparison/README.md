# Donor shell comparison: this port's real shell vs. the donor's own reference

This is the re-anchoring this bundle's earlier port work skipped: instead of
comparing this port's module against itself (`invariants.ts`, this bundle's
own captured `frames/`), this compares it against something the donor
itself produced - `media/launcher.png`, downloaded byte-for-byte from
[`MikeWilson/esp32-gameos`](https://github.com/MikeWilson/esp32-gameos)
at the pinned commit (`../../../ports/esp32-s3-touch-amoled-18/NOTICE.md`)
and vendored unmodified at `../media/launcher.png`.

## The two images

- `../media/launcher.png` - the donor's own reference screenshot, vendored
  unmodified.
- `our-shell-boot.png` - this port's own module, captured live by
  `scripts/capture-gameos-esp32-shell-frame.ts`: boot, tap once to dismiss
  the first-run calibration wizard (see "One real, new divergence" below),
  settle, capture. Regenerate with:

  ```
  ZIG_EXE=<path> bun run pack:esp32:build -- --app apps/gameos/ports/esp32-s3-touch-amoled-18/gameos_port.c --wasm-memory-mb 8
  CHROME_PATH=<path> bun run scripts/capture-gameos-esp32-shell-frame.ts
  ```

Both are 368x448, the panel's own native resolution.

## What matched

Structurally, everything: a light-gray striped field, white rounded
"channel" cards with a cyan letter icon and a title under it, empty gray
slots for unfilled grid positions, and a bottom bar with a round SET
button, a "GAMEOS" label, and a "USB" indicator in the bottom-right corner
(this pack declares no battery HAL - see NOTICE.md's "no battery HAL" shim
- so `hal_power_get()` always reports `present=false`, which is the
donor's own real, unmodified `draw_bottom_bar()` falling back to exactly
this "USB" text, not a rewrite this port made).

`scripts/compare-gameos-esp32-shell-vs-donor.ts` proves the shared regions
pixel-exact, at 5/6/5 (RGB565) precision (see "One expected, explained
gap" below for why 5/6/5 and not raw 8-bit):

```
GUNSHIP tile (grid slot 0): 0/19488 px differ (0.0%)
bottom bar (SET/GAMEOS/USB): 0/19136 px differ (0.0%)
```

GUNSHIP is the one game both images agree occupies grid slot 0 (col 0, row
0), so it is the one region this comparison can hold to a strict "nothing
else may differ" standard - and it does, exactly, down to the palette
values `gfx.c`'s own `gos_gfx_set_default_palette()` picks and the glyph
shapes `font.c`'s own `gos_font5x7` table draws. The bottom bar is
identical for the same reason: `draw_bottom_bar()` is real, unmodified
donor code, called with the exact same declared caps.

**No font565 divergence appears anywhere in this comparison.** The shell
grid, its cards, and its bottom bar are all drawn through the indexed
184x224 pipeline (`gos_gfx_text()`/`font.c`), never through GOLF's own
full-resolution `gos_gfx_text565()` path that `font565_shim.c` substitutes
for - that declared divergence is real (see NOTICE.md) but it is scoped to
GOLF's own screens, not the shell this comparison is checking.

## What differs, and why

**Tile content and count**, which drives the 24.7% whole-frame diff
(`40800/164864` px): the donor's own `media/launcher.png` shows three
tiles (GUNSHIP, AIM TEST, DIAG) with three empty slots; this port's own
capture shows five (GUNSHIP, GOLF, LUCKY 7, AIM TEST, DIAG) with one empty
slot. This is **not** a divergence this port introduced. `registry.c`
(vendored byte-for-byte, `../registry.c`) is what actually decides grid
content and order - `git log --oneline -- components/gos_shell/
registry.c` on the donor repository shows it was touched once after the
initial commit ("Pull BOMBER from the public tree"), while `git log
--oneline -- media/launcher.png` shows the screenshot has never been
updated since that same initial commit. `golf.c`/`slots.c` were already
part of that initial commit's registry (five real games, `bomber` pulled
later) - the donor's own reference screenshot is simply stale relative to
its own `registry.c`, predating `golf`/`slots` being wired into the grid
at all. This port compiles the real, current `registry.c`, so its own
grid reflects what that file actually declares today, not what a screenshot
from an earlier point in the donor's own history shows.

Because the tile ordering follows `registry.c`'s own array order
(`gunship, golf, slots, aimtest, diag`), DIAG's own grid position shifts
from row 1 (donor's 3-tile layout) to row 2 (this port's 5-tile layout) -
again a direct, mechanical consequence of vendoring the real, current
`registry.c`, not a layout change this port made.

## One expected, explained gap: RGB565 channel expansion

Before quantizing to 5/6/5, the SAME shared regions above are NOT
byte-identical - a flat background reads `(208,208,208)` in the donor's
PNG and `(214,211,214)` in this port's capture, a systematic +6/+3/+6
offset (R/B off by up to 6, G off by up to 3). That is exactly the gap
between two different, both legitimate, RGB565-to-RGB888 expansion
formulas for a 5-bit and a 6-bit channel respectively:

- plain left-shift: `v8 = v5 << 3` (R/B) or `v8 = v6 << 2` (G)
- bit-replicate (fills the low bits from the high bits instead of zeroing
  them): `v8 = (v5 << 3) | (v5 >> 2)` (R/B) or `v8 = (v6 << 2) | (v6 >> 4)` (G)

For a 5-bit value of 26 those two formulas give 208 and 214 respectively -
exactly the measured donor/ours values above. This is a display/capture-
tool artifact (whichever expansion the donor's own screenshot tool used,
versus this repository's own `src/panel.ts` canvas pipeline), not a
rendering difference in the shell itself: once both images are quantized
back down to 5/6/5 (`scripts/compare-gameos-esp32-shell-vs-donor.ts`'s
`q()`), the shared regions above match exactly, 0 pixels differing. This
is a SEPARATE gap from the font565 substitution NOTICE.md already declares
(that one is GOLF-only and changes text shape, not color); recorded here
because it is real and this task's own doctrine is to declare every
divergence rather than let a script quietly launder it into "exact."

## One real, new divergence: no NVS persistence means the calibration wizard reappears every boot

Vendoring the real `shell.c` surfaced a genuinely new, honest gap this
port's own former `launcher.c` never had to declare: `shell_init()` enters
the first-run tilt-calibration wizard (`SH_CALIB`, "HOLD THE DEVICE HOW
YOU PLAY / TAP TO SET CENTER") whenever `g_settings.calibrated` is false.
On real silicon this happens exactly once, ever - the setting persists in
NVS. This port's own `nvs.h`/`nvs_flash.h` shims always fail open (no
persistence at all - `../../../ports/esp32-s3-touch-amoled-18/NOTICE.md`),
so `g_settings.calibrated` never sticks: **every fresh module boot shows
the calibration wizard, not the grid, until the first tap.** This is why
`capture-gameos-esp32-shell-frame.ts` and this bundle's own demo/trace
recording both perform one dismissal tap as their first action - matching
a real device's very first-ever boot, not its two-thousandth. Recorded
here and in NOTICE.md rather than silently working around it.

## The donor's host frame-dump

The donor's own `docs/testing-and-verification.md` (vendored at
`../testing-and-verification.md`) documents a host-side simulator pattern
(`-DGOS_HOST_SIM`, a small `simN.c` harness compiling `gos_core/gfx.c`,
`font.c` and game sources on the host, dumping PPM frames). That harness's
own source is not part of the vendored donor repository (session
scratchpads only, per the donor's own doc). `hostsim/` in this directory
is a from-scratch equivalent, written for this task, reusing this port's
real vendored source and its own `gos_hal_shim.c`: it **compiles cleanly**
for a host-native target but **could not be linked into a runnable
executable on this machine** - `zig cc` segfaults deterministically at the
link step, reproduced against this driver AND against a one-line
`int main(void){return 0;}` control case, so the cause is this machine's
own native-link path, not this driver or the donor's method. See
`hostsim/README.md` for the full attempt log. **Not runnable here**,
stated plainly rather than faked or silently skipped.
