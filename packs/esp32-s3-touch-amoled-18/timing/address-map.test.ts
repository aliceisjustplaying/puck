import { describe, expect, test } from "bun:test";
import {
  AddressSpaceResolver,
  adaptAddressResolution,
  type AddressMapConfiguration,
  type AddressRegion,
  type VirtualMemoryAccess,
} from "./address-map";
import { eventUsesMspi, scheduleExecution, type EventLatency, type ExecutionEvent } from "./execution";

const permissions = (read: boolean, write: boolean, execute: boolean) => ({ read, write, execute });

const REGIONS: readonly AddressRegion[] = [
  {
    id: "sram",
    base: 0x1000n,
    size: 0x100n,
    kind: "sram",
    permissions: permissions(true, true, true),
    cacheability: "uncached",
    physical: { backingId: "internal-sram", offset: 0n },
  },
  {
    id: "psram",
    base: 0x2000n,
    size: 0x100n,
    kind: "psram",
    permissions: permissions(true, true, false),
    cacheability: "cached",
    physical: { backingId: "external-psram", offset: 0n },
  },
  {
    id: "irom",
    base: 0x4000n,
    size: 0x100n,
    kind: "flash",
    permissions: permissions(false, false, true),
    cacheability: "cached",
    physical: { backingId: "spi-flash", offset: 0n },
  },
  {
    id: "drom",
    base: 0x5000n,
    size: 0x100n,
    kind: "flash",
    permissions: permissions(true, false, false),
    cacheability: "cached",
    physical: { backingId: "spi-flash", offset: 0n },
  },
  {
    id: "uart",
    base: 0x6000n,
    size: 0x100n,
    kind: "mmio",
    permissions: permissions(true, true, false),
    cacheability: "uncached",
    physical: { backingId: "uart-registers", offset: 0n },
    peripheral: "uart0",
  },
];

function configuration(regions: readonly AddressRegion[] = REGIONS): AddressMapConfiguration {
  return {
    addressBits: 32,
    metadata: {
      architectureCalibration: "uncalibrated",
      source: "synthetic-address-map",
    },
    regions,
  };
}

function access(
  id: string,
  kind: VirtualMemoryAccess["kind"],
  address: bigint,
  bytes = 4,
): VirtualMemoryAccess {
  return { id, kind, core: 0, address, bytes };
}

const knownMmio = (): EventLatency => ({
  status: "known",
  cycles: 3n,
  calibration: "uncalibrated",
  source: "synthetic-mmio-cost",
});

describe("configuration boundaries", () => {
  test("rejects virtual overlaps but permits physical aliases", () => {
    const overlap: AddressRegion = {
      ...REGIONS[1]!,
      id: "overlap",
      base: 0x2080n,
    };
    expect(() => new AddressSpaceResolver(configuration([...REGIONS, overlap]))).toThrow(
      "address regions psram and overlap overlap",
    );

    expect(() => new AddressSpaceResolver(configuration())).not.toThrow();
  });

  test("requires an uncalibrated architecture source and coherent MMIO attributes", () => {
    const overclaim = configuration() as unknown as {
      metadata: { architectureCalibration: string; source: string };
      addressBits: number;
      regions: readonly AddressRegion[];
    };
    overclaim.metadata.architectureCalibration = "calibrated";
    expect(() => new AddressSpaceResolver(overclaim as unknown as AddressMapConfiguration)).toThrow(
      "architectureCalibration must remain uncalibrated",
    );

    const cachedMmio = { ...REGIONS[4]!, cacheability: "cached" as const };
    expect(() => new AddressSpaceResolver(configuration([...REGIONS.slice(0, 4), cachedMmio]))).toThrow(
      "MMIO region uart must be uncached",
    );
  });
});

describe("resolution and aliases", () => {
  test("returns an atomic 32-bit overflow fault", () => {
    const result = new AddressSpaceResolver(configuration()).resolve(
      access("overflow", "load", 0xffff_ffffn, 2),
    );
    expect(result).toMatchObject({
      status: "fault",
      segments: [],
      fault: {
        kind: "address-overflow",
        atAddress: 0x1_0000_0000n,
        regionId: null,
      },
    });
  });

  test("maps IROM execute and DROM read aliases to the same flash backing offset", () => {
    const resolver = new AddressSpaceResolver(configuration());
    const irom = resolver.resolve(access("irom-fetch", "instruction-fetch", 0x4010n));
    const drom = resolver.resolve(access("drom-load", "load", 0x5010n));
    expect(irom.status).toBe("resolved");
    expect(drom.status).toBe("resolved");
    if (irom.status === "resolved" && drom.status === "resolved") {
      expect(irom.segments[0]).toMatchObject({
        kind: "flash",
        physicalBackingId: "spi-flash",
        physicalOffset: 0x10n,
      });
      expect(drom.segments[0]).toMatchObject({
        kind: "flash",
        physicalBackingId: "spi-flash",
        physicalOffset: 0x10n,
      });
      const iromTrace = adaptAddressResolution(irom);
      const dromTrace = adaptAddressResolution(drom);
      expect(iromTrace.status === "resolved" && iromTrace.outputs[0]?.kind === "cache"
        ? iromTrace.outputs[0].trace.address
        : null).toBe(0x10n);
      expect(dromTrace.status === "resolved" && dromTrace.outputs[0]?.kind === "cache"
        ? dromTrace.outputs[0].trace.address
        : null).toBe(0x10n);
    }
  });

  test("classifies internal SRAM locally and PSRAM on the shared external path", () => {
    const resolver = new AddressSpaceResolver(configuration());
    const sram = adaptAddressResolution(resolver.resolve(access("sram", "load", 0x1010n)));
    const psram = adaptAddressResolution(resolver.resolve(access("psram", "load", 0x2010n)));
    expect(sram.status).toBe("resolved");
    expect(psram.status).toBe("resolved");
    if (sram.status === "resolved" && psram.status === "resolved") {
      const sramTrace = sram.outputs[0];
      const psramTrace = psram.outputs[0];
      expect(sramTrace?.kind).toBe("cache");
      expect(psramTrace?.kind).toBe("cache");
      if (sramTrace?.kind === "cache" && psramTrace?.kind === "cache") {
        expect(sramTrace.trace).toMatchObject({ memory: "sram", cacheability: "uncached" });
        expect(psramTrace.trace).toMatchObject({ memory: "psram", cacheability: "cached" });
        const latency: EventLatency = {
          status: "known",
          cycles: 1n,
          calibration: "uncalibrated",
          source: "classification-test",
        };
        const toEvent = (trace: typeof sramTrace.trace): ExecutionEvent => ({
          id: trace.id,
          kind: trace.kind,
          core: trace.core,
          memory: trace.memory,
          bytes: trace.bytes,
          latency,
        });
        expect(eventUsesMspi(toEvent(sramTrace.trace))).toBe(false);
        expect(eventUsesMspi(toEvent(psramTrace.trace))).toBe(true);
      }
    }
  });

  test("adapts MMIO only with an explicit cost and keeps it off MSPI", () => {
    const resolution = new AddressSpaceResolver(configuration()).resolve(access("uart-load", "load", 0x6004n));
    expect(() => adaptAddressResolution(resolution)).toThrow(
      "mmioLatency is required to adapt MMIO without inventing a cost",
    );
    const adapted = adaptAddressResolution(resolution, { mmioLatency: knownMmio });
    expect(adapted.status).toBe("resolved");
    if (adapted.status === "resolved" && adapted.outputs[0]?.kind === "mmio") {
      expect(adapted.outputs[0].event).toMatchObject({
        kind: "mmio",
        peripheral: "uart0",
        operation: "read",
        bytes: 4,
      });
      expect(scheduleExecution([adapted.outputs[0].event]).events[0]).toMatchObject({
        status: "completed",
        resource: null,
      });
    }
  });
});

describe("faults and cross-region atomicity", () => {
  test("returns explicit execute, read, and write permission faults", () => {
    const resolver = new AddressSpaceResolver(configuration());
    const cases = [
      resolver.resolve(access("execute-drom", "instruction-fetch", 0x5000n)),
      resolver.resolve(access("read-irom", "load", 0x4000n)),
      resolver.resolve(access("write-flash", "store", 0x5000n)),
    ];
    expect(cases.map((result) => result.status === "fault" ? [result.fault.kind, result.fault.regionId] : null)).toEqual([
      ["permission", "drom"],
      ["permission", "irom"],
      ["permission", "drom"],
    ]);
    expect(cases.every((result) => result.segments.length === 0)).toBe(true);
  });

  test("splits adjacent permitted regions at the exact boundary", () => {
    const adjacent: readonly AddressRegion[] = [
      {
        id: "left",
        base: 0x100n,
        size: 0x10n,
        kind: "sram",
        permissions: permissions(true, true, false),
        cacheability: "uncached",
        physical: { backingId: "sram", offset: 0n },
      },
      {
        id: "right",
        base: 0x110n,
        size: 0x10n,
        kind: "psram",
        permissions: permissions(true, true, false),
        cacheability: "cached",
        physical: { backingId: "psram", offset: 0x20n },
      },
    ];
    const result = new AddressSpaceResolver(configuration(adjacent)).resolve(access("split", "load", 0x10en, 4));
    expect(result.status).toBe("resolved");
    if (result.status === "resolved") {
      expect(result.segments).toEqual([
        {
          index: 0,
          virtualAddress: 0x10en,
          bytes: 2,
          regionId: "left",
          kind: "sram",
          cacheability: "uncached",
          physicalBackingId: "sram",
          physicalOffset: 0xen,
          peripheral: null,
        },
        {
          index: 1,
          virtualAddress: 0x110n,
          bytes: 2,
          regionId: "right",
          kind: "psram",
          cacheability: "cached",
          physicalBackingId: "psram",
          physicalOffset: 0x20n,
          peripheral: null,
        },
      ]);
      const adapted = adaptAddressResolution(result);
      expect(adapted.status === "resolved" ? adapted.outputs.map((output) => output.kind) : null).toEqual([
        "cache",
        "cache",
      ]);
    }
  });

  test("faults the whole cross-boundary access on a gap or denied neighbor", () => {
    const left = {
      id: "left",
      base: 0x100n,
      size: 0x10n,
      kind: "sram" as const,
      permissions: permissions(true, true, false),
      cacheability: "uncached" as const,
      physical: { backingId: "left", offset: 0n },
    };
    const gapResolver = new AddressSpaceResolver(
      configuration([
        left,
        { ...left, id: "after-gap", base: 0x112n, physical: { backingId: "right", offset: 0n } },
      ]),
    );
    const gap = gapResolver.resolve(access("gap", "load", 0x10en, 4));
    expect(gap).toMatchObject({ status: "fault", segments: [], fault: { kind: "unmapped", atAddress: 0x110n } });

    const deniedResolver = new AddressSpaceResolver(
      configuration([
        left,
        {
          ...left,
          id: "denied",
          base: 0x110n,
          permissions: permissions(false, true, false),
          physical: { backingId: "right", offset: 0n },
        },
      ]),
    );
    const denied = deniedResolver.resolve(access("denied", "load", 0x10en, 4));
    expect(denied).toMatchObject({
      status: "fault",
      segments: [],
      fault: { kind: "permission", atAddress: 0x110n, regionId: "denied" },
    });
  });
});

describe("deterministic ordering", () => {
  test("normalizes region declaration order and repeats identical segment order", () => {
    const forward = new AddressSpaceResolver(configuration(REGIONS));
    const reverse = new AddressSpaceResolver(configuration([...REGIONS].reverse()));
    const request = access("stable", "load", 0x2004n, 8);
    const first = forward.resolve(request);
    expect(reverse.resolve(request)).toEqual(first);
    expect(forward.resolve(request)).toEqual(first);
    if (first.status === "resolved") {
      expect(first.claim).toEqual({
        architectureCalibration: "uncalibrated",
        source: "synthetic-address-map",
      });
    }
  });
});
