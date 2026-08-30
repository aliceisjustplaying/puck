import type { VirtualMemoryAccess } from "./address-map";
import { scheduleExecution, type DmaEvent } from "./execution";
import {
  runTimingMachine,
  type TimingMachineConfiguration,
  type TimingMachineInput,
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
      kind: "dma";
      eventId: string;
    }>;

export interface RuntimeTimingTrace {
  readonly schemaVersion: 1;
  readonly claim: Readonly<{
    architectureCalibration: "uncalibrated";
    coverage: "caller-reported-events-only";
    source: string;
  }>;
  readonly observationOrder: readonly RuntimeTraceObservation[];
  readonly input: TimingMachineInput;
}

function requireNonEmpty(value: unknown, path: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${path} must be a non-empty string`);
  }
  return value;
}

function validateMemoryObservation(value: RuntimeMemoryObservation): void {
  if (typeof value !== "object" || value === null) throw new Error("runtime memory observation is required");
  if (value.kind !== "instruction-fetch" && value.kind !== "load" && value.kind !== "store") {
    throw new Error("runtime memory observation kind must be instruction-fetch, load, or store");
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
    : Object.freeze({ status: "unknown" as const, reason: event.latency.reason });
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

/**
 * Collect the exact event order reported by an execution runtime. The recorder
 * makes no completeness claim and supplies no addresses, mappings, or costs.
 */
export class RuntimeTimingTraceRecorder {
  readonly #claim: RuntimeTimingTrace["claim"];
  readonly #cores: [VirtualMemoryAccess[], VirtualMemoryAccess[]] = [[], []];
  readonly #interleave: string[] = [];
  readonly #dma: DmaEvent[] = [];
  readonly #observations: RuntimeTraceObservation[] = [];
  readonly #ids = new Set<string>();
  #nextAccessId = 0;

  constructor(source: string) {
    this.#claim = Object.freeze({
      architectureCalibration: "uncalibrated",
      coverage: "caller-reported-events-only",
      source: requireNonEmpty(source, "runtime trace source"),
    });
  }

  recordMemory(observation: RuntimeMemoryObservation): string {
    validateMemoryObservation(observation);
    const id = `runtime-access:${this.#nextAccessId}`;
    this.#nextAccessId += 1;
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
    this.#interleave.push(id);
    this.#observations.push(
      Object.freeze({ sequence: this.#observations.length, kind: "memory", accessId: id }),
    );
    return id;
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
      dma: Object.freeze([...this.#dma]),
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
): TimingMachineResult {
  if (typeof trace !== "object" || trace === null) throw new Error("runtime timing trace is required");
  if (trace.schemaVersion !== 1) throw new Error("runtime timing trace schemaVersion must be 1");
  if (
    trace.claim.architectureCalibration !== "uncalibrated" ||
    trace.claim.coverage !== "caller-reported-events-only"
  ) {
    throw new Error("runtime timing trace claim must remain uncalibrated and caller-reported-events-only");
  }
  requireNonEmpty(trace.claim.source, "runtime timing trace claim.source");
  return runTimingMachine(config, trace.input);
}
