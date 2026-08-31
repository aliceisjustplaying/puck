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
import type { EventLatency } from "../../packs/esp32-s3-touch-amoled-18/timing/execution";
import type { RuntimeTimingTrace } from "../../packs/esp32-s3-touch-amoled-18/timing/runtime-trace";
import { TRACE_KINDS, type DecodedTrace, type TraceRecord } from "./trace-abi";

export interface FlexeTraceTimingProvenance {
  readonly source: string;
  readonly sha256: string;
  readonly core: 0 | 1;
}

export interface FlexeTraceTimingOptions extends NeutralTraceAdapterOptions {
  readonly instructionCpuCost?: EventLatency;
}
function kindFor(record: TraceRecord, index: number): NeutralTraceKind {
  if (record.kind === TRACE_KINDS.instruction) return "instruction";
  if (record.kind === TRACE_KINDS.read) return "read";
  if (record.kind === TRACE_KINDS.write) return "write";
  throw new Error(`flexe trace record ${index} has unsupported kind ${record.kind}`);
}

export function adaptFlexeTraceToRuntimeTiming(
  decoded: DecodedTrace,
  provenance: FlexeTraceTimingProvenance,
  options: FlexeTraceTimingOptions = {},
): RuntimeTimingTrace {
  const observations = decoded.records.map((record, sequence) => {
    const kind = kindFor(record, sequence);
    if (options.storeBuffer !== undefined && kind !== "instruction" && record.instruction !== 0) {
      throw new Error(`flexe trace data record ${sequence} must not carry an instruction encoding`);
    }
    const timingKind = kind === "instruction" ? "instruction-fetch" : kind === "read" ? "load" : "store";
    const isMemw =
      options.storeBuffer !== undefined &&
      kind === "instruction" &&
      record.width === 3 &&
      record.instruction === XTENSA_MEMW_INSTRUCTION_ENCODING;
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
            ...(options.instructionCpuCost === undefined || isMemw
              ? {}
              : { cpuCost: Object.freeze({ ...options.instructionCpuCost }) }),
          }
        : { issuingInstructionAddress: BigInt(record.pc) }),
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
  return adaptNeutralTimingTrace(neutral, [], { storeBuffer: options.storeBuffer });
}
