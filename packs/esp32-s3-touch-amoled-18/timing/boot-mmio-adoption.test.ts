import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseHardwareCalibrationReceipt, type ParsedHardwareCalibrationReceipt } from "./calibration";

const evidenceDirectory = join(import.meta.dir, "evidence");
const manifestPath = join(evidenceDirectory, "esp32s3-rev02-tinydraw-545f823-mmio-adoption.json");

interface ExactAccess {
  readonly address: string;
  readonly operation: "read" | "write";
  readonly bytes: number;
  readonly peripheral: string;
  readonly cycles: number;
}

interface BootMmioManifest {
  readonly status: string;
  readonly previousAdoption: Readonly<{ path: string; sha256: string }>;
  readonly firmware: Readonly<{
    repository: string;
    commit: string;
    dirty: boolean;
    elfSha256: string;
    sdkconfigSha256: string;
  }>;
  readonly strictReceipts: Readonly<{
    samplesPerCellPerBoot: number;
    operationsPerSample: number;
    cells: readonly Readonly<{
      role: string;
      kernel: string;
      cycles: number;
      paths: readonly string[];
      sha256: readonly string[];
    }>[];
  }>;
  readonly matchedResults: Readonly<{
    readBaselineCycles: number;
    registerReadCycles: number;
    readDeltaCycles: number;
    adoptedReadCyclesPerAccess: number;
    writeBaselineCycles: number;
    registerWriteCycles: number;
    writeDeltaCycles: number;
    writeDeltaCyclesPerAccess: Readonly<{ numerator: number; denominator: number }>;
  }>;
  readonly adoptedAccesses: readonly ExactAccess[];
  readonly claimBoundary: Readonly<{
    exactAddressOperationWidthAndPeripheralOnly: boolean;
    allAdoptedCacheCountersZero: boolean;
    sameValueWritesExcludedUntilAffineSlopeIsMeasured: boolean;
    autoloadWritesExcludedAfterHardwareStateFailure: boolean;
    otherMmioAccessesCalibrated: boolean;
    architectureCycleAccurate: boolean;
  }>;
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function manifest(): BootMmioManifest {
  return JSON.parse(readFileSync(manifestPath, "utf8")) as BootMmioManifest;
}

function exactCycles(receipt: ParsedHardwareCalibrationReceipt): number {
  const values = new Set(receipt.measurement.samples.map((sample) => sample.cycles));
  expect(values.size).toBe(1);
  return [...values][0]!;
}

const zeroCounters = JSON.stringify({
  ibus: { accesses: 0, misses: 0 },
  dbus: { accesses: 0, flashMisses: 0, psramMisses: 0 },
});

describe("boot-register ESP32-S3 MMIO adoption", () => {
  test("binds the previous adoption and all twenty strict receipts", () => {
    const value = manifest();
    expect(value.status).toBe("adopted");
    const previousBytes = readFileSync(join(evidenceDirectory, value.previousAdoption.path));
    expect(sha256(previousBytes)).toBe(value.previousAdoption.sha256);
    const previous = JSON.parse(previousBytes.toString("utf8")) as { adoptedAccesses: ExactAccess[] };
    expect(previous.adoptedAccesses.map((access) => access.address)).toEqual(["0x600c0010", "0x600c4130"]);

    const parsed: ParsedHardwareCalibrationReceipt[] = [];
    const paths = new Set<string>();
    for (const cell of value.strictReceipts.cells) {
      expect(cell.paths).toHaveLength(2);
      expect(cell.sha256).toHaveLength(2);
      for (const [index, path] of cell.paths.entries()) {
        expect(paths.has(path)).toBe(false);
        paths.add(path);
        const receipt = parseHardwareCalibrationReceipt(readFileSync(join(evidenceDirectory, path), "utf8"));
        expect(receipt.receiptSha256).toBe(cell.sha256[index]);
        expect(receipt.measurement.kernel).toBe(cell.kernel);
        expect(receipt.measurement.samples).toHaveLength(value.strictReceipts.samplesPerCellPerBoot);
        expect(receipt.measurement.bytesPerIteration / 4).toBe(value.strictReceipts.operationsPerSample);
        expect(exactCycles(receipt)).toBe(cell.cycles);
        expect(receipt.measurement.samples.every((sample) =>
          JSON.stringify(sample.cacheCounters) === zeroCounters
        )).toBe(true);
        parsed.push(receipt);
      }
    }
    expect(paths.size).toBe(20);
    expect(parsed).toHaveLength(20);
    expect(new Set(parsed.map((receipt) => receipt.boot.bootId))).toEqual(new Set([
      "1cdbd47b85c8-9ef4e067-00016b7f",
      "1cdbd47b85c8-5048156f-00016b80",
    ]));
    expect(new Set(parsed.map((receipt) => receipt.git.commit))).toEqual(new Set([value.firmware.commit]));
    expect(new Set(parsed.map((receipt) => receipt.sdkconfig.sha256))).toEqual(
      new Set([value.firmware.sdkconfigSha256]),
    );
  });

  test("adopts only the stable integral read delta", () => {
    const value = manifest();
    const cyclesByRole = new Map(value.strictReceipts.cells.map((cell) => [cell.role, cell.cycles]));
    expect(cyclesByRole.get("read-baseline")).toBe(value.matchedResults.readBaselineCycles);
    for (const role of [
      "sysclk-read",
      "dcache-ctrl1-read",
      "dcache-autoload-read",
      "icache-ctrl1-read",
      "icache-autoload-read",
    ]) {
      expect(cyclesByRole.get(role)).toBe(value.matchedResults.registerReadCycles);
    }
    expect(value.matchedResults.registerReadCycles - value.matchedResults.readBaselineCycles).toBe(
      value.matchedResults.readDeltaCycles,
    );
    expect(value.matchedResults.readDeltaCycles / value.strictReceipts.operationsPerSample).toBe(
      value.matchedResults.adoptedReadCyclesPerAccess,
    );
    expect(value.adoptedAccesses).toEqual([
      { address: "0x600c0010", operation: "read", bytes: 4, peripheral: "system-controller", cycles: 8 },
      { address: "0x600c4004", operation: "read", bytes: 4, peripheral: "cache-controller", cycles: 8 },
      { address: "0x600c404c", operation: "read", bytes: 4, peripheral: "cache-controller", cycles: 8 },
      { address: "0x600c4064", operation: "read", bytes: 4, peripheral: "cache-controller", cycles: 8 },
      { address: "0x600c40a0", operation: "read", bytes: 4, peripheral: "cache-controller", cycles: 8 },
      { address: "0x600c4130", operation: "read", bytes: 4, peripheral: "cache-controller", cycles: 8 },
    ]);
  });

  test("retains the write aggregate without inventing a scalar", () => {
    const value = manifest();
    const cyclesByRole = new Map(value.strictReceipts.cells.map((cell) => [cell.role, cell.cycles]));
    expect(cyclesByRole.get("write-baseline")).toBe(value.matchedResults.writeBaselineCycles);
    for (const role of [
      "sysclk-write-excluded",
      "dcache-ctrl1-write-excluded",
      "icache-ctrl1-write-excluded",
    ]) {
      expect(cyclesByRole.get(role)).toBe(value.matchedResults.registerWriteCycles);
    }
    expect(value.matchedResults.registerWriteCycles - value.matchedResults.writeBaselineCycles).toBe(
      value.matchedResults.writeDeltaCycles,
    );
    expect(value.matchedResults.writeDeltaCyclesPerAccess).toEqual({ numerator: 12_280, denominator: 4_096 });
    expect(value.matchedResults.writeDeltaCycles % value.strictReceipts.operationsPerSample).not.toBe(0);
    expect(value.adoptedAccesses.every((access) => access.operation === "read")).toBe(true);
    expect(value.claimBoundary).toEqual({
      exactAddressOperationWidthAndPeripheralOnly: true,
      allAdoptedCacheCountersZero: true,
      sameValueWritesExcludedUntilAffineSlopeIsMeasured: true,
      autoloadWritesExcludedAfterHardwareStateFailure: true,
      otherMmioAccessesCalibrated: false,
      architectureCycleAccurate: false,
    });
  });
});
