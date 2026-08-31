import {
  AddressSpaceResolver,
  adaptAddressResolution,
  type AddressFault,
  type AddressMapConfiguration,
  type ResolvedAddressSegment,
  type ResolvedMemoryAccess,
  type VirtualMemoryAccess,
} from "./address-map";
import {
  CacheStateMachine,
  type CacheConfiguration,
  type CacheLatency,
  type CacheStep,
} from "./cache";
import {
  scheduleExecution,
  type CalibrationStatus,
  type DmaEvent,
  type EventLatency,
  type ExecutionEvent,
  type ExecutionSchedule,
  type TimingCertainty,
} from "./execution";

export interface TimingMachineConfiguration {
  readonly addressMap: AddressMapConfiguration;
  readonly cache: CacheConfiguration;
  readonly mmioCost: (
    segment: ResolvedAddressSegment,
    access: VirtualMemoryAccess,
  ) => CacheLatency;
}

export type TimingMachineIssue =
  | Readonly<{ kind: "memory"; accessId: string }>
  | Readonly<{ kind: "dma"; eventId: string }>;

export interface TimingMachineInput {
  readonly cores: readonly [
    readonly VirtualMemoryAccess[],
    readonly VirtualMemoryAccess[],
  ];
  readonly architecturalInterleave: readonly string[];
  readonly dma: readonly DmaEvent[];
  /** Optional total issue order. Omission retains the legacy memory-then-DMA behavior. */
  readonly issueOrder?: readonly TimingMachineIssue[];
}

export interface ResolvedMachineAccess {
  readonly status: "resolved";
  readonly core: 0 | 1;
  readonly programIndex: number;
  readonly access: VirtualMemoryAccess;
  readonly resolution: ResolvedMemoryAccess;
  readonly cacheSteps: readonly CacheStep[];
  readonly issuedEventIds: readonly string[];
}

export interface FaultedMachineAccess {
  readonly status: "fault";
  readonly core: 0 | 1;
  readonly programIndex: number;
  readonly access: VirtualMemoryAccess;
  readonly fault: AddressFault;
  readonly issuedEventIds: readonly [];
}

export interface SkippedMachineAccess {
  readonly status: "skipped-after-fault";
  readonly core: 0 | 1;
  readonly programIndex: number;
  readonly access: VirtualMemoryAccess;
  readonly blockedByAccessId: string;
  readonly issuedEventIds: readonly [];
}

export type MachineAccessResult =
  | ResolvedMachineAccess
  | FaultedMachineAccess
  | SkippedMachineAccess;

export interface MachineCoreResult {
  readonly core: 0 | 1;
  readonly status: "complete" | "faulted";
  readonly faultedByAccessId: string | null;
  readonly accesses: readonly MachineAccessResult[];
}

export type MachineEventOrigin =
  | Readonly<{
      kind: "cache";
      core: 0 | 1;
      programIndex: number;
      accessId: string;
      addressSegmentIndex: number;
      cacheEmissionIndex: number;
      regionId: string;
    }>
  | Readonly<{
      kind: "mmio";
      core: 0 | 1;
      programIndex: number;
      accessId: string;
      addressSegmentIndex: number;
      regionId: string;
    }>
  | Readonly<{
      kind: "dma";
      dmaIndex: number;
      channel: string;
    }>;

export type MachineCostProvenance =
  | Readonly<{
      status: "known";
      eventId: string;
      calibration: CalibrationStatus;
      cycles: bigint;
      source: string;
    }>
  | Readonly<{
      status: "unknown";
      eventId: string;
      calibration: "unknown";
      reason: string;
      source: string | null;
    }>;

export interface IssuedMachineEvent {
  readonly issueIndex: number;
  readonly event: ExecutionEvent;
  readonly origin: MachineEventOrigin;
  readonly cost: MachineCostProvenance;
}

export interface TimingMachineClaim {
  readonly architectureCalibration: "uncalibrated";
  readonly architectureSources: readonly [
    Readonly<{ component: "address-map"; source: string }>,
    Readonly<{ component: "cache"; source: string }>,
  ];
  readonly costCalibration: TimingCertainty;
  readonly directUncalibratedEventIds: readonly string[];
  readonly unknownCostEventIds: readonly string[];
  readonly costProvenance: readonly MachineCostProvenance[];
  readonly dmaReadinessSources: readonly Readonly<{
    eventId: string;
    calibration: CalibrationStatus;
    source: string;
  }>[];
}

export interface TimingMachineResult {
  readonly schemaVersion: 1;
  readonly status: "complete" | "blocked" | "faulted" | "faulted-and-blocked";
  readonly claim: TimingMachineClaim;
  readonly architecturalInterleave: readonly string[];
  readonly cores: readonly [MachineCoreResult, MachineCoreResult];
  readonly issuedEvents: readonly IssuedMachineEvent[];
  readonly execution: ExecutionSchedule;
}

function requireNonEmpty(value: unknown, path: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${path} must be a non-empty string`);
  }
  return value;
}

function validateMachineCost(cost: unknown, path: string): asserts cost is CacheLatency {
  if (typeof cost !== "object" || cost === null) {
    throw new Error(`${path} must return an explicit known or unknown cost`);
  }
  const candidate = cost as Partial<CacheLatency>;
  requireNonEmpty(candidate.source, `${path}.source`);
  if (candidate.status === "known") {
    if (typeof candidate.cycles !== "bigint" || candidate.cycles < 0n) {
      throw new Error(`${path}.cycles must be a non-negative bigint`);
    }
    if (candidate.calibration !== "calibrated" && candidate.calibration !== "uncalibrated") {
      throw new Error(`${path}.calibration must be calibrated or uncalibrated`);
    }
    return;
  }
  if (candidate.status === "unknown") {
    requireNonEmpty(candidate.reason, `${path}.reason`);
    return;
  }
  throw new Error(`${path}.status must be known or unknown`);
}

function toEventLatency(cost: CacheLatency): EventLatency {
  return cost.status === "known"
    ? {
        status: "known",
        cycles: cost.cycles,
        calibration: cost.calibration,
        source: cost.source,
      }
    : {
        status: "unknown",
        reason: `${cost.reason}; source: ${cost.source}`,
      };
}

function provenance(
  event: ExecutionEvent,
  sourceForUnknown: string | null,
): MachineCostProvenance {
  if (event.latency.status === "known") {
    return Object.freeze({
      status: "known",
      eventId: event.id,
      calibration: event.latency.calibration,
      cycles: event.latency.cycles,
      source: event.latency.source,
    });
  }
  return Object.freeze({
    status: "unknown",
    eventId: event.id,
    calibration: "unknown",
    reason: event.latency.reason,
    source: event.latency.source ?? sourceForUnknown,
  });
}

function applyServiceLatencies(
  issued: readonly IssuedMachineEvent[],
  execution: ExecutionSchedule,
): readonly IssuedMachineEvent[] {
  const byId = new Map(execution.events.map((result) => [result.eventId, result]));
  return Object.freeze(issued.map((record) => {
    if (!("mspiBurst" in record.event) || record.event.mspiBurst === undefined) return record;
    const result = byId.get(record.event.id);
    if (result?.status !== "completed" && result?.status !== "started-unknown-duration") {
      return record;
    }
    const event = Object.freeze({
      ...record.event,
      latency: result.latency,
    }) as ExecutionEvent;
    return Object.freeze({
      ...record,
      event,
      cost: provenance(event, record.cost.source),
    });
  }));
}

interface OrderedArchitecturalAccess {
  readonly core: 0 | 1;
  readonly programIndex: number;
  readonly access: VirtualMemoryAccess;
}

type OrderedMachineIssue =
  | Readonly<{ kind: "memory"; entry: OrderedArchitecturalAccess }>
  | Readonly<{ kind: "dma"; dmaIndex: number; event: DmaEvent }>;

interface ValidatedMachineInput {
  readonly architecturalOrder: readonly OrderedArchitecturalAccess[];
  readonly issueOrder: readonly OrderedMachineIssue[];
  readonly hasExplicitIssueOrder: boolean;
}

function validateInput(input: TimingMachineInput): ValidatedMachineInput {
  if (typeof input !== "object" || input === null) throw new Error("machine input is required");
  if (!Array.isArray(input.cores) || input.cores.length !== 2) {
    throw new Error("input.cores must contain exactly two ordered core streams");
  }
  if (!Array.isArray(input.cores[0]) || !Array.isArray(input.cores[1])) {
    throw new Error("each core stream must be an array");
  }
  if (!Array.isArray(input.dma)) throw new Error("input.dma must be an array");
  if (!Array.isArray(input.architecturalInterleave)) {
    throw new Error("input.architecturalInterleave is required");
  }

  const ids = new Set<string>();
  const byId = new Map<string, OrderedArchitecturalAccess>();
  for (const core of [0, 1] as const) {
    for (const [programIndex, access] of input.cores[core].entries()) {
      if (typeof access !== "object" || access === null) {
        throw new Error(`input.cores[${core}][${programIndex}] must be an access`);
      }
      const id = requireNonEmpty(access.id, `input.cores[${core}][${programIndex}].id`);
      if (ids.has(id)) throw new Error(`duplicate architectural access id ${id}`);
      ids.add(id);
      if (access.core !== core) {
        throw new Error(`access ${id}.core must match core stream ${core}`);
      }
      byId.set(id, Object.freeze({ core, programIndex, access }));
    }
  }

  const seen = new Set<string>();
  const nextProgramIndex: [number, number] = [0, 0];
  const ordered: OrderedArchitecturalAccess[] = [];
  for (const [interleaveIndex, value] of input.architecturalInterleave.entries()) {
    const id = requireNonEmpty(value, `input.architecturalInterleave[${interleaveIndex}]`);
    if (seen.has(id)) throw new Error(`input.architecturalInterleave duplicates access id ${id}`);
    const entry = byId.get(id);
    if (!entry) throw new Error(`input.architecturalInterleave contains unknown access id ${id}`);
    const expectedProgramIndex = nextProgramIndex[entry.core];
    if (entry.programIndex !== expectedProgramIndex) {
      const expectedId = input.cores[entry.core][expectedProgramIndex]!.id;
      throw new Error(
        `input.architecturalInterleave places ${id} before ${expectedId}; core ${entry.core} program order must be preserved`,
      );
    }
    seen.add(id);
    nextProgramIndex[entry.core] += 1;
    ordered.push(entry);
  }
  const omitted = [...byId.keys()].filter((id) => !seen.has(id));
  if (omitted.length > 0) {
    throw new Error(`input.architecturalInterleave omits access ids: ${omitted.join(", ")}`);
  }

  const dmaById = new Map<string, Readonly<{ dmaIndex: number; event: DmaEvent }>>();
  for (const [dmaIndex, event] of input.dma.entries()) {
    if (typeof event !== "object" || event === null) {
      throw new Error(`input.dma[${dmaIndex}] must be a DMA event`);
    }
    const id = requireNonEmpty(event.id, `input.dma[${dmaIndex}].id`);
    if (ids.has(id) || dmaById.has(id)) throw new Error(`duplicate machine issue id ${id}`);
    dmaById.set(id, Object.freeze({ dmaIndex, event }));
  }

  if (input.issueOrder === undefined) {
    return Object.freeze({
      architecturalOrder: Object.freeze(ordered),
      issueOrder: Object.freeze([
        ...ordered.map((entry) => Object.freeze({ kind: "memory" as const, entry })),
        ...input.dma.map((event, dmaIndex) =>
          Object.freeze({ kind: "dma" as const, dmaIndex, event }),
        ),
      ]),
      hasExplicitIssueOrder: false,
    });
  }
  if (!Array.isArray(input.issueOrder)) throw new Error("input.issueOrder must be an array when supplied");

  const issueOrder: OrderedMachineIssue[] = [];
  const issueIds = new Set<string>();
  let memoryIndex = 0;
  let dmaIndex = 0;
  for (const [issueIndex, issue] of input.issueOrder.entries()) {
    if (typeof issue !== "object" || issue === null) {
      throw new Error(`input.issueOrder[${issueIndex}] must be a memory or DMA issue`);
    }
    if (issue.kind === "memory") {
      const id = requireNonEmpty(issue.accessId, `input.issueOrder[${issueIndex}].accessId`);
      if (issueIds.has(id)) throw new Error(`input.issueOrder duplicates issue id ${id}`);
      const entry = byId.get(id);
      if (!entry) throw new Error(`input.issueOrder contains unknown memory access id ${id}`);
      const expected = ordered[memoryIndex]?.access.id;
      if (id !== expected) {
        throw new Error(
          `input.issueOrder memory access ${id} disagrees with architecturalInterleave at index ${memoryIndex}`,
        );
      }
      memoryIndex += 1;
      issueIds.add(id);
      issueOrder.push(Object.freeze({ kind: "memory", entry }));
      continue;
    }
    if (issue.kind === "dma") {
      const id = requireNonEmpty(issue.eventId, `input.issueOrder[${issueIndex}].eventId`);
      if (issueIds.has(id)) throw new Error(`input.issueOrder duplicates issue id ${id}`);
      const entry = dmaById.get(id);
      if (!entry) throw new Error(`input.issueOrder contains unknown DMA event id ${id}`);
      const expected = input.dma[dmaIndex]?.id;
      if (id !== expected) {
        throw new Error(`input.issueOrder DMA event ${id} disagrees with input.dma at index ${dmaIndex}`);
      }
      dmaIndex += 1;
      issueIds.add(id);
      issueOrder.push(Object.freeze({ kind: "dma", ...entry }));
      continue;
    }
    throw new Error(`input.issueOrder[${issueIndex}].kind must be memory or dma`);
  }
  if (memoryIndex !== ordered.length || dmaIndex !== input.dma.length) {
    const missing = [
      ...ordered.slice(memoryIndex).map((entry) => entry.access.id),
      ...input.dma.slice(dmaIndex).map((event) => event.id),
    ];
    throw new Error(`input.issueOrder omits issue ids: ${missing.join(", ")}`);
  }
  return Object.freeze({
    architecturalOrder: Object.freeze(ordered),
    issueOrder: Object.freeze(issueOrder),
    hasExplicitIssueOrder: true,
  });
}

function freezeCoreResult(
  core: 0 | 1,
  accesses: readonly MachineAccessResult[],
  faultedByAccessId: string | null,
): MachineCoreResult {
  return Object.freeze({
    core,
    status: faultedByAccessId === null ? "complete" : "faulted",
    faultedByAccessId,
    accesses: Object.freeze(accesses),
  });
}

function resultStatus(
  cores: readonly [MachineCoreResult, MachineCoreResult],
  execution: ExecutionSchedule,
): TimingMachineResult["status"] {
  const faulted = cores.some((core) => core.status === "faulted");
  const blocked = execution.status === "blocked";
  if (faulted && blocked) return "faulted-and-blocked";
  if (faulted) return "faulted";
  return blocked ? "blocked" : "complete";
}

/**
 * Resolve and execute two ordered architectural memory streams plus DMA.
 * The caller supplies one total cross-core interleave that preserves both
 * per-core orders, so shared cache state has no implicit traversal order.
 * Address faults are atomic: the faulting access emits nothing, and every
 * later access on that core is recorded as skipped without touching cache state.
 */
export function runTimingMachine(
  config: TimingMachineConfiguration,
  input: TimingMachineInput,
): TimingMachineResult {
  if (typeof config !== "object" || config === null) throw new Error("machine configuration is required");
  if (typeof config.mmioCost !== "function") {
    throw new Error("config.mmioCost is required; the machine has no default MMIO costs");
  }
  if (config.addressMap.addressBits !== config.cache.addressBits) {
    throw new Error("address-map and cache address widths must match");
  }
  const validatedInput = validateInput(input);
  const architecturalOrder = validatedInput.architecturalOrder;

  const resolver = new AddressSpaceResolver(config.addressMap);
  const cache = new CacheStateMachine(config.cache);
  const issued: IssuedMachineEvent[] = [];
  const accessResults: [MachineAccessResult[], MachineAccessResult[]] = [[], []];
  const faultedByAccessId: [string | null, string | null] = [null, null];

  for (const issue of validatedInput.issueOrder) {
      if (issue.kind === "dma") {
        issued.push(
          Object.freeze({
            issueIndex: issued.length,
            event: issue.event,
            origin: Object.freeze({
              kind: "dma",
              dmaIndex: issue.dmaIndex,
              channel: issue.event.channel,
            }),
            cost: provenance(issue.event, null),
          }),
        );
        continue;
      }
      const { core, programIndex, access } = issue.entry;
      if (faultedByAccessId[core] !== null) {
        accessResults[core].push(
          Object.freeze({
            status: "skipped-after-fault",
            core,
            programIndex,
            access,
            blockedByAccessId: faultedByAccessId[core],
            issuedEventIds: Object.freeze([]) as readonly [],
          }),
        );
        continue;
      }

      const resolution = resolver.resolve(access);
      if (resolution.status === "fault") {
        faultedByAccessId[core] = access.id;
        accessResults[core].push(
          Object.freeze({
            status: "fault",
            core,
            programIndex,
            access,
            fault: resolution.fault,
            issuedEventIds: Object.freeze([]) as readonly [],
          }),
        );
        continue;
      }

      const mmioCosts = new Map<number, CacheLatency>();
      const adapted = adaptAddressResolution(resolution, {
        mmioLatency: (segment, resolvedAccess) => {
          const cost = config.mmioCost(segment, resolvedAccess);
          validateMachineCost(cost, `config.mmioCost(${resolvedAccess.id}, segment ${segment.index})`);
          mmioCosts.set(segment.index, cost);
          return toEventLatency(cost);
        },
      });
      if (adapted.status !== "resolved") {
        throw new Error(`internal error: resolved access ${access.id} adapted to a fault`);
      }

      const cacheSteps: CacheStep[] = [];
      const issuedEventIds: string[] = [];
      for (const output of adapted.outputs) {
        if (output.kind === "mmio") {
          const cost = mmioCosts.get(output.resolved.index);
          if (!cost) throw new Error(`internal error: no MMIO cost for ${output.event.id}`);
          const eventRecord: IssuedMachineEvent = Object.freeze({
            issueIndex: issued.length,
            event: output.event,
            origin: Object.freeze({
              kind: "mmio",
              core,
              programIndex,
              accessId: access.id,
              addressSegmentIndex: output.resolved.index,
              regionId: output.resolved.regionId,
            }),
            cost: provenance(output.event, cost.source),
          });
          issued.push(eventRecord);
          issuedEventIds.push(output.event.id);
          continue;
        }

        const step = cache.process(output.trace);
        cacheSteps.push(step);
        for (const [cacheEmissionIndex, emission] of step.emissions.entries()) {
          const eventRecord: IssuedMachineEvent = Object.freeze({
            issueIndex: issued.length,
            event: emission.event,
            origin: Object.freeze({
              kind: "cache",
              core,
              programIndex,
              accessId: access.id,
              addressSegmentIndex: output.resolved.index,
              cacheEmissionIndex,
              regionId: output.resolved.regionId,
            }),
            cost: provenance(emission.event, emission.cost.source),
          });
          issued.push(eventRecord);
          issuedEventIds.push(emission.event.id);
        }
      }
      accessResults[core].push(
        Object.freeze({
          status: "resolved",
          core,
          programIndex,
          access,
          resolution,
          cacheSteps: Object.freeze(cacheSteps),
          issuedEventIds: Object.freeze(issuedEventIds),
        }),
      );
  }

  const coreResults: [MachineCoreResult, MachineCoreResult] = [
    freezeCoreResult(0, accessResults[0], faultedByAccessId[0]),
    freezeCoreResult(1, accessResults[1], faultedByAccessId[1]),
  ];

  const execution = scheduleExecution(
    issued.map((record) => record.event),
    validatedInput.hasExplicitIssueOrder ? { sameCycleTieBreak: "input-order" } : undefined,
  );
  const servicedIssued = applyServiceLatencies(issued, execution);
  const costProvenance = Object.freeze(servicedIssued.map((record) => record.cost));
  const directUncalibratedEventIds = Object.freeze(
    costProvenance
      .filter((cost) => cost.status === "known" && cost.calibration === "uncalibrated")
      .map((cost) => cost.eventId),
  );
  const unknownCostEventIds = Object.freeze(
    costProvenance.filter((cost) => cost.status === "unknown").map((cost) => cost.eventId),
  );
  const dmaReadinessSources = Object.freeze(
    input.dma.map((dma) =>
      Object.freeze({
        eventId: dma.id,
        calibration: dma.earliest.calibration,
        source: dma.earliest.source,
      }),
    ),
  );
  const cores = Object.freeze(coreResults) as readonly [MachineCoreResult, MachineCoreResult];
  const architectureSources = Object.freeze([
    Object.freeze({ component: "address-map", source: config.addressMap.metadata.source }),
    Object.freeze({ component: "cache", source: config.cache.metadata.source }),
  ]) as TimingMachineClaim["architectureSources"];
  const claim: TimingMachineClaim = Object.freeze({
    architectureCalibration: "uncalibrated",
    architectureSources,
    costCalibration: execution.calibration.status,
    directUncalibratedEventIds,
    unknownCostEventIds,
    costProvenance,
    dmaReadinessSources,
  });

  return Object.freeze({
    schemaVersion: 1,
    status: resultStatus(cores, execution),
    claim,
    architecturalInterleave: Object.freeze(
      architecturalOrder.map((entry) => entry.access.id),
    ),
    cores,
    issuedEvents: servicedIssued,
    execution,
  });
}

/** Encode bigint addresses and cycles as base-10 strings in stable JSON order. */
export function timingMachineJson(result: TimingMachineResult): string {
  return JSON.stringify(result, (_key, value: unknown) =>
    typeof value === "bigint" ? value.toString(10) : value,
  );
}
