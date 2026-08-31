import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseHardwareCalibrationReceipt, type ParsedHardwareCalibrationReceipt } from "./calibration";

const evidenceDirectory = join(import.meta.dir, "evidence");
const manifestPath = join(
  evidenceDirectory,
  "esp32s3-rev02-tinydraw-0a41b6f-bbpll-rom-callback-adoption.json",
);

interface Manifest {
  readonly status: string;
  readonly priorAdoption: Readonly<{ path: string; sha256: string }>;
  readonly firmware: Readonly<Record<string, string | boolean>>;
  readonly readme: Readonly<{ path: string; sha256: string }>;
  readonly bootLogs: readonly Readonly<{ bootId: string; sha256: string }>[];
  readonly strictReceipts: Readonly<{
    samplesPerCellPerBoot: number;
    cells: readonly Readonly<{ role: string; paths: readonly string[]; sha256: readonly string[] }>[];
  }>;
  readonly adoptedCallback: Readonly<Record<string, string | number>>;
  readonly claimBoundary: Readonly<Record<string, string | number | boolean>>;
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

const zeroCounters = JSON.stringify({
  ibus: { accesses: 0, misses: 0 },
  dbus: { accesses: 0, flashMisses: 0, psramMisses: 0 },
});

describe("exact ESP32-S3 BBPLL ROM callback adoption", () => {
  test("binds the previous callback adoption and two strict hardware boots", () => {
    const value = manifest();
    expect(value.status).toBe("adopted");
    expect(sha256(readFileSync(join(evidenceDirectory, value.priorAdoption.path))))
      .toBe(value.priorAdoption.sha256);
    expect(sha256(readFileSync(join(evidenceDirectory, value.readme.path)))).toBe(value.readme.sha256);
    const parsed = [...receipts(value).values()].flat();
    expect(parsed).toHaveLength(4);
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
    expect(value.firmware.evidenceCommit).toBe("5834f94f8fda111cca6717e36749a6b4ceb71038");
  });

  test("adopts only the one-shot replay class at 836 cycles", () => {
    const value = manifest();
    const byRole = receipts(value);
    for (const baseline of byRole.get("baseline")!) {
      expect(new Set(baseline.measurement.samples.map((sample) => sample.cycles))).toEqual(new Set([28]));
    }
    for (const target of byRole.get("target")!) {
      expect(target.measurement.samples[0]?.cycles).toBe(864);
      expect(new Set(target.measurement.samples.slice(1).map((sample) => sample.cycles))).toEqual(new Set([863]));
    }
    expect(864 - 28).toBe(836);
    expect(863 - 28).toBe(835);
    expect([...byRole.values()].flat().every((receipt) => receipt.measurement.samples.every((sample) =>
      JSON.stringify(sample.cacheCounters) === zeroCounters
    ))).toBe(true);
    expect(value.adoptedCallback).toEqual({
      kind: "bbpllRomWrite",
      pc: "0x40005d60",
      block: 0x66,
      hostId: 1,
      register: 4,
      data: 0x6b,
      callinc: 2,
      currentIntlevel: 3,
      priorIntlevelRestoreCount: 1,
      priorWriteCount: 0,
      cycles: 836,
    });
    expect(value.claimBoundary).toEqual({
      exactCallbackPcAndArgumentsOnly: true,
      oneShotResetStateInvocationOnly: true,
      preflightAndPostReadValue: 0x6b,
      matchedBaselineSubtracted: true,
      allAdoptedCacheCountersZero: true,
      warmedRepeatGeneralized: false,
      otherRomCallbacksCalibrated: false,
      architectureCycleAccurate: false,
    });
  });
});
