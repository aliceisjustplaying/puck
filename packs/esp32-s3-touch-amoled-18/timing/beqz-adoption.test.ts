import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { parseHardwareCalibrationReceipt, type ParsedHardwareCalibrationReceipt } from "./calibration";

const evidenceDirectory = join(import.meta.dir, "evidence");
const manifestPath = join(
  evidenceDirectory,
  "esp32s3-rev02-tinydraw-2bf3ffd-beqz-adoption.json",
);

interface BeqzManifest {
  readonly status: string;
  readonly firmware: Readonly<{
    repository: string;
    commit: string;
    dirty: boolean;
    elfSha256: string;
  }>;
  readonly captures: readonly Readonly<{
    bootId: string;
    path: string;
    compressedSha256: string;
    decompressedSha256: string;
  }>[];
  readonly strictReceipts: Readonly<{
    samplesPerCellPerBoot: number;
    branchIterationsPerSample: number;
    cells: readonly Readonly<{
      pathKind: "baseline" | "not-taken" | "taken";
      kernel: string;
      instructionEncoding: string;
      paths: readonly string[];
      sha256: readonly string[];
    }>[];
  }>;
  readonly matchedResults: Readonly<{
    dynamicBodyInstructionsPerIteration: number;
    baselineCycles: number;
    notTakenCycles: number;
    takenCycles: number;
    notTakenDeltaCycles: number;
    takenDeltaCycles: number;
    takenAdditionalCyclesPerBranch: number;
    steadyStateIssueCycles: number;
    adoptedBeqzCpuCycles: Readonly<{ notTaken: number; taken: number }>;
  }>;
  readonly claimBoundary: Readonly<{
    exactBeqzEncodingAndMatchedRoutesOnly: boolean;
    allCacheCountersZero: boolean;
    otherConditionalBranchesCalibrated: boolean;
    architectureCycleAccurate: boolean;
  }>;
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function manifest(): BeqzManifest {
  return JSON.parse(readFileSync(manifestPath, "utf8")) as BeqzManifest;
}

function receipts(value: BeqzManifest): ReadonlyMap<string, readonly ParsedHardwareCalibrationReceipt[]> {
  return new Map(value.strictReceipts.cells.map((cell) => [
    cell.pathKind,
    Object.freeze(cell.paths.map((path, index) => {
      const parsed = parseHardwareCalibrationReceipt(readFileSync(join(evidenceDirectory, path), "utf8"));
      expect(parsed.measurement.kernel).toBe(cell.kernel);
      expect(parsed.receiptSha256).toBe(cell.sha256[index]);
      return parsed;
    })),
  ]));
}

describe("exact ESP32-S3 beqz path adoption", () => {
  test("binds two raw boots and all six strict receipts", () => {
    const value = manifest();
    expect(value.firmware).toEqual({
      repository: "https://github.com/aliceisjustplaying/tinydraw.git",
      commit: "2bf3ffd861115b95451df1860623618c06e22dcf",
      dirty: false,
      elfSha256: "b5db91a7c2692395c8b73aa96c69a5966517d518f904725f95b94096e2fd729c",
    });
    for (const capture of value.captures) {
      const compressed = readFileSync(join(evidenceDirectory, capture.path));
      expect(sha256(compressed)).toBe(capture.compressedSha256);
      expect(sha256(gunzipSync(compressed))).toBe(capture.decompressedSha256);
    }
    const parsed = [...receipts(value).values()].flat();
    expect(value.captures).toHaveLength(2);
    expect(parsed).toHaveLength(6);
    expect(parsed.every((receipt) =>
      receipt.measurement.samples.length === value.strictReceipts.samplesPerCellPerBoot
    )).toBe(true);
    expect(new Set(parsed.map((receipt) => receipt.boot.bootId))).toEqual(
      new Set(value.captures.map((capture) => capture.bootId)),
    );
  });

  test("adopts only exact matched beqz taken and not-taken CPU costs", () => {
    const value = manifest();
    const byPath = receipts(value);
    const expectedCycles = new Map([
      ["baseline", value.matchedResults.baselineCycles],
      ["not-taken", value.matchedResults.notTakenCycles],
      ["taken", value.matchedResults.takenCycles],
    ]);
    for (const [pathKind, group] of byPath) {
      expect(group).toHaveLength(2);
      for (const receipt of group) {
        expect(receipt.measurement.samples).toHaveLength(100);
        for (const sample of receipt.measurement.samples) {
          expect(sample.cycles).toBe(expectedCycles.get(pathKind));
          expect(sample.cacheCounters).toEqual({
            ibus: { accesses: 0, misses: 0 },
            dbus: { accesses: 0, flashMisses: 0, psramMisses: 0 },
          });
        }
      }
    }
    expect(value.strictReceipts.branchIterationsPerSample).toBe(4_096);
    expect(value.matchedResults).toMatchObject({
      dynamicBodyInstructionsPerIteration: 4,
      notTakenDeltaCycles: 0,
      takenDeltaCycles: 8_192,
      takenAdditionalCyclesPerBranch: 2,
      steadyStateIssueCycles: 1,
      adoptedBeqzCpuCycles: { notTaken: 1, taken: 3 },
    });
    expect(value.claimBoundary).toMatchObject({
      exactBeqzEncodingAndMatchedRoutesOnly: true,
      allCacheCountersZero: true,
      otherConditionalBranchesCalibrated: false,
      architectureCycleAccurate: false,
    });
  });
});
