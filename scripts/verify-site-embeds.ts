// scripts/verify-site-embeds.ts: headless proof that the BUILT gallery
// (site/dist/) is correct end to end - not scripts/verify-embed.ts's job,
// which drives the dev server's bare ?embed=1 page directly and never
// touches site/dist/ or anything site/build.ts generates from it.
//
// Two halves, matching this task's own landing/run-page split:
//
//   1. THE LANDING PAGE (site/dist/index.html) no longer embeds a live
//      emulator per card (see site/build.ts's demoThumb, this task's own
//      "recorded loops, not live emulators" pass): it links to a recorded
//      <video>, poster, and gif fallback for every app card and reference
//      tile. This checks every one of those assets actually exists in the
//      build output and that the thumbnail's own link resolves to a real
//      run page - the regression this guards against is a build that
//      silently ships a landing page pointing at demo media nobody
//      recorded yet (site/build.ts's copyDemoMedia only warns, it does not
//      fail the build, precisely so a fresh clone can still build once
//      before any recording has happened - this script is what actually
//      enforces the media exists before calling the SITE correct).
//
//   2. EVERY RUN PAGE, at three widths (390 - the narrowest realistic
//      phone, 700, 1280): the embedded device must fit entirely inside its
//      iframe viewport (the regression check for a real bug: a run page
//      used to shrink the device around the WRONG point at a narrow width,
//      built to fit but pinned to the left, off screen - see
//      site/styles.css's own ".emu-frame { transform-origin }" comment for
//      the geometry), and the page itself must never scroll horizontally
//      at all (document.scrollingElement.scrollWidth <= the viewport
//      width) - not just the device, every element on the page: header,
//      badges, the flash section, the footer.
//
// Run with: bun run site:verify-embeds (needs site/dist/ - run `bun run
// site:build` first).
import puppeteer, { type Page } from "puppeteer-core";
import { join } from "node:path";
import { existsSync, readdirSync } from "node:fs";
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

let failures = 0;
function fail(msg: string): void {
  failures++;
  console.error(`FAIL: ${msg}`);
}
function failFatal(msg: string): never {
  console.error(`FAIL: ${msg}`);
  process.exit(1);
}

if (!existsSync(DIST)) failFatal(`site/dist/ does not exist. Run \`bun run site:build\` first.`);

const server = serveDist(DIST, PORT);

let browser: Awaited<ReturnType<typeof puppeteer.launch>> | null = null;
try {
  browser = await puppeteer.launch({ executablePath: CHROME, headless: true });

  // ---- 1. the landing page: every thumbnail's media + link resolves ----
  {
    const page = await browser.newPage();
    await page.setViewport({ width: 1400, height: 4200 });
    page.on("pageerror", (e) => console.error("index.html page error:", e));
    await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: "domcontentloaded" });
    console.log("index.html loaded");

    const thumbs = await page.evaluate(() => {
      return Array.from(document.querySelectorAll("a.thumb-video")).map((a) => {
        const el = a as HTMLAnchorElement;
        const video = el.querySelector("video");
        const source = el.querySelector("video source") as HTMLSourceElement | null;
        const img = el.querySelector("noscript img") as HTMLImageElement | null;
        return {
          href: el.getAttribute("href"),
          poster: video?.getAttribute("poster") || null,
          mp4: source?.getAttribute("src") || null,
          // <noscript> content is inert markup in a script-enabled browser
          // (never parsed into a real <img>), so its src has to be read
          // out of the raw innerHTML, not a live element query.
          gifHtml: el.querySelector("noscript")?.innerHTML || null,
        };
      });
    });
    console.log(`found ${thumbs.length} demo thumbnail(s) on the landing page`);
    if (thumbs.length < 4) fail(`expected at least 4 demo thumbnails on the landing page (site/build.ts's cardsHtml + refTiles), found ${thumbs.length}`);

    async function urlOk(path: string): Promise<boolean> {
      try {
        const r = await fetch(`http://127.0.0.1:${PORT}/${path.replace(/^\/+/, "")}`);
        return r.ok;
      } catch {
        return false;
      }
    }

    for (const t of thumbs) {
      const label = t.mp4 || t.href || "(unknown thumbnail)";
      if (!t.href) { fail(`thumbnail has no href to a run page: ${label}`); continue; }
      if (!(await urlOk(t.href))) fail(`thumbnail's run-page link 404s: ${t.href}`);
      if (!t.mp4) fail(`thumbnail has no <source> mp4: ${label}`);
      else if (!(await urlOk(t.mp4))) fail(`thumbnail's mp4 404s: ${t.mp4}`);
      if (!t.poster) fail(`thumbnail has no poster image: ${label}`);
      else if (!(await urlOk(t.poster))) fail(`thumbnail's poster 404s: ${t.poster}`);
      const gifSrcMatch = t.gifHtml?.match(/src="([^"]+)"/);
      if (!gifSrcMatch) fail(`thumbnail has no <noscript> gif fallback: ${label}`);
      else if (!(await urlOk(gifSrcMatch[1]!))) fail(`thumbnail's gif fallback 404s: ${gifSrcMatch[1]}`);
    }
    if (failures === 0) console.log("PASS: every landing-page thumbnail has a working video, poster, gif fallback, and run-page link");
    await page.close();
  }

  // ---- 2. every run page: contained at 390/700/1280, and never scrolls
  // horizontally at any of those widths ------------------------------------
  const runDir = join(DIST, "run");
  const runPages = readdirSync(runDir).filter((f) => f.endsWith(".html"));
  console.log(`\nfound ${runPages.length} run page(s): ${runPages.join(", ")}`);

  const WIDTHS = [390, 700, 1280];

  async function checkRunPage(page: Page, file: string, width: number): Promise<void> {
    await page.setViewport({ width, height: 1600 });
    await page.goto(`http://127.0.0.1:${PORT}/run/${file}`, { waitUntil: "domcontentloaded" });
    // Let the embedded iframe boot (fetch -> instantiate -> first ticks)
    // and this page's own fit()/embed-scale settle.
    await new Promise((r) => setTimeout(r, 1800));

    // No horizontal scroll ANYWHERE on the page - not just the device.
    const scrollWidth = await page.evaluate(() => document.scrollingElement!.scrollWidth);
    const viewportWidth = await page.evaluate(() => window.innerWidth);
    if (scrollWidth > viewportWidth + 1) {
      fail(`${file} @ ${width}px: page scrolls horizontally (scrollWidth ${scrollWidth} > viewport ${viewportWidth})`);
    } else {
      console.log(`  [${width}px] ${file}: no horizontal overflow (scrollWidth ${scrollWidth} <= viewport ${viewportWidth})`);
    }

    // The device itself must fit entirely inside its iframe's viewport -
    // the transform-origin regression this file's header comment covers.
    const frame = page.frames().find((f) => f !== page.mainFrame() && /[?&]module=/.test(f.url()));
    if (!frame) {
      fail(`${file} @ ${width}px: no embedded emulator iframe found`);
      return;
    }
    let result: { ok: boolean; reason: string } | null = null;
    try {
      result = await frame.evaluate((eps) => {
        const bezel = document.querySelector("#bezel") as HTMLElement | null;
        if (!bezel) return { ok: false, reason: "no #bezel element found in frame" };
        const r = bezel.getBoundingClientRect();
        const vw = window.innerWidth, vh = window.innerHeight;
        const fits = r.left >= -eps && r.top >= -eps && r.right <= vw + eps && r.bottom <= vh + eps;
        return { ok: fits, reason: `bezel rect (${r.left.toFixed(1)},${r.top.toFixed(1)})-(${r.right.toFixed(1)},${r.bottom.toFixed(1)}) vs viewport ${vw}x${vh}` };
      }, 1);
    } catch (err) {
      result = { ok: false, reason: `evaluate failed: ${err instanceof Error ? err.message : String(err)}` };
    }
    const status = result!.ok ? "fits" : "OVERFLOWS";
    console.log(`  [${width}px] ${file}: device ${status} (${result!.reason})`);
    if (!result!.ok) fail(`${file} @ ${width}px: embedded device overflows its iframe viewport (${result!.reason})`);
  }

  const page = await browser.newPage();
  page.on("pageerror", (e) => console.error("run page error:", e));
  for (const file of runPages) {
    console.log(`\n-- ${file} --`);
    for (const w of WIDTHS) {
      await checkRunPage(page, file, w);
    }
  }
  await page.close();

  if (failures === 0) {
    console.log(`\nPASS: every run page is contained and free of horizontal overflow at ${WIDTHS.join("px, ")}px`);
  } else {
    console.error(`\nFAIL: ${failures} check(s) failed - see above`);
    process.exitCode = 1;
  }
} finally {
  server.stop(true);
  if (browser) await browser.close();
}
