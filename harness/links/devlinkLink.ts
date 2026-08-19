// A REAL HardwareLink, over devlink, against the RP2350 board this repo's
// packs/rp2350-touch-amoled-18/ half is the firmware for. This is the file harness/types.ts left a
// seam for and docs/harness.md described in the abstract for months without
// anybody writing: everything under harness/ was built to compare an
// emulator against real hardware and had only ever been run against
// harness/fixtures/loopbackLink.ts, which is a second copy of the same wasm
// module and therefore proves nothing about a board.
//
// The transport is packs/rp2350-touch-amoled-18/tools/dev.ts's devlink protocol
// (packs/rp2350-touch-amoled-18/tools/README-devlink.md): one command per line over the board's USB
// CDC port, shared with the runtime's own debug prints. Nothing here
// reimplements that protocol - the port opening (DTR before Open(), the one
// gotcha most likely to make a first run look like a dead board), the
// line reader, the RLE decoder and the server-vs-direct arbitration are all
// imported from dev.ts, because two copies of a wire protocol agree exactly
// once, on the day the second is written (docs/decisions/0002).
//
// THREE THINGS THIS FILE EXISTS TO GET RIGHT, each of which has already cost
// this project a day or a reboot:
//
// 1. THE PORT IS EXCLUSIVE AND SOMETHING ELSE MAY OWN IT. The emulator's dev
//    server holds the port whenever it is running. So this link asks the
//    server first (openServerBridge, GET /api/devlink/status then a
//    WebSocket) and only opens the port itself when the server is not
//    holding one - the same arbitration dev.ts's own openBridge() does.
//    Opening the port directly while the server holds it does not "win": it
//    fails with an access-denied, and the run dies for a reason that has
//    nothing to do with the firmware under test.
//
// 2. SCREENSHOTS CAN REBOOT THE BOARD. A SHOT walks the whole framebuffer
//    twice and writes the result one character at a time inside a single
//    devlink_poll(), i.e. inside one iteration of the main loop that feeds
//    the 4s watchdog. Firmware caps one reply at DEVLINK_SHOT_BUDGET_US
//    (750ms) and then truncates, which bounds a single shot but says nothing
//    about a loop of them. A differential run is by nature a lot of
//    screenshots, so this file paces them (minShotIntervalMs, measured - see
//    harness/hardwarePacing.ts and docs/harness.md) and reports a truncated
//    payload as a truncation rather than as a corrupt image.
//
// 3. A REBOOTED BOARD MUST NOT BE DIFFED. If the board resets mid-run it
//    comes back in app 0 with a cleared arena, and every frame after that
//    point is a comparison against a different device state. Diffing that
//    and reporting "divergence" would be exactly the instrument that lies
//    (packs/rp2350-touch-amoled-18/docs/decisions/0004). So every capture is bracketed by an APP
//    query, and every line of shared-port noise this file reads on its way
//    to a reply is checked for the profiler's own cumulative counters going
//    backwards. Either one aborts the run with what was seen.
//
// Usage (see package.json's harness:hardware):
//   bun run harness/diff.ts <trace.json> --link harness/links/devlinkLink.ts
//
// TWO BOARDS, ONE ADAPTER. This was written for the RP2350 pack and now
// also drives packs/esp32-s3-touch-amoled-18, which implements the same
// devlink wire protocol over its native USB Serial/JTAG port (see that
// pack's docs/decisions/0002-devlink-over-usb-serial-jtag.md). Nothing here
// is per-board except what the environment variables below select: the
// port, and whether opening it asserts DTR. Everything device-specific
// stayed in the firmware, which is the arrangement that makes a second
// board cost one env var rather than a second link.
//
// Environment:
//   DEVLINK_PORT        serial port (default COM4, read by dev.ts). The
//                       ESP32-S3 board is on its own port; name it here.
//   DEVLINK_DTR         "0" to open the port WITHOUT asserting DTR. Required
//                       for the ESP32-S3 board, whose USB Serial/JTAG
//                       peripheral wires DTR to the chip's own boot strap;
//                       leave it alone (default "1") for the RP2350, whose
//                       USB CDC stack needs DTR to answer at all.
//   DEVLINK_SERVER_URL  emulator dev server (default http://127.0.0.1:5330)
//   PUCK_HW_APP         app index to reset into before replay (default 0,
//                       the index rtcore_init() itself boots into)
//   PUCK_HW_SHOT_MIN_MS minimum gap between screenshots, ms (default 250,
//                       measured - see DEFAULT_SHOT_MIN_MS below)
//   PUCK_HW_APP_TRACKING "strict" (default: any app change aborts the run,
//                       the strongest reset detector this device offers) or
//                       "follow" (for a trace that switches apps itself)
//   PUCK_HW_RESTORE_APP "0" to leave the board in whatever app the trace
//                       ended in instead of putting it back

import {
  decodeRLE,
  isBase64Line,
  openDirectBridge,
  openServerBridge,
  readLineWithTimeout,
  type Bridge,
} from "../../packs/rp2350-touch-amoled-18/tools/dev";
import type { CapturedFrame, HardwareLink, TraceEvent } from "../types";

// Measured, not guessed: 60 consecutive screenshots at a ZERO gap, across
// two different screens, produced no truncation, no watchdog reboot and no
// app change (harness/hardwarePacing.ts, numbers in docs/harness.md). This
// ships at 250ms anyway, as margin on somebody else's board, and because a
// single shot already costs 280-600ms so the margin barely shows in a run.
// Override with PUCK_HW_SHOT_MIN_MS.
export const DEFAULT_SHOT_MIN_MS = 250;

export interface DevlinkLinkOptions {
  // Which g_apps[] index to put the board into before replay starts. The
  // emulator side always starts from emu_init(), which is rtcore_init(),
  // which enters app 0 - so 0 is the only value that makes the two sides
  // start alike unless your trace switches apps itself.
  appIndex: number;
  // Minimum wall-clock gap between the END of one screenshot and the start
  // of the next. See docs/harness.md for what was measured.
  minShotIntervalMs: number;
  // Put the board back in whatever app it was running when we connected.
  // Politeness, not correctness: the owner uses this board.
  restoreApp: boolean;
  // How to read "the app changed under us".
  //
  //   "strict" - the board must stay in the app reset() put it in, and any
  //     change aborts the run. This is the strongest reset detector this
  //     device offers (a reset re-enters app 0 with a zeroed arena) and it
  //     is the default, which is also why the trace this repo ships as its
  //     hardware smoke test deliberately does not switch apps.
  //   "follow" - for a trace that drives an app switch itself (the menu
  //     chord and a tap on an icon). Transitions are recorded and printed
  //     rather than treated as failures. Reset detection is genuinely
  //     WEAKER here and the docs say so: what backs it up instead is the
  //     comparison itself, since a board that reset would be showing app 0
  //     while the emulator side shows whatever the trace navigated to, and
  //     that is not a subtle diff.
  appTracking: "strict" | "follow";
}

export function optionsFromEnv(): DevlinkLinkOptions {
  const appIndex = Number(process.env.PUCK_HW_APP ?? "0");
  const minShotIntervalMs = Number(process.env.PUCK_HW_SHOT_MIN_MS ?? String(DEFAULT_SHOT_MIN_MS));
  return {
    appIndex: Number.isFinite(appIndex) ? appIndex : 0,
    minShotIntervalMs: Number.isFinite(minShotIntervalMs) ? minShotIntervalMs : DEFAULT_SHOT_MIN_MS,
    restoreApp: process.env.PUCK_HW_RESTORE_APP !== "0",
    appTracking: process.env.PUCK_HW_APP_TRACKING === "follow" ? "follow" : "strict",
  };
}

export class BoardResetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BoardResetError";
  }
}

export class ShotTruncatedError extends Error {
  readonly headerBytes: number;
  readonly decodedBytes: number;
  constructor(headerBytes: number, decodedBytes: number) {
    super(
      `SHOT truncated: header promised ${headerBytes} RLE bytes, ${decodedBytes} arrived. The firmware caps one reply at ` +
        `DEVLINK_SHOT_BUDGET_US (750ms) and drops the rest of the body rather than starving the watchdog, so this means the ` +
        `screen being captured does not RLE-compress small enough to leave the board inside that budget at this baud rate. ` +
        `See docs/harness.md's pacing section.`
    );
    this.name = "ShotTruncatedError";
    this.headerBytes = headerBytes;
    this.decodedBytes = decodedBytes;
  }
}

export interface RawShot {
  width: number;
  height: number;
  headerBytes: number;
  decodedBytes: number;
  truncated: boolean;
  // One byte per pixel, row-major: the panel's own 6-bit green channel
  // shifted up by two (packs/rp2350-touch-amoled-18/firmware/runtime/gfx.h's px_to_gray). null
  // when the payload was truncated.
  grey: Uint8Array | null;
  // Wall-clock cost of the whole exchange, command written to END read.
  ms: number;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

// The exact inverse of the panel's own packing, not a naive byte-to-grey
// expansion, so a neutral pixel decodes to EXACTLY the RGB triple the
// emulator side produces for the same framebuffer word and a matching frame
// matches at tolerance 0.
//
// The board stores RGB565 (byte-swapped for the panel DMA). gfx.h's
// gray_to_px(g) writes r5 = g>>3, g6 = g>>2, b5 = g>>3, and SHOT sends
// px_to_gray(px) = g6<<2, i.e. one byte carrying the six bits of green.
// src/panel.ts's rgb565be reader expands those stored fields back with bit
// replication: r8 = (r5<<3)|(r5>>2), g8 = (g6<<2)|(g6>>4). So from the SHOT
// byte alone, both fields are recoverable exactly: g6 is byte>>2, and r5/b5
// are byte>>3.
//
// WHAT THIS CANNOT RECOVER, stated here rather than discovered as a mystery
// diff: colour. SHOT's wire format is one greyscale byte per pixel because
// this panel is used as monochrome, so a coloured pixel (the sketchpad's
// palette, apps/sketch.c's tint_to_px, or runtime.c's red core1-dead screen)
// arrives as its green channel and comes back out of this function as a
// grey. Against an emulator frame that kept the colour, that is a real
// divergence in the DIFF and not one in the FIRMWARE. Do not point this
// harness at a coloured screen and believe the number.
export function greyToRGB(grey: Uint8Array, width: number, height: number): CapturedFrame {
  const rgb = new Uint8Array(width * height * 3);
  for (let i = 0, p = 0; i < width * height; i++, p += 3) {
    const v = grey[i]!;
    const g6 = v >> 2;
    const c5 = v >> 3;
    const g8 = (g6 << 2) | (g6 >> 4);
    const rb8 = (c5 << 3) | (c5 >> 2);
    rgb[p] = rb8;
    rgb[p + 1] = g8;
    rgb[p + 2] = rb8;
  }
  return { width, height, rgb };
}

// The shared port's profiler line, from whichever board is on the other end.
//
// THIS USED TO REQUIRE THE RP2350'S EXACT FIELD LIST and therefore silently
// stopped detecting resets the moment a second board spoke devlink. The
// ESP32-S3 pack (packs/esp32-s3-touch-amoled-18) has no second core to
// restart, so it prints `uptime=` instead of `core1restarts=`; under the old
// regex its profiler line matched nothing at all, which is not "no evidence"
// but "the evidence was thrown away". So the app name is the only required
// field now, and every cumulative counter is optional and checked only when
// BOTH readings carry it. The RP2350's own lines still match every field
// they always did, so nothing about that board's detection changed.
const PROF_APP_RE = /^prof app=(\S+)\b/;

// Counters that only ever climb while a board stays up, so any of them
// going backwards is a reboot seen for free. `uptime` is the strongest of
// the three (it moves on every reset, not only on a core dying) and is what
// the ESP32-S3 pack reports.
const PROF_CUMULATIVE: Record<string, RegExp> = {
  core1restarts: /\bcore1restarts=(\d+)\b/,
  "shot drops": /\bshot drops=(\d+)\b/,
  uptime: /\buptime=(\d+)\b/,
};

interface ProfReading {
  app: string;
  counters: Record<string, number>;
}

function parseProf(line: string): ProfReading | null {
  const m = PROF_APP_RE.exec(line);
  if (!m) return null;
  const counters: Record<string, number> = {};
  for (const [name, re] of Object.entries(PROF_CUMULATIVE)) {
    const f = re.exec(line);
    if (f) counters[name] = Number(f[1]);
  }
  return { app: m[1]!, counters };
}

export class DevlinkLink implements HardwareLink {
  readonly opts: DevlinkLinkOptions;

  private bridge: Bridge | null = null;
  private route: "server" | "direct" | null = null;
  private panelW = 0;
  private panelH = 0;
  private appOnConnect: { index: number; name: string } | null = null;
  private expectedApp: { index: number; name: string } | null = null;
  private fingerDown = false;
  private lastShotEndedAt = 0;
  private lastProf: ProfReading | null = null;

  // Everything this link noticed that says the board is not the same device
  // it was a moment ago. Non-empty means the run is void, not divergent.
  readonly resetEvidence: string[] = [];
  // Every app change observed at a capture point, in order. Only ever
  // populated in "follow" tracking mode; in "strict" mode the first one
  // aborts the run instead.
  readonly appTransitions: string[] = [];
  // Bookkeeping the pacing probe and the run summary read back.
  readonly shots: RawShot[] = [];

  constructor(opts: Partial<DevlinkLinkOptions> = {}) {
    this.opts = { ...optionsFromEnv(), ...opts };
  }

  get transport(): string {
    return this.route === "server"
      ? `the emulator dev server at ${process.env.DEVLINK_SERVER_URL ?? "http://127.0.0.1:5330"} (it owns the port)`
      : `${process.env.DEVLINK_PORT ?? "COM4"} directly (no dev server holding the port)`;
  }

  get panel(): { w: number; h: number } {
    return { w: this.panelW, h: this.panelH };
  }

  async connect(): Promise<void> {
    const port = process.env.DEVLINK_PORT ?? "COM4";
    // Same arbitration as dev.ts's own openBridge(): the dev server first
    // (fast to rule out - an unreachable 127.0.0.1 port fails in
    // milliseconds under Bun), the port itself only if nothing else holds
    // it. Never the port first: that races the server for an exclusive
    // handle and loses for a reason unrelated to what is being tested.
    let bridge = await openServerBridge();
    if (bridge) {
      this.route = "server";
    } else {
      try {
        bridge = await openDirectBridge();
      } catch (err) {
        throw new Error(
          `no board: could not reach ${port}. The emulator dev server is not holding a port either, and opening it ` +
            `directly failed with: ${err instanceof Error ? err.message : String(err)}. ` +
            `Set DEVLINK_PORT if the board is on a different port, or DEVLINK_SERVER_URL if the dev server is elsewhere.`
        );
      }
      this.route = "direct";
    }
    this.bridge = bridge;

    // PING before anything else: it is the one command that proves the
    // transport works AND tells us the panel geometry to decode SHOT
    // against. A bounded failure here, with the route named, is the
    // difference between "no board" and a hang.
    let ping: string;
    try {
      ping = await this.expect(/^(OK devlink \d+ \d+ \d+|ERR .*)$/, 3000, "PING reply", "PING");
    } catch (err) {
      await this.closeBridge();
      const msg = err instanceof Error ? err.message : String(err);
      // Two genuinely different failures, kept apart because they send you
      // to different places. openDirectBridge() only waits 300ms to see
      // whether its PowerShell child survived, and PowerShell can take
      // longer than that just to start, so a port that does not exist (or
      // is held by something else) often gets past that check and shows up
      // here as an EOF instead of an open failure.
      throw new Error(
        /bridge closed the connection/.test(msg)
          ? `no board: the devlink bridge for ${port} closed before answering PING. The serial bridge process exited, ` +
            `which means the port does not exist or another process is holding it - its own stderr, relayed above, ` +
            `carries the OS's wording. Set DEVLINK_PORT if the board is elsewhere.`
          : `no board answered devlink on ${this.transport}: ${msg}. The port is open and nothing closed it, so something ` +
            `is there, but nothing spoke devlink within 3s - a board running non-devlink firmware, a board mid-reboot, ` +
            `or another client draining the replies.`
      );
    }
    const m = /^OK devlink (\d+) (\d+) (\d+)$/.exec(ping);
    if (!m) {
      await this.closeBridge();
      throw new Error(`devlink refused PING: ${ping}`);
    }
    this.panelW = Number(m[2]);
    this.panelH = Number(m[3]);

    this.appOnConnect = await this.readApp();
    this.expectedApp = this.appOnConnect;
  }

  async disconnect(): Promise<void> {
    if (!this.bridge) return;
    // Said out loud rather than only kept in a field: in "follow" mode
    // these transitions are the run's only account of which app each frame
    // was actually captured from.
    if (this.appTransitions.length > 0) {
      console.log(`  app changed during the run: ${this.appTransitions.join(", ")}`);
    }
    // Safety first, before anything that can throw: an aborted run must not
    // leave PWR injected-held (runtime_core.c powers the board off after 5s
    // of it) or BOOT injected-held (sensors.c's injected level is sticky -
    // it is OR'd on top of the real read and only cleared by BOOT UP, so a
    // crash between "BOOT DOWN" and "BOOT UP" would leave the owner's board
    // behaving as if a button were welded down).
    await this.tryCommand("KEY RELEASE");
    await this.tryCommand("BOOT UP");
    // Same class of safety as the two above, and missing until a trace that
    // deliberately ENDS with the finger still down went through this link:
    // an injected touch is as sticky as an injected button, so a run that
    // never sends UP (or that dies partway through a stroke) left the
    // owner's board behaving as if a finger were glued to the glass.
    if (this.fingerDown) {
      await this.tryCommand("UP");
      this.fingerDown = false;
    }
    if (this.opts.restoreApp && this.appOnConnect && this.expectedApp && this.appOnConnect.index !== this.expectedApp.index) {
      if (this.appOnConnect.index >= 0) await this.tryCommand(`SWITCH ${this.appOnConnect.index}`);
    }
    await this.closeBridge();
  }

  // Establishes a known starting point, which is the whole reason
  // HardwareLink has this method: the emulator always starts from
  // emu_init(), and the board starts from wherever the last person left it.
  //
  // SWITCH is the lever, because on this device a switch is not just a
  // change of screen: runtime_core.c's do_switch() rewinds the app arena and
  // app_alloc() zeroes every byte it hands back out, and the runtime clears
  // the framebuffer on the way in. So "SWITCH to app 0" reproduces, on
  // hardware, very nearly what emu_init() does on the emulator side - a
  // freshly entered app 0 with zeroed state on a cleared panel.
  //
  // "Very nearly" is doing real work in that sentence, and the gap is
  // stated in docs/harness.md rather than papered over: a switch does not
  // re-run gfx_init(), does not restart core1, does not reset the board's
  // uptime clock, and does not undo any peripheral state the previous app
  // left behind.
  async reset(): Promise<void> {
    const target = this.opts.appIndex;
    await this.expect(/^(OK|ERR .*)$/, 3000, "SWITCH reply", `SWITCH ${target}`, (line) => {
      if (line.startsWith("ERR")) {
        throw new Error(
          `SWITCH ${target} was refused (${line}). Valid indices are g_apps[] positions on the RUNNING firmware; ` +
            `PUCK_HW_APP selects one.`
        );
      }
    });

    // The switch is applied at the end of the current frame, so APP can
    // still report the old app for a frame or two. Poll rather than sleep a
    // guessed amount.
    const deadline = Date.now() + 2000;
    for (;;) {
      const app = await this.readApp();
      if (app.index === target) {
        this.expectedApp = app;
        break;
      }
      if (Date.now() > deadline) {
        throw new Error(`the board did not enter app ${target} within 2s (still reporting ${app.index} ${app.name})`);
      }
      await sleep(50);
    }
    // One full-panel push costs about 12ms (gfx.h); this is slack on top of
    // it so the first capture cannot race the switch's own repaint.
    await sleep(200);
  }

  async send(event: TraceEvent): Promise<void> {
    for (const cmd of this.commandsFor(event)) {
      await this.expect(/^(OK|ERR .*)$/, 3000, `${cmd.split(" ")[0]} reply`, cmd, (line) => {
        if (line.startsWith("ERR")) throw new Error(`devlink refused "${cmd}": ${line}`);
      });
    }
  }

  // The trace-event -> devlink mapping, in one place and total: an event
  // this link cannot deliver throws instead of being quietly skipped. A
  // silently dropped input would make the hardware side replay a DIFFERENT
  // trace from the emulator side and then report the resulting mismatch as
  // a firmware divergence, which is the shape of instrument failure
  // packs/rp2350-touch-amoled-18/docs/decisions/0004 is about.
  //
  // Button indices are the ones emu_shim.c declares and firmware/runtime
  // agrees with: 0 = BOOT, 1 = PWR. Sensor 0 is "shake", the only sensor
  // emu_device() declares.
  commandsFor(event: TraceEvent): string[] {
    switch (event.k) {
      case "touch": {
        if (event.down) {
          const cmd = this.fingerDown ? `MOVE ${event.x} ${event.y}` : `DOWN ${event.x} ${event.y}`;
          this.fingerDown = true;
          return [cmd];
        }
        this.fingerDown = false;
        return ["UP"];
      }
      case "button":
        if (event.i === 0) return [event.down ? "BOOT DOWN" : "BOOT UP"];
        if (event.i === 1) return [event.down ? "KEY PRESS" : "KEY RELEASE"];
        throw new Error(`no devlink command for button index ${event.i} (this device declares 0 = BOOT, 1 = PWR)`);
      case "verdict":
        if (event.i === 1) return [event.long ? "KEY LONG" : "KEY SHORT"];
        throw new Error(
          `no devlink command for a press verdict on button index ${event.i} (only PWR, index 1, declares longPressMs)`
        );
      case "sensor":
        if (event.i === 0) return ["ERASE"];
        throw new Error(`no devlink command for sensor index ${event.i} (this device declares exactly one, 0 = shake)`);
      case "vector":
        // No devlink command exists to inject a continuous vector sensor
        // reading onto real hardware (this pack's own firmware.runtime/
        // sensors.c is not wired for it either - see
        // apps/fluidbox/ports/rp2350-touch-amoled-18/README.md's "The
        // missing ABI call" section). Per this function's own header
        // comment, an event this link cannot deliver throws rather than
        // being silently dropped.
        throw new Error(`no devlink command for a vector sensor event (index ${event.i}): real-hardware tilt injection is not wired`);
      case "tick":
        // Never sent: emu_tick(nowMs) is the emulator's synthetic clock and
        // has no hardware equivalent. harness/hardwareSide.ts already
        // filters these out; this arm exists so the switch is total.
        return [];
    }
  }

  async screenshot(): Promise<CapturedFrame> {
    const raw = await this.captureRaw();
    if (!raw.grey) throw new ShotTruncatedError(raw.headerBytes, raw.decodedBytes);
    await this.assertStillTheSameBoard();
    return greyToRGB(raw.grey, raw.width, raw.height);
  }

  // The screenshot, without the throw-on-truncation and without the reset
  // check, so harness/hardwarePacing.ts can measure what a shot costs and
  // how often it truncates without the measurement aborting on the first
  // bad one.
  async captureRaw(): Promise<RawShot> {
    const wait = this.lastShotEndedAt + this.opts.minShotIntervalMs - Date.now();
    if (wait > 0) await sleep(wait);

    const started = Date.now();
    const header = await this.expect(/^(SHOT \d+ \d+ \d+|ERR .*)$/, 8000, "SHOT header", "SHOT");
    const m = /^SHOT (\d+) (\d+) (\d+)$/.exec(header);
    if (!m) throw new Error(`devlink refused SHOT: ${header}`);
    const width = Number(m[1]);
    const height = Number(m[2]);
    const headerBytes = Number(m[3]);

    let b64 = "";
    for (;;) {
      const line = await readLineWithTimeout(this.lines(), 8000, "SHOT body");
      if (line === "END") break;
      if (!isBase64Line(line)) {
        this.observeNoise(line);
        continue;
      }
      b64 += line;
    }
    const rle = new Uint8Array(Buffer.from(b64, "base64"));
    const ms = Date.now() - started;
    this.lastShotEndedAt = Date.now();

    const truncated = rle.length !== headerBytes;
    let grey: Uint8Array | null = null;
    if (!truncated) {
      try {
        grey = decodeRLE(rle, width, height);
      } catch {
        grey = null;
      }
    }
    const shot: RawShot = { width, height, headerBytes, decodedBytes: rle.length, truncated: grey === null, grey, ms };
    this.shots.push(shot);
    return shot;
  }

  // ---- reset detection -------------------------------------------------
  //
  // Two independent readings, both over devlink, because the run has to be
  // able to say "this comparison is void" rather than diff against a board
  // that rebooted into a different app halfway through.
  //
  //   1. WHICH APP IS RUNNING. A reset re-enters g_apps[0] with a zeroed
  //      arena (rtcore_init()). If the board is not in the app this link
  //      put it in, it is not the same session any more. This is the
  //      strongest signal and it is why reset() deliberately parks the
  //      board somewhere known first.
  //   2. THE PROFILER'S CUMULATIVE COUNTERS GOING BACKWARDS. This firmware's
  //      prof line has no absolute uptime field (loops= and core1= are
  //      per-second rates, not totals), but `core1restarts=` and
  //      `shot drops=` are cumulative from boot. Either one decreasing is a
  //      reboot, seen for free: these lines share the port and this link
  //      already reads past them on its way to every reply.
  private observeNoise(line: string): void {
    const prof = parseProf(line);
    if (!prof) return;
    const prev = this.lastProf;
    if (prev) {
      for (const [name, value] of Object.entries(prof.counters)) {
        const before = prev.counters[name];
        if (before === undefined) continue;
        if (value < before) {
          this.resetEvidence.push(
            `the profiler's cumulative "${name}" went backwards (${before} -> ${value}): the board rebooted`
          );
        }
        if (name === "shot drops" && value > before) {
          this.resetEvidence.push(
            `the firmware dropped a SHOT body (shot drops ${before} -> ${value}): a screenshot ran past the firmware's ` +
              `own reply budget, so screenshots are being asked for faster or on a busier screen than this board can serve`
          );
        }
      }
    }
    if (this.opts.appTracking === "strict" && this.expectedApp && prof.app !== this.expectedApp.name) {
      this.resetEvidence.push(
        `the profiler reports app=${prof.app} while this run put the board in "${this.expectedApp.name}": ` +
          `the board reset (a reset re-enters app 0) or something else switched apps under the run`
      );
    }
    this.lastProf = prof;
  }

  private async assertStillTheSameBoard(): Promise<void> {
    const app = await this.readApp();
    const was = this.expectedApp;
    const changed = was !== null && (app.index !== was.index || app.name !== was.name);
    if (changed && this.opts.appTracking === "follow") {
      this.appTransitions.push(`${was.index} "${was.name}" -> ${app.index} "${app.name}"`);
      this.expectedApp = app;
      return;
    }
    if (changed) {
      throw new BoardResetError(
        `the board is now running app ${app.index} "${app.name}", but this run put it in ${was.index} ` +
          `"${was.name}". A reset re-enters app 0 with a zeroed arena, so every frame from here on would be a ` +
          `comparison against a different device state. Aborting instead of reporting a divergence.`
      );
    }
    if (this.resetEvidence.length > 0) {
      throw new BoardResetError(`the board did not stay put during this run:\n  - ${this.resetEvidence.join("\n  - ")}`);
    }
  }

  async readApp(): Promise<{ index: number; name: string }> {
    const reply = await this.expect(/^(APP -?\d+ \S+|ERR .*)$/, 3000, "APP reply", "APP");
    const m = /^APP (-?\d+) (\S+)$/.exec(reply);
    if (!m) throw new Error(`devlink refused APP: ${reply}`);
    return { index: Number(m[1]), name: m[2]! };
  }

  // ---- plumbing --------------------------------------------------------

  private lines() {
    if (!this.bridge) throw new Error("devlink link used before connect()");
    return this.bridge.lines;
  }

  // Sends a command (optionally) and reads until a line matching `shape`
  // arrives, feeding everything else to observeNoise(). This is dev.ts's
  // expectLine() with one addition: the noise is looked at rather than only
  // discarded, because on this port the noise is the profiler line, and the
  // profiler line is what says whether the board is still the same board.
  private async expect(
    shape: RegExp,
    timeoutMs: number,
    what: string,
    cmd?: string,
    onReply?: (line: string) => void
  ): Promise<string> {
    if (!this.bridge) throw new Error("devlink link used before connect()");
    if (cmd) await this.bridge.send(cmd);
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        throw new Error(`no ${what} within ${timeoutMs}ms on ${this.transport}`);
      }
      const line = await readLineWithTimeout(this.lines(), remaining, what);
      if (shape.test(line)) {
        onReply?.(line);
        return line;
      }
      this.observeNoise(line);
    }
  }

  private async tryCommand(cmd: string): Promise<void> {
    try {
      await this.expect(/^(OK|ERR .*)$/, 2000, `${cmd} reply`, cmd);
    } catch {
      // Best effort: this runs in disconnect(), where the interesting error
      // is whatever already went wrong, not this one.
    }
  }

  private async closeBridge(): Promise<void> {
    const b = this.bridge;
    this.bridge = null;
    if (b) await b.close();
  }
}

// harness/diff.ts's --link contract: a default export taking no arguments.
export default function makeDevlinkLink(): HardwareLink {
  return new DevlinkLink();
}
