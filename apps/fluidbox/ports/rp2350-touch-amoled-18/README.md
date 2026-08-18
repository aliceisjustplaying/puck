# Port verdict: rp2350-touch-amoled-18

## Verdict: degraded, mode adaptation, verified by invariants

Comparing `apps/fluidbox/descriptor.md`'s `Demands` against this pack's `device.json`
(`packs/rp2350-touch-amoled-18/device.json`):

| Demand | device.json | Fit |
|---|---|---|
| Continuous per-frame particle solver (donor: 900 particles @ 240MHz dual-core ESP32-S3) | `memory.model = "full-framebuffer"`, single-core RP2350 @ 150MHz Cortex-M33, single-precision FPU | met, at a **much smaller particle count** (see below) |
| Full-screen redraw every frame | full-framebuffer memory model, `gfx_push`/`gfx_push_all` | met |
| A colour panel | `panel.format = "rgb565be"` | met exactly |
| Motion input: gravity vector preferred, shake event minimum | `sensors: [{"id":"shake","kind":"event"}]` - **no continuous gravity-vector ABI call exists**, only a discrete event | **only the minimum is met**, not the preference |
| *(prefers)* 60fps, IMU-driven gravity, 368x448 colour panel | panel is exactly 368x448 rgb565be; no continuous IMU surface; fps unproven (see Honesty below) | panel matches exactly, gravity does not, fps is asserted plausible, not proven |

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
| | | **IMU tilt steering**: gravity is fixed straight down, never derived from device orientation |

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

## The missing ABI call is a pack limitation, not a board one

The RP2350-Touch-AMOLED-1.8 **has** a QMI8658 IMU on real hardware
(`packs/rp2350-touch-amoled-18/AGENTS.md`'s board table lists it). What this port cannot do is a
consequence of the *current emulator ABI this pack's `device.json` declares* - one `shake` sensor,
`kind: "event"` - not of the silicon. `wasm/emu_abi.h` has no call analogous to `emu_touch()` that
hands a continuous vector into the app's per-frame input; the closest existing shape,
`emu_sensor_event(index)`, is a one-shot event by design (see its own comment: "Sensor events
declared with `kind: "event"`, by index into the sensors array"). Adding a continuous
`kind: "vector"` sensor (a per-tick 2 or 3-float gravity direction, analogous to how touch already
carries `x`/`y` per frame) is a candidate ABI extension for a future pack revision - **not
attempted here**: this task's own rules forbid touching pack firmware sources or the shared ABI to
make one port easier, and hacking a private, undocumented channel into `emu_shim.c` would be
exactly that. Fixed-down gravity plus a shake event is what the CURRENT device descriptor honestly
supports.

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
