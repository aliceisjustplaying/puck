/*
 * Experiment-only bridge from the flexe binary ABI to the pack's neutral
 * trace boundary. Production timing code has no dependency on this ABI.
 */
import {
  adaptNeutralTimingTrace,
  XTENSA_MEMW_INSTRUCTION_ENCODING,
  type BoundedNeutralTrace,
  type NeutralTraceAdapterOptions,
  type NeutralTraceKind,
} from "../../packs/esp32-s3-touch-amoled-18/timing/trace-adapter";
import type { CpuExecutionEvent, EventLatency } from "../../packs/esp32-s3-touch-amoled-18/timing/execution";
import type {
  RuntimeTimingTrace,
  RuntimeTraceObservation,
} from "../../packs/esp32-s3-touch-amoled-18/timing/runtime-trace";
import { classifyFlexeBeqzCpuCosts, type FlexeBeqzTimingOptions } from "./flexe-beqz";
import {
  detectFlexeDependentSramLoadUseHazards,
  type FlexeDependentSramLoadUseHazardOptions,
} from "./flexe-load-use";
import { TRACE_KINDS, type DecodedTrace, type TraceRecord } from "./trace-abi";

export interface FlexeTraceTimingProvenance {
  readonly source: string;
  readonly sha256: string;
  readonly core: 0 | 1;
}

export interface FlexeRomCallbackBoundary {
  readonly kind: string;
  readonly pc: number;
  readonly afterInstructionCount: number;
}

export interface FlexeTraceTimingOptions extends NeutralTraceAdapterOptions {
  readonly instructionCpuCost?: EventLatency;
  readonly dependentSramLoadUseHazard?: FlexeDependentSramLoadUseHazardOptions;
  readonly beqzCpuCost?: FlexeBeqzTimingOptions;
  readonly romCallbacks?: readonly FlexeRomCallbackBoundary[];
}

function kindFor(record: TraceRecord, index: number): NeutralTraceKind {
  if (record.kind === TRACE_KINDS.instruction) return "instruction";
  if (record.kind === TRACE_KINDS.read) return "read";
  if (record.kind === TRACE_KINDS.write) return "write";
  throw new Error(`flexe trace record ${index} has unsupported kind ${record.kind}`);
}

function exactL32rPcs(decoded: DecodedTrace): ReadonlySet<number> {
  const encodings = new Map<number, number>();
  const pcs = new Set<number>();
  for (const [index, record] of decoded.records.entries()) {
    if (record.kind !== TRACE_KINDS.instruction) continue;
    const previous = encodings.get(record.pc);
    if (previous !== undefined && previous !== record.instruction) {
      throw new Error(`flexe trace instruction PC 0x${record.pc.toString(16)} has inconsistent encodings`);
    }
    encodings.set(record.pc, record.instruction);
    if (record.width === 3 && (record.instruction & 0xf) === 1) pcs.add(record.pc);
    if (record.width !== 2 && record.width !== 3) {
      throw new Error(`flexe trace instruction ${index} has unsupported width ${record.width}`);
    }
  }
  return pcs;
}

function attachRomCallbackBoundaries(
  runtime: RuntimeTimingTrace,
  instructionAccessIds: readonly string[],
  provenance: FlexeTraceTimingProvenance,
  callbacks: readonly FlexeRomCallbackBoundary[] | undefined,
): RuntimeTimingTrace {
  if (callbacks === undefined) return runtime;
  if (!Array.isArray(callbacks)) throw new Error("flexe ROM callbacks must be an array");
  const callbacksByInstruction = new Map<string, CpuExecutionEvent[]>();
  const callbackCpuById = new Map<string, CpuExecutionEvent>();
  let previousInstructionCount = 0;
  for (const [index, callback] of callbacks.entries()) {
    if (typeof callback !== "object" || callback === null) {
      throw new Error(`flexe ROM callbacks[${index}] must be a callback boundary`);
    }
    if (typeof callback.kind !== "string" || callback.kind.length === 0) {
      throw new Error(`flexe ROM callbacks[${index}].kind must be a non-empty string`);
    }
    if (!Number.isInteger(callback.pc) || callback.pc < 0 || callback.pc > 0xffff_ffff) {
      throw new Error(`flexe ROM callbacks[${index}].pc must be a uint32`);
    }
    if (
      !Number.isSafeInteger(callback.afterInstructionCount) ||
      callback.afterInstructionCount <= 0 ||
      callback.afterInstructionCount > instructionAccessIds.length
    ) {
      throw new Error(
        `flexe ROM callbacks[${index}].afterInstructionCount must identify an executed instruction`,
      );
    }
    if (callback.afterInstructionCount < previousInstructionCount) {
      throw new Error("flexe ROM callbacks must be ordered by afterInstructionCount");
    }
    previousInstructionCount = callback.afterInstructionCount;
    const instructionAccessId = instructionAccessIds[callback.afterInstructionCount - 1]!;
    const event = Object.freeze({
      id: `${instructionAccessId}:rom-callback:${index}:${callback.kind}`,
      kind: "cpu" as const,
      core: provenance.core,
      instructionAccessId,
      latency: Object.freeze({
        status: "unknown" as const,
        reason: `ROM callback ${callback.kind} at 0x${callback.pc.toString(16)} has no adopted CPU duration`,
        source:
          `full ELF ROM event afterInstructionCount ${callback.afterInstructionCount}; ${provenance.source}`,
      }),
    });
    callbackCpuById.set(event.id, event);
    const existing = callbacksByInstruction.get(instructionAccessId);
    if (existing === undefined) callbacksByInstruction.set(instructionAccessId, [event]);
    else existing.push(event);
  }
  if (callbackCpuById.size === 0) return runtime;

  const observationOrder: RuntimeTraceObservation[] = [];
  for (const observation of runtime.observationOrder) {
    observationOrder.push(Object.freeze({ ...observation, sequence: observationOrder.length }));
    if (
      observation.kind !== "cpu" ||
      observation.eventId !== `${observation.instructionAccessId}:cpu`
    ) continue;
    for (const callback of callbacksByInstruction.get(observation.instructionAccessId) ?? []) {
      observationOrder.push(Object.freeze({
        sequence: observationOrder.length,
        kind: "cpu",
        eventId: callback.id,
        instructionAccessId: callback.instructionAccessId,
      }));
    }
  }
  if (observationOrder.length !== runtime.observationOrder.length + callbackCpuById.size) {
    throw new Error("flexe ROM callback boundary has no preceding instruction CPU event");
  }
  const originalCpuById = new Map((runtime.input.cpu ?? []).map((event) => [event.id, event]));
  const cpu = observationOrder
    .filter((observation): observation is Extract<RuntimeTraceObservation, { kind: "cpu" }> =>
      observation.kind === "cpu",
    )
    .map((observation) => {
      const event = callbackCpuById.get(observation.eventId) ?? originalCpuById.get(observation.eventId);
      if (event === undefined) throw new Error(`flexe CPU observation ${observation.eventId} has no event`);
      return event;
    });
  const issueOrder = observationOrder.map((observation) =>
    observation.kind === "memory"
      ? Object.freeze({ kind: "memory" as const, accessId: observation.accessId })
      : Object.freeze({ kind: observation.kind, eventId: observation.eventId }),
  );
  return Object.freeze({
    ...runtime,
    observationOrder: Object.freeze(observationOrder),
    input: Object.freeze({
      ...runtime.input,
      cpu: Object.freeze(cpu),
      issueOrder: Object.freeze(issueOrder),
    }),
  });
}

export function adaptFlexeTraceToRuntimeTiming(
  decoded: DecodedTrace,
  provenance: FlexeTraceTimingProvenance,
  options: FlexeTraceTimingOptions = {},
): RuntimeTimingTrace {
  const loadUseHazards = detectFlexeDependentSramLoadUseHazards(
    decoded,
    options.instructionCpuCost,
    options.dependentSramLoadUseHazard,
  );
  const beqzCpuCosts = classifyFlexeBeqzCpuCosts(decoded, options.beqzCpuCost);
  const l32rPcs = exactL32rPcs(decoded);
  const strictInstructionIdentity =
    options.storeBuffer !== undefined ||
    options.dependentSramLoadUseHazard !== undefined ||
    options.beqzCpuCost !== undefined;
  const observations = decoded.records.map((record, sequence) => {
    const kind = kindFor(record, sequence);
    const literalLoad = kind === "read" && l32rPcs.has(record.pc);
    if (strictInstructionIdentity && kind !== "instruction" && record.instruction !== 0) {
      throw new Error(`flexe trace data record ${sequence} must not carry an instruction encoding`);
    }
    const timingKind = kind === "instruction"
      ? "instruction-fetch"
      : literalLoad
        ? "literal-load"
        : kind === "read"
          ? "load"
          : "store";
    const isMemw =
      options.storeBuffer !== undefined &&
      kind === "instruction" &&
      record.width === 3 &&
      record.instruction === XTENSA_MEMW_INSTRUCTION_ENCODING;
    const loadUseHazard = loadUseHazards.get(sequence);
    const instructionCpuCost = beqzCpuCosts.get(sequence) ?? options.instructionCpuCost;
    return Object.freeze({
      id: `trace:${sequence.toString().padStart(2, "0")}:${timingKind}`,
      sequence,
      core: provenance.core,
      kind,
      address: BigInt(kind === "instruction" ? record.pc : record.address),
      width: record.width,
      ...(kind === "instruction"
        ? {
            instructionEncoding: Object.freeze({
              value: record.instruction,
              source: `flexe execution trace ABI v${decoded.abiVersion} instruction field`,
            }),
            ...(instructionCpuCost === undefined || isMemw
              ? {}
              : {
                  cpuCost: Object.freeze({ ...instructionCpuCost }),
                }),
            ...(loadUseHazard === undefined
              ? {}
              : { preDataCpuCost: Object.freeze({ ...loadUseHazard.latency }) }),
          }
        : {
            issuingInstructionAddress: BigInt(record.pc),
            ...(literalLoad
              ? {
                  extension: Object.freeze({
                    kind: "literal-load" as const,
                    source: `exact Xtensa L32R encoding at 0x${record.pc.toString(16)}`,
                  }),
                }
              : {}),
          }),
    });
  });
  const neutral: BoundedNeutralTrace = Object.freeze({
    schemaVersion: 1,
    capacity: decoded.capacity,
    overflow: decoded.overflow,
    provenance: Object.freeze({
      source: provenance.source,
      format: `flexe-execution-trace-abi-v${decoded.abiVersion}`,
      digest: Object.freeze({ algorithm: "sha256", value: provenance.sha256 }),
    }),
    observations: Object.freeze(observations),
  });
  const runtime = adaptNeutralTimingTrace(neutral, [], { storeBuffer: options.storeBuffer });
  const instructionAccessIds = observations
    .filter((observation) => observation.kind === "instruction")
    .map((observation) => observation.id);
  return attachRomCallbackBoundaries(
    runtime,
    instructionAccessIds,
    provenance,
    options.romCallbacks,
  );
}
