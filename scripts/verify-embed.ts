// Headless verification of ?embed=1 (src/main.ts's EMBED, src/app.css's
// html.embed rules): the device-only view a public run page iframes (see
// site/build.ts). Two things, in order, mirroring scripts/verify.ts's own
// shape:
//
//   1. Chrome that MUST be gone: the topbar (#topbar's own button ids),
//      the sidebar (#consolePane, the input/tune controls), the
//      diagnostics strip - either absent from the DOM's visible layout or
//      actually hidden (display:none via getComputedStyle, not just a CSS
//      class this script trusts by name).
//   2. The device still works: the same real-input proof scripts/verify.ts
//      uses (a synthetic touch stroke, falling back to declared buttons),
//      confirming embed mode is presentation-only and never touches the
//      real input path.
//
// Run with: bun run verify:embed (needs wasm/dist/emu.wasm - any firmware
// works, this check is device-agnostic).
import puppeteer from "puppeteer-core";
import { join } from "node:path";
import { existsSync } from "node:fs";

const ROOT = join(import.meta.dir, "..");
const PORT = 53411;
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
  fail(`${WASM_FILE} does not exist. Run "bun run example:build" (or any pack build) first.`);
}

const server = Bun.spawn(["bun", "run", "server.ts"], {
  cwd: ROOT,
  env: { ...process.env, PORT: String(PORT) },
  stdout: "pipe",
  stderr: "pipe",
});

let browser: Awaited<ReturnType<typeof puppeteer.launch>> | null = null;
try {
  await waitForServer(`http://127.0.0.1:${PORT}/`, 15000);
  console.log("server up");

  browser = await puppeteer.launch({ executablePath: CHROME, headless: true });
  const page = await browser.newPage();
  await page.setViewport({ width: 900, height: 700 });
  page.on("pageerror", (e) => console.error("page error:", e));

  await page.goto(`http://127.0.0.1:${PORT}/?embed=1`, { waitUntil: "domcontentloaded" });
  await new Promise((r) => setTimeout(r, 1000));

  // 1. Chrome that must be gone: absent from the accessible/visible page
  // (either not in the DOM, or actually display:none per the computed
  // style - never trusting a class name alone, in case the CSS selector
  // itself is wrong).
  const isEffectivelyHidden = (sel: string) =>
    page.evaluate((s) => {
      const el = document.querySelector(s) as HTMLElement | null;
      if (!el) return true; // absent counts as hidden
      const style = getComputedStyle(el);
      // getComputedStyle only reports the ELEMENT'S OWN display/visibility,
      // not whether an ancestor's display:none removed it from the render
      // tree - .side.controls being display:none does not change what
      // getComputedStyle(#consolePane) reports for #consolePane itself.
      // offsetParent is null for exactly that "not actually rendered"
      // case (and is otherwise non-null for anything in normal flow, none
      // of these elements are position:fixed), so check both.
      return style.display === "none" || style.visibility === "hidden" || el.offsetParent === null;
    }, sel);

  const mustBeHidden = [
    { sel: ".topbar", label: "top toolbar (freeze/save/load/baseline/check/quit)" },
    { sel: ".side.controls", label: "input/device/console sidebar" },
    { sel: "#consolePane", label: "console pane" },
    { sel: ".diag-strip", label: "diagnostics strip" },
    { sel: ".tilt-slider", label: "cosmetic tilt slider" },
    { sel: "#btnPause", label: "pause button" },
    { sel: "#btnStep", label: "step button" },
  ];
  for (const { sel, label } of mustBeHidden) {
    const hidden = await isEffectivelyHidden(sel);
    if (!hidden) fail(`embed mode: "${label}" (${sel}) is still visible`);
    console.log(`hidden as expected: ${label} (${sel})`);
  }

  // The rotation control MUST still be visible (it's the minimal strip).
  const rotVisible = await page.evaluate(() => {
    const el = document.querySelector("#rotQuick");
    if (!el) return false;
    const style = getComputedStyle(el as Element);
    return style.display !== "none" && style.visibility !== "hidden";
  });
  if (!rotVisible) fail("embed mode: the rotation control (#rotQuick) should still be visible, and is not");
  console.log("visible as expected: rotation control (#rotQuick)");

  // The device itself (bezel/panel) must still be visible.
  const deviceVisible = await page.evaluate(() => {
    const el = document.querySelector("#bezel");
    if (!el) return false;
    const r = (el as HTMLElement).getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  });
  if (!deviceVisible) fail("embed mode: the device (#bezel) is not visible");
  console.log("visible as expected: the device itself (#bezel)");

  // 2. The device still works: same real-input proof as scripts/verify.ts.
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
  const before = await readPanel();

  const cx = panelBox.x + panelBox.width * 0.3;
  const cy = panelBox.y + panelBox.height * 0.3;
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  for (let i = 0; i < 6; i++) {
    await page.mouse.move(cx + i * 8, cy + i * 4);
    await new Promise((r) => setTimeout(r, 30));
  }
  await page.mouse.up();
  await new Promise((r) => setTimeout(r, 300));

  let changed = countDiff(before, await readPanel());
  if (changed === 0) {
    const buttons = await page.$$("#bezel .dev-btn");
    for (let i = 0; i < buttons.length; i++) {
      await buttons[i]!.click();
      await new Promise((r) => setTimeout(r, 400));
      changed = countDiff(before, await readPanel());
      if (changed > 0) break;
    }
  }
  console.log(`panel pixels changed after real input: ${changed} byte(s) different out of ${before.length}`);
  if (changed === 0) fail("embed mode: touch/button input reached the panel and NOTHING changed - input path is broken in embed mode");

  console.log("\nPASS: ?embed=1 hides dev-UI chrome, keeps the device + rotation strip, and real input still reaches the panel");
} finally {
  if (browser) await browser.close();
  server.kill();
  try {
    Bun.spawnSync(["taskkill", "/pid", String(server.pid), "/t", "/f"], { stdout: "ignore", stderr: "ignore" });
  } catch {}
}
