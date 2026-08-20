// site/record-demos.ts: records the landing page's own demo loops.
//
//   bun run site:build             # once, produces site/dist/ (modules + emu bundle)
//   bun run site/record-demos.ts   # writes site/demo-media/<id>.{mp4,gif,png}
//   bun run site:build             # again, copies that media into site/dist/assets/demos/
//
// This is packs/rp2350-touch-amoled-18/tools/demo.ts's sibling, extended
// past one pack's own README GIF into the landing page's whole card set.
// Same shape (a real Chrome via puppeteer-core, CDP screencast frames
// resampled to a fixed rate, ffmpeg for the encode - see that file's own
// header for why a browser and not a synthetic clock), three differences:
//
//   - it drives the BUILT static site (site/dist/, via scripts/staticSite's
//     serveDist) rather than the dev server, at the exact ?embed=1&module=
//     URL every run page already uses - the thing being recorded is the
//     public embed, not a dev-UI page with chrome hidden by injected CSS;
//   - embed mode (src/app.css, this task's own "bare floating device" pass)
//     already IS the bare device with no control strip, so there is no
//     chrome left to hide here at all;
//   - it records four different combos, each with its own short
//     choreography, not one long tour of a single pack's apps.
//
// Every gesture below goes through the exact same input paths a visitor
// has: mouse/pointer events on the panel, and the "r"/"s" keyboard
// shortcuts main.ts's buildChrome registers - nothing here pokes ABI calls
// or internal state directly. A hidden (display:none, per embed CSS)
// button can still be clicked programmatically (a synthetic click still
// dispatches and runs handlers; only rendering is suppressed), which is
// used below for one precise, one-shot rotation (chrono's menu is drawn in
// a fixed landscape layout, so this needs an exact quarter turn, not
// whichever step "r" happens to land on next).
import puppeteer, { type Page, type KeyInput } from "puppeteer-core";
import { join } from "node:path";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { serveDist } from "../scripts/staticSite";

const ROOT = join(import.meta.dir, "..");
const DIST = join(ROOT, "site", "dist");
const OUT_DIR = join(import.meta.dir, "demo-media");
const PORT = 53415; // distinct from verify.ts (53409), demo.ts/verify-embed.ts (53411), verify-site-embeds.ts/verify-flash-ui.ts (53413/53412-ish)

const FPS = 12.5; // same reasoning as demo.ts: exactly 8cs a frame, no rounding
const MAX_COLORS = 64;
const BEZEL_PAD = 18; // app.css's --bezel-pad
const MARGIN_PX = 24; // breathing room around the device, both axes

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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

function findFfmpeg(): string {
  const candidates = [
    process.env.FFMPEG_EXE,
    "C:/Users/sylve/tools/ffmpeg/ffmpeg.exe",
    "/usr/bin/ffmpeg",
    "/usr/local/bin/ffmpeg",
    "/opt/homebrew/bin/ffmpeg",
  ].filter(Boolean) as string[];
  for (const c of candidates) if (existsSync(c)) return c;
  return "ffmpeg";
}

if (!existsSync(DIST)) {
  console.error("FAIL: site/dist/ does not exist. Run `bun run site:build` first (this script drives the built site).");
  process.exit(1);
}

function findChromeOrExit(): string {
  try {
    return process.env.CHROME_PATH || findChrome();
  } catch (err) {
    console.error(`FAIL: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}
const CHROME = findChromeOrExit();

// ---- panel-relative input helpers -----------------------------------------
// Every gesture is expressed as a FRACTION of #panel's current, on-screen
// bounding rect (0..1 on each axis), never a raw pixel constant: the rect
// already reflects whatever rotation is currently applied (a CSS transform
// changes what getBoundingClientRect() reports, axis-aligned, even for a
// quarter turn), so "tap near this fraction of what's visible" lands on
// the right on-screen spot regardless of orientation, the same way a real
// finger aiming at what it sees would.
interface Ctx {
  page: Page;
  rect(): Promise<{ x: number; y: number; w: number; h: number }>;
  tap(fx: number, fy: number, holdMs?: number): Promise<void>;
  stroke(pts: [number, number][], stepMs?: number): Promise<void>;
  clickButton(dataDeg: number): Promise<void>;
  keyTap(key: KeyInput, holdMs?: number): Promise<void>;
  keyHold(key: KeyInput, ms: number): Promise<void>;
}

// Bounding-box rect of a selector's element, in the SAME viewport (client)
// coordinate space Page.screencastFrame's own pixels are captured in
// (deviceScaleFactor is forced to 1, see puppeteer.launch args below, so CSS
// px === recorded px, no DPR conversion needed here).
function makeRectReader(page: Page, sel: string) {
  return () =>
    page.$eval(sel, (el) => {
      const r = el.getBoundingClientRect();
      return { x: r.x, y: r.y, w: r.width, h: r.height };
    });
}

function makeCtx(page: Page): Ctx {
  // #panel, not #bezel: site/build.ts now draws the device's own bezel and
  // button chrome in CSS/HTML around the card (a détouré device on the
  // page's own background - see that file's renderCardDevice), and the
  // recorded clip crops to #panel alone, a plain rectangle with no
  // background pixels of its own to bake in, unlike a rounded bezel's own
  // bounding box (which always has small leftover-background corner
  // triangles once cropped to an axis-aligned rectangle).
  const rect = makeRectReader(page, "#panel");
  function at(r: { x: number; y: number; w: number; h: number }, fx: number, fy: number): [number, number] {
    return [r.x + fx * r.w, r.y + fy * r.h];
  }
  return {
    page,
    rect,
    async tap(fx, fy, holdMs = 90) {
      const r = await rect();
      const [x, y] = at(r, fx, fy);
      await page.mouse.move(x, y);
      await sleep(110);
      await page.mouse.down();
      await sleep(holdMs);
      await page.mouse.up();
    },
    async stroke(pts, stepMs = 16) {
      const r = await rect();
      const [x0, y0] = at(r, pts[0]![0], pts[0]![1]);
      await page.mouse.move(x0, y0);
      await sleep(60);
      await page.mouse.down();
      await sleep(stepMs);
      for (const [fx, fy] of pts.slice(1)) {
        const [x, y] = at(r, fx, fy);
        await page.mouse.move(x, y);
        await sleep(stepMs);
      }
      await sleep(40);
      await page.mouse.up();
    },
    async clickButton(dataDeg) {
      await page.evaluate((deg) => {
        const btn = document.querySelector(`#rotQuick button[data-deg="${deg}"]`) as HTMLButtonElement | null;
        btn?.click();
      }, dataDeg);
    },
    async keyTap(key, holdMs = 110) {
      await page.keyboard.down(key);
      await sleep(holdMs);
      await page.keyboard.up(key);
    },
    async keyHold(key, ms) {
      await page.keyboard.down(key);
      await sleep(ms);
      await page.keyboard.up(key);
    },
  };
}

// The BOOT+PWR chord that opens rp2350's app menu (device.json's own
// "menu" gesture): held via the keyboard, same as demo.ts, since that is
// what makes a two-button gesture performable with one mouse at all.
async function chord(page: Page): Promise<void> {
  await page.keyboard.down("b");
  await sleep(200);
  await page.keyboard.down("p");
  await sleep(1650); // declared longPressMs is 1500
  await page.keyboard.up("p");
  await page.keyboard.up("b");
}
async function pressPwr(page: Page): Promise<void> {
  await page.keyboard.down("p");
  await sleep(120);
  await page.keyboard.up("p");
}

async function waitPanelReady(page: Page): Promise<void> {
  await page.waitForFunction(() => {
    const c = document.querySelector("canvas#panel") as HTMLCanvasElement | null;
    return !!c && c.width > 1;
  }, { timeout: 15000 });
  await sleep(300);
}

// menu.c's chrono tile, in the same fixed landscape layout demo.ts's own
// TILE_CHRONO/TILE_Y constants describe (see that file's header): as
// fractions of the 448x368 landscape box those pixel constants were
// measured against, so this keeps working if the panel size ever changes
// scale (the ratio is what the firmware's layout is drawn against, not the
// absolute pixel count).
const CHRONO_TILE_FX = 74 / 448;
const CHRONO_TILE_FY = 72 / 368;

// ---- per-combo choreography ------------------------------------------------
// Each one assumes waitPanelReady() already ran and records everything
// itself returns time for - callers add nothing before/after beyond the
// screencast start/stop.
interface DemoSpec {
  id: string;
  panelW: number;
  panelH: number;
  // Anything that should happen BEFORE the screencast starts (menu
  // navigation, an initial rotation) - not part of the visible loop.
  preroll?: (ctx: Ctx) => Promise<void>;
  // The recorded choreography itself.
  play: (ctx: Ctx) => Promise<void>;
}

const DEMOS: DemoSpec[] = [
  {
    id: "chrono-rp2350",
    panelW: 368,
    panelH: 448,
    async preroll(ctx) {
      await chord(ctx.page); // opens the menu
      await sleep(500);
      await ctx.clickButton(-90); // menu.c draws landscape; same quarter-turn every chrono run page auto-applies
      await sleep(350);
      await ctx.tap(CHRONO_TILE_FX, CHRONO_TILE_FY); // select chrono
      await sleep(350);
    },
    async play(ctx) {
      await sleep(900); // idle at zero, so the loop's own seam reads as "about to start" rather than a jump cut
      await pressPwr(ctx.page); // start
      await sleep(4200);
      await pressPwr(ctx.page); // stop
      await sleep(2400); // hold the stopped digits before the loop restarts
    },
  },
  {
    id: "fluidbox-rp2350",
    panelW: 368,
    panelH: 448,
    async play(ctx) {
      // No mid-clip rotation (dropped per this task's own "détouré cards"
      // brief): a quarter-turn quick-rotate used to make #bezel's own
      // bounding box span two different rects across the clip (0deg
      // portrait -> 90deg landscape), which is exactly what forced the old
      // union-rect crop, and a union crop is a bigger rectangle than
      // either single orientation - baking in background on every side.
      // #panel alone never needs that: settle, stir, shake is enough to
      // show real dynamic flow without ever moving the device itself.
      await sleep(2200); // watch the drop settle under fixed straight-down gravity
      // The stir (fluid.c's handle_touch: a finger drag pushes nearby
      // particles along the drag's own motion) is what actually shows
      // dynamic flow on camera, independent of gravity.
      await ctx.stroke(
        [
          [0.5, 0.75],
          [0.25, 0.7],
          [0.5, 0.65],
          [0.75, 0.7],
          [0.5, 0.75],
        ],
        90
      );
      await sleep(900);
      await ctx.keyTap("s"); // the shake sensor + puck-motion jolt
      await sleep(1500);
      await sleep(700); // hold before the loop restarts
    },
  },
  {
    id: "esp32-demo",
    panelW: 368,
    panelH: 448,
    async play(ctx) {
      await sleep(2800); // watch the square bounce off the walls under its own velocity
      await ctx.stroke(
        [
          [0.5, 0.4],
          [0.25, 0.25],
          [0.7, 0.25],
          [0.7, 0.7],
          [0.3, 0.7],
          [0.5, 0.45],
        ],
        260
      ); // touch down: the square snaps to and follows the finger directly (demo.c)
      await sleep(2200); // released: it resumes bouncing from wherever the drag let go
    },
  },
  {
    id: "example",
    panelW: 240,
    panelH: 240,
    async play(ctx) {
      await sleep(500);
      await ctx.stroke(
        [
          [0.3, 0.3],
          [0.36, 0.3],
          [0.42, 0.32],
          [0.48, 0.36],
        ],
        160
      ); // a small mark in the default ink
      await sleep(500);
      await ctx.keyTap("a"); // button A short press: cycles the ink colour (example/firmware/main.c)
      await sleep(500);
      await ctx.stroke(
        [
          [0.6, 0.65],
          [0.66, 0.62],
          [0.72, 0.68],
          [0.78, 0.6],
        ],
        160
      ); // a second mark, now in the new colour
      await sleep(500);
      await ctx.keyTap("b"); // button B: toggles the border, redraws the whole panel
      await sleep(2600); // hold so the border reads clearly before the loop restarts
    },
  },
  {
    id: "tinydraw-rp2350",
    panelW: 368,
    panelH: 448,
    async play(ctx) {
      await sleep(500);
      // A single stroke, fast-slow-fast: widely spaced points (large
      // distance per fixed stepMs = high speed = thin, radius_from_pressure's
      // "fast = light" model, tinydraw.c) at both ends, closely spaced
      // points (slow = thick) in the middle - the same shape this bundle's
      // own captured frames/tinydraw-demo.t750.png shows.
      await ctx.stroke(
        [
          [0.2, 0.28],
          [0.32, 0.34],
          [0.4, 0.38],
          [0.46, 0.41],
          [0.5, 0.43],
          [0.54, 0.45],
          [0.6, 0.47],
          [0.72, 0.53],
          [0.82, 0.58],
        ],
        50
      );
      await sleep(600);
      await ctx.keyTap("p"); // PWR short press: cycles the zoom level (1x -> 2x), reprojecting the stroke about the panel center
      await sleep(700);
      // A second, short stroke, drawn while zoomed.
      await ctx.stroke(
        [
          [0.3, 0.68],
          [0.4, 0.63],
          [0.5, 0.66],
          [0.58, 0.6],
        ],
        60
      );
      await sleep(700);
      await ctx.keyTap("b"); // BOOT click: undo removes exactly the most recent stroke
      await sleep(1500); // hold the single-stroke, zoomed result before the loop restarts
    },
  },
  {
    id: "gameos-esp32",
    panelW: 368,
    panelH: 448,
    async play(ctx) {
      // Byte-for-byte the same choreography as "gameos-rp2350" below: both
      // ports share this app's own launcher.c (identical CARD_GUN_Y0..Y1
      // layout, the same 184x224 game-space fractions), and neither demo
      // drives a tilt/accel gesture through the live page - both ports'
      // GUNSHIP aim starts centered and this choreography never asks it to
      // move, so there is nothing here that differs by port.
      await sleep(500); // idle on the launcher: two cards, GUNSHIP and LUCKY 7
      await ctx.tap(0.5, 0.335, 120); // the GUNSHIP card
      await sleep(700); // briefing screen
      await ctx.tap(0.5, 0.7, 900); // lower two-thirds: starts the mission, then holds to fire (GOS_CAP_TOUCH_FIRE)
      await sleep(900); // watch the wave in progress
      await ctx.stroke([[0.5, 0.03], [0.5, 0.22], [0.5, 0.42]], 90); // swipe down from the top strip: the always-available exit gesture, back to the launcher
      await sleep(500);
      await ctx.tap(0.5, 0.7, 120); // the LUCKY 7 card
      await sleep(700); // idle reels
      await ctx.stroke([[0.5, 0.35], [0.5, 0.55], [0.5, 0.75], [0.5, 0.9]], 70); // drag down on the reel unit: pulls the lever, the drag's own length sets the spin strength
      await sleep(2200); // watch the spin resolve
    },
  },
  {
    id: "gameos-rp2350",
    panelW: 368,
    panelH: 448,
    async play(ctx) {
      await sleep(500); // idle on the launcher: two cards, GUNSHIP and LUCKY 7
      await ctx.tap(0.5, 0.335, 120); // the GUNSHIP card (launcher.c's own CARD_GUN_Y0..Y1, as a fraction of the 184x224 gos layout)
      await sleep(700); // briefing screen
      await ctx.tap(0.5, 0.7, 900); // lower two-thirds: starts the mission, then holds to fire (GOS_CAP_TOUCH_FIRE)
      await sleep(900); // watch the wave in progress
      await ctx.stroke([[0.5, 0.03], [0.5, 0.22], [0.5, 0.42]], 90); // swipe down from the top strip: the always-available exit gesture, back to the launcher
      await sleep(500);
      await ctx.tap(0.5, 0.7, 120); // the LUCKY 7 card
      await sleep(700); // idle reels
      await ctx.stroke([[0.5, 0.35], [0.5, 0.55], [0.5, 0.75], [0.5, 0.9]], 70); // drag down on the reel unit: pulls the lever, the drag's own length sets the spin strength
      await sleep(2200); // watch the spin resolve
    },
  },
];

const onlyId = process.argv.find((a) => a.startsWith("--only="))?.slice("--only=".length);

const server = serveDist(DIST, PORT);

let browser: Awaited<ReturnType<typeof puppeteer.launch>> | null = null;
try {
  browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: true,
    args: ["--force-device-scale-factor=1", "--hide-scrollbars"],
  });

  mkdirSync(OUT_DIR, { recursive: true });
  const ffmpeg = findFfmpeg();

  for (const demo of DEMOS) {
    if (onlyId && demo.id !== onlyId) continue;
    console.log(`\n=== recording ${demo.id} ===`);
    const framesDir = mkdtempSync(join(tmpdir(), `puck-demo-${demo.id}-`));
    const page = await browser.newPage();
    page.on("pageerror", (e) => console.error(`  [${demo.id}] page error:`, e));
    try {
      const side = Math.max(demo.panelW, demo.panelH) + 2 * BEZEL_PAD + 2 * MARGIN_PX;
      await page.setViewport({ width: side, height: side, deviceScaleFactor: 1 });

      const moduleUrl = encodeURIComponent(`/modules/${demo.id}.wasm`);
      await page.goto(`http://127.0.0.1:${PORT}/emu/index.html?embed=1&module=${moduleUrl}`, { waitUntil: "domcontentloaded" });
      await waitPanelReady(page);

      const ctx = makeCtx(page);
      if (demo.preroll) await demo.preroll(ctx);

      const frames: Array<{ t: number; buf: Buffer }> = [];
      const cdp = await page.createCDPSession();
      cdp.on("Page.screencastFrame", async (ev: any) => {
        frames.push({ t: ev.metadata.timestamp * 1000, buf: Buffer.from(ev.data, "base64") });
        try {
          await cdp.send("Page.screencastFrameAck", { sessionId: ev.sessionId });
        } catch {}
      });
      // Measured once, right before the recorded choreography starts: with
      // the mid-clip device rotation dropped (see fluidbox's own play()
      // above), #panel's rect is constant for the whole clip on every demo
      // here, so there is no before/after union to compute any more - one
      // reading is the whole answer.
      const panelRect = await ctx.rect();
      await cdp.send("Page.startScreencast", { format: "png", everyNthFrame: 1 });
      const tStart = Date.now();

      await demo.play(ctx);

      const tEnd = Date.now();
      await cdp.send("Page.stopScreencast");
      await sleep(150);

      // Round to whole pixels, then to EVEN dimensions (yuv420p subsamples
      // chroma 2x2, so libx264 rejects an odd width/height outright), and
      // clamp inside the actual recorded canvas (side x side) so a
      // fractional getBoundingClientRect reading right at the edge can
      // never ask ffmpeg to crop past the frame it was given.
      const cropX = Math.max(0, Math.round(panelRect.x));
      const cropY = Math.max(0, Math.round(panelRect.y));
      const evenDown = (n: number) => Math.max(2, n % 2 === 0 ? n : n - 1);
      const cropW = evenDown(Math.min(Math.round(panelRect.w), side - cropX));
      const cropH = evenDown(Math.min(Math.round(panelRect.h), side - cropY));
      const cropFilter = `crop=${cropW}:${cropH}:${cropX}:${cropY}`;
      console.log(`  panel crop: ${cropW}x${cropH} at (${cropX},${cropY}) of the ${side}x${side} recorded canvas`);

      if (frames.length === 0) throw new Error(`${demo.id}: the screencast produced no frames`);
      frames.sort((a, b) => a.t - b.t);
      const intervalMs = 1000 / FPS;
      const count = Math.max(1, Math.floor((tEnd - tStart) / intervalMs));
      let cursor = 0;
      for (let i = 0; i < count; i++) {
        const t = tStart + i * intervalMs;
        while (cursor + 1 < frames.length && frames[cursor + 1]!.t <= t) cursor++;
        writeFileSync(join(framesDir, `f${String(i).padStart(4, "0")}.png`), frames[cursor]!.buf);
      }
      console.log(`  captured ${frames.length} frames over ${((tEnd - tStart) / 1000).toFixed(1)}s, resampled to ${count} at ${FPS}fps`);

      // Poster: the loop's own first frame, cropped identically to the mp4/gif
      // below (this used to be a plain copyFileSync of the raw, uncropped
      // frame - a browser that has not yet started/cannot autoplay the video
      // showed the OLD full-canvas still, poster and video mismatched).
      const posterPath = join(OUT_DIR, `${demo.id}.png`);
      const encPoster = Bun.spawnSync([
        ffmpeg, "-y", "-hide_banner", "-loglevel", "error",
        "-i", join(framesDir, "f0000.png"),
        "-vf", cropFilter,
        posterPath,
      ]);
      if (encPoster.exitCode !== 0) throw new Error(`ffmpeg (poster) failed (${encPoster.exitCode}): ${new TextDecoder().decode(encPoster.stderr)}`);

      const mp4Path = join(OUT_DIR, `${demo.id}.mp4`);
      const encMp4 = Bun.spawnSync([
        ffmpeg, "-y", "-hide_banner", "-loglevel", "error",
        "-framerate", String(FPS),
        "-i", join(framesDir, "f%04d.png"),
        "-vf", `${cropFilter},format=yuv420p`,
        "-c:v", "libx264",
        "-preset", "veryslow",
        "-crf", "30",
        "-movflags", "+faststart",
        "-an",
        mp4Path,
      ]);
      if (encMp4.exitCode !== 0) throw new Error(`ffmpeg (mp4) failed (${encMp4.exitCode}): ${new TextDecoder().decode(encMp4.stderr)}`);
      const mp4Kb = Math.round(statSync(mp4Path).size / 1024);

      const gifPath = join(OUT_DIR, `${demo.id}.gif`);
      const gifFilter = `${cropFilter},split [a][b];[a] palettegen=max_colors=${MAX_COLORS}:stats_mode=diff [p];[b][p] paletteuse=dither=none:diff_mode=rectangle`;
      const encGif = Bun.spawnSync([
        ffmpeg, "-y", "-hide_banner", "-loglevel", "error",
        "-framerate", String(FPS),
        "-i", join(framesDir, "f%04d.png"),
        "-filter_complex", gifFilter,
        "-loop", "0",
        gifPath,
      ]);
      if (encGif.exitCode !== 0) throw new Error(`ffmpeg (gif) failed (${encGif.exitCode}): ${new TextDecoder().decode(encGif.stderr)}`);
      const gifKb = Math.round(statSync(gifPath).size / 1024);

      console.log(`  wrote ${demo.id}.mp4 (${cropW}x${cropH}, ${count} frames, ${(count / FPS).toFixed(1)}s, ${mp4Kb} KB) + ${demo.id}.gif (${gifKb} KB) + ${demo.id}.png poster`);
      if (mp4Kb > 1536) console.warn(`  WARNING: ${demo.id}.mp4 is ${mp4Kb} KB, over the ~1.5MB target`);
    } finally {
      await page.close();
      rmSync(framesDir, { recursive: true, force: true });
    }
  }

  console.log(`\nwrote demo media to ${OUT_DIR}`);
} finally {
  if (browser) await browser.close();
  server.stop(true);
}
