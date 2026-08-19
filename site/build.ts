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

const SITE_DIR = import.meta.dir;
const REPO_ROOT = resolve(SITE_DIR, "..");
const DIST = join(SITE_DIR, "dist");
const GITHUB_BASE = "https://github.com/s0lness/puck/blob/master";

function gh(path: string): string {
  return `${GITHUB_BASE}/${path}`;
}

// ---- read the data that decides what gets built -------------------------
interface Registry {
  packs: { name: string; path: string }[];
  apps: { name: string; path: string }[];
}
interface ChronoLikeBundle {
  convention: string;
  name: string;
  provenPacks: (string | { name: string; degraded?: boolean })[];
  portMode: string;
  verification: string;
}
interface ProvenEntry {
  pack: string;
  mode: string;
  verification: string;
  degraded: boolean;
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
for (const p of registry.packs) {
  const device = readJson<{ name?: string; panel?: { w: number; h: number } }>(join(REPO_ROOT, p.path, "device.json"));
  packLabel.set(p.name, device.name || p.name);
  if (device.panel) packPanel.set(p.name, device.panel);
}

interface AppEntry {
  name: string;
  path: string;
  bundle: ChronoLikeBundle;
  proven: ProvenEntry[];
}
const apps: AppEntry[] = registry.apps.map((a) => {
  const bundle = readJson<ChronoLikeBundle>(join(REPO_ROOT, a.path, "bundle.json"));
  const proven: ProvenEntry[] = bundle.provenPacks.map((entry) =>
    typeof entry === "string"
      ? { pack: entry, mode: bundle.portMode, verification: bundle.verification, degraded: false }
      : { pack: entry.name, mode: bundle.portMode, verification: bundle.verification, degraded: entry.degraded ?? false }
  );
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
  blurb: "The instrument's own minimal reference firmware: a 240x240 panel, two buttons (one with a long-press verdict), a shake sensor, and a scripted two-button chord. Not a device pack, not a ported app - the smallest complete emu_device() implementation, and where a new firmware author starts.",
};
// Registered into the SAME two lookup maps every real pack uses (never into
// registry.packs itself, so it never appears in the proof matrix, which
// iterates registry.packs specifically) - this is what lets writeRunPage/
// embedFrameSize below treat "example" as just another pack id with no
// special-casing of its own.
packLabel.set(INSTRUMENT_EXAMPLE.id, INSTRUMENT_EXAMPLE.name);
packPanel.set(INSTRUMENT_EXAMPLE.id, INSTRUMENT_EXAMPLE.panel);

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
  console.log("built -> site/dist/flash/flash.js");
}

// ---- 2. the shared emulator bundle, built once via the repo's own build.ts ----
function buildEmulatorBundle(): void {
  runBuild("build.ts", []);
  const repoDist = join(REPO_ROOT, "dist");
  const emuDir = join(DIST, "emu");
  mkdirSync(emuDir, { recursive: true });
  for (const f of ["index.html", "main.js", "family-budget.css", "app.css"]) {
    copyFileSync(join(repoDist, f), join(emuDir, f));
  }
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
// only place a visitor sees it.
const SITE_FOOTER = `<footer>
    <div class="wrap" style="padding:0">
      <a href="${gh("README.md")}">s0lness/puck</a> on GitHub, MIT licensed.
    </div>
  </footer>`;

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
<link rel="stylesheet" href="${stylesHref}" />
</head>
<body>
${body}
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
const DEMO_ASSET_HREF = (id: string, ext: string) => `assets/demos/${id}.${ext}`;

function demoThumb(id: string, alt: string, href: string): string {
  return `<a class="thumb thumb-video" href="${href}" aria-label="${escapeHtml(alt)}, open the live run page">
    <video autoplay muted loop playsinline poster="${DEMO_ASSET_HREF(id, "png")}">
      <source src="${DEMO_ASSET_HREF(id, "mp4")}" type="video/mp4" />
    </video>
    <noscript><img src="${DEMO_ASSET_HREF(id, "gif")}" alt="${escapeHtml(alt)}" /></noscript>
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
  return mode === "faithful" ? "faithful port" : "adaptation";
}

function renderProofCell(entry: ProvenEntry | undefined, comboIdFor: string | null): string {
  if (!entry) return `<td class="proof-cell empty">not ported</td>`;
  const verif = entry.degraded ? `${entry.verification} (degraded)` : entry.verification;
  const inner = `<span class="proof-mode">${escapeHtml(modeLabel(entry.mode))}</span><span class="proof-verif">${escapeHtml(verif)}</span>`;
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
  ${demoThumb(primary.id, `${app.name} demo`, `run/${primary.id}.html`)}
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
      title: `${packLabel.get(r.pack) || r.pack}: ${r.name}`,
      blurb: r.blurb,
      docHref: gh(r.doc),
    })),
    {
      id: INSTRUMENT_EXAMPLE.id,
      title: INSTRUMENT_EXAMPLE.name,
      blurb: INSTRUMENT_EXAMPLE.blurb,
      docHref: gh(INSTRUMENT_EXAMPLE.doc),
    },
  ];
  const refCardsHtml = refTiles
    .map(
      (r) => `<div class="ref-card">
  ${demoThumb(r.id, `${r.title} demo`, `run/${r.id}.html`)}
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
      <p class="lede">Each cell is a real build of that app's own port, for that device pack's real firmware, verified by the shared harness: click through to run it live.</p>
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

  ${SITE_FOOTER}
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
const BOOTSEL_RITUAL =
  "Unplug USB. Hold PWR for at least 12 seconds, until the screen goes black (replugging alone does not reset the board: the PMIC keeps the rails up). Then hold BOOT while plugging the USB cable back in.";

const ESP32_FLASH_NOTE = "Flashing arrives when this pack's ESP-IDF half has been validated on real silicon (it has not).";

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
    <p class="flash-error" hidden></p>
    <details class="flash-ritual">
      <summary>BOOTSEL entry ritual</summary>
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
    const iframeSrc = `../emu/index.html?embed=1&module=${encodeURIComponent(moduleUrlAbs(opts.id))}`;
    const { w: nativeW, h: nativeH } = embedFrameSize(opts.pack);
    const badges = [opts.modeStr, opts.verifStr]
      .filter((x): x is string => !!x)
      .map((x) => `<span class="badge accent">${escapeHtml(x)}</span>`)
      .join(" ");
    const links = opts.docLinks.map((l) => `<a href="${l.href}">${escapeHtml(l.label)}</a>`).join("\n      ");
    const flashSection = renderFlashSection(opts.id, opts.pack);
    const flashScript = FLASH_ARTIFACTS[opts.id] ? `\n<script type="module" src="../flash/flash.js"></script>` : "";
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
  <p class="embed-hint">touch the screen &middot; R rotates &middot; S shakes</p>

  <div class="run-footer"></div>

${flashSection}
${SITE_FOOTER}
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

// ---- run everything -------------------------------------------------
if (existsSync(DIST)) rmSync(DIST, { recursive: true, force: true });
mkdirSync(DIST, { recursive: true });

buildAllModules();
buildEmulatorBundle();
copyFileSync(join(SITE_DIR, "styles.css"), join(DIST, "styles.css"));
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
