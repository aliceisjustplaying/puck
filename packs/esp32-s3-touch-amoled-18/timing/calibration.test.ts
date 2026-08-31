import { describe, expect, test } from "bun:test";

import {
  aggregateCalibrationCohort,
  buildCalibrationCandidates,
  parseHardwareCalibrationReceipt,
} from "./calibration";

const UINT32_MODULUS = 0x1_0000_0000;
const DEFAULT_CYCLES = Array.from({ length: 100 }, (_, index) => index + 1);

interface ReceiptOptions {
  readonly bootId?: string;
  readonly logHash?: string;
  readonly capturedAt?: string;
  readonly cycles?: readonly number[];
  readonly wrapFirst?: boolean;
  readonly dirty?: boolean;
  readonly commit?: string;
  readonly compilerVersion?: string;
  readonly sdkconfigSha256?: string;
  readonly psramBusHz?: number | null;
  readonly flashBusHz?: number | null;
  readonly chipRevision?: number;
  readonly bytesPerIteration?: number;
  readonly kernel?: string;
  readonly counterCore?: 0 | 1;
  readonly cacheCounters?: boolean;
}

function receiptValue(options: ReceiptOptions = {}): Record<string, unknown> {
  const cycles = options.cycles ?? DEFAULT_CYCLES;
  const core = options.counterCore ?? 0;
  const samples = cycles.map((sampleCycles, ordinal) => {
    const startCcount = options.wrapFirst && ordinal === 0 ? UINT32_MODULUS - 6 : 1000 + ordinal * 1000;
    return {
      ordinal,
      startCore: core,
      endCore: core,
      startCcount,
      endCcount: (startCcount + sampleCycles) % UINT32_MODULUS,
      cycles: sampleCycles,
      ...(options.cacheCounters
        ? {
            cacheCounters: {
              ibus: { accesses: ordinal + 1, misses: ordinal % 2 },
              dbus: { accesses: 2 * (ordinal + 1), flashMisses: 1, psramMisses: 0 },
            },
          }
        : {}),
    };
  });
  return {
    schemaVersion: 1,
    receiptKind: "esp32s3-hardware-calibration",
    captureMode: "hardware",
    capturedAt: options.capturedAt ?? "2026-08-30T20:00:00.000Z",
    git: {
      repository: "https://github.com/aliceisjustplaying/tinydraw.git",
      commit: options.commit ?? "0123456789abcdef0123456789abcdef01234567",
      dirty: options.dirty ?? false,
    },
    toolchain: {
      target: "esp32s3",
      espIdfVersion: "v6.0.2",
      compiler: "GNU",
      compilerVersion: options.compilerVersion ?? "15.2.0",
    },
    sdkconfig: {
      path: "esp32/sdkconfig.defaults",
      sha256: options.sdkconfigSha256 ?? "a".repeat(64),
      cpuHz: 240_000_000,
      psramMode: "octal",
      psramBusHz: options.psramBusHz === undefined ? 80_000_000 : options.psramBusHz,
      flashMode: "qio",
      flashBusHz: options.flashBusHz === undefined ? 80_000_000 : options.flashBusHz,
    },
    boot: {
      bootId: options.bootId ?? "boot-a",
      bootLogSha256: options.logHash ?? "b".repeat(64),
      resetReason: "power-on",
      chipModel: "ESP32-S3",
      chipRevision: options.chipRevision ?? 1,
      cpuCores: 2,
      psramBytes: 8 * 1024 * 1024,
      flashBytes: 16 * 1024 * 1024,
    },
    counter: {
      source: "xtensa-ccount",
      bits: 32,
      hz: 240_000_000,
      core,
    },
    measurement: {
      kind: "ccount-kernel",
      kernel: options.kernel ?? "sram_aligned_stream_single_core",
      memoryPath: "internal-to-internal",
      bytesPerIteration: options.bytesPerIteration ?? 4,
      iterationsPerSample: 1,
      warmupIterations: 8,
      samples,
    },
  };
}

function parse(options: ReceiptOptions = {}) {
  return parseHardwareCalibrationReceipt(JSON.stringify(receiptValue(options)));
}

describe("hardware receipt adoption boundary", () => {
  test("accepts an exact uint32 wraparound and retains receipt and boot-log hashes", () => {
    const cycles = [11, ...Array(99).fill(8)];
    const parsed = parse({ cycles, wrapFirst: true });
    expect(parsed.measurement.samples[0]).toEqual({
      ordinal: 0,
      startCore: 0,
      endCore: 0,
      startCcount: UINT32_MODULUS - 6,
      endCcount: 5,
      cycles: 11,
    });
    expect(parsed.receiptSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(parsed.boot.bootLogSha256).toBe("b".repeat(64));
  });

  test("retains strict uint32 cache counters and rejects mixed sample presence", () => {
    const parsed = parse({ cacheCounters: true });
    expect(parsed.measurement.samples[0]!.cacheCounters).toEqual({
      ibus: { accesses: 1, misses: 0 },
      dbus: { accesses: 2, flashMisses: 1, psramMisses: 0 },
    });

    const boundary = receiptValue({ cacheCounters: true });
    const boundarySample = ((boundary.measurement as Record<string, unknown>).samples as Record<
      string,
      unknown
    >[])[0]!;
    (boundarySample.cacheCounters as { ibus: { accesses: number } }).ibus.accesses = UINT32_MODULUS - 1;
    expect(parseHardwareCalibrationReceipt(JSON.stringify(boundary)).measurement.samples[0]!.cacheCounters)
      .toMatchObject({ ibus: { accesses: UINT32_MODULUS - 1 } });

    const mixed = receiptValue({ cacheCounters: true });
    const mixedSample = ((mixed.measurement as Record<string, unknown>).samples as Record<string, unknown>[])[1]!;
    delete mixedSample.cacheCounters;
    expect(() => parseHardwareCalibrationReceipt(JSON.stringify(mixed))).toThrow(
      "must either all include cacheCounters or all omit it",
    );

    const overflow = receiptValue({ cacheCounters: true });
    const overflowSample = ((overflow.measurement as Record<string, unknown>).samples as Record<
      string,
      unknown
    >[])[0]!;
    const counters = overflowSample.cacheCounters as { ibus: { accesses: number } };
    counters.ibus.accesses = UINT32_MODULUS;
    expect(() => parseHardwareCalibrationReceipt(JSON.stringify(overflow))).toThrow(
      "$.measurement.samples[0].cacheCounters.ibus.accesses must be an integer from 0 through 4294967295",
    );

    const impossibleIbus = receiptValue({ cacheCounters: true });
    const impossibleIbusSample = ((impossibleIbus.measurement as Record<string, unknown>)
      .samples as Record<string, unknown>[])[0]!;
    (impossibleIbusSample.cacheCounters as { ibus: { misses: number } }).ibus.misses = 2;
    expect(() => parseHardwareCalibrationReceipt(JSON.stringify(impossibleIbus))).toThrow(
      "$.measurement.samples[0].cacheCounters.ibus.misses must not exceed $.measurement.samples[0].cacheCounters.ibus.accesses",
    );

    const impossibleDbus = receiptValue({ cacheCounters: true });
    const impossibleDbusSample = ((impossibleDbus.measurement as Record<string, unknown>)
      .samples as Record<string, unknown>[])[0]!;
    (impossibleDbusSample.cacheCounters as { dbus: { psramMisses: number } }).dbus.psramMisses = 2;
    expect(() => parseHardwareCalibrationReceipt(JSON.stringify(impossibleDbus))).toThrow(
      "$.measurement.samples[0].cacheCounters.dbus flashMisses plus psramMisses must not exceed accesses for a bounded probe",
    );

    const drift = receiptValue({ cacheCounters: true });
    const driftSample = ((drift.measurement as Record<string, unknown>).samples as Record<string, unknown>[])[0]!;
    (driftSample.cacheCounters as { dbus: Record<string, unknown> }).dbus.unexpected = 1;
    expect(() => parseHardwareCalibrationReceipt(JSON.stringify(drift))).toThrow(
      "$.measurement.samples[0].cacheCounters.dbus keys must be exactly",
    );
  });

  test("rejects dirty builds and schema drift", () => {
    expect(() => parse({ dirty: true })).toThrow("$.git.dirty must be false");
    const fixture = receiptValue();
    fixture.captureMode = "schema-fixture";
    expect(() => parseHardwareCalibrationReceipt(JSON.stringify(fixture))).toThrow(
      '$.captureMode must be "hardware"',
    );
    const value = receiptValue();
    (value.git as Record<string, unknown>).branch = "main";
    expect(() => parseHardwareCalibrationReceipt(JSON.stringify(value))).toThrow(
      "$.git keys must be exactly",
    );
  });

  test("requires configured PSRAM and flash bus frequencies", () => {
    expect(() => parse({ psramBusHz: null })).toThrow("$.sdkconfig.psramBusHz");
    expect(() => parse({ flashBusHz: null })).toThrow("$.sdkconfig.flashBusHz");
    const unknownMode = receiptValue();
    (unknownMode.sdkconfig as Record<string, unknown>).flashMode = "unknown";
    expect(() => parseHardwareCalibrationReceipt(JSON.stringify(unknownMode))).toThrow(
      "$.sdkconfig.flashMode must be one of",
    );
  });

  test("rejects short, misordered, cross-core, and incorrect-delta sample sets", () => {
    expect(() => parse({ cycles: DEFAULT_CYCLES.slice(0, 99) })).toThrow("at least 100 samples");

    const misordered = receiptValue();
    ((misordered.measurement as Record<string, unknown>).samples as Record<string, unknown>[])[1]!.ordinal = 9;
    expect(() => parseHardwareCalibrationReceipt(JSON.stringify(misordered))).toThrow(
      "must equal its zero-based array index 1",
    );

    const crossCore = receiptValue();
    ((crossCore.measurement as Record<string, unknown>).samples as Record<string, unknown>[])[0]!.endCore = 1;
    expect(() => parseHardwareCalibrationReceipt(JSON.stringify(crossCore))).toThrow("must not cross CPU cores");

    const wrongCore = receiptValue();
    (wrongCore.counter as Record<string, unknown>).core = 1;
    expect(() => parseHardwareCalibrationReceipt(JSON.stringify(wrongCore))).toThrow(
      "must equal $.counter.core",
    );

    const wrongClock = receiptValue();
    (wrongClock.counter as Record<string, unknown>).hz = 160_000_000;
    expect(() => parseHardwareCalibrationReceipt(JSON.stringify(wrongClock))).toThrow(
      "$.counter.hz must equal $.sdkconfig.cpuHz",
    );

    const wrongDelta = receiptValue();
    ((wrongDelta.measurement as Record<string, unknown>).samples as Record<string, unknown>[])[0]!.cycles = 2;
    expect(() => parseHardwareCalibrationReceipt(JSON.stringify(wrongDelta))).toThrow(
      "unsigned 32-bit CCOUNT delta 1",
    );
  });
});

describe("calibration cohorts", () => {
  test("rejects provenance and descriptor drift", () => {
    const baseline = parse({ bootId: "boot-a", logHash: "a".repeat(64) });
    const driftCases = [
      parse({ bootId: "boot-b", logHash: "b".repeat(64), commit: "f".repeat(40) }),
      parse({ bootId: "boot-b", logHash: "b".repeat(64), compilerVersion: "15.3.0" }),
      parse({ bootId: "boot-b", logHash: "b".repeat(64), sdkconfigSha256: "c".repeat(64) }),
      parse({ bootId: "boot-b", logHash: "b".repeat(64), psramBusHz: 40_000_000 }),
      parse({ bootId: "boot-b", logHash: "b".repeat(64), chipRevision: 2 }),
    ];
    for (const drift of driftCases) {
      expect(() => aggregateCalibrationCohort([baseline, drift])).toThrow("cohort provenance must agree");
    }
    const descriptorDrift = parse({
      bootId: "boot-b",
      logHash: "b".repeat(64),
      bytesPerIteration: 8,
    });
    expect(() => aggregateCalibrationCohort([baseline, descriptorDrift])).toThrow(
      "measurement descriptors must agree exactly",
    );
    const sampleCountDrift = parse({
      bootId: "boot-b",
      logHash: "b".repeat(64),
      cycles: [...DEFAULT_CYCLES, 101],
    });
    expect(() => aggregateCalibrationCohort([baseline, sampleCountDrift])).toThrow(
      "sample counts must agree exactly",
    );
  });

  test("uses deterministic exact nearest-rank quantiles and rational byte costs", () => {
    const first = parse({ bootId: "boot-a", logHash: "a".repeat(64), cycles: DEFAULT_CYCLES });
    const second = parse({
      bootId: "boot-b",
      logHash: "b".repeat(64),
      capturedAt: "2026-08-30T20:01:00.000Z",
      cycles: DEFAULT_CYCLES,
    });
    const candidate = aggregateCalibrationCohort([second, first]);
    const reordered = aggregateCalibrationCohort([first, second]);

    expect(candidate).toEqual(reordered);
    expect(candidate.samples.count).toBe(200);
    expect(candidate.samples.cycles).toEqual({ min: 1n, p50: 50n, p90: 90n, p99: 99n, max: 100n });
    expect(candidate.samples.cyclesPerByte).toEqual({
      min: { numerator: 1n, denominator: 4n },
      p50: { numerator: 25n, denominator: 2n },
      p90: { numerator: 45n, denominator: 2n },
      p99: { numerator: 99n, denominator: 4n },
      max: { numerator: 25n, denominator: 1n },
    });
    expect(candidate.evidence.bootIds).toEqual(["boot-a", "boot-b"]);
    expect(candidate.review).toEqual({
      microbenchmarkToArchitecturalCost: "unreviewed",
      cacheClaim: "not-claimed",
      isaClaim: "not-claimed",
    });
  });

  test("summarizes cache counters with exact multivariate sufficient statistics", () => {
    const first = parse({
      bootId: "boot-a",
      logHash: "a".repeat(64),
      cycles: DEFAULT_CYCLES,
      cacheCounters: true,
    });
    const second = parse({
      bootId: "boot-b",
      logHash: "b".repeat(64),
      capturedAt: "2026-08-30T20:01:00.000Z",
      cycles: DEFAULT_CYCLES,
      cacheCounters: true,
    });
    const counters = aggregateCalibrationCohort([second, first]).samples.cacheCounters;

    expect(counters).toEqual({
      count: 200,
      cyclesTotal: 10100n,
      cyclesSquaredTotal: 676700n,
      predictorOrder: [
        "ibus.accesses",
        "ibus.misses",
        "dbus.accesses",
        "dbus.flashMisses",
        "dbus.psramMisses",
      ],
      gramMatrix: [
        [676700n, 5100n, 1353400n, 10100n, 0n],
        [5100n, 100n, 10200n, 100n, 0n],
        [1353400n, 10200n, 2706800n, 20200n, 0n],
        [10100n, 100n, 20200n, 200n, 0n],
        [0n, 0n, 0n, 0n, 0n],
      ],
      ibus: {
        accesses: {
          total: 10100n,
          squaredTotal: 676700n,
          cycleProductTotal: 676700n,
          values: { min: 1n, p50: 50n, p90: 90n, p99: 99n, max: 100n },
        },
        misses: {
          total: 100n,
          squaredTotal: 100n,
          cycleProductTotal: 5100n,
          values: { min: 0n, p50: 0n, p90: 1n, p99: 1n, max: 1n },
        },
      },
      dbus: {
        accesses: {
          total: 20200n,
          squaredTotal: 2706800n,
          cycleProductTotal: 1353400n,
          values: { min: 2n, p50: 100n, p90: 180n, p99: 198n, max: 200n },
        },
        flashMisses: {
          total: 200n,
          squaredTotal: 200n,
          cycleProductTotal: 10100n,
          values: { min: 1n, p50: 1n, p90: 1n, p99: 1n, max: 1n },
        },
        psramMisses: {
          total: 0n,
          squaredTotal: 0n,
          cycleProductTotal: 0n,
          values: { min: 0n, p50: 0n, p90: 0n, p99: 0n, max: 0n },
        },
      },
    });
    expect(() => aggregateCalibrationCohort([first, parse({ bootId: "boot-b" })])).toThrow(
      "cache-counter presence must agree exactly across receipts",
    );
  });

  test("keeps uint32 counter maxima exact in products and cohort totals", () => {
    interface HardwareCounters {
      ibus: { accesses: number; misses: number };
      dbus: { accesses: number; flashMisses: number; psramMisses: number };
    }
    const maximum = UINT32_MODULUS - 1;
    const maximumReceipt = (options: ReceiptOptions) => {
      const value = receiptValue({ ...options, cacheCounters: true });
      const samples = (value.measurement as { samples: { cacheCounters: HardwareCounters }[] }).samples;
      for (const sample of samples) {
        sample.cacheCounters = {
          ibus: { accesses: maximum, misses: maximum },
          dbus: { accesses: maximum, flashMisses: maximum, psramMisses: 0 },
        };
      }
      return parseHardwareCalibrationReceipt(JSON.stringify(value));
    };
    const first = maximumReceipt({ bootId: "boot-a", logHash: "a".repeat(64) });
    const second = maximumReceipt({
      bootId: "boot-b",
      logHash: "b".repeat(64),
      capturedAt: "2026-08-30T20:01:00.000Z",
    });
    const counters = aggregateCalibrationCohort([first, second]).samples.cacheCounters!;
    const maximumBigInt = BigInt(maximum);

    expect(counters.ibus.accesses.total).toBe(maximumBigInt * 200n);
    expect(counters.ibus.accesses.cycleProductTotal).toBe(maximumBigInt * 10100n);
    expect(counters.gramMatrix[0]![0]).toBe(maximumBigInt * maximumBigInt * 200n);
    expect(counters.gramMatrix[0]![4]).toBe(0n);
  });

  test("requires two distinct boots and rejects duplicate boot/measurement pairs", () => {
    const first = parse({ bootId: "boot-a", logHash: "a".repeat(64) });
    expect(() => aggregateCalibrationCohort([first])).toThrow("at least two receipts");
    const duplicateBoot = parse({
      bootId: "boot-a",
      logHash: "c".repeat(64),
      capturedAt: "2026-08-30T20:02:00.000Z",
    });
    expect(() => aggregateCalibrationCohort([first, duplicateBoot])).toThrow("duplicate boot/measurement");
    expect(() => buildCalibrationCandidates([first, duplicateBoot])).toThrow("duplicate boot/measurement");
  });

  test("keeps zero-byte instruction probes out of byte-cost and ISA claims", () => {
    const first = parse({
      bootId: "boot-a",
      logHash: "a".repeat(64),
      kernel: "flash_instruction_hot_single_core",
      bytesPerIteration: 0,
    });
    const second = parse({
      bootId: "boot-b",
      logHash: "b".repeat(64),
      kernel: "flash_instruction_hot_single_core",
      bytesPerIteration: 0,
    });
    const candidate = aggregateCalibrationCohort([first, second]);
    expect(candidate.samples.bytesPerSample).toBe(0n);
    expect(candidate.samples.cyclesPerByte).toBeNull();
    expect(candidate.review.isaClaim).toBe("not-claimed");
  });

  test("groups multiple measurement identities deterministically", () => {
    const receipts = [
      parse({ bootId: "boot-b", logHash: "b".repeat(64), kernel: "z-kernel" }),
      parse({ bootId: "boot-a", logHash: "a".repeat(64), kernel: "a-kernel" }),
      parse({ bootId: "boot-a", logHash: "a".repeat(64), kernel: "z-kernel" }),
      parse({ bootId: "boot-b", logHash: "b".repeat(64), kernel: "a-kernel" }),
    ];
    expect(buildCalibrationCandidates(receipts).map((candidate) => candidate.measurement.kernel)).toEqual([
      "a-kernel",
      "z-kernel",
    ]);
  });
});
