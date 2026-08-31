import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseHardwareCalibrationReceipt, type ParsedHardwareCalibrationReceipt } from "./calibration";
import { parseTimingProfile } from "./consumer";

const evidenceDirectory = join(import.meta.dir, "evidence");
const manifestPath = join(
  evidenceDirectory,
  "esp32s3-rev02-tinydraw-d42615b-xtos-intlevel-adoption.json",
);
const profilePath = join(import.meta.dir, "../timing.json");

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

function exactCycles(group: readonly ParsedHardwareCalibrationReceipt[]): number {
  const values = new Set(group.flatMap((receipt) => receipt.measurement.samples.map((sample) => sample.cycles)));
  expect(values.size).toBe(1);
  return [...values][0]!;
}

const zeroCounters = JSON.stringify({
  ibus: { accesses: 0, misses: 0 },
  dbus: { accesses: 0, flashMisses: 0, psramMisses: 0 },
});

describe("exact ESP32-S3 _xtos_set_intlevel adoption", () => {
  test("binds the prior callback profile and four strict receipts from two clean boots", () => {
    const value = manifest();
    expect(value.status).toBe("adopted");
    expect(sha256(readFileSync(join(evidenceDirectory, value.priorAdoption.path))))
      .toBe(value.priorAdoption.sha256);
    expect(sha256(readFileSync(join(evidenceDirectory, value.readme.path)))).toBe(value.readme.sha256);
    const parsed = [...receipts(value).values()].flat();
    expect(parsed).toHaveLength(4);
    expect(parsed.every((receipt) => receipt.git.dirty === false)).toBe(true);
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
    expect(value.firmware.evidenceCommit).toBe("4b5385af65a1933a896d9ec68aee451bfaa57104");
  });

  test("adopts only the exact INTLEVEL3 CALLINC2 restore class at 15 cycles", () => {
    const value = manifest();
    const byRole = receipts(value);
    expect(exactCycles(byRole.get("baseline")!)).toBe(34);
    expect(exactCycles(byRole.get("target")!)).toBe(49);
    expect(49 - 34).toBe(15);
    expect([...byRole.values()].flat().every((receipt) => receipt.measurement.samples.every((sample) =>
      JSON.stringify(sample.cacheCounters) === zeroCounters
    ))).toBe(true);
    expect(value.adoptedCallback).toEqual({
      kind: "intlevelRestore",
      pc: "0x40001c38",
      restorePs: "0x00040c00",
      previousPs: "0x00040c03",
      callinc: 2,
      cycles: 15,
    });

    const profile = parseTimingProfile(JSON.parse(readFileSync(profilePath, "utf8")));
    expect(profile.romCallbackCycles.evidence).toBe(
      "packs/esp32-s3-touch-amoled-18/timing/evidence/" +
        "esp32s3-rev02-tinydraw-d42615b-xtos-intlevel-adoption.json",
    );
    expect(profile.romCallbackCycles.entries.filter((entry) => entry.kind === "intlevelRestore"))
      .toEqual([value.adoptedCallback]);
    expect(value.claimBoundary).toEqual({
      exactCallbackPcAndArgumentsOnly: true,
      callerInterruptLevel: 3,
      immediateCallerPsRestoreChecked: true,
      matchedBaselineSubtracted: true,
      allAdoptedCacheCountersZero: true,
      otherPsValuesGeneralized: false,
      otherRomCallbacksCalibrated: false,
      architectureCycleAccurate: false,
    });
  });
});
