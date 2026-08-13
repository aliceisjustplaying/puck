// A FAKE HardwareLink, for testing the harness mechanism itself (pacing,
// capture points, comparison, PNG output) with no real board attached.
//
// THIS IS NOT A SUBSTITUTE FOR REAL HARDWARE, AND MUST NEVER BE READ AS
// ONE. It runs a second instance of the SAME wasm module the emulator side
// already replays, so a clean diff against it proves only that the harness
// plumbing works end to end (a trace replayed twice through the same
// module, the same way, produces the same pixels - which is exactly the
// determinism guarantee wasm/emu_abi.h already claims, not new evidence of
// anything). It proves nothing about a real chip, a real touch controller,
// or a real display, because there isn't one anywhere in this file.
//
// Used by harness/selftest.ts. If you're looking for how to write a REAL
// link, read this file for the shape (connect/disconnect/send/screenshot),
// then see docs/harness.md's worked example, which describes a real
// serial-based reference implementation.

import { readFileSync } from "node:fs";
import { instantiate, readDeviceDescriptor, type EmuExports, type DeviceDescriptor } from "../../src/wasm";
import { pixelReaderFor, readFramebufferRGB, type PixelReader } from "../../src/panel";
import type { CapturedFrame, HardwareLink, TraceEvent } from "../types";

class LoopbackLink implements HardwareLink {
  private wasmPath: string;
  private emu: EmuExports | null = null;
  private device: DeviceDescriptor | null = null;
  private reader: PixelReader | null = null;
  private fbPtr = 0;
  private tickTimer: ReturnType<typeof setInterval> | null = null;

  constructor(wasmPath: string) {
    this.wasmPath = wasmPath;
  }

  async connect(): Promise<void> {
    const bytes = readFileSync(this.wasmPath).buffer as ArrayBuffer;
    this.emu = await instantiate(bytes, () => {});
    if (this.emu.emu_init() === 0) throw new Error("loopback: emu_init() returned 0");
    this.device = readDeviceDescriptor(this.emu);
    this.reader = pixelReaderFor(this.device.panel.format);
    this.fbPtr = this.emu.emu_fb();
    // Real hardware runs its own tick/main loop continuously and
    // autonomously, at its own rate, regardless of when input happens to
    // arrive over the wire - a touch held for only a few milliseconds is
    // still caught because the board is polling far faster than that. A
    // fake link that only ticked once, synchronously, right before
    // screenshot() would NOT reproduce that: an event sent and then
    // immediately reversed (touch down, then up, faster than one manual
    // tick) would never be observed at all, which is a fake-link bug, not
    // a real property of hardware. Ticking in the background at a fixed
    // rate here is what makes this fake stand in for that autonomy.
    this.tickTimer = setInterval(() => this.emu?.emu_tick(performance.now()), 8);
  }

  async disconnect(): Promise<void> {
    if (this.tickTimer) clearInterval(this.tickTimer);
    this.tickTimer = null;
    this.emu = null;
  }

  async send(event: TraceEvent): Promise<void> {
    const emu = this.emu!;
    switch (event.k) {
      case "touch":
        emu.emu_touch(event.down, event.x, event.y);
        break;
      case "button":
        emu.emu_button(event.i, event.down);
        break;
      case "verdict":
        emu.emu_button_verdict(event.i, event.long);
        break;
      case "sensor":
        emu.emu_sensor_event(event.i);
        break;
      case "tick":
        // Real hardware has no such call, and hardwareSide.ts never sends
        // one - see its header comment. Nothing to do here for parity with
        // that contract, even though this fake COULD trivially call
        // emu_tick() itself.
        break;
    }
  }

  async screenshot(): Promise<CapturedFrame> {
    const emu = this.emu!;
    const device = this.device!;
    const rgb = readFramebufferRGB(emu.memory, this.fbPtr, device.panel.w, this.reader!, {
      x: 0,
      y: 0,
      w: device.panel.w,
      h: device.panel.h,
    });
    return { width: device.panel.w, height: device.panel.h, rgb };
  }
}

export default function makeLoopbackLink(wasmPath = process.env.PUCK_WASM ?? "wasm/dist/emu.wasm"): HardwareLink {
  return new LoopbackLink(wasmPath);
}
