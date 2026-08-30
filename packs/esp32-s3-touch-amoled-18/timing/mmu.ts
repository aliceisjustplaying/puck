import type { CacheAccessTrace } from "./cache";
import type { CoreId } from "./execution";

export const ESP32_S3_MMU_PAGE_SIZE_BYTES = 0x1_0000n;
export const ESP32_S3_MMU_ENTRY_COUNT = 512;
export const ESP32_S3_MMU_MAX_PHYSICAL_PAGE_COUNT = 16_384;
export const ESP32_S3_MMU_INVALID_BIT = 0x4000;
export const ESP32_S3_MMU_TARGET_BIT = 0x8000;
export const ESP32_S3_MMU_PHYSICAL_PAGE_MASK = 0x3fff;

export const ESP32_S3_EXTERNAL_WINDOWS = Object.freeze({
  irom: Object.freeze({ low: 0x4200_0000n, high: 0x4400_0000n }),
  drom: Object.freeze({ low: 0x3c00_0000n, high: 0x3e00_0000n }),
});

export interface MmuSourceReference {
  readonly path: string;
  readonly symbols: readonly string[];
}

export interface ExternalMmuMetadata {
  readonly architectureCalibration: "uncalibrated";
  readonly idfVersion: string;
  readonly sources: readonly MmuSourceReference[];
}

export const ESP32_S3_IDF_V6_0_2_MMU_METADATA: ExternalMmuMetadata = Object.freeze({
  architectureCalibration: "uncalibrated",
  idfVersion: "v6.0.2",
  sources: Object.freeze([
    Object.freeze({
      path: "components/soc/esp32s3/include/soc/ext_mem_defs.h",
      symbols: Object.freeze([
        "SOC_IRAM0_CACHE_ADDRESS_LOW",
        "SOC_IRAM0_CACHE_ADDRESS_HIGH",
        "SOC_DRAM0_CACHE_ADDRESS_LOW",
        "SOC_DRAM0_CACHE_ADDRESS_HIGH",
        "SOC_MMU_INVALID",
        "SOC_MMU_TYPE",
        "SOC_MMU_ACCESS_FLASH",
        "SOC_MMU_ACCESS_SPIRAM",
        "SOC_MMU_VALID_VAL_MASK",
        "SOC_MMU_MAX_PADDR_PAGE_NUM",
        "SOC_MMU_VADDR_MASK",
        "SOC_MMU_ENTRY_NUM",
        "SOC_MMU_DBUS_VADDR_BASE",
        "SOC_MMU_IBUS_VADDR_BASE",
        "SOC_MMU_LINEAR_ADDR_MASK",
      ]),
    }),
    Object.freeze({
      path: "components/hal/esp32s3/include/hal/mmu_ll.h",
      symbols: Object.freeze([
        "mmu_ll_vaddr_to_laddr",
        "mmu_ll_laddr_to_vaddr",
        "mmu_ll_get_page_size",
        "mmu_ll_check_valid_ext_vaddr_region",
        "mmu_ll_check_valid_paddr_region",
        "mmu_ll_get_entry_id",
        "mmu_ll_format_paddr",
        "mmu_ll_write_entry",
        "mmu_ll_check_entry_valid",
        "mmu_ll_get_entry_target",
        "mmu_ll_entry_id_to_paddr_base",
      ]),
    }),
    Object.freeze({
      path: "components/hal/include/hal/mmu_types.h",
      symbols: Object.freeze([
        "MMU_PAGE_64KB",
        "MMU_VADDR_DATA",
        "MMU_VADDR_INSTRUCTION",
        "MMU_TARGET_FLASH0",
        "MMU_TARGET_PSRAM0",
      ]),
    }),
  ]),
});

export type ExternalMemoryTarget = "flash" | "psram";
export type ExternalWindow = "irom" | "drom";

export type ExternalMmuEntryConfiguration =
  | Readonly<{
      index: number;
      state: "invalid";
    }>
  | Readonly<{
      index: number;
      state: "mapped";
      target: ExternalMemoryTarget;
      physicalPage: number;
    }>;

export interface ExternalMmuConfiguration {
  readonly metadata: ExternalMmuMetadata;
  readonly entries: readonly ExternalMmuEntryConfiguration[];
}

export interface ExternalMmuAccess {
  readonly id: string;
  readonly kind: "instruction-fetch" | "load" | "store";
  readonly core: CoreId;
  readonly address: bigint;
  readonly bytes: number;
}

export interface ExternalMmuSnapshotEntry {
  readonly index: number;
  readonly state: "invalid" | "mapped";
  readonly target: ExternalMemoryTarget | null;
  readonly physicalPage: number | null;
  readonly rawValue: number;
}

export interface ExternalMmuSnapshot {
  readonly metadata: ExternalMmuMetadata;
  readonly pageSizeBytes: bigint;
  readonly entries: readonly ExternalMmuSnapshotEntry[];
}

export interface ExternalMmuTranslationSegment {
  readonly index: number;
  readonly virtualAddress: bigint;
  readonly bytes: number;
  readonly window: ExternalWindow;
  readonly entryIndex: number;
  readonly target: ExternalMemoryTarget;
  readonly physicalPage: number;
  readonly pageOffset: bigint;
  readonly physicalAddress: bigint;
  readonly rawEntryValue: number;
}

export type ExternalMmuFaultKind =
  | "address-overflow"
  | "outside-window"
  | "invalid-entry"
  | "physical-overflow";

export interface ExternalMmuFault {
  readonly kind: ExternalMmuFaultKind;
  readonly accessId: string;
  readonly atAddress: bigint;
  readonly entryIndex: number | null;
  readonly reason: string;
}

interface ExternalMmuResultBase {
  readonly access: ExternalMmuAccess;
  readonly claim: ExternalMmuMetadata;
}

export interface ExternalMmuTranslatedAccess extends ExternalMmuResultBase {
  readonly status: "translated";
  readonly window: ExternalWindow;
  readonly segments: readonly ExternalMmuTranslationSegment[];
}

export interface ExternalMmuFaultedAccess extends ExternalMmuResultBase {
  readonly status: "fault";
  readonly segments: readonly [];
  readonly fault: ExternalMmuFault;
}

export type ExternalMmuTranslation = ExternalMmuTranslatedAccess | ExternalMmuFaultedAccess;

export type AdaptedExternalMmuTranslation =
  | Readonly<{
      status: "fault";
      fault: ExternalMmuFault;
      traces: readonly [];
    }>
  | Readonly<{
      status: "translated";
      traces: readonly CacheAccessTrace[];
    }>;

function requireNonEmpty(value: unknown, path: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${path} must be a non-empty string`);
  }
  return value;
}

function requirePositiveSafeInteger(value: unknown, path: string): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    throw new Error(`${path} must be a positive safe integer`);
  }
  return value as number;
}

function requireIndex(value: unknown, path: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) >= ESP32_S3_MMU_ENTRY_COUNT) {
    throw new Error(`${path} must be an integer from 0 through ${ESP32_S3_MMU_ENTRY_COUNT - 1}`);
  }
  return value as number;
}

function requirePhysicalPage(value: unknown, path: string): number {
  if (
    !Number.isSafeInteger(value) ||
    (value as number) < 0 ||
    (value as number) >= ESP32_S3_MMU_MAX_PHYSICAL_PAGE_COUNT
  ) {
    throw new Error(
      `${path} must be an integer from 0 through ${ESP32_S3_MMU_MAX_PHYSICAL_PAGE_COUNT - 1}; the physical page would overflow the MMU limit`,
    );
  }
  return value as number;
}

function validateTarget(value: unknown, path: string): asserts value is ExternalMemoryTarget {
  if (value !== "flash" && value !== "psram") {
    throw new Error(`${path} must be flash or psram`);
  }
}

function validateMetadata(metadata: ExternalMmuMetadata): void {
  if (typeof metadata !== "object" || metadata === null) throw new Error("config.metadata is required");
  if (metadata.architectureCalibration !== "uncalibrated") {
    throw new Error("config.metadata.architectureCalibration must remain uncalibrated");
  }
  requireNonEmpty(metadata.idfVersion, "config.metadata.idfVersion");
  if (metadata.idfVersion !== ESP32_S3_IDF_V6_0_2_MMU_METADATA.idfVersion) {
    throw new Error("config.metadata.idfVersion must be v6.0.2 for this MMU definition");
  }
  if (!Array.isArray(metadata.sources) || metadata.sources.length === 0) {
    throw new Error("config.metadata.sources must contain at least one exact source reference");
  }
  for (const [index, source] of metadata.sources.entries()) {
    if (typeof source !== "object" || source === null) {
      throw new Error(`config.metadata.sources[${index}] must be an object`);
    }
    requireNonEmpty(source.path, `config.metadata.sources[${index}].path`);
    if (!Array.isArray(source.symbols) || source.symbols.length === 0) {
      throw new Error(`config.metadata.sources[${index}].symbols must not be empty`);
    }
    for (const [symbolIndex, symbol] of source.symbols.entries()) {
      requireNonEmpty(symbol, `config.metadata.sources[${index}].symbols[${symbolIndex}]`);
    }
  }
  if (metadata.sources.length !== ESP32_S3_IDF_V6_0_2_MMU_METADATA.sources.length) {
    throw new Error("config.metadata.sources must match the pinned ESP-IDF v6.0.2 source set");
  }
  for (const [index, expected] of ESP32_S3_IDF_V6_0_2_MMU_METADATA.sources.entries()) {
    const actual = metadata.sources[index]!;
    if (
      actual.path !== expected.path ||
      actual.symbols.length !== expected.symbols.length ||
      actual.symbols.some(
        (symbol: string, symbolIndex: number) => symbol !== expected.symbols[symbolIndex],
      )
    ) {
      throw new Error("config.metadata.sources must match the pinned ESP-IDF v6.0.2 source set");
    }
  }
}

function rawValue(entry: ExternalMmuEntryConfiguration): number {
  if (entry.state === "invalid") return ESP32_S3_MMU_INVALID_BIT;
  return entry.physicalPage | (entry.target === "psram" ? ESP32_S3_MMU_TARGET_BIT : 0);
}

function expectedWindow(kind: ExternalMmuAccess["kind"]): ExternalWindow {
  return kind === "instruction-fetch" ? "irom" : "drom";
}

function validateAccessKind(value: unknown): asserts value is ExternalMmuAccess["kind"] {
  if (value !== "instruction-fetch" && value !== "load" && value !== "store") {
    throw new Error("access.kind must be instruction-fetch, load, or store");
  }
}

export class Esp32S3ExternalMmu {
  readonly #entries: readonly ExternalMmuSnapshotEntry[];
  readonly #metadata: ExternalMmuMetadata;

  constructor(config: ExternalMmuConfiguration) {
    if (typeof config !== "object" || config === null) throw new Error("MMU configuration is required");
    validateMetadata(config.metadata);
    if (!Array.isArray(config.entries) || config.entries.length !== ESP32_S3_MMU_ENTRY_COUNT) {
      throw new Error(
        `config.entries must explicitly contain all ${ESP32_S3_MMU_ENTRY_COUNT} MMU entries; no reset mappings are assumed`,
      );
    }

    const normalized: ExternalMmuSnapshotEntry[] = [];
    const seen = new Set<number>();
    for (const [configurationIndex, entry] of config.entries.entries()) {
      if (typeof entry !== "object" || entry === null) {
        throw new Error(`config.entries[${configurationIndex}] must be an object`);
      }
      const index = requireIndex(entry.index, `config.entries[${configurationIndex}].index`);
      if (seen.has(index)) throw new Error(`config.entries duplicates MMU entry ${index}`);
      seen.add(index);
      if (entry.state === "invalid") {
        normalized.push(
          Object.freeze({
            index,
            state: "invalid",
            target: null,
            physicalPage: null,
            rawValue: ESP32_S3_MMU_INVALID_BIT,
          }),
        );
        continue;
      }
      if (entry.state !== "mapped") {
        throw new Error(`config.entries[${configurationIndex}].state must be invalid or mapped`);
      }
      validateTarget(entry.target, `config.entries[${configurationIndex}].target`);
      const physicalPage = requirePhysicalPage(
        entry.physicalPage,
        `config.entries[${configurationIndex}].physicalPage`,
      );
      const mapped = Object.freeze({
        index,
        state: "mapped" as const,
        target: entry.target,
        physicalPage,
        rawValue: rawValue({ index, state: "mapped", target: entry.target, physicalPage }),
      });
      normalized.push(mapped);
    }
    normalized.sort((left, right) => left.index - right.index);
    this.#entries = Object.freeze(normalized);
    this.#metadata = ESP32_S3_IDF_V6_0_2_MMU_METADATA;
  }

  snapshot(): ExternalMmuSnapshot {
    return Object.freeze({
      metadata: this.#metadata,
      pageSizeBytes: ESP32_S3_MMU_PAGE_SIZE_BYTES,
      entries: this.#entries,
    });
  }

  #fault(
    access: ExternalMmuAccess,
    fault: Omit<ExternalMmuFault, "accessId">,
  ): ExternalMmuFaultedAccess {
    return Object.freeze({
      status: "fault",
      access,
      claim: this.#metadata,
      segments: Object.freeze([]) as readonly [],
      fault: Object.freeze({ ...fault, accessId: access.id }),
    });
  }

  /** Translate the full access atomically. Any page fault returns no segments. */
  translate(access: ExternalMmuAccess): ExternalMmuTranslation {
    if (typeof access !== "object" || access === null) throw new Error("MMU access is required");
    requireNonEmpty(access.id, "access.id");
    validateAccessKind(access.kind);
    if (access.core !== 0 && access.core !== 1) throw new Error("access.core must be 0 or 1");
    if (typeof access.address !== "bigint" || access.address < 0n) {
      throw new Error("access.address must be a non-negative bigint");
    }
    const bytes = requirePositiveSafeInteger(access.bytes, "access.bytes");
    const end = access.address + BigInt(bytes);
    const addressLimit = 1n << 32n;
    if (access.address >= addressLimit || end > addressLimit) {
      return this.#fault(access, {
        kind: "address-overflow",
        atAddress: access.address >= addressLimit ? access.address : addressLimit,
        entryIndex: null,
        reason: "access exceeds the 32-bit virtual address space",
      });
    }

    const window = expectedWindow(access.kind);
    const bounds = ESP32_S3_EXTERNAL_WINDOWS[window];
    if (access.address < bounds.low || access.address >= bounds.high || end > bounds.high) {
      const atAddress = access.address < bounds.low || access.address >= bounds.high
        ? access.address
        : bounds.high;
      return this.#fault(access, {
        kind: "outside-window",
        atAddress,
        entryIndex: null,
        reason: `${access.kind} is outside the ${window.toUpperCase()} external window`,
      });
    }

    const segments: ExternalMmuTranslationSegment[] = [];
    let cursor = access.address;
    while (cursor < end) {
      const linearAddress = cursor & 0x1ff_ffffn;
      const entryIndex = Number(linearAddress >> 16n);
      const entry = this.#entries[entryIndex]!;
      if (entry.state === "invalid") {
        return this.#fault(access, {
          kind: "invalid-entry",
          atAddress: cursor,
          entryIndex,
          reason: `MMU entry ${entryIndex} is invalid`,
        });
      }
      const pageOffset = linearAddress & (ESP32_S3_MMU_PAGE_SIZE_BYTES - 1n);
      const available = ESP32_S3_MMU_PAGE_SIZE_BYTES - pageOffset;
      const remaining = end - cursor;
      const segmentBytes = Number(available < remaining ? available : remaining);
      const physicalAddress = BigInt(entry.physicalPage!) * ESP32_S3_MMU_PAGE_SIZE_BYTES + pageOffset;
      const physicalEnd = physicalAddress + BigInt(segmentBytes);
      const physicalLimit = BigInt(ESP32_S3_MMU_MAX_PHYSICAL_PAGE_COUNT) * ESP32_S3_MMU_PAGE_SIZE_BYTES;
      if (physicalEnd > physicalLimit) {
        return this.#fault(access, {
          kind: "physical-overflow",
          atAddress: cursor,
          entryIndex,
          reason: `MMU entry ${entryIndex} exceeds the architectural physical address limit`,
        });
      }
      segments.push(
        Object.freeze({
          index: segments.length,
          virtualAddress: cursor,
          bytes: segmentBytes,
          window,
          entryIndex,
          target: entry.target!,
          physicalPage: entry.physicalPage!,
          pageOffset,
          physicalAddress,
          rawEntryValue: entry.rawValue,
        }),
      );
      cursor += BigInt(segmentBytes);
    }
    return Object.freeze({
      status: "translated",
      access,
      claim: this.#metadata,
      window,
      segments: Object.freeze(segments),
    });
  }
}

export function adaptExternalMmuTranslation(
  translation: ExternalMmuTranslation,
): AdaptedExternalMmuTranslation {
  if (translation.status === "fault") {
    return Object.freeze({
      status: "fault",
      fault: translation.fault,
      traces: Object.freeze([]) as readonly [],
    });
  }
  const traces = translation.segments.map((segment): CacheAccessTrace =>
    Object.freeze({
      id: `${translation.access.id}:mmu:${segment.index}:cache`,
      kind: translation.access.kind,
      core: translation.access.core,
      memory: segment.target,
      address: segment.physicalAddress,
      bytes: segment.bytes,
      cacheability: "cached",
    }),
  );
  return Object.freeze({ status: "translated", traces: Object.freeze(traces) });
}
