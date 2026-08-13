#!/usr/bin/env bun
// The differential test harness's CLI. This is Ragger's pattern (Ledger's
// pytest framework that runs the same script against their emulator and
// real hardware, diffing screenshots at each step), adapted:
//
//   1. record an input trace once (the live page's "save" button, or your
//      own recording tool, writing the same Trace shape as src/recorder.ts)
//   2. replay it through the emulator, capturing the framebuffer at
//      defined points (harness/emulatorSide.ts)
//   3. replay the SAME trace against real hardware over your own link,
//      capturing its screen at the same points (harness/hardwareSide.ts)
//   4. diff them, and report where and when they diverge
//
// Usage:
//   bun run harness/diff.ts <trace.json> --link <path-to-your-link.ts> [options]
//
// Options:
//   --wasm <path>     wasm module to replay against the emulator side
//                      (default: wasm/dist/emu.wasm)
//   --at <ms,ms,...>  explicit capture points, as trace-relative
//                      milliseconds (matching TraceEvent.t)
//   --every <ms>      capture every N ms instead of explicit points
//                      (default if neither --at nor --every given: capture
//                      once, at the trace's final tick)
//   --out <dir>       write PNGs of both captures plus a diff heatmap for
//                      every mismatching frame (default: harness/out)
//   --tolerance <n>   per-channel value difference (0-255) below which a
//                      pixel counts as matching, not diverging (default: 0,
//                      exact match; raise this if your capture path has
//                      real compression/quantisation noise, e.g. a camera)
//
// Your --link module must `export default` a function with no arguments
// that returns a HardwareLink (see harness/types.ts). See
// harness/fixtures/loopbackLink.ts for a minimal, real, working example
// (it is not real hardware - see its own header comment for exactly what
// it stands in for and why), and docs/harness.md for how to point this at
// an actual board.
//
// WHAT THIS CATCHES AND WHAT IT DOES NOT. Read docs/harness.md before
// trusting a clean run more than it has earned: this catches behavioural
// divergence between the two builds of your firmware's C. It does not
// eliminate the two-compilers problem (the wasm build and your real
// build are still two different object codes from one source - see
// docs/decisions/0002), and it does not catch timing or CPU-level bugs.
// A clean diff is evidence the two builds agree on what they draw for
// this input sequence, at these capture points. It is not proof they
// agree on when, or that nothing about the real chip's own timing hazards
// exists.

import { readFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { replayEmulator } from "./emulatorSide";
import { replayHardware } from "./hardwareSide";
import { encodeRGBPNG } from "./png";
import { compareFrames } from "../src/compare";
import type { CapturedFrame, HardwareLink, Trace } from "./types";

// Three distinct outcomes, three distinct exit codes: CI reads exit codes,
// not prose, so "the comparison ran and frames matched," "the comparison
// ran and frames diverged," and "the comparison never happened at all"
// (bad args, a malformed trace, an uncaught exception from either replay
// side, a HardwareLink that never connects) must never collapse onto the
// same number. Before this, an infra failure had no top-level catch at
// all: it fell through as a raw, unhandled-rejection stack trace, which
// (on Bun, as of this writing) still exits 1 -- indistinguishable from a
// real divergence to anything reading the exit code, even though the text
// on screen already made the distinction (a crash looks nothing like
// "FAIL: N frame(s) compared"). See
// docs/findings-first-adversarial-pass.md's "Open" section.
const EXIT_OK = 0;
const EXIT_DIVERGENCE = 1;
const EXIT_INFRA = 2;

interface Args {
  tracePath: string;
  linkPath: string;
  wasmPath: string;
  at: number[] | null;
  every: number | null;
  outDir: string;
  tolerance: number;
}

function parseArgs(argv: string[]): Args {
  const positional: string[] = [];
  let linkPath = "";
  let wasmPath = join(import.meta.dir, "..", "wasm", "dist", "emu.wasm");
  let at: number[] | null = null;
  let every: number | null = null;
  let outDir = join(import.meta.dir, "out");
  let tolerance = 0;

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--link") linkPath = argv[++i] ?? "";
    else if (a === "--wasm") wasmPath = argv[++i] ?? wasmPath;
    else if (a === "--at") at = (argv[++i] ?? "").split(",").map(Number).filter((n) => Number.isFinite(n));
    else if (a === "--every") every = Number(argv[++i]);
    else if (a === "--out") outDir = argv[++i] ?? outDir;
    else if (a === "--tolerance") tolerance = Number(argv[++i] ?? "0");
    else positional.push(a);
  }
  if (positional.length === 0) {
    console.error("usage: bun run harness/diff.ts <trace.json> --link <path-to-your-link.ts> [options]");
    process.exit(EXIT_INFRA);
  }
  if (!linkPath) {
    console.error("missing --link <path-to-your-HardwareLink-module.ts>");
    process.exit(EXIT_INFRA);
  }
  return { tracePath: positional[0]!, linkPath, wasmPath, at, every, outDir, tolerance };
}

// docs/harness.md explicitly anticipates a hand-built trace ("or build one
// by hand" -- see harness/selftest.ts for a worked example), and a
// hand-built one is exactly where an out-of-order timestamp is most
// likely. Uncaught, it produces a WRONG OR SKIPPED capture point on both
// replay sides: emulatorSide.ts's capture-point loop assumes ticks arrive
// with non-decreasing `t` (`while (remainingPoints[0] <= ev.t)`), and
// hardwareSide.ts paces real-time sleeps off the same assumption
// (`targetWall = wallStart + (ev.t - traceStart)`) -- neither errors on a
// violation, they just produce a capture at the wrong moment or miss one
// entirely. Checked once, up front, rather than trusted. Ties are fine
// (a touch and the tick it's latched by commonly share one `t`), so this
// only rejects a STRICT decrease.
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

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  const trace = JSON.parse(readFileSync(args.tracePath, "utf8")) as Trace;
  if (!Array.isArray(trace.events)) throw new Error(`${args.tracePath}: not a trace file (missing events array)`);

  const outOfOrder = findOutOfOrderEvent(trace.events);
  if (outOfOrder) {
    console.error(
      `${args.tracePath}: event[${outOfOrder.index}].t = ${outOfOrder.t} is earlier than the previous event's t = ${outOfOrder.prevT}. ` +
        `Trace timestamps must be non-decreasing (ties are fine -- a touch and the tick it's latched by commonly share one t). Both ` +
        `replay sides pace and pick capture points off this ordering, and an out-of-order trace would otherwise silently produce a ` +
        `wrong or skipped capture point rather than an error. Fix the trace and retry.`
    );
    process.exit(EXIT_INFRA);
  }

  const capturePoints = capturePointsFor(trace.events, args);
  if (capturePoints.length === 0) {
    console.error("no capture points (trace has no tick events, and neither --at nor --every produced any)");
    process.exit(EXIT_INFRA);
  }
  console.log(`replaying ${trace.events.length} events, capturing at ${capturePoints.length} point(s): ${capturePoints.join(", ")}`);

  console.log(`\n-- emulator side --`);
  const emuResult = await replayEmulator(args.wasmPath, trace.events, capturePoints);
  console.log(`${args.wasmPath}: ${emuResult.device.name ?? "device"} ${emuResult.device.panel.w}x${emuResult.device.panel.h}, ${emuResult.frames.length} frame(s) captured`);

  console.log(`\n-- hardware side (${args.linkPath}) --`);
  const linkModule = (await import(resolveModulePath(args.linkPath))) as { default: () => HardwareLink };
  const link = linkModule.default();
  const hwResult = await replayHardware(link, trace.events, capturePoints);
  console.log(`${hwResult.frames.length} frame(s) captured`);

  if (emuResult.frames.length !== hwResult.frames.length) {
    console.error(`frame count mismatch: emulator captured ${emuResult.frames.length}, hardware captured ${hwResult.frames.length}`);
    process.exit(EXIT_INFRA);
  }

  if (args.outDir && !existsSync(args.outDir)) mkdirSync(args.outDir, { recursive: true });

  console.log(`\n-- comparison (tolerance ${args.tolerance}) --`);
  let allMatch = true;
  for (let i = 0; i < emuResult.frames.length; i++) {
    const emuFrame = emuResult.frames[i]!;
    const hwFrame = hwResult.frames[i]!;
    const d = compareFrames(emuFrame.frame, hwFrame.frame, args.tolerance);
    const atMs = emuFrame.atMs;
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
        const base = `t${atMs}`;
        writePng(join(args.outDir, `${base}.emulator.png`), emuFrame.frame);
        writePng(join(args.outDir, `${base}.hardware.png`), hwFrame.frame);
        if (d.diffImage) writePng(join(args.outDir, `${base}.diff.png`), { width: emuFrame.frame.width, height: emuFrame.frame.height, rgb: d.diffImage });
        console.log(`    wrote ${base}.{emulator,hardware,diff}.png -> ${args.outDir}`);
      }
    }
  }

  console.log(`\n${allMatch ? "PASS" : "FAIL"}: ${emuResult.frames.length} frame(s) compared`);
  if (!allMatch) {
    console.log(
      `\nA divergence here means the emulator build and your real build disagree on what they drew for this ` +
        `input, at this point. It does NOT mean the emulator is "wrong" by default: check both PNGs. See ` +
        `docs/harness.md for what this harness can and cannot catch before concluding which side is at fault.`
    );
  }
  process.exit(allMatch ? EXIT_OK : EXIT_DIVERGENCE);
}

function writePng(path: string, frame: CapturedFrame): void {
  Bun.write(path, encodeRGBPNG(frame.width, frame.height, frame.rgb));
}

// Dynamic `import()` needs a proper module specifier; a bare relative path
// from the CLI arg (e.g. "./myLink.ts") isn't automatically resolved
// against cwd, so this makes it absolute first.
function resolveModulePath(p: string): string {
  return p.startsWith(".") || !p.match(/^[a-zA-Z]+:/) ? join(process.cwd(), p) : p;
}

// Unlike every other failure path in this file, main() itself had no
// top-level catch: a truncated trace, a bad wasm path, or a HardwareLink
// that throws while connecting fell straight through as a raw,
// unhandled-rejection stack trace instead of this file's own
// console.error + process.exit style, AND (see EXIT_INFRA above) used to
// exit with the exact same code as a real divergence. This is the fix for
// both at once.
main().catch((err) => {
  console.error(`harness/diff.ts: unexpected error: ${err instanceof Error ? err.message : String(err)}`);
  if (err instanceof Error && err.stack) console.error(err.stack);
  process.exit(EXIT_INFRA);
});
