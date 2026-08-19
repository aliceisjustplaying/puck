#!/usr/bin/env bun
// scripts/verify-web-apps.ts: headless proof that the web device pack's own
// app pages actually run.
//
// The rest of this repository's site checks (scripts/verify-site-embeds.ts)
// verify pages that EMBED the shared emulator. These pages do not embed
// anything: /web/<app>/ is the pack's own host build, and the browser
// showing it is the target device (packs/web/AGENTS.md). So it needs its
// own check, and the check has to be about the things only a real browser
// can decide: does the module instantiate, does the panel actually paint
// pixels, does a tap on a drawn button reach the firmware, does a drag on
// the canvas reach the app, and do the two PWA files resolve and register.
//
// Deliberately NOT a pixel diff. Pixel identity between this pack and the
// RP2350 pack is already proven, at tolerance 0, by the module-level
// harness (harness/portdiff.ts, driven by bun run verify-bundle). Repeating
// that through a canvas would only add scaling and screenshot noise to a
// question already answered exactly. What is unproven at module level, and
// what this file is for, is everything OUTSIDE the module: the host.
//
//   bun run site:verify-web [--screenshots <dir>]
//
// Exit 0: every check passed. Exit 1: at least one did not, and it is named.

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import puppeteer, { type Browser, type Page } from "puppeteer-core";
import { serveDist } from "./staticSite";
import { closeBrowser } from "./browserClose";

const ROOT = resolve(import.meta.dir, "..");
const DIST = join(ROOT, "site", "dist");
const PORT = 53415;

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

const argv = process.argv.slice(2);
const shotIndex = argv.indexOf("--screenshots");
const SHOT_DIR = shotIndex === -1 ? null : resolve(process.cwd(), argv[shotIndex + 1] ?? ".");
if (SHOT_DIR) mkdirSync(SHOT_DIR, { recursive: true });

let failures = 0;
function fail(msg: string): void {
  failures++;
  console.error(`FAIL: ${msg}`);
}
function pass(msg: string): void {
  console.log(`  ok: ${msg}`);
}

if (!existsSync(DIST)) {
  console.error("FAIL: site/dist/ does not exist. Run `bun run site:build` first.");
  process.exit(1);
}

// What one sample of the live panel canvas looks like from outside the
// page: a cheap checksum, plus a count of pixels that are not the app's
// own background. The checksum answers "did anything change"; the count
// answers "is anything drawn at all", which is the difference between a
// running app and a canvas that instantiated and then painted nothing.
interface PanelSample {
  w: number;
  h: number;
  checksum: number;
  nonBackground: number;
}

async function samplePanel(page: Page, bg: "white" | "black"): Promise<PanelSample | null> {
  return page.evaluate((background) => {
    const canvas = document.querySelector("canvas#panel") as HTMLCanvasElement | null;
    if (!canvas || canvas.width === 0) return null;
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
    let checksum = 0;
    let nonBackground = 0;
    // Every 8th pixel: enough to be sensitive to any real change (a digit
    // is thousands of pixels, a particle is 49 at panel scale times the
    // device-pixel scale), and cheap enough to run several times a check.
    for (let i = 0; i < data.length; i += 32) {
      const r = data[i]!, g = data[i + 1]!, b = data[i + 2]!;
      checksum = (checksum + r * 3 + g * 5 + b * 7 + i) % 2147483647;
      const isBg = background === "white" ? r > 240 && g > 240 && b > 240 : r < 16 && g < 16 && b < 16;
      if (!isBg) nonBackground++;
    }
    return { w: canvas.width, h: canvas.height, checksum, nonBackground };
  }, bg);
}

function wait(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// Writes the panel canvas alone (not the page) to a PNG. Only used when a
// frame comparison fails: a checksum that disagrees is a fact, and the two
// images are what turns it into a diagnosis instead of a rerun.
async function dumpPanel(page: Page, path: string): Promise<void> {
  if (!SHOT_DIR) return;
  const dataUrl = await page.evaluate(() => {
    const c = document.querySelector("canvas#panel") as HTMLCanvasElement | null;
    return c ? c.toDataURL("image/png") : null;
  });
  if (!dataUrl) return;
  writeFileSync(path, Buffer.from(dataUrl.split(",")[1]!, "base64"));
  console.error(`  wrote ${path}`);
}

// The horizontal centre of mass of everything drawn on a black panel, as a
// fraction of the panel's width.
//
// A frame diff is useless here, measured: a settled pool still redraws
// nearly every particle every frame (sub-pixel jitter crossing a rounding
// boundary), so "pixels changed" reads ~3670 whether a finger is touching
// the panel or not. Where the fluid IS, on the other hand, barely moves
// once settled, and a horizontal drag through the pool is precisely a
// request to move it sideways. So the centroid is the signal, and its own
// idle drift over the identical window is the baseline it has to beat.
async function centroidX(page: Page): Promise<number> {
  return page.evaluate(() => {
    const canvas = document.querySelector("canvas#panel") as HTMLCanvasElement | null;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return -1;
    const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
    let sum = 0;
    let n = 0;
    for (let i = 0; i < data.length; i += 4) {
      if (data[i]! < 16 && data[i + 1]! < 16 && data[i + 2]! < 16) continue;
      sum += (i / 4) % canvas.width;
      n++;
    }
    return n === 0 ? -1 : sum / n / canvas.width;
  });
}

// A real tap on a drawn button: pointer events at its centre, which is
// what the host listens for (never a synthetic .click(), which would skip
// the pointerdown/pointerup pair the long-press verdict is measured
// between).
async function tapButton(page: Page, id: string, holdMs: number): Promise<boolean> {
  const box = await page.evaluate((buttonId) => {
    const node = document.querySelector(`button[data-button-id="${buttonId}"]`) as HTMLElement | null;
    if (!node) return null;
    const r = node.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  }, id);
  if (!box) return false;
  await page.mouse.move(box.x, box.y);
  await page.mouse.down();
  await wait(holdMs);
  await page.mouse.up();
  return true;
}

async function checkCommon(page: Page, app: string, base: string): Promise<void> {
  // The two PWA files, fetched as the browser would: a manifest that 404s
  // or a worker that does not register is an app that cannot be installed,
  // which is half of what "run it on your phone" means here.
  for (const file of ["manifest.webmanifest", "sw.js", "icon-192.png", "icon-512.png"]) {
    const res = await fetch(`${base}/${file}`);
    if (res.ok) pass(`${app}: /${file} resolves ${res.status}`);
    else fail(`${app}: /${file} does not resolve (HTTP ${res.status})`);
  }

  const manifest = (await (await fetch(`${base}/manifest.webmanifest`)).json()) as {
    name?: string;
    start_url?: string;
    display?: string;
    icons?: unknown[];
  };
  if (manifest.display === "standalone" && manifest.start_url === "./" && (manifest.icons?.length ?? 0) >= 2) {
    pass(`${app}: manifest is installable-shaped (${manifest.name}, standalone, ${manifest.icons!.length} icons)`);
  } else {
    fail(`${app}: manifest is not installable-shaped: ${JSON.stringify(manifest)}`);
  }

  // Registration, not just reachability: 127.0.0.1 is a secure context, so
  // this is a genuine test of the worker's own install step (its precache
  // list has to resolve, or the install rejects).
  const registered = await page
    .evaluate(async () => {
      const reg = await navigator.serviceWorker.getRegistration();
      return reg ? reg.scope : null;
    })
    .catch(() => null);
  if (registered) pass(`${app}: service worker registered at ${registered}`);
  else fail(`${app}: no service worker registration after load`);
}

async function main(): Promise<void> {
  const server = serveDist(DIST, PORT);
  let browser: Browser | null = null;
  try {
    browser = await puppeteer.launch({
      executablePath: CHROME,
      headless: true,
      args: ["--no-sandbox", "--disable-dev-shm-usage"],
    });

    // ---- chrono --------------------------------------------------------
    {
      const app = "chrono";
      const base = `http://127.0.0.1:${PORT}/web/${app}`;
      console.log(`\n-- /web/${app}/ --`);
      const page = await browser.newPage();
      page.on("pageerror", (e: unknown) => fail(`${app}: page error: ${e instanceof Error ? e.message : String(e)}`));
      await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2 });
      await page.goto(`${base}/`, { waitUntil: "domcontentloaded" });
      await wait(1500);

      const first = await samplePanel(page, "white");
      if (!first) {
        fail(`${app}: no painted canvas#panel`);
      } else if (first.nonBackground === 0) {
        fail(`${app}: panel is blank (${first.w}x${first.h}, no non-white pixels)`);
      } else {
        pass(`${app}: panel paints (${first.w}x${first.h} device px, ${first.nonBackground} sampled non-white pixels: the digits and colons)`);
      }

      // A stopped stopwatch must be STILL. Checked before the tap, so the
      // "it started" check below cannot be satisfied by an app that was
      // already animating for some other reason.
      const idleA = await samplePanel(page, "white");
      await wait(500);
      const idleB = await samplePanel(page, "white");
      if (idleA && idleB && idleA.checksum === idleB.checksum) pass(`${app}: stopped and unchanged over 500ms before the tap`);
      else fail(`${app}: the panel changed over 500ms while the stopwatch was stopped`);

      if (!(await tapButton(page, "pwr", 80))) fail(`${app}: no on-screen PWR button found`);
      await wait(500);
      const running = await samplePanel(page, "white");
      if (idleB && running && running.checksum !== idleB.checksum) {
        pass(`${app}: an on-screen PWR tap started the stopwatch (pixels changed over the following 500ms)`);
      } else {
        fail(`${app}: an on-screen PWR tap did not start the stopwatch (panel unchanged over 500ms)`);
      }

      // And BOOT resets it: the second declared affordance, and the one
      // that proves the two buttons are wired to different indices rather
      // than both to whatever happens to be first.
      await tapButton(page, "boot", 60);
      await wait(300);
      const afterReset = await samplePanel(page, "white");
      if (afterReset && first && afterReset.checksum === first.checksum) {
        pass(`${app}: an on-screen BOOT tap reset the display to its 00:00:00 first frame`);
      } else {
        await dumpPanel(page, join(SHOT_DIR ?? ".", `debug-${app}-afterreset.png`));
        fail(
          `${app}: an on-screen BOOT tap did not restore the 00:00:00 frame ` +
            `(checksum ${afterReset?.checksum} vs ${first?.checksum} at boot, ` +
            `${afterReset?.nonBackground} vs ${first?.nonBackground} non-white sampled pixels, canvas ${afterReset?.w}x${afterReset?.h} vs ${first?.w}x${first?.h})`
        );
      }

      await checkCommon(page, app, base);

      if (SHOT_DIR) {
        await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2 });
        await wait(400);
        const shot = join(SHOT_DIR, `web-${app}-390.png`);
        await page.screenshot({ path: shot as `${string}.png` });
        console.log(`  wrote ${shot}`);
      }
      await page.close();
    }

    // ---- fluidbox ------------------------------------------------------
    {
      const app = "fluidbox";
      const base = `http://127.0.0.1:${PORT}/web/${app}`;
      console.log(`\n-- /web/${app}/ --`);
      const page = await browser.newPage();
      page.on("pageerror", (e: unknown) => fail(`${app}: page error: ${e instanceof Error ? e.message : String(e)}`));
      await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2 });
      await page.goto(`${base}/`, { waitUntil: "domcontentloaded" });
      // Long enough for the fluid to fall and settle into a pool, which is
      // the state the stir check below measures against. 9s, not the 4.5s
      // tried first: measured, the pool is still sloshing at 4.5s (its
      // centre of mass drifts 0.59% of the panel width in 320ms, more than
      // a stir moves it), and quiet by 9s (0.05%). That matches the app's
      // own recorded trace, whose second settled capture is at t=9024ms.
      await wait(9000);

      const settled = await samplePanel(page, "black");
      if (!settled) {
        fail(`${app}: no painted canvas#panel`);
      } else if (settled.nonBackground === 0) {
        fail(`${app}: no particles drawn (${settled.w}x${settled.h}, every sampled pixel is background black)`);
      } else {
        pass(`${app}: particles present (${settled.nonBackground} sampled non-black pixels on a ${settled.w}x${settled.h} canvas)`);
      }

      // The baseline: how far the pool's centre of mass drifts on its own
      // over the same wall-clock window the stir gets.
      const STIR_MS = 320;
      const cA = await centroidX(page);
      await wait(STIR_MS);
      const cB = await centroidX(page);
      const idleDrift = Math.abs(cB - cA);

      const canvasBox = await page.evaluate(() => {
        const c = document.querySelector("canvas#panel") as HTMLCanvasElement | null;
        if (!c) return null;
        const r = c.getBoundingClientRect();
        return { x: r.left, y: r.top, w: r.width, h: r.height };
      });
      if (!canvasBox) {
        fail(`${app}: no canvas to stir`);
      } else {
        // A drag straight through the settled pool near the bottom of the
        // panel, which is where the fluid actually is after settling. A
        // drag across empty space above it would prove nothing: the port's
        // stir has a 70px radius and only moves particles it passes near.
        const y = canvasBox.y + canvasBox.h * 0.85;
        await page.mouse.move(canvasBox.x + canvasBox.w * 0.12, y);
        await page.mouse.down();
        const cBeforeStir = await centroidX(page);
        for (let i = 1; i <= 16; i++) {
          await page.mouse.move(canvasBox.x + canvasBox.w * (0.12 + (0.76 * i) / 16), y);
          await wait(STIR_MS / 16);
        }
        const cAfterStir = await centroidX(page);
        await page.mouse.up();
        const stirShift = cAfterStir - cBeforeStir;
        // Rightward, because the drag is rightward: a stir that moved the
        // fluid the other way would mean the pointer-to-panel mapping is
        // mirrored, which a magnitude-only check would happily pass.
        // Threshold: 2x the settled drift, and at least half a percent of
        // the panel width. Measured over several runs on this build, the
        // stir is a steady 0.82-0.83% and the idle drift wanders between
        // 0.05% and 0.21%, so 2x leaves real margin at the drift's worst
        // observed value while a stir that never reached the app (a
        // swallowed pointer event, a mirrored coordinate mapping) lands on
        // the drift itself and fails.
        if (stirShift > Math.max(0.005, idleDrift * 2)) {
          pass(
            `${app}: a rightward drag through the pool pushed it right (centre of mass moved ${(stirShift * 100).toFixed(2)}% of the panel width, vs ${(idleDrift * 100).toFixed(2)}% of idle drift over the same ${STIR_MS}ms)`
          );
        } else {
          fail(
            `${app}: a rightward drag through the pool did not move it (centre of mass moved ${(stirShift * 100).toFixed(2)}%, idle drift ${(idleDrift * 100).toFixed(2)}%, over ${STIR_MS}ms)`
          );
        }
      }

      await checkCommon(page, app, base);

      if (SHOT_DIR) {
        const shot = join(SHOT_DIR, `web-${app}-390.png`);
        await page.screenshot({ path: shot as `${string}.png` });
        console.log(`  wrote ${shot}`);
      }
      await page.close();
    }
  } finally {
    server.stop(true);
    if (browser) await closeBrowser(browser);
  }

  if (failures > 0) {
    console.error(`\nFAIL: ${failures} check(s) failed - see above`);
    process.exit(1);
  }
  console.log("\nPASS: /web/chrono/ and /web/fluidbox/ both load, paint, take input, and are installable");
}

await main();
