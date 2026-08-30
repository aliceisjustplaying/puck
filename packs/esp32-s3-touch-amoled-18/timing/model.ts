export type CalibrationStatus = "calibrated" | "uncalibrated";

export interface ResourceClock {
  readonly hz: bigint;
  readonly calibration: CalibrationStatus;
}

export interface LinearCycleModel {
  readonly fixedCycles: bigint;
  readonly cyclesPerByte: {
    readonly numerator: bigint;
    readonly denominator: bigint;
  };
  readonly calibration: CalibrationStatus;
}

export interface SchedulerConfig {
  /** Outstanding transfers, including the one currently using the panel DMA. */
  readonly queueDepth: number;
  readonly cpuProducer: ResourceClock;
  readonly panelDma: ResourceClock;
}

export interface TransferRequest {
  readonly totalBytes: number;
  readonly maxStripBytes: number;
  readonly producerCost: LinearCycleModel;
  readonly panelDmaCost: LinearCycleModel;
}

export interface ExactSeconds {
  readonly numerator: bigint;
  readonly denominator: bigint;
}

export type SchedulerEventKind =
  | "panel-complete"
  | "producer-complete"
  | "queue-wait-start"
  | "queue-wait-end"
  | "submit"
  | "panel-start"
  | "producer-start";

export interface SchedulerEvent {
  readonly kind: SchedulerEventKind;
  readonly stripIndex: number;
  readonly at: ExactSeconds;
  readonly bytes: number;
  readonly queueOccupancy: number;
}

export interface ScheduledStrip {
  readonly index: number;
  readonly bytes: number;
  readonly producerCycles: bigint;
  readonly panelDmaCycles: bigint;
  readonly producerStartedAt: ExactSeconds;
  readonly producedAt: ExactSeconds;
  readonly submittedAt: ExactSeconds;
  readonly panelStartedAt: ExactSeconds;
  readonly completedAt: ExactSeconds;
  readonly queueWait: ExactSeconds;
}

export interface ScheduleResult {
  readonly calibration: {
    readonly status: CalibrationStatus;
    readonly uncalibratedInputs: readonly string[];
  };
  readonly clocks: {
    readonly cpuProducer: ResourceClock;
    readonly panelDma: ResourceClock;
  };
  readonly queueDepth: number;
  readonly totalBytes: number;
  readonly elapsed: ExactSeconds;
  readonly strips: readonly ScheduledStrip[];
  readonly events: readonly SchedulerEvent[];
}

interface PendingCompletion {
  readonly stripIndex: number;
  readonly at: ExactSeconds;
}

interface MutableEvent extends SchedulerEvent {
  readonly sequence: number;
}

const ZERO: ExactSeconds = Object.freeze({ numerator: 0n, denominator: 1n });

const EVENT_ORDER: Readonly<Record<SchedulerEventKind, number>> = Object.freeze({
  "panel-complete": 0,
  "producer-complete": 1,
  "queue-wait-start": 2,
  "queue-wait-end": 3,
  submit: 4,
  "panel-start": 5,
  "producer-start": 6,
});

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

function exact(numerator: bigint, denominator: bigint): ExactSeconds {
  if (denominator <= 0n) throw new Error("an exact time denominator must be positive");
  if (numerator === 0n) return ZERO;
  const divisor = gcd(numerator, denominator);
  return Object.freeze({ numerator: numerator / divisor, denominator: denominator / divisor });
}

function add(left: ExactSeconds, right: ExactSeconds): ExactSeconds {
  return exact(
    left.numerator * right.denominator + right.numerator * left.denominator,
    left.denominator * right.denominator,
  );
}

function subtract(left: ExactSeconds, right: ExactSeconds): ExactSeconds {
  return exact(
    left.numerator * right.denominator - right.numerator * left.denominator,
    left.denominator * right.denominator,
  );
}

export function compareTime(left: ExactSeconds, right: ExactSeconds): number {
  const difference = left.numerator * right.denominator - right.numerator * left.denominator;
  return difference < 0n ? -1 : difference > 0n ? 1 : 0;
}

function later(left: ExactSeconds, right: ExactSeconds): ExactSeconds {
  return compareTime(left, right) >= 0 ? left : right;
}

function duration(cycles: bigint, clock: ResourceClock): ExactSeconds {
  return exact(cycles, clock.hz);
}

function requirePositiveSafeInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive safe integer`);
  }
}

function validateCost(cost: LinearCycleModel, label: string): void {
  if (cost.fixedCycles < 0n) throw new Error(`${label}.fixedCycles must not be negative`);
  if (cost.cyclesPerByte.numerator < 0n) {
    throw new Error(`${label}.cyclesPerByte.numerator must not be negative`);
  }
  if (cost.cyclesPerByte.denominator <= 0n) {
    throw new Error(`${label}.cyclesPerByte.denominator must be positive`);
  }
}

function cyclesFor(bytes: number, cost: LinearCycleModel): bigint {
  const scaled = BigInt(bytes) * cost.cyclesPerByte.numerator;
  const perByteCycles = (scaled + cost.cyclesPerByte.denominator - 1n) / cost.cyclesPerByte.denominator;
  return cost.fixedCycles + perByteCycles;
}

export function partitionBytes(totalBytes: number, maxStripBytes: number): readonly number[] {
  requirePositiveSafeInteger(totalBytes, "totalBytes");
  requirePositiveSafeInteger(maxStripBytes, "maxStripBytes");
  const strips: number[] = [];
  for (let remaining = totalBytes; remaining > 0; remaining -= maxStripBytes) {
    strips.push(Math.min(remaining, maxStripBytes));
  }
  return Object.freeze(strips);
}

/**
 * Schedule a transfer against independent CPU-producer and panel-DMA clocks.
 * The model is a shadow timeline. Its calibration field is part of every result
 * so configured or estimated inputs cannot be mistaken for measurements.
 */
export function scheduleTransfer(config: SchedulerConfig, request: TransferRequest): ScheduleResult {
  requirePositiveSafeInteger(config.queueDepth, "queueDepth");
  if (config.cpuProducer.hz <= 0n) throw new Error("cpuProducer.hz must be positive");
  if (config.panelDma.hz <= 0n) throw new Error("panelDma.hz must be positive");
  validateCost(request.producerCost, "producerCost");
  validateCost(request.panelDmaCost, "panelDmaCost");

  const byteStrips = partitionBytes(request.totalBytes, request.maxStripBytes);
  const events: MutableEvent[] = [];
  const scheduled: ScheduledStrip[] = [];
  const pending: PendingCompletion[] = [];
  let sequence = 0;
  let cpuAvailable = ZERO;
  let panelAvailable = ZERO;

  const record = (
    kind: SchedulerEventKind,
    stripIndex: number,
    at: ExactSeconds,
    bytes: number,
  ): void => {
    events.push({ kind, stripIndex, at, bytes, queueOccupancy: 0, sequence: sequence++ });
  };

  for (const [stripIndex, bytes] of byteStrips.entries()) {
    const producerCycles = cyclesFor(bytes, request.producerCost);
    const panelDmaCycles = cyclesFor(bytes, request.panelDmaCost);
    if (producerCycles <= 0n) throw new Error("producerCost must produce a positive cycle count per strip");
    if (panelDmaCycles <= 0n) throw new Error("panelDmaCost must produce a positive cycle count per strip");
    const producerStartedAt = cpuAvailable;
    const producedAt = add(producerStartedAt, duration(producerCycles, config.cpuProducer));
    record("producer-start", stripIndex, producerStartedAt, bytes);
    record("producer-complete", stripIndex, producedAt, bytes);

    while (pending.length > 0 && compareTime(pending[0]!.at, producedAt) <= 0) pending.shift();

    let submittedAt = producedAt;
    let queueWait = ZERO;
    if (pending.length >= config.queueDepth) {
      const nextCompletion = pending[0]!.at;
      record("queue-wait-start", stripIndex, producedAt, bytes);
      submittedAt = nextCompletion;
      queueWait = subtract(submittedAt, producedAt);
      while (pending.length > 0 && compareTime(pending[0]!.at, submittedAt) <= 0) pending.shift();
      record("queue-wait-end", stripIndex, submittedAt, bytes);
    }

    record("submit", stripIndex, submittedAt, bytes);
    const panelStartedAt = later(submittedAt, panelAvailable);
    const completedAt = add(panelStartedAt, duration(panelDmaCycles, config.panelDma));
    record("panel-start", stripIndex, panelStartedAt, bytes);
    pending.push({ stripIndex, at: completedAt });
    panelAvailable = completedAt;
    cpuAvailable = submittedAt;

    scheduled.push({
      index: stripIndex,
      bytes,
      producerCycles,
      panelDmaCycles,
      producerStartedAt,
      producedAt,
      submittedAt,
      panelStartedAt,
      completedAt,
      queueWait,
    });
  }

  for (const strip of scheduled) {
    record("panel-complete", strip.index, strip.completedAt, strip.bytes);
  }

  events.sort((left, right) => {
    const byTime = compareTime(left.at, right.at);
    if (byTime !== 0) return byTime;
    const byKind = EVENT_ORDER[left.kind] - EVENT_ORDER[right.kind];
    if (byKind !== 0) return byKind;
    const byStrip = left.stripIndex - right.stripIndex;
    return byStrip !== 0 ? byStrip : left.sequence - right.sequence;
  });

  const uncalibratedInputs: string[] = [];
  if (config.cpuProducer.calibration === "uncalibrated") uncalibratedInputs.push("cpuProducer.clock");
  if (config.panelDma.calibration === "uncalibrated") uncalibratedInputs.push("panelDma.clock");
  if (request.producerCost.calibration === "uncalibrated") uncalibratedInputs.push("producerCost");
  if (request.panelDmaCost.calibration === "uncalibrated") uncalibratedInputs.push("panelDmaCost");

  let queueOccupancy = 0;
  const publicEvents = events.map(({ sequence: _sequence, ...event }) => {
    if (event.kind === "panel-complete") queueOccupancy -= 1;
    if (event.kind === "submit") queueOccupancy += 1;
    if (queueOccupancy < 0 || queueOccupancy > config.queueDepth) {
      throw new Error(`internal queue occupancy escaped 0..${config.queueDepth}`);
    }
    return Object.freeze({ ...event, queueOccupancy });
  });

  return Object.freeze({
    calibration: Object.freeze({
      status: uncalibratedInputs.length === 0 ? "calibrated" : "uncalibrated",
      uncalibratedInputs: Object.freeze(uncalibratedInputs),
    }),
    clocks: Object.freeze({ cpuProducer: config.cpuProducer, panelDma: config.panelDma }),
    queueDepth: config.queueDepth,
    totalBytes: request.totalBytes,
    elapsed: scheduled.at(-1)?.completedAt ?? ZERO,
    strips: Object.freeze(scheduled),
    events: Object.freeze(publicEvents),
  });
}
