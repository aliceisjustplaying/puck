import { composeViewVectorWithQuickDeg } from "./rotate";

const STANDARD_GRAVITY = 9.80665;
const FILTER_TAU_MS = 200;
const SHAKE_THRESHOLD_G = 2.5;
const SHAKE_SAMPLES = 3;
const SHAKE_COOLDOWN_MS = 800;

interface Vector3 {
  x: number;
  y: number;
  z: number;
}

interface PermissionEventConstructor {
  requestPermission?: () => Promise<string>;
}

export interface PhoneMotionOptions {
  embed: boolean;
  stage: HTMLElement;
  getQuickDeg: () => number;
  sendVector: (x: number, y: number, z: number, source: string) => void;
  fireShake: (now: number, source: string) => void;
  onLayoutChanged: () => void;
  onOwnershipReleased: () => void;
  // Where the chip is actually APPENDED, resolved lazily (called only once
  // mount() runs, never at construction time) so main.ts can hand this a
  // getter for a row element it builds later in boot -- the embed rotate/
  // shake button cluster (main.ts's buildEmbedControls), so the chip joins
  // that SAME row instead of self-centering on its own, independent spot.
  // Optional and defaults to `stage` (this class's original, only mount
  // point) so nothing outside main.ts's embed wiring has to know this
  // exists.
  mountTo?: () => HTMLElement;
}

function motionApisAvailable(): boolean {
  return window.DeviceMotionEvent !== undefined || window.DeviceOrientationEvent !== undefined;
}

// Coarse pointer (a touch digitizer) or a nonzero touch-point count: the
// chip is a "tilt with your PHONE" control, and a desktop browser that
// merely exposes DeviceOrientationEvent/DeviceMotionEvent in the global
// scope (Chrome does, unconditionally, with no sensor behind it) must not
// be offered a control it cannot honour. Checked alongside
// motionApisAvailable() in onDeviceChanged below, never instead of it.
function isTouchCapable(): boolean {
  const coarse = typeof window.matchMedia === "function" && window.matchMedia("(pointer: coarse)").matches;
  return coarse || navigator.maxTouchPoints > 0;
}

function permissionRequesters(): (() => Promise<string>)[] {
  const out: (() => Promise<string>)[] = [];
  const orientation = window.DeviceOrientationEvent as typeof DeviceOrientationEvent & PermissionEventConstructor;
  const motion = window.DeviceMotionEvent as typeof DeviceMotionEvent & PermissionEventConstructor;
  if (typeof orientation?.requestPermission === "function") out.push(() => orientation.requestPermission!());
  if (typeof motion?.requestPermission === "function") out.push(() => motion.requestPermission!());
  return out;
}

// The only reliable feature signal for "this is iOS Safari" available to a
// web page: requestPermission() is a permission-gate API iOS Safari alone
// exposes on these two constructors (see permissionRequesters above, which
// this reuses rather than re-deriving the same check a second way).
function isIOSSafariMotion(): boolean {
  return permissionRequesters().length > 0;
}

// iOS Safari and the W3C spec (the convention Android/Chrome follow) report
// accelerationIncludingGravity with DIFFERENT sign conventions for the same
// physical pose, but NOT uniformly across all three axes. Validated on a
// physical iPhone on 2026-08-19:
//   - x (left/right, roll): iOS reports gravity's direction directly, no
//     flip needed. Confirmed correct BEFORE the y fix below: tilting the
//     phone left/right already poured the right way.
//   - y (up/down, pitch): iOS was found INVERTED on real hardware, tilting
//     the phone's top away poured the wrong way. y must be negated for iOS,
//     the same as the spec/Android path negates it.
//   - z (flat/face-up axis): unchanged, still gravity-direct, not exercised
//     by the left/right or up/down hardware test (only the face-up anchor
//     depends on it, and that anchor was never reported wrong).
// So per axis: spec/Android negates all three (its accelerometer reports
// the SUPPORT FORCE holding the device up against gravity, sign-flipped
// relative to gravity's own direction on every axis); iOS negates ONLY y,
// leaving x and z as gravity's direction directly. Two calibration anchors,
// re-derived under both conventions, both required to land on the SAME ABI
// vector (docs/abi.md's emu_sensor_vector convention: x right, y down the
// panel, z into the screen):
//   - flat, face-up on a table (gravity pulls straight down, into the
//     table -> ABI target (0, 0, -1)): spec/Android raw ~= (0, 0, +g) (the
//     table pushes back up, out through the glass) -> negate -> (0, 0, -1).
//     iOS raw ~= (0, 0, -g) (gravity's own direction, into the table) ->
//     NOT negated (z is gravity-direct on iOS) -> (0, 0, -1). Both match,
//     z is untouched by the y-only fix.
//   - upright, screen facing the user (gravity pulls straight down the
//     phone's Y axis -> ABI target (0, 1, 0)): spec/Android raw ~=
//     (0, -g, 0) (the reaction pushes back toward the top of the screen) ->
//     negate -> (0, 1, 0). iOS raw ~= (0, -g, 0) as well (empirically, the
//     y axis behaves like the spec/support-force convention on iOS too,
//     unlike x and z) -> negate y -> (0, 1, 0). Before this fix, the y
//     branch was left un-negated on the assumption iOS's raw y was
//     (0, +g, 0) (gravity-direct like x/z); that assumption was wrong,
//     which is exactly the "tilting the top away pours the wrong way"
//     report: un-negated (0, -g, 0) / g mapped to (0, -1, 0), the inverse
//     of the (0, 1, 0) target.
export function mapAccelerationToVector(x: number, y: number, z: number, isIOS: boolean): Vector3 {
  return isIOS
    ? { x: x / STANDARD_GRAVITY, y: -y / STANDARD_GRAVITY, z: z / STANDARD_GRAVITY }
    : { x: -x / STANDARD_GRAVITY, y: -y / STANDARD_GRAVITY, z: -z / STANDARD_GRAVITY };
}

// DeviceMotion uses x right, y toward the top of the natural portrait
// screen, and z out through the glass. Convenience wrapper over
// mapAccelerationToVector, pinned to the spec/Android convention (isIOS =
// false): kept as its own export because scripts/verify-motion.ts calls it
// directly, OUTSIDE a browser (there is no `window` there to feature-detect
// against), to predict the panel gravity its synthetic devicemotion events
// should produce - see this file's onDeviceMotion handler below for the
// real, convention-detecting call site a live page actually uses.
export function deviceMotionToAbiGravity(x: number, y: number, z: number): Vector3 {
  return mapAccelerationToVector(x, y, z, false);
}

// DeviceOrientation's beta/gamma angles are a lower-fidelity fallback for
// browsers that expose orientation but no accelerationIncludingGravity.
// The formula preserves the same two calibration anchors as the motion
// path: beta=gamma=0 is face-up, beta=90 and gamma=0 is upright.
export function deviceOrientationToAbiGravity(betaDeg: number, gammaDeg: number): Vector3 {
  const beta = (betaDeg * Math.PI) / 180;
  const gamma = (gammaDeg * Math.PI) / 180;
  return {
    x: Math.sin(gamma) * Math.cos(beta),
    y: Math.sin(beta),
    z: -Math.cos(beta) * Math.cos(gamma),
  };
}

export function composePhoneVector(
  deviceVector: Vector3,
  screenDeg: number,
  quickDeg: number
): Vector3 {
  const theta = (screenDeg * Math.PI) / 180;
  const cos = Math.cos(theta);
  const sin = Math.sin(theta);
  const view = {
    x: deviceVector.x * cos - deviceVector.y * sin,
    y: deviceVector.x * sin + deviceVector.y * cos,
    z: deviceVector.z,
  };
  return composeViewVectorWithQuickDeg(view, quickDeg);
}

function screenOrientationDeg(): number {
  const modern = screen.orientation?.angle;
  if (typeof modern === "number") return modern;
  const legacy = (window as Window & { orientation?: number }).orientation;
  return typeof legacy === "number" ? legacy : 0;
}

export class PhoneMotion {
  private chip: HTMLButtonElement | null = null;
  private hasShake = false;
  private active = false;
  private blocked = false;
  private listening = false;
  private filtered: Vector3 | null = null;
  private latest: Vector3 | null = null;
  private lastMotionTimestamp: number | null = null;
  private motionReadingSeen = false;
  private lastOrientation: Vector3 | null = null;
  private raf = 0;
  private shakeSamples = 0;
  private shakeCooldownUntil = 0;

  constructor(private readonly opts: PhoneMotionOptions) {}

  isActive(): boolean {
    return this.active;
  }

  onDeviceChanged(hasVector: boolean, hasShake: boolean): void {
    this.hasShake = hasShake;
    const eligible = this.opts.embed && hasVector && motionApisAvailable() && isTouchCapable();
    if (!eligible) {
      this.unmount();
      return;
    }
    if (!this.chip) this.mount();
    if (this.active) {
      this.resumeIfVisible();
      this.scheduleFlush();
    }
  }

  onQuickRotationChanged(): void {
    if (this.active) this.scheduleFlush();
  }

  private mount(): void {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.id = "motionChip";
    chip.className = "motion-chip chrome-btn";
    chip.dataset.state = this.blocked ? "blocked" : "idle";
    chip.textContent = this.blocked ? "tilt blocked in Safari settings" : "tilt with your phone";
    chip.disabled = this.blocked;
    chip.addEventListener("click", this.onChipClick);
    (this.opts.mountTo ? this.opts.mountTo() : this.opts.stage).appendChild(chip);
    this.opts.stage.classList.add("motion-available");
    this.chip = chip;
    document.addEventListener("visibilitychange", this.onVisibilityChange);
    window.addEventListener("pagehide", this.onPageHide);
    window.addEventListener("pageshow", this.onPageShow);
    this.opts.onLayoutChanged();
  }

  private unmount(): void {
    const wasActive = this.active;
    this.active = false;
    this.suspend();
    if (this.chip) {
      this.chip.removeEventListener("click", this.onChipClick);
      this.chip.remove();
      this.chip = null;
    }
    this.opts.stage.classList.remove("motion-available");
    document.removeEventListener("visibilitychange", this.onVisibilityChange);
    window.removeEventListener("pagehide", this.onPageHide);
    window.removeEventListener("pageshow", this.onPageShow);
    if (wasActive) this.opts.onOwnershipReleased();
    this.opts.onLayoutChanged();
  }

  private readonly onChipClick = (): void => {
    if (this.blocked) return;
    if (this.active) {
      this.stop();
      return;
    }

    const requesters = permissionRequesters();
    if (requesters.length === 0) {
      this.start();
      return;
    }

    // Every request is invoked before this handler yields. iOS Safari only
    // honours requestPermission() while it is still synchronously inside
    // the originating tap gesture.
    let requests: Promise<string>[];
    try {
      requests = requesters.map((request) => request());
    } catch {
      this.block();
      return;
    }
    if (this.chip) {
      this.chip.textContent = "requesting phone tilt...";
      this.chip.disabled = true;
    }
    void Promise.all(requests).then(
      (results) => {
        if (results.every((result) => result === "granted")) this.start();
        else this.block();
      },
      () => this.block()
    );
  };

  private start(): void {
    this.active = true;
    if (this.chip) {
      this.chip.dataset.state = "active";
      this.chip.textContent = "phone tilt on";
      this.chip.disabled = false;
      this.chip.classList.add("active");
    }
    this.resumeIfVisible();
  }

  private stop(): void {
    this.active = false;
    this.suspend();
    if (this.chip) {
      this.chip.dataset.state = "idle";
      this.chip.textContent = "tilt with your phone";
      this.chip.classList.remove("active");
    }
    this.opts.onOwnershipReleased();
  }

  private block(): void {
    this.active = false;
    this.blocked = true;
    this.suspend();
    if (this.chip) {
      this.chip.dataset.state = "blocked";
      this.chip.textContent = "tilt blocked in Safari settings";
      this.chip.classList.remove("active");
      this.chip.disabled = true;
    }
  }

  private resumeIfVisible(): void {
    if (!this.active || document.visibilityState === "hidden" || this.listening) return;
    window.addEventListener("devicemotion", this.onDeviceMotion);
    window.addEventListener("deviceorientation", this.onDeviceOrientation);
    this.listening = true;
  }

  private suspend(): void {
    if (this.listening) {
      window.removeEventListener("devicemotion", this.onDeviceMotion);
      window.removeEventListener("deviceorientation", this.onDeviceOrientation);
      this.listening = false;
    }
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.filtered = null;
    this.latest = null;
    this.lastMotionTimestamp = null;
    this.motionReadingSeen = false;
    this.lastOrientation = null;
    this.shakeSamples = 0;
  }

  private readonly onVisibilityChange = (): void => {
    if (document.visibilityState === "hidden") this.suspend();
    else this.resumeIfVisible();
  };

  private readonly onPageHide = (): void => this.suspend();
  private readonly onPageShow = (): void => this.resumeIfVisible();

  private readonly onDeviceMotion = (event: DeviceMotionEvent): void => {
    const raw = event.accelerationIncludingGravity;
    if (raw && raw.x !== null && raw.y !== null && raw.z !== null) {
      this.motionReadingSeen = true;
      this.ingestMotion(mapAccelerationToVector(raw.x, raw.y, raw.z, isIOSSafariMotion()), event.timeStamp);
    } else if (this.lastOrientation) {
      this.ingestGravity(this.lastOrientation, event.timeStamp);
    }
  };

  private readonly onDeviceOrientation = (event: DeviceOrientationEvent): void => {
    if (event.beta === null || event.gamma === null) return;
    this.lastOrientation = deviceOrientationToAbiGravity(event.beta, event.gamma);
    if (!this.motionReadingSeen) this.ingestGravity(this.lastOrientation, event.timeStamp);
  };

  private ingestMotion(raw: Vector3, timestamp: number): void {
    this.ingestGravity(raw, timestamp);
    if (!this.filtered) return;
    const highPass = Math.hypot(raw.x - this.filtered.x, raw.y - this.filtered.y, raw.z - this.filtered.z);
    if (highPass >= SHAKE_THRESHOLD_G) this.shakeSamples++;
    else this.shakeSamples = 0;

    const now = performance.now();
    if (this.hasShake && this.shakeSamples >= SHAKE_SAMPLES && now >= this.shakeCooldownUntil) {
      this.shakeCooldownUntil = now + SHAKE_COOLDOWN_MS;
      this.shakeSamples = 0;
      this.opts.fireShake(now, "phone shake");
    }
  }

  private ingestGravity(raw: Vector3, timestamp: number): void {
    if (!this.filtered) {
      this.filtered = { ...raw };
    } else {
      const elapsed = this.lastMotionTimestamp === null ? 16.7 : timestamp - this.lastMotionTimestamp;
      const dt = Math.max(1, Math.min(250, Number.isFinite(elapsed) && elapsed > 0 ? elapsed : 16.7));
      const alpha = dt / (FILTER_TAU_MS + dt);
      this.filtered.x += alpha * (raw.x - this.filtered.x);
      this.filtered.y += alpha * (raw.y - this.filtered.y);
      this.filtered.z += alpha * (raw.z - this.filtered.z);
    }
    this.lastMotionTimestamp = timestamp;
    this.latest = { ...this.filtered };
    this.scheduleFlush();
  }

  private scheduleFlush(): void {
    if (!this.active || !this.latest || this.raf) return;
    this.raf = requestAnimationFrame(() => {
      this.raf = 0;
      if (!this.active || !this.latest || document.visibilityState === "hidden") return;
      const panel = composePhoneVector(this.latest, screenOrientationDeg(), this.opts.getQuickDeg());
      this.opts.sendVector(panel.x, panel.y, panel.z, "phone tilt");
    });
  }
}

// ---- desktop drag-as-accelerometer -----------------------------------
// On a fine (non-touch) pointer, in embed mode, with no real phone
// streaming its own motion (that always wins - see isEligible below),
// grabbing the device BEZEL - never the panel, which is the app's own
// input surface (main.ts's wirePanelInput) and must never be intercepted -
// and dragging it simulates the phone's accelerometer, like a pendulum:
// the bounded on-screen displacement becomes a tilt angle, composed
// through the exact same view-rotation math PhoneMotion already uses
// (composeViewVectorWithQuickDeg, rotate.ts) and delivered through the
// exact same sendVector path passed in via opts - never a second, forked
// vector-sending path.
//
// This class owns the bezel's own pointerdown/move/up/cancel listeners and,
// only for a gesture it decides to claim (see onPointerDown below), calls
// stopImmediatePropagation() to keep device.ts's makeDraggable listener -
// registered on the SAME bezel element, afterwards, in main.ts's
// wireStaticUI - from also reacting to the same gesture as a free,
// unbounded reposition. The two behaviours must never both apply to one
// drag. Every gesture this class does not claim (dev UI, touch, real phone
// motion already streaming, a device with neither a vector nor a shake
// sensor declared) is left completely untouched: the event is never even
// looked at, and makeDraggable's own existing behaviour is exactly what
// runs, byte for byte the same as before this class existed. The one
// accepted side effect of claiming a gesture: stopImmediatePropagation also
// keeps it from bubbling to main.ts's document-level audio-unlock listener,
// which is fine, since that unlock is idempotent and only ever needs ANY
// one gesture to have happened, not specifically this one.
const DRAG_MAX_RADIUS_PX = 40;
const DRAG_MAX_TILT_DEG = 60;
const DRAG_SPRING_MS = 200;

export interface DragMotionOptions {
  bezel: HTMLElement;
  getQuickDeg: () => number;
  sendVector: (x: number, y: number, z: number, source: string) => void;
  fireShake: (now: number, source: string) => void;
  // Shares main.ts's own puckDragShake WindowShakeDetector instance (and,
  // critically, its cooldown) rather than standing up a second, independent
  // timer for what is fundamentally the same "fast back-and-forth drag"
  // gesture the dev UI's own free bezel drag already detects.
  pollDragShake: (clientX: number, clientY: number, now: number, suppressed: boolean) => boolean;
  isEligible: () => boolean; // embed mode, and no real phone motion currently streaming
  hasVector: () => boolean;
  hasShake: () => boolean;
  onOffsetChanged: (dx: number, dy: number) => void; // bounded, px - feeds main.ts's applyRotation
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}
function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}
function easeOutCubic(t: number): number {
  const u = 1 - t;
  return 1 - u * u * u;
}

export class DragMotion {
  private capturing = false;
  private activePointerId: number | null = null;
  private startX = 0;
  private startY = 0;
  private offsetX = 0;
  private offsetY = 0;
  private lastVector: Vector3 = { x: 0, y: 1, z: 0 };
  private springRaf = 0;

  constructor(private readonly opts: DragMotionOptions) {
    opts.bezel.addEventListener("pointerdown", this.onPointerDown);
    opts.bezel.addEventListener("pointermove", this.onPointerMove);
    opts.bezel.addEventListener("pointerup", this.onPointerUp);
    opts.bezel.addEventListener("pointercancel", this.onPointerUp);
  }

  // The view-space vector the panel rests at when nobody is dragging: the
  // same (0,1,0) upright anchor PhoneMotion's own calibration uses,
  // composed through the current rotation - identical to what
  // main.ts's sendGravityForRotation/gravityForQuickDeg already send, just
  // expressed through composeViewVectorWithQuickDeg directly since that is
  // the one math path this whole feature is required to share.
  private baselineVector(): Vector3 {
    return composeViewVectorWithQuickDeg({ x: 0, y: 1, z: 0 }, this.opts.getQuickDeg());
  }

  private readonly onPointerDown = (e: PointerEvent): void => {
    if (e.target !== this.opts.bezel) return; // bare plastic only, exactly device.ts's own makeDraggable rule
    if (isTouchCapable()) return; // fine pointer only - a touch drag is the dev UI's plain free-drag, untouched
    if (!this.opts.isEligible() || !(this.opts.hasVector() || this.opts.hasShake())) return;
    if (this.springRaf) {
      cancelAnimationFrame(this.springRaf);
      this.springRaf = 0;
    }
    this.capturing = true;
    this.activePointerId = e.pointerId;
    this.startX = e.clientX;
    this.startY = e.clientY;
    this.opts.bezel.setPointerCapture(e.pointerId);
    e.stopImmediatePropagation();
    e.preventDefault();
    this.updateFromClient(e.clientX, e.clientY, performance.now());
  };

  private readonly onPointerMove = (e: PointerEvent): void => {
    if (!this.capturing || e.pointerId !== this.activePointerId) return;
    e.stopImmediatePropagation();
    this.updateFromClient(e.clientX, e.clientY, performance.now());
  };

  private readonly onPointerUp = (e: PointerEvent): void => {
    if (!this.capturing || e.pointerId !== this.activePointerId) return;
    e.stopImmediatePropagation();
    this.capturing = false;
    this.activePointerId = null;
    this.springBack();
  };

  private updateFromClient(clientX: number, clientY: number, now: number): void {
    const dx = clientX - this.startX;
    const dy = clientY - this.startY;
    const dist = Math.hypot(dx, dy);
    const clamped = Math.min(dist, DRAG_MAX_RADIUS_PX);
    const ux = dist > 0 ? dx / dist : 0;
    const uy = dist > 0 ? dy / dist : 0;
    this.offsetX = ux * clamped;
    this.offsetY = uy * clamped;
    this.opts.onOffsetChanged(this.offsetX, this.offsetY);

    if (this.opts.hasVector()) {
      const ratio = clamped / DRAG_MAX_RADIUS_PX;
      const tilt = (ratio * DRAG_MAX_TILT_DEG * Math.PI) / 180;
      // A pendulum: the baseline "hanging straight down" view vector
      // (0,1,0) tilted toward the drag direction - sideways drag (ux)
      // swings gravity into the panel's x axis, up/down drag (uy) swings
      // it into z (forward/back, the same axis the flat-face-up anchor
      // uses), and y shrinks as the pendulum swings away from straight
      // down. Composed through composeViewVectorWithQuickDeg exactly like
      // every other view-space vector this file produces.
      const view: Vector3 = { x: Math.sin(tilt) * ux, y: Math.cos(tilt), z: Math.sin(tilt) * uy };
      this.lastVector = composeViewVectorWithQuickDeg(view, this.opts.getQuickDeg());
      this.opts.sendVector(this.lastVector.x, this.lastVector.y, this.lastVector.z, "drag tilt");
    }
    if (this.opts.hasShake() && this.opts.pollDragShake(clientX, clientY, now, false)) {
      this.opts.fireShake(now, "drag shake");
    }
  }

  // Springs the visual offset back to centre and ramps the sent vector back
  // to baseline over the SAME ~200ms window, eased - never a snap in either
  // channel. Cancelled and restarted cleanly if a new drag begins mid-spring
  // (onPointerDown above).
  private springBack(): void {
    const fromX = this.offsetX;
    const fromY = this.offsetY;
    const fromVector = this.lastVector;
    const toVector = this.baselineVector();
    const start = performance.now();
    const step = (now: number): void => {
      const t = clamp((now - start) / DRAG_SPRING_MS, 0, 1);
      const eased = easeOutCubic(t);
      this.offsetX = lerp(fromX, 0, eased);
      this.offsetY = lerp(fromY, 0, eased);
      this.opts.onOffsetChanged(this.offsetX, this.offsetY);
      if (this.opts.hasVector()) {
        this.lastVector = {
          x: lerp(fromVector.x, toVector.x, eased),
          y: lerp(fromVector.y, toVector.y, eased),
          z: lerp(fromVector.z, toVector.z, eased),
        };
        this.opts.sendVector(this.lastVector.x, this.lastVector.y, this.lastVector.z, "drag tilt release");
      }
      if (t < 1) {
        this.springRaf = requestAnimationFrame(step);
      } else {
        this.springRaf = 0;
      }
    };
    this.springRaf = requestAnimationFrame(step);
  }
}
