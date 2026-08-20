# Port verdict: rp2350-touch-amoled-18

## Verdict: degraded, mode adaptation, verified by invariants

Comparing `apps/fluidbox/descriptor.md`'s `Demands` against this pack's `device.json`
(`packs/rp2350-touch-amoled-18/device.json`):

| Demand | device.json | Fit |
|---|---|---|
| Continuous per-frame particle solver (donor: 900 particles @ 240MHz dual-core ESP32-S3) | `memory.model = "full-framebuffer"`, single-core RP2350 @ 150MHz Cortex-M33, single-precision FPU | met, at a **much smaller particle count** (see below) |
| Full-screen redraw every frame | full-framebuffer memory model, `gfx_push`/`gfx_push_all` | met |
| A colour panel | `panel.format = "rgb565be"` | met exactly |
| Motion input: gravity vector preferred, shake event minimum | `sensors: [{"id":"shake","kind":"event"},{"id":"tilt","kind":"vector"}]` - a continuous gravity-vector ABI call now exists (`emu_sensor_vector`, `wasm/emu_abi.h`) | **met, in the emulator**; real hardware still only has the shake event (see "The missing ABI call" below for exactly what changed and what did not) |
| *(prefers)* 60fps, IMU-driven gravity, 368x448 colour panel | panel is exactly 368x448 rgb565be; the emulator's rotation control now drives a continuous tilt vector; fps unproven (see Honesty below) | panel matches exactly, gravity follows tilt IN THE EMULATOR ONLY, fps is asserted plausible, not proven |

Two real mismatches decide the verdict:

1. **Compute.** 150MHz single-core Cortex-M33 with a single-precision FPU is a fraction of a
   240MHz dual-core Xtensa LX7 running the solver on its own core while rendering runs on the
   other. There is no second core here to hide the physics behind - render and physics share one
   tick, one core, one budget.
2. **Sensor surface.** This pack's `device.json` declares exactly one sensor, `shake`, `kind:
   "event"` - a discrete signal the emulator ABI fires once per shake, not a per-frame
   accelerometer vector. There is no ABI call in `wasm/emu_abi.h` that hands an app a continuous
   gravity direction. The Demand explicitly allows this ("a discrete shake event is the minimum"),
   so the port is not refused, but it cannot deliver the *preferred* tilt-driven gravity either.

Neither mismatch is fatal to the app's identity (a fluid that slosh and settles, agitated by
motion), so the verdict is **degraded**, not **refuse**. The interaction surface changes (gravity
becomes fixed rather than tilt-driven, and this pack's touch controller - unused by the donor -
becomes a stirring input instead), so the mode is **adaptation**, and verification is
**invariants** rather than pixel-exact frame diffs, per `docs/convention/app-bundle.md`.

## What is kept, what is lost

| | Kept | Lost |
|---|---|---|
| **Fluid character** | Clavet double density relaxation, unchanged formulas (density/near-density, signed pressure, viscosity fused into the density pass, position-based so it cannot explode under a hard shake); same `REST_SPACING`/`SMOOTH_RADIUS` this panel's own ppi already validated for the donor | The third dimension - no depth, no perspective, no depth-darkening or size falloff |
| **Settle behaviour** | The fluid pools against a rounded-rectangle wall (the same first-stage wall projection the donor's `resolve_walls()` uses, one stage instead of two - see "2D, not 3D" below) and visibly flattens at rest | The donor's own settled speed/`rho` tuning does not carry over as numbers (different box, different particle count); this port's constants were re-tuned empirically against its own invariant checks, not copied |
| **Shake response** | A visible burst - particles spray outward and read whiter/faster, then settle back | Continuous IMU shake (a magnitude that scales with how hard the board is actually shaken); this port gets one fixed-magnitude impulse per discrete event, however hard or soft the real shake was |
| | | **Particle count**: 130 vs the donor's 900 (~14%) |
| | | **fps**: unproven on real silicon (see Honesty) vs the donor's measured ~90fps display / ~38 steps/s |
| | | **IMU tilt steering on real hardware**: still fixed straight down - see "The missing ABI call", below, for what changed (the emulator) and what did not (the board) |

What is *gained*, not merely lost-and-kept: this pack has touch (`device.json`'s `touch.points:
1`), which the donor board also has but never reads (`descriptor.md`'s Interactions: "the donor
never reads its touch controller"). This port wires a finger drag to locally stir the fluid - an
interaction the donor's own hardware could have supported but its firmware never implemented.

## 2D, not 3D - a deliberate simplification, not a shortcut

The task brief itself prefers 2D over a fake 3D on a reduced particle budget, and the numbers back
that up independently: at FLUID_N=130 there simply are not enough particles to read as a
volumetric body once spread across a third dimension - the donor's own 900 particles already only
fill "about a third" of its box's volume (`fluidbox/README.md`). Concretely, this port:

- Drops the `z` axis and the donor's second wall-projection stage (the depth fillets where a
  corner rounds into the back panel) entirely - `resolve_walls()` here is exactly the donor's own
  first stage (`sim.c`'s `resolve_walls()`, the `(x, y)` clamp-to-rounded-rect), with nothing
  bolted on to fake depth.
- Draws every particle as a small flat square rather than a projected, depth-shaded, size-falloff
  disc. No perspective, no depth LUT, no highlight discs - none of it would read correctly with
  no depth data behind it, and faking depth cues on a 2D solver would be exactly the "fake 3D" the
  task brief warns against.
- Keeps `REST_SPACING`/`SMOOTH_RADIUS` (panel-scale properties) and every stiffness/viscosity/wall
  constant at the donor's own values, since the *local* physics of a pair of neighbours does not
  care how many dimensions the box has - only the box's own shape (now a rounded rectangle, not a
  rounded box) and the particle count changed.

## Neighbour search: O(n^2), not the donor's grid

The donor's uniform grid (`sim.c`'s `GRID_CX/CY/CZ`, counting-sort rebuild, cached pair list)
exists because 900 particles naively is 810,000 pairs a frame. At `FLUID_N=130` a full pairwise
scan is `130*129/2 = 8,385` pairs, done twice a step (density+viscosity, then relaxation) for
16,770 pair evaluations total - cheaper outright than building and walking a grid at this size,
and it removes an entire subsystem (cell indexing, counting sort, pair caching, the per-particle
memory reorder pass) that has no payoff below a few hundred particles. This is a genuine
simplification the reduced particle count buys, documented here rather than left implicit.

## Arena budget

`packs/rp2350-touch-amoled-18/firmware/runtime/app.h` sets `APP_ARENA_BYTES` to 65536 (64KB). This
port's state (`fluid_state_t` in `fluid.c`: 12 `float[FLUID_N]` arrays plus a handful of scalars)
is `12 * 130 * 4 + ~16 ~= 6,256` bytes, under 10% of the budget - the particle count never needed
reducing to fit the arena; the binding constraint throughout was compute (see the honesty section
below), not memory.

## Panel push: bounding box, not full panel every tick (silicon finding, 2026-08-20)

Flashed onto a real RP2350-Touch-AMOLED-1.8: the emulator's own simulation "purred" correctly,
but the physical panel visibly shimmered/flickered while the fluid ran. The task brief's working
hypothesis going in was the family of bug this pack's own `docs/decisions/0001-push-min-width.md`
already names - many small per-particle `gfx_push` calls, each its own QSPI/DMA transaction - so
that was checked FIRST, empirically, before touching anything: `wasm/emu_abi.h`'s
`emu_push_count()`/`emu_push_x/y/w/h()` ABI lets any wasm build report exactly what it pushed, per
tick, with no bus involved. Measured over the full `apps/fluidbox/traces/fluid-settle-shake.trace.json`
window (settle ~4s, shake, settle ~5s more, 593 ticks at 16ms):

| | pushes/tick (min/mean/max) | pushed pixels/tick (min/mean/max) |
|---|---|---|
| Pre-fix (this port, unmodified) | 1 / 1.00 / 1 | 164,864 / 164,864 / 164,864 (100% of the panel, every tick) |
| Post-fix (bounding-box push) | 1 / 1.00 / 1 | 21,344 / 25,569 / 40,832 (13-25% of the panel) |

**The hypothesis was wrong for this file.** `port_tick()` already issued exactly one `gfx_push`
call per tick, not many - there was never a per-particle erase+draw push here. What was real,
though not what was first suspected: that one push covered the *whole* 368x448 panel
unconditionally, every tick, at up to 60 ticks/s. `gfx.c`'s `gfx_push_all()` prices a full-panel
push at ~12ms on real hardware (this README's own honesty section, below, already flagged this as
"the real constraint most likely to bite"), so this app was driving the QSPI bus at close to that
duty cycle *continuously* for as long as it runs - a load pattern no other app on this pack
reaches (`chrono`/`timer`/`sketch` push small dirty rectangles only on discrete events, not every
tick). That is the same electrical territory `firmware/lib/QSPI_PIO/qspi.pio`'s clock-halving
comment documents (signal integrity failing under load at the vendor's original clock), just
reached by sustained duty cycle instead of a single wide window.

**The fix**: `port_tick()` now tracks the bounding box of wherever a particle is drawn (see
`fluid.c`'s `particles_bbox()`), unions it with wherever a particle was drawn *last* tick
(`fluid_state_t`'s new `lastMinX/Y/MaxX/Y`, updated at the end of every tick, seeded once in
`port_enter()`), clears and redraws only that rectangle instead of the full panel, and pushes
exactly that rectangle. Still one `gfx_push` call - transaction count did not change, because it
was already 1 - but the DATA VOLUME of that one push dropped by roughly 75-87% depending on how
spread out the fluid currently is. **Transactions are not the axis that moved; bytes per push,
and therefore how long the bus stays continuously driven, is** - see
`packs/rp2350-touch-amoled-18/gotchas.md`'s "many small pushes" entry for why that is the
panel-visible cost, not pixel count and not transaction count in isolation.

The union (not just the new frame's positions) matters for correctness, not just efficiency: a
particle's old square has to be erased wherever it no longer is, and the one tick right after a
PWR reset (`seed_block()` jumps every particle instantly, with no gradual old-to-new path a
bounding box could otherwise infer) is exactly why `lastMinX/Y/MaxX/Y` is carried as real state
rather than derived from `oldx/oldy` each tick.

**Why the emulator could not have caught this on its own**, and did not need to: every invariant
and portdiff check in this repository reads the framebuffer directly
(`harness/emulatorSide.ts` -> `src/replayCore.ts`'s `emu_fb()` read), never through `gfx_push` -
see `docs/harness.md`'s "Does not see bus-load artifacts" paragraph. Re-running
`apps/fluidbox/invariants.ts` against the post-fix module at the same three capture points
(`--at 4000,4016,9024`) still reports `PASS: all invariants held over 3 captured frame(s)`, byte
for byte the same as before this change, which is exactly what should happen: nothing about the
fluid's own physics or drawn pixels moved, only how much of the panel gets sent to the display
controller each tick. This is precisely why the physical shimmer needed a human looking at real
silicon to be found at all, and why fixing it needed measuring against the emulator's push-count
ABI rather than guessing.

## Honesty: the emulator cannot prove an fps floor on real silicon

Per this project's own harness documentation (`packs/rp2350-touch-amoled-18/AGENTS.md`'s
"regression tests" section): **the emulator can never answer a timing question.** Nothing in
`wasm/emu_tick()` reproduces real cycle counts, real FPU latency, or the real cost of a QSPI panel
push. This port's fps claim is therefore a *plausibility argument from an op count*, not a proof,
and is reported as exactly that.

**Per-tick op count**, real hardware, `FLUID_N=130`:

- Density + viscosity pass: 8,385 pairs, each with one `sqrtf`, one reciprocal, and roughly 12-15
  multiply/adds (the kernel weight, the viscosity impulse, both particles' accumulators) - call it
  ~17 floating-point operations per pair.
- Relaxation pass: another 8,385 pairs at the same cost.
- Total: `16,770 pairs * ~17 flops ~= 285,000` floating-point operations per physics step, plus
  `O(FLUID_N)` overhead (integration, wall resolution, the draw loop) that is small next to the
  pairwise cost.

At a **30 steps/s** target, that is `285,000 * 30 ~= 8.6M FLOP/s`. The RP2350's Cortex-M33 core
runs at 150MHz with a single-precision hardware FPU (`packs/rp2350-touch-amoled-18/AGENTS.md`'s
own board table); even a conservative assumption of several cycles per pairwise operation (the
`sqrtf` alone costs more than one cycle on real hardware, unlike the emulator's host-`sqrtf`
import) leaves `8.6M` operations comfortably under `150M` cycles/s - roughly 6-15% of the raw
cycle budget depending how pessimistically the per-op cost is estimated, before subtracting
render and the panel push. That is the honest version of the claim this README can make: **the
solver's own arithmetic is cheap enough that 130 particles at 30fps is plausible**, not that it is
proven. The real constraint most likely to bite is not the solver at all but the **panel push**:
`AGENTS.md` measures a full-panel push at ~12ms on real hardware, which alone is over a third of a
33ms (30fps) frame budget, before any physics or drawing happens. A real-hardware check is
deferred - this is exactly the class of question `AGENTS.md`'s own regression-test section says
the emulator cannot answer, not a gap specific to this port.

## The missing ABI call: landed in the emulator, still open on the board

The RP2350-Touch-AMOLED-1.8 **has** a QMI8658 IMU on real hardware
(`packs/rp2350-touch-amoled-18/AGENTS.md`'s board table lists it). The candidate extension this
README used to describe as "not attempted here" has landed, generically, in the shared instrument:
`wasm/emu_abi.h` now declares an OPTIONAL `emu_sensor_vector(int index, float x, float y, float z)`
export for any sensor declared `"kind": "vector"`, and this pack's `device.json` / `emu_device()`
now declares one, `{"id":"tilt","kind":"vector"}`, alongside the existing `shake` event. The host
(`src/main.ts`) drives it from the SAME rotation control that already remaps touch coordinates:
rotating the on-screen view is physically rotating the device, so the emulator now sends a gravity
reading that keeps "down" reading correctly in all four quick-rotate positions (`src/rotate.ts`'s
`gravityForQuickDeg`). This app's own gravity direction now follows that reading (see
`update_gravity_direction()` in `fluid.c`), falling back to fixed straight down when the reading is
near zero - which is exactly what a pre-tilt trace, or a build that never received one, reads back
as, so nothing about the existing invariant trace's behaviour changed (see "Invariant thresholds"
below).

**What did NOT change: real hardware.** `wasm/emu_abi.h` is the shared instrument's contract, but
`app_frame_t` (`firmware/runtime/app.h`) and the QMI8658 read (`firmware/runtime/sensors.c`) are
pack FIRMWARE - real code that ships to real silicon - and this task's own rules forbid editing
pack firmware sources. So this port's tilt reading is wired through a private, non-ABI accessor
local to this one `--app` build (`emu_shim_tilt_get()`, declared in
`packs/rp2350-touch-amoled-18/wasm/emu_shim.c`'s own "tilt" section, called directly by `fluid.c`
via its own `extern` declaration - valid only because `wasm/build.ts`'s `--app` flag always compiles
this file alongside that exact shim), NOT through `app_frame_t`, which gets no new field here. A
build of this port for real hardware does not exist today (CMakeLists.txt never compiles
`apps/fluidbox/`), so this gap is theoretical rather than a live inconsistency, but it is worth
stating plainly: **tilt-driven gravity works in the emulator only.** Wiring it for real silicon
would mean adding a `tiltX/Y/Z` field to `app_frame_t` and a low-pass-filtered QMI8658 read to
`sensors.c` (reusing the same accelerometer burst `imu_poll_core1()` already takes for shake
detection) - a firmware change, out of scope for an app port, left for whoever next touches that
pack's own `firmware/runtime/`.

## Invariant thresholds, and why

Verified in `apps/fluidbox/invariants.ts` against `apps/fluidbox/traces/fluid-settle-shake.trace.json`
(boot, settle ~4s, shake, settle ~5s more; three captures: `settled1` t=4000, `afterShake`
t=4016, `settled2` t=9024). All four thresholds were picked by running the actual harness against
this port's own `FLUID_N=130` build, not derived from the donor's very different numbers:

| # | Invariant | Threshold | Measured (healthy) | Measured (broken, see below) |
|---|---|---|---|---|
| 1 | Mass proxy stable | non-bg pixel count varies < **5%** between `settled1`/`settled2` | 6352 -> 6350 (0.03%) | 6370 -> 6370 (0%, not this invariant's failure mode) |
| 2 | Settled surface roughly flat | bucket-median top-row spread < **40px** (10 bins, corner-margin columns excluded), checked on both settled captures | 20-27px | **43px / 90px** |
| 3 | Shake visibly agitates | `settled1` vs `afterShake` differ by > **1500px** | 4976px | 7574px (not this invariant's failure mode either) |
| 4 | Inside panel bounds | outermost 1px border is pure background, every capture | clean | clean |

**Why bucket-median, not raw per-column min/max, for flatness.** Fluid is drawn as discrete
7x7px squares with real gaps between them (only 130 particles over a wide box) - a raw per-column
"first non-background row" is dominated by columns that happen to fall between two particles and
read as "almost no fluid here," which measured 54-60px of spread even on a genuinely flat, settled
pool. Binning the center columns (excluding the rounded-corner margin, where a puddle in a rounded
box legitimately climbs higher - real geometry, not sloshing) and taking each bin's *median*
before comparing spreads removes that discretization noise and leaves the actual surface shape;
see `apps/fluidbox/invariants.ts`'s own comment for the full derivation.

## Red before green

Per this task's own instruction, gravity was temporarily broken (`GRAVITY_GAIN` in `fluid.c` set
from `2.2f` to `0.0f`) and the *real* invariant runner - not a standalone script - was run against
the rebuilt module:

```
$ bun run invariants /tmp/fluid-broken-gravity.wasm apps/fluidbox/traces/fluid-settle-shake.trace.json apps/fluidbox/invariants.ts --at 4000,4016,9024
...
-- invariants (apps/fluidbox/invariants.ts) --
FAIL: 2 invariant(s) failed:
  - flat surface: settled1 (t=4000) bucket-median spread 43px exceeds max 40px
  - flat surface: settled2 (t=9024) bucket-median spread 90px exceeds max 40px
```

Without gravity, particles keep whatever the shake (or the initial near-relaxed seed) left them
at - nothing pulls the fluid back down into a flat pool, so the flat-surface check on `settled2`
(the more telling of the two: no gravity, no reason for a scattered fluid to ever re-pool)
correctly goes red. `GRAVITY_GAIN` was then restored to `2.2f` and the module rebuilt; the
resulting `emu.wasm` is byte-identical (64399 bytes) to the pre-break build, and the invariant
runner reports:

```
$ bun run invariants /tmp/fluid-final.wasm apps/fluidbox/traces/fluid-settle-shake.trace.json apps/fluidbox/invariants.ts --at 4000,4016,9024
...
-- invariants (apps/fluidbox/invariants.ts) --
PASS: all invariants held over 3 captured frame(s)
```

## Reproducing the proof

```
ZIG_EXE=C:\Users\sylve\tools\zig\zig.exe bun run packs/rp2350-touch-amoled-18/wasm/build.ts --app apps/fluidbox/ports/rp2350-touch-amoled-18/fluid.c --shake
cp wasm/dist/emu.wasm /tmp/fluidbox.wasm
bun run invariants /tmp/fluidbox.wasm apps/fluidbox/traces/fluid-settle-shake.trace.json apps/fluidbox/invariants.ts --at 4000,4016,9024
cp /tmp/fluidbox.wasm /tmp/fluidbox-b.wasm
bun run portdiff /tmp/fluidbox.wasm /tmp/fluidbox-b.wasm apps/fluidbox/traces/fluid-settle-shake.trace.json --at 4000,4016,9024 --write-frames apps/fluidbox/frames
```

The `portdiff` step is not this bundle's verification (that is the `invariants` run above); it is
how `apps/fluidbox/frames/` gets its PNGs, reusing `portdiff --write-frames`'s existing "module A's
frames become the bundle's recorded frames" behaviour against the same module diffed with itself
(always a pixel-exact MATCH), rather than inventing a second frame-writing tool.

`--app`/`--shake`/`--landscape` are the additive flags this task added to
`packs/rp2350-touch-amoled-18/wasm/build.ts`; running the same script with no flags still produces
the full three-app firmware with its menu, unchanged (`bun run pack:build`).
