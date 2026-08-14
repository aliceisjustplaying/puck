// demo.ts: records the README's animated GIF by playing with the puck.
//
//   bun run device/wasm/build.ts     # once, produces wasm/dist/emu.wasm
//   bun run device/tools/demo.ts     # writes device/preview/demo.gif
//
// This is screens.ts's sibling. screens.ts dumps the firmware's own
// framebuffer to a still PNG headlessly, with a synthetic clock; this one
// needs the browser, so it drives the real emulator page in a real Chrome
// with puppeteer-core (the same way scripts/verify.ts does, same local-Chrome
// lookup, same server spawn, same Windows process-tree kill), and records
// what that page paints.
//
// WHY A BROWSER AND NOT A SYNTHETIC CLOCK. Two things a viewer needs are
// drawn by the page, not by the firmware:
//
//   - the touch-contact disc and its trail (src/touchoverlay.ts), without
//     which a drawing appears out of nowhere and a menu tile picks itself;
//   - the buttons on the puck's plastic, which visibly depress and fill as
//     a hold approaches its threshold (src/app.css, .dev-btn), which is the
//     only thing that makes the BOOT+PWR chord legible as a gesture rather
//     than as a screen that suddenly changes.
//
// Everything in the recording is painted by the emulator itself. Nothing
// here draws a cursor, a caption, a highlight or a frame of its own: this
// file only presses buttons, moves one mouse, and collects what came out.
// The one liberty taken is framing, not content: the page's own topbar,
// sidebar and bottom bar are hidden (injected CSS below) so the shot is the
// puck rather than a screenshot of a development tool.
//
// The three judgment calls, recorded here because they are the ones worth
// arguing with:
//
//   1. LENGTH. About 17 seconds, and it opens ON the menu with a finger
//      already reaching for an app: a README GIF that spends its first
//      seconds establishing anything is worse than the still it replaced.
//      The chord that opens the menu is therefore performed BEFORE recording
//      starts (see PRE-ROLL) and shown properly later, once the viewer has
//      context for it.
//   2. FRAME RATE. 12.5 fps (FPS below). A GIF's frame delay is stored in
//      centiseconds, so 12.5 is exactly 8cs and needs no rounding, and hand
//      movement at this rate still reads as a hand. Higher costs frames
//      linearly for motion nobody is studying.
//   3. LOOPING. Yes, forever (-loop 0). The session ends on a running
//      countdown and restarts on the menu, which reads as "another go"
//      rather than as a seam. END_HOLD_MS holds the last frame long enough
//      to register as an ending first.
//
// The page's clock is the browser's, so this recording is real time and
// NOT deterministic the way screens.ts is: two runs differ by a few
// milliseconds here and there. That is the same limitation decision 0003
// puts on the emulator itself, and it does not matter for a GIF.
import puppeteer from "puppeteer-core";
import { join } from "node:path";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";

const REPO_ROOT = join(import.meta.dir, "..", "..");
const OUT_DIR = join(import.meta.dir, "..", "preview");
const OUT_GIF = join(OUT_DIR, "demo.gif");
const WASM_FILE = join(REPO_ROOT, "wasm", "dist", "emu.wasm");
const PORT = 53411; // not verify.ts's 53409: the two must be able to run at once

const FPS = 12.5;
const MARGIN_PX = 30; // stage visible around the puck, room for its drop shadow
const MAX_COLORS = 64; // flat UI plus anti-aliased ink; 128 costs size, shows nothing
const END_HOLD_MS = 450; // hold the final frame before the loop restarts

// The panel, and the landscape space the apps actually draw in. The puck is
// held sideways, so the page is quick-rotated -90 degrees (VIEW_DEG) and
// every coordinate in the script below is landscape: x right, y down, as a
// person holding it sees it. Same space screens.ts calls "land".
const PANEL_W = 368;
const PANEL_H = 448;
const LAND_W = PANEL_H; // 448
const LAND_H = PANEL_W; // 368
const VIEW_DEG = -90;

// menu.c's three columns (icon centres), timer.c's ring, sketch.c's 3x3
// palette. All landscape. The palette tiles the whole panel, so a swatch
// centre is just the centre of its ninth.
const TILE_Y = 72;
const TILE_CHRONO = 74;
const TILE_SKETCH = 223;
const TILE_TIMER = 373;
const RING_CX = 224;
const RING_CY = 184;
const RING_R = 157; // mid-band: RING_INNER_R 141, RING_OUTER_R 173
const SWATCH_RED: L = [74, 306]; // palette index 0, panel (61,74) mapped to landscape

type L = [number, number]; // a landscape point

function findChrome(): string {
  // Same list and same reasoning as scripts/verify.ts: puppeteer-core
  // deliberately bundles no Chromium download. Duplicated rather than
  // imported because that file is a script with top-level side effects
  // (it spawns a server on import), not a module.
  const candidates = [
    "C:/Program Files/Google/Chrome/Application/chrome.exe",
    "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium-browser",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  ];
  for (const c of candidates) if (existsSync(c)) return c;
  throw new Error(
    "no local Chrome found in the usual locations. Set CHROME_PATH to your Chrome/Chromium executable."
  );
}

function findFfmpeg(): string {
  // ffmpeg is invoked as a binary, exactly like zig and cmake elsewhere in
  // this repo. No encoder is added as a dependency for one GIF a month.
  const candidates = [
    process.env.FFMPEG_EXE,
    "C:/Users/sylve/tools/ffmpeg/ffmpeg.exe",
    "/usr/bin/ffmpeg",
    "/usr/local/bin/ffmpeg",
    "/opt/homebrew/bin/ffmpeg",
  ].filter(Boolean) as string[];
  for (const c of candidates) if (existsSync(c)) return c;
  // Last resort: whatever is on PATH.
  return "ffmpeg";
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitForServer(url: string, timeoutMs: number): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const r = await fetch(url);
      if (r.ok) return;
    } catch {}
    await sleep(150);
  }
  throw new Error(`server did not come up within ${timeoutMs}ms`);
}

if (!existsSync(WASM_FILE)) {
  console.error(`FAIL: ${WASM_FILE} does not exist. Run "bun run device:build" first.`);
  process.exit(1);
}

const keepFrames = process.argv.includes("--keep-frames");
const framesDir = mkdtempSync(join(tmpdir(), "puck-demo-"));

const server = Bun.spawn(["bun", "run", "server.ts"], {
  cwd: REPO_ROOT,
  env: { ...process.env, PORT: String(PORT) },
  stdout: "pipe",
  stderr: "pipe",
});

let browser: Awaited<ReturnType<typeof puppeteer.launch>> | null = null;
try {
  await waitForServer(`http://127.0.0.1:${PORT}/`, 15000);

  browser = await puppeteer.launch({
    executablePath: process.env.CHROME_PATH || findChrome(),
    headless: true,
    args: ["--force-device-scale-factor=1", "--hide-scrollbars"],
  });
  const page = await browser.newPage();
  page.on("pageerror", (e) => console.error("page error:", e));

  // The frame IS the viewport: the puck rotated a quarter turn, plus a
  // margin. Nothing is cropped or scaled afterwards, so what the browser
  // composites is what lands in the GIF, pixel for pixel.
  const BEZEL_PAD = 18;
  const frameW = LAND_W + 2 * BEZEL_PAD + 2 * MARGIN_PX;
  const frameH = LAND_H + 2 * BEZEL_PAD + 2 * MARGIN_PX;
  await page.setViewport({ width: frameW, height: frameH, deviceScaleFactor: 1 });

  await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => {
    const c = document.querySelector("canvas#panel") as HTMLCanvasElement | null;
    return !!c && c.width > 1;
  }, { timeout: 15000 });
  await sleep(400);

  // Framing and page state, all through the page's own controls:
  //   - hide the development chrome (topbar, sidebar, bottom bar);
  //   - turn the touch-contact overlay ON (off by default: it is a
  //     diagnostic, and here it is the finger);
  //   - quick-rotate -90, which is how the puck is held and the same
  //     orientation screens.ts writes its stills in;
  //   - centre the puck in what is left, since the page's own centring ran
  //     against the layout that just got hidden.
  // Set through the elements' own change/click handlers, never by poking
  // internals, and focus is dropped afterwards: shortcuts.ts ignores keys
  // while an <input> has focus, which would silently kill every button
  // press in the script below.
  await page.addStyleTag({
    content: `
      .topbar, .side, .bottom-bar { display: none !important; }
      .layout { height: 100vh; }
      .stage { min-height: 0; height: 100vh; overflow: hidden; }
    `,
  });
  await page.evaluate((deg: number) => {
    const overlayOn = document.querySelector("#overlayOn") as HTMLInputElement;
    overlayOn.checked = true;
    overlayOn.dispatchEvent(new Event("change", { bubbles: true }));
    // Deliberately NOT #pushesOn: the push-window outlines are the other
    // half of this emulator's instrumentation and they would cover the
    // apps in fading rectangles. A finger is what a viewer needs here.
    const rot = document.querySelector(`#rotQuick button[data-deg="${deg}"]`) as HTMLButtonElement;
    rot.click();
    (document.activeElement as HTMLElement | null)?.blur();
  }, VIEW_DEG);
  await page.evaluate(() => {
    const stage = document.querySelector("#stage") as HTMLElement;
    const wrap = document.querySelector("#deviceWrap") as HTMLElement;
    const bezel = document.querySelector("#bezel") as HTMLElement;
    wrap.style.left = `${Math.round((stage.clientWidth - bezel.offsetWidth) / 2)}px`;
    wrap.style.top = `${Math.round((stage.clientHeight - bezel.offsetHeight) / 2)}px`;
  });
  await sleep(300);

  // Landscape -> client coordinates. A CSS rotation paints about the
  // element's own centre, so the panel's centre is fixed under it and the
  // rotated view space is just an offset from there (src/rotate.ts does the
  // inverse of this for real input).
  const centre = await page.$eval("#panel", (el) => {
    const r = el.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  });
  const at = (lx: number, ly: number): [number, number] => [
    centre.x + lx - LAND_W / 2,
    centre.y + ly - LAND_H / 2,
  ];

  const mouse = page.mouse;
  // steps:1 everywhere. Each extra interpolation step is another round trip
  // to the browser, and the round trip, not the sleep, is what actually
  // paces this script: sketch.c streamlines the points it receives anyway.
  async function moveTo(p: L) { await mouse.move(...at(p[0], p[1])); }
  async function tap(p: L, holdMs = 90) {
    await moveTo(p);
    await sleep(110); // the hover ring lands before the press does
    await mouse.down();
    await sleep(holdMs);
    await mouse.up();
  }
  // A drawn stroke: one press, a path, one release. stepMs paces it like a
  // hand, not like a mouse teleporting; sketch.c derives its pen pressure
  // from stroke speed, so this is also what gives the ink its varying width.
  async function stroke(pts: L[], stepMs = 14) {
    await moveTo(pts[0]!);
    await sleep(60);
    await mouse.down();
    await sleep(stepMs);
    for (const p of pts.slice(1)) {
      await moveTo(p);
      await sleep(stepMs);
    }
    await sleep(40);
    await mouse.up();
  }
  function arc(cx: number, cy: number, r: number, fromDeg: number, toDeg: number, stepDeg: number): L[] {
    const pts: L[] = [];
    const dir = toDeg >= fromDeg ? 1 : -1;
    for (let a = fromDeg; dir > 0 ? a <= toDeg : a >= toDeg; a += dir * stepDeg) {
      const rad = (a * Math.PI) / 180;
      pts.push([cx + r * Math.cos(rad), cy + r * Math.sin(rad)]);
    }
    return pts;
  }
  // The BOOT+PWR chord (runtime_core.c): hold BOOT, then hold PWR until
  // PWR's long-press verdict lands. Driven from the keyboard, which is what
  // makes a two-button gesture performable at all with one mouse (main.ts's
  // buildChrome assigns b and p from the descriptor's button ids).
  async function chord() {
    await page.keyboard.down("b");
    await sleep(200);
    await page.keyboard.down("p");
    await sleep(1650); // the declared longPressMs is 1500
    await page.keyboard.up("p");
    await page.keyboard.up("b");
  }
  async function pressPwr() {
    await page.keyboard.down("p");
    await sleep(120);
    await page.keyboard.up("p");
  }

  // ---- PRE-ROLL, not recorded: open the menu, so frame one is already the
  // toy rather than a stopwatch waiting for something to happen.
  await chord();
  await sleep(500);

  // ---- capture ------------------------------------------------------------
  const frames: Array<{ t: number; buf: Buffer }> = [];
  const cdp = await page.createCDPSession();
  cdp.on("Page.screencastFrame", async (ev: any) => {
    frames.push({ t: ev.metadata.timestamp * 1000, buf: Buffer.from(ev.data, "base64") });
    try {
      await cdp.send("Page.screencastFrameAck", { sessionId: ev.sessionId });
    } catch {}
  });
  await cdp.send("Page.startScreencast", { format: "png", everyNthFrame: 1 });
  const tStart = Date.now();
  // Every phase's real elapsed time, printed at the end. The script's own
  // sleeps are only half of it: each mouse move is a round trip to the
  // browser, so a stroke's true duration is measured, never assumed.
  const marks: Array<[string, number]> = [];
  const mark = (what: string) => marks.push([what, Date.now() - tStart]);

  // ---- the session --------------------------------------------------------
  // The menu is up. Pick the sketchpad.
  await sleep(350);
  await tap([TILE_SKETCH, TILE_Y]);
  await sleep(320);
  mark("menu -> sketchpad");

  // A face, the way a child draws one: one loop, two eyes, a mouth.
  await stroke(arc(168, 178, 90, -100, 262, 20));
  await sleep(90);
  await stroke([[138, 148], [140, 160]], 35);
  await sleep(80);
  await stroke([[198, 148], [200, 160]], 35);
  await sleep(90);
  await stroke(arc(168, 186, 62, 35, 145, 16));
  await sleep(260);
  mark("drew a face");

  // Hold still on bare paper: sketch.c opens the nine-colour palette after
  // 550ms inside a 12px radius. Then drag to red and lift over it.
  await moveTo([352, 150]);
  await sleep(120);
  await mouse.down();
  // 550ms of it opens the palette; the rest is the pop-in landing and a
  // beat to read nine colours. The mouse does not move at all here, which
  // is the gesture: HOLD_STILL_RADIUS_PX is 12.
  await sleep(1050);
  for (let i = 1; i <= 8; i++) {
    await moveTo([352 + ((SWATCH_RED[0] - 352) * i) / 8, 150 + ((SWATCH_RED[1] - 150) * i) / 8]);
    await sleep(25);
  }
  await sleep(420); // the candidate cell, grown, under the finger
  await mouse.up();
  await sleep(380);
  mark("palette: opened, picked red");

  // Draw again, now in red: hair.
  for (const a of [-140, -110, -80, -50]) {
    const rad = (a * Math.PI) / 180;
    await stroke(
      [
        [168 + 86 * Math.cos(rad), 178 + 86 * Math.sin(rad)],
        [168 + 118 * Math.cos(rad), 178 + 118 * Math.sin(rad)],
      ],
      35
    );
  }
  await sleep(320);
  mark("drew in red");

  // Back to the menu with the chord, and on to the stopwatch.
  await chord();
  await sleep(400);
  await tap([TILE_CHRONO, TILE_Y]);
  await sleep(280);
  mark("chord -> menu -> stopwatch");
  await pressPwr(); // PWR runs it
  await sleep(1800);
  mark("stopwatch running");

  // And the timer: wind the dial like a hose. A full turn is fifteen
  // minutes (timer.c: 180 ticks a lap, 5 seconds a tick), and going round
  // past twelve o'clock starts a second, inner lap.
  //
  // The chord is performed with the stopwatch still RUNNING, deliberately:
  // it is a 1.5s hold, and 1.5s of frozen digits is 1.5s of nothing to
  // watch. Stopping it is PWR again, which the README says and this does
  // not need to spend a second and a half proving twice.
  await chord();
  await sleep(380);
  await tap([TILE_TIMER, TILE_Y]);
  await sleep(280);
  mark("chord -> menu -> timer");
  await stroke(arc(RING_CX, RING_CY, RING_R, -90, 390, 9), 6);
  await sleep(200);
  await pressPwr(); // running: the coil unwinds
  await sleep(700);
  mark("wound the dial and started it");

  await sleep(END_HOLD_MS);
  const tEnd = Date.now();
  await cdp.send("Page.stopScreencast");
  await sleep(200);

  // ---- resample to a fixed frame rate ------------------------------------
  // Screencast frames arrive when the compositor produces one, so they are
  // neither evenly spaced nor guaranteed at all while nothing moves. Each
  // output slot therefore takes the last frame that was on screen at that
  // instant, which is exactly what a camera pointed at the page would have
  // recorded, and holds it when nothing changed.
  if (frames.length === 0) throw new Error("the screencast produced no frames");
  frames.sort((a, b) => a.t - b.t);
  const intervalMs = 1000 / FPS;
  const count = Math.max(1, Math.floor((tEnd - tStart) / intervalMs));
  let cursor = 0;
  for (let i = 0; i < count; i++) {
    const t = tStart + i * intervalMs;
    while (cursor + 1 < frames.length && frames[cursor + 1]!.t <= t) cursor++;
    writeFileSync(join(framesDir, `f${String(i).padStart(4, "0")}.png`), frames[cursor]!.buf);
  }
  console.log(
    `captured ${frames.length} screencast frames over ${((tEnd - tStart) / 1000).toFixed(1)}s, ` +
      `resampled to ${count} at ${FPS} fps`
  );
  for (const [what, t] of marks) console.log(`  ${(t / 1000).toFixed(1).padStart(5)}s  ${what}`);

  // ---- encode -------------------------------------------------------------
  mkdirSync(OUT_DIR, { recursive: true });
  const ffmpeg = findFfmpeg();
  const filter =
    `split [a][b];[a] palettegen=max_colors=${MAX_COLORS}:stats_mode=diff [p];` +
    `[b][p] paletteuse=dither=none:diff_mode=rectangle`;
  const enc = Bun.spawnSync([
    ffmpeg, "-y", "-hide_banner", "-loglevel", "error",
    "-framerate", String(FPS),
    "-i", join(framesDir, "f%04d.png"),
    "-filter_complex", filter,
    "-loop", "0",
    OUT_GIF,
  ]);
  if (enc.exitCode !== 0) {
    throw new Error(`ffmpeg failed (${enc.exitCode}): ${new TextDecoder().decode(enc.stderr)}`);
  }
  const kb = Math.round(statSync(OUT_GIF).size / 1024);
  console.log(`wrote ${OUT_GIF} (${frameW}x${frameH}, ${count} frames, ${(count / FPS).toFixed(1)}s, ${kb} KB)`);
} finally {
  if (browser) await browser.close();
  // Windows: the dev server's own file watcher survives a plain SIGTERM,
  // exactly as scripts/verify.ts documents.
  server.kill();
  try {
    Bun.spawnSync(["taskkill", "/pid", String(server.pid), "/t", "/f"], { stdout: "ignore", stderr: "ignore" });
  } catch {}
  if (keepFrames) console.log(`frames kept in ${framesDir}`);
  else rmSync(framesDir, { recursive: true, force: true });
}
