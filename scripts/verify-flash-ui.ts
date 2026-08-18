// scripts/verify-flash-ui.ts: headless proof the "Flash to the real
// device" section actually renders on a real run page, and that the
// unsupported-browser path is a clean message, not a thrown exception.
//
// Same shape as scripts/verify.ts (a local static server, puppeteer-core
// against a local Chrome install, no bundled Chromium download), but
// serving the built gallery (site/dist/, static output) instead of the
// dev server, and driving the fluidbox-rp2350 run page instead of the
// bare emulator.
//
// The unsupported-browser path is forced deterministically rather than
// hoped for: real headless Chrome does expose navigator.usb, and calling
// requestDevice() from there would either hang waiting on a device chooser
// that can never appear headless, or behave inconsistently across Chrome
// versions. So this script deletes navigator.usb before any page script
// runs (page.evaluateOnNewDocument), which is exactly the condition
// flash-ui.ts's isWebUsbSupported() check exists to handle, and then
// clicks the real button and reads the real DOM.
import puppeteer from "puppeteer-core";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { serveDist } from "./staticSite";

const ROOT = join(import.meta.dir, "..");
const DIST = join(ROOT, "site", "dist");
const PORT = 53411;

function findChrome(): string {
  const candidates = [
    "C:/Program Files/Google/Chrome/Application/chrome.exe",
    "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium-browser",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  ];
  for (const c of candidates) if (existsSync(c)) return c;
  throw new Error(
    `no local Chrome found in the usual locations. Set CHROME_PATH to your Chrome/Chromium executable, ` +
      `or install Chrome. puppeteer-core deliberately does not bundle its own Chromium download.`
  );
}
const CHROME = process.env.CHROME_PATH || findChrome();

function fail(msg: string): never {
  console.error(`FAIL: ${msg}`);
  process.exit(1);
}

if (!existsSync(DIST)) fail(`site/dist/ does not exist. Run \`bun run site:build\` first.`);

// The shared emulator bundle's main.ts unconditionally tries to open a
// live-reload websocket on boot (by design, see scripts/verify.ts's own
// comment); this static server (scripts/staticSite.ts) answers that (and
// any other unknown path, e.g. /favicon.ico) with a plain 404 instead of
// letting a missing file bubble into a noisy 500 - nothing this script
// needs to special-case itself.
const server = serveDist(DIST, PORT);

try {
  const browser = await puppeteer.launch({ executablePath: CHROME, headless: true });
  try {
    const page = await browser.newPage();
    // Only uncaught exceptions count as a failure here. The emulator
    // bundle's own live-reload websocket (main.ts, by design - see
    // scripts/verify.ts's header comment) has nothing to connect to under
    // this static server and logs a console error for it; that's expected
    // noise unrelated to the flash button, not the exception this check
    // is trying to catch.
    const pageErrors: string[] = [];
    page.on("pageerror", (e) => pageErrors.push(String(e)));

    // Strip navigator.usb before any page script executes, so the
    // "unsupported browser" branch is exercised deterministically instead
    // of depending on this Chrome build's real WebUSB behaviour.
    await page.evaluateOnNewDocument(() => {
      Object.defineProperty(window.navigator, "usb", { value: undefined, configurable: true });
    });

    await page.goto(`http://127.0.0.1:${PORT}/run/fluidbox-rp2350.html`, { waitUntil: "domcontentloaded" });
    await new Promise((r) => setTimeout(r, 500));

    const hasSection = await page.evaluate(() => !!document.querySelector(".flash-section[data-uf2]"));
    if (!hasSection) fail("fluidbox-rp2350.html has no .flash-section[data-uf2]: the flash section did not render");
    console.log("flash section renders on fluidbox-rp2350.html");

    const hasDownloadLink = await page.evaluate(() => {
      const a = document.querySelector<HTMLAnchorElement>(".flash-btn-alt");
      return !!a && a.hasAttribute("download") && a.getAttribute("href") === "../flash/fluidbox-rp2350.uf2";
    });
    if (!hasDownloadLink) fail("no working .flash-btn-alt download link pointing at ../flash/fluidbox-rp2350.uf2");
    console.log("download .uf2 fallback link present and correct");

    const hasRitual = await page.evaluate(() => {
      const details = document.querySelector("details.flash-ritual");
      return !!details && (details.textContent || "").includes("BOOT");
    });
    if (!hasRitual) fail("no BOOTSEL entry ritual <details> found");
    console.log("BOOTSEL entry ritual present");

    const clicked = await page.evaluate(() => {
      const btn = document.querySelector<HTMLButtonElement>(".flash-btn");
      if (!btn) return false;
      btn.click();
      return true;
    });
    if (!clicked) fail("no .flash-btn found to click");

    await new Promise((r) => setTimeout(r, 300));

    const errorState = await page.evaluate(() => {
      const el = document.querySelector<HTMLElement>(".flash-error");
      return { hidden: el ? el.hidden : null, text: el ? el.textContent : null };
    });
    if (errorState.hidden !== false) fail(`clicking Flash over USB did not surface a visible .flash-error (state: ${JSON.stringify(errorState)})`);
    if (!errorState.text || !/webusb/i.test(errorState.text)) {
      fail(`expected an unsupported-browser message mentioning WebUSB, got: ${JSON.stringify(errorState.text)}`);
    }
    console.log(`unsupported-browser message shown: "${errorState.text}"`);

    if (pageErrors.length > 0) {
      fail(`clicking Flash over USB with no navigator.usb threw/logged an error instead of a clean message: ${pageErrors.join(" | ")}`);
    }
    console.log("no exceptions thrown");

    console.log("\nOK: flash UI verified.");
  } finally {
    await browser.close();
  }
} finally {
  server.stop(true);
}
