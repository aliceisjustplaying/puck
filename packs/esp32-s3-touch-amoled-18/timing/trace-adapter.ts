import type {
  CpuExecutionEvent,
  DmaEvent,
  EventLatency,
  StoreBufferTiming,
} from "./execution";
import type { TimingMachineFence } from "./machine";
import {
  RuntimeTimingTraceRecorder,
  type RuntimeMemoryObservation,
  type RuntimeTimingTrace,
  type RuntimeTraceProvenance,
} from "./runtime-trace";

export type NeutralTraceKind = "instruction" | "read" | "write";

/** Flexe trace word for Xtensa bytes c0 20 00, printed by objdump as 0020c0. */
export const XTENSA_MEMW_INSTRUCTION_ENCODING = 0x0020c0;

export interface NeutralTraceAdapterOptions {
  readonly storeBuffer?: Readonly<{
    readonly retirementLatency: EventLatency;
    readonly memwLatency: EventLatency;
  }>;
}

export interface NeutralTraceObservation {
  readonly id: string;
  readonly sequence: number;
  readonly core: 0 | 1;
  readonly kind: NeutralTraceKind;
  readonly address: bigint;
  readonly width: number;
  /** Instruction-only CPU duration. Omission becomes an explicit unknown cost. */
  readonly cpuCost?: EventLatency;
  /** Optional CPU delay issued after this fetch and before any owned data. */
  readonly preDataCpuCost?: EventLatency;
  /** Exact instruction word as reported by the bounded runtime trace. */
  readonly instructionEncoding?: Readonly<{
    readonly value: number;
    readonly source: string;
  }>;
  /** Data-only PC of the instruction that issued this access. */
  readonly issuingInstructionAddress?: bigint;
  readonly extension?: Readonly<{
    kind: "literal-load";
    source: string;
  }>;
}

export interface BoundedNeutralTrace {
  readonly schemaVersion: 1;
  readonly capacity: number;
  readonly overflow: boolean;
  readonly provenance: Readonly<{
    source: string;
    format: string;
    digest?: Readonly<{
      algorithm: "sha256";
      value: string;
    }>;
  }>;
  readonly observations: readonly NeutralTraceObservation[];
}

export interface ExplicitDmaObservation {
  readonly sequence: number;
  readonly event: DmaEvent;
}

function requireNonEmpty(value: unknown, path: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${path} must be a non-empty string`);
  }
  return value;
}

function requireSequence(value: unknown, path: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(`${path} must be a non-negative safe integer`);
  }
  return value as number;
}

function validateWidth(kind: NeutralTraceKind, width: unknown, path: string): number {
  if (!Number.isSafeInteger(width)) throw new Error(`${path} must be a supported integer width`);
  if (kind === "instruction" ? width !== 2 && width !== 3 && width !== 4 : width !== 1 && width !== 2 && width !== 4) {
    throw new Error(`${path} ${String(width)} is unsupported for ${kind}`);
  }
  return width as number;
}

function validateLatency(value: unknown, path: string): asserts value is EventLatency {
  if (typeof value !== "object" || value === null) throw new Error(`${path} is required`);
  const latency = value as Partial<EventLatency>;
  if (latency.status === "known") {
    if (typeof latency.cycles !== "bigint" || latency.cycles < 0n) {
      throw new Error(`${path}.cycles must be a non-negative bigint`);
    }
    if (latency.calibration !== "calibrated" && latency.calibration !== "uncalibrated") {
      throw new Error(`${path}.calibration must be calibrated or uncalibrated`);
    }
    requireNonEmpty(latency.source, `${path}.source`);
    return;
  }
  if (latency.status === "unknown") {
    requireNonEmpty(latency.reason, `${path}.reason`);
    requireNonEmpty(latency.source, `${path}.source`);
    return;
  }
  throw new Error(`${path}.status must be known or unknown`);
}

function storeBufferOptions(
  options: NeutralTraceAdapterOptions,
): Readonly<{ retirementLatency: EventLatency; memwLatency: EventLatency }> | null {
  if (typeof options !== "object" || options === null) {
    throw new Error("neutral trace adapter options must be an object");
  }
  if (options.storeBuffer === undefined) return null;
  if (typeof options.storeBuffer !== "object" || options.storeBuffer === null) {
    throw new Error("neutral trace adapter options.storeBuffer must be an object");
  }
  validateLatency(
    options.storeBuffer.retirementLatency,
    "neutral trace adapter options.storeBuffer.retirementLatency",
  );
  validateLatency(
    options.storeBuffer.memwLatency,
    "neutral trace adapter options.storeBuffer.memwLatency",
  );
  return Object.freeze({
    retirementLatency: Object.freeze({ ...options.storeBuffer.retirementLatency }),
    memwLatency: Object.freeze({ ...options.storeBuffer.memwLatency }),
  });
}

function exactMemw(observation: NeutralTraceObservation, index: number): boolean {
  const encoding = observation.instructionEncoding;
  if (encoding === undefined || encoding.value !== XTENSA_MEMW_INSTRUCTION_ENCODING) return false;
  if (observation.width !== 3) {
    throw new Error(
      `neutral trace observations[${index}] memw encoding requires exact three-byte width`,
    );
  }
  return true;
}

function memoryObservation(
  observation: NeutralTraceObservation,
  index: number,
  storeBuffer: Readonly<StoreBufferTiming> | null,
): RuntimeMemoryObservation {
  const path = `neutral trace observations[${index}]`;
  if (typeof observation !== "object" || observation === null) {
    throw new Error(`${path} must be an observation`);
  }
  requireNonEmpty(observation.id, `${path}.id`);
  requireSequence(observation.sequence, `${path}.sequence`);
  if (observation.core !== 0 && observation.core !== 1) {
    throw new Error(`${path}.core must be 0 or 1`);
  }
  if (observation.kind !== "instruction" && observation.kind !== "read" && observation.kind !== "write") {
    throw new Error(`${path}.kind must be instruction, read, or write`);
  }
  if (typeof observation.address !== "bigint" || observation.address < 0n) {
    throw new Error(`${path}.address must be a non-negative bigint`);
  }
  const bytes = validateWidth(observation.kind, observation.width, `${path}.width`);
  if (observation.cpuCost !== undefined && observation.kind !== "instruction") {
    throw new Error(`${path}.cpuCost is only valid for an instruction observation`);
  }
  if (observation.preDataCpuCost !== undefined) {
    if (observation.kind !== "instruction") {
      throw new Error(`${path}.preDataCpuCost is only valid for an instruction observation`);
    }
    validateLatency(observation.preDataCpuCost, `${path}.preDataCpuCost`);
  }
  if (observation.cpuCost?.status === "unknown") {
    requireNonEmpty(observation.cpuCost.source, `${path}.cpuCost.source`);
  }
  if (observation.instructionEncoding !== undefined) {
    if (observation.kind !== "instruction") {
      throw new Error(`${path}.instructionEncoding is only valid for an instruction observation`);
    }
    if (typeof observation.instructionEncoding !== "object" || observation.instructionEncoding === null) {
      throw new Error(`${path}.instructionEncoding must be an object`);
    }
    const encoding = observation.instructionEncoding.value;
    if (!Number.isSafeInteger(encoding) || encoding < 0 || encoding >= 2 ** (bytes * 8)) {
      throw new Error(`${path}.instructionEncoding.value must fit the instruction width`);
    }
    requireNonEmpty(observation.instructionEncoding.source, `${path}.instructionEncoding.source`);
  }
  if (observation.issuingInstructionAddress !== undefined) {
    if (observation.kind === "instruction") {
      throw new Error(`${path}.issuingInstructionAddress is only valid for a data observation`);
    }
    if (typeof observation.issuingInstructionAddress !== "bigint" || observation.issuingInstructionAddress < 0n) {
      throw new Error(`${path}.issuingInstructionAddress must be a non-negative bigint`);
    }
  }
  if (observation.extension !== undefined) {
    if (typeof observation.extension !== "object" || observation.extension === null) {
      throw new Error(`${path}.extension must be an object`);
    }
    if (observation.extension.kind !== "literal-load") {
      throw new Error(`${path}.extension.kind must be literal-load`);
    }
    if (observation.kind !== "read") {
      throw new Error(`${path} literal-load extension requires a read observation`);
    }
    requireNonEmpty(observation.extension.source, `${path}.extension.source`);
  }
  return Object.freeze({
    core: observation.core,
    kind: observation.kind === "instruction"
      ? "instruction-fetch"
      : observation.kind === "write"
        ? "store"
        : observation.extension?.kind === "literal-load"
          ? "literal-load"
          : "load",
    address: observation.address,
    bytes,
    ...(observation.kind === "write" && storeBuffer !== null
      ? { storeBuffer: Object.freeze({ retirementLatency: storeBuffer.retirementLatency }) }
      : {}),
  });
}

function cpuEventFor(
  observation: NeutralTraceObservation,
  source: string,
): CpuExecutionEvent {
  const latency: EventLatency = observation.cpuCost === undefined
    ? Object.freeze({
        status: "unknown" as const,
        reason: `instruction ${observation.id} has no caller-supplied CPU cost`,
        source,
      })
    : Object.freeze({ ...observation.cpuCost });
  return Object.freeze({
    id: `${observation.id}:cpu`,
    kind: "cpu",
    core: observation.core,
    instructionAccessId: observation.id,
    latency,
  });
}

function preDataCpuEventFor(observation: NeutralTraceObservation): CpuExecutionEvent {
  return Object.freeze({
    id: `${observation.id}:pre-data-cpu`,
    kind: "cpu",
    core: observation.core,
    instructionAccessId: observation.id,
    latency: Object.freeze({ ...observation.preDataCpuCost! }),
  });
}

function fenceEventFor(
  observation: NeutralTraceObservation,
  latency: EventLatency,
): TimingMachineFence {
  return Object.freeze({
    id: `${observation.id}:fence`,
    kind: "fence",
    core: observation.core,
    operation: "memw",
    instructionAccessId: observation.id,
    latency: Object.freeze({ ...latency }),
  });
}

function provenanceFor(
  trace: BoundedNeutralTrace,
  memwAccessIds: ReadonlySet<string>,
): RuntimeTraceProvenance {
  const source = requireNonEmpty(trace.provenance.source, "neutral trace provenance.source");
  const format = requireNonEmpty(trace.provenance.format, "neutral trace provenance.format");
  let digest: RuntimeTraceProvenance["digest"] = null;
  if (trace.provenance.digest !== undefined) {
    if (trace.provenance.digest.algorithm !== "sha256") {
      throw new Error("neutral trace provenance.digest.algorithm must be sha256");
    }
    if (!/^[0-9a-f]{64}$/.test(trace.provenance.digest.value)) {
      throw new Error("neutral trace provenance.digest.value must be 64 lowercase hexadecimal characters");
    }
    digest = Object.freeze({ ...trace.provenance.digest });
  }
  return Object.freeze({
    source,
    format,
    digest,
    bounds: Object.freeze({
      capacity: trace.capacity,
      observed: trace.observations.length,
      overflow: trace.overflow,
    }),
    extensions: Object.freeze(
      trace.observations
        .filter((observation) =>
          observation.extension?.kind === "literal-load" || memwAccessIds.has(observation.id),
        )
        .sort((left, right) => left.sequence - right.sequence)
        .map((observation) => Object.freeze({
          accessId: observation.id,
          kind: observation.extension?.kind === "literal-load" ? "literal-load" as const : "memw" as const,
          source: observation.extension?.kind === "literal-load"
            ? observation.extension.source
            : observation.instructionEncoding!.source,
        })),
    ),
  });
}

/**
 * Convert caller-observed instruction, read, and write facts into the pack's
 * runtime timing seam. Addresses, cores, order, literal-load classification,
 * and optional DMA are all explicit inputs. Configuration supplies every
 * address mapping and memory cost after this boundary. Per-core data records
 * stay with the preceding instruction until that core's next instruction.
 * The opt-in store-buffer mode additionally requires exact instruction words
 * and issuing PCs, and replaces an exact three-byte memw with a fence event.
 */
export function adaptNeutralTimingTrace(
  trace: BoundedNeutralTrace,
  dma: readonly ExplicitDmaObservation[] = [],
  options: NeutralTraceAdapterOptions = {},
): RuntimeTimingTrace {
  if (typeof trace !== "object" || trace === null) throw new Error("neutral trace is required");
  if (trace.schemaVersion !== 1) throw new Error("neutral trace schemaVersion must be 1");
  if (!Number.isSafeInteger(trace.capacity) || trace.capacity < 0) {
    throw new Error("neutral trace capacity must be a non-negative safe integer");
  }
  if (typeof trace.overflow !== "boolean") throw new Error("neutral trace overflow must be boolean");
  if (!Array.isArray(trace.observations)) throw new Error("neutral trace observations must be an array");
  if (trace.observations.length > trace.capacity) {
    throw new Error(`neutral trace observed ${trace.observations.length} records beyond capacity ${trace.capacity}`);
  }
  if (typeof trace.provenance !== "object" || trace.provenance === null) {
    throw new Error("neutral trace provenance is required");
  }
  if (!Array.isArray(dma)) throw new Error("neutral trace DMA observations must be an array");
  const buffer = storeBufferOptions(options);
  if (buffer !== null && trace.overflow) {
    throw new Error("neutral trace store-buffer mode requires a complete non-overflow trace");
  }

  const memory = trace.observations.map((observation, index) => {
    const runtimeObservation = memoryObservation(
      observation,
      index,
      buffer === null ? null : { retirementLatency: buffer.retirementLatency },
    );
    if (buffer !== null && observation.kind === "instruction" && observation.instructionEncoding === undefined) {
      throw new Error(
        `neutral trace observations[${index}].instructionEncoding is required in store-buffer mode`,
      );
    }
    if (buffer !== null && observation.kind !== "instruction" && observation.issuingInstructionAddress === undefined) {
      throw new Error(
        `neutral trace observations[${index}].issuingInstructionAddress is required in store-buffer mode`,
      );
    }
    return Object.freeze({
      sequence: requireSequence(observation?.sequence, `neutral trace observations[${index}].sequence`),
      id: observation?.id,
      neutral: observation,
      observation: runtimeObservation,
      isMemw: buffer !== null && observation.kind === "instruction" && exactMemw(observation, index),
    });
  });
  const explicitDma = dma.map((observation, index) => {
    const path = `neutral trace DMA observations[${index}]`;
    if (typeof observation !== "object" || observation === null) {
      throw new Error(`${path} must be an observation`);
    }
    return Object.freeze({
      sequence: requireSequence(observation.sequence, `${path}.sequence`),
      event: observation.event,
    });
  });
  const ordered = [
    ...memory.map((entry) => Object.freeze({ kind: "memory" as const, ...entry })),
    ...explicitDma.map((entry) => Object.freeze({ kind: "dma" as const, ...entry })),
  ].sort((left, right) => left.sequence - right.sequence);
  for (const [index, observation] of ordered.entries()) {
    if (observation.sequence !== index) {
      throw new Error(`neutral trace total observation order must contain sequence ${index} exactly once`);
    }
  }

  const memwAccessIds = new Set(
    memory.filter((observation) => observation.isMemw).map((observation) => observation.id),
  );
  const provenance = provenanceFor(trace, memwAccessIds);
  const eventAfterSequence = new Map<number, Readonly<{
    kind: "cpu";
    event: CpuExecutionEvent;
  }> | Readonly<{
    kind: "fence";
    event: TimingMachineFence;
  }>>();
  const preDataEventAfterSequence = new Map<number, CpuExecutionEvent>();
  const pending: Array<Readonly<{
    closing: Readonly<{ kind: "cpu"; event: CpuExecutionEvent }> | Readonly<{
      kind: "fence";
      event: TimingMachineFence;
    }>;
    instructionAddress: bigint;
    lastMemorySequence: number;
  }> | null> = [null, null];
  for (const observation of ordered) {
    if (observation.kind !== "memory") continue;
    const core = observation.observation.core;
    if (observation.neutral.kind === "instruction") {
      const previous = pending[core];
      if (previous !== null) eventAfterSequence.set(previous.lastMemorySequence, previous.closing);
      if (observation.isMemw && observation.neutral.cpuCost !== undefined) {
        throw new Error(
          `neutral trace instruction ${observation.id} cannot supply both cpuCost and memwLatency`,
        );
      }
      pending[core] = Object.freeze({
        closing: observation.isMemw
          ? Object.freeze({
              kind: "fence" as const,
              event: fenceEventFor(observation.neutral, buffer!.memwLatency),
            })
          : Object.freeze({
              kind: "cpu" as const,
              event: cpuEventFor(observation.neutral, provenance.source),
            }),
        instructionAddress: observation.neutral.address,
        lastMemorySequence: observation.sequence,
      });
      if (observation.neutral.preDataCpuCost !== undefined) {
        preDataEventAfterSequence.set(
          observation.sequence,
          preDataCpuEventFor(observation.neutral),
        );
      }
      continue;
    }
    const current = pending[core];
    if (buffer !== null) {
      if (current === null) {
        throw new Error(`neutral trace data observation ${observation.id} has no preceding instruction`);
      }
      if (observation.neutral.issuingInstructionAddress !== current.instructionAddress) {
        throw new Error(
          `neutral trace data observation ${observation.id} issuing PC does not match its preceding instruction`,
        );
      }
      if (current.closing.kind === "fence") {
        throw new Error(`neutral trace memw instruction cannot own data observation ${observation.id}`);
      }
    }
    if (current !== null) {
      pending[core] = Object.freeze({ ...current, lastMemorySequence: observation.sequence });
    }
  }
  for (const current of pending) {
    if (current !== null) eventAfterSequence.set(current.lastMemorySequence, current.closing);
  }

  const recorder = new RuntimeTimingTraceRecorder(provenance.source);
  for (const observation of ordered) {
    if (observation.kind === "memory") {
      recorder.recordMemory(observation.observation, observation.id);
    } else {
      recorder.recordDma(observation.event);
    }
    const preData = preDataEventAfterSequence.get(observation.sequence);
    if (preData !== undefined) recorder.recordCpu(preData);
    const closing = eventAfterSequence.get(observation.sequence);
    if (closing?.kind === "cpu") recorder.recordCpu(closing.event);
    if (closing?.kind === "fence") recorder.recordFence(closing.event);
  }
  return Object.freeze({ ...recorder.snapshot(), provenance });
}
