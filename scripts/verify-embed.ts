// Headless verification of ?embed=1 (src/main.ts's EMBED, src/app.css's
// html.embed rules): the BARE device a public run page iframes (see
// site/build.ts) - no topbar, no sidebar, no bottom bar (no rotation
// buttons, no shake pill), no backdrop, just the device floating on the
// page's own background. Four things, in order, mirroring
// scripts/verify.ts's own shape:
//
//   1. Chrome that MUST be gone: the topbar, the sidebar, and now the
//      WHOLE bottom bar (not just its cosmetic pieces) - either absent
//      from the DOM's visible layout or actually hidden (display:none via
//      getComputedStyle, not just a CSS class this script trusts by name)
//      - plus #stage itself painting no background of its own.
//   2. The device still works: the same real-input proof scripts/verify.ts
//      uses (a synthetic touch stroke, falling back to declared buttons),
//      confirming embed mode is presentation-only and never touches the
//      real input path.
//   3. "r" still rotates the device with the strip hidden - what a run
//      page's own on-page hint (site/build.ts) tells a visitor to press
//      instead of a button they can no longer see.
//   4. "s" still reaches a declared shake sensor, when the loaded module
//      has one (conditional: not every firmware does).
//
// Run with: bun run verify:embed (needs wasm/dist/emu.wasm - any firmware
// works, this check is device-agnostic).
import puppeteer from "puppeteer-core";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { closeBrowser } from "./browserClose";

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
    // The bare-device pass: the WHOLE bottom bar is gone now, not just the
    // tilt/pause/step pieces - no rotation buttons, no shake pill, on
    // screen. See app.css's html.embed .bottom-bar rule.
    { sel: ".bottom-bar", label: "bottom bar (rotation buttons + any shake pill)" },
    { sel: "#rotQuick", label: "rotation buttons" },
    { sel: "#sensorControls", label: "sensor-event buttons (e.g. shake)" },
  ];
  for (const { sel, label } of mustBeHidden) {
    const hidden = await isEffectivelyHidden(sel);
    if (!hidden) fail(`embed mode: "${label}" (${sel}) is still visible`);
    console.log(`hidden as expected: ${label} (${sel})`);
  }

  // No backdrop either: .stage must not paint a background of its own -
  // this is the "device just floating" half of the bare-embed pass, not
  // just an absence of buttons.
  const stageBg = await page.evaluate(() => getComputedStyle(document.querySelector("#stage")!).backgroundColor);
  if (!/rgba\(0, ?0, ?0, ?0\)|transparent/.test(stageBg)) fail(`embed mode: #stage still paints a background (${stageBg}), expected transparent`);
  console.log(`transparent as expected: #stage background (${stageBg})`);

  // FIX 2's desktop-chip-hidden check: this script's own viewport never
  // sets hasTouch/isMobile (defaults to a plain desktop viewport), so
  // navigator.maxTouchPoints stays 0 and matchMedia("(pointer: coarse)")
  // stays false - exactly the context main.ts's motion chip must never
  // appear in, regardless of which module is loaded or whether it declares
  // a vector sensor at all.
  const chipPresent = await page.evaluate(() => document.querySelector("#motionChip") !== null);
  if (chipPresent) fail("embed mode on a desktop (non-touch) viewport: the tilt-with-your-phone chip is present");
  console.log("no tilt chip on a desktop viewport, as expected");

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

  // 3. "r" rotates even with the strip hidden. #rotQuick's own buttons
  // (and their "active" markup) still exist in the DOM, just not painted -
  // this is what a run page's own hint (site/build.ts) tells a visitor to
  // press instead of a button they can no longer see.
  const activeDeg = () =>
    page.evaluate(() => {
      const b = document.querySelector("#rotQuick button.active") as HTMLButtonElement | null;
      return b ? b.dataset.deg : null;
    });
  const degBefore = await activeDeg();
  await page.keyboard.press("r");
  await new Promise((r) => setTimeout(r, 250));
  const degAfter = await activeDeg();
  if (degBefore === null || degAfter === null) fail(`embed mode: could not read #rotQuick's active button (before=${degBefore}, after=${degAfter})`);
  if (degBefore === degAfter) fail(`embed mode: pressing "r" did not change the rotation (stayed at ${degBefore}deg)`);
  console.log(`"r" rotates as expected: ${degBefore}deg -> ${degAfter}deg`);

  // 4. "s" reaches the shake sensor, when the loaded module declares one -
  // conditional, not every firmware has a "shake" sensor (this script's own
  // doc: "any firmware works"). #consolePane stays hidden but still
  // receives every logged line (main.ts's ConsoleLog does not check EMBED),
  // so its last line is a real proof a sensor fired, not a guess.
  const hasSensorButton = (await page.$$("#sensorControls .sensor-btn")).length > 0;
  if (hasSensorButton) {
    await page.keyboard.press("s");
    await new Promise((r) => setTimeout(r, 250));
    const lastLine = await page.evaluate(() => {
      const lines = document.querySelectorAll("#consolePane .console-line");
      return lines.length ? lines[lines.length - 1]!.textContent : null;
    });
    // Either line is real proof: main.ts's own "sensor: <id>" (buildSensorControls'
    // log callback) or the firmware's own reaction logged via js_log during
    // emu_sensor_event() itself (e.g. example/firmware/main.c's "shake:
    // cleared") - both only happen if the ABI call actually landed.
    if (!lastLine || !/sensor|shake/i.test(lastLine)) fail(`embed mode: pressing "s" did not log a sensor event (last console line: ${lastLine})`);
    console.log(`"s" reaches the sensor as expected (console: "${lastLine}")`);
  } else {
    console.log('no "kind":"event" sensor on this module - skipping the "s" shortcut check (not every firmware declares one)');
  }

  const engineDead = await isEffectivelyHidden("#engineDead");
  if (!engineDead) fail('embed mode: "r"/"s" left #engineDead visible - one of them crashed the module');
  console.log("engine still alive after \"r\"/\"s\": #engineDead stayed hidden");

  console.log("\nPASS: ?embed=1 is the bare device (no control strip, no backdrop), real input still reaches the panel, and \"r\"/\"s\" reach rotate/shake with the strip hidden");
} finally {
  if (browser) await closeBrowser(browser);
  try {
    Bun.spawnSync(["taskkill", "/pid", String(server.pid), "/t", "/f"], { stdout: "ignore", stderr: "ignore" });
  } catch {}
  server.kill();
}
