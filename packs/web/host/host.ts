// host: this pack's own browser host. The half of the "device" that is not
// firmware - the panel, the two buttons, the digitizer and the
// accelerometer - implemented against the DOM instead of against QSPI,
// i2c1 and a QMI8658.
//
// SELF-CONTAINED ON PURPOSE. Nothing here imports from src/, the puck
// emulator's own instrument code, even though src/motion.ts, src/panel.ts
// and src/wasm.ts each solve a piece of this already. docs/convention/
// device-pack.md's rule is that a pack must stay usable when copied out of
// this repository with only a pinned puck checkout, and a pack that
// imported the instrument would break the moment it was copied. So this
// file duplicates, deliberately and with attribution, in the two places
// where duplication is not a shortcut but the rule:
//
//   - the RGB565-big-endian framebuffer read (src/panel.ts's pixelReaderFor)
//   - the devicemotion sign conventions (src/motion.ts's
//     mapAccelerationToVector, and its hardware validation - see
//     applyMotion below, and gotchas.md)
//
// Both are small, both are load-bearing, and a wrong copy of either is
// visible immediately (garbled colours; fluid pouring the wrong way), which
// is the property that makes duplicating them safe.
//
// THE APP IS THE PAGE. Unlike this repository's own emulator page, there is
// no device bezel drawn around the panel, no console, no controls beyond
// the two buttons the device declares. A phone IS the enclosure.

interface EmuExports {
  memory: WebAssembly.Memory;
  emu_device(): number;
  emu_init(): number;
  emu_tick(nowMs: number): void;
  emu_fb(): number;
  emu_push_count(): number;
  emu_push_x(i: number): number;
  emu_push_y(i: number): number;
  emu_push_w(i: number): number;
  emu_push_h(i: number): number;
  emu_touch(down: number, x: number, y: number): void;
  emu_button(index: number, down: number): void;
  emu_button_verdict(index: number, isLong: number): void;
  emu_sensor_event(index: number): void;
  emu_sensor_vector?(index: number, x: number, y: number, z: number): void;
}

interface DeviceButton {
  id: string;
  label: string;
  edge: "left" | "right" | "top" | "bottom";
  at: number;
  longPressMs?: number;
}
interface DeviceSensor {
  id: string;
  kind: string;
}
interface DeviceDescriptor {
  name?: string;
  panel: { w: number; h: number; format: string };
  buttons?: DeviceButton[];
  touch?: { points?: number };
  sensors?: DeviceSensor[];
  apps?: string[];
}

// ---- module loading ------------------------------------------------------
// The nine math functions and js_log, exactly wasm/emu_abi.h's documented
// import list. A build that asks for anything else fails loudly inside
// WebAssembly.instantiate, naming what it asked for and did not get, which
// is the mechanism emu_abi.h itself names for reconciling the two sides.
function importObject(memoryRef: { current?: WebAssembly.Memory }): WebAssembly.Imports {
  const decoder = new TextDecoder();
  return {
    env: {
      sinf: Math.sin,
      cosf: Math.cos,
      atan2f: Math.atan2,
      sqrtf: Math.sqrt,
      fabsf: Math.abs,
      floorf: Math.floor,
      fmodf: (a: number, b: number) => a % b,
      powf: Math.pow,
      expf: Math.exp,
      js_log: (ptr: number, len: number): void => {
        const memory = memoryRef.current;
        if (!memory) return;
        console.log(decoder.decode(new Uint8Array(memory.buffer, ptr, len)));
      },
    },
  };
}

function readCString(memory: WebAssembly.Memory, ptr: number): string {
  const bytes = new Uint8Array(memory.buffer);
  let end = ptr;
  while (end < bytes.length && bytes[end] !== 0) end++;
  return new TextDecoder().decode(bytes.subarray(ptr, end));
}

async function loadModule(url: string): Promise<{ emu: EmuExports; device: DeviceDescriptor }> {
  // Same-origin only, and not by accident: a cross-origin wasm URL is
  // blocked by the service worker's own never-cache-cross-origin rule and,
  // more to the point, by the CSP a static host normally ships. See
  // gotchas.md.
  const res = await fetch(url);
  if (!res.ok) throw new Error(`could not load ${url} (HTTP ${res.status})`);
  const bytes = await res.arrayBuffer();
  const memoryRef: { current?: WebAssembly.Memory } = {};
  const { instance } = await WebAssembly.instantiate(bytes, importObject(memoryRef));
  const emu = instance.exports as unknown as EmuExports;
  memoryRef.current = emu.memory;
  if (!emu.memory) throw new Error("wasm module exports no memory; the panel is read through it");
  if (emu.emu_init() === 0) throw new Error("emu_init() returned 0");
  const device = JSON.parse(readCString(emu.memory, emu.emu_device())) as DeviceDescriptor;
  if (!device.panel || !device.panel.w || !device.panel.h) throw new Error("emu_device() declared no panel");
  return { emu, device };
}

// ---- the panel -----------------------------------------------------------
// RGB565, byte-swapped relative to how the CPU stores a uint16_t: the
// panel format both AMOLED packs declare, and the one this pack matches so
// a faithful port exists at all. Duplicated from src/panel.ts's
// pixelReaderFor("rgb565be") per this file's header comment.
//
// The 5/6/5 channels are expanded by replicating high bits into low ones
// (v << 3 | v >> 2), not by shifting alone, so a full-scale channel reaches
// 255 rather than 248: an all-white framebuffer has to read back as
// #ffffff, and a diff against a recorded PNG is exactly where a 248 would
// show up.
class Panel {
  readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly back: HTMLCanvasElement;
  private readonly backCtx: CanvasRenderingContext2D;
  private readonly image: ImageData;
  private cssW = 0;
  private cssH = 0;

  // A landscape app (app.h's `landscape`, set by --landscape at build
  // time) draws into a 448x368 space that gfx rotates into the portrait
  // panel, so its content sits sideways in the framebuffer. On the puck
  // you turn the device; on a phone the page turns with you, so turning it
  // would achieve nothing. The host presents it rotated instead, which is
  // exactly what this repository's own gallery already does for the same
  // app on the chip packs (site/build.ts clicks the emulator's -90 degree
  // quick-rotate on every chrono run page).
  //
  // This changes nothing the module computes: the framebuffer, the pushed
  // rectangles and every recorded proof are untouched. It is a rotation of
  // the presentation, undone exactly in toPanel() below so a finger still
  // lands where the app thinks it did.
  constructor(readonly w: number, readonly h: number, private readonly rotated: boolean) {
    this.canvas = document.createElement("canvas");
    this.canvas.id = "panel";
    const ctx = this.canvas.getContext("2d", { alpha: false });
    if (!ctx) throw new Error("no 2d canvas context");
    this.ctx = ctx;

    this.back = document.createElement("canvas");
    this.back.width = w;
    this.back.height = h;
    const backCtx = this.back.getContext("2d", { alpha: false, willReadFrequently: false });
    if (!backCtx) throw new Error("no 2d canvas context");
    this.backCtx = backCtx;
    this.image = backCtx.createImageData(w, h);
    const data = this.image.data;
    for (let i = 3; i < data.length; i += 4) data[i] = 255; // alpha, once
  }

  // Integer-ish scaling at DEVICE pixel resolution, with a stated cutoff.
  //
  // A whole number of device pixels per panel pixel makes each panel pixel
  // a crisp square block instead of a resampled smear, so an integer scale
  // is preferred. It is NOT preferred at any price: on a 390px-wide phone
  // at dpr 2, a landscape 448-wide panel fits 1.74 times, and rounding
  // that down to 1 would render the app at HALF the screen width to gain
  // crispness nobody asked for. So the integer is taken only when it keeps
  // at least 80% of the available size, and the fractional scale is used
  // otherwise. Portrait on the same phone fits 2.12 times and keeps 94%,
  // so it snaps to 2 and stays exact; the app that needed the fallback is
  // the one that would have been visibly punished by it.
  private static readonly SNAP_KEEP = 0.8;

  layout(availW: number, availH: number, dpr: number): void {
    // A rotated panel occupies its own dimensions swapped, so it is
    // measured against the available box that way too.
    const wantW = this.rotated ? this.h : this.w;
    const wantH = this.rotated ? this.w : this.h;
    const fitDevice = Math.min((availW * dpr) / wantW, (availH * dpr) / wantH);
    const floored = Math.floor(fitDevice);
    const scale = floored >= 1 && floored / fitDevice >= Panel.SNAP_KEEP ? floored : fitDevice;
    this.canvas.width = Math.max(1, Math.round(wantW * scale));
    this.canvas.height = Math.max(1, Math.round(wantH * scale));
    this.cssW = this.canvas.width / dpr;
    this.cssH = this.canvas.height / dpr;
    this.canvas.style.width = `${this.cssW}px`;
    this.canvas.style.height = `${this.cssH}px`;
    // Set AFTER every resize: a canvas resize resets its whole 2d state,
    // smoothing included, and a smoothed blit is a blurry panel.
    this.ctx.imageSmoothingEnabled = false;
  }

  // Copies one rectangle of the wasm framebuffer into the backing canvas.
  // Bounds are clamped here rather than trusted: emu_push_* is firmware
  // output, and a firmware bug must not become an out-of-range typed-array
  // read in the host.
  private blitRect(memory: WebAssembly.Memory, fbPtr: number, x: number, y: number, w: number, h: number): void {
    if (w <= 0 || h <= 0) return;
    if (x < 0) { w += x; x = 0; }
    if (y < 0) { h += y; y = 0; }
    if (x + w > this.w) w = this.w - x;
    if (y + h > this.h) h = this.h - y;
    if (w <= 0 || h <= 0) return;

    const fb = new Uint16Array(memory.buffer, fbPtr, this.w * this.h);
    const out = this.image.data;
    for (let row = 0; row < h; row++) {
      const src = (y + row) * this.w + x;
      let di = ((y + row) * this.w + x) * 4;
      for (let col = 0; col < w; col++) {
        const raw = fb[src + col]!;
        const v = ((raw >> 8) | (raw << 8)) & 0xffff; // byte-swapped: rgb565be
        const r = (v >> 11) & 0x1f;
        const g = (v >> 5) & 0x3f;
        const b = v & 0x1f;
        out[di] = (r << 3) | (r >> 2);
        out[di + 1] = (g << 2) | (g >> 4);
        out[di + 2] = (b << 3) | (b >> 2);
        di += 4;
      }
    }
    this.backCtx.putImageData(this.image, 0, 0, x, y, w, h);
  }

  paintFull(memory: WebAssembly.Memory, fbPtr: number): void {
    this.blitRect(memory, fbPtr, 0, 0, this.w, this.h);
    this.present();
  }

  paintPushes(emu: EmuExports, fbPtr: number): void {
    const n = emu.emu_push_count();
    if (n === 0) return;
    for (let i = 0; i < n; i++) {
      this.blitRect(emu.memory, fbPtr, emu.emu_push_x(i), emu.emu_push_y(i), emu.emu_push_w(i), emu.emu_push_h(i));
    }
    this.present();
  }

  private present(): void {
    if (!this.rotated) {
      this.ctx.drawImage(this.back, 0, 0, this.w, this.h, 0, 0, this.canvas.width, this.canvas.height);
      return;
    }
    // A quarter turn counterclockwise, the same direction gfx.h's own
    // landscape mapping assumes (landscape (lx, ly) -> panel
    // (PANEL_W - 1 - ly, lx)), inverted here so a landscape app is shown
    // the way it was drawn. Panel (px, py) lands at (py, PANEL_W - px).
    //
    // The destination extents are the canvas's own ROUNDED dimensions, not
    // w * scale and h * scale. That distinction cost a real bug: layout()
    // rounds the canvas size to whole device pixels but `scale` stays
    // fractional, so drawing at the fractional size left the last half-row
    // of the canvas never painted AND, worse, meant two relayouts that
    // rounded to the same canvas size could still draw the image at
    // slightly different sizes. The visible symptom was a stopwatch whose
    // reset-to-zero frame did not match its own boot frame, off by about
    // two pixels of vertical offset, which reads as a firmware bug and is
    // not one. Deriving the extents from the canvas removes the second
    // source of truth.
    this.ctx.save();
    this.ctx.translate(0, this.canvas.height);
    this.ctx.rotate(-Math.PI / 2);
    this.ctx.drawImage(this.back, 0, 0, this.w, this.h, 0, 0, this.canvas.height, this.canvas.width);
    this.ctx.restore();
  }

  // Client coordinates -> panel coordinates, clamped. One place, so a
  // pointer, a rotation and a scale can never disagree about where a
  // finger landed: this is the exact inverse of present()'s transform, and
  // it has to stay that way.
  toPanel(clientX: number, clientY: number): { x: number; y: number } {
    const rect = this.canvas.getBoundingClientRect();
    const fx = (clientX - rect.left) / rect.width;
    const fy = (clientY - rect.top) / rect.height;
    const x = this.rotated ? (1 - fy) * this.w : fx * this.w;
    const y = this.rotated ? fx * this.h : fy * this.h;
    return {
      x: Math.max(0, Math.min(this.w - 1, Math.round(x))),
      y: Math.max(0, Math.min(this.h - 1, Math.round(y))),
    };
  }
}

// ---- motion --------------------------------------------------------------
const STANDARD_GRAVITY = 9.80665;
const FILTER_TAU_MS = 200;
const SHAKE_THRESHOLD_G = 2.5;
const SHAKE_SAMPLES = 3;
const SHAKE_COOLDOWN_MS = 800;

interface Vector3 { x: number; y: number; z: number }

interface PermissionCtor { requestPermission?: () => Promise<string> }

function permissionRequesters(): (() => Promise<string>)[] {
  const out: (() => Promise<string>)[] = [];
  const orientation = window.DeviceOrientationEvent as unknown as PermissionCtor | undefined;
  const motion = window.DeviceMotionEvent as unknown as PermissionCtor | undefined;
  if (typeof orientation?.requestPermission === "function") out.push(() => orientation.requestPermission!());
  if (typeof motion?.requestPermission === "function") out.push(() => motion.requestPermission!());
  return out;
}

// The only reliable feature signal for "this is iOS Safari" a page gets:
// requestPermission() is a gate only iOS exposes on these constructors.
function isIOSMotion(): boolean {
  return permissionRequesters().length > 0;
}

// COPIED, sign for sign, from src/motion.ts's mapAccelerationToVector, and
// the reason it is copied rather than re-derived is that the signs are not
// derivable from the specs: they were VALIDATED ON A PHYSICAL IPHONE on
// 2026-08-19, and the y axis alone came back inverted from what the other
// two axes do.
//
//   - x (roll, left/right): iOS reports gravity's direction directly.
//   - y (pitch, up/down): iOS is INVERTED, i.e. it behaves like the
//     spec/support-force convention, and must be negated.
//   - z (face-up axis): gravity-direct, like x.
//
// The spec/Android convention negates all three, because its accelerometer
// reports the SUPPORT FORCE holding the device up against gravity. Both
// paths have to land on the same ABI vector (x right, y down the panel, z
// into the screen), checked against two anchors: flat face-up -> (0,0,-1),
// and upright facing the user -> (0,1,0).
//
// Getting this wrong is not a crash, it is fluid pouring toward the top of
// the screen, which reads as a physics bug rather than a sign bug. See
// gotchas.md.
export function mapAccelerationToVector(x: number, y: number, z: number, isIOS: boolean): Vector3 {
  return isIOS
    ? { x: x / STANDARD_GRAVITY, y: -y / STANDARD_GRAVITY, z: z / STANDARD_GRAVITY }
    : { x: -x / STANDARD_GRAVITY, y: -y / STANDARD_GRAVITY, z: -z / STANDARD_GRAVITY };
}

// The panel is fixed to the page, and the page rotates with the phone, so
// a device-space vector has to be turned by the screen's own orientation
// angle before it means anything in panel space. Without this, turning the
// phone sideways to read a landscape app would leave gravity pointing at
// what used to be "down".
function toPanelSpace(v: Vector3, screenDeg: number): Vector3 {
  const theta = (screenDeg * Math.PI) / 180;
  const cos = Math.cos(theta);
  const sin = Math.sin(theta);
  return { x: v.x * cos - v.y * sin, y: v.x * sin + v.y * cos, z: v.z };
}

function screenOrientationDeg(): number {
  const modern = screen.orientation?.angle;
  if (typeof modern === "number") return modern;
  const legacy = (window as Window & { orientation?: number }).orientation;
  return typeof legacy === "number" ? legacy : 0;
}

// ---- the host ------------------------------------------------------------

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

async function boot(): Promise<void> {
  const root = document.getElementById("root");
  if (!root) throw new Error("no #root");
  const moduleUrl = document.body.dataset.module;
  if (!moduleUrl) throw new Error("no data-module on <body>");

  let emu: EmuExports;
  let device: DeviceDescriptor;
  try {
    ({ emu, device } = await loadModule(moduleUrl));
  } catch (err) {
    root.textContent = `could not start: ${err instanceof Error ? err.message : String(err)}`;
    root.classList.add("failed");
    return;
  }

  root.textContent = "";
  // Whether the app in this module was built with --landscape. It is a
  // build fact, not a device fact, so it arrives on the page rather than
  // through emu_device(): the DEVICE is the same either way, and putting
  // an app's orientation into a device descriptor would be a category
  // error the sibling packs are careful not to make.
  const panel = new Panel(device.panel.w, device.panel.h, document.body.dataset.landscape === "1");
  const stage = el("div", "stage");
  stage.appendChild(panel.canvas);
  root.appendChild(stage);

  const controls = el("div", "controls");
  root.appendChild(controls);

  const fbPtr = emu.emu_fb();

  // ---- layout ------------------------------------------------------------
  function relayout(): void {
    const dpr = window.devicePixelRatio || 1;
    // visualViewport, not innerHeight: on iOS innerHeight includes the
    // area under the browser's own chrome, so a panel sized from it is
    // partly behind the toolbar. See gotchas.md.
    const vw = window.visualViewport?.width ?? window.innerWidth;
    const vh = window.visualViewport?.height ?? window.innerHeight;
    const reserved = controls.getBoundingClientRect().height + 24;
    panel.layout(vw - 8, Math.max(120, vh - reserved), dpr);
    panel.paintFull(emu.memory, fbPtr);
  }

  // ---- touch -------------------------------------------------------------
  // Pointer events, captured, with touch-action:none in the CSS: without
  // both, Safari treats a drag on the canvas as a page scroll or a
  // pull-to-refresh and the app sees the gesture stop halfway. See
  // gotchas.md.
  let activePointer: number | null = null;
  panel.canvas.addEventListener("pointerdown", (e) => {
    if (activePointer !== null) return;
    activePointer = e.pointerId;
    panel.canvas.setPointerCapture(e.pointerId);
    const p = panel.toPanel(e.clientX, e.clientY);
    emu.emu_touch(1, p.x, p.y);
    e.preventDefault();
  });
  panel.canvas.addEventListener("pointermove", (e) => {
    if (e.pointerId !== activePointer) return;
    const p = panel.toPanel(e.clientX, e.clientY);
    emu.emu_touch(1, p.x, p.y);
    e.preventDefault();
  });
  const endTouch = (e: PointerEvent): void => {
    if (e.pointerId !== activePointer) return;
    activePointer = null;
    const p = panel.toPanel(e.clientX, e.clientY);
    emu.emu_touch(0, p.x, p.y);
    e.preventDefault();
  };
  panel.canvas.addEventListener("pointerup", endTouch);
  panel.canvas.addEventListener("pointercancel", endTouch);

  // ---- buttons -----------------------------------------------------------
  // One ghost button per DECLARED button, in the order the device declares
  // them along its edge - never a hardcoded pair. They sit under the panel
  // rather than protruding from it, because there is no bezel to protrude
  // from and because anything overlapping the panel would steal the app's
  // own input surface.
  const buttons = device.buttons ?? [];
  const ordered = [...buttons.entries()].sort((a, b) => a[1].at - b[1].at);
  for (const [index, button] of ordered) {
    const node = el("button", "ghost", button.label);
    node.type = "button";
    node.dataset.buttonId = button.id;
    let downAt = 0;
    let held = false;
    const press = (e: PointerEvent): void => {
      if (held) return;
      held = true;
      downAt = performance.now();
      node.classList.add("down");
      node.setPointerCapture(e.pointerId);
      emu.emu_button(index, 1);
      e.preventDefault();
    };
    const release = (e: PointerEvent): void => {
      if (!held) return;
      held = false;
      node.classList.remove("down");
      emu.emu_button(index, 0);
      // The verdict is what a PMIC reports at release: short, or long once
      // the declared threshold passed. A button with no declared
      // longPressMs gets no verdict at all, the same as hardware that
      // cannot produce one.
      if (button.longPressMs !== undefined) {
        emu.emu_button_verdict(index, performance.now() - downAt >= button.longPressMs ? 1 : 0);
      }
      e.preventDefault();
    };
    node.addEventListener("pointerdown", press);
    node.addEventListener("pointerup", release);
    node.addEventListener("pointercancel", release);
    controls.appendChild(node);
  }

  // ---- motion ------------------------------------------------------------
  const sensors = device.sensors ?? [];
  const tiltIndex = sensors.findIndex((s) => s.kind === "vector");
  const shakeIndex = sensors.findIndex((s) => s.id === "shake" && s.kind === "event");
  const wantsMotion = (tiltIndex >= 0 && typeof emu.emu_sensor_vector === "function") || shakeIndex >= 0;
  const motionSupported = typeof window.DeviceMotionEvent !== "undefined";

  let filtered: Vector3 | null = null;
  let lastTimestamp: number | null = null;
  let shakeSamples = 0;
  let shakeCooldownUntil = 0;
  let pendingVector: Vector3 | null = null;

  function applyMotion(event: DeviceMotionEvent): void {
    const raw = event.accelerationIncludingGravity;
    if (!raw || raw.x === null || raw.y === null || raw.z === null) return;
    const v = mapAccelerationToVector(raw.x, raw.y, raw.z, isIOSMotion());

    if (!filtered) {
      filtered = { ...v };
    } else {
      const elapsed = lastTimestamp === null ? 16.7 : event.timeStamp - lastTimestamp;
      const dt = Math.max(1, Math.min(250, Number.isFinite(elapsed) && elapsed > 0 ? elapsed : 16.7));
      const alpha = dt / (FILTER_TAU_MS + dt);
      filtered.x += alpha * (v.x - filtered.x);
      filtered.y += alpha * (v.y - filtered.y);
      filtered.z += alpha * (v.z - filtered.z);
    }
    lastTimestamp = event.timeStamp;

    // The low pass is gravity; whatever the raw reading has ON TOP of it is
    // the shake. Same decomposition src/motion.ts uses, same thresholds:
    // three consecutive samples over 2.5g, then an 800ms cooldown so one
    // physical shake is one event, not twenty.
    const highPass = Math.hypot(v.x - filtered.x, v.y - filtered.y, v.z - filtered.z);
    shakeSamples = highPass >= SHAKE_THRESHOLD_G ? shakeSamples + 1 : 0;
    const now = performance.now();
    if (shakeIndex >= 0 && shakeSamples >= SHAKE_SAMPLES && now >= shakeCooldownUntil) {
      shakeCooldownUntil = now + SHAKE_COOLDOWN_MS;
      shakeSamples = 0;
      emu.emu_sensor_event(shakeIndex);
    }

    // Delivered once per animation frame, not once per sensor sample: a
    // phone fires devicemotion faster than it paints, and the firmware only
    // reads the vector inside its own tick anyway.
    pendingVector = toPanelSpace(filtered, screenOrientationDeg());
  }

  let motionOn = false;
  if (wantsMotion && motionSupported) {
    const chip = el("button", "ghost motion", "tilt");
    chip.type = "button";
    chip.addEventListener("click", () => {
      if (motionOn) {
        window.removeEventListener("devicemotion", applyMotion);
        motionOn = false;
        chip.classList.remove("on");
        chip.textContent = "tilt";
        return;
      }
      // iOS Safari only honours requestPermission() while still
      // synchronously inside the tap that triggered it, so every requester
      // is invoked before this handler yields. See gotchas.md.
      const requesters = permissionRequesters();
      if (requesters.length === 0) {
        window.addEventListener("devicemotion", applyMotion);
        motionOn = true;
        chip.classList.add("on");
        chip.textContent = "tilt on";
        return;
      }
      let requests: Promise<string>[];
      try {
        requests = requesters.map((request) => request());
      } catch {
        chip.textContent = "tilt blocked";
        chip.disabled = true;
        return;
      }
      void Promise.all(requests).then(
        (results) => {
          if (results.every((r) => r === "granted")) {
            window.addEventListener("devicemotion", applyMotion);
            motionOn = true;
            chip.classList.add("on");
            chip.textContent = "tilt on";
          } else {
            chip.textContent = "tilt blocked";
            chip.disabled = true;
          }
        },
        () => {
          chip.textContent = "tilt blocked";
          chip.disabled = true;
        }
      );
    });
    controls.appendChild(chip);
  }

  // ---- the loop ----------------------------------------------------------
  // performance.now() straight through: emu_tick takes the timestamp as an
  // argument (wasm/emu_abi.h) precisely so the firmware never reads a clock
  // of its own, which is what makes a recorded trace replay identically
  // here and in the headless harness.
  let running = true;
  let primed = false;
  function frame(): void {
    if (!running) return;
    if (pendingVector && tiltIndex >= 0 && emu.emu_sensor_vector) {
      emu.emu_sensor_vector(tiltIndex, pendingVector.x, pendingVector.y, pendingVector.z);
      pendingVector = null;
    }
    emu.emu_tick(performance.now());
    if (!primed) {
      // The pushes emu_init() produced were cleared by that first tick, so
      // the very first painted frame has to be the whole panel: an app that
      // draws its background once in enter() (chrono's colons, fluidbox's
      // black field) never pushes it again.
      panel.paintFull(emu.memory, fbPtr);
      primed = true;
    } else {
      panel.paintPushes(emu, fbPtr);
    }
    requestAnimationFrame(frame);
  }

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") {
      running = false;
    } else if (!running) {
      running = true;
      requestAnimationFrame(frame);
    }
  });

  window.addEventListener("resize", relayout);
  window.visualViewport?.addEventListener("resize", relayout);
  screen.orientation?.addEventListener?.("change", relayout);

  relayout();
  requestAnimationFrame(frame);
}

// ---- PWA -----------------------------------------------------------------
// Registered from the page, at the page's own scope, so the worker only
// ever controls this one app's directory. A failure here is logged and
// otherwise ignored: an app that cannot register a worker still runs, it
// just does not run offline.
function registerServiceWorker(): void {
  if (!("serviceWorker" in navigator)) return;
  window.addEventListener("load", () => {
    void navigator.serviceWorker.register("sw.js", { scope: "./" }).catch((err) => {
      console.log(`service worker not registered: ${err instanceof Error ? err.message : String(err)}`);
    });
  });
}

// The install hint, in the two shapes the two platforms actually offer.
// Chrome/Android fires beforeinstallprompt and lets a page trigger the
// real dialog; iOS Safari has no such event and installs only through the
// Share sheet, so the honest thing there is one line of text, shown once,
// and never a fake button that cannot do anything.
function wireInstallHint(): void {
  const hint = document.getElementById("install");
  if (!hint) return;
  const standalone =
    window.matchMedia("(display-mode: standalone)").matches ||
    (navigator as Navigator & { standalone?: boolean }).standalone === true;
  if (standalone) return;

  interface InstallPromptEvent extends Event {
    prompt(): Promise<void>;
  }
  let deferred: InstallPromptEvent | null = null;
  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault();
    deferred = e as InstallPromptEvent;
    hint.textContent = "install";
    hint.hidden = false;
  });
  hint.addEventListener("click", () => {
    if (deferred) void deferred.prompt();
  });
  if (isIOSMotion()) {
    // Same feature probe the motion path uses: iOS Safari is the browser
    // that gates devicemotion behind requestPermission, and it is also the
    // one with no install event.
    hint.textContent = "add to home screen: share, then Add to Home Screen";
    hint.hidden = false;
  }
}

registerServiceWorker();
wireInstallHint();
void boot();
