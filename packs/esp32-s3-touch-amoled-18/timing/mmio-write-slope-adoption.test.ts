import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseHardwareCalibrationReceipt, type ParsedHardwareCalibrationReceipt } from "./calibration";

const evidenceDirectory = join(import.meta.dir, "evidence");
const manifestPath = join(
  evidenceDirectory,
  "esp32s3-rev02-tinydraw-e8a9f0e-mmio-write-adoption.json",
);

interface ManifestCell {
  readonly role: string;
  readonly operations: number;
  readonly cycles: number | null;
  readonly paths: readonly string[];
  readonly sha256: readonly string[];
}

interface Manifest {
  readonly status: string;
  readonly previousAdoption: Readonly<{ path: string; sha256: string }>;
  readonly firmware: Readonly<{
    repository: string;
    commit: string;
    evidenceCommit: string;
    dirty: boolean;
    elfSha256: string;
    sdkconfigSha256: string;
  }>;
  readonly bootLogs: readonly Readonly<{ bootId: string; sha256: string }>[];
  readonly strictReceipts: Readonly<{
    samplesPerCellPerBoot: number;
    cells: readonly ManifestCell[];
  }>;
  readonly matchedResults: Readonly<{
    writeBaselineCycles: Readonly<{ "2048": number; "4096": number }>;
    registerWriteCycles: Readonly<{ "2048": number; "4096": number }>;
    additiveDeltaCycles: Readonly<{ "2048": number; "4096": number }>;
    affineSlopeCyclesPerAccess: number;
    affineInterceptCycles: number;
  }>;
  readonly adoptedAccesses: readonly Readonly<{
    address: string;
    operation: "read" | "write";
    bytes: number;
    peripheral: string;
    writeEffect?: "same-value";
    cycles: number;
  }>[];
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
      const parsed = parseHardwareCalibrationReceipt(bytes.toString("utf8"));
      expect(parsed.receiptSha256).toBe(cell.sha256[index]);
      expect(parsed.measurement.bytesPerIteration / 4).toBe(cell.operations);
      expect(parsed.measurement.samples).toHaveLength(value.strictReceipts.samplesPerCellPerBoot);
      return parsed;
    })),
  ]));
}

function exactCycles(group: readonly ParsedHardwareCalibrationReceipt[]): number {
  const values = new Set(group.flatMap((receipt) => receipt.measurement.samples.map((sample) => sample.cycles)));
  expect(values.size).toBe(1);
  return [...values][0]!;
}

const zeroCounters = {
  ibus: { accesses: 0, misses: 0 },
  dbus: { accesses: 0, flashMisses: 0, psramMisses: 0 },
};

describe("exact ESP32-S3 same-value MMIO write slope adoption", () => {
  test("binds two complete boots and all twenty strict receipts", () => {
    const value = manifest();
    expect(value.status).toBe("adopted");
    expect(sha256(readFileSync(join(evidenceDirectory, value.previousAdoption.path)))).toBe(
      value.previousAdoption.sha256,
    );
    const parsed = [...receipts(value).values()].flat();
    expect(parsed).toHaveLength(20);
    expect(new Set(parsed.map((receipt) => receipt.boot.bootId))).toEqual(
      new Set(value.bootLogs.map((boot) => boot.bootId)),
    );
    expect(new Set(parsed.map((receipt) => receipt.boot.bootLogSha256))).toEqual(
      new Set(value.bootLogs.map((boot) => boot.sha256)),
    );
    expect(new Set(parsed.map((receipt) => receipt.git.commit))).toEqual(new Set([value.firmware.commit]));
    expect(new Set(parsed.map((receipt) => receipt.sdkconfig.sha256))).toEqual(
      new Set([value.firmware.sdkconfigSha256]),
    );
    expect(value.firmware).toEqual({
      repository: "https://github.com/aliceisjustplaying/tinydraw.git",
      commit: "e8a9f0e574f0e3f8902ae4c66585d43c9775a098",
      evidenceCommit: "f821736534bb4a7f051c229f0197c09747ee3237",
      dirty: false,
      elfSha256: "b483caab054faba176a9a72db5b203d792ba898993b930745cab82b3ef2a8a3e",
      sdkconfigSha256: "5befec96cb7e4dbd86a69abccf96828696b0c79cfe0b0c904d5bdc75543d3d68",
    });
  });

  test("derives a replicated three-cycle affine write slope", () => {
    const value = manifest();
    const byRole = receipts(value);
    const baseline2048 = exactCycles(byRole.get("write-baseline-2048")!);
    const baseline4096 = exactCycles(byRole.get("write-baseline-4096")!);
    const registerRoles = ["system", "dcache", "icache"] as const;
    for (const role of registerRoles) {
      expect(exactCycles(byRole.get(`${role}-same-value-write-2048`)!)).toBe(8_208);
      expect(exactCycles(byRole.get(`${role}-same-value-write-4096`)!)).toBe(16_400);
    }
    expect({ "2048": baseline2048, "4096": baseline4096 }).toEqual(value.matchedResults.writeBaselineCycles);
    const delta2048 = value.matchedResults.registerWriteCycles["2048"] - baseline2048;
    const delta4096 = value.matchedResults.registerWriteCycles["4096"] - baseline4096;
    expect({ "2048": delta2048, "4096": delta4096 }).toEqual(value.matchedResults.additiveDeltaCycles);
    const slope = (delta4096 - delta2048) / (4096 - 2048);
    expect(slope).toBe(value.matchedResults.affineSlopeCyclesPerAccess);
    expect(delta2048 - slope * 2048).toBe(value.matchedResults.affineInterceptCycles);
    for (const role of ["write-baseline-2048", "write-baseline-4096", ...registerRoles.flatMap((name) => [
      `${name}-same-value-write-2048`,
      `${name}-same-value-write-4096`,
    ])]) {
      expect(byRole.get(role)!.every((receipt) => receipt.measurement.samples.every((sample) =>
        JSON.stringify(sample.cacheCounters) === JSON.stringify(zeroCounters)
      ))).toBe(true);
    }
    expect(value.adoptedAccesses.filter((entry) => entry.operation === "write")).toEqual([
      { address: "0x600c0060", operation: "write", bytes: 4, peripheral: "system-controller", writeEffect: "same-value", cycles: 3 },
      { address: "0x600c4004", operation: "write", bytes: 4, peripheral: "cache-controller", writeEffect: "same-value", cycles: 3 },
      { address: "0x600c4064", operation: "write", bytes: 4, peripheral: "cache-controller", writeEffect: "same-value", cycles: 3 },
    ]);
  });

  test("keeps RTC reads and unobserved write effects outside the adopted class", () => {
    const value = manifest();
    const rtc = receipts(value).get("rtc-date-read-excluded")!;
    expect(rtc.map((receipt) => {
      const cycles = receipt.measurement.samples.map((sample) => sample.cycles);
      return [Math.min(...cycles), Math.max(...cycles)];
    })).toEqual([[372_030, 372_189], [372_018, 372_186]]);
    expect(rtc.every((receipt) => receipt.measurement.samples.every((sample) =>
      sample.cacheCounters?.ibus.accesses === 176
    ))).toBe(true);
    expect(value.claimBoundary).toEqual({
      exactAddressOperationWidthPeripheralAndWriteEffectOnly: true,
      twoPointAffineSlopeMeasured: true,
      allAdoptedCacheCountersZero: true,
      rtcDateReadExcludedForInstructionBusActivityAndVariance: true,
      autoloadAndValueChangingWritesExcluded: true,
      otherMmioAccessesCalibrated: false,
      architectureCycleAccurate: false,
    });
  });
});
