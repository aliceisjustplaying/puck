import type {
  CalibrationStatus,
  CoreId,
  EventLatency,
  ExecutionEvent,
  MemoryRegion,
} from "./execution";

export type CacheKind = "instruction" | "data";
export type ReplacementPolicy = "least-recently-used" | "round-robin";
export type CacheBankSharing = "per-core" | "shared";

export interface CacheBankTopology {
  readonly instruction: CacheBankSharing;
  readonly data: CacheBankSharing;
}

export const ESP32_S3_CACHE_BANK_TOPOLOGY: Readonly<CacheBankTopology> = Object.freeze({
  instruction: "per-core",
  data: "shared",
});

export type CacheLatency =
  | Readonly<{
      status: "known";
      cycles: bigint;
      calibration: CalibrationStatus;
      source: string;
    }>
  | Readonly<{
      status: "unknown";
      reason: string;
      source: string;
    }>;

export type ExternalCacheLineFillCosts = Readonly<{
  instruction: Readonly<Record<"flash" | "psram", CacheLatency>>;
  data: Readonly<Record<"flash" | "psram", CacheLatency>>;
}>;

export type CacheLineFillCost = CacheLatency | ExternalCacheLineFillCosts;

export interface CacheGeometry {
  readonly lineSizeBytes: number;
  readonly sets: number;
  readonly ways: number;
  readonly replacement: ReplacementPolicy;
}

export interface CacheConfiguration {
  readonly addressBits: number;
  readonly metadata: Readonly<{
    readonly architectureCalibration: "uncalibrated";
    readonly source: string;
  }>;
  readonly topology: Readonly<CacheBankTopology>;
  readonly instruction: CacheGeometry &
    Readonly<{
      writePolicy: "read-only";
    }>;
  readonly data: CacheGeometry &
    Readonly<{
      writePolicy: "write-back" | "write-through";
      allocateOnStoreMiss: boolean;
      dirtyInvalidate: "writeback" | "discard";
    }>;
  readonly costs: Readonly<{
    hit: Readonly<{
      instructionFetch: CacheLatency;
      load: CacheLatency;
      store: CacheLatency;
    }>;
    lineFill: CacheLineFillCost;
    dirtyWriteback: CacheLatency;
    writeThrough: CacheLatency;
    uncached: Readonly<{
      instructionFetch: CacheLatency;
      load: CacheLatency;
      store: CacheLatency;
    }>;
    sram: Readonly<{
      instructionFetch: CacheLatency;
      load: CacheLatency;
      store: CacheLatency;
    }>;
    maintenance: CacheLatency;
  }>;
}

export interface CacheAccessTrace {
  readonly id: string;
  readonly kind: "instruction-fetch" | "literal-load" | "load" | "store";
  readonly core: CoreId;
  readonly memory: MemoryRegion;
  readonly address: bigint;
  readonly bytes: number;
  readonly cacheability: "cached" | "uncached";
}

export interface CacheMaintenanceTrace {
  readonly id: string;
  readonly kind: "flush" | "invalidate";
  readonly core: CoreId;
  readonly cache: CacheKind | "both";
  readonly scope:
    | Readonly<{ kind: "all" }>
    | Readonly<{ kind: "range"; address: bigint; bytes: number }>;
}

export type CacheTrace = CacheAccessTrace | CacheMaintenanceTrace;

export type CacheEmissionKind =
  | "hit"
  | "line-fill"
  | "dirty-writeback"
  | "write-through"
  | "uncached"
  | "sram-bypass"
  | "flush"
  | "invalidate";

export interface CacheEmission {
  readonly kind: CacheEmissionKind;
  readonly traceId: string;
  readonly segmentIndex: number | null;
  readonly core: CoreId;
  readonly cache: CacheKind;
  readonly address: bigint | null;
  readonly bytes: number | null;
  readonly lineAddress: bigint | null;
  readonly cost: CacheLatency;
  readonly event: ExecutionEvent;
}

export interface CacheStep {
  readonly traceId: string;
  readonly claim: Readonly<{
    architectureCalibration: "uncalibrated";
    source: string;
    costCalibration: CalibrationStatus | "unknown";
    uncalibratedCostEventIds: readonly string[];
    unknownCostEventIds: readonly string[];
  }>;
  readonly emissions: readonly CacheEmission[];
}

type ExecutionEventWithoutTiming<T = ExecutionEvent> = T extends ExecutionEvent
  ? Omit<T, "id" | "latency">
  : never;

interface CacheLine {
  valid: boolean;
  dirty: boolean;
  memory: "flash" | "psram" | null;
  tag: bigint;
  lineAddress: bigint;
  lastUsed: bigint;
}

interface CacheBank {
  readonly sets: CacheLine[][];
  readonly nextRoundRobinWay: number[];
  useSequence: bigint;
}

interface AccessSegment {
  readonly index: number;
  readonly address: bigint;
  readonly bytes: number;
  readonly lineAddress: bigint;
}

const CACHE_KINDS: readonly CacheKind[] = ["instruction", "data"];

function requireNonEmpty(value: unknown, path: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${path} must be a non-empty string`);
  return value;
}

function requirePositiveSafeInteger(value: unknown, path: string): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    throw new Error(`${path} must be a positive safe integer`);
  }
  return value as number;
}

function validateCalibration(value: unknown, path: string): asserts value is CalibrationStatus {
  if (value !== "calibrated" && value !== "uncalibrated") {
    throw new Error(`${path} must be calibrated or uncalibrated`);
  }
}

function validateMemory(value: unknown, path: string): asserts value is MemoryRegion {
  if (value !== "sram" && value !== "psram" && value !== "flash") {
    throw new Error(`${path} must be sram, psram, or flash`);
  }
}

function validateCost(cost: CacheLatency, path: string): void {
  if (typeof cost !== "object" || cost === null) {
    throw new Error(`${path} is required; the cache model has no default latency`);
  }
  requireNonEmpty(cost.source, `${path}.source`);
  if (cost.status === "known") {
    if (typeof cost.cycles !== "bigint" || cost.cycles < 0n) {
      throw new Error(`${path}.cycles must be a non-negative bigint`);
    }
    validateCalibration(cost.calibration, `${path}.calibration`);
    return;
  }
  if (cost.status === "unknown") {
    requireNonEmpty(cost.reason, `${path}.reason`);
    return;
  }
  throw new Error(`${path}.status must be known or unknown`);
}

function isCacheLatency(value: CacheLineFillCost): value is CacheLatency {
  return "status" in value;
}

function validateLineFillCost(cost: CacheLineFillCost, path: string): void {
  if (typeof cost !== "object" || cost === null) {
    throw new Error(`${path} is required; the cache model has no default latency`);
  }
  if (isCacheLatency(cost)) {
    validateCost(cost, path);
    return;
  }
  for (const cache of CACHE_KINDS) {
    const byMemory = cost[cache];
    if (typeof byMemory !== "object" || byMemory === null) {
      throw new Error(`${path}.${cache} is required`);
    }
    validateCost(byMemory.flash, `${path}.${cache}.flash`);
    validateCost(byMemory.psram, `${path}.${cache}.psram`);
  }
}

function validateGeometry(geometry: CacheGeometry, path: string): void {
  if (typeof geometry !== "object" || geometry === null) throw new Error(`${path} is required`);
  requirePositiveSafeInteger(geometry.lineSizeBytes, `${path}.lineSizeBytes`);
  requirePositiveSafeInteger(geometry.sets, `${path}.sets`);
  requirePositiveSafeInteger(geometry.ways, `${path}.ways`);
  if (geometry.replacement !== "least-recently-used" && geometry.replacement !== "round-robin") {
    throw new Error(`${path}.replacement must be least-recently-used or round-robin`);
  }
}

function validateBankSharing(value: unknown, path: string): asserts value is CacheBankSharing {
  if (value !== "per-core" && value !== "shared") {
    throw new Error(`${path} must be per-core or shared`);
  }
}

function validateConfiguration(config: CacheConfiguration): void {
  if (typeof config !== "object" || config === null) throw new Error("cache configuration is required");
  const addressBits = requirePositiveSafeInteger(config.addressBits, "config.addressBits");
  if (addressBits > 64) throw new Error("config.addressBits must not exceed 64");
  if (typeof config.metadata !== "object" || config.metadata === null) {
    throw new Error("config.metadata is required");
  }
  if (config.metadata.architectureCalibration !== "uncalibrated") {
    throw new Error("config.metadata.architectureCalibration must remain uncalibrated");
  }
  requireNonEmpty(config.metadata.source, "config.metadata.source");
  if (typeof config.topology !== "object" || config.topology === null) {
    throw new Error("config.topology is required");
  }
  validateBankSharing(config.topology.instruction, "config.topology.instruction");
  validateBankSharing(config.topology.data, "config.topology.data");
  validateGeometry(config.instruction, "config.instruction");
  validateGeometry(config.data, "config.data");
  if (config.instruction.writePolicy !== "read-only") {
    throw new Error("config.instruction.writePolicy must be read-only");
  }
  if (config.data.writePolicy !== "write-back" && config.data.writePolicy !== "write-through") {
    throw new Error("config.data.writePolicy must be write-back or write-through");
  }
  if (typeof config.data.allocateOnStoreMiss !== "boolean") {
    throw new Error("config.data.allocateOnStoreMiss must be a boolean");
  }
  if (config.data.dirtyInvalidate !== "writeback" && config.data.dirtyInvalidate !== "discard") {
    throw new Error("config.data.dirtyInvalidate must be writeback or discard");
  }
  if (typeof config.costs !== "object" || config.costs === null) {
    throw new Error("config.costs is required; the cache model has no default latencies");
  }
  if (typeof config.costs.hit !== "object" || config.costs.hit === null) {
    throw new Error("config.costs.hit is required; the cache model has no default hit latencies");
  }
  if (typeof config.costs.uncached !== "object" || config.costs.uncached === null) {
    throw new Error("config.costs.uncached is required; the cache model has no default uncached latencies");
  }
  if (typeof config.costs.sram !== "object" || config.costs.sram === null) {
    throw new Error("config.costs.sram is required; the cache model has no default SRAM latencies");
  }
  validateCost(config.costs.hit.instructionFetch, "config.costs.hit.instructionFetch");
  validateCost(config.costs.hit.load, "config.costs.hit.load");
  validateCost(config.costs.hit.store, "config.costs.hit.store");
  validateLineFillCost(config.costs.lineFill, "config.costs.lineFill");
  validateCost(config.costs.dirtyWriteback, "config.costs.dirtyWriteback");
  validateCost(config.costs.writeThrough, "config.costs.writeThrough");
  validateCost(config.costs.uncached.instructionFetch, "config.costs.uncached.instructionFetch");
  validateCost(config.costs.uncached.load, "config.costs.uncached.load");
  validateCost(config.costs.uncached.store, "config.costs.uncached.store");
  validateCost(config.costs.sram.instructionFetch, "config.costs.sram.instructionFetch");
  validateCost(config.costs.sram.load, "config.costs.sram.load");
  validateCost(config.costs.sram.store, "config.costs.sram.store");
  validateCost(config.costs.maintenance, "config.costs.maintenance");
}

function emptyLine(): CacheLine {
  return { valid: false, dirty: false, memory: null, tag: 0n, lineAddress: 0n, lastUsed: 0n };
}

function createBank(geometry: CacheGeometry): CacheBank {
  return {
    sets: Array.from({ length: geometry.sets }, () =>
      Array.from({ length: geometry.ways }, () => emptyLine()),
    ),
    nextRoundRobinWay: Array(geometry.sets).fill(0),
    useSequence: 0n,
  };
}

function bankKey(core: CoreId, cache: CacheKind, sharing: CacheBankSharing): string {
  return sharing === "shared" ? `shared:${cache}` : `core:${core}:${cache}`;
}

function toExecutionLatency(cost: CacheLatency): EventLatency {
  if (cost.status === "known") {
    return {
      status: "known",
      cycles: cost.cycles,
      calibration: cost.calibration,
      source: cost.source,
    };
  }
  return { status: "unknown", reason: `${cost.reason}; source: ${cost.source}` };
}

function costCalibration(cost: CacheLatency): CalibrationStatus | "unknown" {
  return cost.status === "known" ? cost.calibration : "unknown";
}

function combineCostCalibration(costs: readonly CacheLatency[]): CalibrationStatus | "unknown" {
  if (costs.some((cost) => cost.status === "unknown")) return "unknown";
  return costs.every((cost) => costCalibration(cost) === "calibrated")
    ? "calibrated"
    : "uncalibrated";
}

function cacheForAccess(trace: CacheAccessTrace): CacheKind {
  return trace.kind === "instruction-fetch" || trace.kind === "literal-load" ? "instruction" : "data";
}

function assertNever(value: never): never {
  throw new Error(`unsupported cache trace kind ${String((value as { kind?: unknown }).kind)}`);
}

export class CacheStateMachine {
  readonly #config: CacheConfiguration;
  readonly #banks = new Map<string, CacheBank>();
  readonly #traceIds = new Set<string>();
  readonly #addressLimit: bigint;

  constructor(config: CacheConfiguration) {
    validateConfiguration(config);
    this.#config = config;
    this.#addressLimit = 1n << BigInt(config.addressBits);
    for (const core of [0, 1] as const) {
      for (const cache of CACHE_KINDS) {
        const key = bankKey(core, cache, config.topology[cache]);
        if (!this.#banks.has(key)) this.#banks.set(key, createBank(this.#geometry(cache)));
      }
    }
  }

  #geometry(cache: CacheKind): CacheGeometry {
    return cache === "instruction" ? this.#config.instruction : this.#config.data;
  }

  #bank(core: CoreId, cache: CacheKind): CacheBank {
    return this.#banks.get(bankKey(core, cache, this.#config.topology[cache]))!;
  }

  #validateRange(address: unknown, bytes: unknown, path: string): { address: bigint; bytes: number } {
    if (typeof address !== "bigint" || address < 0n) throw new Error(`${path}.address must be a non-negative bigint`);
    const byteCount = requirePositiveSafeInteger(bytes, `${path}.bytes`);
    const end = address + BigInt(byteCount);
    if (end > this.#addressLimit) {
      throw new Error(`${path} exceeds the configured ${this.#config.addressBits}-bit address space`);
    }
    return { address, bytes: byteCount };
  }

  #segments(trace: CacheAccessTrace, geometry: CacheGeometry): readonly AccessSegment[] {
    const { address, bytes } = this.#validateRange(trace.address, trace.bytes, `trace ${trace.id}`);
    const lineSize = BigInt(geometry.lineSizeBytes);
    const segments: AccessSegment[] = [];
    let cursor = address;
    let remaining = bytes;
    while (remaining > 0) {
      const lineAddress = cursor - (cursor % lineSize);
      const offset = cursor - lineAddress;
      const available = geometry.lineSizeBytes - Number(offset);
      const segmentBytes = Math.min(remaining, available);
      segments.push({
        index: segments.length,
        address: cursor,
        bytes: segmentBytes,
        lineAddress,
      });
      cursor += BigInt(segmentBytes);
      remaining -= segmentBytes;
    }
    return Object.freeze(segments);
  }

  #setAndTag(lineAddress: bigint, geometry: CacheGeometry): { setIndex: number; tag: bigint } {
    const lineNumber = lineAddress / BigInt(geometry.lineSizeBytes);
    return {
      setIndex: Number(lineNumber % BigInt(geometry.sets)),
      tag: lineNumber / BigInt(geometry.sets),
    };
  }

  #touch(bank: CacheBank, line: CacheLine): void {
    bank.useSequence += 1n;
    line.lastUsed = bank.useSequence;
  }

  #victimWay(bank: CacheBank, geometry: CacheGeometry, setIndex: number): number {
    const ways = bank.sets[setIndex]!;
    const invalid = ways.findIndex((line) => !line.valid);
    if (invalid >= 0) {
      if (geometry.replacement === "round-robin") {
        bank.nextRoundRobinWay[setIndex] = (invalid + 1) % geometry.ways;
      }
      return invalid;
    }
    if (geometry.replacement === "round-robin") {
      const victim = bank.nextRoundRobinWay[setIndex]!;
      bank.nextRoundRobinWay[setIndex] = (victim + 1) % geometry.ways;
      return victim;
    }
    let victim = 0;
    for (let way = 1; way < ways.length; way += 1) {
      if (ways[way]!.lastUsed < ways[victim]!.lastUsed) victim = way;
    }
    return victim;
  }

  #emit(
    emissions: CacheEmission[],
    trace: CacheTrace,
    cache: CacheKind,
    kind: CacheEmissionKind,
    segmentIndex: number | null,
    address: bigint | null,
    bytes: number | null,
    lineAddress: bigint | null,
    cost: CacheLatency,
    event: ExecutionEventWithoutTiming,
  ): CacheEmission {
    const eventId = `cache:${trace.id}:${emissions.length}:${kind}`;
    const completeEvent = {
      ...event,
      id: eventId,
      latency: toExecutionLatency(cost),
    } as ExecutionEvent;
    const emission = Object.freeze({
      kind,
      traceId: trace.id,
      segmentIndex,
      core: trace.core,
      cache,
      address,
      bytes,
      lineAddress,
      cost,
      event: completeEvent,
    });
    emissions.push(emission);
    return emission;
  }

  #hitCost(kind: CacheAccessTrace["kind"]): CacheLatency {
    switch (kind) {
      case "instruction-fetch":
      case "literal-load":
        return this.#config.costs.hit.instructionFetch;
      case "load":
        return this.#config.costs.hit.load;
      case "store":
        return this.#config.costs.hit.store;
      default:
        return assertNever(kind);
    }
  }

  #uncachedCost(kind: CacheAccessTrace["kind"]): CacheLatency {
    switch (kind) {
      case "instruction-fetch":
      case "literal-load":
        return this.#config.costs.uncached.instructionFetch;
      case "load":
        return this.#config.costs.uncached.load;
      case "store":
        return this.#config.costs.uncached.store;
      default:
        return assertNever(kind);
    }
  }

  #sramCost(kind: CacheAccessTrace["kind"]): CacheLatency {
    switch (kind) {
      case "instruction-fetch":
      case "literal-load":
        return this.#config.costs.sram.instructionFetch;
      case "load":
        return this.#config.costs.sram.load;
      case "store":
        return this.#config.costs.sram.store;
      default:
        return assertNever(kind);
    }
  }

  #lineFillCost(cache: CacheKind, memory: "flash" | "psram"): CacheLatency {
    const cost = this.#config.costs.lineFill;
    return isCacheLatency(cost) ? cost : cost[cache][memory];
  }

  #memoryEvent(
    trace: CacheAccessTrace,
    memory: MemoryRegion,
    bytes: number,
  ): ExecutionEventWithoutTiming {
    return { kind: trace.kind, core: trace.core, memory, bytes };
  }

  #writeback(
    emissions: CacheEmission[],
    trace: CacheTrace,
    cache: CacheKind,
    line: CacheLine,
  ): void {
    const geometry = this.#geometry(cache);
    if (line.memory === null) throw new Error("internal error: dirty cache line has no backing memory");
    this.#emit(
      emissions,
      trace,
      cache,
      "dirty-writeback",
      null,
      line.lineAddress,
      geometry.lineSizeBytes,
      line.lineAddress,
      this.#config.costs.dirtyWriteback,
      {
        kind: "store",
        core: trace.core,
        memory: line.memory,
        bytes: geometry.lineSizeBytes,
      },
    );
    line.dirty = false;
  }

  #processAccess(trace: CacheAccessTrace): readonly CacheEmission[] {
    if (trace.core !== 0 && trace.core !== 1) throw new Error(`trace ${trace.id}.core must be 0 or 1`);
    validateMemory(trace.memory, `trace ${trace.id}.memory`);
    if (trace.kind === "store" && trace.memory === "flash") {
      throw new Error(`trace ${trace.id} cannot store to memory-mapped flash`);
    }
    if (trace.cacheability !== "cached" && trace.cacheability !== "uncached") {
      throw new Error(`trace ${trace.id}.cacheability must be cached or uncached`);
    }
    const cache = cacheForAccess(trace);
    const geometry = this.#geometry(cache);
    const bank = this.#bank(trace.core, cache);
    const emissions: CacheEmission[] = [];

    if (trace.memory === "sram") {
      const { address, bytes } = this.#validateRange(trace.address, trace.bytes, `trace ${trace.id}`);
      this.#emit(
        emissions,
        trace,
        cache,
        "sram-bypass",
        0,
        address,
        bytes,
        null,
        this.#sramCost(trace.kind),
        this.#memoryEvent(trace, "sram", bytes),
      );
      return Object.freeze(emissions);
    }

    for (const segment of this.#segments(trace, geometry)) {
      if (trace.cacheability === "uncached") {
        const cost = this.#uncachedCost(trace.kind);
        this.#emit(
          emissions,
          trace,
          cache,
          "uncached",
          segment.index,
          segment.address,
          segment.bytes,
          segment.lineAddress,
          cost,
          this.#memoryEvent(trace, trace.memory, segment.bytes),
        );
        continue;
      }

      const { setIndex, tag } = this.#setAndTag(segment.lineAddress, geometry);
      const ways = bank.sets[setIndex]!;
      let way = ways.findIndex(
        (line) => line.valid && line.memory === trace.memory && line.tag === tag,
      );
      if (
        way < 0 &&
        trace.kind === "store" &&
        !this.#config.data.allocateOnStoreMiss
      ) {
        const bypassKind =
          this.#config.data.writePolicy === "write-through" ? "write-through" : "uncached";
        const bypassCost =
          this.#config.data.writePolicy === "write-through"
            ? this.#config.costs.writeThrough
            : this.#config.costs.uncached.store;
        this.#emit(
          emissions,
          trace,
          cache,
          bypassKind,
          segment.index,
          segment.address,
          segment.bytes,
          segment.lineAddress,
          bypassCost,
          this.#memoryEvent(trace, trace.memory, segment.bytes),
        );
        continue;
      }

      if (way < 0) {
        way = this.#victimWay(bank, geometry, setIndex);
        const victim = ways[way]!;
        if (victim.valid && victim.dirty) this.#writeback(emissions, trace, cache, victim);
        const fillEvent =
          trace.kind === "instruction-fetch" || trace.kind === "literal-load"
            ? ({
                kind: trace.kind,
                core: trace.core,
                memory: trace.memory,
                bytes: geometry.lineSizeBytes,
              } as const)
            : ({
                kind: "load",
                core: trace.core,
                memory: trace.memory,
                bytes: geometry.lineSizeBytes,
              } as const);
        this.#emit(
          emissions,
          trace,
          cache,
          "line-fill",
          segment.index,
          segment.lineAddress,
          geometry.lineSizeBytes,
          segment.lineAddress,
          this.#lineFillCost(cache, trace.memory),
          fillEvent,
        );
        Object.assign(victim, {
          valid: true,
          dirty: false,
          memory: trace.memory,
          tag,
          lineAddress: segment.lineAddress,
          lastUsed: 0n,
        });
      }

      const line = ways[way]!;
      this.#emit(
        emissions,
        trace,
        cache,
        "hit",
        segment.index,
        segment.address,
        segment.bytes,
        segment.lineAddress,
        this.#hitCost(trace.kind),
        this.#memoryEvent(trace, "sram", segment.bytes),
      );
      this.#touch(bank, line);
      if (trace.kind === "store") {
        if (this.#config.data.writePolicy === "write-back") {
          line.dirty = true;
        } else {
          this.#emit(
            emissions,
            trace,
            cache,
            "write-through",
            segment.index,
            segment.address,
            segment.bytes,
            segment.lineAddress,
            this.#config.costs.writeThrough,
            this.#memoryEvent(trace, trace.memory, segment.bytes),
          );
        }
      }
    }
    return Object.freeze(emissions);
  }

  #rangeMatches(line: CacheLine, geometry: CacheGeometry, scope: CacheMaintenanceTrace["scope"]): boolean {
    if (!line.valid) return false;
    if (scope.kind === "all") return true;
    const end = scope.address + BigInt(scope.bytes);
    const lineEnd = line.lineAddress + BigInt(geometry.lineSizeBytes);
    return line.lineAddress < end && lineEnd > scope.address;
  }

  #processMaintenance(trace: CacheMaintenanceTrace): readonly CacheEmission[] {
    if (trace.core !== 0 && trace.core !== 1) throw new Error(`trace ${trace.id}.core must be 0 or 1`);
    if (trace.cache !== "instruction" && trace.cache !== "data" && trace.cache !== "both") {
      throw new Error(`trace ${trace.id}.cache must be instruction, data, or both`);
    }
    if (typeof trace.scope !== "object" || trace.scope === null) throw new Error(`trace ${trace.id}.scope is required`);
    if (trace.scope.kind === "range") {
      this.#validateRange(trace.scope.address, trace.scope.bytes, `trace ${trace.id}.scope`);
    } else if (trace.scope.kind !== "all") {
      throw new Error(`trace ${trace.id}.scope.kind must be all or range`);
    }

    const caches = trace.cache === "both" ? CACHE_KINDS : [trace.cache];
    const emissions: CacheEmission[] = [];
    for (const cache of caches) {
      const geometry = this.#geometry(cache);
      const bank = this.#bank(trace.core, cache);
      for (const set of bank.sets) {
        for (const line of set) {
          if (!this.#rangeMatches(line, geometry, trace.scope)) continue;
          if (line.dirty) {
            const shouldWriteback =
              trace.kind === "flush" || this.#config.data.dirtyInvalidate === "writeback";
            if (shouldWriteback) this.#writeback(emissions, trace, cache, line);
            else line.dirty = false;
          }
          if (trace.kind === "invalidate") Object.assign(line, emptyLine());
        }
      }
      this.#emit(
        emissions,
        trace,
        cache,
        trace.kind,
        null,
        null,
        null,
        null,
        this.#config.costs.maintenance,
        {
          kind: "cache-op",
          core: trace.core,
          operation: trace.kind === "flush" ? "writeback" : "invalidate",
          backing: "local",
        },
      );
    }
    return Object.freeze(emissions);
  }

  process(trace: CacheTrace): CacheStep {
    if (typeof trace !== "object" || trace === null) throw new Error("cache trace is required");
    requireNonEmpty(trace.id, "trace.id");
    if (this.#traceIds.has(trace.id)) throw new Error(`duplicate trace id ${trace.id}`);

    let emissions: readonly CacheEmission[];
    switch (trace.kind) {
      case "instruction-fetch":
      case "literal-load":
      case "load":
      case "store":
        emissions = this.#processAccess(trace);
        break;
      case "flush":
      case "invalidate":
        emissions = this.#processMaintenance(trace);
        break;
      default:
        return assertNever(trace);
    }
    this.#traceIds.add(trace.id);
    const uncalibratedCostEventIds = emissions
      .filter((emission) => emission.cost.status === "known" && emission.cost.calibration === "uncalibrated")
      .map((emission) => emission.event.id);
    const unknownCostEventIds = emissions
      .filter((emission) => emission.cost.status === "unknown")
      .map((emission) => emission.event.id);
    return Object.freeze({
      traceId: trace.id,
      claim: Object.freeze({
        architectureCalibration: "uncalibrated",
        source: this.#config.metadata.source,
        costCalibration: combineCostCalibration(emissions.map((emission) => emission.cost)),
        uncalibratedCostEventIds: Object.freeze(uncalibratedCostEventIds),
        unknownCostEventIds: Object.freeze(unknownCostEventIds),
      }),
      emissions,
    });
  }
}
