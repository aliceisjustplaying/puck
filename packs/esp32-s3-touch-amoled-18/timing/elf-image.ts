import type { AddressMapConfiguration, AddressRegion } from "./address-map";
import { AddressSpaceResolver } from "./address-map";
import { ESP32_S3_EXTERNAL_WINDOWS } from "./mmu";
import { withEsp32S3MachineMmio } from "./s3-machine";

const ELF_HEADER_BYTES = 52;
const ELF_PROGRAM_HEADER_BYTES = 32;
const ELF_CLASS_32 = 1;
const ELF_DATA_LITTLE_ENDIAN = 1;
const ELF_CURRENT_VERSION = 1;
const ELF_TYPE_EXECUTABLE = 2;
const ELF_MACHINE_XTENSA = 94;
const ELF_PROGRAM_LOAD = 1;
const ELF_FLAG_EXECUTE = 1;
const ELF_FLAG_WRITE = 2;
const ELF_FLAG_READ = 4;

export const ESP32_S3_INTERNAL_RANGES = Object.freeze([
  Object.freeze({
    id: "dram",
    low: 0x3fc8_8000,
    high: 0x3fd0_0000,
    backingId: "esp32-s3-internal-dram",
  }),
  Object.freeze({
    id: "iram",
    low: 0x4037_0000,
    high: 0x403e_0000,
    backingId: "esp32-s3-internal-iram",
  }),
  Object.freeze({
    id: "rtc-slow",
    low: 0x5000_0000,
    high: 0x5000_2000,
    backingId: "esp32-s3-rtc-slow",
  }),
  Object.freeze({
    id: "rtc-fast",
    low: 0x600f_e000,
    high: 0x6010_0000,
    backingId: "esp32-s3-rtc-fast",
  }),
]);

export interface Esp32S3ElfSourceReference {
  readonly path: string;
  readonly symbols: readonly string[];
  readonly url: string;
}

export const ESP32_S3_IDF_V6_0_2_ELF_MEMORY_SOURCES: readonly Esp32S3ElfSourceReference[] =
  Object.freeze([
    Object.freeze({
      path: "components/esp_system/ld/esp32s3/memory.ld.in",
      symbols: Object.freeze([
        "SRAM_IRAM_START",
        "SRAM_DIRAM_I_START",
        "SRAM_DRAM_START",
        "drom0_0_seg",
        "iram0_2_seg",
        "rtc_iram_seg",
        "rtc_slow_seg",
      ]),
      url: "https://github.com/espressif/esp-idf/blob/v6.0.2/components/esp_system/ld/esp32s3/memory.ld.in",
    }),
    Object.freeze({
      path: "components/soc/esp32s3/include/soc/ext_mem_defs.h",
      symbols: Object.freeze([
        "SOC_IRAM0_CACHE_ADDRESS_LOW",
        "SOC_IRAM0_CACHE_ADDRESS_HIGH",
        "SOC_DRAM0_CACHE_ADDRESS_LOW",
        "SOC_DRAM0_CACHE_ADDRESS_HIGH",
      ]),
      url: "https://github.com/espressif/esp-idf/blob/v6.0.2/components/soc/esp32s3/include/soc/ext_mem_defs.h",
    }),
  ]);

export interface Elf32LoadSegment {
  readonly index: number;
  readonly fileOffset: number;
  readonly virtualAddress: number;
  readonly physicalAddress: number;
  readonly fileBytes: number;
  readonly memoryBytes: number;
  readonly flags: number;
  readonly alignment: number;
  readonly data: Uint8Array;
}

export interface Esp32S3ElfImage {
  readonly schemaVersion: 1;
  readonly elfClass: "ELF32";
  readonly byteOrder: "little-endian";
  readonly machine: "Xtensa";
  readonly type: "executable";
  readonly entry: number;
  readonly loadSegments: readonly Elf32LoadSegment[];
}

function requireBounds(
  total: number,
  offset: number,
  bytes: number,
  label: string,
): void {
  if (
    !Number.isSafeInteger(offset) ||
    !Number.isSafeInteger(bytes) ||
    offset < 0 ||
    bytes < 0 ||
    offset > total ||
    bytes > total - offset
  ) {
    throw new Error(`${label} is outside the ELF file`);
  }
}

function addUint32(left: number, right: number, label: string): number {
  const sum = left + right;
  if (!Number.isSafeInteger(sum) || sum > 0x1_0000_0000) {
    throw new Error(`${label} exceeds the 32-bit address space`);
  }
  return sum;
}

/** Parse only the ELF32 little-endian Xtensa executable surface Puck needs. */
export function parseEsp32S3Elf(bytes: Uint8Array): Esp32S3ElfImage {
  if (!(bytes instanceof Uint8Array)) throw new Error("ELF bytes must be a Uint8Array");
  if (bytes.byteLength < ELF_HEADER_BYTES) throw new Error("ELF file is shorter than its 52-byte header");
  if (bytes[0] !== 0x7f || bytes[1] !== 0x45 || bytes[2] !== 0x4c || bytes[3] !== 0x46) {
    throw new Error("ELF magic is missing");
  }
  if (bytes[4] !== ELF_CLASS_32) throw new Error("ELF must be 32-bit");
  if (bytes[5] !== ELF_DATA_LITTLE_ENDIAN) throw new Error("ELF must be little-endian");
  if (bytes[6] !== ELF_CURRENT_VERSION) throw new Error("ELF identification version must be 1");

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint16(16, true) !== ELF_TYPE_EXECUTABLE) throw new Error("ELF must be an executable");
  if (view.getUint16(18, true) !== ELF_MACHINE_XTENSA) throw new Error("ELF machine must be Xtensa");
  if (view.getUint32(20, true) !== ELF_CURRENT_VERSION) throw new Error("ELF header version must be 1");
  const entry = view.getUint32(24, true);
  const programHeaderOffset = view.getUint32(28, true);
  const elfHeaderBytes = view.getUint16(40, true);
  const programHeaderBytes = view.getUint16(42, true);
  const programHeaderCount = view.getUint16(44, true);
  if (elfHeaderBytes !== ELF_HEADER_BYTES) throw new Error("ELF header size must be 52 bytes");
  if (programHeaderBytes !== ELF_PROGRAM_HEADER_BYTES) {
    throw new Error("ELF program header size must be 32 bytes");
  }
  if (programHeaderCount === 0) throw new Error("ELF must contain at least one program header");
  requireBounds(
    bytes.byteLength,
    programHeaderOffset,
    programHeaderBytes * programHeaderCount,
    "ELF program header table",
  );

  const loadSegments: Elf32LoadSegment[] = [];
  for (let index = 0; index < programHeaderCount; index += 1) {
    const offset = programHeaderOffset + index * programHeaderBytes;
    if (view.getUint32(offset, true) !== ELF_PROGRAM_LOAD) continue;
    const fileOffset = view.getUint32(offset + 4, true);
    const virtualAddress = view.getUint32(offset + 8, true);
    const physicalAddress = view.getUint32(offset + 12, true);
    const fileBytes = view.getUint32(offset + 16, true);
    const memoryBytes = view.getUint32(offset + 20, true);
    const flags = view.getUint32(offset + 24, true);
    const alignment = view.getUint32(offset + 28, true);
    if (memoryBytes < fileBytes) {
      throw new Error(`ELF load segment ${index} has file bytes larger than memory bytes`);
    }
    requireBounds(bytes.byteLength, fileOffset, fileBytes, `ELF load segment ${index}`);
    addUint32(virtualAddress, memoryBytes, `ELF load segment ${index}`);
    loadSegments.push(Object.freeze({
      index,
      fileOffset,
      virtualAddress,
      physicalAddress,
      fileBytes,
      memoryBytes,
      flags,
      alignment,
      data: Uint8Array.from(bytes.subarray(fileOffset, fileOffset + fileBytes)),
    }));
  }
  if (loadSegments.length === 0) throw new Error("ELF has no loadable segments");
  if (!loadSegments.some((segment) =>
    entry >= segment.virtualAddress && entry < segment.virtualAddress + segment.memoryBytes
  )) {
    throw new Error(`ELF entry 0x${entry.toString(16)} is outside every loadable segment`);
  }

  return Object.freeze({
    schemaVersion: 1,
    elfClass: "ELF32",
    byteOrder: "little-endian",
    machine: "Xtensa",
    type: "executable",
    entry,
    loadSegments: Object.freeze(loadSegments),
  });
}

function isInside(address: number, bytes: number, low: number, high: number): boolean {
  return address >= low && address + bytes <= high;
}

function isExternalWindow(address: number, bytes: number): boolean {
  const start = BigInt(address);
  const end = start + BigInt(bytes);
  return (
    (start >= ESP32_S3_EXTERNAL_WINDOWS.irom.low && end <= ESP32_S3_EXTERNAL_WINDOWS.irom.high) ||
    (start >= ESP32_S3_EXTERNAL_WINDOWS.drom.low && end <= ESP32_S3_EXTERNAL_WINDOWS.drom.high)
  );
}

/**
 * Adapt internal ELF load segments to address regions. External IROM and DROM
 * remain owned by the explicit MMU snapshot and are never inferred from ELF
 * file offsets or virtual addresses.
 */
export function esp32S3ElfInternalRegions(image: Esp32S3ElfImage): readonly AddressRegion[] {
  if (typeof image !== "object" || image === null || image.schemaVersion !== 1) {
    throw new Error("ESP32-S3 ELF image schemaVersion must be 1");
  }
  const regions: AddressRegion[] = [];
  for (const segment of image.loadSegments) {
    if (segment.memoryBytes === 0 || isExternalWindow(segment.virtualAddress, segment.memoryBytes)) continue;
    const range = ESP32_S3_INTERNAL_RANGES.find((candidate) =>
      isInside(segment.virtualAddress, segment.memoryBytes, candidate.low, candidate.high)
    );
    if (!range) {
      throw new Error(
        `ELF load segment ${segment.index} at 0x${segment.virtualAddress.toString(16)} is outside the sourced ESP32-S3 internal and external ranges`,
      );
    }
    regions.push(Object.freeze({
      id: `elf:load:${segment.index}:${range.id}`,
      base: BigInt(segment.virtualAddress),
      size: BigInt(segment.memoryBytes),
      kind: "sram",
      permissions: Object.freeze({
        read: (segment.flags & ELF_FLAG_READ) !== 0,
        write: (segment.flags & ELF_FLAG_WRITE) !== 0,
        execute: (segment.flags & ELF_FLAG_EXECUTE) !== 0,
      }),
      cacheability: "uncached",
      physical: Object.freeze({ backingId: range.backingId, offset: BigInt(segment.virtualAddress - range.low) }),
    }));
  }
  return Object.freeze(regions);
}

/** Compose internal ELF segments, an optional explicit MMU map, and boot MMIO. */
export function esp32S3ElfAddressMap(
  image: Esp32S3ElfImage,
  external?: AddressMapConfiguration,
): AddressMapConfiguration {
  const internal = esp32S3ElfInternalRegions(image);
  const base: AddressMapConfiguration = Object.freeze({
    addressBits: 32,
    metadata: Object.freeze({
      architectureCalibration: "uncalibrated",
      source: external
        ? `${external.metadata.source}; ESP-IDF v6.0.2 ELF internal memory`
        : "ESP-IDF v6.0.2 ELF internal memory",
    }),
    regions: Object.freeze([...(external?.regions ?? []), ...internal]),
  });
  const result = withEsp32S3MachineMmio(base);
  new AddressSpaceResolver(result);
  return result;
}
