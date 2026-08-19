// packs/web/host/host.ts
function importObject(memoryRef) {
  const decoder = new TextDecoder;
  return {
    env: {
      sinf: Math.sin,
      cosf: Math.cos,
      atan2f: Math.atan2,
      sqrtf: Math.sqrt,
      fabsf: Math.abs,
      floorf: Math.floor,
      fmodf: (a, b) => a % b,
      powf: Math.pow,
      expf: Math.exp,
      js_log: (ptr, len) => {
        const memory = memoryRef.current;
        if (!memory)
          return;
        console.log(decoder.decode(new Uint8Array(memory.buffer, ptr, len)));
      }
    }
  };
}
function readCString(memory, ptr) {
  const bytes = new Uint8Array(memory.buffer);
  let end = ptr;
  while (end < bytes.length && bytes[end] !== 0)
    end++;
  return new TextDecoder().decode(bytes.subarray(ptr, end));
}
async function loadModule(url) {
  const res = await fetch(url);
  if (!res.ok)
    throw new Error(`could not load ${url} (HTTP ${res.status})`);
  const bytes = await res.arrayBuffer();
  const memoryRef = {};
  const { instance } = await WebAssembly.instantiate(bytes, importObject(memoryRef));
  const emu = instance.exports;
  memoryRef.current = emu.memory;
  if (!emu.memory)
    throw new Error("wasm module exports no memory; the panel is read through it");
  if (emu.emu_init() === 0)
    throw new Error("emu_init() returned 0");
  const device = JSON.parse(readCString(emu.memory, emu.emu_device()));
  if (!device.panel || !device.panel.w || !device.panel.h)
    throw new Error("emu_device() declared no panel");
  return { emu, device };
}

class Panel {
  w;
  h;
  rotated;
  canvas;
  ctx;
  back;
  backCtx;
  image;
  cssW = 0;
  cssH = 0;
  constructor(w, h, rotated) {
    this.w = w;
    this.h = h;
    this.rotated = rotated;
    this.canvas = document.createElement("canvas");
    this.canvas.id = "panel";
    const ctx = this.canvas.getContext("2d", { alpha: false });
    if (!ctx)
      throw new Error("no 2d canvas context");
    this.ctx = ctx;
    this.back = document.createElement("canvas");
    this.back.width = w;
    this.back.height = h;
    const backCtx = this.back.getContext("2d", { alpha: false, willReadFrequently: false });
    if (!backCtx)
      throw new Error("no 2d canvas context");
    this.backCtx = backCtx;
    this.image = backCtx.createImageData(w, h);
    const data = this.image.data;
    for (let i = 3;i < data.length; i += 4)
      data[i] = 255;
  }
  static SNAP_KEEP = 0.8;
  layout(availW, availH, dpr) {
    const wantW = this.rotated ? this.h : this.w;
    const wantH = this.rotated ? this.w : this.h;
    const fitDevice = Math.min(availW * dpr / wantW, availH * dpr / wantH);
    const floored = Math.floor(fitDevice);
    const scale = floored >= 1 && floored / fitDevice >= Panel.SNAP_KEEP ? floored : fitDevice;
    this.canvas.width = Math.max(1, Math.round(wantW * scale));
    this.canvas.height = Math.max(1, Math.round(wantH * scale));
    this.cssW = this.canvas.width / dpr;
    this.cssH = this.canvas.height / dpr;
    this.canvas.style.width = `${this.cssW}px`;
    this.canvas.style.height = `${this.cssH}px`;
    this.ctx.imageSmoothingEnabled = false;
  }
  blitRect(memory, fbPtr, x, y, w, h) {
    if (w <= 0 || h <= 0)
      return;
    if (x < 0) {
      w += x;
      x = 0;
    }
    if (y < 0) {
      h += y;
      y = 0;
    }
    if (x + w > this.w)
      w = this.w - x;
    if (y + h > this.h)
      h = this.h - y;
    if (w <= 0 || h <= 0)
      return;
    const fb = new Uint16Array(memory.buffer, fbPtr, this.w * this.h);
    const out = this.image.data;
    for (let row = 0;row < h; row++) {
      const src = (y + row) * this.w + x;
      let di = ((y + row) * this.w + x) * 4;
      for (let col = 0;col < w; col++) {
        const raw = fb[src + col];
        const v = (raw >> 8 | raw << 8) & 65535;
        const r = v >> 11 & 31;
        const g = v >> 5 & 63;
        const b = v & 31;
        out[di] = r << 3 | r >> 2;
        out[di + 1] = g << 2 | g >> 4;
        out[di + 2] = b << 3 | b >> 2;
        di += 4;
      }
    }
    this.backCtx.putImageData(this.image, 0, 0, x, y, w, h);
  }
  paintFull(memory, fbPtr) {
    this.blitRect(memory, fbPtr, 0, 0, this.w, this.h);
    this.present();
  }
  paintPushes(emu, fbPtr) {
    const n = emu.emu_push_count();
    if (n === 0)
      return;
    for (let i = 0;i < n; i++) {
      this.blitRect(emu.memory, fbPtr, emu.emu_push_x(i), emu.emu_push_y(i), emu.emu_push_w(i), emu.emu_push_h(i));
    }
    this.present();
  }
  present() {
    if (!this.rotated) {
      this.ctx.drawImage(this.back, 0, 0, this.w, this.h, 0, 0, this.canvas.width, this.canvas.height);
      return;
    }
    this.ctx.save();
    this.ctx.translate(0, this.canvas.height);
    this.ctx.rotate(-Math.PI / 2);
    this.ctx.drawImage(this.back, 0, 0, this.w, this.h, 0, 0, this.canvas.height, this.canvas.width);
    this.ctx.restore();
  }
  toPanel(clientX, clientY) {
    const rect = this.canvas.getBoundingClientRect();
    const fx = (clientX - rect.left) / rect.width;
    const fy = (clientY - rect.top) / rect.height;
    const x = this.rotated ? (1 - fy) * this.w : fx * this.w;
    const y = this.rotated ? fx * this.h : fy * this.h;
    return {
      x: Math.max(0, Math.min(this.w - 1, Math.round(x))),
      y: Math.max(0, Math.min(this.h - 1, Math.round(y)))
    };
  }
}
var STANDARD_GRAVITY = 9.80665;
var FILTER_TAU_MS = 200;
var SHAKE_THRESHOLD_G = 2.5;
var SHAKE_SAMPLES = 3;
var SHAKE_COOLDOWN_MS = 800;
function permissionRequesters() {
  const out = [];
  const orientation = window.DeviceOrientationEvent;
  const motion = window.DeviceMotionEvent;
  if (typeof orientation?.requestPermission === "function")
    out.push(() => orientation.requestPermission());
  if (typeof motion?.requestPermission === "function")
    out.push(() => motion.requestPermission());
  return out;
}
function isIOSMotion() {
  return permissionRequesters().length > 0;
}
function mapAccelerationToVector(x, y, z, isIOS) {
  return isIOS ? { x: x / STANDARD_GRAVITY, y: -y / STANDARD_GRAVITY, z: z / STANDARD_GRAVITY } : { x: -x / STANDARD_GRAVITY, y: -y / STANDARD_GRAVITY, z: -z / STANDARD_GRAVITY };
}
function toPanelSpace(v, screenDeg) {
  const theta = screenDeg * Math.PI / 180;
  const cos = Math.cos(theta);
  const sin = Math.sin(theta);
  return { x: v.x * cos - v.y * sin, y: v.x * sin + v.y * cos, z: v.z };
}
function screenOrientationDeg() {
  const modern = screen.orientation?.angle;
  if (typeof modern === "number")
    return modern;
  const legacy = window.orientation;
  return typeof legacy === "number" ? legacy : 0;
}
function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className)
    node.className = className;
  if (text !== undefined)
    node.textContent = text;
  return node;
}
async function boot() {
  const root = document.getElementById("root");
  if (!root)
    throw new Error("no #root");
  const moduleUrl = document.body.dataset.module;
  if (!moduleUrl)
    throw new Error("no data-module on <body>");
  let emu;
  let device;
  try {
    ({ emu, device } = await loadModule(moduleUrl));
  } catch (err) {
    root.textContent = `could not start: ${err instanceof Error ? err.message : String(err)}`;
    root.classList.add("failed");
    return;
  }
  root.textContent = "";
  const panel = new Panel(device.panel.w, device.panel.h, document.body.dataset.landscape === "1");
  const stage = el("div", "stage");
  stage.appendChild(panel.canvas);
  root.appendChild(stage);
  const controls = el("div", "controls");
  root.appendChild(controls);
  const fbPtr = emu.emu_fb();
  function relayout() {
    const dpr = window.devicePixelRatio || 1;
    const vw = window.visualViewport?.width ?? window.innerWidth;
    const vh = window.visualViewport?.height ?? window.innerHeight;
    const reserved = controls.getBoundingClientRect().height + 24;
    panel.layout(vw - 8, Math.max(120, vh - reserved), dpr);
    panel.paintFull(emu.memory, fbPtr);
  }
  let activePointer = null;
  panel.canvas.addEventListener("pointerdown", (e) => {
    if (activePointer !== null)
      return;
    activePointer = e.pointerId;
    panel.canvas.setPointerCapture(e.pointerId);
    const p = panel.toPanel(e.clientX, e.clientY);
    emu.emu_touch(1, p.x, p.y);
    e.preventDefault();
  });
  panel.canvas.addEventListener("pointermove", (e) => {
    if (e.pointerId !== activePointer)
      return;
    const p = panel.toPanel(e.clientX, e.clientY);
    emu.emu_touch(1, p.x, p.y);
    e.preventDefault();
  });
  const endTouch = (e) => {
    if (e.pointerId !== activePointer)
      return;
    activePointer = null;
    const p = panel.toPanel(e.clientX, e.clientY);
    emu.emu_touch(0, p.x, p.y);
    e.preventDefault();
  };
  panel.canvas.addEventListener("pointerup", endTouch);
  panel.canvas.addEventListener("pointercancel", endTouch);
  const buttons = device.buttons ?? [];
  const ordered = [...buttons.entries()].sort((a, b) => a[1].at - b[1].at);
  for (const [index, button] of ordered) {
    const node = el("button", "ghost", button.label);
    node.type = "button";
    node.dataset.buttonId = button.id;
    let downAt = 0;
    let held = false;
    const press = (e) => {
      if (held)
        return;
      held = true;
      downAt = performance.now();
      node.classList.add("down");
      node.setPointerCapture(e.pointerId);
      emu.emu_button(index, 1);
      e.preventDefault();
    };
    const release = (e) => {
      if (!held)
        return;
      held = false;
      node.classList.remove("down");
      emu.emu_button(index, 0);
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
  const sensors = device.sensors ?? [];
  const tiltIndex = sensors.findIndex((s) => s.kind === "vector");
  const shakeIndex = sensors.findIndex((s) => s.id === "shake" && s.kind === "event");
  const wantsMotion = tiltIndex >= 0 && typeof emu.emu_sensor_vector === "function" || shakeIndex >= 0;
  const motionSupported = typeof window.DeviceMotionEvent !== "undefined";
  let filtered = null;
  let lastTimestamp = null;
  let shakeSamples = 0;
  let shakeCooldownUntil = 0;
  let pendingVector = null;
  function applyMotion(event) {
    const raw = event.accelerationIncludingGravity;
    if (!raw || raw.x === null || raw.y === null || raw.z === null)
      return;
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
    const highPass = Math.hypot(v.x - filtered.x, v.y - filtered.y, v.z - filtered.z);
    shakeSamples = highPass >= SHAKE_THRESHOLD_G ? shakeSamples + 1 : 0;
    const now = performance.now();
    if (shakeIndex >= 0 && shakeSamples >= SHAKE_SAMPLES && now >= shakeCooldownUntil) {
      shakeCooldownUntil = now + SHAKE_COOLDOWN_MS;
      shakeSamples = 0;
      emu.emu_sensor_event(shakeIndex);
    }
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
      const requesters = permissionRequesters();
      if (requesters.length === 0) {
        window.addEventListener("devicemotion", applyMotion);
        motionOn = true;
        chip.classList.add("on");
        chip.textContent = "tilt on";
        return;
      }
      let requests;
      try {
        requests = requesters.map((request) => request());
      } catch {
        chip.textContent = "tilt blocked";
        chip.disabled = true;
        return;
      }
      Promise.all(requests).then((results) => {
        if (results.every((r) => r === "granted")) {
          window.addEventListener("devicemotion", applyMotion);
          motionOn = true;
          chip.classList.add("on");
          chip.textContent = "tilt on";
        } else {
          chip.textContent = "tilt blocked";
          chip.disabled = true;
        }
      }, () => {
        chip.textContent = "tilt blocked";
        chip.disabled = true;
      });
    });
    controls.appendChild(chip);
  }
  let running = true;
  let primed = false;
  function frame() {
    if (!running)
      return;
    if (pendingVector && tiltIndex >= 0 && emu.emu_sensor_vector) {
      emu.emu_sensor_vector(tiltIndex, pendingVector.x, pendingVector.y, pendingVector.z);
      pendingVector = null;
    }
    emu.emu_tick(performance.now());
    if (!primed) {
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
function registerServiceWorker() {
  if (!("serviceWorker" in navigator))
    return;
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("sw.js", { scope: "./" }).catch((err) => {
      console.log(`service worker not registered: ${err instanceof Error ? err.message : String(err)}`);
    });
  });
}
function wireInstallHint() {
  const hint = document.getElementById("install");
  if (!hint)
    return;
  const standalone = window.matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;
  if (standalone)
    return;
  let deferred = null;
  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault();
    deferred = e;
    hint.textContent = "install";
    hint.hidden = false;
  });
  hint.addEventListener("click", () => {
    if (deferred)
      deferred.prompt();
  });
  if (isIOSMotion()) {
    hint.textContent = "add to home screen: share, then Add to Home Screen";
    hint.hidden = false;
  }
}
registerServiceWorker();
wireInstallHint();
boot();
export {
  mapAccelerationToVector
};
