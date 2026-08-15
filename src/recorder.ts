// Records every ABI input call and every tick timestamp, in order, into a
// trace. This is the foundation the differential test harness (harness/)
// is also built on: emu_tick(nowMs) is the guest's only clock
// (wasm/emu_abi.h), so a session is fully described by the ordered
// sequence of (call, timestamp) pairs that were made against it. Replaying
// that same sequence against a freshly booted module (see replay.ts)
// reproduces the same behavior.

import { TRACE_MAX_EVENTS } from "./constants";
import type { DeviceDescriptor } from "./wasm";

export type LegacyTraceEvent =
  | { t: number; k: "touch"; down: number; x: number; y: number }
  | { t: number; k: "button"; i: number; down: number }
  | { t: number; k: "verdict"; i: number; long: number }
  | { t: number; k: "sensor"; i: number }
  | { t: number; k: "tick" };

export type BatteryTraceEvent = { t: number; k: "battery"; percent: number; charging: number; external: number };
export type TraceEvent = LegacyTraceEvent | BatteryTraceEvent;
export type TraceSchemaVersion = 2 | 3;

interface TraceBase {
  recordedAt: string;
  device: DeviceDescriptor;
  truncated: boolean;
}

export interface TraceV2 extends TraceBase {
  schemaVersion: 2;
  events: LegacyTraceEvent[];
}

export interface TraceV3 extends TraceBase {
  schemaVersion: 3;
  events: TraceEvent[];
}

export type Trace = TraceV2 | TraceV3;

export function validateTraceEvents(schemaVersion: TraceSchemaVersion, events: TraceEvent[]): void {
  for (const [index, event] of events.entries()) {
    if (typeof event !== "object" || event === null || typeof event.t !== "number" || !Number.isFinite(event.t)) {
      throw new Error(`trace event ${index} is malformed`);
    }
    if (event.k !== "battery") continue;
    if (schemaVersion !== 3) throw new Error(`trace schema ${schemaVersion} cannot contain battery event ${index}`);
    if (!Number.isInteger(event.percent) || event.percent < -1 || event.percent > 100) {
      throw new Error(`battery event ${index} percent must be an integer from -1 through 100`);
    }
    if ((event.charging !== 0 && event.charging !== 1) || (event.external !== 0 && event.external !== 1)) {
      throw new Error(`battery event ${index} charging and external must be 0 or 1`);
    }
  }
}

export function validateTrace(value: unknown): Trace {
  if (typeof value !== "object" || value === null) throw new Error("not a trace file");
  const trace = value as { schemaVersion?: unknown; truncated?: unknown; events?: unknown };
  if (trace.schemaVersion !== 2 && trace.schemaVersion !== 3) {
    throw new Error("unsupported trace schema: version 2 or 3 is required");
  }
  if (typeof trace.truncated !== "boolean") throw new Error("trace needs an explicit truncated field");
  if (!Array.isArray(trace.events)) throw new Error("not a trace file (missing events array)");
  validateTraceEvents(trace.schemaVersion, trace.events as TraceEvent[]);
  return trace as Trace;
}

export class Recorder {
  events: TraceEvent[] = [];
  enabled = true;
  truncated = false;

  record(ev: TraceEvent): "truncated" | undefined {
    if (!this.enabled || this.truncated) return;
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

  toTrace(device: DeviceDescriptor): TraceV3 {
    return {
      schemaVersion: 3,
      recordedAt: new Date().toISOString(),
      device,
      truncated: this.truncated,
      events: this.events.slice(),
    };
  }
}
