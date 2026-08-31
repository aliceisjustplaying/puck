import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { parseHardwareCalibrationReceipt, type ParsedHardwareCalibrationReceipt } from "./calibration";

const evidenceDirectory = join(import.meta.dir, "evidence");
const manifestPath = join(
  evidenceDirectory,
  "esp32s3-rev02-tinydraw-6f22350-mmio-adoption.json",
);

type MmioCellRole =
  | "read-baseline"
  | "system-read"
  | "cache-read"
  | "write-baseline"
  | "cache-write"
  | "rtc-read-excluded";

interface MmioManifest {
  readonly status: string;
  readonly firmware: Readonly<{
    repository: string;
    commit: string;
    dirty: boolean;
    elfSha256: string;
    sdkconfigSha256: string;
  }>;
  readonly captures: readonly Readonly<{
    bootId: string;
    path: string;
    compressedSha256: string;
    decompressedSha256: string;
  }>[];
  readonly strictReceipts: Readonly<{
    samplesPerCellPerBoot: number;
    operationsPerSample: number;
    cells: readonly Readonly<{
      role: MmioCellRole;
      kernel: string;
      paths: readonly string[];
      sha256: readonly string[];
    }>[];
  }>;
  readonly matchedResults: Readonly<{
    readBaselineCycles: number;
    systemReadCycles: number;
    cacheReadCycles: number;
    readDeltaCycles: number;
    adoptedReadCyclesPerAccess: number;
    writeBaselineCycles: number;
    cacheWriteCycles: number;
    writeDeltaCycles: number;
    writeDeltaCyclesPerAccess: Readonly<{ numerator: number; denominator: number }>;
  }>;
  readonly adoptedAccesses: readonly Readonly<{
    address: string;
    operation: "read" | "write";
    bytes: number;
    peripheral: string;
    cycles: number;
  }>[];
  readonly claimBoundary: Readonly<{
    exactAddressOperationWidthAndPeripheralOnly: boolean;
    allAdoptedCacheCountersZero: boolean;
    rtcReadExcludedForInstructionBusActivityAndVariance: boolean;
    cacheCounterClearWriteExcludedForNonIntegralDelta: boolean;
    otherMmioAccessesCalibrated: boolean;
    architectureCycleAccurate: boolean;
  }>;
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function manifest(): MmioManifest {
  return JSON.parse(readFileSync(manifestPath, "utf8")) as MmioManifest;
}

function receipts(value: MmioManifest): ReadonlyMap<MmioCellRole, readonly ParsedHardwareCalibrationReceipt[]> {
  return new Map(value.strictReceipts.cells.map((cell) => [
    cell.role,
    Object.freeze(cell.paths.map((path, index) => {
      const parsed = parseHardwareCalibrationReceipt(readFileSync(join(evidenceDirectory, path), "utf8"));
      expect(parsed.measurement.kernel).toBe(cell.kernel);
      expect(parsed.receiptSha256).toBe(cell.sha256[index]);
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

describe("exact ESP32-S3 MMIO access adoption", () => {
  test("binds two complete boots and all twelve strict receipts", () => {
    const value = manifest();
    expect(value.status).toBe("adopted");
    expect(value.firmware).toEqual({
      repository: "https://github.com/aliceisjustplaying/tinydraw.git",
      commit: "6f22350a95ccc3eba4eebfbd89bb98582e0087e0",
      dirty: false,
      elfSha256: "21ba3dba138373e4f8227bdded35131a4d37012244c36b847c83efe4f72a05da",
      sdkconfigSha256: "5befec96cb7e4dbd86a69abccf96828696b0c79cfe0b0c904d5bdc75543d3d68",
    });
    for (const capture of value.captures) {
      const compressed = readFileSync(join(evidenceDirectory, capture.path));
      expect(sha256(compressed)).toBe(capture.compressedSha256);
      expect(sha256(gunzipSync(compressed))).toBe(capture.decompressedSha256);
    }
    const parsed = [...receipts(value).values()].flat();
    expect(value.captures).toHaveLength(2);
    expect(parsed).toHaveLength(12);
    expect(parsed.every((receipt) =>
      receipt.measurement.samples.length === value.strictReceipts.samplesPerCellPerBoot
    )).toBe(true);
    expect(new Set(parsed.map((receipt) => receipt.boot.bootId))).toEqual(
      new Set(value.captures.map((capture) => capture.bootId)),
    );
    expect(new Set(parsed.map((receipt) => receipt.git.commit))).toEqual(new Set([value.firmware.commit]));
    expect(new Set(parsed.map((receipt) => receipt.sdkconfig.sha256))).toEqual(
      new Set([value.firmware.sdkconfigSha256]),
    );
  });

  test("adopts only the two exact zero-miss read classes", () => {
    const value = manifest();
    const byRole = receipts(value);
    const readBaseline = exactCycles(byRole.get("read-baseline")!);
    const systemRead = exactCycles(byRole.get("system-read")!);
    const cacheRead = exactCycles(byRole.get("cache-read")!);
    for (const role of ["read-baseline", "system-read", "cache-read"] as const) {
      expect(byRole.get(role)!.every((receipt) =>
        receipt.measurement.samples.every((sample) => sample.cacheCounters === undefined ||
          JSON.stringify(sample.cacheCounters) === JSON.stringify(zeroCounters))
      )).toBe(true);
    }
    expect({ readBaseline, systemRead, cacheRead }).toEqual({
      readBaseline: value.matchedResults.readBaselineCycles,
      systemRead: value.matchedResults.systemReadCycles,
      cacheRead: value.matchedResults.cacheReadCycles,
    });
    expect(systemRead - readBaseline).toBe(value.matchedResults.readDeltaCycles);
    expect(cacheRead - readBaseline).toBe(value.matchedResults.readDeltaCycles);
    expect(value.matchedResults.readDeltaCycles % value.strictReceipts.operationsPerSample).toBe(0);
    expect(value.matchedResults.readDeltaCycles / value.strictReceipts.operationsPerSample).toBe(
      value.matchedResults.adoptedReadCyclesPerAccess,
    );
    expect(value.adoptedAccesses).toEqual([
      {
        address: "0x600c0010",
        operation: "read",
        bytes: 4,
        peripheral: "system-controller",
        cycles: 8,
      },
      {
        address: "0x600c4130",
        operation: "read",
        bytes: 4,
        peripheral: "cache-controller",
        cycles: 8,
      },
    ]);
  });

  test("keeps RTC reads and the non-integral write delta outside exact costs", () => {
    const value = manifest();
    const byRole = receipts(value);
    const writeBaseline = exactCycles(byRole.get("write-baseline")!);
    const cacheWrite = exactCycles(byRole.get("cache-write")!);
    const rtcCycles = new Set(
      byRole.get("rtc-read-excluded")!.flatMap((receipt) =>
        receipt.measurement.samples.map((sample) => sample.cycles)
      ),
    );
    expect(writeBaseline).toBe(value.matchedResults.writeBaselineCycles);
    expect(cacheWrite).toBe(value.matchedResults.cacheWriteCycles);
    expect(cacheWrite - writeBaseline).toBe(value.matchedResults.writeDeltaCycles);
    expect(value.matchedResults.writeDeltaCyclesPerAccess).toEqual({ numerator: 12_280, denominator: 4_096 });
    expect(value.matchedResults.writeDeltaCycles % value.strictReceipts.operationsPerSample).not.toBe(0);
    expect(rtcCycles.size).toBeGreaterThan(1);
    expect(byRole.get("rtc-read-excluded")!.every((receipt) =>
      receipt.measurement.samples.every((sample) => sample.cacheCounters?.ibus.accesses === 176)
    )).toBe(true);
    expect(value.claimBoundary).toEqual({
      exactAddressOperationWidthAndPeripheralOnly: true,
      allAdoptedCacheCountersZero: true,
      rtcReadExcludedForInstructionBusActivityAndVariance: true,
      cacheCounterClearWriteExcludedForNonIntegralDelta: true,
      otherMmioAccessesCalibrated: false,
      architectureCycleAccurate: false,
    });
  });
});
