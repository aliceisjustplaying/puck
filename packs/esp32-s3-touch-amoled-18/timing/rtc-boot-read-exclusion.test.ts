import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseHardwareCalibrationReceipt, type ParsedHardwareCalibrationReceipt } from "./calibration";

const evidenceRoot = join(import.meta.dir, "evidence/rtc-boot-read-70cc31a");
const profilePath = join(import.meta.dir, "../timing.json");

const receiptSha256 = Object.freeze({
  "boot-1/mmio_read_rtc_date_2048_aligned_single_core.json":
    "94dab20f1a87871744834365da8717f6a03c41a8af4f5d6728cc55b1edc91789",
  "boot-1/mmio_read_rtc_date_4096_aligned_single_core.json":
    "ee61468a68de2a2a98abdf289bc668570585f653795b9f2c24f8704d9fb6d357",
  "boot-1/mmio_read_rtc_xtal_freq_2048_aligned_single_core.json":
    "f4f0c850510fb4d7a5734bea18fd085575da22f5207ea50489bd999b1625e383",
  "boot-1/mmio_read_rtc_xtal_freq_4096_aligned_single_core.json":
    "0355caa73227984b1921a6e0947aa8e47ecd492c11db88bed5e25993ea8e392b",
  "boot-1/mmio_read_sram_2048_aligned_single_core.json":
    "4f6f56019569462e23a74dce2e913fc8a76c25d13104366f3349860a64c60234",
  "boot-1/mmio_read_sram_4096_aligned_single_core.json":
    "86e5a7a09979e6875433223e194669e4edd25b2d5b6a524d7061fc4cd553b85b",
  "boot-2/mmio_read_rtc_date_2048_aligned_single_core.json":
    "f572fdc5b338e152a272011f52482adcc4413099f7bd30eb691c86f49c44352f",
  "boot-2/mmio_read_rtc_date_4096_aligned_single_core.json":
    "6cad7893787d444739442ac0af75ab9ad6a5350cde3c3dc6e9e707e1ede92754",
  "boot-2/mmio_read_rtc_xtal_freq_2048_aligned_single_core.json":
    "bf62acd9afd32c9fb9eab184785d8c6f5e2c5bb7fbf90716a986635ec14f3333",
  "boot-2/mmio_read_rtc_xtal_freq_4096_aligned_single_core.json":
    "a8e7e61d7123a44b85066b3226b604c7f41b100e38f5e28866870a0769164bd4",
  "boot-2/mmio_read_sram_2048_aligned_single_core.json":
    "c637ae5bef7879a42830f003c9a1e92c8e78b44a6a7c319582450fadd2239e38",
  "boot-2/mmio_read_sram_4096_aligned_single_core.json":
    "4c6de2ae61b0ce5cf1744ebf85b22dbcbd28acdeea2fcf3a122857126ced3ea3",
});

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function receipts(): readonly ParsedHardwareCalibrationReceipt[] {
  return Object.entries(receiptSha256).map(([path, expectedSha256]) => {
    const bytes = readFileSync(join(evidenceRoot, path));
    expect(sha256(bytes)).toBe(expectedSha256);
    return parseHardwareCalibrationReceipt(bytes.toString("utf8"));
  });
}

function upperMedian(receipt: ParsedHardwareCalibrationReceipt): number {
  const values = receipt.measurement.samples.map((sample) => sample.cycles).sort((a, b) => a - b);
  return values[Math.floor(values.length / 2)]!;
}

function expectedCounters(kernel: string) {
  const ibusAccesses = kernel.includes("sram") ? 0 : kernel.includes("2048") ? 88 : 176;
  return {
    ibus: { accesses: ibusAccesses, misses: 0 },
    dbus: { accesses: 0, flashMisses: 0, psramMisses: 0 },
  };
}

describe("RTC boot-register exclusion evidence", () => {
  test("binds twelve strict receipts to two complete boots and exact counter signatures", () => {
    const parsed = receipts();
    expect(parsed).toHaveLength(12);
    expect(new Set(parsed.map((receipt) => receipt.git.commit))).toEqual(
      new Set(["70cc31adb84ff43641d8727a1bcd4be8fbfe7744"]),
    );
    expect(parsed.every((receipt) => receipt.git.dirty === false)).toBe(true);
    expect(new Set(parsed.map((receipt) => receipt.sdkconfig.sha256))).toEqual(
      new Set(["5befec96cb7e4dbd86a69abccf96828696b0c79cfe0b0c904d5bdc75543d3d68"]),
    );
    expect(new Set(parsed.map((receipt) => receipt.boot.bootId))).toEqual(
      new Set(["device-a-560d3850-0001986e", "device-a-6f7b4d3b-0001986e"]),
    );
    expect(new Set(parsed.map((receipt) => receipt.boot.bootLogSha256))).toEqual(
      new Set([
        "d4bb24af94cbbee2527c8a5c6bc186aed9cea760218a90d8fd41e2743746c122",
        "2443d51b62ea70db24e9e2db603fb2b00a6ca3b0355a70642de1ea986d453490",
      ]),
    );

    for (const receipt of parsed) {
      expect(receipt.measurement.samples).toHaveLength(100);
      const expected = expectedCounters(receipt.measurement.kernel);
      expect(receipt.measurement.samples.every((sample) =>
        JSON.stringify(sample.cacheCounters) === JSON.stringify(expected)
      )).toBe(true);
    }
  });

  test("keeps both asynchronous RTC reads outside the scalar MMIO profile", () => {
    const parsed = receipts();
    const byBootAndKernel = new Map(parsed.map((receipt) => [
      `${receipt.boot.bootId}:${receipt.measurement.kernel}`,
      receipt,
    ]));
    const additiveNumerators: number[] = [];
    for (const bootId of ["device-a-560d3850-0001986e", "device-a-6f7b4d3b-0001986e"]) {
      const median = (kernel: string) => upperMedian(byBootAndKernel.get(`${bootId}:${kernel}`)!);
      const sramDifference =
        median("mmio_read_sram_4096_aligned_single_core") -
        median("mmio_read_sram_2048_aligned_single_core");
      expect(sramDifference).toBe(6_144);
      for (const register of ["rtc_date", "rtc_xtal_freq"]) {
        const targetDifference =
          median(`mmio_read_${register}_4096_aligned_single_core`) -
          median(`mmio_read_${register}_2048_aligned_single_core`);
        const additiveNumerator = targetDifference - sramDifference;
        expect(additiveNumerator % 2_048).not.toBe(0);
        additiveNumerators.push(additiveNumerator);
      }
    }
    expect(additiveNumerators).toEqual([179_834, 179_921, 180_072, 180_039]);

    const profile = JSON.parse(readFileSync(profilePath, "utf8")) as {
      mmioAccessCycles: { entries: readonly { address: string }[] };
    };
    expect(profile.mmioAccessCycles.entries.some((entry) =>
      entry.address === "0x600080c0" || entry.address === "0x600081fc"
    )).toBe(false);
    expect(readFileSync(join(evidenceRoot, "README.md"), "utf8")).toContain(
      "not exact integers",
    );
  });
});
