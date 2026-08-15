# 0007: Battery state is a latched input

Date: 2026-08-15
Status: accepted

## Context

Puck's deterministic boundary is an ordered sequence of input calls and ticks.
`wasm/emu_abi.h` says that `emu_tick(nowMs)` is the guest's only clock and that
the host must never deliver an input the hardware cannot produce.
`src/recorder.ts` records touch, button, verdict, sensor, and tick events, while
`src/replay.ts` and `src/replayCore.ts` issue those calls again in order.
Battery state belongs on that boundary: firmware can branch on charge level or
external power just as it can branch on touch state.

Battery is not a reason to simulate more of the physical device. The ABI header
already excludes display brightness and physical panel behavior from what is
real (`wasm/emu_abi.h`, "WHAT IS REAL, AND WHAT IS NOT"), and decision
[0003](0003-differential-testing-not-cycle-accurate-emulation.md) rejects a
progression toward peripheral or timing simulation.

## Decision

### Optional battery input

A device with a battery declares this descriptor field:

```json
{ "battery": true }
```

It also exports one optional function:

```c
void emu_battery(int percent, int charging, int external);
```

`percent` is an integer from 0 through 100. `-1` means that no battery reading
is present. `charging` and `external` are boolean levels represented as 0 or 1.
`external` says that external power is present; it remains distinct from
`charging` because a full or charge-inhibited device can have external power
without actively charging.

The call is latched until the next `emu_tick()`, exactly like `emu_touch()`.
`emu_battery()` records pending state inside the guest and does not update
application state, draw, or push a rectangle directly. The next tick consumes
that state through the same firmware-owned reducer used by the hardware build.
This preserves the input-latching pattern documented for `emu_touch()` in
`docs/abi.md` and exercised by the consumer adapter at
`/Users/sarah/src/tries/2026-08-09-espdraw-puck/puck/puck_abi.cpp`
(`pending_touch` and `emu_tick`).

The optional group has one member, but descriptor and export still agree in
both directions. `scripts/audit.ts` must fail when `battery: true` is declared
without `emu_battery`, and when `emu_battery` is exported without
`battery: true`. This is the same cross-check already applied to the descriptor
`apps` array and `OPTIONAL_APP_EXPORT_NAMES` in `scripts/audit.ts`. The
canonical name belongs in `src/abiSurface.ts`, and the optional function type
and descriptor validation belong in `src/wasm.ts`.

### Page chrome

The interactive page shows a battery slider and a charging toggle only when
`battery: true` is present. A device that omits the field gets no empty battery
section and no calls to `emu_battery`, matching the descriptor-driven chrome
already built for buttons, touch, sensors, gestures, and apps in `src/main.ts`.

The slider covers `-1` through `100` and labels `-1` as absent. For the simple
interactive charging toggle, off sends `charging=0, external=0` and on sends
`charging=1, external=1`. The ABI and trace retain the separate `external`
field so hand-built traces and hardware links can represent external power
without active charging. Each control change records and latches one complete
battery event. Replay suppresses live controls, as it already suppresses live
panel input in `src/main.ts`.

### Trace schema 3 and dual reading

A recorded event has this shape:

```json
{
  "t": 1250,
  "k": "battery",
  "percent": 74,
  "charging": 1,
  "external": 1
}
```

Adding an event kind evolves the trace to schema 3. New recordings always
write schema 3. Readers accept schema 2 and schema 3: schema 2 means there are
no battery events, so the guest's initialized battery state remains untouched.
Readers do not rewrite an old trace in place and do not invent an initial
battery value for it. Schema 1 remains rejected because, as
`src/recorder.ts` records, it could silently lose the fresh-boot prefix before
trace truncation became explicit.

The schema change crosses every place that writes, embeds, validates, or
replays `TraceEvent`:

- `src/recorder.ts` adds the battery union member, writes schema 3, and defines
  the accepted schema 2 and schema 3 trace shapes.
- `src/main.ts` records control changes, describes battery as the last input
  after a crash, and replaces its schema-2-only file gate with the dual
  reader.
- `src/replay.ts` accepts schema 2 or 3 and dispatches battery events before
  the following tick.
- `src/replayCore.ts` adds the trace schema to `replayFromBytes`'s signature.
  Passing only a bare event array is no longer enough to distinguish an old
  schema-2 run from schema 3. Its event switch dispatches `emu_battery` and
  fails clearly if the trace asks for battery but the module does not export
  it.
- `src/regression.ts` stores the trace schema with a baseline, passes it into
  replay core, and dual-reads existing baseline bundles as schema 2. Its disk
  shape in `baselineStore.ts` changes with it.
- `src/freeze.ts` bumps the freeze schema and identifies the embedded input as
  trace schema 3. A freeze is not itself a replayable trace, but its `input`
  and dead-engine `lastInputEvent` use the same union and must not leave a
  battery event ambiguous.
- `harness/diff.ts` accepts trace schema 2 and 3 and passes the schema through
  both replay sides. `harness/types.ts`, `harness/hardwareSide.ts`, and each
  `HardwareLink` switch either deliver the new event or reject it explicitly.
  The current concrete switches are in `harness/fixtures/loopbackLink.ts` and
  `harness/links/devlinkLink.ts`.
- `test/hostile/run.ts` updates freeze-schema checks and adds coverage that
  malformed battery descriptors, mismatched exports, invalid event values,
  and schema rejection fail loudly. Focused firmware fixtures remain under
  `test/hostile/firmware/`.

The in-page regression buttons reach `src/replayCore.ts` through
`src/regression.ts`, while the harness reaches it through
`harness/emulatorSide.ts`. Keeping the schema argument on that shared core is
what prevents those two replay paths from interpreting battery differently.
The hand-built traces in `test/regression/run.ts` and `harness/selftest.ts` can
remain schema-2 fixtures when their purpose does not involve battery, which is
an executable check of the dual reader rather than a forced artifact rewrite.

Battery values are validated at the reader boundary: percent is an integer in
`[-1, 100]`, and the two flags are exactly 0 or 1. A schema-2 trace containing
a battery event is malformed, not a schema extension to guess at. A schema-3
battery event against a device that neither declares nor exports battery also
fails rather than being silently dropped.

### What is deliberately not simulated

- **No dimming simulation.** Browser CSS opacity or altered framebuffer reads
  would imitate an output that the firmware did not draw. It would also exceed
  the ABI header's explicit statement that display brightness is not real in
  this emulator (`wasm/emu_abi.h`). Firmware may react to battery input by
  drawing its own low-battery UI, and that real application behavior remains
  visible.
- **No sleep simulation.** Suspending ticks or inventing wake behavior would
  add power-management timing and lifecycle semantics that differ by board.
  Decision [0003](0003-differential-testing-not-cycle-accurate-emulation.md)
  keeps those timing questions on hardware.
- **No voltage input.** A synthetic voltage curve would ask the browser to
  reproduce a PMIC, ADC, battery chemistry, calibration, and load behavior it
  does not have. The host supplies only the firmware-level state the hardware
  integration can honestly produce.
- **No wall-clock coupling.** Charge does not drift as browser time passes and
  external power does not alter `emu_tick()` pacing. `wasm/emu_abi.h` makes
  host-provided `nowMs` the only clock specifically so traces remain
  deterministic.

These exclusions apply the ABI header's load-bearing honesty rule: the
emulator must never provide capabilities or behavior the actual hardware
cannot produce. A battery input exercises real firmware decisions. A browser
model of battery physics or power management would be a second implementation
with a fidelity claim Puck cannot support.

### Consumer impact

TinyDraw's
`/Users/sarah/src/tries/2026-08-09-espdraw-puck/puck/verify.mjs` compares the
compiled module against an exact export list, not a permissive subset. It will
add `emu_battery` to `abiExports` when TinyDraw adopts the optional battery
input. Puck does not weaken that consumer-side pin and does not require the
symbol before the consumer declares `battery: true`.

## Implementation inventory

Implementing this decision touches the following repository files:

- `wasm/emu_abi.h`
- `docs/abi.md`
- `src/abiSurface.ts`
- `src/wasm.ts`
- `src/recorder.ts`
- `src/main.ts`
- `src/replay.ts`
- `src/replayCore.ts`
- `src/regression.ts`
- `src/freeze.ts`
- `src/index.html`
- `src/app.css`
- `baselineStore.ts`
- `docs/agent-loop.md`
- `harness/types.ts`
- `harness/diff.ts`
- `harness/emulatorSide.ts`
- `harness/hardwareSide.ts`
- `harness/fixtures/loopbackLink.ts`
- `harness/links/devlinkLink.ts`
- `harness/selftest.ts`
- `scripts/audit.ts`
- `scripts/verify.ts`
- `test/regression/run.ts`
- `test/hostile/build.ts`
- `test/hostile/run.ts`
- new focused fixtures under `test/hostile/firmware/`

A firmware adopts the input separately by declaring battery and exporting the
function from its own wasm adapter. TinyDraw's adoption will touch
`/Users/sarah/src/tries/2026-08-09-espdraw-puck/puck/puck_abi.cpp` and
`/Users/sarah/src/tries/2026-08-09-espdraw-puck/puck/verify.mjs`. The root
example can continue omitting the optional input, just as it currently omits
the optional apps and sound groups (`example/firmware/main.c`).

## Consequences

Battery-dependent application behavior becomes deterministic and replayable.
Old schema-2 traces remain valid without acquiring invented battery state.
Descriptor-driven chrome stays absent for devices without a battery. Puck
gains no claim about voltage, battery life, display dimming, sleep, wake, or
power-management timing.
