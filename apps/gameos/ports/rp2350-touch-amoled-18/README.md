# Port verdict: rp2350-touch-amoled-18

**SHOW PHASE.** This is a working, runnable port (`gameos_port.c` builds to `wasm/dist/emu.wasm`
and runs in `bun run dev`), not a locked, verified bundle: no `bundle.json`, no `verify-bundle`
run, no red-before-green on anything, per this task's own scope. See "What is NOT done yet"
below before treating anything here as proven.

## Verdict: degraded

Comparing `apps/gameos/descriptor.md`'s `Demands` against this pack's `device.json`
(`packs/rp2350-touch-amoled-18/device.json`):

| Demand | device.json | Fit |
|---|---|---|
| **60fps** | full-framebuffer memory model, single-core RP2350 @ 150MHz Cortex-M33 | **unproven, plausibly not met at the donor's own entity counts** - see "Honesty" below. This is the demand that decides the verdict. |
| Colour panel, >=256-entry palette | `panel.format = "rgb565be"`, true colour | met exactly |
| Single-point touch | `touch.points: 1` | met exactly |
| Continuous gravity/tilt vector | `sensors: [..., {"id":"gravity","kind":"vector"}]`, live on both silicon and the emulator (`firmware/runtime/tilt.c`) | met |
| >=64KB scratch per active game | `memory.model = "full-framebuffer"`, 520KB SRAM | met with wide margin (see "Memory", below) |
| *(prefers)* 8-voice synth, save slot, raw 200Hz accel stream | none of the three exist on this ABI | **not met, and not attempted** - all three are stated show-phase gaps, not silent ones (see the table below) |

One real mismatch decides the verdict, and it is a genuinely interesting one because it is the
**opposite shape** from the ESP32-S3 sibling pack's mismatch (see "A correction" below):

1. **Compute, not memory.** This pack's full-framebuffer model is actually a *good* structural
   fit for `gos.h`'s own contract - direct pixel writes anywhere on the panel, no band-awareness
   needed, exactly what GUNSHIP's spatial-grid entity draws and LUCKY 7's reel-window clip
   rectangles assume. What the donor's own hardware brings that this pack's silicon does not is
   a **second core plus a hardware palette-LUT DMA upscale unit** doing the 184x224-to-368x448
   expansion off the CPU's own critical path. Here, one 150MHz Cortex-M33 core does the game
   logic, the software rasterization (circles, quads, soft blobs, up to 160 zombie entities via
   `gos_grid_query`), the palette lookup, AND the 2x upscale (164,864 output pixels, every
   tick), with nothing overlapped. That is a real, structural budget gap, not a rounding error.

That mismatch is not fatal to the app's identity (a picker handing off to a thermal gunner and a
slot machine, both still fully playable and pixel-correct in the emulator - see the captured
frames), so the verdict is **degraded**, not **refuse**. `mode` is not recorded here (no
`bundle.json` yet - see "What is NOT done yet"), but would be `native`-shaped in spirit: nothing
about GUNSHIP's or LUCKY 7's own interaction surface changed from the donor (same aim mode, same
FIRE cap, same reel-pull gesture with its already-donor-provided touch fallback); only the
launcher is genuinely new (see NOTICE.md).

## A correction to this task's own brief

This task's brief said "rp2350 renders in 16 bands of 20KB" as the reason to expect a degraded
verdict here. That is not this pack: **`packs/rp2350-touch-amoled-18/device.json` declares
`"model": "full-framebuffer"`, 330KB, one contiguous buffer.** The 16-bands-of-20KB, no-
framebuffer-at-all model belongs to this repository's OTHER pack,
`packs/esp32-s3-touch-amoled-18` (`device.json`: `"model": "band", "bands": 16, "bandRows": 28,
"bandBufferKB": 20`) - which, not coincidentally, is the actual chip family
(ESP32-S3) esp32-gameos itself targets. The degraded verdict on THIS pack is real, but for the
opposite reason the brief anticipated: not too little memory for a framebuffer, but too little
compute to fill one fast enough alone. See "esp32-s3-touch-amoled-18", below, for where the
band-memory mismatch this task's brief was describing actually lives.

## Honesty: the emulator cannot prove an fps floor on real silicon

Per this repository's own harness documentation
(`packs/rp2350-touch-amoled-18/AGENTS.md`'s "regression tests" section, `docs/harness.md`'s "What
this catches, and what it cannot"): **the emulator can never answer a timing question.** Nothing
in `emu_tick()` reproduces real cycle counts, real FPU latency, or the real cost of a QSPI panel
push. This port's fps claim is therefore a plausibility argument, not a measurement, and reported
as exactly that - the same honesty standard `apps/fluidbox`'s own rp2350 README already set for
this pack.

**What is real:** every captured frame in `apps/gameos/frames/` (12 frames across the launcher,
GUNSHIP's briefing/play states with a converging tilt reticle and a HUD, and LUCKY 7's idle,
mid-spin motion-blur, and a resolved win with coin particles) rendered correctly, at tolerance
zero against itself, with no arena trap and no `call_indirect` fault, replaying a 528-event, 8.1
second hand-built trace (`apps/gameos/traces/gameos-demo.trace.json`) headlessly via
`harness/emulatorSide.ts`. Nothing crashed. That is real evidence the port is *correct*
(the pixels a healthy run should show, do show), and zero evidence about *fast enough*, which the
emulator's clock (whatever timestamps the trace or the live page hands `emu_tick()`) cannot
speak to at all.

**What is not yet measured, and would decide this verdict for real:** a wall-clock frame time on
the actual board, for both games, at their donor entity counts (GUNSHIP: up to 160 zombies, 12
survivors, 40 shells, 64 scorch marks, 16 flashes, all drawn every tick; LUCKY 7: 56 coin
particles at once during a big win, three reel windows each redrawn with up to 2 motion-blur
ghosts per visible symbol). The honest expectation, reasoned from the sibling `fluidbox` port's
own measured numbers on this exact chip (a much simpler O(n^2) 130-particle physics solver alone
already needed real profiling to land inside a 30fps budget on this core): a full-panel present
pass **alone** costs a fixed, unavoidable 164,864-pixel walk every tick regardless of what either
game draws, before any of GUNSHIP's own per-entity software rasterization. Whether that fits
inside a 16.7ms (60fps) budget on real silicon, at the donor's own entity counts, is genuinely
unknown until measured - which is exactly why this is `degraded`, not a forced `go`.

## Memory

`gs_t` (GUNSHIP's own state, computed field-by-field from `gunship.c`'s own struct, not measured
via a device-side allocator - this port does not route game state through `app_alloc()`/
`APP_ARENA_BYTES` at all, see "Arena" below): roughly **8.5KB**, dominated by the zombie SoA
arrays at `NZ=160` entities. `slots_t` (LUCKY 7's own state): roughly **1.4KB**, dominated by the
56-particle coin-fountain array. Both are static C globals, not a per-launch allocation - see
"Arena", next.

**Arena.** `packs/rp2350-touch-amoled-18/firmware/runtime/app.h`'s `APP_ARENA_BYTES` (64KB) is a
service this pack's `app_alloc()`/`APP_STATE()` offer to an app that wants its state reclaimed on
a real puck-level app switch. This port never performs one (it is a single puck app slot doing
its own internal launcher/GUNSHIP/LUCKY-7 dispatch - see `gameos_port.c`'s own header comment),
so it does not use `app_alloc()` at all: both games' state are plain `static` globals, zeroed by
hand on every (re)launch to reproduce the donor's own "launching is a fresh `calloc`" contract
(`docs/game-contract.md`) without a real per-launch allocator underneath. Memory is therefore not
the constraint anywhere in this port - see "Compute, not memory" above for the one that is.

## What is kept, what is adapted, what is genuinely gone

| | Kept | Adapted | Gone |
|---|---|---|---|
| **GUNSHIP's aim** | the donor's own default mode (`GOS_AIM_TILT_ABS`), the exact one-euro filter and pow-1.4 response curve, the same constants | pose SOURCE: this ABI's filtered gravity vector (`app_frame_t.tilt`), reconstructed to pitch/roll via `atan2f`, instead of the donor's own QMI8658-fused pitch/roll | `GOS_AIM_GYRO_RATE` (no gyro on this ABI at all) and `GOS_AIM_TOUCH_DRAG` (not wired - TILT_ABS only) |
| **LUCKY 7's pull** | the donor's own touch-drag fallback, unchanged: press, drag down past a threshold, release triggers the spin at a strength proportional to the drag | - | the accelerometer "yank" gesture (needs a raw ~200Hz sample stream this ABI does not publish - see descriptor.md's Demands) |
| **Both games' escape** | the donor's own top-edge swipe-down gesture, exact thresholds | destination: the launcher, not a pause overlay (this port has none) | the donor's own in-game EXIT chip (`gos_request_exit()` is a no-op here) and the BOOT-button pause path |
| **The launcher** | - | a new, small picker against the same `gos.h` primitives | the donor's own Wii-menu shell: settings, a pause overlay, first-run tilt calibration (694+266 lines not attempted this show phase) |
| **Sound, save** | - | - | both: silent, no persistence (stated gaps, see descriptor.md) |

## Reproducing this show phase

```
ZIG_EXE=<path to zig.exe> bun run packs/rp2350-touch-amoled-18/wasm/build.ts --app apps/gameos/ports/rp2350-touch-amoled-18/gameos_port.c
bun run dev   # http://127.0.0.1:5340 - launcher navigable, both games playable
```

The 12 captured frames in `apps/gameos/frames/` and the trace at
`apps/gameos/traces/gameos-demo.trace.json` were produced by replaying that same trace headlessly
through `harness/emulatorSide.ts` (the mechanism `harness/portdiff.ts --write-frames` already
uses against a bundle's own module - see `docs/harness.md`), at the capture points:

- launcher: t=16, 48, 80 (fresh boot), t=2316 (returned from GUNSHIP, before launching LUCKY 7)
- GUNSHIP: t=192 (briefing), t=304 (mission just started), t=700 (tilt-aimed, firing held),
  t=1500 (wave in progress, an entity and the reticle both on screen)
- LUCKY 7: t=2460 (idle), t=3212 (mid-spin, motion-blur ghosts), t=4396 (a reel landed, BAR/BAR
  near-miss visible), t=7004 (resolved: a $5 win, coin particles mid-fountain)

## What is NOT done yet (this task's own stop point)

Per this task's scope: no `bundle.json`, no `verify-bundle` run, no red-before-green invariant
proof, no silicon attestation, and no registry entry. `apps/gameos/gen_trace.ts` and
`apps/gameos/capture_frames.ts` (the two throwaway scripts that produced the trace and the
frames above) are deliberately not part of this bundle and were not committed - only their
output (the trace, the frames) is. The lock phase (schema-0.2 `bundle.json`, a real
`bun run verify-bundle apps/gameos` pass, and - separately - the esp32-s3 and web ports this
README's verdicts below only reason about, not build) comes after this show phase is reviewed.

## The other two packs (reasoned, not built, this session)

- **esp32-s3-touch-amoled-18: degraded.** This is the chip family (ESP32-S3) esp32-gameos itself
  targets - compute is not the concern the way it is on the RP2350 sibling (see "A correction",
  above). The mismatch here is architectural: this puck pack's own contract is **16 bands of 20KB,
  double-buffered, `draw_band()` callback, no framebuffer anywhere** (`packs/esp32-s3-touch-amoled-18/
  AGENTS.md`'s "THE MEMORY MODEL" section), while `gos.h`'s whole pipeline assumes one contiguous,
  randomly-addressable off-screen buffer (GUNSHIP's spatial-grid queries and LUCKY 7's reel-window
  clip rectangles both draw wherever their own state says to, with no notion of which band that
  falls in). Porting for real means either re-deriving every draw call to be band-clipped and
  replayed 16 times a tick, or keeping a full shadow buffer and blitting it band-by-band at flush
  (which defeats the low-SRAM point of that pack's whole design). Feasible, not attempted here;
  ESP-IDF is also not installed on this machine, so even a native build is blocked independently
  of this question. Not `refuse`: nothing about GUNSHIP's or LUCKY 7's own identity conflicts with
  a band renderer, the cost is architectural adaptation work, not a fundamental mismatch.
- **web: go.** `packs/web` adopts `packs/rp2350-touch-amoled-18`'s `app.h`/`gfx.h` contract
  symbol-for-symbol, vendored (`packs/web/NOTICE.md`), including the same full-framebuffer
  `gfx_fb` pointer and the same `PANEL_W`/`PANEL_H`. This port's own `gameos_port.c` and
  `gos_runtime.c` use nothing outside that shared contract (no `app_alloc()`, no landscape
  helpers, no rp2350-specific symbol), so the same source should compile against `packs/web`
  unedited via `bun run pack:web:build -- --app apps/gameos/ports/rp2350-touch-amoled-18/gameos_port.c`
  - the same "one port file, two packs" result `apps/fluidbox/ports/web/fluid.c` already
  demonstrates for that bundle. Not attempted this session (out of this task's stated scope), and
  the compute concern that produced `degraded` on the RP2350 pack does not apply here: a browser's
  JS/wasm engine has orders of magnitude more headroom than a 150MHz embedded core for the same
  software rasterization workload.
