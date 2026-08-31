import type { VirtualMemoryAccess } from "./address-map";
import { scheduleExecution, type CpuExecutionEvent, type DmaEvent } from "./execution";
import {
  runTimingMachine,
  timingMachineJson,
  type TimingMachineConfiguration,
  type TimingMachineInput,
  type TimingMachineClaim,
  type TimingMachineResult,
} from "./machine";

export interface RuntimeMemoryObservation {
  readonly kind: VirtualMemoryAccess["kind"];
  readonly core: VirtualMemoryAccess["core"];
  readonly address: bigint;
  readonly bytes: number;
}

export type RuntimeTraceObservation =
  | Readonly<{
      sequence: number;
      kind: "memory";
      accessId: string;
    }>
  | Readonly<{
      sequence: number;
      kind: "cpu";
      eventId: string;
      instructionAccessId: string;
    }>
  | Readonly<{
      sequence: number;
      kind: "dma";
      eventId: string;
    }>;

export interface RuntimeTimingClaim {
  readonly architectureCalibration: "uncalibrated";
  readonly coverage: "caller-reported-events-only";
  readonly source: string;
  readonly cycleAccurate: false;
  readonly countsOnlyInstrumentedEvents: true;
  readonly hostTraceTimeIsSimulatedTime: false;
}

export interface RuntimeTraceProvenance {
  readonly source: string;
  readonly format: string;
  readonly digest: Readonly<{
    algorithm: "sha256";
    value: string;
  }> | null;
  readonly bounds: Readonly<{
    capacity: number;
    observed: number;
    overflow: boolean;
  }>;
  readonly extensions: readonly Readonly<{
    accessId: string;
    kind: "literal-load";
    source: string;
  }>[];
}

export interface RuntimeTimingTrace {
  readonly schemaVersion: 1;
  readonly claim: Readonly<RuntimeTimingClaim>;
  readonly provenance?: Readonly<RuntimeTraceProvenance>;
  readonly observationOrder: readonly RuntimeTraceObservation[];
  readonly input: TimingMachineInput;
}

export interface RuntimeTimingResult extends Omit<TimingMachineResult, "claim"> {
  readonly claim: TimingMachineClaim & RuntimeTimingClaim;
  readonly provenance?: Readonly<RuntimeTraceProvenance>;
  readonly observationOrder: readonly RuntimeTraceObservation[];
}

function requireNonEmpty(value: unknown, path: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${path} must be a non-empty string`);
  }
  return value;
}

function validateMemoryObservation(value: RuntimeMemoryObservation): void {
  if (typeof value !== "object" || value === null) throw new Error("runtime memory observation is required");
  if (
    value.kind !== "instruction-fetch" &&
    value.kind !== "literal-load" &&
    value.kind !== "load" &&
    value.kind !== "store"
  ) {
    throw new Error(
      "runtime memory observation kind must be instruction-fetch, literal-load, load, or store",
    );
  }
  if (value.core !== 0 && value.core !== 1) throw new Error("runtime memory observation core must be 0 or 1");
  if (typeof value.address !== "bigint" || value.address < 0n) {
    throw new Error("runtime memory observation address must be a non-negative bigint");
  }
  if (!Number.isSafeInteger(value.bytes) || value.bytes <= 0) {
    throw new Error("runtime memory observation bytes must be a positive safe integer");
  }
}

function freezeDma(event: DmaEvent): DmaEvent {
  scheduleExecution([event]);
  const latency = event.latency.status === "known"
    ? Object.freeze({
        status: "known" as const,
        cycles: event.latency.cycles,
        calibration: event.latency.calibration,
        source: event.latency.source,
      })
    : Object.freeze({
        status: "unknown" as const,
        reason: event.latency.reason,
        ...(event.latency.source === undefined ? {} : { source: event.latency.source }),
      });
  const source = event.source.kind === "memory"
    ? Object.freeze({ kind: "memory" as const, memory: event.source.memory })
    : Object.freeze({ kind: "mmio" as const, peripheral: event.source.peripheral });
  const destination = event.destination.kind === "memory"
    ? Object.freeze({ kind: "memory" as const, memory: event.destination.memory })
    : Object.freeze({ kind: "mmio" as const, peripheral: event.destination.peripheral });
  return Object.freeze({
    id: event.id,
    kind: "dma",
    channel: event.channel,
    earliest: Object.freeze({ ...event.earliest }),
    source,
    destination,
    bytes: event.bytes,
    latency,
  });
}

function freezeCpu(event: CpuExecutionEvent): CpuExecutionEvent {
  scheduleExecution([event]);
  const latency = event.latency.status === "known"
    ? Object.freeze({ ...event.latency })
    : Object.freeze({
        status: "unknown" as const,
        reason: event.latency.reason,
        ...(event.latency.source === undefined ? {} : { source: event.latency.source }),
      });
  return Object.freeze({
    id: event.id,
    kind: "cpu",
    core: event.core,
    instructionAccessId: event.instructionAccessId,
    latency,
  });
}

/**
 * Collect the exact event order reported by an execution runtime. The recorder
 * makes no completeness claim and supplies no addresses, mappings, or costs.
 */
export class RuntimeTimingTraceRecorder {
  readonly #claim: RuntimeTimingTrace["claim"];
  readonly #cores: [VirtualMemoryAccess[], VirtualMemoryAccess[]] = [[], []];
  readonly #interleave: string[] = [];
  readonly #cpu: CpuExecutionEvent[] = [];
  readonly #dma: DmaEvent[] = [];
  readonly #observations: RuntimeTraceObservation[] = [];
  readonly #ids = new Set<string>();
  readonly #memoryById = new Map<string, VirtualMemoryAccess>();
  #nextAccessId = 0;

  constructor(source: string) {
    this.#claim = Object.freeze({
      architectureCalibration: "uncalibrated",
      coverage: "caller-reported-events-only",
      source: requireNonEmpty(source, "runtime trace source"),
      cycleAccurate: false,
      countsOnlyInstrumentedEvents: true,
      hostTraceTimeIsSimulatedTime: false,
    });
  }

  recordMemory(observation: RuntimeMemoryObservation, suppliedId?: string): string {
    validateMemoryObservation(observation);
    let id = suppliedId === undefined
      ? `runtime-access:${this.#nextAccessId}`
      : requireNonEmpty(suppliedId, "runtime memory access id");
    if (suppliedId === undefined) {
      while (this.#ids.has(id)) {
        this.#nextAccessId += 1;
        id = `runtime-access:${this.#nextAccessId}`;
      }
      this.#nextAccessId += 1;
    }
    if (this.#ids.has(id)) throw new Error(`runtime trace event id ${id} is already in use`);
    this.#ids.add(id);
    const access: VirtualMemoryAccess = Object.freeze({
      id,
      kind: observation.kind,
      core: observation.core,
      address: observation.address,
      bytes: observation.bytes,
    });
    this.#cores[observation.core].push(access);
    this.#memoryById.set(id, access);
    this.#interleave.push(id);
    this.#observations.push(
      Object.freeze({ sequence: this.#observations.length, kind: "memory", accessId: id }),
    );
    return id;
  }

  recordCpu(event: CpuExecutionEvent): void {
    if (typeof event !== "object" || event === null) throw new Error("runtime CPU event is required");
    requireNonEmpty(event.id, "runtime CPU event.id");
    if (this.#ids.has(event.id)) throw new Error(`runtime trace event id ${event.id} is already in use`);
    const instruction = this.#memoryById.get(event.instructionAccessId);
    if (!instruction || instruction.kind !== "instruction-fetch") {
      throw new Error("runtime CPU event.instructionAccessId must name a recorded instruction-fetch access");
    }
    if (event.core !== instruction.core) {
      throw new Error("runtime CPU event.core must match its instruction-fetch access");
    }
    const frozen = freezeCpu(event);
    this.#ids.add(frozen.id);
    this.#cpu.push(frozen);
    this.#observations.push(Object.freeze({
      sequence: this.#observations.length,
      kind: "cpu",
      eventId: frozen.id,
      instructionAccessId: frozen.instructionAccessId,
    }));
  }

  recordDma(event: DmaEvent): void {
    if (typeof event !== "object" || event === null) throw new Error("runtime DMA event is required");
    requireNonEmpty(event.id, "runtime DMA event.id");
    if (this.#ids.has(event.id)) throw new Error(`runtime trace event id ${event.id} is already in use`);
    const frozen = freezeDma(event);
    this.#ids.add(frozen.id);
    this.#dma.push(frozen);
    this.#observations.push(
      Object.freeze({ sequence: this.#observations.length, kind: "dma", eventId: frozen.id }),
    );
  }

  snapshot(): RuntimeTimingTrace {
    const input: TimingMachineInput = Object.freeze({
      cores: Object.freeze([
        Object.freeze([...this.#cores[0]]),
        Object.freeze([...this.#cores[1]]),
      ]) as TimingMachineInput["cores"],
      architecturalInterleave: Object.freeze([...this.#interleave]),
      cpu: Object.freeze([...this.#cpu]),
      dma: Object.freeze([...this.#dma]),
      issueOrder: Object.freeze(
        this.#observations.map((observation) => {
          if (observation.kind === "memory") {
            return Object.freeze({ kind: "memory" as const, accessId: observation.accessId });
          }
          return Object.freeze({ kind: observation.kind, eventId: observation.eventId });
        }),
      ),
    });
    return Object.freeze({
      schemaVersion: 1,
      claim: this.#claim,
      observationOrder: Object.freeze([...this.#observations]),
      input,
    });
  }
}

export function runRuntimeTimingTrace(
  config: TimingMachineConfiguration,
  trace: RuntimeTimingTrace,
): RuntimeTimingResult {
  if (typeof trace !== "object" || trace === null) throw new Error("runtime timing trace is required");
  if (trace.schemaVersion !== 1) throw new Error("runtime timing trace schemaVersion must be 1");
  if (typeof trace.claim !== "object" || trace.claim === null) {
    throw new Error("runtime timing trace claim is required");
  }
  if (
    trace.claim.architectureCalibration !== "uncalibrated" ||
    trace.claim.coverage !== "caller-reported-events-only" ||
    trace.claim.cycleAccurate !== false ||
    trace.claim.countsOnlyInstrumentedEvents !== true ||
    trace.claim.hostTraceTimeIsSimulatedTime !== false
  ) {
    throw new Error(
      "runtime timing trace claim must remain partial, uncalibrated, and cycleAccurate false",
    );
  }
  requireNonEmpty(trace.claim.source, "runtime timing trace claim.source");
  if (typeof trace.input !== "object" || trace.input === null) {
    throw new Error("runtime timing trace input is required");
  }
  if (!Array.isArray(trace.observationOrder)) {
    throw new Error("runtime timing trace observationOrder must be an array");
  }
  if (!Array.isArray(trace.input.issueOrder)) {
    throw new Error("runtime timing trace input.issueOrder is required");
  }
  if (trace.provenance !== undefined) {
    if (typeof trace.provenance !== "object" || trace.provenance === null) {
      throw new Error("runtime timing trace provenance must be an object");
    }
    if (trace.provenance.source !== trace.claim.source) {
      throw new Error("runtime timing trace provenance.source must match claim.source");
    }
  }
  if (trace.observationOrder.length !== trace.input.issueOrder.length) {
    throw new Error("runtime timing trace observationOrder and input.issueOrder lengths must match");
  }
  for (const [index, observation] of trace.observationOrder.entries()) {
    if (typeof observation !== "object" || observation === null) {
      throw new Error(`runtime timing trace observationOrder[${index}] must be an observation`);
    }
    if (observation.sequence !== index) {
      throw new Error(`runtime timing trace observationOrder[${index}].sequence must be ${index}`);
    }
    const issue = trace.input.issueOrder[index]!;
    if (observation.kind === "memory") {
      const accessId = requireNonEmpty(
        observation.accessId,
        `runtime timing trace observationOrder[${index}].accessId`,
      );
      if (issue.kind !== "memory" || issue.accessId !== accessId) {
        throw new Error(`runtime timing trace observationOrder[${index}] disagrees with input.issueOrder`);
      }
      continue;
    }
    if (observation.kind === "dma") {
      const eventId = requireNonEmpty(
        observation.eventId,
        `runtime timing trace observationOrder[${index}].eventId`,
      );
      if (issue.kind !== "dma" || issue.eventId !== eventId) {
        throw new Error(`runtime timing trace observationOrder[${index}] disagrees with input.issueOrder`);
      }
      continue;
    }
    if (observation.kind === "cpu") {
      const eventId = requireNonEmpty(
        observation.eventId,
        `runtime timing trace observationOrder[${index}].eventId`,
      );
      const instructionAccessId = requireNonEmpty(
        observation.instructionAccessId,
        `runtime timing trace observationOrder[${index}].instructionAccessId`,
      );
      if (issue.kind !== "cpu" || issue.eventId !== eventId) {
        throw new Error(`runtime timing trace observationOrder[${index}] disagrees with input.issueOrder`);
      }
      const cpu = trace.input.cpu?.find((event) => event.id === eventId);
      if (!cpu || cpu.instructionAccessId !== instructionAccessId) {
        throw new Error(`runtime timing trace observationOrder[${index}] disagrees with input.cpu`);
      }
      continue;
    }
    throw new Error(`runtime timing trace observationOrder[${index}].kind must be memory, cpu, or dma`);
  }

  const machine = runTimingMachine(config, trace.input);
  const claim = Object.freeze({ ...machine.claim, ...trace.claim });
  return Object.freeze({
    ...machine,
    claim,
    ...(trace.provenance === undefined ? {} : { provenance: trace.provenance }),
    observationOrder: Object.freeze(
      trace.observationOrder.map((observation) => Object.freeze({ ...observation })),
    ),
  });
}

export function runtimeTimingResultJson(result: RuntimeTimingResult): string {
  return timingMachineJson(result);
}
