// capture-gameos-esp32-shell-frame.ts: captures the esp32-s3-touch-amoled-18
// gameos module's own settled boot frame (the real shell's grid, freshly
// booted, no touch yet) as a PNG - the emulator half of this bundle's
// donor-reference comparison (see apps/gameos/reference/esp32-gameos/
// donor-shell-comparison/README.md, which this script's own output feeds).
// The donor half is media/launcher.png, downloaded byte-for-byte from
// MikeWilson/esp32-gameos and vendored at
// apps/gameos/reference/esp32-gameos/media/launcher.png (NOTICE.md).
//
// PRECONDITION: wasm/dist/emu.wasm must be this port's module:
//   ZIG_EXE=<path> bun run pack:esp32:build -- --app apps/gameos/ports/esp32-s3-touch-amoled-18/gameos_port.c --wasm-memory-mb 8
//
// Run with: bun run scripts/capture-gameos-esp32-shell-frame.ts [outfile.png]
import puppeteer, { type Page } from "puppeteer-core";
import { join } from "node:path";
import { existsSync, writeFileSync } from "node:fs";
import { closeBrowser } from "./browserClose";
import { encodeRGBPNG } from "../harness/png";

const ROOT = join(import.meta.dir, "..");
const PORT = 53421;
const WASM_FILE = join(ROOT, "wasm", "dist", "emu.wasm");
const OUT_FILE = process.argv[2] ?? join(ROOT, "apps", "gameos", "reference", "esp32-gameos", "donor-shell-comparison", "our-shell-boot.png");

function findChrome(): string {
  const candidates = [
    "C:/Program Files/Google/Chrome/Application/chrome.exe",
    "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium-browser",
  ];
  for (const c of candidates) if (existsSync(c)) return c;
  throw new Error("no local Chrome found. Set CHROME_PATH, or install Chrome.");
}
const CHROME = process.env.CHROME_PATH || findChrome();

function fail(msg: string): never {
  console.error(`FAIL: ${msg}`);
  process.exit(1);
}

async function waitForServer(url: string, timeoutMs: number): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const r = await fetch(url);
      if (r.ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`server did not come up within ${timeoutMs}ms`);
}

if (!existsSync(WASM_FILE)) {
  fail(`${WASM_FILE} does not exist. Build the gameos esp32 module first - see this file's header comment.`);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function readFrame(page: Page): Promise<{ width: number; height: number; rgb: Uint8Array }> {
  const raw = await page.evaluate(() => {
    const c = document.querySelector("canvas#panel") as HTMLCanvasElement;
    const ctx = c.getContext("2d")!;
    const d = ctx.getImageData(0, 0, c.width, c.height);
    return { width: c.width, height: c.height, data: Array.from(d.data) };
  });
  const rgb = new Uint8Array(raw.width * raw.height * 3);
  for (let i = 0, j = 0; i < raw.data.length; i += 4, j += 3) {
    rgb[j] = raw.data[i]!;
    rgb[j + 1] = raw.data[i + 1]!;
    rgb[j + 2] = raw.data[i + 2]!;
  }
  return { width: raw.width, height: raw.height, rgb };
}

async function main(): Promise<void> {
  const server = Bun.spawn(["bun", "run", "server.ts"], { cwd: ROOT, env: { ...process.env, PORT: String(PORT) }, stdout: "pipe", stderr: "pipe" });
  let browser: Awaited<ReturnType<typeof puppeteer.launch>> | null = null;
  try {
    await waitForServer(`http://127.0.0.1:${PORT}/`, 15000);
    browser = await puppeteer.launch({ executablePath: CHROME, headless: true });
    const page = await browser.newPage();
    await page.setViewport({ width: 900, height: 900, isMobile: false, hasTouch: false });
    page.on("pageerror", (e) => console.error("page error:", e));
    await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: "domcontentloaded" });

    await page.waitForFunction(() => {
      const c = document.querySelector("canvas#panel") as HTMLCanvasElement | null;
      return !!c && c.width > 1;
    }, { timeout: 15000 });
    await sleep(200);

    // shell_init() (the real, vendored shell.c) enters the first-run
    // calibration wizard (SH_CALIB), not the grid, whenever
    // g_settings.calibrated is false - which it always is here, every
    // session, since this port's nvs.h always fails open (no persistence -
    // see NOTICE.md's "no NVS persistence" shim). A real board only sees
    // this screen ONCE, ever (NVS remembers); this emulator sees it on
    // every fresh boot, which is why this script taps through it before
    // capturing - the grid is the state both the donor's own
    // media/launcher.png reference and this bundle's demo/invariants
    // actually mean by "the shell", not this one-time wizard.
    const panelRect = await page.$eval("#panel", (el) => {
      const r = el.getBoundingClientRect();
      return { x: r.x, y: r.y, w: r.width, h: r.height };
    });
    const RW = 184, RH = 224;
    const toClient = (rx: number, ry: number) => [panelRect.x + (rx / RW) * panelRect.w, panelRect.y + (ry / RH) * panelRect.h] as const;
    const [cx, cy] = toClient(92, 150);
    await page.mouse.move(cx, cy);
    await sleep(40);
    await page.mouse.down();
    await sleep(80);
    await page.mouse.up();

    // Settle well past the grid's own first render (matches the pattern
    // gameos-demo-esp32.trace.json's own launcher16/48/80 boot captures
    // use): the grid's own idle state is static once ticking, no animation
    // to wait out.
    await sleep(400);

    const frame = await readFrame(page);
    const png = encodeRGBPNG(frame.width, frame.height, frame.rgb);
    writeFileSync(OUT_FILE, png);
    console.log(`wrote ${OUT_FILE} (${frame.width}x${frame.height})`);
  } finally {
    if (browser) await closeBrowser(browser);
    if (process.platform === "win32" && server.pid) {
      Bun.spawnSync(["taskkill", "/pid", String(server.pid), "/t", "/f"], { stdout: "ignore", stderr: "ignore" });
    } else {
      server.kill();
    }
  }
}

await main();
