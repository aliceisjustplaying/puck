import { describe, expect, test } from "bun:test";
import { AddressSpaceResolver } from "./address-map";
import {
  ESP32_S3_IDF_V6_0_2_ELF_MEMORY_SOURCES,
  esp32S3ElfAddressMap,
  esp32S3ElfInternalRegions,
  parseEsp32S3Elf,
} from "./elf-image";

interface FixtureSegment {
  type?: number;
  offset: number;
  virtualAddress: number;
  fileBytes: number;
  memoryBytes: number;
  flags: number;
}

function elfFixture(
  segments: readonly FixtureSegment[],
  entry = 0x4037_4000,
): Uint8Array {
  const bytes = new Uint8Array(0x400);
  bytes.set([0x7f, 0x45, 0x4c, 0x46, 1, 1, 1], 0);
  const view = new DataView(bytes.buffer);
  view.setUint16(16, 2, true);
  view.setUint16(18, 94, true);
  view.setUint32(20, 1, true);
  view.setUint32(24, entry, true);
  view.setUint32(28, 52, true);
  view.setUint16(40, 52, true);
  view.setUint16(42, 32, true);
  view.setUint16(44, segments.length, true);
  for (const [index, segment] of segments.entries()) {
    const header = 52 + index * 32;
    view.setUint32(header, segment.type ?? 1, true);
    view.setUint32(header + 4, segment.offset, true);
    view.setUint32(header + 8, segment.virtualAddress, true);
    view.setUint32(header + 12, segment.virtualAddress, true);
    view.setUint32(header + 16, segment.fileBytes, true);
    view.setUint32(header + 20, segment.memoryBytes, true);
    view.setUint32(header + 24, segment.flags, true);
    view.setUint32(header + 28, 0x1000, true);
    for (let byte = 0; byte < segment.fileBytes; byte += 1) {
      bytes[segment.offset + byte] = (index * 16 + byte) & 0xff;
    }
  }
  return bytes;
}

const VALID_SEGMENTS: readonly FixtureSegment[] = [
  {
    offset: 0x200,
    virtualAddress: 0x4037_4000,
    fileBytes: 8,
    memoryBytes: 0x100,
    flags: 7,
  },
  {
    offset: 0x220,
    virtualAddress: 0x3fc8_8000,
    fileBytes: 4,
    memoryBytes: 0x80,
    flags: 6,
  },
  {
    offset: 0x240,
    virtualAddress: 0x4200_0020,
    fileBytes: 4,
    memoryBytes: 0x40,
    flags: 5,
  },
  {
    type: 7,
    offset: 0x260,
    virtualAddress: 0x3c02_1000,
    fileBytes: 4,
    memoryBytes: 4,
    flags: 4,
  },
];

describe("ELF32 Xtensa loading boundary", () => {
  test("parses loadable segments without treating TLS or other headers as loads", () => {
    const image = parseEsp32S3Elf(elfFixture(VALID_SEGMENTS));
    expect(image).toMatchObject({
      schemaVersion: 1,
      elfClass: "ELF32",
      byteOrder: "little-endian",
      machine: "Xtensa",
      type: "executable",
      entry: 0x4037_4000,
    });
    expect(image.loadSegments).toHaveLength(3);
    expect(image.loadSegments.map((segment) => ({
      index: segment.index,
      address: segment.virtualAddress,
      fileBytes: segment.fileBytes,
      memoryBytes: segment.memoryBytes,
      data: [...segment.data],
    }))).toEqual([
      {
        index: 0,
        address: 0x4037_4000,
        fileBytes: 8,
        memoryBytes: 0x100,
        data: [0, 1, 2, 3, 4, 5, 6, 7],
      },
      {
        index: 1,
        address: 0x3fc8_8000,
        fileBytes: 4,
        memoryBytes: 0x80,
        data: [16, 17, 18, 19],
      },
      {
        index: 2,
        address: 0x4200_0020,
        fileBytes: 4,
        memoryBytes: 0x40,
        data: [32, 33, 34, 35],
      },
    ]);
  });

  test("maps internal load segments and leaves external IROM to the explicit MMU", () => {
    const image = parseEsp32S3Elf(elfFixture(VALID_SEGMENTS));
    expect(esp32S3ElfInternalRegions(image)).toEqual([
      expect.objectContaining({
        id: "elf:load:0:iram",
        base: 0x4037_4000n,
        size: 0x100n,
        kind: "sram",
        permissions: { read: true, write: true, execute: true },
      }),
      expect.objectContaining({
        id: "elf:load:1:dram",
        base: 0x3fc8_8000n,
        size: 0x80n,
        permissions: { read: true, write: true, execute: false },
      }),
    ]);
  });

  test("composes the ELF entry and boot MMIO with the address resolver", () => {
    const image = parseEsp32S3Elf(elfFixture(VALID_SEGMENTS));
    const resolver = new AddressSpaceResolver(esp32S3ElfAddressMap(image));
    expect(resolver.resolve({
      id: "entry-fetch",
      core: 0,
      kind: "instruction-fetch",
      address: BigInt(image.entry),
      bytes: 3,
    })).toMatchObject({ status: "resolved", segments: [{ regionId: "elf:load:0:iram" }] });
    expect(resolver.resolve({
      id: "unknown-peripheral",
      core: 0,
      kind: "load",
      address: 0x6000_0000n,
      bytes: 4,
    })).toMatchObject({ status: "fault", fault: { kind: "unmapped" } });
  });

  test("refuses malformed, wrong-target, overflowing, and unsourced segments", () => {
    const wrongMachine = elfFixture(VALID_SEGMENTS);
    new DataView(wrongMachine.buffer).setUint16(18, 243, true);
    expect(() => parseEsp32S3Elf(wrongMachine)).toThrow("ELF machine must be Xtensa");

    const tooMuchFile = elfFixture(VALID_SEGMENTS);
    new DataView(tooMuchFile.buffer).setUint32(52 + 16, 0x200, true);
    new DataView(tooMuchFile.buffer).setUint32(52 + 20, 0x100, true);
    expect(() => parseEsp32S3Elf(tooMuchFile)).toThrow("file bytes larger than memory bytes");

    const outside = parseEsp32S3Elf(elfFixture([
      { offset: 0x200, virtualAddress: 0x2000_0000, fileBytes: 4, memoryBytes: 4, flags: 5 },
    ], 0x2000_0000));
    expect(() => esp32S3ElfInternalRegions(outside)).toThrow("outside the sourced ESP32-S3 internal and external ranges");
  });

  test("pins the official v6.0.2 memory-layout sources", () => {
    expect(ESP32_S3_IDF_V6_0_2_ELF_MEMORY_SOURCES).toEqual([
      expect.objectContaining({
        path: "components/esp_system/ld/esp32s3/memory.ld.in",
        url: "https://github.com/espressif/esp-idf/blob/v6.0.2/components/esp_system/ld/esp32s3/memory.ld.in",
      }),
      expect.objectContaining({
        path: "components/soc/esp32s3/include/soc/ext_mem_defs.h",
      }),
    ]);
  });
});
