// gameos's own invariant checks - the bundle half of "the bundle owns its
// checks, the instrument owns the runner" (harness/invariantRun.ts's header
// comment). This file has no idea how a wasm module got instantiated or how
// a trace got replayed; it only knows what a trace's capture points are
// supposed to mean and what a healthy run should look like at each of them.
//
// TWO shapes are accepted, both sharing the same first 12 points - the
// rp2350 port (still two games, apps/gameos/traces/gameos-demo.trace.json,
// unchanged) and the esp32 port BEFORE GOLF shipped both used exactly 12;
// the esp32 port's own trace (apps/gameos/traces/gameos-demo-esp32.trace.json,
// see that port's own README for why it is a SEPARATE file from the shared
// one, not an edit to it) extends the same 12 with three more for GOLF:
//
//   frames[0..2]  "launcherBoot"    fresh boot, launcher idle
//   frames[3]     "briefing"        GUNSHIP briefing screen
//   frames[4]     "missionStart"    GUNSHIP mission just started
//   frames[5]     "firing"          GUNSHIP, tilt-aimed, firing held
//   frames[6]     "wave"            GUNSHIP, wave in progress
//   frames[7]     "backToLauncher"  returned to launcher (swipe exit)
//   frames[8]     "idle"            LUCKY 7, idle
//   frames[9]     "midSpin"         LUCKY 7, mid-spin motion blur
//   frames[10]    "landed"          LUCKY 7, a reel just landed
//   frames[11]    "win"             LUCKY 7, a resolved win, coins
//   frames[12]    "golfReady"       GOLF, loaded/title/intro skipped, ball at rest, ready to swing
//   frames[13]    "golfSwingImpact" GOLF, right after a swing (synthetic raw-accel samples) fires the shot
//   frames[14]    "backToLauncherFromGolf"  returned to launcher from GOLF (swipe exit)
//
// This exact order (and one of these two counts) is a contract with the
// trace file, not something this checker can discover on its own.
//
// Every threshold below was picked empirically against this port's own
// built module (`bun run packs/rp2350-touch-amoled-18/wasm/build.ts --app
// apps/gameos/ports/rp2350-touch-amoled-18/gameos_port.c`) replaying this
// exact trace, not guessed: the measured good-run numbers are quoted next
// to each threshold, and every one of the first five checks here was run
// red-before-green (see this bundle's own PR) by deliberately breaking
// this port's own glue code (never the vendored gunship.c/slots.c), the one
// behaviour it is meant to catch, confirming THIS check fails, then
// restoring and confirming green again. Invariants (6) and (7) below were
// added when GOLF shipped on the esp32 port and were themselves proven
// red-before-green against THAT port's own module and trace - see this
// bundle's esp32 port README, "What is real", for the specific break/
// restore each one caught.

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
// backToLauncher (after a full GUNSHIP session) must be bit-identical to
// launcher80 (before anything was ever played) - both are
// launcher_render()'s own deterministic output, and gosrt_
// reset_shell_palette()/gosrt_reset_aim_filters() (enter_launcher(),
// gameos_port.c) exist specifically to make that true. Measured good run:
// 0 differing pixels. MAX_RETURN_DIFF_PX = 0 is therefore the actual claim.
const MAX_RETURN_DIFF_PX = 0;

// (6) GOLF-only, esp32 port only (15-frame trace shape). A swing (driven
// entirely by synthetic raw-accel samples, decision 0003's stream sensor -
// see scripts/record-gameos-golf-trace.ts) must actually change the ball's
// on-screen state: golf.c's fire_shot() sets ball_vx/vy and, for a driver
// shot, air_time > 0, so the camera (update_camera() tracks G->ball_x/y)
// and the ball sprite itself move between golfReady (ball at rest,
// GST_READY, "Strokes 0") and golfSwingImpact (just after GST_ARMED ->
// fire_shot() -> GST_MOVING, "Strokes 1"). Measured good run: 148549px
// differ (out of 164864 total - nearly the whole panel: the camera itself
// pans to follow the struck ball). MIN_GOLF_SWING_DIFF_PX = 30000 sits well
// under that while still requiring a real change, not idle-animation
// noise - proven red-before-green by starving gos_hal_shim.c's
// hal_imu_accel_read() (returning 0 samples always), which stalls
// swing_poll() in SWING_WAIT forever: no backswing is ever detected, GOLF
// never leaves GST_ARMED, fire_shot() never runs, and golfSwingImpact reads
// as a near-static continuation of golfReady instead (measured: 0px).
const MIN_GOLF_SWING_DIFF_PX = 30000;

// (7) GOLF-only, esp32 port only. Exiting GOLF (top-edge swipe, the same
// gesture GUNSHIP/LUCKY 7 already use) must reproduce the exact prior
// launcher screen, the identical claim invariant (5) makes for GUNSHIP -
// GOLF's own enter_launcher() call path is the SAME dispatcher function
// (gameos_port.c), so this is really "does gos_gfx_direct565(false) (and
// the rest of enter_launcher()'s reset) actually undo GOLF's full-res
// direct mode", not a second implementation of the same idea.
const MAX_GOLF_RETURN_DIFF_PX = 0;

export function check(frames: TimedFrame[], meta: InvariantMeta): InvariantResult {
  const failures: string[] = [];

  if (frames.length !== 12 && frames.length !== 15) {
    return {
      pass: false,
      failures: [`expected exactly 12 (no GOLF) or 15 (with GOLF) captures per this trace's own contract, got ${frames.length}`],
    };
  }

  const [
    launcher16, launcher48, launcher80,
    briefing, missionStart, firing, wave,
    backToLauncher,
    idle, midSpin, landed, win,
    golfReady, golfSwingImpact, backToLauncherFromGolf,
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

  // GOLF, only present in the 15-frame (esp32) trace shape.
  if (frames.length === 15) {
    // (6) a swing (synthetic raw-accel samples) causes a real ball-state change
    const swingDiff = diffPixelCount(golfReady!.frame, golfSwingImpact!.frame);
    if (swingDiff < MIN_GOLF_SWING_DIFF_PX) {
      failures.push(`golf swing: only ${swingDiff}px differ between golfReady (t=${golfReady!.atMs}) and golfSwingImpact (t=${golfSwingImpact!.atMs}), min required ${MIN_GOLF_SWING_DIFF_PX}px - the swing does not appear to have armed and fired a shot`);
    }

    // (7) exiting GOLF reproduces the exact prior launcher screen
    const golfReturnDiff = diffPixelCount(launcher80!.frame, backToLauncherFromGolf!.frame);
    if (golfReturnDiff > MAX_GOLF_RETURN_DIFF_PX) {
      failures.push(`golf launcher exactness: backToLauncherFromGolf (t=${backToLauncherFromGolf!.atMs}) differs from launcher80 (t=${launcher80!.atMs}) by ${golfReturnDiff}px, expected ${MAX_GOLF_RETURN_DIFF_PX} (returning to the launcher from GOLF must reproduce it exactly - GOLF's own direct565 mode must be fully undone)`);
    }
  }

  return { pass: failures.length === 0, failures };
}
