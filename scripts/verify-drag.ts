// Headless proof for FIX 3 (desktop drag-as-accelerometer, src/motion.ts's
// DragMotion): on a genuinely non-touch desktop viewport, dragging the
// device BEZEL steers the same real vector ABI path phone tilt uses (same
// sendVector, same composeViewVectorWithQuickDeg composition), a fast
// wiggle drag fires the same shake sensor event phone shake uses, releasing
// springs the device back and the fluid resettles toward baseline, and
// dragging the PANEL instead still reaches the app's own input path and
// never moves the device element. Also doubles as the desktop no-chip
// check for this page (FIX 2): a real, non-touch viewport must never show
// the "tilt with your phone" chip.
//
// PRECONDITION: wasm/dist/emu.wasm must be the fluidbox module with shake:
//   ZIG_EXE=<path> bun run pack:build -- --app apps/fluidbox/ports/rp2350-touch-amoled-18/fluid.c --shake
//
// Run with: bun run verify:drag
import puppeteer from "puppeteer-core";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { closeBrowser } from "./browserClose";

const ROOT = join(import.meta.dir, "..");
const PORT = 53414;
const WASM_FILE = join(ROOT, "wasm", "dist", "emu.wasm");

function findChrome(): string {
  const candidates = [
    "C:/Program Files/Google/Chrome/Application/chrome.exe",
    "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium-browser",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
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
  fail(`${WASM_FILE} does not exist. Build the fluidbox module first - see this file's header comment.`);
}

const server = Bun.spawn(["bun", "run", "server.ts"], {
  cwd: ROOT,
  env: { ...process.env, PORT: String(PORT) },
  stdout: "pipe",
  stderr: "pipe",
});

// Same technique verify-tilt.ts/verify-motion.ts already use: the single
// most common RGBA colour is "background", the centroid of every other
// pixel is where the fluid's mass actually is.
async function readCentroid(page: import("puppeteer-core").Page): Promise<{ cx: number; cy: number; n: number; w: number; h: number }> {
  return page.evaluate(() => {
    const c = document.querySelector("canvas#panel") as HTMLCanvasElement;
    const w = c.width, h = c.height;
    const data = c.getContext("2d")!.getImageData(0, 0, w, h).data;
    const counts = new Map<number, number>();
    for (let i = 0; i < data.length; i += 4) {
      const key = (data[i]! << 16) | (data[i + 1]! << 8) | data[i + 2]!;
      counts.set(key, (counts.get(key) || 0) + 1);
    }
    let bg = 0, bgCount = -1;
    for (const [key, count] of counts) if (count > bgCount) { bg = key; bgCount = count; }
    let sumX = 0, sumY = 0, n = 0;
    for (let i = 0; i < data.length; i += 4) {
      const key = (data[i]! << 16) | (data[i + 1]! << 8) | data[i + 2]!;
      if (key === bg) continue;
      sumX += (i / 4) % w;
      sumY += Math.floor(i / 4 / w);
      n++;
    }
    return { cx: n > 0 ? sumX / n : w / 2, cy: n > 0 ? sumY / n : h / 2, n, w, h };
  });
}

let browser: Awaited<ReturnType<typeof puppeteer.launch>> | null = null;
try {
  await waitForServer(`http://127.0.0.1:${PORT}/`, 15000);
  console.log("server up");

  browser = await puppeteer.launch({ executablePath: CHROME, headless: true });
  const page = await browser.newPage();
  // Genuinely non-touch, fine-pointer desktop: isMobile/hasTouch both
  // false, so navigator.maxTouchPoints stays 0 and matchMedia("(pointer:
  // coarse)") stays false - exactly the environment FIX 2's chip gate and
  // FIX 3's drag gate both key off.
  await page.setViewport({ width: 900, height: 900, isMobile: false, hasTouch: false });
  page.on("pageerror", (e) => console.error("page error:", e));

  await page.goto(`http://127.0.0.1:${PORT}/?embed=1`, { waitUntil: "domcontentloaded" });
  await new Promise((r) => setTimeout(r, 1000));

  const device = await page.evaluate(() => {
    const debug = (window as unknown as { __debug: { getDevice: () => { sensors?: { id: string; kind: string }[] } | null } }).__debug;
    return debug.getDevice();
  });
  const hasVector = (device?.sensors || []).some((s) => s.kind === "vector");
  const hasShake = (device?.sensors || []).some((s) => s.kind === "event" && s.id.toLowerCase() === "shake");
  if (!hasVector || !hasShake) fail(`loaded module must declare vector and shake sensors, got ${JSON.stringify(device?.sensors || [])}`);

  // ---- FIX 2 (doubled up here): no chip on a real desktop viewport -------
  const chipPresent = await page.evaluate(() => document.querySelector("#motionChip") !== null);
  if (chipPresent) fail("tilt chip is present on a non-touch desktop viewport - FIX 2 regression");
  console.log("no tilt chip on desktop, as expected (FIX 2)");

  // ---- geometry: a point on the bezel's BARE plastic, never the panel ----
  // The fluidbox pack declares both its buttons (boot/pwr) on the RIGHT
  // edge (packs/rp2350-touch-amoled-18/wasm/emu_shim.c's emu_device()), so
  // the LEFT edge's padding band is button-free at any vertical position.
  const bezelBox = await page.$eval("#bezel", (el) => {
    const r = el.getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height };
  });
  const dragX = bezelBox.x + 8;
  const dragY = bezelBox.y + bezelBox.height / 2;
  const target = await page.evaluate((p) => {
    const el = document.elementFromPoint(p.x, p.y);
    return el ? el.id || el.tagName : null;
  }, { x: dragX, y: dragY });
  if (target !== "bezel") fail(`chosen drag point (${dragX},${dragY}) does not resolve to #bezel (got "${target}") - geometry assumption is wrong`);
  console.log(`drag point (${dragX.toFixed(0)}, ${dragY.toFixed(0)}) resolves to #bezel, as expected`);

  // ---- settle at baseline, then drag sideways and HOLD --------------------
  console.log("waiting for the fluid to settle at baseline...");
  await new Promise((r) => setTimeout(r, 4000));
  const before = await readCentroid(page);
  if (before.n === 0) fail("no fluid pixels found before dragging - nothing to measure");
  console.log(`baseline centroid: (${before.cx.toFixed(1)}, ${before.cy.toFixed(1)}) over ${before.n}px`);

  await page.mouse.move(dragX, dragY);
  await page.mouse.down();
  const DRAG_PX = 35; // within DragMotion's 40px max radius
  const STEPS = 8;
  for (let i = 1; i <= STEPS; i++) {
    await page.mouse.move(dragX + (DRAG_PX * i) / STEPS, dragY);
    await new Promise((r) => setTimeout(r, 30));
  }
  console.log(`dragged bezel +${DRAG_PX}px sideways, holding...`);
  await new Promise((r) => setTimeout(r, 3000));

  const held = await readCentroid(page);
  console.log(`held centroid: (${held.cx.toFixed(1)}, ${held.cy.toFixed(1)})`);
  const heldShift = held.cx - before.cx;
  if (heldShift < 15) {
    fail(`fluid centroid moved only ${heldShift.toFixed(1)}px toward the predicted (right) edge while held, need at least 15px`);
  }
  console.log(`fluid migrated ${heldShift.toFixed(1)}px toward the predicted edge while held`);

  // ---- release: spring back, fluid resettles toward baseline -------------
  await page.mouse.up();
  console.log("released, waiting for spring-back and resettle...");
  await new Promise((r) => setTimeout(r, 4000));
  const released = await readCentroid(page);
  console.log(`resettled centroid: (${released.cx.toFixed(1)}, ${released.cy.toFixed(1)})`);
  const recovered = held.cx - released.cx; // positive = moved back toward baseline
  if (recovered < 10) {
    fail(`fluid centroid did not move back toward baseline after release: held=${held.cx.toFixed(1)}, after=${released.cx.toFixed(1)} (only ${recovered.toFixed(1)}px recovered)`);
  }
  console.log(`fluid moved ${recovered.toFixed(1)}px back toward baseline after release`);

  const bezelAfterRelease = await page.$eval("#bezel", (el) => el.getBoundingClientRect());
  if (Math.abs(bezelAfterRelease.x - bezelBox.x) > 1 || Math.abs(bezelAfterRelease.y - bezelBox.y) > 1) {
    fail(`bezel did not spring back to its original position: was (${bezelBox.x},${bezelBox.y}), now (${bezelAfterRelease.x},${bezelAfterRelease.y})`);
  }
  console.log("bezel visually returned to centre after release");

  // ---- rapid wiggle: same shake sensor path phone shake uses -------------
  const consoleLinesBefore = await page.$$eval("#consolePane .console-line", (els) =>
    els.filter((el) => (el.textContent || "").includes("shake: drag shake accepted")).length
  );
  await page.mouse.move(dragX, dragY);
  await page.mouse.down();
  const WIGGLE_PX = 30;
  for (let i = 0; i < 10; i++) {
    await page.mouse.move(dragX + (i % 2 === 0 ? WIGGLE_PX : -WIGGLE_PX), dragY);
    await new Promise((r) => setTimeout(r, 25));
  }
  await page.mouse.up();
  await new Promise((r) => setTimeout(r, 300));
  const consoleLinesAfter = await page.$$eval("#consolePane .console-line", (els) =>
    els.filter((el) => (el.textContent || "").includes("shake: drag shake accepted")).length
  );
  if (consoleLinesAfter <= consoleLinesBefore) fail('rapid wiggle drag did not log "shake: drag shake accepted"');
  console.log("rapid wiggle drag fired the shared shake sensor path");
  await new Promise((r) => setTimeout(r, 500)); // let the spring-back from this gesture finish too

  // ---- panel drag: still paints app input, never moves the device --------
  const bezelBeforePanelDrag = await page.$eval("#bezel", (el) => el.getBoundingClientRect());
  const panelBox = await page.$eval("#panel", (el) => {
    const r = el.getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height };
  });
  const readPanel = () =>
    page.evaluate(() => {
      const c = document.querySelector("canvas#panel") as HTMLCanvasElement;
      return Array.from(c.getContext("2d")!.getImageData(0, 0, c.width, c.height).data);
    });
  const countDiff = (a: number[], b: number[]) => {
    let n = 0;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) n++;
    return n;
  };
  const panelBefore = await readPanel();
  const px = panelBox.x + panelBox.width * 0.5;
  const py = panelBox.y + panelBox.height * 0.5;
  await page.mouse.move(px, py);
  await page.mouse.down();
  for (let i = 0; i < 6; i++) {
    await page.mouse.move(px + i * 6, py + i * 4);
    await new Promise((r) => setTimeout(r, 30));
  }
  await page.mouse.up();
  await new Promise((r) => setTimeout(r, 300));
  const panelChanged = countDiff(panelBefore, await readPanel());
  console.log(`panel pixels changed after dragging the PANEL: ${panelChanged} byte(s)`);
  if (panelChanged === 0) fail("dragging the panel did not paint any app input - panel input path is broken");

  const bezelAfterPanelDrag = await page.$eval("#bezel", (el) => el.getBoundingClientRect());
  if (Math.abs(bezelAfterPanelDrag.x - bezelBeforePanelDrag.x) > 1 || Math.abs(bezelAfterPanelDrag.y - bezelBeforePanelDrag.y) > 1) {
    fail(
      `dragging the PANEL moved/translated the device element: was (${bezelBeforePanelDrag.x},${bezelBeforePanelDrag.y}), ` +
        `now (${bezelAfterPanelDrag.x},${bezelAfterPanelDrag.y}) - the panel must never be intercepted as a drag surface`
    );
  }
  console.log("dragging the panel painted app input and left the device element exactly where it was");

  console.log(
    "\nPASS: no chip on desktop, bezel drag steers the shared vector ABI path and springs back, a wiggle drag fires the shared shake path, and panel dragging is untouched"
  );
} finally {
  if (browser) await closeBrowser(browser);
  try {
    Bun.spawnSync(["taskkill", "/pid", String(server.pid), "/t", "/f"], { stdout: "ignore", stderr: "ignore" });
  } catch {}
  server.kill();
}
