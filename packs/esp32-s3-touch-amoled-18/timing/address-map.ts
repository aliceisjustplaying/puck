import type { CacheAccessTrace } from "./cache";
import type { CoreId, EventLatency, MemoryRegion, MmioEvent } from "./execution";

export type AddressRegionKind = MemoryRegion | "mmio";
export type AccessKind = "instruction-fetch" | "literal-load" | "load" | "store";

export interface AddressRegion {
  readonly id: string;
  readonly base: bigint;
  readonly size: bigint;
  readonly kind: AddressRegionKind;
  readonly permissions: Readonly<{
    read: boolean;
    write: boolean;
    execute: boolean;
  }>;
  readonly cacheability: "cached" | "uncached";
  readonly physical: Readonly<{
    backingId: string;
    offset: bigint;
  }>;
  readonly peripheral?: string;
}

export interface AddressMapConfiguration {
  readonly addressBits: number;
  readonly metadata: Readonly<{
    architectureCalibration: "uncalibrated";
    source: string;
  }>;
  readonly regions: readonly AddressRegion[];
}

export interface VirtualMemoryAccess {
  readonly id: string;
  readonly kind: AccessKind;
  readonly core: CoreId;
  readonly address: bigint;
  readonly bytes: number;
}

export interface ResolvedAddressSegment {
  readonly index: number;
  readonly virtualAddress: bigint;
  readonly bytes: number;
  readonly regionId: string;
  readonly kind: AddressRegionKind;
  readonly cacheability: "cached" | "uncached";
  readonly physicalBackingId: string;
  readonly physicalOffset: bigint;
  readonly peripheral: string | null;
}

export type AddressFaultKind = "address-overflow" | "unmapped" | "permission";

export interface AddressFault {
  readonly kind: AddressFaultKind;
  readonly accessId: string;
  readonly operation: AccessKind;
  readonly atAddress: bigint;
  readonly regionId: string | null;
  readonly reason: string;
}

interface ResolutionBase {
  readonly access: VirtualMemoryAccess;
  readonly claim: Readonly<{
    architectureCalibration: "uncalibrated";
    source: string;
  }>;
}

export interface ResolvedMemoryAccess extends ResolutionBase {
  readonly status: "resolved";
  readonly segments: readonly ResolvedAddressSegment[];
}

export interface FaultedMemoryAccess extends ResolutionBase {
  readonly status: "fault";
  readonly segments: readonly [];
  readonly fault: AddressFault;
}

export type AddressResolution = ResolvedMemoryAccess | FaultedMemoryAccess;

export interface AddressAdapterOptions {
  readonly mmioLatency?: (
    segment: ResolvedAddressSegment,
    access: VirtualMemoryAccess,
  ) => EventLatency;
}

export type AdaptedAddressSegment =
  | Readonly<{
      kind: "cache";
      resolved: ResolvedAddressSegment;
      trace: CacheAccessTrace;
    }>
  | Readonly<{
      kind: "mmio";
      resolved: ResolvedAddressSegment;
      event: MmioEvent;
    }>;

export type AdaptedAddressResolution =
  | Readonly<{
      status: "fault";
      fault: AddressFault;
      outputs: readonly [];
    }>
  | Readonly<{
      status: "resolved";
      outputs: readonly AdaptedAddressSegment[];
    }>;

interface NormalizedRegion extends AddressRegion {
  readonly end: bigint;
  readonly physicalEnd: bigint;
}

function requireNonEmpty(value: unknown, path: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${path} must be a non-empty string`);
  return value;
}

function positiveSafeInteger(value: unknown, path: string): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    throw new Error(`${path} must be a positive safe integer`);
  }
  return value as number;
}

function validateKind(value: unknown, path: string): asserts value is AddressRegionKind {
  if (value !== "sram" && value !== "psram" && value !== "flash" && value !== "mmio") {
    throw new Error(`${path} must be sram, psram, flash, or mmio`);
  }
}

function validateCacheability(value: unknown, path: string): asserts value is "cached" | "uncached" {
  if (value !== "cached" && value !== "uncached") {
    throw new Error(`${path} must be cached or uncached`);
  }
}

function validatePermission(value: unknown, path: string): asserts value is boolean {
  if (typeof value !== "boolean") throw new Error(`${path} must be a boolean`);
}

function operationPermission(kind: AccessKind): "read" | "write" | "execute" {
  switch (kind) {
    case "instruction-fetch":
    case "literal-load":
      return "execute";
    case "load":
      return "read";
    case "store":
      return "write";
  }
}

function validateAccessKind(value: unknown, path: string): asserts value is AccessKind {
  if (
    value !== "instruction-fetch" &&
    value !== "literal-load" &&
    value !== "load" &&
    value !== "store"
  ) {
    throw new Error(`${path} must be instruction-fetch, literal-load, load, or store`);
  }
}

function compareRegion(left: NormalizedRegion, right: NormalizedRegion): number {
  if (left.base !== right.base) return left.base < right.base ? -1 : 1;
  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
}

function validateLatency(value: unknown): asserts value is EventLatency {
  if (typeof value !== "object" || value === null) {
    throw new Error("mmioLatency must return an explicit known or unknown latency");
  }
  const latency = value as Partial<EventLatency>;
  if (latency.status === "known") {
    if (typeof latency.cycles !== "bigint" || latency.cycles < 0n) {
      throw new Error("mmioLatency known cycles must be a non-negative bigint");
    }
    if (latency.calibration !== "calibrated" && latency.calibration !== "uncalibrated") {
      throw new Error("mmioLatency calibration must be calibrated or uncalibrated");
    }
    requireNonEmpty(latency.source, "mmioLatency.source");
    return;
  }
  if (latency.status === "unknown") {
    requireNonEmpty(latency.reason, "mmioLatency.reason");
    return;
  }
  throw new Error("mmioLatency must return an explicit known or unknown latency");
}

export class AddressSpaceResolver {
  readonly #regions: readonly NormalizedRegion[];
  readonly #addressLimit: bigint;
  readonly #claim: ResolutionBase["claim"];

  constructor(config: AddressMapConfiguration) {
    if (typeof config !== "object" || config === null) throw new Error("address map configuration is required");
    const addressBits = positiveSafeInteger(config.addressBits, "config.addressBits");
    if (addressBits > 64) throw new Error("config.addressBits must not exceed 64");
    this.#addressLimit = 1n << BigInt(addressBits);
    if (typeof config.metadata !== "object" || config.metadata === null) {
      throw new Error("config.metadata is required");
    }
    if (config.metadata.architectureCalibration !== "uncalibrated") {
      throw new Error("config.metadata.architectureCalibration must remain uncalibrated");
    }
    const source = requireNonEmpty(config.metadata.source, "config.metadata.source");
    if (!Array.isArray(config.regions) || config.regions.length === 0) {
      throw new Error("config.regions must contain at least one explicit region");
    }

    const ids = new Set<string>();
    const normalized = config.regions.map((region, index): NormalizedRegion => {
      if (typeof region !== "object" || region === null) throw new Error(`config.regions[${index}] must be an object`);
      const id = requireNonEmpty(region.id, `config.regions[${index}].id`);
      if (ids.has(id)) throw new Error(`duplicate address region id ${id}`);
      ids.add(id);
      if (typeof region.base !== "bigint" || region.base < 0n) {
        throw new Error(`config.regions[${index}].base must be a non-negative bigint`);
      }
      if (typeof region.size !== "bigint" || region.size <= 0n) {
        throw new Error(`config.regions[${index}].size must be a positive bigint`);
      }
      const end = region.base + region.size;
      if (end > this.#addressLimit) {
        throw new Error(`config.regions[${index}] exceeds the configured ${addressBits}-bit address space`);
      }
      validateKind(region.kind, `config.regions[${index}].kind`);
      validateCacheability(region.cacheability, `config.regions[${index}].cacheability`);
      if (typeof region.permissions !== "object" || region.permissions === null) {
        throw new Error(`config.regions[${index}].permissions is required`);
      }
      validatePermission(region.permissions.read, `config.regions[${index}].permissions.read`);
      validatePermission(region.permissions.write, `config.regions[${index}].permissions.write`);
      validatePermission(region.permissions.execute, `config.regions[${index}].permissions.execute`);
      if (typeof region.physical !== "object" || region.physical === null) {
        throw new Error(`config.regions[${index}].physical is required`);
      }
      const backingId = requireNonEmpty(
        region.physical.backingId,
        `config.regions[${index}].physical.backingId`,
      );
      if (typeof region.physical.offset !== "bigint" || region.physical.offset < 0n) {
        throw new Error(`config.regions[${index}].physical.offset must be a non-negative bigint`);
      }
      const physicalEnd = region.physical.offset + region.size;
      if (physicalEnd > this.#addressLimit) {
        throw new Error(`config.regions[${index}] physical range exceeds ${addressBits} bits`);
      }

      let peripheral: string | undefined;
      if (region.kind === "mmio") {
        peripheral = requireNonEmpty(region.peripheral, `config.regions[${index}].peripheral`);
        if (region.cacheability !== "uncached") throw new Error(`MMIO region ${id} must be uncached`);
        if (region.permissions.execute) throw new Error(`MMIO region ${id} cannot be executable`);
      } else if (region.peripheral !== undefined) {
        throw new Error(`non-MMIO region ${id} cannot declare a peripheral`);
      }

      return Object.freeze({
        id,
        base: region.base,
        size: region.size,
        end,
        kind: region.kind,
        permissions: Object.freeze({ ...region.permissions }),
        cacheability: region.cacheability,
        physical: Object.freeze({ backingId, offset: region.physical.offset }),
        physicalEnd,
        ...(peripheral === undefined ? {} : { peripheral }),
      });
    });
    normalized.sort(compareRegion);
    for (let index = 1; index < normalized.length; index += 1) {
      const previous = normalized[index - 1]!;
      const current = normalized[index]!;
      if (current.base < previous.end) {
        throw new Error(`address regions ${previous.id} and ${current.id} overlap`);
      }
    }
    this.#regions = Object.freeze(normalized);
    this.#claim = Object.freeze({ architectureCalibration: "uncalibrated", source });
  }

  #fault(access: VirtualMemoryAccess, fault: Omit<AddressFault, "accessId" | "operation">): FaultedMemoryAccess {
    return Object.freeze({
      status: "fault",
      access,
      claim: this.#claim,
      segments: Object.freeze([]) as readonly [],
      fault: Object.freeze({
        ...fault,
        accessId: access.id,
        operation: access.kind,
      }),
    });
  }

  #regionAt(address: bigint): NormalizedRegion | undefined {
    return this.#regions.find((region) => address >= region.base && address < region.end);
  }

  /**
   * Resolve the full half-open access range before exposing any segment.
   * Adjacent permitted regions split in ascending address order. Any overflow,
   * gap, or permission failure returns one fault and an empty segment list.
   */
  resolve(access: VirtualMemoryAccess): AddressResolution {
    if (typeof access !== "object" || access === null) throw new Error("virtual memory access is required");
    requireNonEmpty(access.id, "access.id");
    validateAccessKind(access.kind, "access.kind");
    if (access.core !== 0 && access.core !== 1) throw new Error("access.core must be 0 or 1");
    if (typeof access.address !== "bigint" || access.address < 0n) {
      throw new Error("access.address must be a non-negative bigint");
    }
    const bytes = positiveSafeInteger(access.bytes, "access.bytes");
    const end = access.address + BigInt(bytes);
    if (access.address >= this.#addressLimit || end > this.#addressLimit) {
      return this.#fault(access, {
        kind: "address-overflow",
        atAddress: access.address >= this.#addressLimit ? access.address : this.#addressLimit,
        regionId: null,
        reason: `access exceeds the configured address width`,
      });
    }

    const permission = operationPermission(access.kind);
    const segments: ResolvedAddressSegment[] = [];
    let cursor = access.address;
    while (cursor < end) {
      const region = this.#regionAt(cursor);
      if (!region) {
        return this.#fault(access, {
          kind: "unmapped",
          atAddress: cursor,
          regionId: null,
          reason: `address ${cursor} is not mapped`,
        });
      }
      if (!region.permissions[permission]) {
        return this.#fault(access, {
          kind: "permission",
          atAddress: cursor,
          regionId: region.id,
          reason: `${access.kind} lacks ${permission} permission in ${region.id}`,
        });
      }
      const segmentEnd = region.end < end ? region.end : end;
      const segmentBytes = Number(segmentEnd - cursor);
      segments.push(
        Object.freeze({
          index: segments.length,
          virtualAddress: cursor,
          bytes: segmentBytes,
          regionId: region.id,
          kind: region.kind,
          cacheability: region.cacheability,
          physicalBackingId: region.physical.backingId,
          physicalOffset: region.physical.offset + (cursor - region.base),
          peripheral: region.peripheral ?? null,
        }),
      );
      cursor = segmentEnd;
    }
    return Object.freeze({
      status: "resolved",
      access,
      claim: this.#claim,
      segments: Object.freeze(segments),
    });
  }
}

export function adaptAddressResolution(
  resolution: AddressResolution,
  options: AddressAdapterOptions = {},
): AdaptedAddressResolution {
  if (resolution.status === "fault") {
    return Object.freeze({ status: "fault", fault: resolution.fault, outputs: Object.freeze([]) as readonly [] });
  }
  const outputs = resolution.segments.map((segment): AdaptedAddressSegment => {
    const id = `${resolution.access.id}:segment:${segment.index}`;
    if (segment.kind !== "mmio") {
      const trace: CacheAccessTrace = Object.freeze({
        id: `${id}:cache`,
        kind: resolution.access.kind,
        core: resolution.access.core,
        memory: segment.kind,
        address: segment.physicalOffset,
        bytes: segment.bytes,
        cacheability: segment.cacheability,
      });
      return Object.freeze({ kind: "cache", resolved: segment, trace });
    }
    if (resolution.access.kind === "instruction-fetch") {
      throw new Error("resolved MMIO instruction fetch cannot be adapted");
    }
    if (!options.mmioLatency) throw new Error("mmioLatency is required to adapt MMIO without inventing a cost");
    const latency = options.mmioLatency(segment, resolution.access);
    validateLatency(latency);
    const event: MmioEvent = Object.freeze({
      id: `${id}:mmio`,
      kind: "mmio",
      core: resolution.access.core,
      peripheral: segment.peripheral!,
      operation: resolution.access.kind === "load" ? "read" : "write",
      bytes: segment.bytes,
      latency,
    });
    return Object.freeze({ kind: "mmio", resolved: segment, event });
  });
  return Object.freeze({ status: "resolved", outputs: Object.freeze(outputs) });
}
