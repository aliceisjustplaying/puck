#!/usr/bin/env bun
// The pack's gate: fast, hardware-free, device-specific checks.
//
// `bun run pack:esp32:gate` from the repository root.
//
// WHAT BELONGS HERE, AND WHY THIS PACK NEEDED ONE. The repository root's
// `bun run typecheck` / `bun run verify` already cover the instrument, and
// `bun run verify-bundle` covers an app's ports. None of them look at this
// pack's own two-target arrangement: one set of portable C compiled BOTH to
// wasm32-freestanding and to an ESP32-S3, against a platform seam each
// target has to satisfy separately. That seam is exactly where this pack's
// first real flash found a defect that had been sitting in the tree
// untouched since the file was written (docs/decisions/0001): two of the
// four host-provided functions were never implemented for the board at all,
// and nothing noticed because nothing had ever linked the board half.
//
// So every check below is one this pack can get wrong on its own, and each
// costs milliseconds. Nothing here needs a board, a toolchain, or a build:
// a check that needs ESP-IDF installed is not a gate, it is the build.
//
// Each check was shown RED before it was shown green, by breaking the thing
// it checks - see this pack's README.md, "The gate", for the exact
// breakages and what each one printed.

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";

const PACK = resolve(import.meta.dir, "..");
const FIRMWARE = join(PACK, "firmware");
const RUNTIME = join(FIRMWARE, "runtime");

interface Check {
  name: string;
  run(): string | null; // null = pass, a string = why it failed
}

function read(path: string): string {
  return readFileSync(path, "utf8");
}

function cFilesIn(dir: string): string[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith(".c"))
    .map((f) => join(dir, f));
}

// Strips /* */ and // comments so a symbol named in prose is never mistaken
// for a declaration or a definition. Without this every check below could be
// satisfied by a comment, which is the opposite of a gate.
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, " ");
}

// Every function name declared (`... name(...);`) in a header.
function declaredFunctions(header: string): string[] {
  const src = stripComments(header);
  const names: string[] = [];
  const re = /(?:^|\n)\s*(?:const\s+)?[A-Za-z_][A-Za-z0-9_]*\s+\**([a-z_][A-Za-z0-9_]*)\s*\([^;{]*\)\s*;/g;
  for (let m = re.exec(src); m; m = re.exec(src)) names.push(m[1]!);
  return [...new Set(names)];
}

// Whether a translation unit DEFINES `name` (a body, not a declaration).
function definesFunction(src: string, name: string): boolean {
  const stripped = stripComments(src);
  const re = new RegExp(`[A-Za-z_][A-Za-z0-9_]*\\s+\\**${name}\\s*\\([^;{]*\\)\\s*\\{`);
  return re.test(stripped);
}

function defineValue(src: string, name: string): number | null {
  const m = new RegExp(`#define\\s+${name}\\s+(\\d+)`).exec(src);
  return m ? Number(m[1]) : null;
}

/* ---------------------------------------------------------------------
 * 1. The platform seam is implemented by BOTH targets.
 *
 * Derived, not listed: the seam is whatever runtime_core.h declares that
 * runtime_core.c does not define. A hook added to the header later is
 * therefore covered by this check on the day it is added, with no edit
 * here - which matters, because a hardcoded list of four names would have
 * been just as blind to a fifth as the original defect was to two.
 * ------------------------------------------------------------------- */
const platformSeam: Check = {
  name: "the platform seam is implemented for the board AND for wasm",
  run() {
    const header = read(join(RUNTIME, "runtime_core.h"));
    const core = read(join(RUNTIME, "runtime_core.c"));
    const seam = declaredFunctions(header).filter((n) => !definesFunction(core, n));
    if (seam.length === 0) {
      return `no host-provided functions found in runtime_core.h: this check has stopped checking anything`;
    }

    const boardSources = [...cFilesIn(join(FIRMWARE, "main")), join(FIRMWARE, "devlink.c")];
    const board = boardSources.map(read).join("\n");
    const wasm = read(join(PACK, "wasm", "emu_shim.c"));

    const missingBoard = seam.filter((n) => !definesFunction(board, n));
    const missingWasm = seam.filter((n) => !definesFunction(wasm, n));
    if (missingBoard.length === 0 && missingWasm.length === 0) return null;
    const parts: string[] = [];
    if (missingBoard.length > 0) {
      parts.push(`the board half (firmware/main/, firmware/devlink.c) does not implement: ${missingBoard.join(", ")}`);
    }
    if (missingWasm.length > 0) {
      parts.push(`wasm/emu_shim.c does not implement: ${missingWasm.join(", ")}`);
    }
    return (
      `${parts.join("; ")}. runtime_core.h declares these as host-provided, so every target has to supply them: ` +
      `${seam.join(", ")}.`
    );
  },
};

/* ---------------------------------------------------------------------
 * 2. device.json and emu_device()'s JSON agree on every ABI field.
 *
 * AGENTS.md states this as a rule for a human to follow when either side
 * changes. This is that rule, enforced. `convention` and `memory` are pack
 * metadata rather than wire ABI and deliberately live only in device.json.
 * ------------------------------------------------------------------- */
const deviceDescriptorMatches: Check = {
  name: "device.json matches emu_device()'s JSON on every ABI field",
  run() {
    const shim = read(join(PACK, "wasm", "emu_shim.c"));
    const m = /g_deviceJson\[\]\s*=([\s\S]*?);\s*\n/.exec(shim);
    if (!m) return "could not find g_deviceJson[] in wasm/emu_shim.c";
    const literal = [...m[1]!.matchAll(/"((?:[^"\\]|\\.)*)"/g)]
      .map((q) => q[1]!)
      .join("")
      .replace(/\\"/g, '"')
      .replace(/\\\\/g, "\\");
    let fromShim: Record<string, unknown>;
    try {
      fromShim = JSON.parse(literal) as Record<string, unknown>;
    } catch (err) {
      return `emu_device()'s JSON does not parse: ${err instanceof Error ? err.message : String(err)}`;
    }

    const declared = JSON.parse(read(join(PACK, "device.json"))) as Record<string, unknown>;
    const abiFields = ["name", "panel", "buttons", "touch", "sensors"];
    const differences = abiFields.filter(
      (k) => JSON.stringify(declared[k]) !== JSON.stringify(fromShim[k])
    );
    if (differences.length === 0) return null;
    return differences
      .map((k) => `"${k}": device.json has ${JSON.stringify(declared[k])}, emu_device() has ${JSON.stringify(fromShim[k])}`)
      .join("; ");
  },
};

/* ---------------------------------------------------------------------
 * 3. The band geometry in C and the one device.json advertises are the
 *    same geometry.
 *
 * device.json's "memory" block is this pack's declared identity (AGENTS.md:
 * 16 bands of 28 rows, 20KB each, double-buffered). A change to BAND_ROWS
 * that leaves that block alone would make the pack's own documentation
 * quietly wrong about the one thing it is for.
 * ------------------------------------------------------------------- */
const bandGeometry: Check = {
  name: "the band geometry in runtime_core.h is the one device.json declares",
  run() {
    const header = read(join(RUNTIME, "runtime_core.h"));
    const w = defineValue(header, "PANEL_W");
    const h = defineValue(header, "PANEL_H");
    const rows = defineValue(header, "BAND_ROWS");
    if (w === null || h === null || rows === null) {
      return "PANEL_W / PANEL_H / BAND_ROWS are not all plain #defines in runtime_core.h any more";
    }
    if (h % rows !== 0) {
      return `PANEL_H (${h}) is not a whole number of BAND_ROWS (${rows}): the last band would run past the panel`;
    }
    const device = JSON.parse(read(join(PACK, "device.json"))) as {
      panel: { w: number; h: number };
      memory: { model: string; bands: number; bandRows: number; bandBufferKB: number; doubleBuffered: boolean };
    };
    const problems: string[] = [];
    if (device.panel.w !== w || device.panel.h !== h) {
      problems.push(`device.json's panel is ${device.panel.w}x${device.panel.h}, the C says ${w}x${h}`);
    }
    if (device.memory.bandRows !== rows) {
      problems.push(`device.json says ${device.memory.bandRows} rows per band, the C says ${rows}`);
    }
    if (device.memory.bands !== h / rows) {
      problems.push(`device.json says ${device.memory.bands} bands, the C's geometry gives ${h / rows}`);
    }
    const kb = Math.round((w * rows * 2) / 1024);
    if (device.memory.bandBufferKB !== kb) {
      problems.push(`device.json says a ${device.memory.bandBufferKB}KB band buffer, the C's geometry gives ${kb}KB`);
    }
    return problems.length === 0 ? null : problems.join("; ");
  },
};

/* ---------------------------------------------------------------------
 * 4. Nothing in this pack's firmware keeps a full panel of PIXELS.
 *
 * The one claim this pack exists to make. devlink's screenshot capture
 * (main/display.c) is a full panel of 8-bit GREY, which is why this looks
 * for the pixel type specifically rather than for the size: the question is
 * never "is there a big buffer", it is "is anything drawing into a whole
 * frame instead of into a band". See docs/decisions/0002.
 * ------------------------------------------------------------------- */
const noFramebuffer: Check = {
  name: "no full-panel pixel buffer exists in the firmware",
  run() {
    const sources = [...cFilesIn(join(FIRMWARE, "main")), ...cFilesIn(RUNTIME), join(FIRMWARE, "devlink.c")];
    const offenders: string[] = [];
    for (const path of sources) {
      const src = stripComments(read(path));
      for (const line of src.split("\n")) {
        if (!/PANEL_W\s*\*\s*PANEL_H/.test(line)) continue;
        if (/uint16_t|uint32_t/.test(line)) {
          offenders.push(`${path}: ${line.trim()}`);
        }
      }
    }
    if (offenders.length === 0) return null;
    return (
      `a full-panel buffer of pixel-sized elements exists, which is the one thing this pack is built not to have ` +
      `(AGENTS.md's memory model): ${offenders.join(" | ")}`
    );
  },
};

/* ---------------------------------------------------------------------
 * 5. timing.json pins the timing model's hardware profile and its claim
 *    boundary.
 *
 * These are inputs to a model, not values the model is allowed to quietly
 * infer. A changed clock, memory mode, or calibration status changes what a
 * reported duration means, so drift must be a visible gate failure.
 * ------------------------------------------------------------------- */
const timingProfile: Check = {
  name: "timing.json pins the ESP32-S3 timing profile and claim boundary",
  run() {
    const path = join(PACK, "timing.json");
    if (!existsSync(path)) {
      return "timing.json is missing; the timing model needs a checked-in hardware profile";
    }

    let profile: unknown;
    try {
      profile = JSON.parse(read(path));
    } catch (err) {
      return `timing.json is not valid JSON: ${err instanceof Error ? err.message : String(err)}`;
    }
    if (typeof profile !== "object" || profile === null || Array.isArray(profile)) {
      return "timing.json must contain one JSON object";
    }

    const expected = {
      schemaVersion: 1,
      claimBoundary: {
        mode: "shadow-ledger",
        cycleAccurate: false,
        countsOnlyInstrumentedEvents: true,
        hostTraceTimeIsSimulatedTime: false,
      },
      cpu: {
        cores: 2,
        hz: 240_000_000,
        frequencyStatus: "configured",
      },
      coreSteadyStateCycles: {
        status: "partially-calibrated",
        evidence:
          "packs/esp32-s3-touch-amoled-18/timing/evidence/esp32s3-rev02-tinydraw-bf169bc-counters-candidate.json",
        instructionIssueCycles: 1,
        independentSramAccessAdditiveCycles: {
          instructionFetch: 0,
          load: 0,
          store: 0,
        },
        dependentLoadUseHazard: {
          status: "unmodeled",
          observedAdditionalCycles: 1,
          reason: "runtime traces do not identify register dependencies",
        },
      },
      psram: {
        mode: "octal",
        dtr: true,
        busHz: 80_000_000,
        frequencyStatus: "configured",
        calibrated: false,
        throughputBytesPerSecond: null,
      },
      flash: {
        mode: "qio",
        hz: 80_000_000,
        frequencyStatus: "configured",
        calibrated: false,
        throughputBytesPerSecond: null,
      },
      cacheLineFillCycles: {
        status: "calibrated",
        evidence:
          "packs/esp32-s3-touch-amoled-18/timing/evidence/esp32s3-rev02-tinydraw-a91d1d7-cache-burst-adoption.json",
        instruction: {
          flash: { firstLineCycles: 204, subsequentLineCycles: 266 },
          psram: null,
        },
        data: {
          flash: { firstLineCycles: 115, subsequentLineCycles: 473 },
          psram: { firstLineCycles: 82, subsequentLineCycles: 170 },
        },
      },
      cacheHitAdditiveCycles: {
        status: "partially-calibrated",
        evidence:
          "packs/esp32-s3-touch-amoled-18/timing/evidence/esp32s3-rev02-tinydraw-1ddd64b-4a2c659-hot-hit-adoption.json",
        instructionFetch: 0,
        load: 0,
        store: null,
      },
      panel: {
        interface: "qspi",
        lanes: 4,
        busHz: 40_000_000,
        frequencyStatus: "measured",
        frequencyCalibrated: true,
        bitsPerPixel: 16,
        payloadBytesPerSecond: 20_000_000,
        throughputCalibrated: false,
        payloadStatus: "derived-from-measured-frequency",
      },
    };
    if (isDeepStrictEqual(profile, expected)) return null;
    return (
      "timing.json differs from the pinned schema or values. " +
      `expected ${JSON.stringify(expected)}, got ${JSON.stringify(profile)}`
    );
  },
};

const CHECKS: Check[] = [platformSeam, deviceDescriptorMatches, bandGeometry, noFramebuffer, timingProfile];

let failed = 0;
for (const check of CHECKS) {
  let why: string | null;
  try {
    why = check.run();
  } catch (err) {
    why = `the check itself threw: ${err instanceof Error ? err.message : String(err)}`;
  }
  if (why === null) {
    console.log(`  ok    ${check.name}`);
  } else {
    failed++;
    console.log(`  FAIL  ${check.name}`);
    console.log(`        ${why}`);
  }
}

console.log(`\n${failed === 0 ? "PASS" : "FAIL"}: ${CHECKS.length} check(s), ${failed} failing`);
process.exit(failed === 0 ? 0 : 1);
