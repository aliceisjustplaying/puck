import type { DmaEvent } from "./execution";
import {
  RuntimeTimingTraceRecorder,
  type RuntimeMemoryObservation,
  type RuntimeTimingTrace,
  type RuntimeTraceProvenance,
} from "./runtime-trace";

export type NeutralTraceKind = "instruction" | "read" | "write";

export interface NeutralTraceObservation {
  readonly id: string;
  readonly sequence: number;
  readonly core: 0 | 1;
  readonly kind: NeutralTraceKind;
  readonly address: bigint;
  readonly width: number;
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
  if (kind === "instruction" ? width !== 2 && width !== 3 : width !== 1 && width !== 2 && width !== 4) {
    throw new Error(`${path} ${String(width)} is unsupported for ${kind}`);
  }
  return width as number;
}

function memoryObservation(
  observation: NeutralTraceObservation,
  index: number,
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
  });
}

function provenanceFor(trace: BoundedNeutralTrace): RuntimeTraceProvenance {
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
        .filter((observation) => observation.extension?.kind === "literal-load")
        .sort((left, right) => left.sequence - right.sequence)
        .map((observation) => Object.freeze({
          accessId: observation.id,
          kind: "literal-load" as const,
          source: observation.extension!.source,
        })),
    ),
  });
}

/**
 * Convert caller-observed instruction, read, and write facts into the pack's
 * runtime timing seam. Addresses, cores, order, literal-load classification,
 * and optional DMA are all explicit inputs. Configuration supplies every
 * address mapping and cost after this boundary.
 */
export function adaptNeutralTimingTrace(
  trace: BoundedNeutralTrace,
  dma: readonly ExplicitDmaObservation[] = [],
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

  const memory = trace.observations.map((observation, index) => Object.freeze({
    sequence: requireSequence(observation?.sequence, `neutral trace observations[${index}].sequence`),
    id: observation?.id,
    observation: memoryObservation(observation, index),
  }));
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

  const provenance = provenanceFor(trace);
  const recorder = new RuntimeTimingTraceRecorder(provenance.source);
  for (const observation of ordered) {
    if (observation.kind === "memory") {
      recorder.recordMemory(observation.observation, observation.id);
    } else {
      recorder.recordDma(observation.event);
    }
  }
  return Object.freeze({ ...recorder.snapshot(), provenance });
}
