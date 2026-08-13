// Panel size, pixel format, buttons, sensors and apps all come from the
// firmware's own emu_device() descriptor at runtime (see wasm.ts), because
// this emulator is generic across devices and must not hardcode any of it.
// What's left here are constants for the parts that ARE this emulator's own
// (the touch-controller defect simulation, overlay timing, trace limits),
// not the device's.
//
// There is no ABI for "how a real touch panel misbehaves" because that is
// not part of any firmware; it is this emulator's own model of what a
// physical touch controller does that a mouse never does (see touchsim.ts).

export interface TouchSimConfig {
  reportRateHz: number;
  dropoutsEnabled: boolean;
  dropoutsPerSec: number;
  straysEnabled: boolean;
  straysPerSec: number;
}

// These are the rates the simulation uses ONCE the master "simulate
// controller defects" toggle is switched on (default off, see main.ts).
// Reasonable defaults for a small capacitive touch controller, not a
// measurement of any particular chip: real touch panels this emulator has
// been checked against report on the order of 1-3 dropouts per second
// while a finger is actively dragging. Tune these sliders against your own
// hardware's actual behaviour if you know it.
export const TOUCHSIM_DEFAULTS: TouchSimConfig = {
  reportRateHz: 60,
  dropoutsEnabled: true,
  dropoutsPerSec: 2,
  straysEnabled: true,
  straysPerSec: 0.2,
};

// Off by default: a clean, unthrottled pointer pass-through exercises none
// of the firmware's dropout-bridging or stray-rejection code, which is
// exactly why this exists as an opt-in rather than always-on (see
// emu_abi.h: "off by default, and clearly labelled when on").
export const TOUCH_DEFECTS_DEFAULT = false;

// How long a push-rectangle outline stays visible in the overlay before
// fully fading (see overlay.ts). Not part of any ABI; a UI choice.
export const PUSH_FADE_MS = 400;

// Recorder ring-buffer cap (see recorder.ts). At a steady 60Hz tick rate
// this is a little over 13 minutes of full-rate history, which comfortably
// covers "what just happened" without growing without bound in a session
// left running overnight.
export const TRACE_MAX_EVENTS = 50000;
