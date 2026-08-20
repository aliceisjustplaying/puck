// gameos's own invariant checks - the bundle half of "the bundle owns its
// checks, the instrument owns the runner" (harness/invariantRun.ts's header
// comment). This file has no idea how a wasm module got instantiated or how
// a trace got replayed; it only knows what apps/gameos/traces/
// gameos-demo.trace.json's TWELVE capture points are supposed to mean and
// what a healthy launcher+GUNSHIP+LUCKY7 run should look like at each of
// them - the same timeline this bundle's port README's own "Reproducing
// this show phase" section already documents:
//
//   frames[0..2]  "launcherBoot"    t=16,48,80:   fresh boot, launcher idle
//   frames[3]     "briefing"        t=192:        GUNSHIP briefing screen
//   frames[4]     "missionStart"    t=304:        GUNSHIP mission just started
//   frames[5]     "firing"          t=700:        GUNSHIP, tilt-aimed, firing held
//   frames[6]     "wave"            t=1500:       GUNSHIP, wave in progress
//   frames[7]     "backToLauncher"  t=2316:       returned to launcher (swipe exit)
//   frames[8]     "idle"            t=2460:       LUCKY 7, idle
//   frames[9]     "midSpin"         t=3212:       LUCKY 7, mid-spin motion blur
//   frames[10]    "landed"          t=4396:       LUCKY 7, a reel just landed
//   frames[11]    "win"             t=7004:       LUCKY 7, a resolved win, coins
//
// This exact order and count is a contract with the trace file, not
// something this checker can discover on its own.
//
// Every threshold below was picked empirically against this port's own
// built module (`bun run packs/rp2350-touch-amoled-18/wasm/build.ts --app
// apps/gameos/ports/rp2350-touch-amoled-18/gameos_port.c`) replaying this
// exact trace, not guessed: the measured good-run numbers are quoted next
// to each threshold, and every one of the five checks here was run
// red-before-green (see this bundle's own PR) by deliberately breaking
// this port's own glue code (never the vendored gunship.c/slots.c), the one
// behaviour it is meant to catch, confirming THIS check fails, then
// restoring and confirming green again.

import type { TimedFrame, InvariantMeta, InvariantResult } from "../../harness/invariantRun";

function diffPixelCount(a: TimedFrame["frame"], b: TimedFrame["frame"]): number {
  let diff = 0;
  const n = Math.min(a.rgb.length, b.rgb.length);
  for (let i = 0; i < n; i += 3) {
    if (a.rgb[i] !== b.rgb[i] || a.rgb[i + 1] !== b.rgb[i + 1] || a.rgb[i + 2] !== b.rgb[i + 2]) diff++;
  }
  return diff;
}

// Brightness proxy: pixels whose average channel exceeds 200 - used both as
// "is there rendered text/UI, not just a flat fill" (launcher) and, via its
// absence pattern, elsewhere.
function countBright(frame: TimedFrame["frame"], thresh: number): number {
  const { width, height, rgb } = frame;
  let n = 0;
  for (let i = 0; i < width * height; i++) {
    const r = rgb[i * 3]!, g = rgb[i * 3 + 1]!, b = rgb[i * 3 + 2]!;
    if ((r + g + b) / 3 > thresh) n++;
  }
  return n;
}

// Gold/amber proxy (GOS_AMBER-family colours: this port's launcher card
// accents and LUCKY 7's whole chrome/gold cabinet identity use this range).
// GUNSHIP's thermal ramp (deep blue through white, gos_runtime.c's palette
// indices 0..15 overwritten by gunship's own init()) never produces a pixel
// in this range - see this file's invariant (4).
function countGold(frame: TimedFrame["frame"]): number {
  const { width, height, rgb } = frame;
  let n = 0;
  for (let i = 0; i < width * height; i++) {
    const r = rgb[i * 3]!, g = rgb[i * 3 + 1]!, b = rgb[i * 3 + 2]!;
    if (r > 180 && g > 130 && b < 120) n++;
  }
  return n;
}

// (1) Launcher actually draws its two cards and title text, not just a flat
// navy fill. Measured good run: 4480px bright(>200) at every one of t=16/48/
// 80 (GOS_WHITE title text and card borders/labels). MIN_LAUNCHER_BRIGHT_PX
// = 1500 sits well under that while still requiring real rendered content,
// not antialiasing noise - a launcher_render() that only clears the screen
// would measure 0.
const MIN_LAUNCHER_BRIGHT_PX = 1500;

// (2) Tapping a card actually launches: the screen must change substantially
// between the launcher and the game it launches. Measured good run: 164532px
// differ between launcher80 (t=80) and briefing (t=192, GUNSHIP). Every
// later GUNSHIP/LUCKY7 invariant below implicitly depends on this one
// holding (a launcher_update() that never returns a pick, or an enter_game()
// that never flips s_screen, makes every downstream capture just show the
// launcher again) - see this file's own red-before-green note on why
// breaking this one cascades, the same shape apps/tinydraw/invariants.ts's
// own invariant (1) documents. MIN_LAUNCH_DIFF_PX = 50000 sits well under
// the measured 164532px.
const MIN_LAUNCH_DIFF_PX = 50000;

// (3) Once launched, a game's own simulation keeps advancing tick to tick,
// not frozen on the first rendered frame. Measured good run (GUNSHIP):
// briefing(192)->missionStart(304) = 66988px, missionStart(304)->firing(700)
// = 18004px, firing(700)->wave(1500) = 32996px. Measured good run (LUCKY 7):
// idle(2460)->midSpin(3212) = 33048px, midSpin(3212)->landed(4396) =
// 31348px, landed(4396)->win(7004) = 84368px. MIN_TICK_DIFF_PX = 5000 sits
// well under the smallest of those six measured transitions (18004px) - a
// port_tick() that stops calling a game's own update() every tick (only
// render()) would freeze all six at ~0.
const MIN_TICK_DIFF_PX = 5000;

// (4) GUNSHIP's thermal palette actually applies during play: no
// gold/amber-family pixel appears in any GUNSHIP-screen capture. Measured
// good run: 0 gold px at all four of briefing/missionStart/firing/wave.
// MAX_GUNSHIP_GOLD_PX = 0 is the actual claim, not a margin - see this
// file's own red-before-green note for what a palette that keeps getting
// reset mid-play measures instead.
const MAX_GUNSHIP_GOLD_PX = 0;

// (5) Exiting to the launcher reproduces the EXACT prior launcher screen,
// not a launcher with some leftover state (a stale palette entry, a stray
// pixel from the last game). This is the strongest check in this file,
// mirroring apps/tinydraw/invariants.ts's own undo-exactness invariant:
// backToLauncher (t=2316, after a full GUNSHIP session) must be bit-
// identical to launcher80 (t=80, before anything was ever played) - both
// are launcher_render()'s own deterministic output, and gosrt_
// reset_shell_palette()/gosrt_reset_aim_filters() (enter_launcher(),
// gameos_port.c) exist specifically to make that true. Measured good run:
// 0 differing pixels. MAX_RETURN_DIFF_PX = 0 is therefore the actual claim.
const MAX_RETURN_DIFF_PX = 0;

export function check(frames: TimedFrame[], meta: InvariantMeta): InvariantResult {
  const failures: string[] = [];

  if (frames.length !== 12) {
    return {
      pass: false,
      failures: [`expected exactly 12 captures per this trace's own contract, got ${frames.length}`],
    };
  }

  const [
    launcher16, launcher48, launcher80,
    briefing, missionStart, firing, wave,
    backToLauncher,
    idle, midSpin, landed, win,
  ] = frames;

  // (1) launcher draws real content, at every one of the three boot captures
  for (const [label, f] of [["launcher16", launcher16], ["launcher48", launcher48], ["launcher80", launcher80]] as const) {
    const bright = countBright(f!.frame, 200);
    if (bright < MIN_LAUNCHER_BRIGHT_PX) {
      failures.push(`launcher content: only ${bright}px bright(>200) at ${label} (t=${f!.atMs}), min required ${MIN_LAUNCHER_BRIGHT_PX}px - launcher reads as a blank fill`);
    }
  }

  // (2) tap launches: launcher -> GUNSHIP is a real, substantial screen change
  const launchDiff = diffPixelCount(launcher80!.frame, briefing!.frame);
  if (launchDiff < MIN_LAUNCH_DIFF_PX) {
    failures.push(`launch transition: only ${launchDiff}px differ between launcher80 (t=${launcher80!.atMs}) and briefing (t=${briefing!.atMs}), min required ${MIN_LAUNCH_DIFF_PX}px - tapping the GUNSHIP card does not appear to launch it`);
  }

  // (3) simulation keeps advancing: six consecutive in-game transitions
  const ticks: [string, TimedFrame, TimedFrame][] = [
    ["briefing->missionStart", briefing!, missionStart!],
    ["missionStart->firing", missionStart!, firing!],
    ["firing->wave", firing!, wave!],
    ["idle->midSpin", idle!, midSpin!],
    ["midSpin->landed", midSpin!, landed!],
    ["landed->win", landed!, win!],
  ];
  for (const [label, a, b] of ticks) {
    const d = diffPixelCount(a.frame, b.frame);
    if (d < MIN_TICK_DIFF_PX) {
      failures.push(`simulation alive: only ${d}px differ across ${label} (t=${a.atMs}->t=${b.atMs}), min required ${MIN_TICK_DIFF_PX}px - looks frozen`);
    }
  }

  // (4) GUNSHIP's thermal palette holds during play: no gold/amber leakage
  for (const [label, f] of [["briefing", briefing], ["missionStart", missionStart], ["firing", firing], ["wave", wave]] as const) {
    const gold = countGold(f!.frame);
    if (gold > MAX_GUNSHIP_GOLD_PX) {
      failures.push(`gunship palette: ${gold}px read as gold/amber at ${label} (t=${f!.atMs}), max allowed ${MAX_GUNSHIP_GOLD_PX}px - the thermal ramp is not holding during play`);
    }
  }

  // (5) exiting reproduces the exact prior launcher screen
  const returnDiff = diffPixelCount(launcher80!.frame, backToLauncher!.frame);
  if (returnDiff > MAX_RETURN_DIFF_PX) {
    failures.push(`launcher exactness: backToLauncher (t=${backToLauncher!.atMs}) differs from launcher80 (t=${launcher80!.atMs}) by ${returnDiff}px, expected ${MAX_RETURN_DIFF_PX} (returning to the launcher must reproduce it exactly)`);
  }

  return { pass: failures.length === 0, failures };
}
