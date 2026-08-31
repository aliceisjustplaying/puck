import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseHardwareCalibrationReceipt, type ParsedHardwareCalibrationReceipt } from "./calibration";

const evidenceDirectory = join(import.meta.dir, "evidence");
const manifestPath = join(evidenceDirectory, "esp32s3-rev02-tinydraw-0b187a0-rom-callback-adoption.json");

interface Manifest {
  readonly status: string;
  readonly firmware: Readonly<Record<string, string | boolean>>;
  readonly bootLogs: readonly Readonly<{ bootId: string; sha256: string }>[];
  readonly strictReceipts: Readonly<{
    samplesPerCellPerBoot: number;
    cells: readonly Readonly<{
      role: string;
      cycles: number | null;
      paths: readonly string[];
      sha256: readonly string[];
    }>[];
  }>;
  readonly adoptedCallbacks: readonly Readonly<Record<string, string | number>>[];
  readonly claimBoundary: Readonly<Record<string, boolean>>;
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function manifest(): Manifest {
  return JSON.parse(readFileSync(manifestPath, "utf8")) as Manifest;
}

function receipts(value: Manifest): ReadonlyMap<string, readonly ParsedHardwareCalibrationReceipt[]> {
  return new Map(value.strictReceipts.cells.map((cell) => [
    cell.role,
    Object.freeze(cell.paths.map((path, index) => {
      const bytes = readFileSync(join(evidenceDirectory, path));
      expect(sha256(bytes)).toBe(cell.sha256[index]);
      const receipt = parseHardwareCalibrationReceipt(bytes.toString("utf8"));
      expect(receipt.receiptSha256).toBe(cell.sha256[index]);
      expect(receipt.measurement.samples).toHaveLength(value.strictReceipts.samplesPerCellPerBoot);
      return receipt;
    })),
  ]));
}

function exactCycles(group: readonly ParsedHardwareCalibrationReceipt[]): number {
  const values = new Set(group.flatMap((receipt) => receipt.measurement.samples.map((sample) => sample.cycles)));
  expect(values.size).toBe(1);
  return [...values][0]!;
}

const zeroCounters = JSON.stringify({
  ibus: { accesses: 0, misses: 0 },
  dbus: { accesses: 0, flashMisses: 0, psramMisses: 0 },
});

describe("exact ESP32-S3 ROM callback adoption", () => {
  test("binds two complete boots and all twenty strict receipts", () => {
    const value = manifest();
    const parsed = [...receipts(value).values()].flat();
    expect(value.status).toBe("adopted");
    expect(parsed).toHaveLength(20);
    expect(new Set(parsed.map((receipt) => receipt.boot.bootId))).toEqual(
      new Set(value.bootLogs.map((boot) => boot.bootId)),
    );
    expect(new Set(parsed.map((receipt) => receipt.boot.bootLogSha256))).toEqual(
      new Set(value.bootLogs.map((boot) => boot.sha256)),
    );
    expect(new Set(parsed.map((receipt) => receipt.git.commit))).toEqual(
      new Set([value.firmware.commit]),
    );
    expect(new Set(parsed.map((receipt) => receipt.sdkconfig.sha256))).toEqual(
      new Set([value.firmware.sdkconfigSha256]),
    );
    expect(value.firmware.evidenceCommit).toBe("eded23aa95264bbca76554c456e5bbb2349b441e");
  });

  test("subtracts matched call shapes for three exact callbacks", () => {
    const value = manifest();
    const byRole = receipts(value);
    expect(exactCycles(byRole.get("target-memset-length-0")!) -
      exactCycles(byRole.get("baseline-memset-length-0")!)).toBe(31);
    expect(exactCycles(byRole.get("target-memset-length-0x52e0")!) -
      exactCycles(byRole.get("baseline-memset-length-0x52e0")!)).toBe(6_659);
    expect(exactCycles(byRole.get("target-set-cpu-ticks-same-value")!) -
      exactCycles(byRole.get("baseline-set-cpu-ticks")!)).toBe(9);
    expect([...byRole.values()].flat().every((receipt) => receipt.measurement.samples.every((sample) =>
      JSON.stringify(sample.cacheCounters) === zeroCounters
    ))).toBe(true);
    expect(value.adoptedCallbacks).toEqual([
      { kind: "memset", pc: "0x400011e8", destination: "0x3fcabe60", value: 0, length: 0x52e0, cycles: 6_659 },
      { kind: "memset", pc: "0x400011e8", destination: "0x50000000", value: 0, length: 0, cycles: 31 },
      { kind: "cpuTicksPerUs", pc: "0x40001a4c", ticksPerUs: 40, callinc: 2, cycles: 9 },
    ]);
  });

  test("excludes the repeatable but non-scalar reset-reason lattice", () => {
    const value = manifest();
    const byRole = receipts(value);
    expect(exactCycles(byRole.get("baseline-reset-reason-core-0")!)).toBe(25);
    expect(exactCycles(byRole.get("baseline-reset-reason-core-1")!)).toBe(25);
    const ranges = ([0, 1] as const).map((core) => {
      const values = byRole.get(`target-reset-reason-core-${core}-excluded`)!
        .flatMap((receipt) => receipt.measurement.samples.map((sample) => sample.cycles));
      return [Math.min(...values), Math.max(...values), [...new Set(values)].sort((a, b) => a - b)];
    });
    expect(ranges).toEqual([
      [119, 131, [119, 122, 125, 128, 131]],
      [116, 128, [116, 118, 119, 122, 125, 127, 128]],
    ]);
    expect(value.claimBoundary).toEqual({
      exactCallbackPcAndArgumentsOnly: true,
      matchedCallShapeBaselineSubtracted: true,
      allAdoptedCacheCountersZero: true,
      resetReasonExcludedForNonScalarDuration: true,
      otherRomCallbacksCalibrated: false,
      architectureCycleAccurate: false,
    });
  });
});
