import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import {
  parseHardwareCalibrationReceipt,
  type HardwareCacheCounters,
  type ParsedHardwareCalibrationReceipt,
} from "./calibration";

const evidenceDirectory = join(import.meta.dir, "evidence");
const manifestPath = join(
  evidenceDirectory,
  "esp32s3-rev02-tinydraw-1ddd64b-4a2c659-hot-hit-adoption.json",
);

interface CaptureEntry {
  readonly bootId: string;
  readonly path: string;
  readonly compressedSha256: string;
  readonly decompressedSha256: string;
}

interface ReceiptCell {
  readonly kernel: string;
  readonly paths: readonly string[];
  readonly sha256: readonly string[];
}

interface AdoptionManifest {
  readonly status: string;
  readonly firmwareCohorts: readonly Readonly<{
    captures: readonly CaptureEntry[];
  }>[];
  readonly strictReceipts: Readonly<{
    samplesPerCellPerBoot: number;
    independent: readonly ReceiptCell[];
    dependent: readonly ReceiptCell[];
  }>;
  readonly adoptedCosts: Readonly<{
    instructionFetchHotHitAdditiveCycles: number;
    loadHotHitAdditiveCycles: number;
    storeHotHitAdditiveCycles: null;
  }>;
  readonly claimBoundary: Readonly<{
    dependentLoadUseHazard: Readonly<{
      status: string;
      observedAdditionalCycles: number;
    }>;
    architectureCycleAccurate: boolean;
  }>;
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function manifest(): AdoptionManifest {
  return JSON.parse(readFileSync(manifestPath, "utf8")) as AdoptionManifest;
}

function receipts(value: AdoptionManifest): readonly ParsedHardwareCalibrationReceipt[] {
  return [...value.strictReceipts.independent, ...value.strictReceipts.dependent].flatMap((cell) =>
    cell.paths.map((path, index) => {
      const parsed = parseHardwareCalibrationReceipt(
        readFileSync(join(evidenceDirectory, path), "utf8"),
      );
      expect(parsed.measurement.kernel).toBe(cell.kernel);
      expect(parsed.receiptSha256).toBe(cell.sha256[index]);
      return parsed;
    })
  );
}

function expectExactSignature(
  receipt: ParsedHardwareCalibrationReceipt,
  cycles: number,
  counters: HardwareCacheCounters,
): void {
  expect(receipt.measurement.samples).toHaveLength(100);
  for (const sample of receipt.measurement.samples) {
    expect(sample.cycles).toBe(cycles);
    expect(sample.cacheCounters).toEqual(counters);
  }
}

const zeroCounters: HardwareCacheCounters = {
  ibus: { accesses: 0, misses: 0 },
  dbus: { accesses: 0, flashMisses: 0, psramMisses: 0 },
};

describe("hot zero-miss cache-hit adoption", () => {
  test("binds every compact raw capture and strict receipt by SHA-256", () => {
    const value = manifest();
    for (const cohort of value.firmwareCohorts) {
      for (const capture of cohort.captures) {
        const compressed = readFileSync(join(evidenceDirectory, capture.path));
        expect(sha256(compressed)).toBe(capture.compressedSha256);
        expect(sha256(gunzipSync(compressed))).toBe(capture.decompressedSha256);
      }
    }
    const parsed = receipts(value);
    expect(value.firmwareCohorts.flatMap((cohort) => cohort.captures)).toHaveLength(4);
    expect(parsed).toHaveLength(16);
    expect(parsed.every((receipt) =>
      receipt.measurement.samples.length === value.strictReceipts.samplesPerCellPerBoot
    )).toBe(true);
  });

  test("retains exact independent and dependent zero-miss comparisons", () => {
    const value = manifest();
    const byKernel = new Map<string, ParsedHardwareCalibrationReceipt[]>();
    for (const receipt of receipts(value)) {
      const group = byKernel.get(receipt.measurement.kernel) ?? [];
      group.push(receipt);
      byKernel.set(receipt.measurement.kernel, group);
    }

    const expected = new Map<string, Readonly<{ cycles: number; counters: HardwareCacheCounters }>>([
      ["icache_hit_iram_120_instructions_single_core", { cycles: 126, counters: zeroCounters }],
      ["icache_hit_flash_120_instructions_single_core", {
        cycles: 126,
        counters: {
          ibus: { accesses: 62, misses: 0 },
          dbus: { accesses: 0, flashMisses: 0, psramMisses: 0 },
        },
      }],
      ["dcache_hit_sram_16_loads_single_core", { cycles: 33, counters: zeroCounters }],
      ["dcache_hit_psram_16_loads_single_core", {
        cycles: 33,
        counters: {
          ibus: { accesses: 0, misses: 0 },
          dbus: { accesses: 16, flashMisses: 0, psramMisses: 0 },
        },
      }],
      ["dcache_hit_flash_16_loads_single_core", {
        cycles: 33,
        counters: {
          ibus: { accesses: 0, misses: 0 },
          dbus: { accesses: 16, flashMisses: 0, psramMisses: 0 },
        },
      }],
      ["dependent_load_sram_4096_steps_single_core", { cycles: 16_403, counters: zeroCounters }],
      ["dependent_load_psram_hot_4096_steps_single_core", {
        cycles: 16_403,
        counters: {
          ibus: { accesses: 0, misses: 0 },
          dbus: { accesses: 4_096, flashMisses: 0, psramMisses: 0 },
        },
      }],
      ["dependent_load_flash_hot_4096_steps_single_core", {
        cycles: 16_403,
        counters: {
          ibus: { accesses: 0, misses: 0 },
          dbus: { accesses: 4_096, flashMisses: 0, psramMisses: 0 },
        },
      }],
    ]);

    expect(byKernel.size).toBe(expected.size);
    for (const [kernel, signature] of expected) {
      const group = byKernel.get(kernel);
      expect(group).toHaveLength(2);
      for (const receipt of group ?? []) {
        expectExactSignature(receipt, signature.cycles, signature.counters);
      }
    }
    expect(value.adoptedCosts).toEqual({
      instructionFetchHotHitAdditiveCycles: 0,
      loadHotHitAdditiveCycles: 0,
      storeHotHitAdditiveCycles: null,
    });
    expect(value.claimBoundary.dependentLoadUseHazard).toMatchObject({
      status: "unmodeled",
      observedAdditionalCycles: 1,
    });
    expect(value.claimBoundary.architectureCycleAccurate).toBe(false);
  });
});
