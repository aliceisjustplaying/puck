// screens.ts: writes the README's screenshots by running the real firmware.
//
//   bun run packs/rp2350-touch-amoled-18/wasm/build.ts        # once, produces wasm/dist/emu.wasm
//   bun run packs/rp2350-touch-amoled-18/tools/screens.ts
//
// Every image under packs/rp2350-touch-amoled-18/preview/screen-*.png comes out of this file. They
// are not mockups and not a drawing of what the apps look like: this loads
// wasm/dist/emu.wasm, which is the firmware's own C (runtime_core.c, gfx.c
// and every app under firmware/apps/) compiled a second time, drives it
// through emu_tick() with a synthetic clock exactly the way a person's finger
// would, and dumps emu_fb() straight to a PNG. If an app's layout changes,
// re-run this and the README changes with it.
//
// What this CANNOT show, and it is the same caveat decision 0003 puts on the
// emulator itself: timing. These are pixel-accurate and say nothing about how
// the device feels in a hand.
//
// The panel is physically 368x448 (portrait) and every app draws landscape
// into it, because the puck is held sideways. So the framebuffer is rotated
// here before writing, to show what a person actually sees rather than what
// the memory happens to hold.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { deflateSync } from "node:zlib";

const REPO_ROOT = join(import.meta.dir, "..", "..", "..");
const WASM_PATH = join(REPO_ROOT, "wasm", "dist", "emu.wasm");
const OUT_DIR = join(import.meta.dir, "..", "preview");

const PANEL_W = 368;
const PANEL_H = 448;

// g_apps[] in firmware/runtime/runtime.c, and the menu's own sentinel.
const APP_CHRONO = 0;
const APP_SKETCH = 1;
const APP_TIMER = 2;
const APP_MENU = -1; // emu_app_current() while the picture menu is open

const BTN_BOOT = 0;
const BTN_PWR = 1;

// ---- PNG (RGB8, no alpha) -------------------------------------------------
// Bun.deflateSync and node:zlib's deflateSync differ here: PNG's IDAT wants a
// zlib stream, which node:zlib already produces, so nothing has to be wrapped
// by hand (contrast harness/png.ts, which works around Bun's raw DEFLATE).
function crc32(buf: Uint8Array): number {
    let c = ~0;
    for (let i = 0; i < buf.length; i++) {
        c ^= buf[i];
        for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
    }
    return ~c >>> 0;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
    const out = new Uint8Array(12 + data.length);
    const dv = new DataView(out.buffer);
    dv.setUint32(0, data.length);
    for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
    out.set(data, 8);
    dv.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
    return out;
}

function writePNG(path: string, w: number, h: number, rgb: Uint8Array): void {
    const raw = new Uint8Array(h * (1 + w * 3));
    for (let y = 0; y < h; y++) {
        raw[y * (1 + w * 3)] = 0; // filter: none
        raw.set(rgb.subarray(y * w * 3, (y + 1) * w * 3), y * (1 + w * 3) + 1);
    }
    const ihdr = new Uint8Array(13);
    const dv = new DataView(ihdr.buffer);
    dv.setUint32(0, w);
    dv.setUint32(4, h);
    ihdr[8] = 8; // bit depth
    ihdr[9] = 2; // colour type: truecolour
    const parts = [
        new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        chunk("IHDR", ihdr),
        chunk("IDAT", new Uint8Array(deflateSync(raw))),
        chunk("IEND", new Uint8Array(0)),
    ];
    const total = parts.reduce((n, p) => n + p.length, 0);
    const png = new Uint8Array(total);
    let off = 0;
    for (const p of parts) { png.set(p, off); off += p.length; }
    writeFileSync(path, png);
}

// The framebuffer is RGB565 big-endian (emu_device()'s "format"), portrait.
// The apps' own landscape mapping is lx = panelY, ly = PANEL_W - 1 - panelX
// (timer.c's ring_tick_for_touch), so undoing it is a 90 degree turn
// ANTI-clockwise. Turning it the other way is the mistake to expect here: it
// produces a picture that looks plausible (three icons, big digits) and is
// upside down, which a hash-based test would never catch and an eye does
// immediately. Look at the output.
function fbToLandscapeRGB(fb: Uint8Array): { w: number; h: number; rgb: Uint8Array } {
    const w = PANEL_H, h = PANEL_W;
    const rgb = new Uint8Array(w * h * 3);
    for (let py = 0; py < PANEL_H; py++) {
        for (let px = 0; px < PANEL_W; px++) {
            const i = (py * PANEL_W + px) * 2;
            const v = (fb[i] << 8) | fb[i + 1];
            const r = ((v >> 11) & 0x1f) * 255 / 31;
            const g = ((v >> 5) & 0x3f) * 255 / 63;
            const b = (v & 0x1f) * 255 / 31;
            // anti-clockwise: (px, py) -> (x = py, y = PANEL_W-1-px)
            const o = ((PANEL_W - 1 - px) * w + py) * 3;
            rgb[o] = r; rgb[o + 1] = g; rgb[o + 2] = b;
        }
    }
    return { w, h, rgb };
}

// ---- the device -----------------------------------------------------------
async function loadDevice() {
    const mod = await WebAssembly.compile(readFileSync(WASM_PATH));
    let memory!: WebAssembly.Memory;
    const decoder = new TextDecoder();
    let quiet = true;

    // Exactly emu_abi.h's documented import list. Nothing else is needed:
    // malloc/printf and the rest are compiled into the module itself.
    const imports = {
        env: {
            js_log(ptr: number, len: number) {
                if (quiet) return;
                console.log(`    [fw] ${decoder.decode(new Uint8Array(memory.buffer, ptr, len))}`);
            },
            sinf: Math.sin, cosf: Math.cos, atan2f: Math.atan2, sqrtf: Math.sqrt,
            fabsf: Math.abs, floorf: Math.floor, expf: Math.exp,
            fmodf: (x: number, y: number) => x % y,
            powf: Math.pow,
        },
    };

    const instance = await WebAssembly.instantiate(mod, imports);
    memory = instance.exports.memory as WebAssembly.Memory;
    const exp = instance.exports as any;
    if (exp.emu_init() !== 1) throw new Error("emu_init() failed");

    let now = 0;
    return {
        get now() { return now; },
        advance(ms: number, step = 16) {
            const end = now + ms;
            while (now < end) { now = Math.min(now + step, end); exp.emu_tick(now); }
        },
        button(i: number, down: boolean) { exp.emu_button(i, down ? 1 : 0); },
        verdict(i: number, long: boolean) { exp.emu_button_verdict(i, long ? 1 : 0); },
        touch(down: boolean, x: number, y: number) { exp.emu_touch(down ? 1 : 0, x, y); },
        switchTo(i: number) { exp.emu_app_switch(i); },
        current(): number { return exp.emu_app_current(); },
        shoot(name: string) {
            const fb = new Uint8Array(memory.buffer, exp.emu_fb(), PANEL_W * PANEL_H * 2);
            const { w, h, rgb } = fbToLandscapeRGB(fb);
            const path = join(OUT_DIR, `screen-${name}.png`);
            writePNG(path, w, h, rgb);
            console.log(`wrote ${path} (${w}x${h})`);
        },
    };
}

// A landscape point, converted to the panel coordinates emu_touch() takes.
// timer.c's ring_tick_for_touch() defines the mapping: lx = panelY,
// ly = PANEL_W - 1 - panelX.
function land(lx: number, ly: number): [number, number] {
    return [PANEL_W - 1 - ly, lx];
}

function tap(dev: Awaited<ReturnType<typeof loadDevice>>, lx: number, ly: number) {
    const [x, y] = land(lx, ly);
    dev.touch(true, x, y);
    dev.advance(60);
    dev.touch(false, x, y);
    dev.advance(60);
}

function stroke(dev: Awaited<ReturnType<typeof loadDevice>>, pts: Array<[number, number]>) {
    let first = true;
    for (const [lx, ly] of pts) {
        const [x, y] = land(lx, ly);
        dev.touch(true, x, y);
        dev.advance(first ? 30 : 16, 8);
        first = false;
    }
    const [lx, ly] = pts[pts.length - 1];
    const [x, y] = land(lx, ly);
    dev.touch(false, x, y);
    dev.advance(80);
}

// The chord that opens and closes the picture menu: BOOT held while PWR's
// long-press verdict lands (runtime_core.c). Same gesture tools/dev.ts sends
// as `chord`.
function chord(dev: Awaited<ReturnType<typeof loadDevice>>) {
    dev.button(BTN_BOOT, true);
    dev.advance(50);
    dev.button(BTN_PWR, true);
    dev.advance(1500);
    dev.verdict(BTN_PWR, true);
    dev.advance(120);
    dev.button(BTN_PWR, false);
    dev.button(BTN_BOOT, false);
    dev.advance(200);
}

const dev = await loadDevice();
mkdirSync(OUT_DIR, { recursive: true });

// ---- the menu: three icons, which is the first thing anybody sees ---------
chord(dev);
if (dev.current() !== APP_MENU) throw new Error("the chord did not open the menu");
dev.advance(400);
dev.shoot("menu");
chord(dev); // close it again

// ---- the stopwatch: running, so the digits are not all zero --------------
dev.switchTo(APP_CHRONO);
dev.advance(200);
dev.button(BTN_PWR, true);
dev.advance(120);
dev.verdict(BTN_PWR, false);
dev.button(BTN_PWR, false);
dev.advance(12_480); // a while, so seconds and hundredths both read as busy
dev.shoot("chrono");

// ---- the sketchpad: something drawn on it -------------------------------
dev.switchTo(APP_SKETCH);
dev.advance(300);
// A loose hand-drawn shape. The point is to show the ink's variable width and
// tapered ends (sketch.c), not to draw anything in particular.
stroke(dev, [
    [70, 250], [95, 210], [120, 170], [150, 135], [185, 110], [220, 100],
    [255, 108], [285, 130], [305, 162], [312, 198], [305, 232], [286, 258],
    [258, 274], [226, 280], [196, 274], [174, 258], [163, 236], [166, 214],
    [182, 200], [204, 198], [222, 208], [232, 226],
]);
stroke(dev, [[330, 120], [352, 150], [368, 186], [376, 224], [374, 258]]);
dev.shoot("sketch");

// ---- the countdown timer: a value set on the ring, then running ----------
dev.switchTo(APP_TIMER);
dev.advance(300);
// timer.c's ring: drag round it to set a value, the way a finger would.
{
    const CX = 224, CY = 184, R = 165;
    const pts: Array<[number, number]> = [];
    for (let a = -90; a <= 30; a += 6) {
        const rad = (a * Math.PI) / 180;
        pts.push([CX + R * Math.cos(rad), CY + R * Math.sin(rad)]);
    }
    stroke(dev, pts);
}
dev.button(BTN_PWR, true);
dev.advance(120);
dev.verdict(BTN_PWR, false);
dev.button(BTN_PWR, false);
dev.advance(3_200);
dev.shoot("timer");

console.log("done");
