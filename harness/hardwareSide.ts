// Replays a trace against real hardware, through whatever HardwareLink your
// adapter implements. Unlike the emulator side (emulatorSide.ts), this
// cannot be instant: real hardware runs on its own clock regardless of
// what a trace's recorded timestamps say, so this paces input events in
// real wall-clock time, at the same relative spacing they were originally
// recorded at, and hopes the board's own timing-sensitive behaviour (if
// any) lines up closely enough to be useful. See docs/harness.md for what
// this can and cannot prove.
//
// "tick" events in the trace are NOT sent to the hardware: emu_tick(nowMs)
// is an emulator-only concept (the module's synthetic clock). They are
// still used as pacing/capture-point anchors, since they're what the
// trace's own timestamps are built around.

import type { CapturedFrame, HardwareLink, TraceEvent } from "./types";

export interface HardwareReplayResult {
  frames: { atMs: number; frame: CapturedFrame }[];
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

export async function replayHardware(link: HardwareLink, events: TraceEvent[], capturePoints: number[]): Promise<HardwareReplayResult> {
  await link.connect();
  try {
    if (link.reset) await link.reset();

    const sortedPoints = [...capturePoints].sort((a, b) => a - b);
    const frames: HardwareReplayResult["frames"] = [];
    if (events.length === 0) {
      for (const p of sortedPoints) frames.push({ atMs: p, frame: await link.screenshot() });
      return { frames };
    }

    const wallStart = Date.now();
    const traceStart = events[0]!.t;
    let capIdx = 0;

    for (const ev of events) {
      const targetWall = wallStart + (ev.t - traceStart);
      await sleep(targetWall - Date.now());
      if (ev.k !== "tick") await link.send(ev);
      while (capIdx < sortedPoints.length && sortedPoints[capIdx]! <= ev.t) {
        frames.push({ atMs: sortedPoints[capIdx]!, frame: await link.screenshot() });
        capIdx++;
      }
    }
    while (capIdx < sortedPoints.length) {
      const targetWall = wallStart + (sortedPoints[capIdx]! - traceStart);
      await sleep(targetWall - Date.now());
      frames.push({ atMs: sortedPoints[capIdx]!, frame: await link.screenshot() });
      capIdx++;
    }
    return { frames };
  } finally {
    await link.disconnect();
  }
}
