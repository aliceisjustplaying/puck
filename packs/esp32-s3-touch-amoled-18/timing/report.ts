#!/usr/bin/env bun

import { join, resolve } from "node:path";
import { instantiate } from "../../../src/wasm";
import {
  buildTimingReport,
  decodeOptionalTimingExports,
  parseTimingProfile,
  stableTimingJson,
  type TimingReportOptions,
} from "./consumer";

interface CliOptions {
  readonly wasmPath: string;
  readonly report: TimingReportOptions;
}

function usage(): never {
  console.error(
    "usage: bun packs/esp32-s3-touch-amoled-18/timing/report.ts <emu.wasm> " +
      "[--max-strip-bytes N] [--producer-cycles-per-byte N[/D]]",
  );
  process.exit(2);
}

function positiveInteger(text: string | undefined, flag: string): number {
  if (text === undefined || !/^\d+$/.test(text)) throw new Error(`${flag} needs a positive integer`);
  const value = Number(text);
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${flag} needs a positive safe integer`);
  return value;
}

function positiveRatio(text: string | undefined): Readonly<{ numerator: bigint; denominator: bigint }> {
  if (text === undefined) throw new Error("--producer-cycles-per-byte needs N or N/D");
  const match = /^(\d+)(?:\/(\d+))?$/.exec(text);
  if (!match) throw new Error("--producer-cycles-per-byte needs N or N/D");
  const numerator = BigInt(match[1]!);
  const denominator = BigInt(match[2] ?? "1");
  if (numerator <= 0n || denominator <= 0n) {
    throw new Error("--producer-cycles-per-byte needs a positive ratio");
  }
  return Object.freeze({ numerator, denominator });
}

function parseArguments(args: readonly string[]): CliOptions {
  if (args.length === 0 || args[0]!.startsWith("--")) usage();
  const wasmPath = resolve(args[0]!);
  let maxStripBytes: number | undefined;
  let producerCyclesPerByte: Readonly<{ numerator: bigint; denominator: bigint }> | undefined;
  for (let index = 1; index < args.length; index += 1) {
    const flag = args[index];
    if (flag === "--max-strip-bytes") {
      maxStripBytes = positiveInteger(args[++index], flag);
    } else if (flag === "--producer-cycles-per-byte") {
      producerCyclesPerByte = positiveRatio(args[++index]);
    } else {
      throw new Error(`unknown argument ${flag}`);
    }
  }
  return Object.freeze({
    wasmPath,
    report: Object.freeze({ maxStripBytes, producerCyclesPerByte }),
  });
}

export async function runTimingReport(args: readonly string[]): Promise<string> {
  const options = parseArguments(args);
  const profilePath = join(import.meta.dir, "..", "timing.json");
  const profile = parseTimingProfile(await Bun.file(profilePath).json());
  const bytes = await Bun.file(options.wasmPath).arrayBuffer();
  const emu = await instantiate(bytes, () => {});
  if (emu.emu_init() !== 1) throw new Error("emu_init failed");
  const availability = decodeOptionalTimingExports(emu as unknown as Record<string, unknown>);
  return stableTimingJson(buildTimingReport(availability, profile, options.report));
}

if (import.meta.main) {
  try {
    process.stdout.write(await runTimingReport(process.argv.slice(2)));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
