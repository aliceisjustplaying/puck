// Replays a trace against the emulator side of a comparison, headless: no
// browser, no canvas, no puppeteer. WebAssembly is a global in Bun the same
// way it is in a browser, so the exact same loader (src/wasm.ts's
// instantiate()) works here unmodified - this is possible specifically
// because wasm/emu_abi.h's module has no DOM dependency of its own, only
// the nine documented host imports.
//
// Unlike the live page, this never has to wait for real time to pass:
// emu_tick(nowMs) takes the timestamp as an argument, so replaying a trace
// here is just "call the ABI functions in order, as fast as the host can",
// and the result is bit-identical to what the live page would have shown
// at each of those same nowMs values, per the determinism guarantee
// wasm/emu_abi.h documents.

import { readFileSync } from "node:fs";
import { instantiate, readDeviceDescriptor, type EmuExports, type DeviceDescriptor } from "../src/wasm";
import { pixelReaderFor, readFramebufferRGB } from "../src/panel";
import type { CapturedFrame, TraceEvent } from "./types";

export interface EmulatorReplayResult {
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
export async function replayEmulator(wasmPath: string, events: TraceEvent[], capturePoints: number[]): Promise<EmulatorReplayResult> {
  const bytes = readFileSync(wasmPath).buffer as ArrayBuffer;
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
