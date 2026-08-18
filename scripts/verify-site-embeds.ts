// scripts/verify-site-embeds.ts: headless proof that the BUILT gallery's
// own landing page (site/dist/index.html) actually renders its live
// embedded emulators - not scripts/verify-embed.ts's job, which drives the
// dev server's bare ?embed=1 page directly and never touches site/dist/ or
// the module-URL resolution site/build.ts does for it.
//
// This exists because of a real regression: site/build.ts used to embed
// each card with a RELATIVE ?module= value ("modules/<id>.wasm"), which
// site/main.ts's fetchWasmBytes() resolves against the embedding document
// (site/dist/emu/index.html), not against whichever page put the iframe on
// screen - so every index-page card 404'd ("wasm module not found at
// modules/<id>.wasm") even though the identical relative depth was correct
// from a run page one level deeper. Fixed in site/build.ts by making the
// module URL root-absolute (moduleUrlAbs()); this script is what actually
// proves it front to back, in a real browser, against the real static
// output - not by re-deriving the URL logic and checking it matches
// (compares source strings would exercise nothing) but by loading the real
// page and reading whether pixels actually came out.
//
// Three things, in order:
//   1. Zero occurrences of "module not found" anywhere on the page,
//      including inside every embedded iframe's own document (the error
//      banner - main.ts's #wasmError - renders INSIDE the iframe, so the
//      top document's own text never shows it; this checks every frame).
//   2. At least 4 of the embedded panels (index.html embeds exactly 4 today
//      - two app cards, chrono and fluidbox, plus two reference tiles, the
//      esp32-s3 pack's demo and the instrument's own example firmware -
//      see site/build.ts's cardsHtml/refTiles) actually painted real,
//      opaque pixels (not still the browser's default fully-transparent
//      blank canvas), proving the module fetched, instantiated, ticked and
//      drew something real, not just "didn't show an error string".
//   3. CONTAINMENT: every embedded frame's #bezel (the device, per
//      src/app.css/main.ts - the thing embed mode's fitDeviceToStage
//      scales to fit) is entirely inside that frame's own iframe viewport,
//      at two page widths (narrow ~700px, wide ~1280px - the CSS grid
//      auto-fits card widths differently at each). This is the regression
//      check for a real bug: the landing-page fluidbox card used to crop
//      the bottom of the device (all-black panel, the fluid pooled out of
//      sight below the crop) because centerDeviceOnce()'s plain-mode
//      centring math (pixel left/top, clamped to a 20px floor) put the
//      UNSCALED device's geometric centre well below the iframe's actual
//      visual centre, and CSS `transform: scale()` shrinks around
//      whatever point transform-origin names - so it shrank the device
//      toward the wrong point instead of the iframe's true centre, and
//      the correctly-computed scale factor was still not enough to pull
//      the bottom edge back on screen. Fixed with true CSS
//      (translate(-50%,-50%) + scale) centring in app.css and a
//      main.ts guard that skips centerDeviceOnce's own left/top writes in
//      embed mode - see both of those for the full geometry writeup.
//
// Run with: bun run site:verify-embeds (needs site/dist/ - run `bun run
// site:build` first).
import puppeteer from "puppeteer-core";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { serveDist } from "./staticSite";

const ROOT = join(import.meta.dir, "..");
const DIST = join(ROOT, "site", "dist");
const PORT = 53413;

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

if (!existsSync(DIST)) fail(`site/dist/ does not exist. Run \`bun run site:build\` first.`);

const server = serveDist(DIST, PORT);

let browser: Awaited<ReturnType<typeof puppeteer.launch>> | null = null;
try {
  browser = await puppeteer.launch({ executablePath: CHROME, headless: true });
  const page = await browser.newPage();
  // Tall viewport so every card (including the "reference app" tiles
  // further down the page) is already inside the viewport on load - this
  // sidesteps loading="lazy" timing entirely rather than needing to script
  // a scroll-and-wait per card, and is the more honest test besides: a
  // real visitor who scrolls slowly would trigger every one of these the
  // same way.
  await page.setViewport({ width: 1400, height: 4200 });
  page.on("pageerror", (e) => console.error("page error:", e));

  await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: "domcontentloaded" });
  console.log("index.html loaded");

  // Let every lazy iframe's own boot sequence (fetch -> instantiate ->
  // emu_init -> first ticks) settle.
  await new Promise((r) => setTimeout(r, 3500));

  const embeddedFrames = page.frames().filter((f) => f !== page.mainFrame() && /[?&]module=/.test(f.url()));
  console.log(`embedded emulator iframe(s) found: ${embeddedFrames.length}`);
  if (embeddedFrames.length < 4) {
    fail(`expected at least 4 embedded emulator iframes on the index page, found ${embeddedFrames.length} (site/build.ts's cardsHtml + refTiles)`);
  }

  // 1. "module not found" must not appear anywhere - the top document, or
  // inside any embedded frame (where main.ts's #wasmError banner actually
  // renders on a 404).
  let notFoundHits = 0;
  const allFrames = [page.mainFrame(), ...embeddedFrames];
  for (const frame of allFrames) {
    let text = "";
    try {
      text = await frame.evaluate(() => document.body?.textContent || "");
    } catch (err) {
      console.log(`  (frame ${frame.url().slice(0, 80)}: could not read body text: ${err instanceof Error ? err.message : String(err)})`);
      continue;
    }
    if (/module not found/i.test(text)) {
      notFoundHits++;
      console.error(`  "module not found" present in frame: ${frame.url()}`);
    }
  }
  if (notFoundHits > 0) fail(`"module not found" text present in ${notFoundHits} frame(s) - see above`);
  console.log('PASS: zero occurrences of "module not found" across the top page and every embedded frame');

  // 2. At least 4 embedded panels actually painted (main.ts's blitAll:
  // "Painted immediately... The screen must never show a stale frame").
  //
  // "More than one colour" was the first thing tried here and is the WRONG
  // test: example/firmware/main.c's own header comment says it boots to a
  // single flat "paper colour" fill with nothing else drawn until a button
  // is pressed - a real, successful paint, just a monochrome one - so that
  // module correctly measured only 1 distinct colour and a >1 threshold
  // reported it as a false failure. What actually distinguishes "the
  // firmware painted this" from "this canvas was never touched" is alpha:
  // an HTML canvas element starts fully TRANSPARENT (every pixel (0,0,0,0))
  // until something draws to it, and every one of the emulator's blit
  // paths (panel.ts's blitAll/blitRect) draws fully OPAQUE pixels - so any
  // sampled pixel with alpha > 0 proves a real paint happened, regardless
  // of how many distinct colours that paint used.
  async function isPanelPainted(frame: (typeof embeddedFrames)[number]): Promise<boolean> {
    return frame.evaluate(() => {
      const c = document.querySelector("canvas#panel") as HTMLCanvasElement | null;
      if (!c || c.width === 0 || c.height === 0) return false;
      const data = c.getContext("2d")!.getImageData(0, 0, c.width, c.height).data;
      for (let i = 3; i < data.length; i += 4 * 37) {
        if (data[i]! > 0) return true; // alpha channel: opaque means painted
      }
      return false;
    });
  }

  let paintedCount = 0;
  for (const frame of embeddedFrames) {
    const painted = await isPanelPainted(frame);
    if (painted) paintedCount++;
    console.log(`  ${frame.url().slice(0, 90)} -> ${painted ? "painted (opaque pixels present)" : "NOT painted (canvas still fully transparent)"}`);
  }
  console.log(`embedded panels that painted non-background pixels: ${paintedCount}/${embeddedFrames.length}`);
  if (paintedCount < 4) {
    fail(`expected at least 4 embedded panels to have painted non-background pixels, only ${paintedCount} did`);
  }

  console.log("\nPASS: the built gallery's landing page embeds render live, with no module-not-found errors, and at least 4 panels actually painted");

  // 3. Containment: the device (#bezel) must fit entirely inside each
  // embedded iframe's own viewport, at two different page widths - see
  // this file's header comment for the regression this catches.
  const CONTAINMENT_WIDTHS = [700, 1280];
  const EPS = 1; // px, subpixel rounding tolerance only

  async function checkContainmentAt(pageWidth: number): Promise<void> {
    await page.setViewport({ width: pageWidth, height: 4200 });
    // A fresh navigation, not just a resize: the CSS grid's own column
    // count depends on the page width (site/styles.css's .cards
    // grid-template-columns: repeat(auto-fit, minmax(260px, 1fr))), and a
    // reload is the simplest way to get every card and its iframe to
    // re-settle at the new width rather than reasoning about what a
    // bare resize event does or does not recompute inside each iframe.
    await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: "domcontentloaded" });
    await new Promise((r) => setTimeout(r, 3500));

    const frames = page.frames().filter((f) => f !== page.mainFrame() && /[?&]module=/.test(f.url()));
    if (frames.length < 4) {
      fail(`containment check at ${pageWidth}px: expected at least 4 embedded frames, found ${frames.length}`);
    }

    let violations = 0;
    for (const frame of frames) {
      let result: { ok: boolean; reason: string } | null = null;
      try {
        result = await frame.evaluate((eps) => {
          const bezel = document.querySelector("#bezel") as HTMLElement | null;
          if (!bezel) return { ok: false, reason: "no #bezel element found in frame" };
          const r = bezel.getBoundingClientRect();
          const vw = window.innerWidth, vh = window.innerHeight;
          const fits = r.left >= -eps && r.top >= -eps && r.right <= vw + eps && r.bottom <= vh + eps;
          return {
            ok: fits,
            reason: `bezel rect (${r.left.toFixed(1)},${r.top.toFixed(1)})-(${r.right.toFixed(1)},${r.bottom.toFixed(1)}) vs viewport ${vw}x${vh}`,
          };
        }, EPS);
      } catch (err) {
        result = { ok: false, reason: `evaluate failed: ${err instanceof Error ? err.message : String(err)}` };
      }
      const status = result!.ok ? "fits" : "OVERFLOWS";
      console.log(`  [${pageWidth}px page] ${frame.url().slice(0, 70)} -> ${status}: ${result!.reason}`);
      if (!result!.ok) violations++;
    }
    if (violations > 0) {
      fail(`containment check at ${pageWidth}px page width: ${violations}/${frames.length} embedded device(s) overflow their iframe viewport (cropped)`);
    }
  }

  for (const w of CONTAINMENT_WIDTHS) {
    console.log(`\n-- containment check, page width ${w}px --`);
    await checkContainmentAt(w);
  }
  console.log(`\nPASS: every embedded device fits entirely inside its iframe viewport at ${CONTAINMENT_WIDTHS.join("px and ")}px page widths`);
} finally {
  server.stop(true);
  if (browser) await browser.close();
}
