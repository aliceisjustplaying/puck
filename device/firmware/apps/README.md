# The three apps

One binary holds all three. Switching is a function call, not a reboot: about
15ms, against 182ms when each app was its own flashed image.

Hold BOOT and PWR together to open the menu, then touch a picture. There is no
back arrow, no home button and no title bar anywhere: an app owns the whole
panel and refers to nothing outside itself. That is a rule, written down in
[decision 0002](../../docs/decisions/0002-runtime-architecture.md).


All three live in [`device/firmware/apps/`](.), one file
each, and they ship as one binary: switching between them is a function
call, not a reboot. Hold **both side buttons** together for about a second
and a half and the three pictures appear. Touch one. The same chord closes
the menu again and goes back to what was running.

![The menu: a stopwatch, a pencil, an hourglass](../../preview/screen-menu.png)

That chord is the only way in and out, and it is the only navigation the
device has. No app carries a back arrow, a clock, a battery indicator or its
own name anywhere on screen, on purpose:
[decision 0002](../../docs/decisions/0002-runtime-architecture.md) argues
it, and the case gets a physical mark instead. **PWR is the lower side
button, BOOT the upper one.**

| | | |
|---|---|---|
| ![](../../preview/screen-chrono.png) | ![](../../preview/screen-sketch.png) | ![](../../preview/screen-timer.png) |

### The stopwatch, `apps/chrono.c`

Six digits, `MM:SS:CC`, and nothing else on the screen. **PWR starts and
stops it. BOOT resets it to zero**, from any state.

A stop is applied in the same tick the press arrives, before that tick
redraws, because a stopwatch that freezes a frame late is a stopwatch that
reads wrong. It is also the one app deliberately deaf to the shake sensor:
shaking is how the sketchpad erases, and a number a child is carrying across
a room should not be destroyed by a jolt.

### The sketchpad, `apps/sketch.c`

Draw with a finger. The ink varies in width and tapers at both ends like a
real pen, but this panel has no pressure to report (the touch controller
answers zero to its own weight and area registers, always, however hard you
press), so the width comes from how fast the stroke is moving: fast is
light. Overlapping segments composite darkest-wins rather than blending,
which is what keeps a slow stroke from compounding into the hard, pixelated
edge the anti-aliasing exists to avoid.

**Shake the puck to erase.** It wipes in sixteen bands rather than blanking,
and a touch during the wipe stops it part way.

**Hold a finger still** for half a second, without moving more than about
12 pixels, and the whole screen becomes a grid of nine colours. Slide onto
one and lift to pick it; lift in a gap between two and nothing changes.
Black sits in the middle, because that is the device's own ink. The dot that
hold would otherwise have drawn is rolled back, so opening the palette never
marks the page.

![The palette: nine colours over the whole screen, black in the middle](../../preview/palette-open.png)

### The timer, `apps/timer.c`

A dial you wind, not a number you type. Drag a finger around the ring:
**one full turn is fifteen minutes**, and carrying on past twelve o'clock
winds a second, inner band, up to a **thirty minute** maximum. Every part of
the dial is worth the same five seconds per step, everywhere, which matters
for someone who cannot yet read the digits in the middle: an earlier version
had three different step sizes at three different radii, and the same finger
movement meaning different things in different places is what made it
unusable.

**PWR starts it and pauses it. BOOT resets** it to the value you set, and
from a blank dial recalls the last one, so "again" is a single press.

At zero it flashes black and white twice a second and rings: four rising
notes, synthesised sample by sample rather than stored, because a stored
phrase would cost tens of kilobytes of SRAM this device does not have. Any
touch and any button stops it, since a child reaching for a beeping object
should not have to remember which one.


---

Back to the [repository README](../../../README.md).
