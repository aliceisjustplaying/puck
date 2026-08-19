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
}

function motionApisAvailable(): boolean {
  return window.DeviceMotionEvent !== undefined || window.DeviceOrientationEvent !== undefined;
}

function permissionRequesters(): (() => Promise<string>)[] {
  const out: (() => Promise<string>)[] = [];
  const orientation = window.DeviceOrientationEvent as typeof DeviceOrientationEvent & PermissionEventConstructor;
  const motion = window.DeviceMotionEvent as typeof DeviceMotionEvent & PermissionEventConstructor;
  if (typeof orientation?.requestPermission === "function") out.push(() => orientation.requestPermission!());
  if (typeof motion?.requestPermission === "function") out.push(() => motion.requestPermission!());
  return out;
}

// DeviceMotion uses x right, y toward the top of the natural portrait
// screen, and z out through the glass. accelerationIncludingGravity is the
// accelerometer's support-force reading, opposite the gravity direction we
// need. Negating all three axes therefore gives the ABI anchors directly:
// face-up is (0, 0, -1), and upright portrait is (0, 1, 0).
export function deviceMotionToAbiGravity(x: number, y: number, z: number): Vector3 {
  return { x: -x / STANDARD_GRAVITY, y: -y / STANDARD_GRAVITY, z: -z / STANDARD_GRAVITY };
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
    const eligible = this.opts.embed && hasVector && motionApisAvailable();
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
    this.opts.stage.appendChild(chip);
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
      this.ingestMotion(deviceMotionToAbiGravity(raw.x, raw.y, raw.z), event.timeStamp);
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
