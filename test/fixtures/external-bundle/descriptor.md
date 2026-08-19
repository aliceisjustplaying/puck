# external-fixture

A test fixture's app descriptor, written to the same three-section shape
every real bundle uses (`docs/convention/app-bundle.md`). The app itself
lives in `test/fixtures/external-app/`, which stands in for a repository
that is not puck.

## Essence

A 32x32 panel, near-black. One orange 6x6 square travels left to right
along a single row, one cell per 100ms, wrapping at the right edge. The
whole panel is repainted every tick; there is nothing else on screen.

## Interactions

- A touch anywhere moves the square's row so the square is centred on the
  touched y, clamped to the panel. (intent: the one input this fixture
  has, so a trace with input in it produces different frames from one
  without, and a recorded frame proves the input was actually replayed.)
- The declared A button does nothing. (intent: a device declaring a
  control the app ignores is a real shape a port can take, and this
  fixture carries it so the descriptor is not narrower than the device.)

## Demands

- Requires a panel of at least 32x32 in a format the emulator can read.
- Requires the host clock (`emu_tick(nowMs)`): the square's position is a
  pure function of `nowMs`, with no state carried between ticks.
- Does NOT require touch: without it the square simply stays on its
  starting row.
- Prefers, but does not require, a button.
