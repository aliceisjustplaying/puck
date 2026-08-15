// The regression suite for "the emulator fails loudly": drives every
// hostile firmware under test/hostile/firmware/*.c through the REAL dev
// server in a REAL headless Chrome (same method the first adversarial pass
// used - see docs/findings-first-adversarial-pass.md - not TypeScript
// stand-ins for what a hostile module might do), and asserts each one is
// now reported the way the fix promises: a clean #wasmError banner, a
// distinct #engineDead banner, or a skipped-and-logged "firmware bug:"
// finding -- never an uncaught page error, never a silently frozen tick
// loop, never a freeze bundle that claims a dead session is healthy.
//
// Cases #6 and #7 (button_trap, app_switch_trap) cover the follow-up: a
// trap in a direct ABI call made from a DOM event handler, entirely
// outside the tick loop stepOnce guards (a button press, an app-strip
// click) -- the class of bug the original guarding pass scoped out and
// said so honestly. See main.ts's guardedAbiCall for the fix.
//
//   bun run test:hostile
//
// Requires the same local Chrome install as scripts/verify.ts (set
// CHROME_PATH if it isn't found automatically) and a zig toolchain able to
// build wasm32-freestanding (ZIG_EXE if it isn't on PATH). zig cc is
// documented (AGENTS.md, docs/findings-first-adversarial-pass.md) to
// segfault under cache contention roughly one attempt in four on this
// machine, clean on immediate retry; test/hostile/build.ts already retries.
//
// One shared dev server and one shared browser page for the whole suite:
// each case writes its hostile module to wasm/dist/emu.wasm (the same path
// server.ts always serves and watches) and then does a full page
// navigation, which runs main.ts's own boot() -> reloadModule("initial
// load") exactly once, deterministically -- no reliance on the live-reload
// websocket's own debounced broadcast, which would otherwise race a
// fast-moving test script (see server.ts's waitForStableFile). The
// original wasm/dist/emu.wasm (if any) is restored when the suite ends,
// whether it passed or not.
import puppeteer, { type Page } from "puppeteer-core";
import { join } from "node:path";
import { existsSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { buildHostileFirmware, listHostileFirmwareNames } from "./build";
import { FREEZE_SCHEMA_VERSION } from "../../src/freeze";
import { Recorder } from "../../src/recorder";
import { TRACE_MAX_EVENTS } from "../../src/constants";

const ROOT = join(import.meta.dir, "..", "..");
const PORT = 53411; // distinct from scripts/verify.ts's 53409
const WASM_FILE = join(ROOT, "wasm", "dist", "emu.wasm");
const FREEZE_LATEST_BUNDLE = join(ROOT, "freezes", "latest", "bundle.json");

function findChrome(): string {
  const candidates = [
    "C:/Program Files/Google/Chrome/Application/chrome.exe",
    "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium-browser",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  ];
  for (const c of candidates) if (existsSync(c)) return c;
  throw new Error(`no local Chrome found in the usual locations. Set CHROME_PATH to your Chrome/Chromium executable.`);
}
const CHROME = process.env.CHROME_PATH || findChrome();

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function verifyRecorderCapacity(): void {
  const recorder = new Recorder();
  for (let index = 0; index < TRACE_MAX_EVENTS; index++) {
    recorder.record({ t: index, k: "tick" });
  }
  assert(!recorder.truncated, "a trace that exactly fills recorder capacity must not be truncated");
  recorder.record({ t: TRACE_MAX_EVENTS, k: "tick" });
  assert(recorder.events.length === TRACE_MAX_EVENTS, "recorder grew past TRACE_MAX_EVENTS");
  assert(recorder.truncated, "recorder did not mark the first dropped event as truncation");
  assert(recorder.events[0]?.t === 0, "recorder did not preserve the fresh-boot prefix at index 0");
  const trace = recorder.toTrace({ panel: { w: 1, h: 1, format: "rgb565" } });
  assert(trace.truncated, "toTrace() did not export recorder truncation");
  recorder.clear();
  assert(!recorder.truncated, "clear() did not reset recorder truncation");
  console.log("recorder capacity: PASS");
}

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

// Builds the real example firmware straight into wasm/dist/emu.wasm (the
// canonical path this whole suite temporarily borrows) -- this is the
// KNOWN-GOOD baseline the "a healthy freeze must say so honestly" check
// runs against, deliberately built fresh from current source rather than
// trusted from whatever happened to be on disk already.
function buildBaselineIntoWasmDist(): void {
  const MAX_ATTEMPTS = 3; // same zig cc flakiness as test/hostile/build.ts
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const result = Bun.spawnSync(["bun", "run", "example/build.ts"], { cwd: ROOT, env: process.env, stdout: "inherit", stderr: "inherit" });
    if (result.success) return;
    if (attempt < MAX_ATTEMPTS) console.warn(`baseline example firmware build failed (attempt ${attempt}/${MAX_ATTEMPTS}), retrying...`);
  }
  throw new Error("could not build the baseline example firmware after retries");
}

interface PageState {
  wasmErrorVisible: boolean;
  wasmErrorText: string;
  engineDeadVisible: boolean;
  engineDeadText: string;
  consoleText: string;
  deviceName: string | null;
  tickCount: number | null;
  deadState: { error: string; diedOnTick: number; cause: string } | null;
}

async function readPageState(page: Page): Promise<PageState> {
  return page.evaluate(() => {
    const w = window as unknown as { __debug?: Record<string, (...a: unknown[]) => unknown> };
    const wasmErrorEl = document.querySelector("#wasmError");
    const engineDeadEl = document.querySelector("#engineDead");
    const dbg = w.__debug;
    const device = dbg?.getDevice?.() as { name?: string } | null | undefined;
    return {
      wasmErrorVisible: !!wasmErrorEl && !wasmErrorEl.classList.contains("hidden"),
      wasmErrorText: wasmErrorEl?.textContent ?? "",
      engineDeadVisible: !!engineDeadEl && !engineDeadEl.classList.contains("hidden"),
      engineDeadText: engineDeadEl?.textContent ?? "",
      consoleText: document.querySelector("#consolePane")?.textContent ?? "",
      deviceName: device?.name ?? null,
      tickCount: (dbg?.getTickCount?.() as number | undefined) ?? null,
      deadState: (dbg?.getDeadState?.() as PageState["deadState"] | undefined) ?? null,
    };
  });
}

// Loads a module at `wasmPath` through a FULL page navigation (not the
// live-reload websocket path, and not the __debug.reloadModule() escape
// hatch either): this is exactly the boot() -> reloadModule("initial
// load") path every real user's first page load takes, driven for real.
async function loadCase(page: Page, wasmPath: string): Promise<void> {
  writeFileSync(WASM_FILE, readFileSync(wasmPath));
  await page.goto(`http://127.0.0.1:${PORT}/?storage=throwaway`, { waitUntil: "domcontentloaded" });
}

interface CaseResult {
  name: string;
  pass: boolean;
  notes: string[];
}
const results: CaseResult[] = [];

function record(name: string, checks: { label: string; pass: boolean }[]): void {
  const pass = checks.every((c) => c.pass);
  const notes = checks.map((c) => `${c.pass ? "ok" : "FAIL"}: ${c.label}`);
  results.push({ name, pass, notes });
  console.log(`\n${pass ? "PASS" : "FAIL"}: ${name}`);
  for (const n of notes) console.log(`  ${n}`);
}

async function freezeAndReadBundle(page: Page): Promise<Record<string, unknown>> {
  await page.click("#btnFreeze");
  await page.waitForFunction(() => (document.querySelector("#consolePane")?.textContent ?? "").includes("frozen ->"), { timeout: 5000 });
  return JSON.parse(readFileSync(FREEZE_LATEST_BUNDLE, "utf8")) as Record<string, unknown>;
}

async function main(): Promise<void> {
  verifyRecorderCapacity();
  console.log("building hostile firmware modules...");
  const builds = new Map(listHostileFirmwareNames().map((name) => [name, buildHostileFirmware(name).wasmPath]));
  console.log(`built ${builds.size} hostile module(s): ${[...builds.keys()].join(", ")}`);

  const hadOriginal = existsSync(WASM_FILE);
  const originalBytes = hadOriginal ? readFileSync(WASM_FILE) : null;

  console.log("\nbuilding the baseline (real) example firmware into wasm/dist/emu.wasm...");
  buildBaselineIntoWasmDist();

  const server = Bun.spawn(["bun", "run", "server.ts"], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT) },
    stdout: "pipe",
    stderr: "pipe",
  });

  let browser: Awaited<ReturnType<typeof puppeteer.launch>> | null = null;
  try {
    await waitForServer(`http://127.0.0.1:${PORT}/`, 15000);
    console.log("server up\n");

    browser = await puppeteer.launch({ executablePath: CHROME, headless: true });
    const page = await browser.newPage();
    await page.setViewport({ width: 1200, height: 900 });
    let pageErrors: string[] = [];
    page.on("pageerror", (e: unknown) => pageErrors.push(e instanceof Error ? e.message : String(e)));

    // ---- baseline: a healthy session's freeze must say so honestly ----
    pageErrors = [];
    await page.goto(`http://127.0.0.1:${PORT}/?storage=throwaway`, { waitUntil: "domcontentloaded" });
    await sleep(1000);
    const baselineState = await readPageState(page);
    const baselineBundle = await freezeAndReadBundle(page);
    const baselineEngine = baselineBundle.engine as { alive?: boolean } | undefined;
    record("baseline (real example firmware): loads clean, and a freeze says engine.alive === true", [
      { label: "no uncaught page errors", pass: pageErrors.length === 0 },
      { label: "#wasmError hidden", pass: !baselineState.wasmErrorVisible },
      { label: "#engineDead hidden", pass: !baselineState.engineDeadVisible },
      { label: `freeze bundle schemaVersion === ${FREEZE_SCHEMA_VERSION}`, pass: baselineBundle.schemaVersion === FREEZE_SCHEMA_VERSION },
      { label: "freeze bundle inputTruncated is boolean", pass: typeof baselineBundle.inputTruncated === "boolean" },
      { label: "freeze bundle engine.alive === true", pass: baselineEngine?.alive === true },
    ]);

    // ---- hostile #1: emu_fb() returns an out-of-bounds pointer ----
    pageErrors = [];
    await loadCase(page, builds.get("fb_out_of_bounds")!);
    await sleep(1000);
    const s1 = await readPageState(page);
    record('hostile: emu_fb() returns 0x7FFFFFFF ("bringUp() unguarded blitAll()" in the adversarial pass)', [
      { label: "no uncaught page errors", pass: pageErrors.length === 0 },
      { label: "#wasmError visible", pass: s1.wasmErrorVisible },
      { label: '#wasmError names emu_fb()', pass: /emu_fb\(\)/.test(s1.wasmErrorText) },
      { label: "#engineDead stays hidden (module never came up, this is not an engine crash)", pass: !s1.engineDeadVisible },
    ]);

    // ---- hostile #2: a sensor entry with no "id" ----
    pageErrors = [];
    await loadCase(page, builds.get("sensor_missing_id")!);
    await sleep(1000);
    const s2 = await readPageState(page);
    record('hostile: emu_device()\'s sensors[0] has no "id" (was buildChrome()\'s TypeError on s.id.toLowerCase())', [
      { label: "no uncaught page errors", pass: pageErrors.length === 0 },
      { label: "#wasmError visible", pass: s2.wasmErrorVisible },
      { label: 'names sensors[0] and "id"', pass: /sensors\[0\]/.test(s2.wasmErrorText) && /"id"/.test(s2.wasmErrorText) },
      { label: "#engineDead stays hidden", pass: !s2.engineDeadVisible },
    ]);

    // ---- hostile #3: a push rectangle at y=1000000 on the second tick ----
    pageErrors = [];
    await loadCase(page, builds.get("push_rect_out_of_bounds")!);
    await sleep(1500); // ~90 ticks at 60Hz: well past the hostile tick 2
    const s3 = await readPageState(page);
    record('hostile: a push rect at y=1000000 on tick 2 (was the invalid-typed-array-length crash inside requestAnimationFrame)', [
      { label: "no uncaught page errors", pass: pageErrors.length === 0 },
      { label: "#wasmError stays hidden (the module DID come up)", pass: !s3.wasmErrorVisible },
      { label: "#engineDead stays hidden (a bad rect is a finding, not a crash)", pass: !s3.engineDeadVisible },
      { label: `ticking kept going (tickCount=${s3.tickCount}, expected > 5)`, pass: (s3.tickCount ?? 0) > 5 },
      { label: 'console pane logged a "firmware bug:" finding naming the out-of-bounds rect', pass: /firmware bug:.*extends past the declared panel/s.test(s3.consoleText) },
    ]);

    // ---- hostile #4: emu_tick() writes through a wild pointer ----
    pageErrors = [];
    await loadCase(page, builds.get("wild_pointer_trap")!);
    await sleep(1200); // settle, and comfortably past server.ts's own live-reload debounce window
    const s4a = await readPageState(page);
    await sleep(800);
    const s4b = await readPageState(page);
    const crashBundle = await freezeAndReadBundle(page);
    const crashEngine = crashBundle.engine as { alive?: boolean; error?: string; diedOnTick?: number } | undefined;
    record("hostile: emu_tick() writes through a wild pointer (a real wasm trap, not a JS-catchable ABI value)", [
      { label: "no uncaught page errors (the trap is caught, not left to escape)", pass: pageErrors.length === 0 },
      { label: "#wasmError stays hidden (the module DID come up first)", pass: !s4a.wasmErrorVisible },
      { label: "#engineDead visible", pass: s4a.engineDeadVisible },
      { label: 'banner names "died on tick"', pass: /died on tick/.test(s4a.engineDeadText) },
      { label: "debug state: died on tick 1", pass: s4a.deadState?.diedOnTick === 1 },
      { label: `ticking actually stopped (tickCount ${s4a.tickCount} then ${s4b.tickCount}, 800ms apart)`, pass: s4a.tickCount === s4b.tickCount },
      { label: `freeze bundle schemaVersion === ${FREEZE_SCHEMA_VERSION}`, pass: crashBundle.schemaVersion === FREEZE_SCHEMA_VERSION },
      { label: "freeze bundle inputTruncated is boolean", pass: typeof crashBundle.inputTruncated === "boolean" },
      { label: "freeze bundle engine.alive === false (this is the honesty check: it must NOT look like an ordinary freeze)", pass: crashEngine?.alive === false },
      { label: "freeze bundle engine.diedOnTick === 1", pass: crashEngine?.diedOnTick === 1 },
      { label: "freeze bundle engine.error is a real, non-empty exception message", pass: typeof crashEngine?.error === "string" && crashEngine.error.length > 0 },
    ]);

    // ---- hostile #5: emu_sound_frames() claims 100,000,000 frames ----
    pageErrors = [];
    await loadCase(page, builds.get("audio_bad_buffer")!);
    await sleep(500);
    await page.mouse.click(100, 100); // a real, trusted CDP-dispatched gesture: unlocks the AudioContext, per audio.ts's autoplay-policy wiring
    await sleep(2000); // >20 ticks at 60Hz: past the firmware's own play_seq bump threshold, more than once
    const s5 = await readPageState(page);
    record("hostile: emu_sound_frames() claims 100,000,000 frames (found by inspection; audio.ts's play() had no bounds check)", [
      { label: "no uncaught page errors", pass: pageErrors.length === 0 },
      { label: "#wasmError stays hidden", pass: !s5.wasmErrorVisible },
      { label: "#engineDead stays hidden (a bad audio buffer is a finding, not a crash)", pass: !s5.engineDeadVisible },
      { label: `ticking kept going (tickCount=${s5.tickCount}, expected > 20)`, pass: (s5.tickCount ?? 0) > 20 },
      { label: 'console pane logged a "firmware bug:" finding, and the play() call was skipped', pass: /firmware bug:.*sound_play\(\) call ignored/s.test(s5.consoleText) },
    ]);

    // ---- hostile #6: emu_button() writes through a wild pointer on press ----
    // The open item the tick-loop guard's first pass scoped out on
    // purpose: a direct ABI call from a DOM event handler (device.ts's
    // wireButton -> main.ts's emuButtonDown), never inside
    // requestAnimationFrame's own callback, so stepOnce's try/catch cannot
    // reach it. Presses the real .dev-btn element with a real mouse click,
    // through the same pointerdown/pointerup path a person's mouse would
    // take -- not __debug's escape hatch, and not a direct emu_button()
    // call from this script.
    pageErrors = [];
    await loadCase(page, builds.get("button_trap")!);
    await sleep(500);
    const preClickTick = (await readPageState(page)).tickCount ?? 0;
    await page.click(".dev-btn");
    await sleep(800);
    const s6a = await readPageState(page);
    await sleep(500);
    const s6b = await readPageState(page);
    const buttonCrashBundle = await freezeAndReadBundle(page);
    const buttonCrashEngine = buttonCrashBundle.engine as { alive?: boolean; error?: string; diedOnTick?: number; cause?: string } | undefined;
    record('hostile: emu_button() writes through a wild pointer on press (the button-handler open item, "guard the direct ABI calls too")', [
      { label: "ticking was healthy before the click", pass: preClickTick > 0 },
      { label: "no uncaught page errors (the trap is caught, not left to escape)", pass: pageErrors.length === 0 },
      { label: "#wasmError stays hidden (the module DID come up first)", pass: !s6a.wasmErrorVisible },
      { label: "#engineDead visible (a trapped button must not look like it just did nothing)", pass: s6a.engineDeadVisible },
      { label: 'banner names the button, not "tick"', pass: /button\[0\] down/.test(s6a.engineDeadText) },
      { label: "debug state: cause is button[0] down", pass: s6a.deadState?.cause === "button[0] down" },
      { label: `ticking also stopped (tickCount ${s6a.tickCount} then ${s6b.tickCount}, 500ms apart)`, pass: s6a.tickCount === s6b.tickCount },
      { label: "freeze bundle engine.alive === false", pass: buttonCrashEngine?.alive === false },
      { label: "freeze bundle engine.cause names the button, not a tick", pass: buttonCrashEngine?.cause === "button[0] down" },
    ]);

    // ---- hostile #7: emu_app_switch() writes through a wild pointer ----
    // Same open item, different direct call: appstrip.ts's click listener,
    // outside the tick loop, calling emu_app_switch() through
    // guardedCall -> main.ts's guardedAbiCall. Index 0 (the initial app) is
    // harmless in this firmware, so the module comes up and ticks
    // normally; only clicking the SECOND app-strip button traps.
    pageErrors = [];
    await loadCase(page, builds.get("app_switch_trap")!);
    await sleep(500);
    const preSwitchTick = (await readPageState(page)).tickCount ?? 0;
    const appButtons = await page.$$(".app-strip-btn");
    if (appButtons.length !== 2) throw new Error(`expected 2 app-strip buttons for app_switch_trap, found ${appButtons.length}`);
    await appButtons[1]!.click();
    await sleep(800);
    const s7a = await readPageState(page);
    await sleep(500);
    const s7b = await readPageState(page);
    const appCrashBundle = await freezeAndReadBundle(page);
    const appCrashEngine = appCrashBundle.engine as { alive?: boolean; error?: string; diedOnTick?: number; cause?: string } | undefined;
    record('hostile: emu_app_switch() writes through a wild pointer (the app-strip open item, "guard the direct ABI calls too")', [
      { label: "ticking was healthy before the click", pass: preSwitchTick > 0 },
      { label: "no uncaught page errors (the trap is caught, not left to escape)", pass: pageErrors.length === 0 },
      { label: "#wasmError stays hidden (the module DID come up first)", pass: !s7a.wasmErrorVisible },
      { label: "#engineDead visible (a trapped app switch must not look like it just did nothing)", pass: s7a.engineDeadVisible },
      { label: 'banner names the app switch, not "tick"', pass: /app switch to 1/.test(s7a.engineDeadText) },
      { label: "debug state: cause names the app switch", pass: s7a.deadState?.cause === 'app switch to 1 ("two")' },
      { label: `ticking also stopped (tickCount ${s7a.tickCount} then ${s7b.tickCount}, 500ms apart)`, pass: s7a.tickCount === s7b.tickCount },
      { label: "freeze bundle engine.alive === false", pass: appCrashEngine?.alive === false },
      { label: "freeze bundle engine.cause names the app switch, not a tick", pass: appCrashEngine?.cause === 'app switch to 1 ("two")' },
    ]);
  } finally {
    if (browser) await browser.close();
    // See AGENTS.md: plain server.kill() can leave Bun's dev-server watcher
    // still listening on Windows even after the parent reports killed.
    server.kill();
    try {
      Bun.spawnSync(["taskkill", "/pid", String(server.pid), "/t", "/f"], { stdout: "ignore", stderr: "ignore" });
    } catch {}
    if (hadOriginal && originalBytes) writeFileSync(WASM_FILE, originalBytes);
    else if (!hadOriginal && existsSync(WASM_FILE)) rmSync(WASM_FILE);
  }

  const failed = results.filter((r) => !r.pass);
  console.log(`\n${failed.length === 0 ? "PASS" : "FAIL"}: ${results.length - failed.length}/${results.length} hostile-firmware checks passed`);
  process.exit(failed.length === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(`test/hostile/run.ts: unexpected error: ${err instanceof Error ? err.message : String(err)}`);
  if (err instanceof Error && err.stack) console.error(err.stack);
  process.exit(1);
});
