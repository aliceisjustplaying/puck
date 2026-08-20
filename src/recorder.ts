// Records every ABI input call and every tick timestamp, in order, into a
// trace. This is the foundation the differential test harness (harness/)
// is also built on: emu_tick(nowMs) is the guest's only clock
// (wasm/emu_abi.h), so a session is fully described by the ordered
// sequence of (call, timestamp) pairs that were made against it. Replaying
// that same sequence against a freshly booted module (see replay.ts)
// reproduces the same behaviour, which turns a bug that only shows up
// "sometimes, while doing X" into a file that reproduces it on demand.

import { TRACE_MAX_EVENTS } from "./constants";
import type { DeviceDescriptor } from "./wasm";

export type TraceEvent =
  | { t: number; k: "touch"; down: number; x: number; y: number }
  | { t: number; k: "button"; i: number; down: number }
  | { t: number; k: "verdict"; i: number; long: number }
  | { t: number; k: "sensor"; i: number }
  // A "kind": "vector" sensor's current reading (emu_abi.h's
  // emu_sensor_vector), by index into the declared sensors array. Recorded
  // whenever the host sends one (see main.ts); replayed by replayCore.ts/
  // replay.ts, which skip it silently against a module that never exported
  // emu_sensor_vector - a trace with no "vector" events (every trace
  // recorded before this event kind existed) replays exactly as before.
  | { t: number; k: "vector"; i: number; x: number; y: number; z: number }
  // One raw accelerometer sample (emu_abi.h's OPTIONAL emu_accel_sample),
  // by index into the declared sensors array (a "kind": "stream" sensor).
  // Unlike "vector" (one continuous, level-triggered reading), a real
  // stream sensor produces several of these between two "tick" events
  // (packs/esp32-s3-touch-amoled-18's device.json declares ~200Hz against a
  // ~60Hz tick rate), so a trace legitimately carries multiple "accel"
  // events at the same or nearby `t`. Replayed by replayCore.ts, which
  // skips it silently against a module that never exported
  // emu_accel_sample - same "unimplemented means uncalled" contract
  // "vector" already uses, so a trace with no "accel" events replays
  // exactly as before.
  | { t: number; k: "accel"; i: number; ax: number; ay: number; az: number }
  | { t: number; k: "tick" };

export interface Trace {
  schemaVersion: 1;
  recordedAt: string;
  device: DeviceDescriptor;
  events: TraceEvent[];
  // OPTIONAL, and absent from every trace this repository has recorded so
  // far. Seeds the deterministic PRNG behind WASI-lite's random_get
  // (src/wasiLite.ts), which is the only source of randomness a module can
  // reach at all: emu_abi.h itself offers none. A trace that omits it
  // replays with wasiLite.ts's DEFAULT_TRACE_SEED, the same value a live
  // page uses when there is no trace, so a pre-existing trace replays
  // bit-identically and no schemaVersion bump is needed (this is a
  // backwards-compatible optional field, exactly like the "vector" event
  // kind above). Set it by hand to replay one session's randomness under a
  // different draw.
  seed?: number;
}

export class Recorder {
  events: TraceEvent[] = [];
  enabled = true;

  record(ev: TraceEvent): void {
    if (!this.enabled) return;
    this.events.push(ev);
    // A ring buffer, not an ever-growing array: bounds memory in a session
    // left running, at the cost of only keeping the most recent history
    // (see constants.ts for what that cap actually covers in wall time).
    if (this.events.length > TRACE_MAX_EVENTS) this.events.shift();
  }

  recent(n: number): TraceEvent[] {
    return this.events.slice(-n);
  }

  clear(): void {
    this.events.length = 0;
  }

  toTrace(device: DeviceDescriptor): Trace {
    return {
      schemaVersion: 1,
      recordedAt: new Date().toISOString(),
      device,
      events: this.events.slice(),
    };
  }
}
