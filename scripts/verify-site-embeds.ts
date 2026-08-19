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
import { closeBrowser } from "./browserClose";

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

async function fetchOk(path: string): Promise<boolean> {
  try {
    const r = await fetch(`http://127.0.0.1:${PORT}/${path.replace(/^\/+/, "")}`);
    return r.ok;
  } catch {
    return false;
  }
}

// site/build.ts's own contentHashOf: first 10 hex chars of a sha256 - this
// only checks the QUERY STRING SHAPE ("?v=" or "&v=" followed by hex), not
// that any specific hash is correct (fetchOk below is what proves the URL
// actually resolves against the built output, which is the real proof a
// stale cached copy would fail).
function hasVersion(url: string): boolean {
  return /[?&]v=[0-9a-f]{6,}(?:&|$)/i.test(url);
}

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

    for (const t of thumbs) {
      const label = t.mp4 || t.href || "(unknown thumbnail)";
      if (!t.href) { fail(`thumbnail has no href to a run page: ${label}`); continue; }
      if (!(await fetchOk(t.href))) fail(`thumbnail's run-page link 404s: ${t.href}`);
      if (!t.mp4) fail(`thumbnail has no <source> mp4: ${label}`);
      else if (!(await fetchOk(t.mp4))) fail(`thumbnail's mp4 404s: ${t.mp4}`);
      else if (!hasVersion(t.mp4)) fail(`thumbnail's mp4 has no ?v= cache-buster: ${t.mp4}`);
      if (!t.poster) fail(`thumbnail has no poster image: ${label}`);
      else if (!(await fetchOk(t.poster))) fail(`thumbnail's poster 404s: ${t.poster}`);
      else if (!hasVersion(t.poster)) fail(`thumbnail's poster has no ?v= cache-buster: ${t.poster}`);
      const gifSrcMatch = t.gifHtml?.match(/src="([^"]+)"/);
      if (!gifSrcMatch) fail(`thumbnail has no <noscript> gif fallback: ${label}`);
      else if (!(await fetchOk(gifSrcMatch[1]!))) fail(`thumbnail's gif fallback 404s: ${gifSrcMatch[1]}`);
      else if (!hasVersion(gifSrcMatch[1]!)) fail(`thumbnail's gif fallback has no ?v= cache-buster: ${gifSrcMatch[1]}`);
    }
    if (failures === 0) console.log("PASS: every landing-page thumbnail has a working, cache-busted video, poster, gif fallback, and run-page link");

    const stylesHref = await page.$eval('link[rel="stylesheet"]', (el) => el.getAttribute("href"));
    if (!stylesHref || !hasVersion(stylesHref)) fail(`index.html: styles.css link has no ?v= cache-buster (${stylesHref})`);
    else if (!(await fetchOk(stylesHref))) fail(`index.html: styles.css?v= 404s: ${stylesHref}`);
    else console.log(`PASS: index.html's styles.css link is cache-busted (${stylesHref})`);

    // Each card's own recorded video must actually match the aspect ratio
    // site/build.ts declared for it (demoAspect: the poster PNG's own
    // pixel dimensions, read at build time) - proof the crop this task
    // introduced (site/record-demos.ts, tight to #bezel) and the CSS box
    // it is displayed in (the card's own inline aspect-ratio style) agree,
    // so the video fills its card with no letterbox bars ("the device
    // itself, nothing else around it").
    await page.evaluate(
      () =>
        new Promise<void>((resolve) => {
          const vids = Array.from(document.querySelectorAll("video"));
          let pending = vids.length;
          if (pending === 0) { resolve(); return; }
          for (const v of vids) {
            if (v.readyState >= 1) { pending--; if (pending === 0) resolve(); continue; }
            v.addEventListener("loadedmetadata", () => { pending--; if (pending === 0) resolve(); }, { once: true });
          }
        })
    );
    const aspectChecks = await page.evaluate(() => {
      return Array.from(document.querySelectorAll("a.thumb-video")).map((a) => {
        const el = a as HTMLAnchorElement;
        const video = el.querySelector("video") as HTMLVideoElement | null;
        const m = (el.getAttribute("style") || "").match(/aspect-ratio:\s*([\d.]+)\s*\/\s*([\d.]+)/);
        return {
          href: el.getAttribute("href"),
          videoW: video?.videoWidth ?? 0,
          videoH: video?.videoHeight ?? 0,
          declaredW: m ? parseFloat(m[1]!) : null,
          declaredH: m ? parseFloat(m[2]!) : null,
        };
      });
    });
    for (const c of aspectChecks) {
      if (!c.videoW || !c.videoH) { fail(`${c.href}: card video metadata never loaded (${c.videoW}x${c.videoH})`); continue; }
      if (!c.declaredW || !c.declaredH) { fail(`${c.href}: card has no parsable aspect-ratio style`); continue; }
      const videoRatio = c.videoW / c.videoH;
      const declaredRatio = c.declaredW / c.declaredH;
      const pctOff = Math.abs(videoRatio - declaredRatio) / declaredRatio;
      if (pctOff > 0.05) {
        fail(
          `${c.href}: video intrinsic ${c.videoW}x${c.videoH} (ratio ${videoRatio.toFixed(3)}) is ${(pctOff * 100).toFixed(1)}% off ` +
            `the card's own bezel aspect ${c.declaredW}/${c.declaredH} (ratio ${declaredRatio.toFixed(3)})`
        );
      } else {
        console.log(`  ${c.href}: video ${c.videoW}x${c.videoH} matches bezel aspect ${c.declaredW}/${c.declaredH} (${(pctOff * 100).toFixed(1)}% off)`);
      }
    }
    if (failures === 0) console.log("PASS: every card video's intrinsic dimensions match its own bezel aspect within 5%");

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

  // ---- 3. cache-busting: every asset URL a run page emits carries ?v= and
  // resolves 200 - both the OUTER page's own refs (styles.css, flash.js,
  // the emu iframe's src) and, separately, the EMBEDDED emu/index.html
  // document's own internal refs to main.js/app.css/family-budget.css
  // (site/build.ts rewrites those during the copy step; a browser caches
  // them by their own url, resolved against that document, so the outer
  // page's iframe src carrying ?v= alone would not be enough - this is the
  // actual regression the cache-busting fix targets). --------------------
  {
    const page = await browser.newPage();
    for (const file of runPages) {
      await page.setViewport({ width: 700, height: 1200 });
      await page.goto(`http://127.0.0.1:${PORT}/run/${file}`, { waitUntil: "domcontentloaded" });
      await new Promise((r) => setTimeout(r, 1200));

      const stylesHref = await page.$eval('link[rel="stylesheet"]', (el) => el.getAttribute("href"));
      if (!stylesHref || !hasVersion(stylesHref)) fail(`${file}: styles.css link has no ?v= (${stylesHref})`);
      else if (!(await fetchOk(stylesHref))) fail(`${file}: styles.css?v= 404s: ${stylesHref}`);

      const flashSrc = await page
        .$eval('script[type="module"][src*="flash"]', (el) => el.getAttribute("src"))
        .catch(() => null);
      if (flashSrc) {
        if (!hasVersion(flashSrc)) fail(`${file}: flash.js script has no ?v= (${flashSrc})`);
        else if (!(await fetchOk(flashSrc))) fail(`${file}: flash.js?v= 404s: ${flashSrc}`);
      }

      const iframeSrc = await page.$eval("#emu", (el) => el.getAttribute("src"));
      if (!iframeSrc || !hasVersion(iframeSrc)) fail(`${file}: emu iframe src has no ?v= (${iframeSrc})`);
      else if (!(await fetchOk(iframeSrc.split("?")[0]!))) fail(`${file}: emu iframe src path 404s: ${iframeSrc}`);

      const frame = page.frames().find((f) => f !== page.mainFrame() && /[?&]module=/.test(f.url()));
      if (!frame) {
        fail(`${file}: no embedded emulator iframe found for the asset-versioning check`);
        continue;
      }
      const inner = await frame.evaluate(() => {
        const css = Array.from(document.querySelectorAll('link[rel="stylesheet"]')).map((l) => (l as HTMLLinkElement).href);
        const js = Array.from(document.querySelectorAll('script[type="module"]')).map((s) => (s as HTMLScriptElement).src);
        return [...css, ...js];
      });
      if (inner.length < 3) fail(`${file}: emu/index.html has only ${inner.length} internal asset ref(s), expected main.js + app.css + family-budget.css`);
      for (const u of inner) {
        const parsed = new URL(u);
        if (!hasVersion(parsed.search)) fail(`${file}: emu/index.html's own asset ref has no ?v=: ${u}`);
        else if (!(await fetchOk(parsed.pathname))) fail(`${file}: emu/index.html's own asset ref 404s: ${u}`);
      }
      console.log(`  ${file}: styles.css, flash.js (if any), the emu iframe, and its own main.js/app.css/family-budget.css all carry ?v= and resolve`);
    }
    await page.close();
    if (failures === 0) console.log("\nPASS: every run page's own assets, and the embedded emu bundle's internal assets, are cache-busted and resolve");
  }

  if (failures === 0) {
    console.log(`\nPASS: every run page is contained and free of horizontal overflow at ${WIDTHS.join("px, ")}px`);
  } else {
    console.error(`\nFAIL: ${failures} check(s) failed - see above`);
    process.exitCode = 1;
  }
} finally {
  server.stop(true);
  if (browser) await closeBrowser(browser);
}
