// Builds one button per declared "event" sensor (emu_abi.h: "a shake, a
// tap, a step: anything the firmware receives as 'it happened' rather than
// as a continuous value"). A sensor of any other kind is left for a future
// emulator version to render; skipping it here is deliberate ("unknown
// fields are ignored", emu_abi.h) rather than a TODO.
//
// Index passed to emu_sensor_event MUST be the sensor's index in the FULL
// declared array, not its position among the ones actually rendered, so a
// skipped non-event sensor does not shift every index after it.
//
// Keyboard shortcuts go through the shared ShortcutRegistry (see
// shortcuts.ts) rather than this module attaching its own window listener:
// the whole chrome, including this, is rebuilt from scratch on every wasm
// reload, and a per-module listener would leak one more copy of itself on
// every rebuild.

import type { EmuExports, DeviceSensor } from "./wasm";
import type { ShortcutRegistry } from "./shortcuts";
import { assignShortcut } from "./shortcuts";

// Returned by buildSensorControls so a control OUTSIDE this module's own
// rendered buttons (main.ts's embed rotate/shake cluster, see main.ts's
// buildEmbedControls) can fire a declared event sensor through the EXACT
// same path a real click on its (possibly hidden, e.g. embed mode's
// sidebar) own button uses -- same guardedCall, same recorded event, same
// onFire callback (the puck-motion jolt a "shake" click gets since there is
// no real device motion behind it) -- rather than a second, independently
// reimplemented "click shake" that could drift from this one.
export interface SensorControls {
  // false if no declared "event" sensor has this id (case-insensitive):
  // nothing fired. This is also the one place that answers "does this
  // device have a sensor called X" for a caller that only cares whether
  // firing it is possible, so main.ts's embed shake button gates its own
  // visibility on the SAME shakeSensorIndex >= 0 check buildChrome already
  // computes, rather than asking this map a second way.
  fire(id: string): boolean;
}

// No `emu` parameter: every ABI call this module makes goes through
// guardedCall below, which already closes over the live module reference
// (see main.ts's guardedAbiCall) -- a second, separately-passed `emu` would
// just be an unused parameter inviting a stale, unguarded call to be added
// here by mistake later.
export function buildSensorControls(
  container: HTMLElement,
  sensors: DeviceSensor[],
  shortcuts: ShortcutRegistry,
  usedKeys: Set<string>,
  log: (text: string) => void,
  // Fired right after emu_sensor_event(), so a button/keyboard press can
  // drive something visible (the puck-motion shake, for a "shake" sensor)
  // even though there is no real window motion behind a click.
  onFire: ((sensor: DeviceSensor, index: number) => void) | undefined,
  // Same direct-ABI-call guard main.ts uses for button presses and the
  // window-shake path (see main.ts's guardedAbiCall header comment): a
  // sensor button click is a DOM event handler, outside the tick loop's own
  // try/catch, calling straight into the module -- a trap here gets the
  // same #engineDead treatment as any other direct call, not silence.
  guardedCall: (cause: string, fn: (liveEmu: EmuExports) => void) => void
): SensorControls {
  container.innerHTML = "";
  const firers = new Map<string, () => void>();
  sensors.forEach((sensor, index) => {
    if (sensor.kind !== "event") return;
    const fire = () => {
      guardedCall(`sensor[${index}] ("${sensor.id}")`, (liveEmu) => {
        liveEmu.emu_sensor_event(index);
        log(`sensor: ${sensor.id}`);
        onFire?.(sensor, index);
      });
    };
    firers.set(sensor.id.toLowerCase(), fire);
    const key = assignShortcut(sensor.id, usedKeys);
    const btn = document.createElement("button");
    btn.className = "btn sec sm sensor-btn";
    btn.textContent = sensor.label || sensor.id;
    if (key) {
      const kbd = document.createElement("span");
      kbd.className = "kbd";
      kbd.textContent = key.toUpperCase();
      btn.appendChild(kbd);
      shortcuts.bindClick(key, fire);
    }
    btn.addEventListener("click", fire);
    container.appendChild(btn);
  });
  return {
    fire(id: string): boolean {
      const fn = firers.get(id.toLowerCase());
      if (!fn) return false;
      fn();
      return true;
    },
  };
}
