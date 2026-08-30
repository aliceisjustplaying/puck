export const HARDWARE_CALIBRATION_SCHEMA_VERSION = 1 as const;
export const MINIMUM_HARDWARE_SAMPLES = 100;

const UINT32_MAX = 0xffff_ffff;
const UINT32_MODULUS = 0x1_0000_0000;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const COMMIT_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const ISO_UTC_PATTERN = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,3}))?Z$/;

type JsonObject = Record<string, unknown>;

export type MemoryPath =
  | "internal-to-internal"
  | "psram-to-internal"
  | "internal-to-psram"
  | "psram-to-psram"
  | "flash-to-internal"
  | "other";

export interface HardwareSample {
  readonly ordinal: number;
  readonly startCore: 0 | 1;
  readonly endCore: 0 | 1;
  readonly startCcount: number;
  readonly endCcount: number;
  readonly cycles: number;
}

export interface KernelDescriptor {
  readonly kind: "ccount-kernel";
  readonly kernel: string;
  readonly memoryPath: MemoryPath;
  readonly bytesPerIteration: number;
  readonly iterationsPerSample: number;
  readonly warmupIterations: number;
}

export interface ParsedHardwareCalibrationReceipt {
  readonly receiptSha256: string;
  readonly schemaVersion: 1;
  readonly receiptKind: "esp32s3-hardware-calibration";
  readonly captureMode: "hardware";
  readonly capturedAt: string;
  readonly git: Readonly<{
    repository: string;
    commit: string;
    dirty: false;
  }>;
  readonly toolchain: Readonly<{
    target: "esp32s3";
    espIdfVersion: string;
    compiler: string;
    compilerVersion: string;
  }>;
  readonly sdkconfig: Readonly<{
    path: string;
    sha256: string;
    cpuHz: number;
    psramMode: "octal" | "quad";
    psramBusHz: number;
    flashMode: "qio" | "qout" | "dio" | "dout";
    flashBusHz: number;
  }>;
  readonly boot: Readonly<{
    bootId: string;
    bootLogSha256: string;
    resetReason: string;
    chipModel: "ESP32-S3";
    chipRevision: number;
    cpuCores: 2;
    psramBytes: number;
    flashBytes: number;
  }>;
  readonly counter: Readonly<{
    source: "xtensa-ccount";
    bits: 32;
    hz: number;
    core: 0 | 1;
  }>;
  readonly measurement: KernelDescriptor & Readonly<{ samples: readonly HardwareSample[] }>;
}

export interface ExactIntegerSummary {
  readonly min: bigint;
  readonly p50: bigint;
  readonly p90: bigint;
  readonly p99: bigint;
  readonly max: bigint;
}

export interface ExactRational {
  readonly numerator: bigint;
  readonly denominator: bigint;
}

export interface ExactRationalSummary {
  readonly min: ExactRational;
  readonly p50: ExactRational;
  readonly p90: ExactRational;
  readonly p99: ExactRational;
  readonly max: ExactRational;
}

export interface CalibrationCandidate {
  readonly candidateVersion: 1;
  readonly status: "candidate";
  readonly review: Readonly<{
    microbenchmarkToArchitecturalCost: "unreviewed";
    cacheClaim: "not-claimed";
    isaClaim: "not-claimed";
  }>;
  readonly measurement: KernelDescriptor;
  readonly cohort: Readonly<{
    repository: string;
    commit: string;
    toolchain: ParsedHardwareCalibrationReceipt["toolchain"];
    sdkconfig: ParsedHardwareCalibrationReceipt["sdkconfig"];
    chipRevision: number;
    psramBytes: number;
    flashBytes: number;
    counter: ParsedHardwareCalibrationReceipt["counter"];
  }>;
  readonly evidence: Readonly<{
    bootIds: readonly string[];
    receiptSha256: readonly string[];
    bootLogSha256: readonly string[];
    receipts: readonly Readonly<{
      bootId: string;
      capturedAt: string;
      receiptSha256: string;
      bootLogSha256: string;
    }>[];
  }>;
  readonly samples: Readonly<{
    count: number;
    cycles: ExactIntegerSummary;
    bytesPerSample: bigint;
    cyclesPerByte: ExactRationalSummary | null;
  }>;
}

export class CalibrationAdoptionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CalibrationAdoptionError";
  }
}

function fail(path: string, requirement: string): never {
  throw new CalibrationAdoptionError(`${path} ${requirement}`);
}

function objectAt(value: unknown, path: string): JsonObject {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return fail(path, "must be an object");
  }
  return value as JsonObject;
}

function exactKeys(object: JsonObject, keys: readonly string[], path: string): void {
  const actual = Object.keys(object).sort();
  const expected = [...keys].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    fail(path, `keys must be exactly ${expected.join(", ")}; got ${actual.join(", ")}`);
  }
}

function literal<T extends string | number | boolean>(
  value: unknown,
  expected: T,
  path: string,
): asserts value is T {
  if (value !== expected) fail(path, `must be ${JSON.stringify(expected)}`);
}

function stringAt(value: unknown, path: string): string {
  if (typeof value !== "string" || value.length === 0) return fail(path, "must be a non-empty string");
  return value;
}

function integerAt(value: unknown, path: string, minimum: number, maximum = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    return fail(path, `must be an integer from ${minimum} through ${maximum}`);
  }
  return value as number;
}

function enumAt<const T extends string | number>(value: unknown, allowed: readonly T[], path: string): T {
  if (!allowed.includes(value as T)) return fail(path, `must be one of ${allowed.join(", ")}`);
  return value as T;
}

function sha256At(value: unknown, path: string): string {
  const digest = stringAt(value, path);
  if (!SHA256_PATTERN.test(digest)) return fail(path, "must be a lowercase SHA-256 digest");
  return digest;
}

function timestampAt(value: unknown, path: string): string {
  const timestamp = stringAt(value, path);
  const match = ISO_UTC_PATTERN.exec(timestamp);
  if (!match) return fail(path, "must be an ISO-8601 UTC timestamp");
  const parsed = Date.parse(timestamp);
  const canonical = `${match[1]}.${(match[2] ?? "").padEnd(3, "0")}Z`;
  if (Number.isNaN(parsed) || new Date(parsed).toISOString() !== canonical) {
    return fail(path, "must be an ISO-8601 UTC timestamp");
  }
  return timestamp;
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const nested of Object.values(value as JsonObject)) deepFreeze(nested);
    Object.freeze(value);
  }
  return value;
}

function parseGit(value: unknown): ParsedHardwareCalibrationReceipt["git"] {
  const git = objectAt(value, "$.git");
  exactKeys(git, ["repository", "commit", "dirty"], "$.git");
  const repository = stringAt(git.repository, "$.git.repository");
  const commit = stringAt(git.commit, "$.git.commit");
  if (!COMMIT_PATTERN.test(commit)) fail("$.git.commit", "must be a lowercase 40- or 64-hex object id");
  literal(git.dirty, false, "$.git.dirty");
  return { repository, commit, dirty: false };
}

function parseToolchain(value: unknown): ParsedHardwareCalibrationReceipt["toolchain"] {
  const toolchain = objectAt(value, "$.toolchain");
  exactKeys(toolchain, ["target", "espIdfVersion", "compiler", "compilerVersion"], "$.toolchain");
  literal(toolchain.target, "esp32s3", "$.toolchain.target");
  return {
    target: "esp32s3",
    espIdfVersion: stringAt(toolchain.espIdfVersion, "$.toolchain.espIdfVersion"),
    compiler: stringAt(toolchain.compiler, "$.toolchain.compiler"),
    compilerVersion: stringAt(toolchain.compilerVersion, "$.toolchain.compilerVersion"),
  };
}

function parseSdkconfig(value: unknown): ParsedHardwareCalibrationReceipt["sdkconfig"] {
  const sdkconfig = objectAt(value, "$.sdkconfig");
  exactKeys(
    sdkconfig,
    ["path", "sha256", "cpuHz", "psramMode", "psramBusHz", "flashMode", "flashBusHz"],
    "$.sdkconfig",
  );
  return {
    path: stringAt(sdkconfig.path, "$.sdkconfig.path"),
    sha256: sha256At(sdkconfig.sha256, "$.sdkconfig.sha256"),
    cpuHz: integerAt(sdkconfig.cpuHz, "$.sdkconfig.cpuHz", 1),
    psramMode: enumAt(sdkconfig.psramMode, ["octal", "quad"] as const, "$.sdkconfig.psramMode"),
    psramBusHz: integerAt(sdkconfig.psramBusHz, "$.sdkconfig.psramBusHz", 1),
    flashMode: enumAt(
      sdkconfig.flashMode,
      ["qio", "qout", "dio", "dout"] as const,
      "$.sdkconfig.flashMode",
    ),
    flashBusHz: integerAt(sdkconfig.flashBusHz, "$.sdkconfig.flashBusHz", 1),
  };
}

function parseBoot(value: unknown): ParsedHardwareCalibrationReceipt["boot"] {
  const boot = objectAt(value, "$.boot");
  exactKeys(
    boot,
    [
      "bootId",
      "bootLogSha256",
      "resetReason",
      "chipModel",
      "chipRevision",
      "cpuCores",
      "psramBytes",
      "flashBytes",
    ],
    "$.boot",
  );
  literal(boot.chipModel, "ESP32-S3", "$.boot.chipModel");
  literal(boot.cpuCores, 2, "$.boot.cpuCores");
  return {
    bootId: stringAt(boot.bootId, "$.boot.bootId"),
    bootLogSha256: sha256At(boot.bootLogSha256, "$.boot.bootLogSha256"),
    resetReason: stringAt(boot.resetReason, "$.boot.resetReason"),
    chipModel: "ESP32-S3",
    chipRevision: integerAt(boot.chipRevision, "$.boot.chipRevision", 0),
    cpuCores: 2,
    psramBytes: integerAt(boot.psramBytes, "$.boot.psramBytes", 0),
    flashBytes: integerAt(boot.flashBytes, "$.boot.flashBytes", 1),
  };
}

function parseCounter(value: unknown): ParsedHardwareCalibrationReceipt["counter"] {
  const counter = objectAt(value, "$.counter");
  exactKeys(counter, ["source", "bits", "hz", "core"], "$.counter");
  literal(counter.source, "xtensa-ccount", "$.counter.source");
  literal(counter.bits, 32, "$.counter.bits");
  return {
    source: "xtensa-ccount",
    bits: 32,
    hz: integerAt(counter.hz, "$.counter.hz", 1),
    core: enumAt(counter.core, [0, 1] as const, "$.counter.core"),
  };
}

function parseMeasurement(
  value: unknown,
  counterCore: 0 | 1,
): ParsedHardwareCalibrationReceipt["measurement"] {
  const measurement = objectAt(value, "$.measurement");
  exactKeys(
    measurement,
    [
      "kind",
      "kernel",
      "memoryPath",
      "bytesPerIteration",
      "iterationsPerSample",
      "warmupIterations",
      "samples",
    ],
    "$.measurement",
  );
  literal(measurement.kind, "ccount-kernel", "$.measurement.kind");
  if (!Array.isArray(measurement.samples)) fail("$.measurement.samples", "must be an array");
  if (measurement.samples.length < MINIMUM_HARDWARE_SAMPLES) {
    fail("$.measurement.samples", `must contain at least ${MINIMUM_HARDWARE_SAMPLES} samples`);
  }
  const samples = measurement.samples.map((sampleValue, index): HardwareSample => {
    const path = `$.measurement.samples[${index}]`;
    const sample = objectAt(sampleValue, path);
    exactKeys(sample, ["ordinal", "startCore", "endCore", "startCcount", "endCcount", "cycles"], path);
    const ordinal = integerAt(sample.ordinal, `${path}.ordinal`, 0);
    if (ordinal !== index) fail(`${path}.ordinal`, `must equal its zero-based array index ${index}`);
    const startCore = enumAt(sample.startCore, [0, 1] as const, `${path}.startCore`);
    const endCore = enumAt(sample.endCore, [0, 1] as const, `${path}.endCore`);
    if (startCore !== endCore) fail(path, "must not cross CPU cores");
    if (startCore !== counterCore) fail(`${path}.startCore`, "must equal $.counter.core");
    const startCcount = integerAt(sample.startCcount, `${path}.startCcount`, 0, UINT32_MAX);
    const endCcount = integerAt(sample.endCcount, `${path}.endCcount`, 0, UINT32_MAX);
    const cycles = integerAt(sample.cycles, `${path}.cycles`, 1, UINT32_MAX);
    const expected = (endCcount - startCcount + UINT32_MODULUS) % UINT32_MODULUS;
    if (cycles !== expected) fail(`${path}.cycles`, `must equal the unsigned 32-bit CCOUNT delta ${expected}`);
    return { ordinal, startCore, endCore, startCcount, endCcount, cycles };
  });
  return {
    kind: "ccount-kernel",
    kernel: stringAt(measurement.kernel, "$.measurement.kernel"),
    memoryPath: enumAt(
      measurement.memoryPath,
      [
        "internal-to-internal",
        "psram-to-internal",
        "internal-to-psram",
        "psram-to-psram",
        "flash-to-internal",
        "other",
      ] as const,
      "$.measurement.memoryPath",
    ),
    bytesPerIteration: integerAt(measurement.bytesPerIteration, "$.measurement.bytesPerIteration", 0),
    iterationsPerSample: integerAt(measurement.iterationsPerSample, "$.measurement.iterationsPerSample", 1),
    warmupIterations: integerAt(measurement.warmupIterations, "$.measurement.warmupIterations", 0),
    samples,
  };
}

function sha256(text: string): string {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(text);
  return hasher.digest("hex");
}

export function parseHardwareCalibrationReceipt(json: string): ParsedHardwareCalibrationReceipt {
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return fail("$", `must be valid JSON: ${detail}`);
  }
  const root = objectAt(value, "$");
  exactKeys(
    root,
    [
      "schemaVersion",
      "receiptKind",
      "captureMode",
      "capturedAt",
      "git",
      "toolchain",
      "sdkconfig",
      "boot",
      "counter",
      "measurement",
    ],
    "$",
  );
  literal(root.schemaVersion, HARDWARE_CALIBRATION_SCHEMA_VERSION, "$.schemaVersion");
  literal(root.receiptKind, "esp32s3-hardware-calibration", "$.receiptKind");
  literal(root.captureMode, "hardware", "$.captureMode");
  const git = parseGit(root.git);
  const toolchain = parseToolchain(root.toolchain);
  const sdkconfig = parseSdkconfig(root.sdkconfig);
  const boot = parseBoot(root.boot);
  const counter = parseCounter(root.counter);
  if (counter.hz !== sdkconfig.cpuHz) fail("$.counter.hz", "must equal $.sdkconfig.cpuHz");
  const measurement = parseMeasurement(root.measurement, counter.core);
  return deepFreeze({
    receiptSha256: sha256(json),
    schemaVersion: 1,
    receiptKind: "esp32s3-hardware-calibration",
    captureMode: "hardware",
    capturedAt: timestampAt(root.capturedAt, "$.capturedAt"),
    git,
    toolchain,
    sdkconfig,
    boot,
    counter,
    measurement,
  });
}

function descriptorOf(receipt: ParsedHardwareCalibrationReceipt): KernelDescriptor {
  const measurement = receipt.measurement;
  return {
    kind: "ccount-kernel",
    kernel: measurement.kernel,
    memoryPath: measurement.memoryPath,
    bytesPerIteration: measurement.bytesPerIteration,
    iterationsPerSample: measurement.iterationsPerSample,
    warmupIterations: measurement.warmupIterations,
  };
}

function descriptorKey(receipt: ParsedHardwareCalibrationReceipt): string {
  return JSON.stringify(descriptorOf(receipt));
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

function gcd(left: bigint, right: bigint): bigint {
  let a = left < 0n ? -left : left;
  let b = right < 0n ? -right : right;
  while (b !== 0n) {
    const remainder = a % b;
    a = b;
    b = remainder;
  }
  return a;
}

function rational(numerator: bigint, denominator: bigint): ExactRational {
  const divisor = gcd(numerator, denominator);
  return Object.freeze({ numerator: numerator / divisor, denominator: denominator / divisor });
}

function nearestRank(sorted: readonly bigint[], percentile: 50 | 90 | 99): bigint {
  const rank = (BigInt(sorted.length) * BigInt(percentile) + 99n) / 100n;
  return sorted[Number(rank - 1n)]!;
}

export function exactIntegerSummary(values: readonly bigint[]): ExactIntegerSummary {
  if (values.length === 0) fail("samples", "must not be empty");
  const sorted = [...values].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
  return Object.freeze({
    min: sorted[0]!,
    p50: nearestRank(sorted, 50),
    p90: nearestRank(sorted, 90),
    p99: nearestRank(sorted, 99),
    max: sorted[sorted.length - 1]!,
  });
}

function rationalSummary(summary: ExactIntegerSummary, bytes: bigint): ExactRationalSummary {
  return Object.freeze({
    min: rational(summary.min, bytes),
    p50: rational(summary.p50, bytes),
    p90: rational(summary.p90, bytes),
    p99: rational(summary.p99, bytes),
    max: rational(summary.max, bytes),
  });
}

export function aggregateCalibrationCohort(
  receipts: readonly ParsedHardwareCalibrationReceipt[],
): CalibrationCandidate {
  if (receipts.length < 2) fail("cohort", "requires at least two receipts from distinct boot IDs");
  const first = receipts[0]!;
  const expectedCohort = cohortKey(first);
  const expectedDescriptor = descriptorKey(first);
  const expectedSampleCount = first.measurement.samples.length;
  const bootIds = new Set<string>();
  const receiptHashes = new Set<string>();
  for (const receipt of receipts) {
    if (cohortKey(receipt) !== expectedCohort) {
      fail("cohort", "provenance must agree on commit, toolchain, sdkconfig, chip revision, memory, and counter");
    }
    if (descriptorKey(receipt) !== expectedDescriptor) {
      fail("cohort", "measurement descriptors must agree exactly");
    }
    if (receipt.measurement.samples.length !== expectedSampleCount) {
      fail("cohort", "sample counts must agree exactly so every boot has equal weight");
    }
    if (receiptHashes.has(receipt.receiptSha256)) fail("cohort", "contains a duplicate receipt");
    receiptHashes.add(receipt.receiptSha256);
    if (bootIds.has(receipt.boot.bootId)) {
      fail("cohort", `contains duplicate boot/measurement ${receipt.boot.bootId}/${receipt.measurement.kernel}`);
    }
    bootIds.add(receipt.boot.bootId);
  }
  if (bootIds.size < 2) fail("cohort", "requires at least two distinct boot IDs");

  const descriptor = descriptorOf(first);
  const cycles = receipts.flatMap((receipt) =>
    receipt.measurement.samples.map((sample) => BigInt(sample.cycles)),
  );
  const cycleSummary = exactIntegerSummary(cycles);
  const bytesPerSample =
    BigInt(descriptor.bytesPerIteration) * BigInt(descriptor.iterationsPerSample);
  const evidenceReceipts = receipts
    .map((receipt) => ({
      bootId: receipt.boot.bootId,
      capturedAt: receipt.capturedAt,
      receiptSha256: receipt.receiptSha256,
      bootLogSha256: receipt.boot.bootLogSha256,
    }))
    .sort((left, right) =>
      left.bootId.localeCompare(right.bootId) || left.receiptSha256.localeCompare(right.receiptSha256),
    );

  return deepFreeze({
    candidateVersion: 1,
    status: "candidate",
    review: {
      microbenchmarkToArchitecturalCost: "unreviewed",
      cacheClaim: "not-claimed",
      isaClaim: "not-claimed",
    },
    measurement: descriptor,
    cohort: {
      repository: first.git.repository,
      commit: first.git.commit,
      toolchain: first.toolchain,
      sdkconfig: first.sdkconfig,
      chipRevision: first.boot.chipRevision,
      psramBytes: first.boot.psramBytes,
      flashBytes: first.boot.flashBytes,
      counter: first.counter,
    },
    evidence: {
      bootIds: evidenceReceipts.map((receipt) => receipt.bootId),
      receiptSha256: evidenceReceipts.map((receipt) => receipt.receiptSha256),
      bootLogSha256: evidenceReceipts.map((receipt) => receipt.bootLogSha256),
      receipts: evidenceReceipts,
    },
    samples: {
      count: cycles.length,
      cycles: cycleSummary,
      bytesPerSample,
      cyclesPerByte: bytesPerSample === 0n ? null : rationalSummary(cycleSummary, bytesPerSample),
    },
  });
}

export function buildCalibrationCandidates(
  receipts: readonly ParsedHardwareCalibrationReceipt[],
): readonly CalibrationCandidate[] {
  const groups = new Map<string, ParsedHardwareCalibrationReceipt[]>();
  const seenReceipts = new Set<string>();
  const seenBootMeasurements = new Set<string>();
  for (const receipt of receipts) {
    if (seenReceipts.has(receipt.receiptSha256)) fail("receipts", "contains a duplicate receipt");
    seenReceipts.add(receipt.receiptSha256);
    const identity = receipt.measurement.kernel;
    const bootMeasurement = `${receipt.boot.bootId}\u0000${identity}`;
    if (seenBootMeasurements.has(bootMeasurement)) {
      fail("receipts", `contains duplicate boot/measurement ${receipt.boot.bootId}/${identity}`);
    }
    seenBootMeasurements.add(bootMeasurement);
    const group = groups.get(identity) ?? [];
    group.push(receipt);
    groups.set(identity, group);
  }
  return Object.freeze(
    [...groups.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([, group]) => aggregateCalibrationCohort(group)),
  );
}
