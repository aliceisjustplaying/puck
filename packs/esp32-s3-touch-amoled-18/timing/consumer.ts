import {
  partitionBytes,
  scheduleTransfer,
  type CalibrationStatus,
  type ExactSeconds,
  type LinearCycleModel,
  type ScheduleResult,
} from "./model";

export const SNAPSHOT_V1_BYTES = 144;

export const SNAPSHOT_V1_FIELDS = [
  ["version", 0, "u32", "schema"],
  ["size", 4, "u32", "schema"],
  ["observation_sequence", 8, "u64", "sequence"],
  ["internal_allocation_live_bytes", 16, "u64", "live"],
  ["psram_allocation_live_bytes", 24, "u64", "live"],
  ["unclassified_allocation_live_bytes", 32, "u64", "live"],
  ["internal_read_bytes", 40, "u64", "observation"],
  ["internal_write_bytes", 48, "u64", "observation"],
  ["psram_read_bytes", 56, "u64", "observation"],
  ["psram_write_bytes", 64, "u64", "observation"],
  ["flash_read_bytes", 72, "u64", "observation"],
  ["flash_write_bytes", 80, "u64", "observation"],
  ["unclassified_read_bytes", 88, "u64", "observation"],
  ["unclassified_write_bytes", 96, "u64", "observation"],
  ["panel_write_bytes", 104, "u64", "observation"],
  ["panel_submit_count", 112, "u64", "observation"],
  ["panel_wire_clocks", 120, "u64", "observation"],
  ["panel_payload_cpu_cycles", 128, "u64", "observation"],
  ["allocation_registry_overflow_count", 136, "u64", "lifetime"],
] as const;

type SnapshotFieldDescriptor = (typeof SNAPSHOT_V1_FIELDS)[number];
type SnapshotU64Name = Exclude<SnapshotFieldDescriptor[0], "version" | "size">;

export type TimingSnapshotV1 = Readonly<
  { version: 1; size: typeof SNAPSHOT_V1_BYTES } & Record<SnapshotU64Name, bigint>
>;

export interface TimingSchemaV1 {
  readonly schemaVersion: 1;
  readonly byteOrder: "little";
  readonly snapshotBytes: typeof SNAPSHOT_V1_BYTES;
  readonly claim: "accounted-events-only";
  readonly cpuHz: number;
  readonly panelBusHz: number;
  readonly panelLanes: number;
  readonly panelPayloadBytesPerSecond: number;
  readonly observationReset: "start-of-emu_tick";
  readonly scopes: Readonly<{
    schema: "schema";
    sequence: "instance-monotonic";
    live: "instance-live";
    observation: "since-last-reset";
    lifetime: "instance-lifetime";
  }>;
  readonly fields: typeof SNAPSHOT_V1_FIELDS;
}

export interface TimingProfileV1 {
  readonly schemaVersion: 1;
  readonly claimBoundary: Readonly<{
    mode: "shadow-ledger";
    cycleAccurate: false;
    countsOnlyInstrumentedEvents: true;
    hostTraceTimeIsSimulatedTime: false;
  }>;
  readonly cpu: Readonly<{
    cores: number;
    hz: number;
    frequencyStatus: string;
  }>;
  readonly coreSteadyStateCycles: Readonly<{
    status: "partially-calibrated";
    evidence: string;
    instructionIssueCycles: 1;
    independentSramAccessAdditiveCycles: Readonly<{
      load: 0;
      store: 0;
    }>;
    dependentLoadUseHazard: Readonly<{
      status: "unmodeled";
      observedAdditionalCycles: 1;
      reason: string;
    }>;
  }>;
  readonly psram: Readonly<{
    mode: string;
    dtr: boolean;
    busHz: number;
    frequencyStatus: string;
    calibrated: false;
    throughputBytesPerSecond: null;
  }>;
  readonly flash: Readonly<{
    mode: string;
    hz: number | null;
    frequencyStatus: string;
    calibrated: false;
    throughputBytesPerSecond: null;
  }>;
  readonly cacheLineFillCycles: Readonly<{
    status: "calibrated";
    evidence: string;
    instruction: Readonly<{
      flash: CacheLineFillProfileCost;
      psram: null;
    }>;
    data: Readonly<{
      flash: CacheLineFillProfileCost;
      psram: CacheLineFillProfileCost;
    }>;
  }>;
  readonly panel: Readonly<{
    interface: string;
    lanes: number;
    busHz: number;
    frequencyStatus: string;
    frequencyCalibrated: boolean;
    bitsPerPixel: number;
    payloadBytesPerSecond: number;
    throughputCalibrated: false;
    payloadStatus: string;
  }>;
}

export interface CacheLineFillProfileCost {
  readonly firstLineCycles: number;
  readonly subsequentLineCycles: number;
}

export type TimingAvailability =
  | Readonly<{ status: "absent" }>
  | Readonly<{ status: "present"; schema: TimingSchemaV1; snapshot: TimingSnapshotV1 }>;

export interface TimingReportOptions {
  readonly maxStripBytes?: number;
  readonly producerCyclesPerByte?: Readonly<{ numerator: bigint; denominator: bigint }>;
}

export interface TimingReport {
  readonly reportVersion: 1;
  readonly timingExports: "absent" | "present";
  readonly claimBoundary: TimingProfileV1["claimBoundary"];
  readonly ledger: null | Readonly<{
    status: "accounted-events-only";
    schemaVersion: 1;
    observationSequence: bigint;
    values: Readonly<Record<SnapshotU64Name, bigint>>;
  }>;
  readonly scheduler: null | Readonly<{
    status: CalibrationStatus;
    uncalibratedInputs: readonly string[];
    modelInputs: Readonly<{
      maxStripBytes: Readonly<{ value: number; status: "configured" }>;
      cpuProducerClockHz: Readonly<{ value: number; status: CalibrationStatus; basis: string }>;
      producerCyclesPerByte: Readonly<{ value: string; status: "uncalibrated"; basis: "explicit-estimate" }>;
      panelDmaClockHz: Readonly<{ value: number; status: CalibrationStatus; basis: string }>;
      panelDmaCyclesPerByte: Readonly<{ value: string; status: CalibrationStatus; basis: string }>;
    }>;
    result: ScheduleResult;
  }>;
}

type JsonObject = Record<string, unknown>;

const TIMING_EXPORT_NAMES = [
  "emu_timing_schema",
  "emu_timing_snapshot",
  "emu_timing_snapshot_size",
] as const;

const SCHEMA_KEYS = [
  "schemaVersion",
  "byteOrder",
  "snapshotBytes",
  "claim",
  "cpuHz",
  "panelBusHz",
  "panelLanes",
  "panelPayloadBytesPerSecond",
  "observationReset",
  "scopes",
  "fields",
] as const;

function objectAt(value: unknown, path: string): JsonObject {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${path} must be an object`);
  }
  return value as JsonObject;
}

function exactKeys(object: JsonObject, expected: readonly string[], path: string): void {
  const actual = Object.keys(object).sort();
  const wanted = [...expected].sort();
  if (JSON.stringify(actual) !== JSON.stringify(wanted)) {
    throw new Error(`${path} keys must be exactly ${wanted.join(", ")}; got ${actual.join(", ")}`);
  }
}

function literal<T extends string | number | boolean | null>(
  value: unknown,
  expected: T,
  path: string,
): asserts value is T {
  if (value !== expected) throw new Error(`${path} must be ${JSON.stringify(expected)}`);
}

function positiveSafeInteger(value: unknown, path: string): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    throw new Error(`${path} must be a positive safe integer`);
  }
  return value as number;
}

function booleanAt(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") throw new Error(`${path} must be a boolean`);
  return value;
}

function stringAt(value: unknown, path: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${path} must be a non-empty string`);
  return value;
}

function nullablePositiveSafeInteger(value: unknown, path: string): number | null {
  if (value === null) return null;
  return positiveSafeInteger(value, path);
}

function unsignedWasmPointer(value: unknown, path: string): number {
  if (!Number.isInteger(value) || (value as number) < -0x8000_0000 || (value as number) > 0xffff_ffff) {
    throw new Error(`${path} must return one wasm32 pointer`);
  }
  const pointer = (value as number) >>> 0;
  if (pointer === 0) throw new Error(`${path} returned a null pointer`);
  return pointer;
}

function readCString(memory: WebAssembly.Memory, pointer: number): string {
  const bytes = new Uint8Array(memory.buffer);
  if (pointer >= bytes.byteLength) throw new Error("timing schema pointer is outside wasm memory");
  const limit = Math.min(bytes.byteLength, pointer + 65_536);
  let end = pointer;
  while (end < limit && bytes[end] !== 0) end += 1;
  if (end === limit) throw new Error("timing schema is not null-terminated within 65536 bytes");
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(pointer, end));
}

function parseSchema(value: unknown): TimingSchemaV1 {
  const schema = objectAt(value, "timing schema");
  exactKeys(schema, SCHEMA_KEYS, "timing schema");
  literal(schema.schemaVersion, 1, "timing schema.schemaVersion");
  literal(schema.byteOrder, "little", "timing schema.byteOrder");
  literal(schema.snapshotBytes, SNAPSHOT_V1_BYTES, "timing schema.snapshotBytes");
  literal(schema.claim, "accounted-events-only", "timing schema.claim");
  const cpuHz = positiveSafeInteger(schema.cpuHz, "timing schema.cpuHz");
  const panelBusHz = positiveSafeInteger(schema.panelBusHz, "timing schema.panelBusHz");
  const panelLanes = positiveSafeInteger(schema.panelLanes, "timing schema.panelLanes");
  const panelPayloadBytesPerSecond = positiveSafeInteger(
    schema.panelPayloadBytesPerSecond,
    "timing schema.panelPayloadBytesPerSecond",
  );
  literal(schema.observationReset, "start-of-emu_tick", "timing schema.observationReset");

  const scopes = objectAt(schema.scopes, "timing schema.scopes");
  exactKeys(scopes, ["schema", "sequence", "live", "observation", "lifetime"], "timing schema.scopes");
  literal(scopes.schema, "schema", "timing schema.scopes.schema");
  literal(scopes.sequence, "instance-monotonic", "timing schema.scopes.sequence");
  literal(scopes.live, "instance-live", "timing schema.scopes.live");
  literal(scopes.observation, "since-last-reset", "timing schema.scopes.observation");
  literal(scopes.lifetime, "instance-lifetime", "timing schema.scopes.lifetime");
  if (JSON.stringify(schema.fields) !== JSON.stringify(SNAPSHOT_V1_FIELDS)) {
    throw new Error("timing schema.fields does not match snapshot v1 layout");
  }

  return Object.freeze({
    schemaVersion: 1,
    byteOrder: "little",
    snapshotBytes: SNAPSHOT_V1_BYTES,
    claim: "accounted-events-only",
    cpuHz,
    panelBusHz,
    panelLanes,
    panelPayloadBytesPerSecond,
    observationReset: "start-of-emu_tick",
    scopes: Object.freeze({
      schema: "schema",
      sequence: "instance-monotonic",
      live: "instance-live",
      observation: "since-last-reset",
      lifetime: "instance-lifetime",
    }),
    fields: SNAPSHOT_V1_FIELDS,
  });
}

function timingFunction(exports: JsonObject, name: (typeof TIMING_EXPORT_NAMES)[number]): () => number {
  const value = exports[name];
  if (typeof value !== "function") throw new Error(`${name} must be a function`);
  return value as () => number;
}

export function decodeOptionalTimingExports(exportsValue: unknown): TimingAvailability {
  const exports = objectAt(exportsValue, "wasm exports");
  const present = TIMING_EXPORT_NAMES.filter((name) => exports[name] !== undefined);
  if (present.length === 0) return Object.freeze({ status: "absent" });
  if (present.length !== TIMING_EXPORT_NAMES.length) {
    const missing = TIMING_EXPORT_NAMES.filter((name) => exports[name] === undefined);
    throw new Error(`timing exports are partial; missing ${missing.join(", ")}`);
  }
  if (!(exports.memory instanceof WebAssembly.Memory)) {
    throw new Error("timing exports require an exported WebAssembly.Memory");
  }

  const schemaPointer = unsignedWasmPointer(timingFunction(exports, "emu_timing_schema")(), "emu_timing_schema");
  let parsedSchema: unknown;
  try {
    parsedSchema = JSON.parse(readCString(exports.memory, schemaPointer)) as unknown;
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error(`timing schema is invalid JSON: ${error.message}`);
    throw error;
  }
  const schema = parseSchema(parsedSchema);

  const exportedSize = timingFunction(exports, "emu_timing_snapshot_size")();
  if (exportedSize !== SNAPSHOT_V1_BYTES) {
    throw new Error(`emu_timing_snapshot_size returned ${exportedSize}; expected ${SNAPSHOT_V1_BYTES}`);
  }
  const snapshotPointer = unsignedWasmPointer(
    timingFunction(exports, "emu_timing_snapshot")(),
    "emu_timing_snapshot",
  );
  if (snapshotPointer + exportedSize > exports.memory.buffer.byteLength) {
    throw new Error("timing snapshot layout exceeds wasm memory");
  }

  const view = new DataView(exports.memory.buffer, snapshotPointer, exportedSize);
  const version = view.getUint32(0, true);
  const headerSize = view.getUint32(4, true);
  if (version !== 1) throw new Error(`timing snapshot version ${version} is unsupported`);
  if (headerSize !== exportedSize) {
    throw new Error(`timing snapshot header size ${headerSize} does not match export size ${exportedSize}`);
  }

  const values = Object.fromEntries(
    SNAPSHOT_V1_FIELDS.slice(2).map(([name, offset]) => [name, view.getBigUint64(offset, true)]),
  ) as Record<SnapshotU64Name, bigint>;
  const snapshot = Object.freeze({ version: 1 as const, size: SNAPSHOT_V1_BYTES, ...values });
  return Object.freeze({ status: "present", schema, snapshot });
}

export function parseTimingProfile(value: unknown): TimingProfileV1 {
  const profile = objectAt(value, "timing profile");
  exactKeys(
    profile,
    [
      "schemaVersion",
      "claimBoundary",
      "cpu",
      "coreSteadyStateCycles",
      "psram",
      "flash",
      "cacheLineFillCycles",
      "panel",
    ],
    "timing profile",
  );
  literal(profile.schemaVersion, 1, "timing profile.schemaVersion");

  const claim = objectAt(profile.claimBoundary, "timing profile.claimBoundary");
  exactKeys(
    claim,
    ["mode", "cycleAccurate", "countsOnlyInstrumentedEvents", "hostTraceTimeIsSimulatedTime"],
    "timing profile.claimBoundary",
  );
  literal(claim.mode, "shadow-ledger", "timing profile.claimBoundary.mode");
  literal(claim.cycleAccurate, false, "timing profile.claimBoundary.cycleAccurate");
  literal(
    claim.countsOnlyInstrumentedEvents,
    true,
    "timing profile.claimBoundary.countsOnlyInstrumentedEvents",
  );
  literal(
    claim.hostTraceTimeIsSimulatedTime,
    false,
    "timing profile.claimBoundary.hostTraceTimeIsSimulatedTime",
  );

  const cpu = objectAt(profile.cpu, "timing profile.cpu");
  exactKeys(cpu, ["cores", "hz", "frequencyStatus"], "timing profile.cpu");
  const cores = positiveSafeInteger(cpu.cores, "timing profile.cpu.cores");
  const cpuHz = positiveSafeInteger(cpu.hz, "timing profile.cpu.hz");
  const cpuFrequencyStatus = stringAt(cpu.frequencyStatus, "timing profile.cpu.frequencyStatus");

  const coreCycles = objectAt(
    profile.coreSteadyStateCycles,
    "timing profile.coreSteadyStateCycles",
  );
  exactKeys(
    coreCycles,
    [
      "status",
      "evidence",
      "instructionIssueCycles",
      "independentSramAccessAdditiveCycles",
      "dependentLoadUseHazard",
    ],
    "timing profile.coreSteadyStateCycles",
  );
  literal(
    coreCycles.status,
    "partially-calibrated",
    "timing profile.coreSteadyStateCycles.status",
  );
  const coreCyclesEvidence = stringAt(
    coreCycles.evidence,
    "timing profile.coreSteadyStateCycles.evidence",
  );
  literal(
    coreCycles.instructionIssueCycles,
    1,
    "timing profile.coreSteadyStateCycles.instructionIssueCycles",
  );
  const sramAdditive = objectAt(
    coreCycles.independentSramAccessAdditiveCycles,
    "timing profile.coreSteadyStateCycles.independentSramAccessAdditiveCycles",
  );
  exactKeys(
    sramAdditive,
    ["load", "store"],
    "timing profile.coreSteadyStateCycles.independentSramAccessAdditiveCycles",
  );
  literal(
    sramAdditive.load,
    0,
    "timing profile.coreSteadyStateCycles.independentSramAccessAdditiveCycles.load",
  );
  literal(
    sramAdditive.store,
    0,
    "timing profile.coreSteadyStateCycles.independentSramAccessAdditiveCycles.store",
  );
  const loadUseHazard = objectAt(
    coreCycles.dependentLoadUseHazard,
    "timing profile.coreSteadyStateCycles.dependentLoadUseHazard",
  );
  exactKeys(
    loadUseHazard,
    ["status", "observedAdditionalCycles", "reason"],
    "timing profile.coreSteadyStateCycles.dependentLoadUseHazard",
  );
  literal(
    loadUseHazard.status,
    "unmodeled",
    "timing profile.coreSteadyStateCycles.dependentLoadUseHazard.status",
  );
  literal(
    loadUseHazard.observedAdditionalCycles,
    1,
    "timing profile.coreSteadyStateCycles.dependentLoadUseHazard.observedAdditionalCycles",
  );
  const loadUseHazardReason = stringAt(
    loadUseHazard.reason,
    "timing profile.coreSteadyStateCycles.dependentLoadUseHazard.reason",
  );

  const psram = objectAt(profile.psram, "timing profile.psram");
  exactKeys(
    psram,
    ["mode", "dtr", "busHz", "frequencyStatus", "calibrated", "throughputBytesPerSecond"],
    "timing profile.psram",
  );
  const psramMode = stringAt(psram.mode, "timing profile.psram.mode");
  const psramDtr = booleanAt(psram.dtr, "timing profile.psram.dtr");
  const psramBusHz = positiveSafeInteger(psram.busHz, "timing profile.psram.busHz");
  const psramFrequencyStatus = stringAt(psram.frequencyStatus, "timing profile.psram.frequencyStatus");
  literal(psram.calibrated, false, "timing profile.psram.calibrated");
  literal(psram.throughputBytesPerSecond, null, "timing profile.psram.throughputBytesPerSecond");

  const flash = objectAt(profile.flash, "timing profile.flash");
  exactKeys(
    flash,
    ["mode", "hz", "frequencyStatus", "calibrated", "throughputBytesPerSecond"],
    "timing profile.flash",
  );
  const flashMode = stringAt(flash.mode, "timing profile.flash.mode");
  const flashHz = nullablePositiveSafeInteger(flash.hz, "timing profile.flash.hz");
  const flashFrequencyStatus = stringAt(flash.frequencyStatus, "timing profile.flash.frequencyStatus");
  literal(flash.calibrated, false, "timing profile.flash.calibrated");
  literal(flash.throughputBytesPerSecond, null, "timing profile.flash.throughputBytesPerSecond");

  const cacheLineFill = objectAt(profile.cacheLineFillCycles, "timing profile.cacheLineFillCycles");
  exactKeys(
    cacheLineFill,
    ["status", "evidence", "instruction", "data"],
    "timing profile.cacheLineFillCycles",
  );
  literal(cacheLineFill.status, "calibrated", "timing profile.cacheLineFillCycles.status");
  const cacheLineFillEvidence = stringAt(
    cacheLineFill.evidence,
    "timing profile.cacheLineFillCycles.evidence",
  );
  const parseLineFillCost = (value: unknown, path: string): CacheLineFillProfileCost => {
    const cost = objectAt(value, path);
    exactKeys(cost, ["firstLineCycles", "subsequentLineCycles"], path);
    return Object.freeze({
      firstLineCycles: positiveSafeInteger(cost.firstLineCycles, `${path}.firstLineCycles`),
      subsequentLineCycles: positiveSafeInteger(
        cost.subsequentLineCycles,
        `${path}.subsequentLineCycles`,
      ),
    });
  };
  const instructionLineFill = objectAt(
    cacheLineFill.instruction,
    "timing profile.cacheLineFillCycles.instruction",
  );
  exactKeys(
    instructionLineFill,
    ["flash", "psram"],
    "timing profile.cacheLineFillCycles.instruction",
  );
  const instructionFlashLineFill = parseLineFillCost(
    instructionLineFill.flash,
    "timing profile.cacheLineFillCycles.instruction.flash",
  );
  literal(
    instructionLineFill.psram,
    null,
    "timing profile.cacheLineFillCycles.instruction.psram",
  );
  const dataLineFill = objectAt(cacheLineFill.data, "timing profile.cacheLineFillCycles.data");
  exactKeys(dataLineFill, ["flash", "psram"], "timing profile.cacheLineFillCycles.data");
  const dataFlashLineFill = parseLineFillCost(
    dataLineFill.flash,
    "timing profile.cacheLineFillCycles.data.flash",
  );
  const dataPsramLineFill = parseLineFillCost(
    dataLineFill.psram,
    "timing profile.cacheLineFillCycles.data.psram",
  );

  const panel = objectAt(profile.panel, "timing profile.panel");
  exactKeys(
    panel,
    [
      "interface",
      "lanes",
      "busHz",
      "frequencyStatus",
      "frequencyCalibrated",
      "bitsPerPixel",
      "payloadBytesPerSecond",
      "throughputCalibrated",
      "payloadStatus",
    ],
    "timing profile.panel",
  );
  const panelInterface = stringAt(panel.interface, "timing profile.panel.interface");
  const panelLanes = positiveSafeInteger(panel.lanes, "timing profile.panel.lanes");
  const panelBusHz = positiveSafeInteger(panel.busHz, "timing profile.panel.busHz");
  const panelFrequencyStatus = stringAt(panel.frequencyStatus, "timing profile.panel.frequencyStatus");
  const panelFrequencyCalibrated = booleanAt(
    panel.frequencyCalibrated,
    "timing profile.panel.frequencyCalibrated",
  );
  const bitsPerPixel = positiveSafeInteger(panel.bitsPerPixel, "timing profile.panel.bitsPerPixel");
  const payloadBytesPerSecond = positiveSafeInteger(
    panel.payloadBytesPerSecond,
    "timing profile.panel.payloadBytesPerSecond",
  );
  literal(panel.throughputCalibrated, false, "timing profile.panel.throughputCalibrated");
  const payloadStatus = stringAt(panel.payloadStatus, "timing profile.panel.payloadStatus");

  return Object.freeze({
    schemaVersion: 1,
    claimBoundary: Object.freeze({
      mode: "shadow-ledger",
      cycleAccurate: false,
      countsOnlyInstrumentedEvents: true,
      hostTraceTimeIsSimulatedTime: false,
    }),
    cpu: Object.freeze({ cores, hz: cpuHz, frequencyStatus: cpuFrequencyStatus }),
    coreSteadyStateCycles: Object.freeze({
      status: "partially-calibrated",
      evidence: coreCyclesEvidence,
      instructionIssueCycles: 1,
      independentSramAccessAdditiveCycles: Object.freeze({ load: 0, store: 0 }),
      dependentLoadUseHazard: Object.freeze({
        status: "unmodeled",
        observedAdditionalCycles: 1,
        reason: loadUseHazardReason,
      }),
    }),
    psram: Object.freeze({
      mode: psramMode,
      dtr: psramDtr,
      busHz: psramBusHz,
      frequencyStatus: psramFrequencyStatus,
      calibrated: false,
      throughputBytesPerSecond: null,
    }),
    flash: Object.freeze({
      mode: flashMode,
      hz: flashHz,
      frequencyStatus: flashFrequencyStatus,
      calibrated: false,
      throughputBytesPerSecond: null,
    }),
    cacheLineFillCycles: Object.freeze({
      status: "calibrated",
      evidence: cacheLineFillEvidence,
      instruction: Object.freeze({ flash: instructionFlashLineFill, psram: null }),
      data: Object.freeze({ flash: dataFlashLineFill, psram: dataPsramLineFill }),
    }),
    panel: Object.freeze({
      interface: panelInterface,
      lanes: panelLanes,
      busHz: panelBusHz,
      frequencyStatus: panelFrequencyStatus,
      frequencyCalibrated: panelFrequencyCalibrated,
      bitsPerPixel,
      payloadBytesPerSecond,
      throughputCalibrated: false,
      payloadStatus,
    }),
  });
}

function requireEqual(actual: number, expected: number, label: string): void {
  if (actual !== expected) throw new Error(`${label} differs: schema ${actual}, profile ${expected}`);
}

export function assertSchemaMatchesProfile(schema: TimingSchemaV1, profile: TimingProfileV1): void {
  requireEqual(schema.cpuHz, profile.cpu.hz, "CPU frequency");
  requireEqual(schema.panelBusHz, profile.panel.busHz, "panel bus frequency");
  requireEqual(schema.panelLanes, profile.panel.lanes, "panel lane count");
  requireEqual(
    schema.panelPayloadBytesPerSecond,
    profile.panel.payloadBytesPerSecond,
    "panel payload throughput",
  );
  if (profile.panel.busHz * profile.panel.lanes !== profile.panel.payloadBytesPerSecond * 8) {
    throw new Error("timing profile panel frequency, lanes, and payload throughput are inconsistent");
  }
}

function bigintToSafeInteger(value: bigint, label: string): number {
  if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error(`${label} does not fit one safe integer`);
  }
  return Number(value);
}

function calibrationFromBoolean(value: boolean): CalibrationStatus {
  return value ? "calibrated" : "uncalibrated";
}

function rationalText(value: Readonly<{ numerator: bigint; denominator: bigint }>): string {
  return `${value.numerator}/${value.denominator}`;
}

function ledgerValues(snapshot: TimingSnapshotV1): Readonly<Record<SnapshotU64Name, bigint>> {
  return Object.freeze(
    Object.fromEntries(SNAPSHOT_V1_FIELDS.slice(2).map(([name]) => [name, snapshot[name]])) as Record<
      SnapshotU64Name,
      bigint
    >,
  );
}

function buildSchedule(
  availability: Extract<TimingAvailability, { status: "present" }>,
  profile: TimingProfileV1,
  options: TimingReportOptions,
): TimingReport["scheduler"] {
  const totalBytes = bigintToSafeInteger(availability.snapshot.panel_write_bytes, "panel_write_bytes");
  if (totalBytes === 0) return null;
  const maxStripBytes = options.maxStripBytes ?? 32_768;
  const producerRatio = options.producerCyclesPerByte ?? { numerator: 1n, denominator: 1n };
  if (producerRatio.numerator <= 0n || producerRatio.denominator <= 0n) {
    throw new Error("producerCyclesPerByte must be a positive ratio");
  }

  const expectedSubmits = partitionBytes(totalBytes, maxStripBytes).length;
  const accountedSubmits = bigintToSafeInteger(availability.snapshot.panel_submit_count, "panel_submit_count");
  if (expectedSubmits !== accountedSubmits) {
    throw new Error(
      `maxStripBytes ${maxStripBytes} yields ${expectedSubmits} strips, but the ledger accounted ${accountedSubmits} submits`,
    );
  }

  if (8 % profile.panel.lanes !== 0) throw new Error("panel lane count must divide eight bits");
  const panelCyclesPerByte = BigInt(8 / profile.panel.lanes);
  const expectedWireClocks = BigInt(totalBytes) * panelCyclesPerByte;
  if (availability.snapshot.panel_wire_clocks !== expectedWireClocks) {
    throw new Error("panel_wire_clocks does not match accounted bytes and profile lanes");
  }
  const expectedPayloadCpuCycles =
    (BigInt(totalBytes) * BigInt(profile.cpu.hz)) / BigInt(profile.panel.payloadBytesPerSecond);
  if (availability.snapshot.panel_payload_cpu_cycles !== expectedPayloadCpuCycles) {
    throw new Error("panel_payload_cpu_cycles does not match accounted bytes and profile throughput");
  }

  const cpuClockCalibration: CalibrationStatus =
    profile.cpu.frequencyStatus === "measured" ? "calibrated" : "uncalibrated";
  const panelClockCalibration = calibrationFromBoolean(profile.panel.frequencyCalibrated);
  const producerCost: LinearCycleModel = {
    fixedCycles: 0n,
    cyclesPerByte: producerRatio,
    calibration: "uncalibrated",
  };
  const panelCost: LinearCycleModel = {
    fixedCycles: 0n,
    cyclesPerByte: { numerator: panelCyclesPerByte, denominator: 1n },
    calibration: calibrationFromBoolean(profile.panel.throughputCalibrated),
  };
  const result = scheduleTransfer(
    {
      queueDepth: 3,
      cpuProducer: { hz: BigInt(profile.cpu.hz), calibration: cpuClockCalibration },
      panelDma: { hz: BigInt(profile.panel.busHz), calibration: panelClockCalibration },
    },
    {
      totalBytes,
      maxStripBytes,
      producerCost,
      panelDmaCost: panelCost,
    },
  );

  return Object.freeze({
    status: result.calibration.status,
    uncalibratedInputs: result.calibration.uncalibratedInputs,
    modelInputs: Object.freeze({
      maxStripBytes: Object.freeze({ value: maxStripBytes, status: "configured" as const }),
      cpuProducerClockHz: Object.freeze({
        value: profile.cpu.hz,
        status: cpuClockCalibration,
        basis: profile.cpu.frequencyStatus,
      }),
      producerCyclesPerByte: Object.freeze({
        value: rationalText(producerRatio),
        status: "uncalibrated" as const,
        basis: "explicit-estimate" as const,
      }),
      panelDmaClockHz: Object.freeze({
        value: profile.panel.busHz,
        status: panelClockCalibration,
        basis: profile.panel.frequencyStatus,
      }),
      panelDmaCyclesPerByte: Object.freeze({
        value: `${panelCyclesPerByte}/1`,
        status: panelCost.calibration,
        basis: profile.panel.payloadStatus,
      }),
    }),
    result,
  });
}

export function buildTimingReport(
  availability: TimingAvailability,
  profile: TimingProfileV1,
  options: TimingReportOptions = {},
): TimingReport {
  if (availability.status === "absent") {
    return Object.freeze({
      reportVersion: 1,
      timingExports: "absent",
      claimBoundary: profile.claimBoundary,
      ledger: null,
      scheduler: null,
    });
  }
  assertSchemaMatchesProfile(availability.schema, profile);
  return Object.freeze({
    reportVersion: 1,
    timingExports: "present",
    claimBoundary: profile.claimBoundary,
    ledger: Object.freeze({
      status: "accounted-events-only",
      schemaVersion: 1,
      observationSequence: availability.snapshot.observation_sequence,
      values: ledgerValues(availability.snapshot),
    }),
    scheduler: buildSchedule(availability, profile, options),
  });
}

export function stableTimingJson(report: TimingReport): string {
  return `${JSON.stringify(report, (_key, value: unknown) => (typeof value === "bigint" ? value.toString() : value), 2)}\n`;
}

export function exactSecondsText(value: ExactSeconds): string {
  return rationalText(value);
}
