export type CoreId = 0 | 1;
export type CalibrationStatus = "calibrated" | "uncalibrated";
export type TimingCertainty = CalibrationStatus | "unknown";
export type MemoryRegion = "sram" | "psram" | "flash";

export type EventLatency =
  | Readonly<{
      status: "known";
      cycles: bigint;
      calibration: CalibrationStatus;
      source: string;
    }>
  | Readonly<{
      status: "unknown";
      reason: string;
    }>;

interface CoreEventBase {
  readonly id: string;
  readonly core: CoreId;
  readonly latency: EventLatency;
}

interface MemoryEventBase extends CoreEventBase {
  readonly memory: MemoryRegion;
  readonly bytes: number;
}

export interface InstructionFetchEvent extends MemoryEventBase {
  readonly kind: "instruction-fetch";
}

export interface LoadEvent extends MemoryEventBase {
  readonly kind: "load";
}

export interface StoreEvent extends MemoryEventBase {
  readonly kind: "store";
}

export interface AtomicEvent extends MemoryEventBase {
  readonly kind: "atomic";
  readonly operation: string;
}

export interface CacheOpEvent extends CoreEventBase {
  readonly kind: "cache-op";
  readonly operation: "invalidate" | "writeback" | "writeback-invalidate";
  readonly backing: "local" | "psram" | "flash";
}

export interface MmioEvent extends CoreEventBase {
  readonly kind: "mmio";
  readonly peripheral: string;
  readonly operation: "read" | "write";
  readonly bytes: number;
}

export type DmaEndpoint =
  | Readonly<{ kind: "memory"; memory: MemoryRegion }>
  | Readonly<{ kind: "mmio"; peripheral: string }>;

export interface DmaEvent {
  readonly id: string;
  readonly kind: "dma";
  readonly channel: string;
  readonly earliest: Readonly<{
    cycle: bigint;
    calibration: CalibrationStatus;
    source: string;
  }>;
  readonly source: DmaEndpoint;
  readonly destination: DmaEndpoint;
  readonly bytes: number;
  readonly latency: EventLatency;
}

export type ExecutionEvent =
  | InstructionFetchEvent
  | LoadEvent
  | StoreEvent
  | AtomicEvent
  | CacheOpEvent
  | MmioEvent
  | DmaEvent;

export type ExecutionActor =
  | Readonly<{ kind: "core"; core: CoreId }>
  | Readonly<{ kind: "dma"; channel: string }>;

export type ReadyClock =
  | Readonly<{
      status: "known";
      cycle: bigint;
      calibration: CalibrationStatus;
    }>
  | Readonly<{
      status: "blocked";
      atCycle: bigint;
      blockedBy: string;
      reason: string;
    }>;

interface ResultBase {
  readonly eventId: string;
  readonly kind: ExecutionEvent["kind"];
  readonly actor: ExecutionActor;
  readonly inputIndex: number;
  readonly resultIndex: number;
  readonly resource: "mspi" | null;
}

export interface CompletedExecution extends ResultBase {
  readonly status: "completed";
  readonly startCycle: bigint;
  readonly endCycle: bigint;
  readonly waitCycles: bigint;
  readonly startCalibration: CalibrationStatus;
  readonly endCalibration: CalibrationStatus;
  readonly latency: Extract<EventLatency, { status: "known" }>;
}

export interface UnknownDurationExecution extends ResultBase {
  readonly status: "started-unknown-duration";
  readonly startCycle: bigint;
  readonly endCycle: null;
  readonly waitCycles: bigint;
  readonly startCalibration: CalibrationStatus;
  readonly endCalibration: "unknown";
  readonly reason: string;
}

export interface BlockedExecution extends ResultBase {
  readonly status: "blocked";
  readonly startCycle: null;
  readonly endCycle: null;
  readonly waitCycles: null;
  readonly startCalibration: "unknown";
  readonly endCalibration: "unknown";
  readonly blockedBy: string;
  readonly reason: string;
}

export type ExecutionResult = CompletedExecution | UnknownDurationExecution | BlockedExecution;

export interface ExecutionSchedule {
  readonly status: "complete" | "blocked";
  readonly calibration: Readonly<{
    status: TimingCertainty;
    uncalibratedEventIds: readonly string[];
    unknownEventIds: readonly string[];
  }>;
  readonly events: readonly ExecutionResult[];
  readonly finalClocks: Readonly<{
    cores: readonly [ReadyClock, ReadyClock];
    mspi: ReadyClock;
    dma: Readonly<Record<string, ReadyClock>>;
  }>;
}

interface QueuedEvent {
  readonly event: ExecutionEvent;
  readonly inputIndex: number;
}

interface KnownCandidate {
  readonly queued: QueuedEvent;
  readonly actorKey: string;
  readonly actor: ExecutionActor;
  readonly resource: "mspi" | null;
  readonly startCycle: bigint;
  readonly startCalibration: CalibrationStatus;
  readonly actorReadyCycle: bigint;
  readonly blockedResource: null;
}

interface ResourceBlockedCandidate {
  readonly queued: QueuedEvent;
  readonly actorKey: string;
  readonly actor: ExecutionActor;
  readonly resource: "mspi";
  readonly startCycle: bigint;
  readonly startCalibration: "unknown";
  readonly actorReadyCycle: bigint;
  readonly blockedResource: Extract<ReadyClock, { status: "blocked" }>;
}

type Candidate = KnownCandidate | ResourceBlockedCandidate;

const INITIAL_CLOCK: ReadyClock = Object.freeze({
  status: "known",
  cycle: 0n,
  calibration: "calibrated",
});

function requireNonEmpty(value: unknown, path: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${path} must be a non-empty string`);
  return value;
}

function requirePositiveBytes(value: unknown, path: string): void {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    throw new Error(`${path} must be a positive safe integer`);
  }
}

function validateMemory(value: unknown, path: string): asserts value is MemoryRegion {
  if (value !== "sram" && value !== "psram" && value !== "flash") {
    throw new Error(`${path} must be sram, psram, or flash`);
  }
}

function validateCalibration(value: unknown, path: string): asserts value is CalibrationStatus {
  if (value !== "calibrated" && value !== "uncalibrated") {
    throw new Error(`${path} must be calibrated or uncalibrated`);
  }
}

function validateLatency(value: unknown, path: string): asserts value is EventLatency {
  if (typeof value !== "object" || value === null) {
    throw new Error(`${path} is required; the scheduler has no default chip costs`);
  }
  const latency = value as Partial<EventLatency>;
  if (latency.status === "known") {
    if (typeof latency.cycles !== "bigint" || latency.cycles < 0n) {
      throw new Error(`${path}.cycles must be a non-negative bigint`);
    }
    validateCalibration(latency.calibration, `${path}.calibration`);
    requireNonEmpty(latency.source, `${path}.source`);
    return;
  }
  if (latency.status === "unknown") {
    requireNonEmpty(latency.reason, `${path}.reason`);
    return;
  }
  throw new Error(`${path}.status must be known or unknown`);
}

function validateEndpoint(endpoint: DmaEndpoint, path: string): void {
  if (typeof endpoint !== "object" || endpoint === null) throw new Error(`${path} must be an endpoint`);
  if (endpoint.kind === "memory") {
    if (endpoint.memory !== "sram" && endpoint.memory !== "psram" && endpoint.memory !== "flash") {
      throw new Error(`${path}.memory is unsupported`);
    }
    return;
  }
  if (endpoint.kind === "mmio") {
    requireNonEmpty(endpoint.peripheral, `${path}.peripheral`);
    return;
  }
  throw new Error(`${path}.kind must be memory or mmio`);
}

function assertNever(value: never): never {
  throw new Error(`unsupported execution event kind ${String((value as { kind?: unknown }).kind)}`);
}

function validateEvent(event: ExecutionEvent, inputIndex: number): void {
  requireNonEmpty(event.id, `events[${inputIndex}].id`);
  validateLatency(event.latency, `events[${inputIndex}].latency`);
  switch (event.kind) {
    case "instruction-fetch":
    case "load":
    case "store":
      if (event.core !== 0 && event.core !== 1) throw new Error(`events[${inputIndex}].core must be 0 or 1`);
      validateMemory(event.memory, `events[${inputIndex}].memory`);
      requirePositiveBytes(event.bytes, `events[${inputIndex}].bytes`);
      return;
    case "atomic":
      if (event.core !== 0 && event.core !== 1) throw new Error(`events[${inputIndex}].core must be 0 or 1`);
      validateMemory(event.memory, `events[${inputIndex}].memory`);
      requirePositiveBytes(event.bytes, `events[${inputIndex}].bytes`);
      requireNonEmpty(event.operation, `events[${inputIndex}].operation`);
      return;
    case "cache-op":
      if (event.core !== 0 && event.core !== 1) throw new Error(`events[${inputIndex}].core must be 0 or 1`);
      if (event.backing !== "local" && event.backing !== "psram" && event.backing !== "flash") {
        throw new Error(`events[${inputIndex}].backing must be local, psram, or flash`);
      }
      if (
        event.operation !== "invalidate" &&
        event.operation !== "writeback" &&
        event.operation !== "writeback-invalidate"
      ) {
        throw new Error(`events[${inputIndex}].operation is unsupported`);
      }
      return;
    case "mmio":
      if (event.core !== 0 && event.core !== 1) throw new Error(`events[${inputIndex}].core must be 0 or 1`);
      requireNonEmpty(event.peripheral, `events[${inputIndex}].peripheral`);
      if (event.operation !== "read" && event.operation !== "write") {
        throw new Error(`events[${inputIndex}].operation must be read or write`);
      }
      requirePositiveBytes(event.bytes, `events[${inputIndex}].bytes`);
      return;
    case "dma":
      requireNonEmpty(event.channel, `events[${inputIndex}].channel`);
      if (typeof event.earliest !== "object" || event.earliest === null) {
        throw new Error(`events[${inputIndex}].earliest is required for DMA`);
      }
      if (typeof event.earliest.cycle !== "bigint" || event.earliest.cycle < 0n) {
        throw new Error(`events[${inputIndex}].earliest.cycle must be a non-negative bigint`);
      }
      validateCalibration(event.earliest.calibration, `events[${inputIndex}].earliest.calibration`);
      requireNonEmpty(event.earliest.source, `events[${inputIndex}].earliest.source`);
      validateEndpoint(event.source, `events[${inputIndex}].source`);
      validateEndpoint(event.destination, `events[${inputIndex}].destination`);
      requirePositiveBytes(event.bytes, `events[${inputIndex}].bytes`);
      return;
    default:
      return assertNever(event);
  }
}

function actorFor(event: ExecutionEvent): ExecutionActor {
  return event.kind === "dma"
    ? Object.freeze({ kind: "dma", channel: event.channel })
    : Object.freeze({ kind: "core", core: event.core });
}

function actorKey(actor: ExecutionActor): string {
  return actor.kind === "core" ? `core:${actor.core}` : `dma:${actor.channel}`;
}

function lexicalCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function actorCompare(left: ExecutionActor, right: ExecutionActor): number {
  if (left.kind === "core" && right.kind === "core") return left.core - right.core;
  if (left.kind === "core") return -1;
  if (right.kind === "core") return 1;
  return lexicalCompare(left.channel, right.channel);
}

function endpointUsesMspi(endpoint: DmaEndpoint): boolean {
  return endpoint.kind === "memory" && (endpoint.memory === "flash" || endpoint.memory === "psram");
}

export function eventUsesMspi(event: ExecutionEvent): boolean {
  switch (event.kind) {
    case "instruction-fetch":
    case "load":
    case "store":
    case "atomic":
      return event.memory === "flash" || event.memory === "psram";
    case "cache-op":
      return event.backing === "flash" || event.backing === "psram";
    case "mmio":
      return false;
    case "dma":
      return endpointUsesMspi(event.source) || endpointUsesMspi(event.destination);
    default:
      return assertNever(event);
  }
}

function combineCalibration(...values: CalibrationStatus[]): CalibrationStatus {
  return values.every((value) => value === "calibrated") ? "calibrated" : "uncalibrated";
}

function laterCycle(...cycles: bigint[]): bigint {
  return cycles.reduce((latest, cycle) => (cycle > latest ? cycle : latest), 0n);
}

function candidateFor(
  queued: QueuedEvent,
  actorKeyValue: string,
  actorClock: Extract<ReadyClock, { status: "known" }>,
  mspiClock: ReadyClock,
): Candidate {
  const actor = actorFor(queued.event);
  const resource = eventUsesMspi(queued.event) ? "mspi" : null;
  const earliestCycle = queued.event.kind === "dma" ? queued.event.earliest.cycle : 0n;
  const earliestCalibration =
    queued.event.kind === "dma" ? queued.event.earliest.calibration : "calibrated";
  if (resource === "mspi" && mspiClock.status === "blocked") {
    return {
      queued,
      actorKey: actorKeyValue,
      actor,
      resource,
      startCycle: laterCycle(actorClock.cycle, earliestCycle, mspiClock.atCycle),
      startCalibration: "unknown",
      actorReadyCycle: actorClock.cycle,
      blockedResource: mspiClock,
    };
  }
  const resourceCycle = resource === "mspi" ? (mspiClock as Extract<ReadyClock, { status: "known" }>).cycle : 0n;
  const resourceCalibration =
    resource === "mspi"
      ? (mspiClock as Extract<ReadyClock, { status: "known" }>).calibration
      : "calibrated";
  return {
    queued,
    actorKey: actorKeyValue,
    actor,
    resource,
    startCycle: laterCycle(actorClock.cycle, earliestCycle, resourceCycle),
    startCalibration: combineCalibration(
      actorClock.calibration,
      earliestCalibration,
      resourceCalibration,
    ),
    actorReadyCycle: actorClock.cycle,
    blockedResource: null,
  };
}

function candidateCompare(left: Candidate, right: Candidate): number {
  if (left.startCycle !== right.startCycle) return left.startCycle < right.startCycle ? -1 : 1;
  const byActor = actorCompare(left.actor, right.actor);
  return byActor !== 0 ? byActor : left.queued.inputIndex - right.queued.inputIndex;
}

function knownClock(cycle: bigint, calibration: CalibrationStatus): ReadyClock {
  return Object.freeze({ status: "known", cycle, calibration });
}

function blockedClock(atCycle: bigint, blockedBy: string, reason: string): ReadyClock {
  return Object.freeze({ status: "blocked", atCycle, blockedBy, reason });
}

function clockForActor(clocks: Map<string, ReadyClock>, key: string): ReadyClock {
  const clock = clocks.get(key);
  if (!clock) throw new Error(`internal error: no clock for ${key}`);
  return clock;
}

function blockedResult(
  queued: QueuedEvent,
  actor: ExecutionActor,
  resource: "mspi" | null,
  resultIndex: number,
  blockedBy: string,
  reason: string,
): BlockedExecution {
  return Object.freeze({
    eventId: queued.event.id,
    kind: queued.event.kind,
    actor,
    inputIndex: queued.inputIndex,
    resultIndex,
    resource,
    status: "blocked",
    startCycle: null,
    endCycle: null,
    waitCycles: null,
    startCalibration: "unknown",
    endCalibration: "unknown",
    blockedBy,
    reason,
  });
}

/**
 * Execute typed events on two ordered core streams and ordered DMA channels.
 * Every known duration is supplied by the caller in one common cycle domain.
 * The scheduler contains no ESP32-S3 latency table and supplies no fallback.
 */
export function scheduleExecution(input: readonly ExecutionEvent[]): ExecutionSchedule {
  const ids = new Set<string>();
  const queues = new Map<string, QueuedEvent[]>();
  const actors = new Map<string, ExecutionActor>();
  for (const [inputIndex, event] of input.entries()) {
    validateEvent(event, inputIndex);
    if (ids.has(event.id)) throw new Error(`duplicate event id ${event.id}`);
    ids.add(event.id);
    const actor = actorFor(event);
    const key = actorKey(actor);
    const queue = queues.get(key) ?? [];
    queue.push({ event, inputIndex });
    queues.set(key, queue);
    actors.set(key, actor);
  }

  const clocks = new Map<string, ReadyClock>([
    ["core:0", INITIAL_CLOCK],
    ["core:1", INITIAL_CLOCK],
  ]);
  for (const key of queues.keys()) if (!clocks.has(key)) clocks.set(key, INITIAL_CLOCK);
  let mspiClock: ReadyClock = INITIAL_CLOCK;
  const results: ExecutionResult[] = [];

  while (true) {
    const candidates: Candidate[] = [];
    for (const [key, queue] of queues) {
      if (queue.length === 0) continue;
      const clock = clockForActor(clocks, key);
      if (clock.status === "blocked") continue;
      candidates.push(candidateFor(queue[0]!, key, clock, mspiClock));
    }
    if (candidates.length === 0) break;
    candidates.sort(candidateCompare);
    const candidate = candidates[0]!;
    const queue = queues.get(candidate.actorKey)!;
    queue.shift();

    if (candidate.blockedResource !== null) {
      const reason = `MSPI completion is unknown after ${candidate.blockedResource.blockedBy}`;
      results.push(
        blockedResult(
          candidate.queued,
          candidate.actor,
          candidate.resource,
          results.length,
          candidate.blockedResource.blockedBy,
          reason,
        ),
      );
      clocks.set(candidate.actorKey, blockedClock(candidate.startCycle, candidate.queued.event.id, reason));
      continue;
    }

    const latency = candidate.queued.event.latency;
    const waitCycles = candidate.startCycle - candidate.actorReadyCycle;
    if (latency.status === "unknown") {
      const reason = latency.reason;
      results.push(
        Object.freeze({
          eventId: candidate.queued.event.id,
          kind: candidate.queued.event.kind,
          actor: candidate.actor,
          inputIndex: candidate.queued.inputIndex,
          resultIndex: results.length,
          resource: candidate.resource,
          status: "started-unknown-duration",
          startCycle: candidate.startCycle,
          endCycle: null,
          waitCycles,
          startCalibration: candidate.startCalibration,
          endCalibration: "unknown",
          reason,
        }),
      );
      clocks.set(
        candidate.actorKey,
        blockedClock(candidate.startCycle, candidate.queued.event.id, reason),
      );
      if (candidate.resource === "mspi") {
        mspiClock = blockedClock(candidate.startCycle, candidate.queued.event.id, reason);
      }
      continue;
    }

    const endCycle = candidate.startCycle + latency.cycles;
    const endCalibration = combineCalibration(candidate.startCalibration, latency.calibration);
    results.push(
      Object.freeze({
        eventId: candidate.queued.event.id,
        kind: candidate.queued.event.kind,
        actor: candidate.actor,
        inputIndex: candidate.queued.inputIndex,
        resultIndex: results.length,
        resource: candidate.resource,
        status: "completed",
        startCycle: candidate.startCycle,
        endCycle,
        waitCycles,
        startCalibration: candidate.startCalibration,
        endCalibration,
        latency,
      }),
    );
    const nextClock = knownClock(endCycle, endCalibration);
    clocks.set(candidate.actorKey, nextClock);
    if (candidate.resource === "mspi") mspiClock = nextClock;
  }

  const actorKeys = [...queues.keys()].sort((left, right) => actorCompare(actors.get(left)!, actors.get(right)!));
  for (const key of actorKeys) {
    const queue = queues.get(key)!;
    if (queue.length === 0) continue;
    const actor = actors.get(key)!;
    const clock = clockForActor(clocks, key);
    if (clock.status !== "blocked") throw new Error(`internal error: pending events on ready actor ${key}`);
    for (const queued of queue) {
      results.push(
        blockedResult(
          queued,
          actor,
          eventUsesMspi(queued.event) ? "mspi" : null,
          results.length,
          clock.blockedBy,
          `actor ${key} cannot pass ${clock.blockedBy}: ${clock.reason}`,
        ),
      );
    }
  }

  const uncalibratedEventIds = results
    .filter(
      (result): result is CompletedExecution =>
        result.status === "completed" && result.endCalibration === "uncalibrated",
    )
    .map((result) => result.eventId);
  const unknownEventIds = results
    .filter((result) => result.status !== "completed")
    .map((result) => result.eventId);
  const calibrationStatus: TimingCertainty =
    unknownEventIds.length > 0
      ? "unknown"
      : uncalibratedEventIds.length > 0
        ? "uncalibrated"
        : "calibrated";
  const dmaClocks = Object.fromEntries(
    [...clocks.entries()]
      .filter(([key]) => key.startsWith("dma:"))
      .sort(([left], [right]) => lexicalCompare(left, right))
      .map(([key, clock]) => [key.slice(4), clock]),
  );

  return Object.freeze({
    status: unknownEventIds.length > 0 ? "blocked" : "complete",
    calibration: Object.freeze({
      status: calibrationStatus,
      uncalibratedEventIds: Object.freeze(uncalibratedEventIds),
      unknownEventIds: Object.freeze(unknownEventIds),
    }),
    events: Object.freeze(results),
    finalClocks: Object.freeze({
      cores: Object.freeze([
        clockForActor(clocks, "core:0"),
        clockForActor(clocks, "core:1"),
      ]) as readonly [ReadyClock, ReadyClock],
      mspi: mspiClock,
      dma: Object.freeze(dmaClocks),
    }),
  });
}
