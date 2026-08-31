import { describe, expect, test } from "bun:test";

import { analyzeDcacheBurstReceiptJson } from "./dcache-burst-analysis";

const LINE_COUNTS = [1, 2, 4, 8, 16] as const;
const PATHS = ["flash", "psram"] as const;
const PENALTIES = {
  "boot-a": [100, 130, 190, 310, 550],
  "boot-b": [110, 145, 211, 351, 623],
} as const;

function receiptJson(
  bootId: keyof typeof PENALTIES,
  path: (typeof PATHS)[number],
  lines: (typeof LINE_COUNTS)[number],
  residency: "hot" | "cold",
): string {
  const core = 0;
  const hotCycles = 20 + lines;
  const penalty = PENALTIES[bootId][LINE_COUNTS.indexOf(lines)]!;
  const cycles = hotCycles + (residency === "cold" ? penalty : 0);
  const targetMisses = residency === "cold" ? lines : 0;
  return JSON.stringify({
    schemaVersion: 1,
    receiptKind: "esp32s3-hardware-calibration",
    captureMode: "hardware",
    capturedAt: bootId === "boot-a" ? "2026-08-31T01:00:00.000Z" : "2026-08-31T02:00:00.000Z",
    git: {
      repository: "https://github.com/aliceisjustplaying/tinydraw.git",
      commit: "0123456789abcdef0123456789abcdef01234567",
      dirty: false,
    },
    toolchain: {
      target: "esp32s3",
      espIdfVersion: "v6.0.2",
      compiler: "GNU",
      compilerVersion: "15.2.0",
    },
    sdkconfig: {
      path: "esp32/sdkconfig.timing-probe.defaults",
      sha256: "a".repeat(64),
      cpuHz: 240_000_000,
      psramMode: "octal",
      psramBusHz: 80_000_000,
      flashMode: "qio",
      flashBusHz: 80_000_000,
    },
    boot: {
      bootId,
      bootLogSha256: (bootId === "boot-a" ? "b" : "c").repeat(64),
      resetReason: "usb",
      chipModel: "ESP32-S3",
      chipRevision: 2,
      cpuCores: 2,
      psramBytes: 8 * 1024 * 1024,
      flashBytes: 16 * 1024 * 1024,
    },
    counter: { source: "xtensa-ccount", bits: 32, hz: 240_000_000, core },
    measurement: {
      kind: "ccount-kernel",
      kernel: `dcache_${path}_burst_${lines}_lines_${residency}_single_core`,
      memoryPath: `${path}-to-internal`,
      bytesPerIteration: lines * 4,
      iterationsPerSample: 1,
      warmupIterations: residency === "hot" ? 8 : 0,
      samples: Array.from({ length: 100 }, (_, ordinal) => {
        const startCcount = 1000 + ordinal * 1000;
        return {
          ordinal,
          startCore: core,
          endCore: core,
          startCcount,
          endCcount: startCcount + cycles,
          cycles,
          cacheCounters: {
            ibus: { accesses: 0, misses: 0 },
            dbus: {
              accesses: lines,
              flashMisses: path === "flash" ? targetMisses : 0,
              psramMisses: path === "psram" ? targetMisses : 0,
            },
          },
        };
      }),
    },
  });
}

function cohort(): string[] {
  const receipts: string[] = [];
  for (const bootId of ["boot-a", "boot-b"] as const) {
    for (const path of PATHS) {
      for (const lines of LINE_COUNTS) {
        receipts.push(receiptJson(bootId, path, lines, "hot"));
        receipts.push(receiptJson(bootId, path, lines, "cold"));
      }
    }
  }
  return receipts;
}

function mutateReceipt(
  json: string,
  mutate: (receipt: Record<string, any>) => void,
): string {
  const receipt = JSON.parse(json) as Record<string, any>;
  mutate(receipt);
  return JSON.stringify(receipt);
}

describe("deterministic D-cache burst analysis", () => {
  test("reports per-boot and pooled penalties, interval estimates, and exact residuals", () => {
    const receipts = cohort();
    const forward = analyzeDcacheBurstReceiptJson(receipts);
    const reverse = analyzeDcacheBurstReceiptJson([...receipts].reverse());
    expect(forward.json).toBe(reverse.json);
    expect(forward.analysis).toMatchObject({
      analysisVersion: 1,
      status: "analysis-only",
      review: {
        microbenchmarkToArchitecturalCost: "unreviewed",
        cacheClaim: "not-claimed",
        costAdoption: "none",
      },
      estimator: "nearest-rank-median(cold)-nearest-rank-median(hot)",
      receiptCount: 40,
      bootCount: 2,
    });
    const flash = forward.analysis.paths[0]!;
    expect(flash.path).toBe("flash");
    expect(flash.perBoot[0]!.series.penalties.map((point) => point.coldMinusHotCycles)).toEqual([
      "100",
      "130",
      "190",
      "310",
      "550",
    ]);
    expect(
      flash.perBoot[0]!.series.intervalEstimates.map((interval) => interval.cyclesPerAdditionalLine),
    ).toEqual([
      { numerator: "30", denominator: "1" },
      { numerator: "30", denominator: "1" },
      { numerator: "30", denominator: "1" },
      { numerator: "30", denominator: "1" },
    ]);
    expect(flash.perBoot[0]!.series.fixedFirstLineFit).toMatchObject({
      intervalCyclesPerLine: { numerator: "30", denominator: "1" },
      residualSumSquaresCyclesSquared: { numerator: "0", denominator: "1" },
    });
    expect(flash.perBoot[1]!.series.firstLinePenaltyCycles).toBe("110");
    expect(flash.perBoot[1]!.series.fixedFirstLineFit).toEqual({
      model: "penalty(N)=P1+(N-1)*interval",
      intervalCyclesPerLine: { numerator: "2430", denominator: "71" },
      residuals: [
        { lines: 1, cycles: { numerator: "0", denominator: "1" } },
        { lines: 2, cycles: { numerator: "55", denominator: "71" } },
        { lines: 4, cycles: { numerator: "-119", denominator: "71" } },
        { lines: 8, cycles: { numerator: "101", denominator: "71" } },
        { lines: 16, cycles: { numerator: "-27", denominator: "71" } },
      ],
      residualSumSquaresCyclesSquared: { numerator: "396", denominator: "71" },
    });
    expect(flash.pooled.firstLinePenaltyCycles).toBe("100");
    expect(flash.pooled.samplesPerCell).toBe(200);
    expect(forward.analysis.paths[1]!.path).toBe("psram");
    expect(forward.json).not.toContain('"calibrated"');
  });

  test("rejects incomplete, duplicate, and provenance-mismatched cohorts", () => {
    const incomplete = cohort();
    incomplete.pop();
    expect(() => analyzeDcacheBurstReceiptJson(incomplete)).toThrow("must contain all 20 hot/cold burst cells");

    const duplicated = cohort();
    duplicated.push(duplicated[0]!);
    expect(() => analyzeDcacheBurstReceiptJson(duplicated)).toThrow("duplicate receipt");

    const drift = cohort();
    drift[20] = mutateReceipt(drift[20]!, (receipt) => {
      receipt.git.commit = "f".repeat(40);
    });
    expect(() => analyzeDcacheBurstReceiptJson(drift)).toThrow(
      "cohort provenance must agree across every cell",
    );
  });

  test("requires exact hot, cold, and wrong-path miss signatures on every sample", () => {
    const hotMiss = cohort();
    hotMiss[0] = mutateReceipt(hotMiss[0]!, (receipt) => {
      receipt.measurement.samples[4].cacheCounters.dbus.flashMisses = 1;
    });
    expect(() => analyzeDcacheBurstReceiptJson(hotMiss)).toThrow(
      "requires flashMisses=0 and psramMisses=0",
    );

    const shortCold = cohort();
    shortCold[3] = mutateReceipt(shortCold[3]!, (receipt) => {
      receipt.measurement.samples[7].cacheCounters.dbus.flashMisses = 1;
    });
    expect(() => analyzeDcacheBurstReceiptJson(shortCold)).toThrow(
      "requires flashMisses=2 and psramMisses=0",
    );

    const wrongPath = cohort();
    wrongPath[19] = mutateReceipt(wrongPath[19]!, (receipt) => {
      receipt.measurement.samples[9].cacheCounters.dbus.accesses = 17;
      receipt.measurement.samples[9].cacheCounters.dbus.flashMisses = 1;
    });
    expect(() => analyzeDcacheBurstReceiptJson(wrongPath)).toThrow(
      "requires psramMisses=16 and flashMisses=0",
    );

    const absent = cohort();
    absent[0] = mutateReceipt(absent[0]!, (receipt) => {
      for (const sample of receipt.measurement.samples) delete sample.cacheCounters;
    });
    expect(() => analyzeDcacheBurstReceiptJson(absent)).toThrow("requires cache counters");
  });

  test("keeps strict receipt and descriptor validation at the boundary", () => {
    const dirty = cohort();
    dirty[0] = mutateReceipt(dirty[0]!, (receipt) => {
      receipt.git.dirty = true;
    });
    expect(() => analyzeDcacheBurstReceiptJson(dirty)).toThrow("$.git.dirty must be false");

    const descriptor = cohort();
    descriptor[0] = mutateReceipt(descriptor[0]!, (receipt) => {
      receipt.measurement.bytesPerIteration = 64;
    });
    expect(() => analyzeDcacheBurstReceiptJson(descriptor)).toThrow(
      "measurement descriptor does not match",
    );
  });
});
