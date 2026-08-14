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
  | { t: number; k: "tick" };

export interface Trace {
  // Bumped from 1: version 1 traces could silently lose their oldest events
  // when the recorder reached capacity, so their event list might not begin
  // at a fresh boot. Version 2 always says whether recording stopped early.
  schemaVersion: 2;
  recordedAt: string;
  device: DeviceDescriptor;
  truncated: boolean;
  events: TraceEvent[];
}

export class Recorder {
  events: TraceEvent[] = [];
  enabled = true;
  truncated = false;

  record(ev: TraceEvent): "truncated" | undefined {
    if (!this.enabled || this.truncated) return;
    // Preserve a replayable prefix from fresh boot. Mark truncation only when
    // an event is actually dropped, not when the final available slot is
    // filled exactly.
    if (this.events.length >= TRACE_MAX_EVENTS) {
      this.truncated = true;
      return "truncated";
    }
    this.events.push(ev);
  }

  recent(n: number): TraceEvent[] {
    return this.events.slice(-n);
  }

  clear(): void {
    this.events.length = 0;
    this.truncated = false;
  }

  toTrace(device: DeviceDescriptor): Trace {
    return {
      schemaVersion: 2,
      recordedAt: new Date().toISOString(),
      device,
      truncated: this.truncated,
      events: this.events.slice(),
    };
  }
}
