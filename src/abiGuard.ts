// Validates raw values an untrusted wasm module hands back through the ABI,
// AT THE BOUNDARY, ONCE, before anything downstream (a typed array
// constructor, a canvas blit, a Web Audio buffer) ever touches them.
//
// wasm/emu_abi.h states its own honesty rule as one direction only: "the
// emulator must never deliver an input the hardware cannot produce." This
// file is the other direction, which the ABI doc does not cover because it
// is a property of THIS HOST, not of the contract: the emulator must also
// never TRUST an output the module hands back blindly. A pointer or a
// count coming out of emu_fb() / emu_push_x() / emu_sound_buffer() is
// exactly as untrusted as any other value a hostile or merely-buggy
// firmware can produce, and a JS runtime will happily throw the instant a
// bad one reaches `new Uint16Array(...)` - RangeError, "invalid typed
// array length," "start offset must be a multiple of 2." That throw is
// real, but by the time it fires the one fact that matters is already
// lost: this is a bug in the FIRMWARE being emulated, not in the emulator.
// Every function here runs BEFORE that construction, so the message always
// names the firmware's own mistake precisely, in the firmware's own terms
// (which ABI call, what it returned), and the caller decides what to do
// about it: refuse to bring the module up at all (a bad framebuffer
// pointer - nothing downstream can run without one), or skip just the bad
// item and keep going (a bad push rectangle is a finding, not a reason to
// stop ticking - see src/panel.ts's readPushes and docs/requirements.md).
//
// Nothing here reports through the console pane or any UI directly: this
// module has no DOM dependency (same reasoning as src/panel.ts's pure
// functions - harness/ can use these too, headless, with no browser
// involved), and always returns/throws plain data. The caller decides how
// to surface it.

// Thrown only for failures a caller has decided are fatal to bringing a
// module up at all (see wasm.ts's readFramebufferPointer). Plain findings
// that get skipped-and-reported (a push rect, an audio buffer) are NOT
// exceptions - see PushValidation below - because throwing for something
// the caller is going to catch and continue past anyway is just a slower,
// more error-prone way to return a value.
export class FirmwareBug extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FirmwareBug";
  }
}

// A readable rendering of a raw ABI return value for an error/finding
// message: the decimal value, plus hex for anything that looks like it was
// meant to be a pointer or a bit pattern (0x7FFFFFFF reads a lot more
// obviously "wrong" in hex than in decimal).
function describe(n: number): string {
  if (!Number.isFinite(n)) return String(n);
  if (!Number.isInteger(n)) return String(n);
  return `${n} (0x${(n >>> 0).toString(16)})`;
}

// The framebuffer pointer emu_fb() hands back. Fatal when invalid: every
// other guarded step in bringUp() (instantiate, emu_init, the device
// descriptor) exists precisely so nothing downstream ever has to wonder
// whether the module is basically sound, and a framebuffer this emulator
// cannot safely read is the same class of "cannot proceed" as those.
//
// bytesPerPixel is fixed at 2: both pixel formats src/panel.ts implements
// (rgb565, rgb565be) are 16-bit. A firmware declaring a format this
// emulator doesn't recognise already fails earlier, in pixelReaderFor().
export function validateFbPtr(memory: WebAssembly.Memory, fbPtr: number, panelW: number, panelH: number): void {
  const bytesPerPixel = 2;
  const bytesNeeded = panelW * panelH * bytesPerPixel;
  if (!Number.isInteger(fbPtr) || fbPtr < 0) {
    throw new FirmwareBug(`emu_fb() returned ${describe(fbPtr)}, which is not a valid (non-negative integer) memory offset`);
  }
  if (fbPtr % bytesPerPixel !== 0) {
    throw new FirmwareBug(
      `emu_fb() returned ${describe(fbPtr)}, which is not ${bytesPerPixel}-byte aligned (required to read the panel as 16-bit pixels)`
    );
  }
  if (fbPtr + bytesNeeded > memory.buffer.byteLength) {
    throw new FirmwareBug(
      `emu_fb() returned ${describe(fbPtr)}, but the declared panel is ${panelW}x${panelH} (needs ${bytesNeeded} bytes there) ` +
        `and the module's own memory is only ${memory.buffer.byteLength} bytes; this pointer runs off the end of the module's own memory`
    );
  }
}

export interface Validation {
  ok: boolean;
  reason?: string;
}

// A push rectangle from emu_push_x/y/w/h. NOT fatal: a rectangle outside
// the panel (or otherwise malformed) is a firmware bug worth showing
// exactly as it is, not a reason to stop the whole emulator - see
// wasm/emu_abi.h's push-window section on why the overlay exists at all
// ("that overlay is the single most useful thing here"). The caller skips
// drawing it and reports the finding instead of clamping it into bounds:
// clamping would hide the exact geometry error a partial-refresh bug is
// made of.
export function validatePushRect(rect: { x: number; y: number; w: number; h: number }, panelW: number, panelH: number): Validation {
  const { x, y, w, h } = rect;
  for (const [name, v] of [
    ["x", x],
    ["y", y],
    ["w", w],
    ["h", h],
  ] as const) {
    if (!Number.isFinite(v) || !Number.isInteger(v)) {
      return { ok: false, reason: `${name}=${describe(v)} is not a finite integer` };
    }
  }
  if (w < 0 || h < 0) return { ok: false, reason: `w=${w}, h=${h} is negative` };
  if (w === 0 || h === 0) return { ok: true }; // a genuinely empty push: nothing to draw, nothing to report
  if (x < 0 || y < 0) return { ok: false, reason: `x=${x}, y=${y} is negative` };
  if (x + w > panelW || y + h > panelH) {
    return { ok: false, reason: `rect (${x},${y} ${w}x${h}) extends past the declared panel (${panelW}x${panelH})` };
  }
  return { ok: true };
}

// A generous multiple of any real partial-refresh count (the example
// firmware caps itself at 4; a busy real firmware might reasonably push a
// few dozen small rectangles in one tick). Exists only so a hostile or
// runaway emu_push_count() cannot drive an unbounded per-tick loop before
// a bad rectangle even gets a chance to be checked - see
// docs/findings-first-adversarial-pass.md's "Open" section.
export const MAX_PUSHES_PER_TICK = 256;

export function validatePushCount(count: number): { count: number; reason?: string } {
  if (!Number.isFinite(count) || !Number.isInteger(count) || count < 0) {
    return { count: 0, reason: `emu_push_count() returned ${describe(count)}, not a valid non-negative integer; reading 0 pushes this tick` };
  }
  if (count > MAX_PUSHES_PER_TICK) {
    return {
      count: MAX_PUSHES_PER_TICK,
      reason:
        `emu_push_count() returned ${count}, more than the ${MAX_PUSHES_PER_TICK} this emulator will read in one tick ` +
        `(is g_push_count being reset at the top of emu_tick(), per emu_abi.h?); reading only the first ${MAX_PUSHES_PER_TICK}`,
    };
  }
  return { count };
}

// The audio buffer emu_sound_buffer()/emu_sound_frames()/
// emu_sound_sample_rate() describe. NOT fatal, same reasoning as a push
// rect: a sound event this tick is skipped and reported rather than
// crashing playback (or the tick loop) for the whole session.
export function validateAudioBuffer(memory: WebAssembly.Memory, framesPtr: number, frameCount: number, sampleRate: number): Validation {
  if (!Number.isFinite(frameCount) || !Number.isInteger(frameCount) || frameCount <= 0) {
    return { ok: false, reason: `emu_sound_frames() returned ${describe(frameCount)}, not a positive integer` };
  }
  if (!Number.isFinite(framesPtr) || !Number.isInteger(framesPtr) || framesPtr < 0) {
    return { ok: false, reason: `emu_sound_buffer() returned ${describe(framesPtr)}, not a valid memory offset` };
  }
  if (framesPtr % 2 !== 0) {
    return { ok: false, reason: `emu_sound_buffer() returned ${describe(framesPtr)}, not 2-byte aligned (required to read int16 samples)` };
  }
  const bytesNeeded = frameCount * 2;
  if (framesPtr + bytesNeeded > memory.buffer.byteLength) {
    return {
      ok: false,
      reason:
        `emu_sound_buffer()/emu_sound_frames() describe a ${bytesNeeded}-byte region at ${describe(framesPtr)} ` +
        `that runs off the end of the module's ${memory.buffer.byteLength}-byte memory`,
    };
  }
  if (!Number.isFinite(sampleRate) || sampleRate <= 0 || sampleRate > 384000) {
    return { ok: false, reason: `emu_sound_sample_rate() returned ${describe(sampleRate)}, not a plausible sample rate` };
  }
  return { ok: true };
}
