#!/usr/bin/env bun
// The PORT differential harness's CLI: given two wasm modules and one
// trace, replays the SAME trace against both, headless, and compares the
// captured frames. This is harness/diff.ts's pattern (emulator vs. real
// hardware) turned sideways: emulator vs. emulator, two different device
// packs, one app bundle. The question this answers is not "does the
// emulator match my board" but "do these two ports of one app draw the
// same pixels for the same input" - the check the porting flow
// (docs/convention/app-bundle.md) calls "faithful" verification: replay
// the trace verbatim, diff the frames pixel-exact.
//
// Deliberately device-agnostic: nothing here hardcodes a panel size, a
// button name or index, or a device name. Both modules' shapes come from
// their own emu_device() (via replayEmulator -> replayFromBytes ->
// readDeviceDescriptor), same as every other consumer in this repo. A
// trace itself already carries only portable input (touch/button/verdict/
// sensor indices and coordinates, and tick timestamps - src/recorder.ts),
// so replaying it against two different packs' modules needs nothing
// pack-specific here.
//
// Usage:
//   bun run portdiff <moduleA.wasm> <moduleB.wasm> <trace.json> [options]
//   bun run harness/portdiff.ts <moduleA.wasm> <moduleB.wasm> <trace.json> [options]
//
// Options:
//   --at <ms,ms,...>     explicit capture points, as trace-relative
//                        milliseconds (matching TraceEvent.t)
//   --every <ms>         capture every N ms instead of explicit points
//                        (default if neither --at nor --every given:
//                        capture once, at the trace's final tick)
//   --tolerance <n>      per-channel value difference (0-255) below which a
//                        pixel counts as matching (default: 0, exact match -
//                        this harness compares two wasm builds, not a real
//                        capture path, so there is no compression/quantisation
//                        noise to allow for)
//   --out <dir>          on a divergence, write PNGs of both frames plus a
//                        diff heatmap (default: harness/out)
//   --write-frames <dir> write MODULE A's frames as PNGs into <dir>, one
//                        per capture point, regardless of match/diverge.
//                        This is how a proven port's expected frames get
//                        written for its app bundle (docs/convention/
//                        app-bundle.md's "expected frames"): point module A
//                        at the reference pack's build and this at the
//                        bundle's own frames/ directory once every capture
//                        point matches.
//
// Exit codes, same three-way split harness/diff.ts uses and for the same
// reason (CI reads the code, not the prose): 0 = ran, every frame matched;
// 1 = ran, at least one frame diverged; 2 = never ran to completion (bad
// args, a malformed or out-of-order trace, a module that failed to
// instantiate).

import { readFileSync, mkdirSync, existsSync } from "node:fs";
import { basename, join } from "node:path";
import { replayEmulator } from "./emulatorSide";
import { encodeRGBPNG } from "./png";
import { compareFrames } from "../src/compare";
import type { CapturedFrame, Trace } from "./types";

const EXIT_OK = 0;
const EXIT_DIVERGENCE = 1;
const EXIT_INFRA = 2;

interface Args {
  moduleAPath: string;
  moduleBPath: string;
  tracePath: string;
  at: number[] | null;
  every: number | null;
  outDir: string;
  writeFramesDir: string | null;
  tolerance: number;
}

function parseArgs(argv: string[]): Args {
  const positional: string[] = [];
  let at: number[] | null = null;
  let every: number | null = null;
  let outDir = join(import.meta.dir, "out");
  let writeFramesDir: string | null = null;
  let tolerance = 0;

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--at") at = (argv[++i] ?? "").split(",").map(Number).filter((n) => Number.isFinite(n));
    else if (a === "--every") every = Number(argv[++i]);
    else if (a === "--out") outDir = argv[++i] ?? outDir;
    else if (a === "--write-frames") writeFramesDir = argv[++i] ?? null;
    else if (a === "--tolerance") tolerance = Number(argv[++i] ?? "0");
    else positional.push(a);
  }
  if (positional.length < 3) {
    console.error("usage: bun run portdiff <moduleA.wasm> <moduleB.wasm> <trace.json> [options]");
    console.error("       (see harness/portdiff.ts's header comment for the full option list)");
    process.exit(EXIT_INFRA);
  }
  return {
    moduleAPath: positional[0]!,
    moduleBPath: positional[1]!,
    tracePath: positional[2]!,
    at,
    every,
    outDir,
    writeFramesDir,
    tolerance,
  };
}

// Identical rule to harness/diff.ts's findOutOfOrderEvent, and for the
// identical reason: both replay sides assume ticks arrive with
// non-decreasing `t` (replayFromBytes's capture-point loop), so a hand- or
// tool-authored trace with a strict decrease would otherwise produce a
// wrong or skipped capture point rather than an error. Ties are fine.
function findOutOfOrderEvent(events: Trace["events"]): { index: number; t: number; prevT: number } | null {
  let prevT = -Infinity;
  for (let i = 0; i < events.length; i++) {
    const t = events[i]!.t;
    if (t < prevT) return { index: i, t, prevT };
    prevT = t;
  }
  return null;
}

function capturePointsFor(events: Trace["events"], args: Args): number[] {
  const tickTimes = events.filter((e) => e.k === "tick").map((e) => e.t);
  if (args.at && args.at.length > 0) return args.at;
  if (args.every && args.every > 0) {
    if (tickTimes.length === 0) return [];
    const first = tickTimes[0]!, last = tickTimes[tickTimes.length - 1]!;
    const points: number[] = [];
    for (let t = first; t <= last; t += args.every) points.push(t);
    return points;
  }
  return tickTimes.length > 0 ? [tickTimes[tickTimes.length - 1]!] : [];
}

async function writePng(path: string, frame: CapturedFrame): Promise<void> {
  await Bun.write(path, encodeRGBPNG(frame.width, frame.height, frame.rgb));
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  const trace = JSON.parse(readFileSync(args.tracePath, "utf8")) as Trace;
  if (!Array.isArray(trace.events)) throw new Error(`${args.tracePath}: not a trace file (missing events array)`);

  const outOfOrder = findOutOfOrderEvent(trace.events);
  if (outOfOrder) {
    console.error(
      `${args.tracePath}: event[${outOfOrder.index}].t = ${outOfOrder.t} is earlier than the previous event's t = ${outOfOrder.prevT}. ` +
        `Trace timestamps must be non-decreasing (ties are fine). Fix the trace and retry.`
    );
    process.exit(EXIT_INFRA);
  }

  const capturePoints = capturePointsFor(trace.events, args);
  if (capturePoints.length === 0) {
    console.error("no capture points (trace has no tick events, and neither --at nor --every produced any)");
    process.exit(EXIT_INFRA);
  }
  console.log(`${basename(args.tracePath)}: replaying ${trace.events.length} events, capturing at ${capturePoints.length} point(s): ${capturePoints.join(", ")}`);

  console.log(`\n-- module A: ${args.moduleAPath} --`);
  const resultA = await replayEmulator(args.moduleAPath, trace.events, capturePoints);
  console.log(`${resultA.device.name ?? "device"} ${resultA.device.panel.w}x${resultA.device.panel.h}, ${resultA.frames.length} frame(s) captured`);

  console.log(`\n-- module B: ${args.moduleBPath} --`);
  const resultB = await replayEmulator(args.moduleBPath, trace.events, capturePoints);
  console.log(`${resultB.device.name ?? "device"} ${resultB.device.panel.w}x${resultB.device.panel.h}, ${resultB.frames.length} frame(s) captured`);

  if (resultA.frames.length !== resultB.frames.length) {
    console.error(`frame count mismatch: module A captured ${resultA.frames.length}, module B captured ${resultB.frames.length}`);
    process.exit(EXIT_INFRA);
  }

  if (args.writeFramesDir && !existsSync(args.writeFramesDir)) mkdirSync(args.writeFramesDir, { recursive: true });
  if (args.outDir && !existsSync(args.outDir)) mkdirSync(args.outDir, { recursive: true });

  const traceStem = basename(args.tracePath).replace(/\.trace\.json$|\.json$/, "");

  console.log(`\n-- comparison (tolerance ${args.tolerance}) --`);
  let allMatch = true;
  for (let i = 0; i < resultA.frames.length; i++) {
    const frameA = resultA.frames[i]!;
    const frameB = resultB.frames[i]!;
    const atMs = frameA.atMs;

    if (args.writeFramesDir) {
      // Frame naming is this file's own invention (docs/convention/
      // app-bundle.md names "expected frames" but does not prescribe a
      // filename scheme): <trace-stem>.t<ms>.png, one per capture point, so
      // a bundle's frames/ directory holds a self-describing set with no
      // extra index file needed.
      await writePng(join(args.writeFramesDir, `${traceStem}.t${atMs}.png`), frameA.frame);
    }

    const d = compareFrames(frameA.frame, frameB.frame, args.tolerance);
    const pct = d.totalPixels > 0 ? ((d.diffPixels / d.totalPixels) * 100).toFixed(2) : "?";
    if (d.match) {
      console.log(`  t=${atMs}ms  MATCH`);
    } else {
      allMatch = false;
      console.log(
        `  t=${atMs}ms  DIVERGE  ${d.diffPixels}/${d.totalPixels} px (${pct}%)` +
          (d.firstDiffAt ? `  first at (${d.firstDiffAt.x},${d.firstDiffAt.y})` : "") +
          `  max channel delta ${d.maxChannelDelta}`
      );
      if (args.outDir) {
        const base = `${traceStem}.t${atMs}`;
        await writePng(join(args.outDir, `${base}.a.png`), frameA.frame);
        await writePng(join(args.outDir, `${base}.b.png`), frameB.frame);
        if (d.diffImage) await writePng(join(args.outDir, `${base}.diff.png`), { width: frameA.frame.width, height: frameA.frame.height, rgb: d.diffImage });
        console.log(`    wrote ${base}.{a,b,diff}.png -> ${args.outDir}`);
      }
    }
  }

  if (args.writeFramesDir) console.log(`\nwrote ${resultA.frames.length} frame(s) from module A to ${args.writeFramesDir}`);

  console.log(`\n${allMatch ? "PASS" : "FAIL"}: ${resultA.frames.length} frame(s) compared (${basename(args.tracePath)})`);
  process.exit(allMatch ? EXIT_OK : EXIT_DIVERGENCE);
}

main().catch((err) => {
  console.error(`harness/portdiff.ts: unexpected error: ${err instanceof Error ? err.message : String(err)}`);
  if (err instanceof Error && err.stack) console.error(err.stack);
  process.exit(EXIT_INFRA);
});
