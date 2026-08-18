#!/usr/bin/env bun
// Measures what screenshot pacing a real board actually tolerates, because
// the number matters more than any other single parameter of a differential
// run and guessing it has already rebooted this board twice.
//
// WHY THIS IS NOT A FOOTNOTE. A SHOT walks the whole framebuffer twice and
// writes the reply one character at a time from inside a single
// devlink_poll(), which is one step of the main loop that feeds the 4s
// watchdog (packs/rp2350-touch-amoled-18/firmware/runtime/runtime.c). The firmware caps one reply
// at DEVLINK_SHOT_BUDGET_US (750ms) and truncates past it - that bounds a
// single shot, and says nothing about a loop of them, or about what happens
// when the screen being captured does not compress. A differential run is by
// nature a lot of screenshots, so "how fast is safe" is a measurement this
// repo owes, not an assumption it gets to make.
//
// What this prints, per interval tried: the wall-clock cost of each shot,
// the RLE payload size, whether the firmware truncated it (the header's own
// byte count versus what arrived), and whether the board was still in the
// same app afterwards. A truncation or an app change is the failure; a slow
// shot is just a slow shot.
//
//   bun run harness:hardware:pacing              # default ladder
//   bun run harness:hardware:pacing 0 200 400    # explicit intervals, ms
//
// Environment: DEVLINK_PORT, DEVLINK_SERVER_URL, PUCK_HW_APP - see
// harness/links/devlinkLink.ts.

import { DevlinkLink } from "./links/devlinkLink";

const SHOTS_PER_INTERVAL = Number(process.env.PUCK_HW_PACING_SHOTS ?? "6");

const intervals = process.argv
  .slice(2)
  .map(Number)
  .filter((n) => Number.isFinite(n) && n >= 0);
const ladder = intervals.length > 0 ? intervals : [1000, 500, 250, 100, 0];

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2]! : Math.round((s[s.length / 2 - 1]! + s[s.length / 2]!) / 2);
}

const link = new DevlinkLink({ minShotIntervalMs: 0 });
await link.connect();
console.log(`connected over ${link.transport}`);

try {
  await link.reset();
  const app = await link.readApp();
  console.log(`board parked in app ${app.index} "${app.name}", panel ${link.panel.w}x${link.panel.h}`);
  console.log(`${SHOTS_PER_INTERVAL} shots per interval, watching for truncation and for the board changing app under us\n`);

  let firstFailure: number | null = null;

  for (const interval of ladder) {
    const costs: number[] = [];
    const payloads: number[] = [];
    let truncations = 0;
    let sawReset = false;

    for (let i = 0; i < SHOTS_PER_INTERVAL; i++) {
      if (interval > 0 && i > 0) await Bun.sleep(interval);
      const shot = await link.captureRaw();
      costs.push(shot.ms);
      payloads.push(shot.decodedBytes);
      if (shot.truncated) truncations++;
    }

    const after = await link.readApp();
    if (after.index !== app.index || after.name !== app.name) {
      sawReset = true;
    }

    const verdict = truncations > 0 || sawReset ? "FAIL" : "ok";
    console.log(
      `  gap ${String(interval).padStart(4)}ms  shot cost median ${String(median(costs)).padStart(4)}ms ` +
        `(min ${Math.min(...costs)}, max ${Math.max(...costs)})  payload ${median(payloads)} RLE bytes  ` +
        `truncated ${truncations}/${SHOTS_PER_INTERVAL}  ${sawReset ? "APP CHANGED " : ""}${verdict}`
    );
    if (verdict === "FAIL" && firstFailure === null) firstFailure = interval;
    if (sawReset) break; // the board is no longer the board we were measuring
  }

  if (link.resetEvidence.length > 0) {
    console.log(`\nreset/health evidence seen on the shared port:`);
    for (const e of link.resetEvidence) console.log(`  - ${e}`);
  }

  const worstCost = Math.max(...link.shots.map((s) => s.ms));
  console.log(
    `\n${link.shots.length} shots total, worst single shot ${worstCost}ms.` +
      (firstFailure === null
        ? ` No truncation and no app change at any interval tried, down to ${Math.min(...ladder)}ms.`
        : ` First failure at a ${firstFailure}ms gap.`)
  );
} finally {
  await link.disconnect();
}
