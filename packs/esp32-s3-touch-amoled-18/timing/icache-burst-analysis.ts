import {
  exactIntegerSummary,
  parseHardwareCalibrationReceipt,
  type ParsedHardwareCalibrationReceipt,
} from "./calibration";

const LINE_COUNTS = [1, 2, 4, 8] as const;
const MEASUREMENT_PATTERN = /^icache_flash_burst_(1|2|4|8)_lines_(hot|cold)_single_core$/;

type LineCount = (typeof LINE_COUNTS)[number];
type Residency = "hot" | "cold";

interface DecimalRational {
  readonly numerator: string;
  readonly denominator: string;
}

interface BurstSeries {
  readonly samplesPerCell: number;
  readonly penalties: readonly Readonly<{
    lines: LineCount;
    hotMedianCycles: string;
    coldMedianCycles: string;
    coldMinusHotCycles: string;
  }>[];
  readonly firstLinePenaltyCycles: string;
  readonly intervalEstimates: readonly Readonly<{
    fromLines: LineCount;
    toLines: LineCount;
    additionalLines: number;
    cyclesPerAdditionalLine: DecimalRational;
  }>[];
  readonly fixedFirstLineFit: Readonly<{
    model: "penalty(N)=P1+(N-1)*interval";
    intervalCyclesPerLine: DecimalRational;
    residuals: readonly Readonly<{ lines: LineCount; cycles: DecimalRational }>[];
    residualSumSquaresCyclesSquared: DecimalRational;
  }>;
}

export interface IcacheBurstAnalysisV1 {
  readonly analysisVersion: 1;
  readonly status: "analysis-only";
  readonly review: Readonly<{
    microbenchmarkToArchitecturalCost: "unreviewed";
    cacheClaim: "not-claimed";
    costAdoption: "none";
  }>;
  readonly estimator: "nearest-rank-median(cold)-nearest-rank-median(hot)";
  readonly receiptCount: number;
  readonly bootCount: number;
  readonly cohort: Readonly<{
    repository: string;
    commit: string;
    toolchain: ParsedHardwareCalibrationReceipt["toolchain"];
    sdkconfig: ParsedHardwareCalibrationReceipt["sdkconfig"];
    chipRevision: number;
    flashBytes: number;
    counter: ParsedHardwareCalibrationReceipt["counter"];
  }>;
  readonly evidence: Readonly<{
    bootIds: readonly string[];
    bootLogSha256: readonly string[];
    receiptSha256: readonly string[];
  }>;
  readonly perBoot: readonly Readonly<{ bootId: string; series: BurstSeries }>[];
  readonly pooled: BurstSeries;
}

export interface IcacheBurstAnalysisArtifact {
  readonly analysis: IcacheBurstAnalysisV1;
  readonly json: string;
}

export class IcacheBurstAnalysisError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IcacheBurstAnalysisError";
  }
}

interface Cell {
  readonly lines: LineCount;
  readonly residency: Residency;
  readonly receipt: ParsedHardwareCalibrationReceipt;
}

function fail(message: string): never {
  throw new IcacheBurstAnalysisError(message);
}

function gcd(left: bigint, right: bigint): bigint {
  let a = left < 0n ? -left : left;
  let b = right < 0n ? -right : right;
  while (b !== 0n) [a, b] = [b, a % b];
  return a;
}

function rational(numerator: bigint, denominator: bigint): DecimalRational {
  if (denominator === 0n) fail("internal rational denominator must not be zero");
  const sign = denominator < 0n ? -1n : 1n;
  const divisor = gcd(numerator, denominator);
  return Object.freeze({
    numerator: ((numerator / divisor) * sign).toString(),
    denominator: ((denominator / divisor) * sign).toString(),
  });
}

function measurementOf(receipt: ParsedHardwareCalibrationReceipt): Omit<Cell, "receipt"> {
  const match = MEASUREMENT_PATTERN.exec(receipt.measurement.kernel);
  if (match === null) fail(`unexpected measurement kernel ${receipt.measurement.kernel}`);
  return {
    lines: Number(match[1]) as LineCount,
    residency: match[2] as Residency,
  };
}

function cohortKey(receipt: ParsedHardwareCalibrationReceipt): string {
  return JSON.stringify({
    repository: receipt.git.repository,
    commit: receipt.git.commit,
    toolchain: receipt.toolchain,
    sdkconfig: receipt.sdkconfig,
    chipRevision: receipt.boot.chipRevision,
    psramBytes: receipt.boot.psramBytes,
    flashBytes: receipt.boot.flashBytes,
    counter: receipt.counter,
  });
}

function bootKey(receipt: ParsedHardwareCalibrationReceipt): string {
  return JSON.stringify({ capturedAt: receipt.capturedAt, boot: receipt.boot });
}

function validateCell(cell: Cell): void {
  const measurement = cell.receipt.measurement;
  if (
    measurement.memoryPath !== "other" ||
    measurement.bytesPerIteration !== 0 ||
    measurement.iterationsPerSample !== 1 ||
    measurement.warmupIterations !== (cell.residency === "hot" ? 8 : 0)
  ) {
    fail(`measurement descriptor does not match ${measurement.kernel}`);
  }
  const expectedMisses = cell.residency === "cold" ? cell.lines : 0;
  for (const sample of measurement.samples) {
    const counters = sample.cacheCounters;
    if (counters === undefined) fail(`${measurement.kernel} requires cache counters`);
    if (
      counters.ibus.misses !== expectedMisses ||
      counters.dbus.flashMisses !== 0 ||
      counters.dbus.psramMisses !== 0
    ) {
      fail(`${measurement.kernel} sample ${sample.ordinal} has the wrong cache miss signature`);
    }
  }
}

function medianCycles(receipts: readonly ParsedHardwareCalibrationReceipt[]): bigint {
  return exactIntegerSummary(
    receipts.flatMap((receipt) => receipt.measurement.samples.map((sample) => BigInt(sample.cycles))),
  ).p50;
}

function buildSeries(
  hot: ReadonlyMap<LineCount, readonly ParsedHardwareCalibrationReceipt[]>,
  cold: ReadonlyMap<LineCount, readonly ParsedHardwareCalibrationReceipt[]>,
): BurstSeries {
  const penalties = new Map<LineCount, bigint>();
  const points = LINE_COUNTS.map((lines) => {
    const hotMedian = medianCycles(hot.get(lines)!);
    const coldMedian = medianCycles(cold.get(lines)!);
    const penalty = coldMedian - hotMedian;
    penalties.set(lines, penalty);
    return Object.freeze({
      lines,
      hotMedianCycles: hotMedian.toString(),
      coldMedianCycles: coldMedian.toString(),
      coldMinusHotCycles: penalty.toString(),
    });
  });
  const first = penalties.get(1)!;
  const steps = [[1, 2], [2, 4], [4, 8]] as const;
  const intervals = steps.map(([fromLines, toLines]) => Object.freeze({
    fromLines,
    toLines,
    additionalLines: toLines - fromLines,
    cyclesPerAdditionalLine: rational(
      penalties.get(toLines)! - penalties.get(fromLines)!,
      BigInt(toLines - fromLines),
    ),
  }));
  let weightedDelta = 0n;
  let squaredDistance = 0n;
  for (const lines of LINE_COUNTS.slice(1)) {
    const distance = BigInt(lines - 1);
    weightedDelta += distance * (penalties.get(lines)! - first);
    squaredDistance += distance * distance;
  }
  const divisor = gcd(weightedDelta, squaredDistance);
  const fitNumerator = weightedDelta / divisor;
  const fitDenominator = squaredDistance / divisor;
  let residualSquareNumerator = 0n;
  const residuals = LINE_COUNTS.map((lines) => {
    const numerator =
      (penalties.get(lines)! - first) * fitDenominator -
      BigInt(lines - 1) * fitNumerator;
    residualSquareNumerator += numerator * numerator;
    return Object.freeze({ lines, cycles: rational(numerator, fitDenominator) });
  });
  return Object.freeze({
    samplesPerCell: hot.get(1)!.reduce(
      (count, receipt) => count + receipt.measurement.samples.length,
      0,
    ),
    penalties: Object.freeze(points),
    firstLinePenaltyCycles: first.toString(),
    intervalEstimates: Object.freeze(intervals),
    fixedFirstLineFit: Object.freeze({
      model: "penalty(N)=P1+(N-1)*interval",
      intervalCyclesPerLine: rational(fitNumerator, fitDenominator),
      residuals: Object.freeze(residuals),
      residualSumSquaresCyclesSquared: rational(
        residualSquareNumerator,
        fitDenominator * fitDenominator,
      ),
    }),
  });
}

function cellKey(lines: LineCount, residency: Residency): string {
  return `${lines}/${residency}`;
}

export function analyzeIcacheBurstReceiptJson(
  receiptJson: readonly string[],
): IcacheBurstAnalysisArtifact {
  if (receiptJson.length === 0) fail("receipt JSON inputs must not be empty");
  const receipts = receiptJson.map((json, index) => {
    try {
      return parseHardwareCalibrationReceipt(json);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      return fail(`invalid receipt JSON at index ${index}: ${detail}`);
    }
  });
  const first = receipts[0]!;
  const expectedCohort = cohortKey(first);
  const receiptHashes = new Set<string>();
  const bootMetadata = new Map<string, string>();
  const bootLogs = new Map<string, string>();
  const cellsByBoot = new Map<string, Map<string, Cell>>();
  let expectedSampleCount: number | undefined;
  for (const receipt of receipts) {
    if (cohortKey(receipt) !== expectedCohort) fail("cohort provenance must agree across every cell");
    if (receiptHashes.has(receipt.receiptSha256)) fail("receipt inputs contain a duplicate receipt");
    receiptHashes.add(receipt.receiptSha256);
    const previousBoot = bootMetadata.get(receipt.boot.bootId);
    if (previousBoot !== undefined && previousBoot !== bootKey(receipt)) {
      fail(`boot provenance must agree for ${receipt.boot.bootId}`);
    }
    bootMetadata.set(receipt.boot.bootId, bootKey(receipt));
    bootLogs.set(receipt.boot.bootId, receipt.boot.bootLogSha256);
    const parsed = measurementOf(receipt);
    const cell: Cell = { ...parsed, receipt };
    validateCell(cell);
    const sampleCount = receipt.measurement.samples.length;
    if (expectedSampleCount !== undefined && sampleCount !== expectedSampleCount) {
      fail("sample counts must agree across every boot and cell");
    }
    expectedSampleCount = sampleCount;
    const cells = cellsByBoot.get(receipt.boot.bootId) ?? new Map<string, Cell>();
    const key = cellKey(cell.lines, cell.residency);
    if (cells.has(key)) fail(`duplicate measurement ${receipt.boot.bootId}/${receipt.measurement.kernel}`);
    cells.set(key, cell);
    cellsByBoot.set(receipt.boot.bootId, cells);
  }
  const bootIds = [...cellsByBoot.keys()].sort();
  if (bootIds.length < 2) fail("I-cache burst analysis requires at least two distinct boots");
  if (new Set(bootLogs.values()).size !== bootIds.length) {
    fail("distinct boot IDs must have distinct boot-log hashes");
  }
  const expectedCells = LINE_COUNTS.length * 2;
  for (const bootId of bootIds) {
    if (cellsByBoot.get(bootId)!.size !== expectedCells) {
      fail(`boot ${bootId} must contain all ${expectedCells} hot/cold burst cells`);
    }
  }
  const seriesFor = (selectedBoots: readonly string[]): BurstSeries => {
    const hot = new Map<LineCount, readonly ParsedHardwareCalibrationReceipt[]>();
    const cold = new Map<LineCount, readonly ParsedHardwareCalibrationReceipt[]>();
    for (const lines of LINE_COUNTS) {
      hot.set(lines, selectedBoots.map(
        (bootId) => cellsByBoot.get(bootId)!.get(cellKey(lines, "hot"))!.receipt,
      ));
      cold.set(lines, selectedBoots.map(
        (bootId) => cellsByBoot.get(bootId)!.get(cellKey(lines, "cold"))!.receipt,
      ));
    }
    return buildSeries(hot, cold);
  };
  const analysis: IcacheBurstAnalysisV1 = Object.freeze({
    analysisVersion: 1,
    status: "analysis-only",
    review: Object.freeze({
      microbenchmarkToArchitecturalCost: "unreviewed",
      cacheClaim: "not-claimed",
      costAdoption: "none",
    }),
    estimator: "nearest-rank-median(cold)-nearest-rank-median(hot)",
    receiptCount: receipts.length,
    bootCount: bootIds.length,
    cohort: Object.freeze({
      repository: first.git.repository,
      commit: first.git.commit,
      toolchain: first.toolchain,
      sdkconfig: first.sdkconfig,
      chipRevision: first.boot.chipRevision,
      flashBytes: first.boot.flashBytes,
      counter: first.counter,
    }),
    evidence: Object.freeze({
      bootIds: Object.freeze(bootIds),
      bootLogSha256: Object.freeze(bootIds.map((bootId) => bootLogs.get(bootId)!)),
      receiptSha256: Object.freeze([...receiptHashes].sort()),
    }),
    perBoot: Object.freeze(
      bootIds.map((bootId) => Object.freeze({ bootId, series: seriesFor([bootId]) })),
    ),
    pooled: seriesFor(bootIds),
  });
  return Object.freeze({ analysis, json: `${JSON.stringify(analysis, null, 2)}\n` });
}
