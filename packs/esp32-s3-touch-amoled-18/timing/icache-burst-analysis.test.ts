import { describe, expect, test } from "bun:test";

import { analyzeIcacheBurstReceiptJson } from "./icache-burst-analysis";

const LINE_COUNTS = [1, 2, 4, 8] as const;
const HOT_CYCLES = [14, 30, 62, 126] as const;
const PENALTIES = [204, 469, 1002, 2065] as const;

function receiptJson(
  boot: "boot-a" | "boot-b",
  lines: (typeof LINE_COUNTS)[number],
  residency: "hot" | "cold",
): string {
  const lineIndex = LINE_COUNTS.indexOf(lines);
  const cycles = HOT_CYCLES[lineIndex]! + (residency === "cold" ? PENALTIES[lineIndex]! : 0);
  return JSON.stringify({
    schemaVersion: 1,
    receiptKind: "esp32s3-hardware-calibration",
    captureMode: "hardware",
    capturedAt: boot === "boot-a" ? "2026-08-31T01:00:00.000Z" : "2026-08-31T02:00:00.000Z",
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
      bootId: boot,
      bootLogSha256: (boot === "boot-a" ? "b" : "c").repeat(64),
      resetReason: "usb",
      chipModel: "ESP32-S3",
      chipRevision: 2,
      cpuCores: 2,
      psramBytes: 8 * 1024 * 1024,
      flashBytes: 16 * 1024 * 1024,
    },
    counter: { source: "xtensa-ccount", bits: 32, hz: 240_000_000, core: 0 },
    measurement: {
      kind: "ccount-kernel",
      kernel: `icache_flash_burst_${lines}_lines_${residency}_single_core`,
      memoryPath: "other",
      bytesPerIteration: 0,
      iterationsPerSample: 1,
      warmupIterations: residency === "hot" ? 8 : 0,
      samples: Array.from({ length: 100 }, (_, ordinal) => {
        const startCcount = 1000 + ordinal * 10_000;
        return {
          ordinal,
          startCore: 0,
          endCore: 0,
          startCcount,
          endCcount: startCcount + cycles,
          cycles,
          cacheCounters: {
            ibus: { accesses: 4 * lines + 1, misses: residency === "cold" ? lines : 0 },
            dbus: { accesses: 0, flashMisses: 0, psramMisses: 0 },
          },
        };
      }),
    },
  });
}

function cohort(): string[] {
  return (["boot-a", "boot-b"] as const).flatMap((boot) =>
    LINE_COUNTS.flatMap((lines) => [
      receiptJson(boot, lines, "hot"),
      receiptJson(boot, lines, "cold"),
    ])
  );
}

function mutate(
  json: string,
  update: (receipt: Record<string, any>) => void,
): string {
  const receipt = JSON.parse(json) as Record<string, any>;
  update(receipt);
  return JSON.stringify(receipt);
}

describe("deterministic I-cache burst analysis", () => {
  test("reports exact multi-boot first-line and contiguous interval evidence", () => {
    const forward = analyzeIcacheBurstReceiptJson(cohort());
    const reverse = analyzeIcacheBurstReceiptJson(cohort().reverse());
    expect(forward.json).toBe(reverse.json);
    expect(forward.analysis).toMatchObject({
      analysisVersion: 1,
      status: "analysis-only",
      receiptCount: 16,
      bootCount: 2,
      review: { costAdoption: "none", cacheClaim: "not-claimed" },
    });
    expect(forward.analysis.pooled.penalties.map((point) => point.coldMinusHotCycles)).toEqual([
      "204",
      "469",
      "1002",
      "2065",
    ]);
    expect(forward.analysis.pooled.firstLinePenaltyCycles).toBe("204");
    expect(forward.analysis.pooled.samplesPerCell).toBe(200);
    expect(forward.analysis.pooled.intervalEstimates.map(
      (estimate) => estimate.cyclesPerAdditionalLine,
    )).toEqual([
      { numerator: "265", denominator: "1" },
      { numerator: "533", denominator: "2" },
      { numerator: "1063", denominator: "4" },
    ]);
    expect(forward.analysis.pooled.fixedFirstLineFit.intervalCyclesPerLine).toEqual({
      numerator: "15686",
      denominator: "59",
    });
    expect(forward.json).not.toContain('"calibrated"');
  });

  test("requires two complete boots and exact miss signatures", () => {
    const oneBoot = cohort().slice(0, 8);
    expect(() => analyzeIcacheBurstReceiptJson(oneBoot)).toThrow("at least two distinct boots");

    const incomplete = cohort();
    incomplete.pop();
    expect(() => analyzeIcacheBurstReceiptJson(incomplete)).toThrow("all 8 hot/cold burst cells");

    const wrongMiss = cohort();
    wrongMiss[1] = mutate(wrongMiss[1]!, (receipt) => {
      receipt.measurement.samples[0].cacheCounters.ibus.misses = 0;
    });
    expect(() => analyzeIcacheBurstReceiptJson(wrongMiss)).toThrow("wrong cache miss signature");
  });

  test("rejects descriptor and provenance drift", () => {
    const descriptor = cohort();
    descriptor[0] = mutate(descriptor[0]!, (receipt) => {
      receipt.measurement.bytesPerIteration = 4;
    });
    expect(() => analyzeIcacheBurstReceiptJson(descriptor)).toThrow("measurement descriptor");

    const provenance = cohort();
    provenance[8] = mutate(provenance[8]!, (receipt) => {
      receipt.git.commit = "f".repeat(40);
    });
    expect(() => analyzeIcacheBurstReceiptJson(provenance)).toThrow("cohort provenance");
  });
});
