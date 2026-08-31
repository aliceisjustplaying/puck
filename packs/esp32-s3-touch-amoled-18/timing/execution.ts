export type CoreId = 0 | 1;
export type CalibrationStatus = "calibrated" | "uncalibrated";
export type TimingCertainty = CalibrationStatus | "unknown";
export type MemoryRegion = "sram" | "psram" | "flash";

export interface EventReadyTime {
  readonly cycle: bigint;
  readonly calibration: CalibrationStatus;
  readonly source: string;
}

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
      source?: string;
    }>;

export interface MspiBurstSelection {
  readonly clientId: string;
  /** Issue-side candidate identity. A cache boundary starts a new sequence. */
  readonly sequenceId: bigint;
  readonly lineAddress: bigint;
  readonly lineSizeBytes: number;
  readonly firstLineLatency: EventLatency;
  readonly subsequentLineServiceInterval: EventLatency;
}

interface CoreEventBase {
  readonly id: string;
  readonly core: CoreId;
  readonly earliest?: EventReadyTime;
  readonly latency: EventLatency;
}

interface MemoryEventBase extends CoreEventBase {
  readonly memory: MemoryRegion;
  readonly bytes: number;
  readonly mspiBurst?: MspiBurstSelection;
}

export interface InstructionFetchEvent extends MemoryEventBase {
  readonly kind: "instruction-fetch";
}

export interface LiteralLoadEvent extends MemoryEventBase {
  readonly kind: "literal-load";
}

export interface LoadEvent extends MemoryEventBase {
  readonly kind: "load";
}

export interface StoreEvent extends MemoryEventBase {
  readonly kind: "store";
  readonly storeBuffer?: Readonly<{
    readonly retirementLatency: EventLatency;
  }>;
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

export interface CpuExecutionEvent extends CoreEventBase {
  readonly kind: "cpu";
  readonly instructionAccessId: string;
}

export interface FenceEvent extends CoreEventBase {
  readonly kind: "fence";
  readonly operation: "memw";
}

export type DmaEndpoint =
  | Readonly<{ kind: "memory"; memory: MemoryRegion }>
  | Readonly<{ kind: "mmio"; peripheral: string }>;

export interface DmaEvent {
  readonly id: string;
  readonly kind: "dma";
  readonly channel: string;
  readonly earliest: EventReadyTime;
  readonly source: DmaEndpoint;
  readonly destination: DmaEndpoint;
  readonly bytes: number;
  readonly latency: EventLatency;
}

export type ExecutionEvent =
  | InstructionFetchEvent
  | LiteralLoadEvent
  | LoadEvent
  | StoreEvent
  | AtomicEvent
  | CacheOpEvent
  | MmioEvent
  | CpuExecutionEvent
  | FenceEvent
  | DmaEvent;

export type ExecutionActor =
  | Readonly<{ kind: "core"; core: CoreId }>
  | Readonly<{ kind: "store-buffer"; core: CoreId }>
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
  readonly latency: Extract<EventLatency, { status: "unknown" }>;
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
    storeBuffers?: readonly [ReadyClock, ReadyClock];
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

const INITIAL_CLOCK: Extract<ReadyClock, { status: "known" }> = Object.freeze({
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

function validateReadyTime(value: unknown, path: string): asserts value is EventReadyTime {
  if (typeof value !== "object" || value === null) throw new Error(`${path} must be an object`);
  const ready = value as Partial<EventReadyTime>;
  if (typeof ready.cycle !== "bigint" || ready.cycle < 0n) {
    throw new Error(`${path}.cycle must be a non-negative bigint`);
  }
  validateCalibration(ready.calibration, `${path}.calibration`);
  requireNonEmpty(ready.source, `${path}.source`);
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
    if (latency.source !== undefined) requireNonEmpty(latency.source, `${path}.source`);
    return;
  }
  throw new Error(`${path}.status must be known or unknown`);
}

function validateMspiBurst(value: unknown, path: string): asserts value is MspiBurstSelection {
  if (typeof value !== "object" || value === null) throw new Error(`${path} must be an object`);
  const burst = value as Partial<MspiBurstSelection>;
  requireNonEmpty(burst.clientId, `${path}.clientId`);
  if (typeof burst.sequenceId !== "bigint" || burst.sequenceId < 0n) {
    throw new Error(`${path}.sequenceId must be a non-negative bigint`);
  }
  if (typeof burst.lineAddress !== "bigint" || burst.lineAddress < 0n) {
    throw new Error(`${path}.lineAddress must be a non-negative bigint`);
  }
  requirePositiveBytes(burst.lineSizeBytes, `${path}.lineSizeBytes`);
  if (burst.lineAddress % BigInt(burst.lineSizeBytes as number) !== 0n) {
    throw new Error(`${path}.lineAddress must be aligned to lineSizeBytes`);
  }
  validateLatency(burst.firstLineLatency, `${path}.firstLineLatency`);
  validateLatency(
    burst.subsequentLineServiceInterval,
    `${path}.subsequentLineServiceInterval`,
  );
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
  if (event.earliest !== undefined) validateReadyTime(event.earliest, `events[${inputIndex}].earliest`);
  switch (event.kind) {
    case "instruction-fetch":
    case "literal-load":
    case "load":
    case "store":
      if (event.core !== 0 && event.core !== 1) throw new Error(`events[${inputIndex}].core must be 0 or 1`);
      validateMemory(event.memory, `events[${inputIndex}].memory`);
      requirePositiveBytes(event.bytes, `events[${inputIndex}].bytes`);
      if (event.mspiBurst !== undefined) {
        if (event.memory !== "flash" && event.memory !== "psram") {
          throw new Error(`events[${inputIndex}].mspiBurst requires flash or psram memory`);
        }
        validateMspiBurst(event.mspiBurst, `events[${inputIndex}].mspiBurst`);
      }
      if (event.kind === "store" && event.storeBuffer !== undefined) {
        if (typeof event.storeBuffer !== "object" || event.storeBuffer === null) {
          throw new Error(`events[${inputIndex}].storeBuffer must be an object`);
        }
        validateLatency(
          event.storeBuffer.retirementLatency,
          `events[${inputIndex}].storeBuffer.retirementLatency`,
        );
      }
      return;
    case "atomic":
      if (event.core !== 0 && event.core !== 1) throw new Error(`events[${inputIndex}].core must be 0 or 1`);
      validateMemory(event.memory, `events[${inputIndex}].memory`);
      requirePositiveBytes(event.bytes, `events[${inputIndex}].bytes`);
      requireNonEmpty(event.operation, `events[${inputIndex}].operation`);
      if (event.mspiBurst !== undefined) {
        if (event.memory !== "flash" && event.memory !== "psram") {
          throw new Error(`events[${inputIndex}].mspiBurst requires flash or psram memory`);
        }
        validateMspiBurst(event.mspiBurst, `events[${inputIndex}].mspiBurst`);
      }
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
    case "cpu":
      if (event.core !== 0 && event.core !== 1) throw new Error(`events[${inputIndex}].core must be 0 or 1`);
      requireNonEmpty(event.instructionAccessId, `events[${inputIndex}].instructionAccessId`);
      return;
    case "fence":
      if (event.core !== 0 && event.core !== 1) throw new Error(`events[${inputIndex}].core must be 0 or 1`);
      if (event.operation !== "memw") throw new Error(`events[${inputIndex}].operation must be memw`);
      return;
    case "dma":
      requireNonEmpty(event.channel, `events[${inputIndex}].channel`);
      if (event.earliest === undefined) {
        throw new Error(`events[${inputIndex}].earliest is required for DMA`);
      }
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
  if (actor.kind === "core") return `core:${actor.core}`;
  if (actor.kind === "store-buffer") return `store-buffer:${actor.core}`;
  return `dma:${actor.channel}`;
}

function lexicalCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function actorCompare(left: ExecutionActor, right: ExecutionActor): number {
  if (left.kind === "core" && right.kind === "core") return left.core - right.core;
  if (left.kind === "core") return -1;
  if (right.kind === "core") return 1;
  if (left.kind === "store-buffer" && right.kind === "store-buffer") return left.core - right.core;
  if (left.kind === "store-buffer") return -1;
  if (right.kind === "store-buffer") return 1;
  return lexicalCompare(left.channel, right.channel);
}

function endpointUsesMspi(endpoint: DmaEndpoint): boolean {
  return endpoint.kind === "memory" && (endpoint.memory === "flash" || endpoint.memory === "psram");
}

export function eventUsesMspi(event: ExecutionEvent): boolean {
  switch (event.kind) {
    case "instruction-fetch":
    case "literal-load":
    case "load":
    case "store":
    case "atomic":
      return event.memory === "flash" || event.memory === "psram";
    case "cache-op":
      return event.backing === "flash" || event.backing === "psram";
    case "mmio":
    case "cpu":
    case "fence":
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

function isBufferedStore(event: ExecutionEvent): event is StoreEvent & {
  readonly storeBuffer: Readonly<{ readonly retirementLatency: EventLatency }>;
} {
  return event.kind === "store" && event.storeBuffer !== undefined;
}

function waitsForStoreBuffer(event: ExecutionEvent): boolean {
  return event.kind === "store" || event.kind === "fence";
}

function resourceForEvent(event: ExecutionEvent): "mspi" | null {
  return !isBufferedStore(event) && eventUsesMspi(event) ? "mspi" : null;
}

function storeBufferActor(core: CoreId): ExecutionActor {
  return Object.freeze({ kind: "store-buffer", core });
}

function drainEventFor(event: StoreEvent & {
  readonly storeBuffer: Readonly<{ readonly retirementLatency: EventLatency }>;
}): StoreEvent {
  const { storeBuffer: _storeBuffer, ...drain } = event;
  return Object.freeze({ ...drain, id: `${event.id}:drain` });
}

function candidateFor(
  queued: QueuedEvent,
  actorKeyValue: string,
  actor: ExecutionActor,
  actorClock: Extract<ReadyClock, { status: "known" }>,
  mspiClock: ReadyClock,
  gateClock: Extract<ReadyClock, { status: "known" }> = INITIAL_CLOCK,
): Candidate {
  const resource = resourceForEvent(queued.event);
  const earliestCycle = queued.event.earliest?.cycle ?? 0n;
  const earliestCalibration = queued.event.earliest?.calibration ?? "calibrated";
  if (resource === "mspi" && mspiClock.status === "blocked") {
    return {
      queued,
      actorKey: actorKeyValue,
      actor,
      resource,
      startCycle: laterCycle(actorClock.cycle, earliestCycle, gateClock.cycle, mspiClock.atCycle),
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
    startCycle: laterCycle(actorClock.cycle, earliestCycle, gateClock.cycle, resourceCycle),
    startCalibration: combineCalibration(
      actorClock.calibration,
      earliestCalibration,
      gateClock.calibration,
      resourceCalibration,
    ),
    actorReadyCycle: actorClock.cycle,
    blockedResource: null,
  };
}

function candidateCompare(
  left: Candidate,
  right: Candidate,
  sameCycleTieBreak: "actor" | "input-order",
): number {
  if (left.startCycle !== right.startCycle) return left.startCycle < right.startCycle ? -1 : 1;
  if (sameCycleTieBreak === "input-order") {
    return left.queued.inputIndex - right.queued.inputIndex;
  }
  const byActor = actorCompare(left.actor, right.actor);
  return byActor !== 0 ? byActor : left.queued.inputIndex - right.queued.inputIndex;
}

function mspiBurstFor(event: ExecutionEvent): MspiBurstSelection | null {
  switch (event.kind) {
    case "instruction-fetch":
    case "literal-load":
    case "load":
    case "store":
    case "atomic":
      return event.mspiBurst ?? null;
    case "cache-op":
    case "mmio":
    case "cpu":
    case "fence":
    case "dma":
      return null;
    default:
      return assertNever(event);
  }
}

function serviceLatency(
  event: ExecutionEvent,
  previous: MspiBurstSelection | null,
): EventLatency {
  const burst = mspiBurstFor(event);
  if (burst === null) return event.latency;
  const continues =
    previous !== null &&
    previous.clientId === burst.clientId &&
    previous.sequenceId === burst.sequenceId &&
    previous.lineSizeBytes === burst.lineSizeBytes &&
    previous.lineAddress + BigInt(previous.lineSizeBytes) === burst.lineAddress;
  return continues
    ? burst.subsequentLineServiceInterval
    : burst.firstLineLatency;
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
export interface ScheduleExecutionOptions {
  readonly sameCycleTieBreak?: "actor" | "input-order";
}

export function scheduleExecution(
  input: readonly ExecutionEvent[],
  options: ScheduleExecutionOptions = {},
): ExecutionSchedule {
  const hasBufferedStore = input.some(isBufferedStore);
  const sameCycleTieBreak = options.sameCycleTieBreak ?? "actor";
  if (sameCycleTieBreak !== "actor" && sameCycleTieBreak !== "input-order") {
    throw new Error("options.sameCycleTieBreak must be actor or input-order");
  }
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
  for (const event of input) {
    if (isBufferedStore(event) && ids.has(`${event.id}:drain`)) {
      throw new Error(`buffered store ${event.id} drain id collides with an input event`);
    }
  }
  for (const core of [0, 1] as const) {
    const actor = storeBufferActor(core);
    const key = actorKey(actor);
    queues.set(key, []);
    actors.set(key, actor);
  }

  const clocks = new Map<string, ReadyClock>([
    ["core:0", INITIAL_CLOCK],
    ["core:1", INITIAL_CLOCK],
    ["store-buffer:0", INITIAL_CLOCK],
    ["store-buffer:1", INITIAL_CLOCK],
  ]);
  for (const key of queues.keys()) if (!clocks.has(key)) clocks.set(key, INITIAL_CLOCK);
  let mspiClock: ReadyClock = INITIAL_CLOCK;
  let previousMspiBurst: MspiBurstSelection | null = null;
  const results: ExecutionResult[] = [];

  while (true) {
    const candidates: Candidate[] = [];
    for (const [key, queue] of queues) {
      if (queue.length === 0) continue;
      const clock = clockForActor(clocks, key);
      if (clock.status === "blocked") continue;
      const actor = actors.get(key)!;
      const event = queue[0]!.event;
      let gateClock: Extract<ReadyClock, { status: "known" }> = INITIAL_CLOCK;
      if (actor.kind === "core" && waitsForStoreBuffer(event)) {
        const bufferKey = `store-buffer:${actor.core}`;
        const bufferClock = clockForActor(clocks, bufferKey);
        if (queues.get(bufferKey)!.length > 0 || bufferClock.status === "blocked") continue;
        gateClock = bufferClock;
      }
      candidates.push(candidateFor(queue[0]!, key, actor, clock, mspiClock, gateClock));
    }
    if (candidates.length === 0) break;
    candidates.sort((left, right) => candidateCompare(left, right, sameCycleTieBreak));
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

    const latency = isBufferedStore(candidate.queued.event)
      ? candidate.queued.event.storeBuffer.retirementLatency
      : candidate.resource === "mspi"
        ? serviceLatency(candidate.queued.event, previousMspiBurst)
        : candidate.queued.event.latency;
    if (candidate.resource === "mspi") {
      previousMspiBurst = mspiBurstFor(candidate.queued.event);
    }
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
          latency,
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
    if (isBufferedStore(candidate.queued.event)) {
      const bufferKey = `store-buffer:${candidate.queued.event.core}`;
      const bufferQueue = queues.get(bufferKey)!;
      if (bufferQueue.length !== 0) throw new Error(`internal error: ${bufferKey} accepted a second store`);
      bufferQueue.push(Object.freeze({
        event: drainEventFor(candidate.queued.event),
        inputIndex: candidate.queued.inputIndex,
      }));
      clocks.set(bufferKey, nextClock);
    }
  }

  const actorKeys = [...queues.keys()].sort((left, right) => actorCompare(actors.get(left)!, actors.get(right)!));
  for (const key of actorKeys) {
    const queue = queues.get(key)!;
    if (queue.length === 0) continue;
    const actor = actors.get(key)!;
    const clock = clockForActor(clocks, key);
    let blocker = clock;
    if (clock.status !== "blocked" && actor.kind === "core" && waitsForStoreBuffer(queue[0]!.event)) {
      blocker = clockForActor(clocks, `store-buffer:${actor.core}`);
    }
    if (blocker.status !== "blocked") throw new Error(`internal error: pending events on ready actor ${key}`);
    for (const queued of queue) {
      results.push(
        blockedResult(
          queued,
          actor,
          resourceForEvent(queued.event),
          results.length,
          blocker.blockedBy,
          `actor ${key} cannot pass ${blocker.blockedBy}: ${blocker.reason}`,
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
      ...(hasBufferedStore
        ? {
            storeBuffers: Object.freeze([
              clockForActor(clocks, "store-buffer:0"),
              clockForActor(clocks, "store-buffer:1"),
            ]) as readonly [ReadyClock, ReadyClock],
          }
        : {}),
      mspi: mspiClock,
      dma: Object.freeze(dmaClocks),
    }),
  });
}
