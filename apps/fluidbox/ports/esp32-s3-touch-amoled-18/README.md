# Port verdict: esp32-s3-touch-amoled-18

## Verdict: go, mode adaptation, verified by invariants

**The app is coming home.** FluidBox was born on this exact board: the donor
(`s0lness/esp32-fluidbox`, snapshotted under
[`apps/fluidbox/reference/esp32-fluidbox/`](../../reference/esp32-fluidbox/)) is custom ESP-IDF
firmware for a Waveshare ESP32-S3-Touch-AMOLED-1.8, and so is this pack. Every other fluidbox port
in this bundle carries the app to hardware it had never seen. This one carries it back, through the
convention, to the silicon it was written on. The pack's own `main/display.c`, `button.c` and
`imu.c` are themselves adapted from that same donor repository (see the pack's `AGENTS.md`), so the
band DMA pipeline this port draws through is, ancestrally, FluidBox's own.

Which makes the interesting question not "does it fit" but "what did the round trip cost". The
answer is on this page, and it is honest in both directions: nothing was lost relative to the
bundle, and a great deal is still lost relative to the donor.

Comparing [`apps/fluidbox/descriptor.md`](../../descriptor.md)'s `Demands` against this pack's
[`device.json`](../../../../packs/esp32-s3-touch-amoled-18/device.json):

| Demand | device.json / pack | Fit |
|---|---|---|
| Continuous per-frame compute for a particle solver | ESP32-S3 at 240MHz with a hardware single-precision FPU, one app task (`main/main.c` is a single loop: no second core to hide the solver behind) | met with a wide margin at this bundle's 130 particles; see "Compute" below |
| A full-screen redraw every frame | `memory.model: "band"`, 16 bands of 28 rows, double-buffered against DMA | met, and met *natively*: this contract repaints all 368x448 pixels every frame by construction, which is exactly what this app's Demand asks for and what a dirty-rectangle model has to be talked into |
| A colour panel | `panel.format: "rgb565be"`, 368x448 | met exactly, and it is the same physical panel the donor's constants (`PX_PER_METER`, `BOX_CORNER_MM`, `REST_SPACING`) were derived from |
| Motion input: a continuous gravity vector preferred, a discrete shake event the minimum | `sensors: [{"id":"shake","kind":"event"}]`, and nothing else | met at the **minimum**, not the preference: there is no `"kind":"vector"` sensor in this pack's `device.json` |
| *(prefers)* 60fps, a 3D box, IMU-driven gravity | panel exact; 2D box (the bundle's own adaptation); gravity fixed straight down | panel matches, the other two do not |

Two things change the interaction surface, which is what makes the mode **adaptation** rather than
faithful:

1. **Gravity is fixed straight down.** This pack declares one sensor, a discrete shake event. The
   descriptor allows exactly this ("a discrete shake event is the minimum"), so the port is not
   refused, but a tilt cannot pour the liquid here.
2. **Touch stirs.** This pack has a digitizer (`touch.points: 1`) the donor's own firmware never
   read. A finger drag nudges nearby particles: a widened interaction surface, which the
   descriptor's own Interactions section names as an adaptation when a port adds it.

That is the same adaptation surface the rp2350 port already carries, on a board that reads the
descriptor's Demands at least as well.

### Why `go` and not `degraded`

`verdict` is a judgement about *this port against this bundle's app*, not against the donor
firmware. The app this bundle defines is the 130-particle 2D fluid its `invariants.ts` thresholds
are calibrated against and its three ports implement. Measured against that app, this port loses
nothing: same solver, same constants, same particle count, and the frames it produces are
**pixel-identical** to the rp2350 port's at all three capture points (proof below). There is no
stated cost to record, which is what `degraded` exists to carry.

The rp2350 port is `degraded` for a reason that does not apply here in the same shape, and the
distinction is worth being precise about rather than waving at. That port's own README lists its
costs as compute (150MHz single core versus the donor's 240MHz dual core) and sensor surface. This
board **is** the donor's board: the compute mismatch it records simply does not exist here. The
sensor mismatch does exist, in the sense that gravity is fixed down. But so it is on the rp2350
port's real silicon, and so it is on the web port's recorded proof, and the web port is `go`.

Being honest in the other direction, because a `go` here could be read as a bigger claim than it
is: **this port is not the donor.** The donor ran 900 particles in a real 3D box with depth shading
and read a live IMU vector every step. This one runs 130 particles in 2D under constant gravity.
Against the *donor*, that is a large loss, and it is the bundle's loss, not this port's: it was
taken when the app was extracted into `apps/fluidbox/` and it is documented in the rp2350 port's
"kept vs lost" table. This port inherits that adaptation whole and adds nothing to the bill. Saying
`go` means "no new cost", not "as good as the original", and the difference between those two
sentences is this paragraph.

## Compute: the donor's own numbers, on the donor's own chip

The rp2350 port had to argue its fps plausibility from an op count because it was moving to a
slower chip. Here the comparison is direct, and it runs the other way.

| | Particles | Where the solver ran | Measured |
|---|---|---|---|
| Donor (`esp32-fluidbox`) | 900, 3D | This chip, one of its two cores, render on the other | 33-41 simulation steps/s (24-30ms per step) |
| This port | 130, 2D | This chip, the single `main.c` loop, render in the same tick | not measured on silicon; the same solver measured **0.186ms/tick** at 130 particles in the web port's harness |

The donor's own measurement is the useful bound. It sustained 900 particles in 3D at 33-41 steps/s
on this silicon while also driving this panel. This port asks the same chip for roughly a seventh
of the pair count (`130*129/2 = 8,385` pairs versus `900*899/2 = 404,550`, before the donor's grid
culls it) with one dimension fewer of arithmetic per pair. The web port's timing table puts the
same 2D solver at 0.186ms/tick for 130 and 2.653ms/tick for 900 on a laptop, a ratio of ~14x for
the ~48x pair-count increase, which is what an O(n^2) inner loop with a radius cutoff looks like.

**This is still not an fps proof, and this README does not claim one.** The emulator cannot answer
a timing question (the pack's `AGENTS.md` says so, and `wasm/emu_abi.h`'s "What is not real"
section says so). What is measured on this board's silicon is the *panel*: the band DMA pipeline
runs at 50 full-panel frames per second, paced by its own semaphore
([`docs/decisions/0001`](../../../../packs/esp32-s3-touch-amoled-18/docs/decisions/0001-what-the-first-flash-found.md)).
A solver that costs a fraction of a millisecond per tick on a laptop, against a donor that spent
24-30ms per step on this exact chip and still drove this exact panel, is not the thing that will
decide this port's frame rate. Running it on the board is what would close this, and it has not
been done.

## The band contract, and what it did to the app

The rp2350 port owns a persistent 368x448 framebuffer: it clears the buffer, draws 130 squares into
it, and pushes the whole panel once. This pack has no framebuffer at all, on the board or in the
emulator (`firmware/runtime/app.h`, the pack's `AGENTS.md`): `draw_band()` is called 16 times a
frame with a 28-row buffer whose prior content is **undefined**, and must write every pixel of it.

The split this port takes:

- **`tick()`** runs the whole solver (PWR reset, shake impulse, touch stir, one substep) and draws
  nothing, which is exactly what `app.h` asks of it.
- **`draw_band()`** fills the band with the app's black background, then offers all 130 particles to
  `gfxb_fill_rect()`, which clips each 7x7 square to `[y0, y0+rows)` and to the panel. Most of those
  130 calls touch nothing in a given band and cost only the clip check. 130 clip checks per band is
  2,080 a frame, against the ~285,000 floating-point operations the solver already does per step:
  bucketing particles per band would be a data structure earning less than it costs, so there is
  none.

One thing genuinely did change, and it is a small optimisation the band model *forces you to
notice*: particle colour is a function of speed, via a `sqrtf`. Computed inside `draw_band()` that
would be 130 square roots per band, 2,080 a frame, for velocities that cannot change between the 16
calls. So `tick()` refreshes a `uint16_t color[130]` cache at the end of the solver and every band
reads it. Same pixels, one sixteenth of the square roots. The full-framebuffer sibling never had a
reason to separate those two steps.

**No `app_frame_t.tilt` read.** The rp2350 and web ports both read `f->tilt.gx`/`f->tilt.gy` every
tick, with a fallback branch for when the reading is ~zero, because those packs' `app.h` declares
an `app_tilt_t tilt` field their own runtimes populate (the rp2350 pack's real QMI8658, through
`firmware/runtime/tilt.c`; the web pack's browser motion path). This pack's own `app.h`
(`packs/esp32-s3-touch-amoled-18/firmware/runtime/app.h`) declares no such field at all, and its
`device.json` declares no vector sensor either - there is nothing to read, on the board or in the
emulator, so reading one here would not compile. It is left out, gravity is the constant `(0, +1)`,
and `integrate_velocities()` is two lines shorter. Simpler is better here: on the other two packs
that field buys a real capability, and on this one it would buy a paragraph of comment explaining a
sensor the device does not have.

## Arena budget

This pack sets `APP_ARENA_BYTES` to **8192** (`firmware/runtime/app.h`), an eighth of the rp2350
sibling's 64KB, because it ships one app that never switches. Worth counting rather than assuming:

| | bytes |
|---|---|
| 12 x `float[130]` (positions, velocities, old positions, densities, pressures, viscosity deltas) | 6,240 |
| `uint16_t color[130]` (the cache above) | 260 |
| scalars (`restDensity`, `rng`, touch latch) | ~20 |
| **total** | **~6,520 of 8,192** |

It fits, with about 20% headroom. The colour cache is what makes this worth writing down: it is the
one allocation this port added over the sibling's state, and on a 64KB arena nobody would have had
to check.

## Verification: the same checker, unchanged, with the same thresholds

`bundle.json`'s entry names the identical checker
([`apps/fluidbox/invariants.ts`](../../invariants.ts)), the identical trace, and the identical three
capture points (4000, 4016, 9024) the other two ports use. Not one threshold was touched. Measured
on this port's own module:

| # | Invariant | Threshold | Measured here | Measured on the rp2350 module, today |
|---|---|---|---|---|
| 1 | Mass proxy stable | drift < **5%** between the two settled captures | 6352 -> 6350 (0.03%) | 6352 -> 6350 (0.03%) |
| 2 | Settled surface roughly flat | bucket-median spread < **40px**, both settled captures | 22px / 27px | 22px / 27px |
| 3 | Shake visibly agitates | `settled1` vs `afterShake` differ by > **1500px** | 4789px | 4789px |
| 4 | Inside panel bounds | outermost 1px border pure background, every capture | clean | clean |

```
$ bun run invariants /tmp/fluidbox-esp32.wasm apps/fluidbox/traces/fluid-settle-shake.trace.json \
    apps/fluidbox/invariants.ts --at 4000,4016,9024
replaying 566 events, capturing at 3 point(s): 4000, 4016, 9024
ESP32-S3-Touch-AMOLED-1.8 368x448, 3 frame(s) captured

-- invariants (apps/fluidbox/invariants.ts) --
PASS: all invariants held over 3 captured frame(s)
```

### The band model and the framebuffer model agree pixel for pixel

The two columns above are identical because the frames are. `harness/portdiff.ts`, run between this
port's module and the rp2350 port's module on the same trace:

```
$ bun run portdiff /tmp/fluidbox-esp32.wasm /tmp/fluidbox-rp2350.wasm \
    apps/fluidbox/traces/fluid-settle-shake.trace.json --at 4000,4016,9024
-- module A: ESP32-S3-Touch-AMOLED-1.8 368x448, 3 frame(s) captured
-- module B: RP2350-Touch-AMOLED-1.8 368x448, 3 frame(s) captured

-- comparison (tolerance 0) --
  t=4000ms  MATCH
  t=4016ms  MATCH
  t=9024ms  MATCH

PASS: 3 frame(s) compared
```

That diff is **not** this port's verification (the bundle's is the invariant run above, and the
convention is explicit that an `adaptation` port is checked by stated invariants, not pixel
identity). It is reported here because it says something the invariants alone do not: a fluid
assembled 28 rows at a time out of buffers with undefined prior content, with no framebuffer behind
it, lands on precisely the same pixels as the same fluid painted into one persistent buffer. The
solver is deterministic and both packs' `dtMs` come from the same replayed trace, so this is what
"the drawing changed and nothing else did" looks like when it is true.

## Red before green

Per `docs/convention/publishing.md`: a check that cannot be made to fail is not a check.
`GRAVITY_GAIN` was set from `2.2f` to `0.0f` in this port's own `fluid.c`, the module rebuilt, and
the real invariant runner (not a standalone script) run against it:

```
$ bun run invariants /tmp/fluidbox-esp32-broken.wasm apps/fluidbox/traces/fluid-settle-shake.trace.json \
    apps/fluidbox/invariants.ts --at 4000,4016,9024
-- invariants (apps/fluidbox/invariants.ts) --
FAIL: 2 invariant(s) failed:
  - flat surface: settled1 (t=4000) bucket-median spread 43px exceeds max 40px
  - flat surface: settled2 (t=9024) bucket-median spread 90px exceeds max 40px
```

The same two failures, at the same two numbers, that the rp2350 port's own red run produced: with
no gravity, nothing pulls a scattered fluid back into a flat pool. `GRAVITY_GAIN` was restored and
the module rebuilt; the result is **byte-identical** (28,564 bytes) to the pre-break build, and the
runner reports `PASS`.

## What is not proven

- **Real silicon.** This pack's chrono port carries a dated `silicon` attestation
  (`apps/chrono/bundle.json`, 2026-08-19, the differential harness against the physical board over
  USB Serial/JTAG). This port carries none, and must not: no build of `apps/fluidbox/` for the
  board exists (the pack's `CMakeLists.txt` compiles `firmware/apps/demo.c`, not this file), so
  nothing has run on the hardware. The comment about the panel running at 50fps is a fact about
  the pack, not about this app.
- **The shake threshold.** Delivered here as a discrete `f->shaken` bit, and the emulator fires it
  from a trace event. The board's own detector reads a QMI8658 magnitude against a threshold that
  the pack's `AGENTS.md` says cannot be tuned by anything automated and has not been tuned by a
  human yet. How hard a real hand has to shake this puck to make the fluid flash white is unknown.
- **Touch stir on glass.** The invariant trace contains no touch events at all (565 ticks, one
  sensor event), so `handle_touch()` is exercised by nothing here, and the board's touch path has
  only ever been driven by devlink injection, never a real finger (the pack's `AGENTS.md`).

## Reproducing the proof

```
ZIG_EXE=C:\Users\sylve\tools\zig\zig.exe bun run packs/esp32-s3-touch-amoled-18/wasm/build.ts \
  --app apps/fluidbox/ports/esp32-s3-touch-amoled-18/fluid.c
cp wasm/dist/emu.wasm /tmp/fluidbox-esp32.wasm
bun run invariants /tmp/fluidbox-esp32.wasm apps/fluidbox/traces/fluid-settle-shake.trace.json \
  apps/fluidbox/invariants.ts --at 4000,4016,9024
```

No `--shake` flag, unlike the other two ports' `buildArgs`: this pack delivers `app_frame_t.shaken`
unconditionally (`runtime_core.c`, no `wants_shake` gate, since there is one app and no drawing
surface an unwanted erase would threaten), so there is nothing to opt into and `bundle.json`'s entry
for this port carries no `buildArgs` at all.

Or simply `bun run verify-bundle apps/fluidbox`, which does the build and the replay itself for all
three ports.
