import { describe, expect, test } from "bun:test";
import {
  ESP32_S3_EXTERNAL_WINDOWS,
  ESP32_S3_IDF_V6_1_MMU_METADATA,
  ESP32_S3_MMU_ENTRY_COUNT,
  ESP32_S3_MMU_INVALID_BIT,
  ESP32_S3_MMU_PAGE_SIZE_BYTES,
  ESP32_S3_MMU_TARGET_BIT,
  Esp32S3ExternalMmu,
  adaptExternalMmuSnapshotToAddressMap,
  adaptExternalMmuTranslation,
  type ExternalMmuAccess,
  type ExternalMmuConfiguration,
  type ExternalMmuEntryConfiguration,
  type ExternalMemoryTarget,
} from "./mmu";

interface Mapping {
  readonly index: number;
  readonly target: ExternalMemoryTarget;
  readonly physicalPage: number;
}

function entries(...mappings: readonly Mapping[]): ExternalMmuEntryConfiguration[] {
  const table: ExternalMmuEntryConfiguration[] = Array.from(
    { length: ESP32_S3_MMU_ENTRY_COUNT },
    (_, index) => ({ index, state: "invalid" as const }),
  );
  for (const mapping of mappings) {
    table[mapping.index] = { ...mapping, state: "mapped" };
  }
  return table;
}

function configuration(table: readonly ExternalMmuEntryConfiguration[]): ExternalMmuConfiguration {
  return {
    metadata: ESP32_S3_IDF_V6_1_MMU_METADATA,
    entries: table,
  };
}

function access(
  id: string,
  kind: ExternalMmuAccess["kind"],
  address: bigint,
  bytes = 4,
): ExternalMmuAccess {
  return { id, kind, core: 0, address, bytes };
}

describe("configuration and source boundary", () => {
  test("requires all 512 explicit entries and assumes no reset mappings", () => {
    expect(() => new Esp32S3ExternalMmu(configuration(entries().slice(0, -1)))).toThrow(
      "config.entries must explicitly contain all 512 MMU entries; no reset mappings are assumed",
    );

    const duplicate = entries();
    duplicate[511] = { index: 0, state: "invalid" };
    expect(() => new Esp32S3ExternalMmu(configuration(duplicate))).toThrow(
      "config.entries duplicates MMU entry 0",
    );
  });

  test("refuses physical page overflow and architecture overclaims", () => {
    const overflow = entries({ index: 0, target: "flash", physicalPage: 16_384 });
    expect(() => new Esp32S3ExternalMmu(configuration(overflow))).toThrow(
      "physicalPage must be an integer from 0 through 16383; the physical page would overflow the MMU limit",
    );

    const overclaim = {
      ...ESP32_S3_IDF_V6_1_MMU_METADATA,
      architectureCalibration: "calibrated",
    } as unknown as ExternalMmuConfiguration["metadata"];
    expect(() => new Esp32S3ExternalMmu({ metadata: overclaim, entries: entries() })).toThrow(
      "config.metadata.architectureCalibration must remain uncalibrated",
    );

    const wrongVersion = {
      ...ESP32_S3_IDF_V6_1_MMU_METADATA,
      idfVersion: "v6.0.2",
    };
    expect(() => new Esp32S3ExternalMmu({ metadata: wrongVersion, entries: entries() })).toThrow(
      "config.metadata.idfVersion must be v6.1 for this MMU definition",
    );
  });

  test("records exact ESP-IDF version, paths, and macros without latency claims", () => {
    const snapshot = new Esp32S3ExternalMmu(configuration(entries())).snapshot();
    expect(snapshot.metadata).toEqual(ESP32_S3_IDF_V6_1_MMU_METADATA);
    expect(snapshot.metadata.architectureCalibration).toBe("uncalibrated");
    expect(snapshot.metadata.idfVersion).toBe("v6.1");
    expect(snapshot.metadata.sources).toContainEqual({
      path: "components/soc/esp32s3/include/soc/ext_mem_defs.h",
      symbols: expect.arrayContaining([
        "SOC_MMU_ENTRY_NUM",
        "SOC_MMU_INVALID",
        "SOC_MMU_TYPE",
        "SOC_MMU_VALID_VAL_MASK",
      ]),
    });
    expect(snapshot.metadata.sources).toContainEqual({
      path: "components/hal/esp32s3/include/hal/mmu_ll.h",
      symbols: expect.arrayContaining([
        "mmu_ll_get_entry_id",
        "mmu_ll_get_entry_target",
        "mmu_ll_entry_id_to_paddr_base",
      ]),
    });
    expect("latency" in snapshot).toBe(false);
  });
});

describe("window and page boundaries", () => {
  test("translates the first and last entries of both 32 MiB windows", () => {
    const mmu = new Esp32S3ExternalMmu(
      configuration(
        entries(
          { index: 0, target: "flash", physicalPage: 2 },
          { index: 511, target: "psram", physicalPage: 16_383 },
        ),
      ),
    );
    const first = mmu.translate(access("first", "instruction-fetch", ESP32_S3_EXTERNAL_WINDOWS.irom.low, 1));
    const last = mmu.translate(access("last", "load", ESP32_S3_EXTERNAL_WINDOWS.drom.high - 1n, 1));
    expect(first.status).toBe("translated");
    expect(last.status).toBe("translated");
    if (first.status === "translated" && last.status === "translated") {
      expect(first.segments[0]).toMatchObject({
        entryIndex: 0,
        target: "flash",
        physicalAddress: 0x2_0000n,
        rawEntryValue: 2,
      });
      expect(last.segments[0]).toMatchObject({
        entryIndex: 511,
        target: "psram",
        physicalAddress: 0x3fff_ffffn,
        rawEntryValue: ESP32_S3_MMU_TARGET_BIT | 0x3fff,
      });
    }
  });

  test("splits a cross-page access exactly and faults a cross-window access atomically", () => {
    const mmu = new Esp32S3ExternalMmu(
      configuration(
        entries(
          { index: 0, target: "flash", physicalPage: 8 },
          { index: 1, target: "psram", physicalPage: 4 },
          { index: 511, target: "flash", physicalPage: 9 },
        ),
      ),
    );
    const split = mmu.translate(access("split", "load", 0x3c00_ffffn, 2));
    expect(split.status).toBe("translated");
    if (split.status === "translated") {
      expect(split.segments.map((segment) => ({
        virtualAddress: segment.virtualAddress,
        bytes: segment.bytes,
        entryIndex: segment.entryIndex,
        target: segment.target,
        physicalAddress: segment.physicalAddress,
      }))).toEqual([
        {
          virtualAddress: 0x3c00_ffffn,
          bytes: 1,
          entryIndex: 0,
          target: "flash",
          physicalAddress: 0x8_ffffn,
        },
        {
          virtualAddress: 0x3c01_0000n,
          bytes: 1,
          entryIndex: 1,
          target: "psram",
          physicalAddress: 0x4_0000n,
        },
      ]);
    }

    const crossing = mmu.translate(access("cross-window", "load", 0x3dff_ffffn, 2));
    expect(crossing).toMatchObject({
      status: "fault",
      segments: [],
      fault: { kind: "outside-window", atAddress: 0x3e00_0000n, entryIndex: null },
    });
  });

  test("rejects the wrong access view and a 32-bit overflow", () => {
    const mmu = new Esp32S3ExternalMmu(
      configuration(entries({ index: 0, target: "flash", physicalPage: 0 })),
    );
    expect(mmu.translate(access("load-irom", "load", 0x4200_0000n))).toMatchObject({
      status: "fault",
      fault: { kind: "outside-window", atAddress: 0x4200_0000n },
    });
    expect(mmu.translate(access("fetch-drom", "instruction-fetch", 0x3c00_0000n))).toMatchObject({
      status: "fault",
      fault: { kind: "outside-window", atAddress: 0x3c00_0000n },
    });
    expect(mmu.translate(access("overflow", "load", 0xffff_ffffn, 2))).toMatchObject({
      status: "fault",
      fault: { kind: "address-overflow", atAddress: 0x1_0000_0000n },
    });
  });
});

describe("aliases, target bit, and invalid entries", () => {
  test("maps IROM and DROM aliases through the same table entry and target type", () => {
    const mmu = new Esp32S3ExternalMmu(
      configuration(entries({ index: 3, target: "psram", physicalPage: 7 })),
    );
    const irom = mmu.translate(access("irom", "instruction-fetch", 0x4203_1234n));
    const drom = mmu.translate(access("drom", "load", 0x3c03_1234n));
    expect(irom.status).toBe("translated");
    expect(drom.status).toBe("translated");
    if (irom.status === "translated" && drom.status === "translated") {
      expect(irom.segments[0]).toMatchObject({
        entryIndex: 3,
        target: "psram",
        physicalAddress: 0x7_1234n,
        rawEntryValue: ESP32_S3_MMU_TARGET_BIT | 7,
      });
      expect(drom.segments[0]).toMatchObject({
        entryIndex: irom.segments[0]?.entryIndex,
        target: irom.segments[0]?.target,
        physicalPage: irom.segments[0]?.physicalPage,
        pageOffset: irom.segments[0]?.pageOffset,
        physicalAddress: irom.segments[0]?.physicalAddress,
        rawEntryValue: irom.segments[0]?.rawEntryValue,
      });
      expect(irom.segments[0]?.window).toBe("irom");
      expect(drom.segments[0]?.window).toBe("drom");
    }
  });

  test("routes an Xtensa literal load through the IROM view without calling it a fetch", () => {
    const mmu = new Esp32S3ExternalMmu(
      configuration(entries({ index: 3, target: "flash", physicalPage: 7 })),
    );
    const literal = mmu.translate(access("literal", "literal-load", 0x4203_1234n));
    expect(literal.status).toBe("translated");
    if (literal.status === "translated") {
      expect(literal.window).toBe("irom");
      expect(literal.access.kind).toBe("literal-load");
      expect(literal.segments[0]).toMatchObject({
        entryIndex: 3,
        target: "flash",
        physicalAddress: 0x7_1234n,
      });
      const adapted = adaptExternalMmuTranslation(literal);
      expect(adapted.status).toBe("translated");
      if (adapted.status === "translated") {
        expect(adapted.traces[0]).toMatchObject({
          kind: "literal-load",
          memory: "flash",
        });
      }
    }
  });

  test("returns an atomic fault for an explicitly invalid entry", () => {
    const mmu = new Esp32S3ExternalMmu(configuration(entries()));
    const result = mmu.translate(access("invalid", "load", 0x3c05_0010n, 4));
    expect(result).toMatchObject({
      status: "fault",
      segments: [],
      fault: {
        kind: "invalid-entry",
        atAddress: 0x3c05_0010n,
        entryIndex: 5,
      },
    });
    expect(mmu.snapshot().entries[5]).toEqual({
      index: 5,
      state: "invalid",
      target: null,
      physicalPage: null,
      rawValue: ESP32_S3_MMU_INVALID_BIT,
    });
  });

  test("adapts translated physical segments to cache traces without adding costs", () => {
    const mmu = new Esp32S3ExternalMmu(
      configuration(
        entries(
          { index: 0, target: "flash", physicalPage: 2 },
          { index: 1, target: "psram", physicalPage: 3 },
        ),
      ),
    );
    const adapted = adaptExternalMmuTranslation(
      mmu.translate(access("cache-input", "load", 0x3c00_ffffn, 2)),
    );
    expect(adapted).toEqual({
      status: "translated",
      traces: [
        {
          id: "cache-input:mmu:0:cache",
          kind: "load",
          core: 0,
          memory: "flash",
          address: 0x2_ffffn,
          bytes: 1,
          cacheability: "cached",
        },
        {
          id: "cache-input:mmu:1:cache",
          kind: "load",
          core: 0,
          memory: "psram",
          address: 0x3_0000n,
          bytes: 1,
          cacheability: "cached",
        },
      ],
    });
    expect("latency" in (adapted.status === "translated" ? adapted.traces[0]! : {})).toBe(false);
  });
});

describe("address-map adapter", () => {
  test("emits deterministic target-specific DROM and IROM regions and omits invalid entries", () => {
    const snapshot = new Esp32S3ExternalMmu(
      configuration(
        entries(
          { index: 0, target: "psram", physicalPage: 3 },
          { index: 1, target: "flash", physicalPage: 7 },
        ),
      ),
    ).snapshot();
    const adapted = adaptExternalMmuSnapshotToAddressMap(snapshot);
    const reversed = adaptExternalMmuSnapshotToAddressMap({
      ...snapshot,
      entries: [...snapshot.entries].reverse(),
    });

    expect(reversed).toEqual(adapted);
    expect(adapted.regions.map((region) => region.id)).toEqual([
      "mmu:drom:0:psram",
      "mmu:drom:1:flash",
      "mmu:irom:0:psram",
      "mmu:irom:1:flash",
    ]);
    expect(adapted.regions).toHaveLength(4);
    expect(adapted.regions[0]).toMatchObject({
      base: 0x3c00_0000n,
      size: 0x1_0000n,
      kind: "psram",
      permissions: { read: true, write: true, execute: false },
      cacheability: "cached",
      physical: { backingId: "esp32-s3-mspi-psram", offset: 0x3_0000n },
    });
    expect(adapted.regions[1]).toMatchObject({
      kind: "flash",
      permissions: { read: true, write: false, execute: false },
      physical: { backingId: "esp32-s3-mspi-flash", offset: 0x7_0000n },
    });
    expect(adapted.regions[2]).toMatchObject({
      base: 0x4200_0000n,
      kind: "psram",
      permissions: { read: false, write: false, execute: true },
      physical: { backingId: "esp32-s3-mspi-psram", offset: 0x3_0000n },
    });
    expect(adapted.regions[3]).toMatchObject({
      kind: "flash",
      permissions: { read: false, write: false, execute: true },
      physical: { backingId: "esp32-s3-mspi-flash", offset: 0x7_0000n },
    });
    expect(adapted.metadata).toMatchObject({ architectureCalibration: "uncalibrated" });
    expect(adapted.metadata.source).toContain(
      "components/soc/esp32s3/include/soc/ext_mem_defs.h [SOC_IRAM0_CACHE_ADDRESS_LOW",
    );
    expect(adapted.mmuClaim).toBe(ESP32_S3_IDF_V6_1_MMU_METADATA);
  });
});

describe("stable ordering", () => {
  test("normalizes entry declaration order and repeats exact translations", () => {
    const forwardEntries = entries(
      { index: 10, target: "flash", physicalPage: 20 },
      { index: 11, target: "psram", physicalPage: 21 },
    );
    const reverseEntries = [...forwardEntries].reverse();
    const forward = new Esp32S3ExternalMmu(configuration(forwardEntries));
    const reverse = new Esp32S3ExternalMmu(configuration(reverseEntries));
    const request = access("stable", "instruction-fetch", 0x420a_fffcn, 8);
    expect(reverse.snapshot()).toEqual(forward.snapshot());
    expect(reverse.translate(request)).toEqual(forward.translate(request));
    expect(forward.translate(request)).toEqual(forward.translate(request));
    expect(forward.snapshot().pageSizeBytes).toBe(ESP32_S3_MMU_PAGE_SIZE_BYTES);
    expect(forward.snapshot().entries.map((entry) => entry.index)).toEqual(
      Array.from({ length: ESP32_S3_MMU_ENTRY_COUNT }, (_, index) => index),
    );
  });
});
