// The core of a headless emulator replay: instantiate a wasm module from
// already-fetched bytes, then call the ABI functions in order for a
// trace's events, capturing the framebuffer at whatever nowMs values were
// asked for. No filesystem, no browser DOM: this is what makes it callable
// from every place this repo needs to replay a trace against the emulator
// with nothing but the module's bytes -
//   - harness/emulatorSide.ts, for the differential test harness's CLI
//     (reads a wasm PATH off disk with node:fs, then hands the bytes here)
//   - src/regression.ts, the in-page hardware-free regression check (the
//     page already has the current module's bytes in memory, see
//     main.ts's wasmBytes, no file to read)
//   - test/regression/run.ts, a plain Bun script proving the regression
//     check catches a real firmware change, with no browser involved
//
// This function used to live only inside harness/emulatorSide.ts. Reused
// here rather than forked: two copies of "replay a trace against the
// emulator" would have agreed with each other exactly once, at the moment
// the second copy was written, and drifted from then on with nothing to
// notice - see docs/decisions/0002-two-compilers-not-one.md for the same
// argument made about firmware logic, applied here to this repo's own code.
//
// emu_tick(nowMs) takes the timestamp as an argument (wasm/emu_abi.h), so
// this never has to wait for real time to pass: replaying a trace here is
// "call the ABI functions in order, as fast as the host can", and the
// result is bit-identical to what the live page would have shown at each
// of those same nowMs values, per the determinism guarantee emu_abi.h
// documents.

import { instantiate, readDeviceDescriptor, type EmuExports, type DeviceDescriptor } from "./wasm";
import { pixelReaderFor, readFramebufferRGB } from "./panel";
import type { CapturedFrame } from "./frame";
import type { TraceEvent } from "./recorder";

export interface ReplayResult {
  device: DeviceDescriptor;
  // One captured frame per requested capture point, in the same order,
  // paired with the trace timestamp (nowMs) it was captured at.
  frames: { atMs: number; frame: CapturedFrame }[];
  log: string[];
}

// capturePoints: nowMs values (matching TraceEvent's "t" field / the tick
// event's own timestamp) at which to read the framebuffer. A capture
// happens right after the emu_tick() whose timestamp is >= the requested
// point - the same "capture at whatever the state is after this tick"
// semantics the live page's push overlay uses.
export async function replayFromBytes(bytes: ArrayBuffer, events: TraceEvent[], capturePoints: number[]): Promise<ReplayResult> {
  const log: string[] = [];
  const emu: EmuExports = await instantiate(bytes, (text) => log.push(text));
  if (emu.emu_init() === 0) throw new Error("emu_init() returned 0");

  const device = readDeviceDescriptor(emu);
  const reader = pixelReaderFor(device.panel.format);
  const fbPtr = emu.emu_fb();

  const remainingPoints = [...capturePoints].sort((a, b) => a - b);
  const frames: { atMs: number; frame: CapturedFrame }[] = [];

  function captureNow(atMs: number): void {
    const rgb = readFramebufferRGB(emu.memory, fbPtr, device.panel.w, reader, {
      x: 0,
      y: 0,
      w: device.panel.w,
      h: device.panel.h,
    });
    frames.push({ atMs, frame: { width: device.panel.w, height: device.panel.h, rgb } });
  }

  for (const ev of events) {
    switch (ev.k) {
      case "touch":
        emu.emu_touch(ev.down, ev.x, ev.y);
        break;
      case "button":
        emu.emu_button(ev.i, ev.down);
        break;
      case "verdict":
        emu.emu_button_verdict(ev.i, ev.long);
        break;
      case "sensor":
        emu.emu_sensor_event(ev.i);
        break;
      case "vector":
        // Optional export: a module that never declared a "kind": "vector"
        // sensor (or predates this ABI addition) simply does not have it,
        // and this is a silent no-op against it, per emu_abi.h's own
        // "unimplemented means uncalled" contract - see recorder.ts's
        // header comment on this event kind for why that is what keeps a
        // pre-existing trace (no vector events at all) replaying bit-
        // identically either way.
        emu.emu_sensor_vector?.(ev.i, ev.x, ev.y, ev.z);
        break;
      case "tick":
        emu.emu_tick(ev.t);
        while (remainingPoints.length > 0 && remainingPoints[0]! <= ev.t) {
          captureNow(remainingPoints.shift()!);
        }
        break;
    }
  }
  // Any capture point past the trace's last tick: capture the final state
  // rather than silently dropping it, since "after the trace finished" is
  // a legitimate thing to ask for (e.g. --at the trace's total duration).
  for (const p of remainingPoints) captureNow(p);

  return { device, frames, log };
}
