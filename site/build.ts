// site/build.ts: builds the public gallery, site/dist/, the COMMITTED
// static output Cloudflare Pages serves as-is (no Pages-side build). This
// script is the only build step; site/dist/ is checked in.
//
// What it does, in order:
//   1. For every proven app+pack combo (from registry.json + each app's
//      bundle.json, not hand-listed twice), invoke that pack's own
//      wasm/build.ts with the arguments its port README documents. Every
//      pack build writes the SAME repo-root wasm/dist/emu.wasm (see each
//      pack's own build.ts header comment), so these run one at a time,
//      and each output is copied out to site/dist/modules/<combo>.wasm
//      before the next build overwrites it.
//   2. Runs the repo's own root build.ts (bun run build), which produces a
//      plain static bundle of the emulator page (index.html, main.js,
//      family-budget.css, app.css). Copied once into site/dist/emu/ and
//      shared by every run page: one bundle, loaded with a different
//      module each time via the ?module= hook (src/main.ts).
//   3. Writes one run page per combo (site/dist/run/<combo>.html): this
//      repository's own design, embedding the shared emulator bundle in an
//      iframe pointed at that combo's module.
//   4. Writes the gallery (site/dist/index.html) from the same
//      registry.json + bundle.json data used to decide which combos to
//      build, plus a small hand-written table of labels and GitHub doc
//      links (registry.json and bundle.json carry no prose).
//
// Idempotent: every step is deterministic (a compiled .wasm from the same
// C, a template rendered from the same data), so running this twice
// produces byte-identical site/dist/, no timestamps embedded anywhere.
//
// TypeScript only, no shell script, per this repo's own AGENTS.md.
import { existsSync, mkdirSync, rmSync, copyFileSync, readFileSync, writeFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";

const SITE_DIR = import.meta.dir;
const REPO_ROOT = resolve(SITE_DIR, "..");
const DIST = join(SITE_DIR, "dist");
const GITHUB_BASE = "https://github.com/s0lness/puck/blob/master";

function gh(path: string): string {
  return `${GITHUB_BASE}/${path}`;
}

// ---- content-hash cache busting ------------------------------------------
// Every asset URL this generator emits is otherwise stable across a deploy
// (same filename every build), which is exactly what let Safari go on
// serving a PREVIOUS deploy's emu/main.js, emu/app.css and styles.css after
// a new one shipped (Sylve's own iPhone report: a new hint line rendering
// next to an old, already-fixed layout bug - two different deploys'
// output, stitched together by a cache that had no reason to refetch
// anything). First 10 hex chars of the CONTENT's own sha256, not a build
// timestamp: deterministic given the same bytes, so two consecutive builds
// with no source changes emit byte-identical query strings (this file's own
// idempotency contract) - a clock-based cache-buster would fail that.
function contentHashOf(filePath: string): string {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex").slice(0, 10);
}
function withVersion(url: string, hash: string): string {
  return `${url}${url.includes("?") ? "&" : "?"}v=${hash}`;
}

// ---- read the data that decides what gets built -------------------------
interface Registry {
  packs: { name: string; path: string }[];
  apps: { name: string; path: string }[];
}
// Schema v0.2 (docs/convention/app-bundle.md): one "ports" entry per pack
// this app is proven on, replacing 0.1's loose "provenPacks" array. Read
// generically here (verification only down to its "kind" discriminator,
// the two shapes' own extra fields are the verifier's concern, not the
// site generator's) so this file never has to know the difference between
// a pixel-exact port and an invariants one beyond that one label.
interface BundlePort {
  pack: string;
  mode: string;
  verification: { kind: string };
  source: string;
  // Optional, beyond the bundle schema's minimal shape (documented in
  // app-bundle.md alongside "buildArgs"): the porting flow's own
  // go/degraded/refuse verdict (docs/convention/app-bundle.md's "Porting
  // flow"), carried through so a degraded port (fluidbox's touch-and-
  // fixed-gravity rp2350 port) still reads as degraded here, the way 0.1's
  // per-pack "degraded" boolean used to.
  verdict?: "go" | "degraded";
  // Present once a port has been run against real hardware, not only the
  // emulator (docs/convention/app-bundle.md): an attestation, not an
  // automatic guarantee. Drives the matrix's second mark, below.
  silicon?: { attestedAt: string; how: string };
}
interface ChronoLikeBundle {
  convention: string;
  name: string;
  ports: BundlePort[];
}
interface ProvenEntry {
  pack: string;
  mode: string;
  verification: string;
  degraded: boolean;
  silicon: { attestedAt: string; how: string } | null;
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

const registry = readJson<Registry>(join(REPO_ROOT, "registry.json"));

const packLabel = new Map<string, string>();
// Panel dimensions per pack, read from the SAME device.json packLabel
// already reads (not a second file read) - what sizes each run page's
// embed iframe below, so a run page never hardcodes one device's pixel
// size the way the shared instrument itself is forbidden to (AGENTS.md's
// "nothing names one device" is about src/server.ts/harness/, not this
// site generator, but staying data-driven here costs nothing and avoids a
// magic number per pack anyway).
const packPanel = new Map<string, { w: number; h: number }>();
const packHasVectorSensor = new Map<string, boolean>();
// A device's own buttons (edge + fractional position along it), read from
// the SAME device.json as panel/label above: what site/build.ts's own CSS
// device frame (renderCardDevice, below) draws around the panel-only demo
// video, so the détouré card reads as the same device the run page embeds
// rather than a generic rounded rectangle. Real device geometry (nub
// length/thickness/protrusion) mirrors src/device.ts's
// BTN_LENGTH_PX/BTN_THICKNESS_PX/BTN_OFFSET_PX (restated below, same
// "small enough that a shared constants module is more indirection than
// the number" reasoning as BEZEL_PAD itself already documents).
interface PackButton {
  edge: "left" | "right" | "top" | "bottom";
  at: number;
}
const packButtons = new Map<string, PackButton[]>();
for (const p of registry.packs) {
  const device = readJson<{
    name?: string;
    panel?: { w: number; h: number };
    sensors?: { id: string; kind: string }[];
    buttons?: { edge: "left" | "right" | "top" | "bottom"; at: number }[];
  }>(join(REPO_ROOT, p.path, "device.json"));
  packLabel.set(p.name, device.name || p.name);
  if (device.panel) packPanel.set(p.name, device.panel);
  packHasVectorSensor.set(p.name, (device.sensors || []).some((sensor) => sensor.kind === "vector"));
  packButtons.set(p.name, (device.buttons || []).map((b) => ({ edge: b.edge, at: b.at })));
}

// src/app.css's --bezel-pad, and site/record-demos.ts's own BEZEL_PAD (same
// source of truth, restated in each file since neither imports the other -
// this repo's device geometry values are small enough that a shared
// constants module would be more indirection than the number itself). Read
// by cardDeviceGeometry below, which draws the landing cards' own CSS
// device frame at this same proportion.
const BEZEL_PAD = 18;
// src/device.ts's own BTN_LENGTH_PX / BTN_THICKNESS_PX (a third
// restatement of the same small geometry constants, for the same reason
// as BEZEL_PAD above): a button nub is 56px along its edge, 14px thick.
// Real hardware protrudes past the bezel's own edge (BTN_OFFSET_PX in
// src/device.ts) - the card frame does NOT reproduce that protrusion
// (see cardDeviceGeometry's own header): a nub is drawn flush, INSET
// inside the bezel's own edge instead, so the bezel itself can span the
// card's full width with nothing left over for a protruding button to
// clip against.
const BTN_LENGTH_PX = 56;
const BTN_THICKNESS_PX = 14;

// The full on-page geometry for one détouré landing card: a device bezel
// drawn entirely in CSS, filling the card's own full width (Sylve's own
// read: the device should be as big as the text block below it, not
// sitting in a smaller box with margin around it), with the recorded
// video filling only the rectangular panel inside it. Every number here
// is a PERCENTAGE of some containing box, never a pixel, so the same card
// renders correctly at any width a responsive grid gives it - the actual
// recorded clip is cropped to #panel alone (site/record-demos.ts), a
// plain rectangle with no background pixels, so the only thing that can
// ever look "not-detoure" is this CSS frame itself now, not a recording
// artifact.
interface CardDeviceGeometry {
  bezelW: number; // bezel's own real px size (== the card's own aspect-ratio)
  bezelH: number;
  bezelRadius: string; // border-radius, as an inline CSS value (the bezel itself is a fixed 100%/100% via styles.css's .card-bezel rule)
  panelStyle: string; // left/top/width/height/border-radius, as inline CSS, relative to the bezel box
  buttonsHtml: string; // one <span class="card-btn"> per declared button
  panelW: number; // real panel px, for the aspect-ratio sanity check a verify script does
  panelH: number;
}

// Edge a button visually ends up on after the SAME -90deg (CCW) quarter
// turn every chrono run page auto-applies (writeRunPage's own autoRotate,
// site/record-demos.ts's chrono preroll clicking the same button) - a
// physical rotation swaps which edge each side of the rectangle occupies:
// picture a clock face turned 90deg counterclockwise, the mark at 3
// o'clock (right) ends up at 12 (top), 12 ends up at 9 (left), and so on.
// Exact left/right ORDER along the new edge is not preserved (not derived
// here), which is fine: a .card-btn nub carries no label, so two
// unlabelled nubs on the same edge read identically regardless of which
// is which - only which EDGE they protrude from matters for "reads as the
// same device."
const EDGE_AFTER_QUICK_ROTATE: Record<PackButton["edge"], PackButton["edge"]> = {
  right: "top",
  top: "left",
  left: "bottom",
  bottom: "right",
};

function cardDeviceGeometry(pack: string, rotated: boolean): CardDeviceGeometry {
  const rawPanel = packPanel.get(pack) || { w: 368, h: 448 };
  // rotated: the card's own recorded clip is landscape (site/record-demos.ts's
  // chrono preroll clicks the same -90deg quick-rotate the run page
  // auto-applies, BEFORE the screencast starts), so the CSS frame drawn
  // around it has to be landscape too, panel dimensions and button edges
  // both swapped, or a landscape video would sit inside a portrait-shaped
  // panel box.
  const panel = rotated ? { w: rawPanel.h, h: rawPanel.w } : rawPanel;
  const rawButtons = packButtons.get(pack) || [];
  const buttons = rotated ? rawButtons.map((b) => ({ edge: EDGE_AFTER_QUICK_ROTATE[b.edge], at: b.at })) : rawButtons;
  const bezelW = panel.w + 2 * BEZEL_PAD;
  const bezelH = panel.h + 2 * BEZEL_PAD;

  const pct = (n: number, denom: number) => `${((n / denom) * 100).toFixed(3)}%`;
  // 34px / 6px are src/app.css's own .bezel / .panel border-radius at the
  // reference RP2350 bezel width (404px) and panel width (368px); scaled
  // by the SAME ratio here so a smaller instrument panel (example: 240px)
  // still gets a proportionally similar corner, not a fixed pixel radius
  // that would look sharp-cornered at card scale or blobby at full size.
  const bezelRadius = pct(34, bezelW);
  const panelRadius = pct(6, panel.w);
  const panelStyle = `left:${pct(BEZEL_PAD, bezelW)};top:${pct(BEZEL_PAD, bezelH)};width:${pct(panel.w, bezelW)};height:${pct(panel.h, bezelH)};border-radius:${panelRadius}`;

  const buttonsHtml = buttons
    .map((b) => {
      const alongEdge = b.edge === "left" || b.edge === "right";
      const bezelAlongAxis = alongEdge ? bezelH : bezelW; // the axis the button's LENGTH runs along
      const bezelAcrossAxis = alongEdge ? bezelW : bezelH; // the axis its THICKNESS runs along
      const offset = Math.max(0, b.at) * Math.max(0, bezelAlongAxis - BTN_LENGTH_PX);
      const along = pct(offset, bezelAlongAxis);
      const length = pct(BTN_LENGTH_PX, bezelAlongAxis);
      const thickness = pct(BTN_THICKNESS_PX, bezelAcrossAxis);
      // 0, not a negative protrusion: the bezel fills the card's own full
      // width now (styles.css's .card-bezel, 100%/100% of .thumb), so
      // there is no silhouette margin left for a button to protrude INTO
      // without .card's own overflow:hidden clipping it. Drawn flush
      // against the bezel's own edge instead - a "simplified but
      // faithful" nub, per this task's own original brief, still reads
      // as a button in the right place on the right edge.
      return alongEdge
        ? `<span class="card-btn" style="${b.edge}:0;top:${along};width:${thickness};height:${length}"></span>`
        : `<span class="card-btn" style="${b.edge}:0;left:${along};height:${thickness};width:${length}"></span>`;
    })
    .join("");

  return { bezelW, bezelH, bezelRadius, panelStyle, buttonsHtml, panelW: panel.w, panelH: panel.h };
}

interface AppEntry {
  name: string;
  path: string;
  bundle: ChronoLikeBundle;
  proven: ProvenEntry[];
}
const apps: AppEntry[] = registry.apps.map((a) => {
  const bundle = readJson<ChronoLikeBundle>(join(REPO_ROOT, a.path, "bundle.json"));
  const proven: ProvenEntry[] = bundle.ports.map((entry) => ({
    pack: entry.pack,
    mode: entry.mode,
    verification: entry.verification.kind,
    degraded: entry.verdict === "degraded",
    silicon: entry.silicon ?? null,
  }));
  return { name: a.name, path: a.path, bundle, proven };
});

// ---- the one piece of prose this data cannot carry: how to build each
// proven combo's module, and which doc on GitHub explains that specific
// port. Keyed by "app:pack" and cross-checked against the proven combos
// derived above, so an app+pack this table doesn't know how to build fails
// the build loudly instead of silently skipping a proof the gallery claims.
interface ComboBuild {
  script: string; // relative to REPO_ROOT
  args: string[];
  portDoc: string; // relative to REPO_ROOT, linked on GitHub
  blurb: string; // one line, shown on the run page
}
const COMBO_BUILD: Record<string, ComboBuild> = {
  "chrono:rp2350-touch-amoled-18": {
    script: "packs/rp2350-touch-amoled-18/wasm/build.ts",
    args: [],
    portDoc: "packs/rp2350-touch-amoled-18/firmware/apps/README.md",
    blurb: "Chrono's native home: one of the three apps this pack's own firmware ships, built with no --app override.",
  },
  "chrono:esp32-s3-touch-amoled-18": {
    script: "packs/esp32-s3-touch-amoled-18/wasm/build.ts",
    args: ["--app", "apps/chrono/ports/esp32-s3-touch-amoled-18/chrono.c"],
    portDoc: "apps/chrono/ports/esp32-s3-touch-amoled-18/README.md",
    blurb: "The same descriptor, ported to a second board with no persistent framebuffer. Pixel-identical to the reference, verified capture by capture.",
  },
  "fluidbox:rp2350-touch-amoled-18": {
    script: "packs/rp2350-touch-amoled-18/wasm/build.ts",
    args: ["--app", "apps/fluidbox/ports/rp2350-touch-amoled-18/fluid.c", "--shake"],
    portDoc: "apps/fluidbox/ports/rp2350-touch-amoled-18/README.md",
    blurb: "Ported down from a 900-particle, dual-core donor to 130 particles, single core: the interaction surface changed (fixed gravity, a touch stir), so this is verified by invariants, not pixel identity.",
  },
};

// The instrument's own minimal reference firmware (example/firmware/main.c,
// docs/decisions/0001-example-is-minimal-not-a-shim.md), built and embedded
// live the same way every proven combo is: not a device pack (no CMake, no
// real board), not a ported app - this is what a new firmware author
// targeting this instrument for the first time starts from. Panel size is
// a plain literal here, not read from a device.json (example/ has none;
// AGENTS.md's "nothing names one device" rule exempts example/ by name for
// exactly this reason - it is real, minimal, single-purpose firmware, not
// shared instrument code).
const INSTRUMENT_EXAMPLE = {
  id: "example",
  name: "puck-example",
  script: "example/build.ts",
  args: [] as string[],
  doc: "example/firmware/main.c",
  panel: { w: 240, h: 240 },
  // example/firmware/main.c's own emu_device() string literal (grepped, not
  // guessed): button "a" right edge at 0.5 with an 800ms long press, "b"
  // left edge at 0.5. Hand-restated here for the same reason the panel
  // size above already is: example/ has no device.json for this file to
  // read, and AGENTS.md's "nothing names one device" rule exempts example/
  // by name for exactly this reason.
  buttons: [
    { edge: "right", at: 0.5 },
    { edge: "left", at: 0.5 },
  ] as PackButton[],
  blurb: "The instrument's own minimal reference firmware: a 240x240 panel, two buttons (one with a long-press verdict), a shake sensor, and a scripted two-button chord. Not a device pack, not a ported app - the smallest complete emu_device() implementation, and where a new firmware author starts.",
};
// Registered into the SAME lookup maps every real pack uses (never into
// registry.packs itself, so it never appears in the proof matrix, which
// iterates registry.packs specifically) - this is what lets writeRunPage/
// embedFrameSize/renderCardDevice below treat "example" as just another
// pack id with no special-casing of its own.
packLabel.set(INSTRUMENT_EXAMPLE.id, INSTRUMENT_EXAMPLE.name);
packPanel.set(INSTRUMENT_EXAMPLE.id, INSTRUMENT_EXAMPLE.panel);
packHasVectorSensor.set(INSTRUMENT_EXAMPLE.id, false);
packButtons.set(INSTRUMENT_EXAMPLE.id, INSTRUMENT_EXAMPLE.buttons);

// A fourth card that is not part of the proof matrix at all: the ESP32-S3
// pack's own shipped reference app, included per this site's brief as a
// fourth "reference app" tile (a device pack proving itself, not a ported
// app).
interface ReferenceApp {
  id: string;
  name: string;
  pack: string;
  script: string;
  args: string[];
  doc: string;
  blurb: string;
}
const REFERENCE_APPS: ReferenceApp[] = [
  {
    id: "esp32-demo",
    name: "demo",
    pack: "esp32-s3-touch-amoled-18",
    script: "packs/esp32-s3-touch-amoled-18/wasm/build.ts",
    args: [],
    doc: "packs/esp32-s3-touch-amoled-18/firmware/apps/demo.c",
    blurb: "A bouncing square: the pack's own reference app, proving its band-render contract with nothing borrowed from another device.",
  },
];

function comboId(app: string, pack: string): string {
  const short = pack.split("-")[0]; // "rp2350" / "esp32"
  return `${app}-${short}`;
}

interface Combo {
  id: string;
  app: string;
  appPath: string;
  pack: string;
  build: ComboBuild;
  proven: ProvenEntry;
}
const combos: Combo[] = [];
for (const app of apps) {
  for (const entry of app.proven) {
    const key = `${app.name}:${entry.pack}`;
    const build = COMBO_BUILD[key];
    if (!build) {
      throw new Error(
        `site/build.ts has no COMBO_BUILD entry for "${key}", but ${app.path}/bundle.json lists it as proven. ` +
          `Add one (script, args, portDoc, blurb) or this gallery would silently under-claim what's proven.`
      );
    }
    combos.push({ id: comboId(app.name, entry.pack), app: app.name, appPath: app.path, pack: entry.pack, build, proven: entry });
  }
}

// ---- 1. build every combo's module, one at a time (shared wasm/dist/emu.wasm output) ----
const REPO_WASM_OUT = join(REPO_ROOT, "wasm", "dist", "emu.wasm");
const MODULES_DIR = join(DIST, "modules");

// Retried here too, not just inside packs/rp2350-touch-amoled-18/wasm/build.ts's own loop
// (AGENTS.md: "its wasm link segfaults on roughly one run in three; that is
// a known zig bug, not your change, so run it again"). That pack's own
// build.ts already retries internally, but example/build.ts and the
// esp32-s3 pack's build.ts do not, and this function invokes every one of
// them - without a retry HERE, a whole `bun run site:build` fails on a
// single flaky exit from a script that has no retry loop of its own, for a
// reason that has nothing to do with anything this task changed.
const BUILD_MAX_ATTEMPTS = 4;

function runBuild(script: string, args: string[]): void {
  console.log(`\n--- building: bun run ${script} ${args.join(" ")}`);
  let result = Bun.spawnSync(["bun", "run", script, ...args], {
    cwd: REPO_ROOT,
    stdout: "inherit",
    stderr: "inherit",
    env: { ...process.env },
  });
  for (let attempt = 2; !result.success && attempt <= BUILD_MAX_ATTEMPTS; attempt++) {
    console.error(`bun run ${script} exited ${result.exitCode}, retrying (${attempt}/${BUILD_MAX_ATTEMPTS}) - see this function's comment`);
    result = Bun.spawnSync(["bun", "run", script, ...args], {
      cwd: REPO_ROOT,
      stdout: "inherit",
      stderr: "inherit",
      env: { ...process.env },
    });
  }
  if (!result.success) {
    throw new Error(`build failed: bun run ${script} ${args.join(" ")} (exit ${result.exitCode}) on all ${BUILD_MAX_ATTEMPTS} attempts`);
  }
}

function buildAllModules(): void {
  mkdirSync(MODULES_DIR, { recursive: true });
  for (const c of combos) {
    runBuild(c.build.script, c.build.args);
    if (!existsSync(REPO_WASM_OUT)) throw new Error(`${c.build.script} did not write ${REPO_WASM_OUT}`);
    copyFileSync(REPO_WASM_OUT, join(MODULES_DIR, `${c.id}.wasm`));
    console.log(`copied -> site/dist/modules/${c.id}.wasm`);
  }
  for (const r of REFERENCE_APPS) {
    runBuild(r.script, r.args);
    if (!existsSync(REPO_WASM_OUT)) throw new Error(`${r.script} did not write ${REPO_WASM_OUT}`);
    copyFileSync(REPO_WASM_OUT, join(MODULES_DIR, `${r.id}.wasm`));
    console.log(`copied -> site/dist/modules/${r.id}.wasm`);
  }
  runBuild(INSTRUMENT_EXAMPLE.script, INSTRUMENT_EXAMPLE.args);
  if (!existsSync(REPO_WASM_OUT)) throw new Error(`${INSTRUMENT_EXAMPLE.script} did not write ${REPO_WASM_OUT}`);
  copyFileSync(REPO_WASM_OUT, join(MODULES_DIR, `${INSTRUMENT_EXAMPLE.id}.wasm`));
  console.log(`copied -> site/dist/modules/${INSTRUMENT_EXAMPLE.id}.wasm`);
}

// ---- 1.5. flash artifacts + the WebUSB flasher's own bundled JS --------
// The two verified RP2350 UF2s live in site/flash-artifacts/ (tracked,
// source), never directly in site/dist/flash/ (untracked build output):
// this step's whole job is making sure a clean rebuild (which rm -rf's
// DIST first, see "run everything" below) never deletes the artifacts, it
// only ever regenerates a copy of them.
const FLASH_ARTIFACTS_SRC = join(SITE_DIR, "flash-artifacts");

function copyFlashArtifacts(): void {
  const flashDir = join(DIST, "flash");
  mkdirSync(flashDir, { recursive: true });
  for (const name of readdirSync(FLASH_ARTIFACTS_SRC)) {
    if (!name.endsWith(".uf2")) continue;
    copyFileSync(join(FLASH_ARTIFACTS_SRC, name), join(flashDir, name));
    console.log(`copied -> site/dist/flash/${name}`);
  }
}

// ---- 1.6. landing demo loops: recorded, tracked source, copied out -------
// Same pattern as flash-artifacts above: site/demo-media/ is the tracked
// source (written by site/record-demos.ts, committed like any other
// asset), site/dist/assets/demos/ is untracked build output regenerated
// from it every time. Every id the landing page actually links to
// (demoThumb's own callers) must have all three files - missing media is
// a loud warning, not a thrown error, so a fresh clone can still run
// site:build once (to produce the wasm modules site/record-demos.ts itself
// needs to drive) before any recording has happened yet.
const DEMO_MEDIA_EXTS = ["mp4", "gif", "png"] as const;

function copyDemoMedia(ids: string[]): void {
  const outDir = join(DIST, "assets", "demos");
  mkdirSync(outDir, { recursive: true });
  for (const id of ids) {
    for (const ext of DEMO_MEDIA_EXTS) {
      const src = join(DEMO_MEDIA_DIR, `${id}.${ext}`);
      if (!existsSync(src)) {
        console.warn(`site/build.ts: no site/demo-media/${id}.${ext} yet (run \`bun run site:record-demos\` to generate it) - the landing page will link to a missing asset until then`);
        continue;
      }
      copyFileSync(src, join(outDir, `${id}.${ext}`));
      console.log(`copied -> site/dist/assets/demos/${id}.${ext}`);
    }
  }
}

// flash-ui.ts is the run page's own small entrypoint (wires the "Flash
// over USB" button to site/flasher/flash.ts); bundled the same way the
// root build.ts bundles src/main.ts, so this page ships one local JS file
// and never a CDN import.
// Set by buildFlashUi() below, read by writeRunPage()'s flashScript - one
// bundle shared by every run page that has a flash section.
let FLASH_JS_VERSION = "";

async function buildFlashUi(): Promise<void> {
  const result = await Bun.build({
    entrypoints: [join(SITE_DIR, "flasher", "flash-ui.ts")],
    outdir: join(DIST, "flash"),
    naming: "flash.js",
    target: "browser",
    format: "esm",
    minify: false,
  });
  if (!result.success) {
    for (const log of result.logs) console.error(log);
    throw new Error("site/build.ts: failed to bundle site/flasher/flash-ui.ts");
  }
  FLASH_JS_VERSION = contentHashOf(join(DIST, "flash", "flash.js"));
  console.log("built -> site/dist/flash/flash.js");
}

// ---- 2. the shared emulator bundle, built once via the repo's own build.ts ----
// Set by buildEmulatorBundle() below, read by writeRunPage(): the SAME
// emu/index.html is embedded by every run page, so its content hash is
// computed once here rather than re-hashing the same file per run page.
let EMU_INDEX_VERSION = "";

function buildEmulatorBundle(): void {
  runBuild("build.ts", []);
  const repoDist = join(REPO_ROOT, "dist");
  const emuDir = join(DIST, "emu");
  mkdirSync(emuDir, { recursive: true });
  for (const f of ["main.js", "family-budget.css", "app.css"]) {
    copyFileSync(join(repoDist, f), join(emuDir, f));
  }
  // index.html itself is not a byte-for-byte copy: its own internal
  // references to main.js/family-budget.css/app.css need the SAME
  // cache-busting query string every other emitted asset URL gets (this is
  // the "copied emu/index.html" half of this task's cache-busting fix -
  // the outer run page versioning its iframe src is not enough on its own,
  // because the browser caches main.js/app.css by THEIR OWN url, resolved
  // against this document, not against whatever versioned url embedded it).
  const mainJsV = contentHashOf(join(emuDir, "main.js"));
  const fbCssV = contentHashOf(join(emuDir, "family-budget.css"));
  const appCssV = contentHashOf(join(emuDir, "app.css"));
  let html = readFileSync(join(repoDist, "index.html"), "utf8");
  html = html
    .replace('href="./family-budget.css"', `href="${withVersion("./family-budget.css", fbCssV)}"`)
    .replace('href="./app.css"', `href="${withVersion("./app.css", appCssV)}"`)
    .replace('src="./main.js"', `src="${withVersion("./main.js", mainJsV)}"`);
  writeFileSync(join(emuDir, "index.html"), html);
  EMU_INDEX_VERSION = contentHashOf(join(emuDir, "index.html"));
  console.log("copied -> site/dist/emu/ (shared emulator bundle)");
}

// ---- html helpers ----
function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

// A monochrome puck glyph, inline (no separate .ico/.png asset to keep in
// sync with the rest of the gallery): a disc with a smaller punched-out
// centre, the same silhouette a hockey puck reads as from directly above.
// One colour (the site's own accent), on transparent - matches "system
// sans, one accent, no marketing" as much as a 32x32 glyph can. A data URI
// means every page carries its own favicon with zero extra requests, and a
// static build with no build-time image pipeline never has to write a
// second file this could drift from.
const FAVICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><circle cx="16" cy="16" r="14" fill="#2f6feb"/><circle cx="16" cy="16" r="5" fill="#fafafa"/></svg>`;
const FAVICON_HREF = `data:image/svg+xml,${encodeURIComponent(FAVICON_SVG)}`;

// One footer, everywhere: the index page and every run page end on the
// same GitHub link + MIT note, rather than the index's own copy being the
// only place a visitor sees it. The "agents" link is set once ROOT_DEPTH_*
// versions exist (see buildAgentSurfaces below) via patchFooterAgentsLink;
// it starts unversioned so every page() call before that step still has a
// working (if uncached) href rather than a dangling one.
let AGENTS_HTML_VERSION = "";
function siteFooter(depth: "" | "../"): string {
  const href = `${depth}agents.html${AGENTS_HTML_VERSION ? `?v=${AGENTS_HTML_VERSION}` : ""}`;
  return `<footer>
    <div class="wrap" style="padding:0">
      <a href="${gh("README.md")}">s0lness/puck</a> on GitHub, MIT licensed.
      &middot; <a href="${href}">agents</a>
    </div>
  </footer>`;
}

// Set once styles.css is copied into DIST (see "run everything" below),
// read by every page() call - index.html and every run page link the SAME
// physical file, just at a different relative depth ("styles.css" vs
// "../styles.css"), so one hash covers all of them.
let STYLES_VERSION = "";

// Markup's own key-gated loader (markup/scripts/install-loader.py's
// SNIPPET, the same one gazette/public/*.html embeds verbatim): inert on a
// plain load. It only ever runs past its first "return" when the URL
// carries ?markup or ?edit (or a tab already opted in via
// sessionStorage["markup-on"]), and only fetches markup.js past its
// second "return" when a key is already in localStorage (seeded once from
// a #k=<key> URL fragment) or the page is being served from localhost. No
// key lives in this repo; Sylve's own key lives outside it entirely
// (~/projects/.secrets.env), pasted into the URL once per device via
// https://<site>/?edit#k=<key>. Deliberately backslash-free (a stray `\b`
// once got mangled to a control byte through a shell and silently
// disabled this, per markup's own AGENTS.md), and copied verbatim rather
// than re-derived, so it never drifts from the version every other
// s0lness site embeds.
const MARKUP_LOADER = `<script>/* markup: visual-feedback overlay, only for a browser holding the key */(function(){if(!(/[?&](markup|edit)([=&]|$)/.test(location.search)||sessionStorage.getItem("markup-on")))return;var m=/[#&]k=([A-Za-z0-9_-]+)/.exec(location.hash),k=null;try{if(m)localStorage.setItem("markup-key",m[1]);k=localStorage.getItem("markup-key")}catch(e){}var local=location.hostname==="localhost"||location.hostname==="127.0.0.1";if(!k&&!local)return;document.head.appendChild(Object.assign(document.createElement("script"),{src:"https://markup.sylve.org/markup.js"}))})()</script>`;

function page(title: string, description: string, stylesHref: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHtml(title)}</title>
<meta name="description" content="${escapeHtml(description)}" />
<meta property="og:title" content="${escapeHtml(title)}" />
<meta property="og:description" content="${escapeHtml(description)}" />
<meta property="og:type" content="website" />
<link rel="icon" href="${FAVICON_HREF}" />
<link rel="stylesheet" href="${withVersion(stylesHref, STYLES_VERSION)}" />
</head>
<body>
${body}
${MARKUP_LOADER}
</body>
</html>
`;
}

// ---- landing thumbnails: recorded loops, not live emulators -------------
// The index page used to embed the same live ?embed=1 iframe every run page
// does, once per card. Real, but expensive on a phone (four wasm fetches +
// instantiations before anything paints) and fragile in exactly the way
// Sylve's own iPhone Safari report showed ("the fluid simulation doesn't
// seem to work"): a live embed's correctness depends on wasm compiling,
// touch reaching the panel, and the device fitting its iframe, all before
// a visitor sees anything move. A short recorded loop (site/record-demos.ts,
// see its own header for how these are captured) has none of that: it is a
// <video>, it always plays, and it costs one small file instead of a wasm
// module. The live thing still exists, one click away - every thumbnail
// links to its real run page, per site/build.ts's own COMBO ids so this
// never points at a made-up id.
const DEMO_MEDIA_DIR = join(SITE_DIR, "demo-media");
// Hashed on demand, not from a precomputed table: called from
// buildIndexHtml(), which always runs after copyDemoMedia() has already
// populated DIST/assets/demos/ (see "run everything" below), so the file
// this hashes is the one actually shipped. Falls back to an unversioned
// href when the file is missing (a fresh clone that has not run
// site:record-demos yet - copyDemoMedia's own warning already covers that
// case without failing the build, this matches it rather than throwing).
function demoAssetHref(id: string, ext: string): string {
  const base = `assets/demos/${id}.${ext}`;
  const filePath = join(DIST, "assets", "demos", `${id}.${ext}`);
  return existsSync(filePath) ? withVersion(base, contentHashOf(filePath)) : base;
}

// The card itself: a CSS device frame (cardDeviceGeometry above) sized by
// the pack's own device.json, wrapping a video/poster/gif that were all
// cropped to #panel alone (site/record-demos.ts) - never a plain video
// filling the whole box. The outer link's own aspect-ratio is the
// BEZEL's own (not a wider silhouette that reserves margin for a
// protruding button - cardDeviceGeometry no longer adds one), so the
// device fills the card's full width, the same width as the text block
// below it. The video only fills the inner .card-panel box, positioned by
// cardDeviceGeometry's panelStyle. data-panel-w/-h on the <video> are what
// scripts/verify-site-embeds.ts reads to confirm the recorded clip's own
// intrinsic size actually matches this pack's panel aspect, independent of
// whatever this function draws around it.
function demoThumb(id: string, alt: string, href: string, pack: string, rotated: boolean): string {
  const g = cardDeviceGeometry(pack, rotated);
  return `<a class="thumb thumb-video" style="aspect-ratio:${g.bezelW} / ${g.bezelH}" href="${href}" aria-label="${escapeHtml(alt)}, open the live run page">
    <span class="card-bezel" style="border-radius:${g.bezelRadius}">
      <span class="card-panel" style="${g.panelStyle}">
        <video autoplay muted loop playsinline poster="${demoAssetHref(id, "png")}" data-panel-w="${g.panelW}" data-panel-h="${g.panelH}">
          <source src="${demoAssetHref(id, "mp4")}" type="video/mp4" />
        </video>
      </span>
      ${g.buttonsHtml}
    </span>
    <noscript><img src="${demoAssetHref(id, "gif")}" alt="${escapeHtml(alt)}" /></noscript>
  </a>`;
}

// ROOT-ABSOLUTE, deliberately, not relative. src/main.ts's fetchWasmBytes()
// calls fetch(WASM_URL) INSIDE the emu/index.html document, so a relative
// value in the ?module= param resolves against THAT document's own
// location (site/dist/emu/), never against whichever page is embedding it.
// A relative "modules/<id>.wasm" from an index-page card therefore resolved
// to site/dist/emu/modules/<id>.wasm (one directory too deep - it does not
// exist, 404) even though the exact same relative depth ("../modules/") was
// correct from a run page one level further down in run/. Root-absolute
// sidesteps embedding depth entirely: it means the same thing regardless of
// which page (or how deeply nested) embeds emu/index.html. Correct on both
// targets this repo ever serves site/dist/ from: Cloudflare Pages (a
// project's dist is served at its own domain root) and this repo's own
// local static servers (scripts/verify-flash-ui.ts, scripts/verify-embed.ts
// pointed at site/dist/, and any other server that maps site/dist/ itself
// to "/"), never at a deeper mount path.
function moduleUrlAbs(moduleId: string): string {
  return `/modules/${moduleId}.wasm`;
}

// ---- hand-written one-liners: bundle.json has no prose, this is it -----
const APP_BLURB: Record<string, string> = {
  chrono: "A full-screen stopwatch: six seven-segment digits, two buttons, nothing else on screen.",
  fluidbox: "A particle liquid that sloshes and settles inside the device's own enclosure shape.",
};

// ---- 3 & 4: generate every page --------------------------------------
function modeLabel(mode: string): string {
  if (mode === "faithful") return "faithful port";
  if (mode === "native") return "native";
  return "adaptation";
}

// The two-mark matrix (docs/convention/publishing.md): EVERY cell rendered
// here already passed the shared harness (site/build.ts only ever builds a
// combo listed as a bundle.json "port", and bun run verify-bundle is what
// decides a port belongs there at all) - that is the first mark, implicit
// in the cell simply being filled in rather than "not ported". The second,
// distinct mark is proof-silicon below: only present when that port's own
// bundle.json carries a "silicon" attestation, meaning it has ALSO been
// run against real hardware, not only the emulator.
function renderProofCell(entry: ProvenEntry | undefined, comboIdFor: string | null): string {
  if (!entry) return `<td class="proof-cell empty">not ported</td>`;
  const verif = entry.degraded ? `${entry.verification} (degraded)` : entry.verification;
  const silicon = entry.silicon
    ? `<span class="proof-silicon" title="run against real hardware, attested ${escapeHtml(entry.silicon.attestedAt)}: ${escapeHtml(entry.silicon.how)}">&#9679; on silicon</span>`
    : "";
  const inner = `<span class="proof-mode">${escapeHtml(modeLabel(entry.mode))}</span><span class="proof-verif">${escapeHtml(verif)}</span>${silicon}`;
  return comboIdFor
    ? `<td class="proof-cell"><a href="run/${comboIdFor}.html">${inner}</a></td>`
    : `<td class="proof-cell">${inner}</td>`;
}

function buildIndexHtml(): void {
  const cardsHtml = apps
    .map((app) => {
      const primary = combos.find((x) => x.app === app.name && x.pack === app.proven[0]!.pack)!;
      const provenLinks = app.proven
        .map((p) => {
          const c = combos.find((x) => x.app === app.name && x.pack === p.pack)!;
          return `<a href="run/${c.id}.html">run on ${escapeHtml(packLabel.get(p.pack) || p.pack)}</a>`;
        })
        .join("");
      // Deduped: chrono is proven the same way (faithful/pixel-exact) on
      // both packs, and showing that badge twice would just be noise.
      const seenBadges = new Set<string>();
      const badges = app.proven
        .filter((p) => {
          const key = `${p.mode}:${p.verification}:${p.degraded}`;
          if (seenBadges.has(key)) return false;
          seenBadges.add(key);
          return true;
        })
        .map((p) => `<span class="badge${p.degraded ? "" : " accent"}">${escapeHtml(modeLabel(p.mode))} · ${escapeHtml(p.verification)}</span>`)
        .join("");
      return `<div class="card">
  ${demoThumb(primary.id, `${app.name} demo`, `run/${primary.id}.html`, primary.pack, primary.app === "chrono")}
  <div class="body">
    <h3>${escapeHtml(app.name)}</h3>
    <p>${escapeHtml(APP_BLURB[app.name] || "")}</p>
    <div class="badges">${badges}</div>
    <div class="links">
      ${provenLinks}
      <a href="${gh(`${app.path}/descriptor.md`)}">descriptor</a>
    </div>
  </div>
</div>`;
    })
    .join("\n");

  const packNames = registry.packs.map((p) => p.name);
  const matrixRows = apps
    .map((app) => {
      const cells = packNames
        .map((pack) => {
          const entry = app.proven.find((p) => p.pack === pack);
          const c = entry ? combos.find((x) => x.app === app.name && x.pack === pack) : undefined;
          return renderProofCell(entry, c ? c.id : null);
        })
        .join("\n        ");
      return `      <tr>
        <td class="app-row">${escapeHtml(app.name)}</td>
        ${cells}
      </tr>`;
    })
    .join("\n");
  const matrixHead = packNames.map((p) => `<th>${escapeHtml(packLabel.get(p) || p)}</th>`).join("\n        ");

  // Every "reference" tile (a device pack proving itself, plus the
  // instrument's own minimal example) gets the same recorded-loop
  // treatment as the app cards above, and the same click-through to its
  // real, live run page.
  const refTiles = [
    ...REFERENCE_APPS.map((r) => ({
      id: r.id,
      pack: r.pack,
      title: `${packLabel.get(r.pack) || r.pack}: ${r.name}`,
      blurb: r.blurb,
      docHref: gh(r.doc),
    })),
    {
      id: INSTRUMENT_EXAMPLE.id,
      pack: INSTRUMENT_EXAMPLE.id, // pseudo-pack, registered into packPanel above
      title: INSTRUMENT_EXAMPLE.name,
      blurb: INSTRUMENT_EXAMPLE.blurb,
      docHref: gh(INSTRUMENT_EXAMPLE.doc),
    },
  ];
  const refCardsHtml = refTiles
    .map(
      (r) => `<div class="ref-card">
  ${demoThumb(r.id, `${r.title} demo`, `run/${r.id}.html`, r.pack, false)}
  <h3>${escapeHtml(r.title)}</h3>
  <p>${escapeHtml(r.blurb)}</p>
  <div class="links"><a href="run/${r.id}.html">open full page</a> <a href="${r.docHref}">source</a></div>
</div>`
    )
    .join("\n");

  const body = `<div class="wrap">
  <header class="hero">
    <h1>puck</h1>
    <p class="tagline">apps that travel between tiny computers.</p>
    <p class="sub">Every clip below is a recording of the real thing, compiled to WebAssembly and running live one click away. <a href="${gh("README.md")}">puck</a> is a device-agnostic emulator, a set of self-contained device packs, and a set of portable app bundles; open any run page to touch the actual emulator, not a mockup.</p>
  </header>

  <section id="apps">
    <div class="wrap" style="padding:0">
      <div class="cards">
${cardsHtml}
      </div>
    </div>
  </section>

  <section id="proof">
    <div class="wrap" style="padding:0">
      <h2>proof matrix</h2>
      <p class="lede">Each cell is a real build of that app's own port, for that device pack's real firmware, verified by the shared harness (<code>bun run verify-bundle</code>): click through to run it live. Every cell shown is emulator-proven; a cell additionally marked <strong>&#9679; on silicon</strong> has also been run against the real board over serial, an attestation, not an automatic guarantee (hover or focus the mark for when and how).</p>
      <div class="matrix-scroll">
        <table class="matrix">
          <thead><tr><th></th>
        ${matrixHead}
          </tr></thead>
          <tbody>
${matrixRows}
          </tbody>
        </table>
      </div>
    </div>
  </section>

  <section id="reference">
    <div class="wrap" style="padding:0">
      <h2>reference app</h2>
      <p class="lede">Not a port: each device pack's own shipped app, plus the instrument's own minimal example firmware - every tile below links to it running live, the same as the cards above.</p>
      <div class="ref-cards">
${refCardsHtml}
      </div>
    </div>
  </section>

  <section id="how">
    <div class="wrap" style="padding:0">
      <h2>how it works</h2>
      <div class="how-grid">
        <div class="item">
          <h3>device packs</h3>
          <p>A self-contained folder for one hardware target: real drivers, a real board's firmware, and a <code>device.json</code> descriptor the emulator reads at runtime. Nothing in the shared instrument names one device; every panel size and button comes from the pack itself.</p>
          <span class="src"><a href="${gh("docs/convention/device-pack.md")}">device-pack.md</a></span>
        </div>
        <div class="item">
          <h3>app descriptors</h3>
          <p>An app is defined by its descriptor and traces, not by one implementation's source code: what appears on screen, every interaction, and separate requirements from preferences. A port starts with a verdict against the target pack, stated plainly, before any code is written.</p>
          <span class="src"><a href="${gh("docs/convention/app-bundle.md")}">app-bundle.md</a></span>
        </div>
        <div class="item">
          <h3>the verifier</h3>
          <p>A faithful port replays its traces and compares frames pixel for pixel. An adaptation states behavioral invariants instead, and gets checked against those. Either way, the same shared harness decides, not a claim in a README.</p>
          <span class="src"><a href="${gh("docs/harness.md")}">harness.md</a></span>
        </div>
      </div>
    </div>
  </section>

  ${siteFooter("")}
</div>`;

  writeFileSync(
    join(DIST, "index.html"),
    page(
      "puck: apps that travel between tiny computers",
      "A gallery of firmware ported between device packs: recorded demo loops on this page, the real WebAssembly build one click away on every run page.",
      "styles.css",
      body
    )
  );
}

// ---- flash section: real-device flashing over WebUSB, or an honest note ----
// Keyed by combo id (not by pack) because the artifact choice is per
// combo, not per pack: both chrono-rp2350 and fluidbox-rp2350 target the
// same pack but ship different firmware.
interface FlashArtifact {
  file: string; // filename under site/flash-artifacts/ and site/dist/flash/
  note?: string; // shown above the buttons; chrono's explains the artifact is the full firmware, not an app-only build
}
const FLASH_ARTIFACTS: Record<string, FlashArtifact> = {
  "chrono-rp2350": {
    file: "puck-full.uf2",
    note: "This artifact is the full puck firmware for this board, not a chrono-only build: chrono is simply the app it boots into.",
  },
  "fluidbox-rp2350": {
    file: "fluidbox-rp2350.uf2",
  },
};

// Quoted compactly from packs/rp2350-touch-amoled-18/gotchas.md's own
// recovery ritual: replugging alone does not reset this board, because its
// PMIC keeps the rails powered through a simple unplug/replug.
//
// This is the RECOVERY path now, not the entry path. A board running
// firmware built on or after 2026-08-19 carries pico-sdk's USB reset
// interface, so the flasher reboots it into BOOTSEL itself over USB
// (site/flasher/flash.ts) and nobody has to hold anything. The fold stays
// because the two cases it still covers are the two where a button is the
// only thing left: firmware too old to have the interface, and firmware so
// broken that its USB stack never comes up.
const BOOTSEL_RITUAL_INTRO =
  "Only needed for a bricked board, or for firmware older than the USB reset interface. Otherwise the flasher reboots the board into BOOTSEL itself.";
const BOOTSEL_RITUAL =
  "Unplug USB. Hold PWR for at least 12 seconds, until the screen goes black (replugging alone does not reset the board: the PMIC keeps the rails up). Then hold BOOT while plugging the USB cable back in.";

// The ESP-IDF half is no longer unvalidated: it was built, flashed and run on
// the physical board on 2026-08-19 (packs/esp32-s3-touch-amoled-18/docs/
// decisions/0001-what-the-first-flash-found.md). What is still missing is a
// BROWSER flashing path, and that gap is a different one from the old note's:
// the RP2350 flasher works because a board in BOOTSEL mounts as a drive and
// takes a single .uf2 file. An ESP32-S3 takes a multi-image esptool write over
// serial, which this site does not implement. Saying "flashing arrives when
// the firmware is validated" would now be false, and the point of this note is
// that a visitor should not wait for something that is not coming from here.
const ESP32_FLASH_NOTE =
  "This pack's firmware runs on the real board, but flashing it from a browser does not: an ESP32-S3 takes an esptool write over serial, not a single file dropped on a drive. Build and flash it from the pack's own README.";

function renderFlashSection(comboId: string, pack: string): string {
  const artifact = FLASH_ARTIFACTS[comboId];
  if (artifact) {
    const uf2Href = `../flash/${artifact.file}`;
    return `  <section class="flash-section" data-uf2="${uf2Href}">
    <h2>Flash to the real device</h2>
    ${artifact.note ? `<p class="flash-note">${escapeHtml(artifact.note)}</p>` : ""}
    <div class="flash-actions">
      <button type="button" class="flash-btn btn-flash">Flash over USB</button>
      <a class="flash-btn-alt" href="${uf2Href}" download>Download .uf2</a>
    </div>
    <p class="flash-hint">No install needed: copy the downloaded file onto the RP2350 BOOTSEL drive once it appears.</p>
    <div class="flash-progress" hidden>
      <div class="flash-progress-track"><div class="flash-progress-bar"></div></div>
      <p class="flash-status"></p>
    </div>
    <p class="flash-done" hidden></p>
    <p class="flash-error" hidden></p>
    <details class="flash-ritual">
      <summary>BOOTSEL entry ritual</summary>
      <p class="flash-ritual-intro">${escapeHtml(BOOTSEL_RITUAL_INTRO)}</p>
      <p>${escapeHtml(BOOTSEL_RITUAL)}</p>
    </details>
  </section>`;
  }
  if (pack.startsWith("esp32")) {
    return `  <section class="flash-section flash-section-note">
    <h2>Flash to the real device</h2>
    <p class="flash-note">${escapeHtml(ESP32_FLASH_NOTE)}</p>
  </section>`;
  }
  return "";
}

// Native size for the run page's iframe: since site/build.ts's iframe now
// points at the emulator's `?embed=1` view (device + minimal control strip
// only, no topbar/sidebar/console - see src/main.ts's EMBED and
// src/app.css's html.embed rules), the iframe only needs to fit the
// device itself, not the full dev-UI layout the old fixed 980x760 was
// sized for. Computed per pack from its own device.json panel size (never
// a hardcoded 368x448 here), plus fixed margins for the bezel's own
// padding and the bottom control strip - generous enough that nothing
// wraps, and the embed page's own fitDeviceToStage() scales the device
// down further still if a narrower viewport asks for it. A quarter-turned
// device (chrono's autoRotate below) is still comfortable at these
// margins since they are added on both axes.
const EMBED_MARGIN_W = 80; // bezel padding, both sides, plus breathing room
const EMBED_MARGIN_H = 170; // bezel padding + the bottom control strip
const EMBED_MIN = 260; // floor, so a very small/no-panel pack still gets a usable frame

function embedFrameSize(pack: string): { w: number; h: number } {
  const panel = packPanel.get(pack);
  const pw = panel?.w ?? 368;
  const ph = panel?.h ?? 448;
  return {
    w: Math.max(EMBED_MIN, pw + EMBED_MARGIN_W),
    h: Math.max(EMBED_MIN, ph + EMBED_MARGIN_H),
  };
}

function buildRunDir(): void {
  const runDir = join(DIST, "run");
  mkdirSync(runDir, { recursive: true });

  function writeRunPage(opts: {
    id: string;
    title: string;
    pack: string;
    packLabelStr: string;
    modeStr: string | null;
    verifStr: string | null;
    blurb: string;
    docLinks: { label: string; href: string }[];
    autoRotate: boolean;
  }) {
    // Root-absolute module URL, same reasoning and same helper as the
    // index page's live card embeds (moduleUrlAbs's own header comment);
    // the run page's iframe `src` itself stays relative ("../emu/..."),
    // resolved normally by the browser against this page's own location.
    const iframeSrc = withVersion(`../emu/index.html?embed=1&module=${encodeURIComponent(moduleUrlAbs(opts.id))}`, EMU_INDEX_VERSION);
    const { w: nativeW, h: nativeH } = embedFrameSize(opts.pack);
    const badges = [opts.modeStr, opts.verifStr]
      .filter((x): x is string => !!x)
      .map((x) => `<span class="badge accent">${escapeHtml(x)}</span>`)
      .join(" ");
    const links = opts.docLinks.map((l) => `<a href="${l.href}">${escapeHtml(l.label)}</a>`).join("\n      ");
    const flashSection = renderFlashSection(opts.id, opts.pack);
    const flashScript = FLASH_ARTIFACTS[opts.id] ? `\n<script type="module" src="${withVersion("../flash/flash.js", FLASH_JS_VERSION)}"></script>` : "";
    const phoneTiltHint = packHasVectorSensor.get(opts.pack) ? " &middot; tilt with your phone" : "";
    const body = `<div class="wrap">
  <div class="run-header">
    <div class="back"><a href="../index.html">&larr; puck</a></div>
    <h1>${escapeHtml(opts.title)}</h1>
    <p class="meta">running on ${escapeHtml(opts.packLabelStr)}</p>
    <div class="badges">${badges}</div>
    <p>${escapeHtml(opts.blurb)}</p>
    <div class="links">
      ${links}
    </div>
  </div>

  <div class="emu-stage" id="stage">
    <div class="emu-frame" id="frame" style="width:${nativeW}px;height:${nativeH}px">
      <iframe id="emu" allowtransparency="true" src="${iframeSrc}" width="${nativeW}" height="${nativeH}" title="${escapeHtml(opts.title)} running live" allow="autoplay"></iframe>
    </div>
  </div>
  <p class="embed-hint">touch the screen${phoneTiltHint}</p>

  <div class="run-footer"></div>

${flashSection}
${siteFooter("../")}
</div>${flashScript}
<script>
(function () {
  var NATIVE_W = ${nativeW}, NATIVE_H = ${nativeH};
  var stage = document.getElementById("stage");
  var frame = document.getElementById("frame");
  function fit() {
    var scale = Math.min(1, stage.clientWidth / NATIVE_W);
    frame.style.transform = "scale(" + scale + ")";
    stage.style.height = Math.round(NATIVE_H * scale) + "px";
  }
  window.addEventListener("resize", fit);
  fit();
  ${
    opts.autoRotate
      ? `// Chrono renders landscape into a portrait-native panel; this clicks
  // the emulator's own "-90deg" quick-rotate button once the page loads,
  // the same control a person would click by hand (or the "r" keyboard
  // shortcut would cycle to), rather than defaulting to a sideways view.
  var emu = document.getElementById("emu");
  emu.addEventListener("load", function () {
    setTimeout(function () {
      try {
        var doc = emu.contentDocument;
        var btn = doc && doc.querySelector('#rotQuick button[data-deg="-90"]');
        if (btn) btn.click();
      } catch (e) {}
    }, 400);
  });`
      : ""
  }
})();
</script>`;
    writeFileSync(join(runDir, `${opts.id}.html`), page(`${opts.title}: puck`, opts.blurb, "../styles.css", body));
  }

  for (const c of combos) {
    const entry = c.proven;
    writeRunPage({
      id: c.id,
      title: `${c.app} on ${packLabel.get(c.pack) || c.pack}`,
      pack: c.pack,
      packLabelStr: packLabel.get(c.pack) || c.pack,
      modeStr: modeLabel(entry.mode),
      verifStr: entry.degraded ? `${entry.verification} (degraded)` : entry.verification,
      blurb: c.build.blurb,
      docLinks: [
        { label: "descriptor", href: gh(`${c.appPath}/descriptor.md`) },
        { label: c.build.args.length === 0 ? "reference source" : "port notes", href: gh(c.build.portDoc) },
      ],
      autoRotate: c.app === "chrono",
    });
  }

  for (const r of REFERENCE_APPS) {
    writeRunPage({
      id: r.id,
      title: `${packLabel.get(r.pack) || r.pack}: ${r.name}`,
      pack: r.pack,
      packLabelStr: packLabel.get(r.pack) || r.pack,
      modeStr: null,
      verifStr: null,
      blurb: r.blurb,
      docLinks: [{ label: "source", href: gh(r.doc) }],
      autoRotate: false,
    });
  }

  writeRunPage({
    id: INSTRUMENT_EXAMPLE.id,
    title: INSTRUMENT_EXAMPLE.name,
    pack: INSTRUMENT_EXAMPLE.id, // pseudo-pack, registered into packLabel/packPanel above
    packLabelStr: "the instrument itself, no device pack",
    modeStr: null,
    verifStr: null,
    blurb: INSTRUMENT_EXAMPLE.blurb,
    docLinks: [{ label: "source", href: gh(INSTRUMENT_EXAMPLE.doc) }],
    autoRotate: false,
  });
}

// ---- agent-browsable surfaces: llms.txt, registry.json, convention docs,
// each app's descriptor.md, and an HTML mirror (agents.html) -----------
// docs/convention/*.md + registry.json + each app's descriptor.md are
// already the machine-readable contract this repo asks a porting agent to
// read BEFORE writing code (docs/convention/*.md's own "Porting flow"):
// serving them raw under the same domain as the live gallery means an
// agent with only a URL, not a git checkout, reads the real files, never
// an LLM's paraphrase of them. Called from "run everything" below, before
// buildRunDir()/buildIndexHtml() so AGENTS_HTML_VERSION (read by every
// page's own footer, see siteFooter above) is already set by the time
// those write anything.
const AGENT_DOCS = ["docs/convention/device-pack.md", "docs/convention/app-bundle.md"];

function buildAgentSurfaces(): void {
  copyFileSync(join(REPO_ROOT, "registry.json"), join(DIST, "registry.json"));
  console.log("copied -> site/dist/registry.json");

  for (const rel of AGENT_DOCS) {
    const outPath = join(DIST, rel);
    mkdirSync(join(outPath, ".."), { recursive: true });
    copyFileSync(join(REPO_ROOT, rel), outPath);
    console.log(`copied -> site/dist/${rel}`);
  }

  const descriptorHrefs: { name: string; href: string }[] = [];
  for (const app of apps) {
    const outDir = join(DIST, "apps", app.name);
    mkdirSync(outDir, { recursive: true });
    const outPath = join(outDir, "descriptor.md");
    copyFileSync(join(REPO_ROOT, app.path, "descriptor.md"), outPath);
    descriptorHrefs.push({ name: app.name, href: withVersion(`apps/${app.name}/descriptor.md`, contentHashOf(outPath)) });
    console.log(`copied -> site/dist/apps/${app.name}/descriptor.md`);
  }
  const registryHref = withVersion("registry.json", contentHashOf(join(DIST, "registry.json")));
  const docHrefs = AGENT_DOCS.map((rel) => ({ rel, href: withVersion(rel, contentHashOf(join(DIST, rel))) }));

  const llms = `# puck

Apps that travel between tiny computers: portable app bundles (a descriptor
plus recorded input traces, independent of any one implementation) ported
onto self-contained device packs (real firmware, a device.json an emulator
reads at runtime), verified by a shared emulator and differential harness:
pixel-exact frame diffs for a faithful port, stated behavioral invariants
for an adaptation.

This site (puck.sylve.org) is the gallery: every proven combination runs
live in the browser, compiled to WebAssembly, and the reference RP2350
firmware also flashes onto real hardware over WebUSB.

## Machine-readable surfaces on this domain

- /registry.json: local paths and external URLs for every device pack and app bundle this repo knows about.
- /docs/convention/device-pack.md: what a device pack must contain.
- /docs/convention/app-bundle.md: what an app bundle (descriptor + traces) must contain.
- /apps/<name>/descriptor.md: the portable descriptor for each proven app (chrono, fluidbox).
- https://github.com/s0lness/puck: the repository itself, MIT licensed.

## Consuming a pack or app as an agent

1. git clone https://github.com/s0lness/puck
2. Read docs/convention/device-pack.md and docs/convention/app-bundle.md.
3. Pick a target device pack from registry.json; read its own AGENTS.md and device.json.
4. Pick an app from registry.json; read its descriptor.md and bundle.json (its "ports" array: pack, mode, verification).
5. Give a verdict against the target pack's device.json before writing any code: go, degraded, or refuse, stated plainly.
6. Build: bun install, then bun run <pack>/wasm/build.ts (writes wasm/dist/emu.wasm), then bun run dev for http://127.0.0.1:5340.
7. Verify: bun run verify-bundle <bundle> rebuilds every declared port and replays its traces end to end; bun run harness:selftest proves the differential harness with no hardware; bun run harness/diff.ts <trace.json> --link <yourBoardLink.ts> replays a trace against real hardware and diffs the resulting frames.

## Further reading

- docs/harness.md: how the differential harness proves a port.
- docs/abi.md: the ABI every firmware implements.
- AGENTS.md: conventions and gotchas, repo root.
`;
  writeFileSync(join(DIST, "llms.txt"), llms);
  console.log("wrote -> site/dist/llms.txt");

  const surfaceLinks = [
    `<li><a href="${registryHref}">registry.json</a>: local paths and external URLs for every device pack and app bundle.</li>`,
    ...docHrefs.map((d) => `<li><a href="${d.href}">${escapeHtml(d.rel)}</a></li>`),
    ...descriptorHrefs.map((d) => `<li><a href="${d.href}">apps/${escapeHtml(d.name)}/descriptor.md</a></li>`),
    `<li><a href="${gh("README.md")}">github.com/s0lness/puck</a>, MIT licensed.</li>`,
  ].join("\n        ");

  const agentsBody = `<div class="wrap">
  <div class="run-header">
    <div class="back"><a href="index.html">&larr; puck</a></div>
    <h1>puck, for an agent</h1>
    <p class="meta">the same content as <a href="${withVersion("llms.txt", contentHashOf(join(DIST, "llms.txt")))}">/llms.txt</a>, in HTML</p>
  </div>
  <section>
    <div class="wrap" style="padding:0">
      <h2>machine-readable surfaces</h2>
      <ul class="agent-links">
        ${surfaceLinks}
      </ul>
      <pre class="agent-doc">${escapeHtml(llms)}</pre>
    </div>
  </section>
  ${siteFooter("")}
</div>`;
  writeFileSync(
    join(DIST, "agents.html"),
    page(
      "puck: for an agent",
      "What this site is, its machine-readable surfaces (registry.json, convention docs, app descriptors), and how an agent consumes a pack or app.",
      "styles.css",
      agentsBody
    )
  );
  AGENTS_HTML_VERSION = contentHashOf(join(DIST, "agents.html"));
  console.log("wrote -> site/dist/agents.html");
}

// ---- run everything -------------------------------------------------
if (existsSync(DIST)) rmSync(DIST, { recursive: true, force: true });
mkdirSync(DIST, { recursive: true });

buildAllModules();
buildEmulatorBundle();
copyFileSync(join(SITE_DIR, "styles.css"), join(DIST, "styles.css"));
STYLES_VERSION = contentHashOf(join(DIST, "styles.css"));
copyFlashArtifacts();
// Every id the landing page's own demoThumb() calls link to: the primary
// (first-proven-pack) combo per app, plus every reference tile - the same
// set site/record-demos.ts records.
const DEMO_IDS = [
  ...apps.map((app) => combos.find((x) => x.app === app.name && x.pack === app.proven[0]!.pack)!.id),
  ...REFERENCE_APPS.map((r) => r.id),
  INSTRUMENT_EXAMPLE.id,
];
copyDemoMedia(DEMO_IDS);
await buildFlashUi();
buildAgentSurfaces();
buildRunDir();
buildIndexHtml();

function totalSize(dir: string): number {
  let total = 0;
  for (const name of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, name.name);
    if (name.isDirectory()) total += totalSize(p);
    else total += Bun.file(p).size;
  }
  return total;
}
const bytes = totalSize(DIST);
console.log(`\nbuilt site/dist/ (${(bytes / 1024).toFixed(0)} KiB)`);
