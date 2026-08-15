#!/usr/bin/env bun
// Proves the hardware-free regression check (src/regression.ts) actually
// catches a firmware regression, using nothing but the emulator: the same
// promise harness/selftest.ts proves for the differential harness's own
// mechanism, extended to this feature. No browser, no puppeteer, no real
// hardware anywhere in this file.
//
//   bun run test:regression
//
// What this proves, in order:
//   1. captureBaseline() against a real compiled module produces exactly
//      the capture points this hand-built trace should produce.
//   2. saveBaseline()/loadBaseline() (baselineStore.ts, the actual disk
//      persistence server.ts's /api/baseline route uses) round-trips a
//      baseline exactly - this is the "survives a live reload" property,
//      proven without needing an actual page reload to do it.
//   3. checking a build against ITS OWN baseline passes.
//   4. checking a DIFFERENT build (one draw call changed, compiled fresh -
//      see test/regression/firmware/fixture.c) against that same baseline
//      FAILS, and names the exact capture point that diverged while the
//      point before the change still reports as matching.
//
// Step 4 is the one that matters: a test suite where this check can only
// ever pass would be worth nothing.
import { existsSync, cpSync, rmSync } from "node:fs";
import { join } from "node:path";
import { buildRegressionFixture } from "./build";
import { captureBaseline, checkAgainstBaseline, type BaselineBundle } from "../../src/regression";
import { saveBaseline, loadBaseline, type BaselineOnDisk } from "../../baselineStore";
import type { TraceEvent } from "../../src/recorder";

function fail(msg: string): never {
  console.error(`FAIL: ${msg}`);
  process.exit(1);
}

const ROOT = join(import.meta.dir, "..", "..");
const BASELINES_LATEST = join(ROOT, "baselines", "latest");

// A short-press verdict on button A, straddled by two ticks: the first
// tick (t=10) happens before the verdict lands, so it captures the
// unflipped panel on BOTH builds. The second (t=20) is the tick that
// actually processes the verdict and flips the panel - the one line that
// differs between the two builds (see fixture.c). Timestamps are
// milliseconds, matching performance.now()'s unit, same convention as
// harness/selftest.ts's own hand-built trace.
const events: TraceEvent[] = [
  { t: 0, k: "tick" },
  { t: 10, k: "button", i: 0, down: 1 },
  { t: 10, k: "tick" },
  { t: 20, k: "button", i: 0, down: 0 },
  { t: 20, k: "verdict", i: 0, long: 0 },
  { t: 20, k: "tick" },
];

async function main(): Promise<void> {
  console.log("building the regression-check test fixtures (v1: baseline build, v2: one draw call changed)...");
  const v1 = buildRegressionFixture("regress_v1", false);
  const v2 = buildRegressionFixture("regress_v2", true);
  console.log(`built ${v1.wasmPath} and ${v2.wasmPath}`);

  const v1Bytes = await Bun.file(v1.wasmPath).arrayBuffer();
  const v2Bytes = await Bun.file(v2.wasmPath).arrayBuffer();

  console.log("\ncapturing a baseline against v1...");
  const baseline = await captureBaseline(v1Bytes, events, undefined, 2);
  // The trace has three tick events (t=0, t=10, t=20) and pickCapturePoints
  // keeps every one of them when there are fewer ticks than its cap (8
  // here) - see src/regression.ts. t=0 and t=10 are both before the
  // verdict lands (paper colour on both builds); t=20 is the tick that
  // actually processes it and flips the panel, the one point that should
  // diverge between v1 and v2 below.
  if (baseline.capturePoints.length !== 3) {
    fail(`expected exactly 3 capture points (one per tick event), got ${baseline.capturePoints.length}: ${baseline.capturePoints.join(",")}`);
  }
  if (baseline.capturePoints[0] !== 0 || baseline.capturePoints[1] !== 10 || baseline.capturePoints[2] !== 20) {
    fail(`expected capture points [0, 10, 20], got [${baseline.capturePoints.join(", ")}]`);
  }
  console.log(`baseline captured at t=${baseline.capturePoints.join("ms, t=")}ms`);

  // ---- prove the actual disk persistence, not just an in-memory object --
  // This is baselineStore.ts, the exact module server.ts's /api/baseline
  // route calls - proving THIS round-trips exactly is what backs the
  // "survives a live reload" claim: a reload re-fetches from this same
  // disk state, with nothing carried over from the page's own memory.
  const hadExistingBaseline = existsSync(BASELINES_LATEST);
  const backupDir = hadExistingBaseline ? join(ROOT, "baselines", `.test-backup-${Date.now()}`) : null;
  if (hadExistingBaseline) cpSync(BASELINES_LATEST, backupDir!, { recursive: true });

  let reloaded: BaselineOnDisk | null;
  try {
    console.log("\nsaving the baseline to disk (baselineStore.ts) and reading it back...");
    saveBaseline(baseline as unknown as BaselineOnDisk);
    reloaded = loadBaseline();
    if (!reloaded) fail("saveBaseline()/loadBaseline() round-trip lost the baseline entirely");
    if (reloaded.frames.length !== baseline.frames.length) {
      fail(`round-tripped baseline has ${reloaded.frames.length} frame(s), expected ${baseline.frames.length}`);
    }
    for (const f of baseline.frames) {
      const back = reloaded.frames.find((rf) => rf.atMs === f.atMs);
      if (!back) fail(`round-tripped baseline is missing the t=${f.atMs}ms frame`);
      if (back!.rgbBase64 !== f.rgbBase64) fail(`round-tripped baseline's t=${f.atMs}ms frame does not match byte-for-byte`);
    }
    console.log("PASS: disk round-trip preserved every capture point's frame exactly");
  } finally {
    rmSync(BASELINES_LATEST, { recursive: true, force: true });
    if (backupDir) {
      cpSync(backupDir, BASELINES_LATEST, { recursive: true });
      rmSync(backupDir, { recursive: true, force: true });
    }
  }
  const roundTripped = reloaded as unknown as BaselineBundle;

  // ---- v1 against its own baseline: must pass -----------------------------
  console.log("\nchecking v1 against its own (round-tripped) baseline -- must pass...");
  const selfCheck = await checkAgainstBaseline(v1Bytes, roundTripped);
  if (!selfCheck.pass) fail(`v1 against its own baseline should pass; points: ${JSON.stringify(selfCheck.points)}`);
  console.log(`PASS: ${selfCheck.points.length}/${selfCheck.points.length} capture point(s) matched`);

  // ---- v2 (one draw call changed) against v1's baseline: must fail, and
  // must name the exact capture point that diverged. This is the half that
  // actually exercises the "regression" in "regression check": a suite
  // where this could only ever come back green would prove nothing. -------
  console.log("\nchecking v2 (one draw call changed) against v1's baseline -- must fail, naming the right capture point...");
  const regressionCheck = await checkAgainstBaseline(v2Bytes, roundTripped);
  if (regressionCheck.pass) {
    fail("v2 against v1's baseline PASSED, but v2 draws a different colour after the button verdict -- the regression check did not catch a real, deliberate divergence");
  }

  const boot = regressionCheck.points.find((p) => p.atMs === 0);
  const before = regressionCheck.points.find((p) => p.atMs === 10);
  const after = regressionCheck.points.find((p) => p.atMs === 20);
  if (!boot || !boot!.match) fail(`t=0ms (boot, before any input) should still match; got ${JSON.stringify(boot)}`);
  if (!before) fail("regression check result is missing the t=10ms capture point entirely");
  if (!before!.match) fail(`t=10ms (before the firmware change takes effect) should still match; got ${JSON.stringify(before)}`);
  if (!after) fail("regression check result is missing the t=20ms capture point entirely");
  if (after!.match) fail(`t=20ms (after the firmware change takes effect) should diverge; got ${JSON.stringify(after)}`);
  if (after!.diffPixels <= 0) fail(`t=20ms was reported as diverging but diffPixels=${after!.diffPixels}`);
  if (!after!.firstDiffAt) fail("t=20ms diverged but reported no firstDiffAt");

  console.log(
    `PASS (correctly FAILED the check): t=10ms matched, t=20ms diverged ` +
      `(${after!.diffPixels}/${after!.totalPixels}px, first at (${after!.firstDiffAt!.x},${after!.firstDiffAt!.y})) -- ` +
      `the regression check correctly named the exact capture point that changed and left the unaffected one alone`
  );

  console.log(
    "\nPASS: the hardware-free regression check saves a baseline, survives a disk round-trip, passes against " +
      "an unchanged build, and fails -- naming the right capture point -- against a build that draws differently."
  );
}

main().catch((err) => {
  console.error(`test/regression/run.ts: unexpected error: ${err instanceof Error ? err.message : String(err)}`);
  if (err instanceof Error && err.stack) console.error(err.stack);
  process.exit(1);
});
