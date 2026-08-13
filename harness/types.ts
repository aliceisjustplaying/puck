// The differential test harness's shared types: a trace (the same shape
// src/recorder.ts records from a live session), and the HardwareLink
// interface a real board's transport implements. See docs/harness.md for
// the full explanation of what this proves and what it cannot.

import type { DeviceDescriptor } from "../src/wasm";
import type { TraceEvent } from "../src/recorder";

export type { TraceEvent };

export interface Trace {
  schemaVersion: 1;
  recordedAt: string;
  device: DeviceDescriptor;
  events: TraceEvent[];
}

// A captured frame, in a common representation both sides of a comparison
// produce: RGB, 3 bytes per pixel, row-major, top-left origin. Emulator
// side: converted from the wasm framebuffer via the same pixel-format
// reader the live page uses (src/panel.ts's readFramebufferRGB). Hardware
// side: whatever your HardwareLink.screenshot() returns, already decoded
// to this shape by your adapter - the harness makes no assumption about
// your transport's wire format (base64, RLE, raw SPI dump, a camera
// photograph you've perspective-corrected, anything), only about what your
// adapter hands back.
export interface CapturedFrame {
  width: number;
  height: number;
  rgb: Uint8Array; // width * height * 3 bytes
}

// The pluggable side of the harness. Your own transport (serial, USB, a
// debug probe, a camera pointed at the panel with autocrop, anything that
// can inject the same input events a real user would produce and read back
// what the panel shows) implements this. Nothing in harness/ knows or
// cares which.
//
// Every input method mirrors an ABI call from wasm/emu_abi.h exactly,
// because the whole point of the differential harness is replaying the
// SAME trace both ways: what the emulator received via emu_touch/
// emu_button/emu_button_verdict/emu_sensor_event, your hardware must
// receive through whatever real mechanism reaches the same input path on
// the board (a button GPIO, a touch controller register, an injected
// event over your own debug link - see docs/harness.md's worked example
// for how one project's own link maps these).
export interface HardwareLink {
  // Opens the transport (a serial port, a socket, whatever). Called once
  // before the first event is sent.
  connect(): Promise<void>;

  // Closes the transport. Called once after the last screenshot, in a
  // `finally`, even if the run failed partway through.
  disconnect(): Promise<void>;

  // Optional: put the board into a known starting state before replay
  // begins (reboot it, reset to a known app, clear its screen). If your
  // hardware always boots into the same state as the emulator's emu_init(),
  // this can be omitted; if it can't, the comparison is only meaningful
  // from a known-equal starting point, so implement this.
  reset?(): Promise<void>;

  // Sends one input event through whatever real mechanism reaches the
  // board's equivalent of this ABI call. `t` (the trace event's own
  // timestamp) is NOT re-sent to the hardware - real hardware runs on its
  // own clock, always; see docs/harness.md on why this harness paces
  // events in real time rather than pretending it can hand the board a
  // synthetic nowMs the way emu_tick() takes one.
  send(event: TraceEvent): Promise<void>;

  // Captures what the panel currently shows, decoded to a common RGB
  // representation (see CapturedFrame above). Called at each capture
  // point the harness was told to stop at (see harness/diff.ts's --at /
  // --every).
  screenshot(): Promise<CapturedFrame>;
}
