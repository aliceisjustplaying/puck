import { describe, expect, test } from "bun:test";
import type { AddressMapConfiguration, AddressRegion, VirtualMemoryAccess } from "./address-map";
import {
  ESP32_S3_CACHE_BANK_TOPOLOGY,
  type CacheConfiguration,
  type CacheLineFillBurstCost,
  type CacheLineFillCost,
  type CacheLatency,
} from "./cache";
import type { CpuExecutionEvent, DmaEvent } from "./execution";
import {
  ESP32_S3_IDF_V6_0_2_MMU_METADATA,
  ESP32_S3_MMU_ENTRY_COUNT,
  Esp32S3ExternalMmu,
  adaptExternalMmuSnapshotToAddressMap,
  type ExternalMmuEntryConfiguration,
} from "./mmu";
import {
  runTimingMachine,
  timingMachineJson,
  type ScheduledMemoryIssue,
  type TimingMachineConfiguration,
  type TimingMachineInput,
} from "./machine";

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

const known = (
  cycles: bigint,
  calibration: "calibrated" | "uncalibrated" = "calibrated",
  source = "synthetic-machine-cost",
): CacheLatency => ({ status: "known", cycles, calibration, source });

const burst = (first: bigint, subsequent: bigint): CacheLineFillBurstCost => ({
  firstLineLatency: known(first, "calibrated", "synthetic-first-line-cost"),
  subsequentLineServiceInterval: known(
    subsequent,
    "calibrated",
    "synthetic-subsequent-line-cost",
  ),
});

function addressMap(): AddressMapConfiguration {
  return {
    addressBits: 32,
    metadata: {
      architectureCalibration: "uncalibrated",
      source: "synthetic-machine-address-map",
    },
    regions: REGIONS,
  };
}

function cache(lineFill: CacheLineFillCost = known(10n)): CacheConfiguration {
  return {
    addressBits: 32,
    metadata: {
      architectureCalibration: "uncalibrated",
      source: "synthetic-machine-cache",
    },
    topology: ESP32_S3_CACHE_BANK_TOPOLOGY,
    instruction: {
      lineSizeBytes: 16,
      sets: 1,
      ways: 4,
      replacement: "least-recently-used",
      writePolicy: "read-only",
    },
    data: {
      lineSizeBytes: 16,
      sets: 1,
      ways: 4,
      replacement: "least-recently-used",
      writePolicy: "write-back",
      allocateOnStoreMiss: true,
      dirtyInvalidate: "writeback",
    },
    costs: {
      hit: {
        instructionFetch: known(1n),
        load: known(1n),
        store: known(1n),
      },
      lineFill,
      dirtyWriteback: known(9n),
      writeThrough: known(7n),
      uncached: {
        instructionFetch: known(6n),
        load: known(6n),
        store: known(6n),
      },
      sram: {
        instructionFetch: known(2n),
        load: known(2n),
        store: known(2n),
      },
      maintenance: known(2n),
    },
  };
}

function configuration(lineFill: CacheLineFillCost = known(10n)): TimingMachineConfiguration {
  return {
    addressMap: addressMap(),
    cache: cache(lineFill),
    mmioCost: () => known(3n, "calibrated", "synthetic-mmio-receipt"),
  };
}

function access(
  id: string,
  core: 0 | 1,
  kind: VirtualMemoryAccess["kind"],
  address: bigint,
  bytes = 4,
): VirtualMemoryAccess {
  return { id, core, kind, address, bytes };
}

function input(
  core0: readonly VirtualMemoryAccess[],
  core1: readonly VirtualMemoryAccess[],
  dma: readonly DmaEvent[] = [],
  architecturalInterleave: readonly string[] = [
    ...core0.map((trace) => trace.id),
    ...core1.map((trace) => trace.id),
  ],
): TimingMachineInput {
  return { cores: [core0, core1], architecturalInterleave, dma };
}

function dma(id: string, latencyCycles: bigint): DmaEvent {
  return {
    id,
    kind: "dma",
    channel: "panel",
    earliest: {
      cycle: 0n,
      calibration: "calibrated",
      source: "synthetic-dma-submit",
    },
    source: { kind: "memory", memory: "flash" },
    destination: { kind: "mmio", peripheral: "panel" },
    bytes: 64,
    latency: {
      status: "known",
      cycles: latencyCycles,
      calibration: "calibrated",
      source: "synthetic-dma-cost",
    },
  };
}

function scheduled(accessId: string, cycle: bigint): ScheduledMemoryIssue {
  return {
    accessId,
    earliest: {
      cycle,
      calibration: "calibrated",
      source: "synthetic-core-ready-clock",
    },
  };
}

function completedWindow(
  result: ReturnType<typeof runTimingMachine>,
  eventId: string,
): readonly [bigint, bigint] | null {
  const event = result.execution.events.find((candidate) => candidate.eventId === eventId);
  return event?.status === "completed" ? [event.startCycle, event.endCycle] : null;
}

describe("two-core composition and shared resources", () => {
  test("serializes simultaneous flash and PSRAM misses while preserving each core stream", () => {
    const result = runTimingMachine(
      configuration(),
      input(
        [access("core0-flash", 0, "instruction-fetch", 0x4000n)],
        [access("core1-psram", 1, "load", 0x2000n)],
      ),
    );
    const fills = result.issuedEvents.filter(
      (issued) =>
        issued.origin.kind === "cache" &&
        "memory" in issued.event &&
        issued.event.memory !== "sram",
    );
    expect(fills.map((issued) => issued.event.id)).toEqual([
      "cache:core0-flash:segment:0:cache:0:line-fill",
      "cache:core1-psram:segment:0:cache:0:line-fill",
    ]);
    expect(completedWindow(result, fills[0]!.event.id)).toEqual([0n, 10n]);
    expect(completedWindow(result, fills[1]!.event.id)).toEqual([10n, 20n]);
    expect(result.cores.map((core) => core.status)).toEqual(["complete", "complete"]);
  });

  test("applies sequential fill intervals and restarts on gaps, cores, and paths", () => {
    const lineFill: CacheLineFillCost = {
      instruction: { flash: burst(11n, 3n), psram: burst(13n, 4n) },
      data: { flash: burst(17n, 5n), psram: burst(19n, 6n) },
    };
    const sequential = runTimingMachine(
      configuration(lineFill),
      input(
        [
          access("seq-0", 0, "instruction-fetch", 0x4000n),
          access("seq-1", 0, "instruction-fetch", 0x4010n),
          access("random", 0, "instruction-fetch", 0x4040n),
        ],
        [],
      ),
    );
    expect(
      sequential.issuedEvents
        .filter((issued) => issued.event.id.endsWith("line-fill"))
        .map((issued) => issued.cost.status === "known" ? issued.cost.cycles : null),
    ).toEqual([11n, 3n, 11n]);

    const switched = runTimingMachine(
      configuration(lineFill),
      input(
        [
          access("flash-data-0", 0, "load", 0x5000n),
          access("flash-data-1", 0, "load", 0x5010n),
          access("flash-data-after", 0, "load", 0x5020n),
        ],
        [access("psram-between", 1, "load", 0x2020n)],
        [],
        ["flash-data-0", "flash-data-1", "psram-between", "flash-data-after"],
      ),
    );
    const fillCosts = switched.issuedEvents
      .filter((issued) => issued.event.id.endsWith("line-fill"))
      .map((issued) => [
        issued.origin.kind === "cache" ? issued.origin.accessId : null,
        issued.cost.status === "known" ? issued.cost.cycles : null,
        issued.cost.status === "known" ? issued.cost.source : null,
      ]);
    expect(fillCosts).toEqual([
      ["flash-data-0", 17n, "synthetic-first-line-cost"],
      ["flash-data-1", 5n, "synthetic-subsequent-line-cost"],
      ["psram-between", 19n, "synthetic-first-line-cost"],
      ["flash-data-after", 17n, "synthetic-first-line-cost"],
    ]);
    expect(switched.execution.events.filter((event) => event.resource === "mspi").every(
      (event, index, events) => index === 0 || (event.startCycle ?? 0n) >= (events[index - 1]?.endCycle ?? 0n),
    )).toBe(true);
  });

  test("lets internal SRAM on one core complete while the other core occupies MSPI", () => {
    const result = runTimingMachine(
      configuration(known(20n)),
      input(
        [access("flash-long", 0, "instruction-fetch", 0x4000n)],
        [access("sram-local", 1, "load", 0x1000n)],
      ),
    );
    const flashFill = result.issuedEvents.find((issued) => issued.event.id.includes("line-fill"))!;
    const sram = result.issuedEvents.find((issued) => issued.event.id.includes("sram-bypass"))!;
    expect(completedWindow(result, flashFill.event.id)).toEqual([0n, 20n]);
    expect(completedWindow(result, sram.event.id)).toEqual([0n, 2n]);
    expect(result.execution.events.find((event) => event.eventId === sram.event.id)?.resource).toBeNull();
  });

  test("resolves IROM and DROM aliases to the same physical flash offset", () => {
    const result = runTimingMachine(
      configuration(),
      input(
        [
          access("irom-fetch", 0, "instruction-fetch", 0x4014n),
          access("drom-load", 0, "load", 0x5014n),
        ],
        [],
      ),
    );
    const resolved = result.cores[0].accesses.filter((item) => item.status === "resolved");
    expect(resolved.map((item) => item.resolution.segments[0]?.physicalBackingId)).toEqual([
      "spi-flash",
      "spi-flash",
    ]);
    expect(resolved.map((item) => item.resolution.segments[0]?.physicalOffset)).toEqual([0x14n, 0x14n]);
  });

  test("uses the instruction cache for IROM literal loads without relabeling them as fetches", () => {
    const result = runTimingMachine(
      configuration(),
      input(
        [
          access("literal", 0, "literal-load", 0x4014n),
          access("fetch-after-literal", 0, "instruction-fetch", 0x4018n),
        ],
        [],
      ),
    );
    const literal = result.cores[0].accesses[0];
    const fetch = result.cores[0].accesses[1];
    expect(literal?.status).toBe("resolved");
    expect(fetch?.status).toBe("resolved");
    if (literal?.status === "resolved" && fetch?.status === "resolved") {
      expect(literal.cacheSteps[0]?.emissions.map((emission) => [
        emission.kind,
        emission.cache,
        emission.event.kind,
      ])).toEqual([
        ["line-fill", "instruction", "literal-load"],
        ["hit", "instruction", "literal-load"],
      ]);
      expect(fetch.cacheSteps[0]?.emissions.map((emission) => emission.kind)).toEqual(["hit"]);
    }
  });

  test("keeps MMIO local and records its explicit cost source", () => {
    const result = runTimingMachine(
      configuration(),
      input([access("uart-read", 0, "load", 0x6004n)], []),
    );
    expect(result.issuedEvents).toHaveLength(1);
    expect(result.issuedEvents[0]).toMatchObject({
      origin: { kind: "mmio", regionId: "uart" },
      event: { kind: "mmio", peripheral: "uart0", operation: "read" },
      cost: { status: "known", cycles: 3n, source: "synthetic-mmio-receipt" },
    });
    expect(result.execution.events[0]).toMatchObject({ resource: null, startCycle: 0n, endCycle: 3n });

    const missing = { ...configuration(), mmioCost: undefined } as unknown as TimingMachineConfiguration;
    expect(() => runTimingMachine(missing, input([], []))).toThrow(
      "config.mmioCost is required; the machine has no default MMIO costs",
    );
  });

  test("arbitrates DMA with core traffic on the same MSPI clock", () => {
    const transfer = dma("panel-dma", 4n);
    const result = runTimingMachine(
      configuration(),
      input([access("psram-load", 0, "load", 0x2000n)], [], [transfer]),
    );
    expect(completedWindow(result, "cache:psram-load:segment:0:cache:0:line-fill")).toEqual([0n, 10n]);
    expect(completedWindow(result, "panel-dma")).toEqual([10n, 14n]);
    expect(result.claim.dmaReadinessSources).toEqual([
      {
        eventId: "panel-dma",
        calibration: "calibrated",
        source: "synthetic-dma-submit",
      },
    ]);
  });

  test("runs MMU-derived flash and PSRAM mappings through address, cache, and MSPI", () => {
    const mmuEntries: ExternalMmuEntryConfiguration[] = Array.from(
      { length: ESP32_S3_MMU_ENTRY_COUNT },
      (_, index) => ({ index, state: "invalid" as const }),
    );
    mmuEntries[0] = { index: 0, state: "mapped", target: "flash", physicalPage: 2 };
    mmuEntries[1] = { index: 1, state: "mapped", target: "psram", physicalPage: 3 };
    const mmu = new Esp32S3ExternalMmu({
      metadata: ESP32_S3_IDF_V6_0_2_MMU_METADATA,
      entries: mmuEntries,
    });
    const mmuAddressMap = adaptExternalMmuSnapshotToAddressMap(mmu.snapshot());
    const machineConfig = { ...configuration(), addressMap: mmuAddressMap };
    const result = runTimingMachine(
      machineConfig,
      input(
        [access("mmu-flash", 0, "instruction-fetch", 0x4200_0004n)],
        [access("mmu-psram", 1, "load", 0x3c01_0008n)],
        [],
        ["mmu-flash", "mmu-psram"],
      ),
    );

    const flash = result.cores[0].accesses[0];
    const psram = result.cores[1].accesses[0];
    expect(flash?.status).toBe("resolved");
    expect(psram?.status).toBe("resolved");
    if (flash?.status === "resolved" && psram?.status === "resolved") {
      expect(flash.resolution.segments[0]).toMatchObject({
        kind: "flash",
        physicalBackingId: "esp32-s3-mspi-flash",
        physicalOffset: 0x2_0004n,
      });
      expect(psram.resolution.segments[0]).toMatchObject({
        kind: "psram",
        physicalBackingId: "esp32-s3-mspi-psram",
        physicalOffset: 0x3_0008n,
      });
    }
    expect(completedWindow(result, "cache:mmu-flash:segment:0:cache:0:line-fill")).toEqual([0n, 10n]);
    expect(completedWindow(result, "cache:mmu-psram:segment:0:cache:0:line-fill")).toEqual([10n, 20n]);
    expect(result.execution.events.filter((event) => event.resource === "mspi")).toHaveLength(2);
    expect(result.claim.architectureCalibration).toBe("uncalibrated");
    expect(result.claim.architectureSources[0]?.source).toBe(mmuAddressMap.metadata.source);
  });
});

describe("explicit architectural interleave", () => {
  test("changes shared data-cache ownership when a legal cross-core order is swapped", () => {
    const core0 = access("core0-data", 0, "load", 0x2000n);
    const core1 = access("core1-data", 1, "load", 0x2000n);
    const forward = runTimingMachine(
      configuration(),
      input([core0], [core1], [], ["core0-data", "core1-data"]),
    );
    const reverse = runTimingMachine(
      configuration(),
      input([core0], [core1], [], ["core1-data", "core0-data"]),
    );
    const kindsFor = (
      result: ReturnType<typeof runTimingMachine>,
      core: 0 | 1,
    ): string[] => {
      const accessResult = result.cores[core].accesses[0];
      if (accessResult?.status !== "resolved") throw new Error("expected resolved test access");
      return accessResult.cacheSteps.flatMap((step) => step.emissions.map((emission) => emission.kind));
    };

    expect([kindsFor(forward, 0), kindsFor(forward, 1)]).toEqual([
      ["line-fill", "hit"],
      ["hit"],
    ]);
    expect([kindsFor(reverse, 0), kindsFor(reverse, 1)]).toEqual([
      ["hit"],
      ["line-fill", "hit"],
    ]);
    expect(forward.architecturalInterleave).toEqual(["core0-data", "core1-data"]);
    expect(reverse.architecturalInterleave).toEqual(["core1-data", "core0-data"]);
    expect(forward.issuedEvents[0]?.origin).toMatchObject({ accessId: "core0-data" });
    expect(reverse.issuedEvents[0]?.origin).toMatchObject({ accessId: "core1-data" });
  });

  test("rejects omitted, duplicate, and per-core out-of-order access IDs", () => {
    const core0 = [
      access("core0-first", 0, "load", 0x1000n),
      access("core0-second", 0, "load", 0x1004n),
    ];
    const core1 = [access("core1-only", 1, "load", 0x1008n)];

    const missing = { cores: [core0, core1], dma: [] } as unknown as TimingMachineInput;
    expect(() => runTimingMachine(configuration(), missing)).toThrow(
      "input.architecturalInterleave is required",
    );

    expect(() =>
      runTimingMachine(
        configuration(),
        input(core0, core1, [], ["core0-first", "core0-second"]),
      ),
    ).toThrow("input.architecturalInterleave omits access ids: core1-only");
    expect(() =>
      runTimingMachine(
        configuration(),
        input(core0, core1, [], ["core0-first", "core1-only", "core1-only", "core0-second"]),
      ),
    ).toThrow("input.architecturalInterleave duplicates access id core1-only");
    expect(() =>
      runTimingMachine(
        configuration(),
        input(core0, core1, [], ["core0-second", "core0-first", "core1-only"]),
      ),
    ).toThrow(
      "input.architecturalInterleave places core0-second before core0-first; core 0 program order must be preserved",
    );
  });

  test("validates and retains a total memory and DMA issue order", () => {
    const core0 = [access("memory-before", 0, "load", 0x1000n)];
    const core1 = [access("memory-after", 1, "load", 0x1004n)];
    const transfer = dma("dma-middle", 4n);
    const ordered: TimingMachineInput = {
      ...input(core0, core1, [transfer], ["memory-before", "memory-after"]),
      issueOrder: [
        { kind: "memory", accessId: "memory-before" },
        { kind: "dma", eventId: "dma-middle" },
        { kind: "memory", accessId: "memory-after" },
      ],
    };
    const result = runTimingMachine(configuration(), ordered);
    expect(result.issuedEvents.map((issued) =>
      issued.origin.kind === "cache" || issued.origin.kind === "mmio"
        ? issued.origin.accessId
        : issued.event.id,
    )).toEqual(["memory-before", "dma-middle", "memory-after"]);

    const omitted: TimingMachineInput = { ...ordered, issueOrder: ordered.issueOrder!.slice(0, -1) };
    expect(() => runTimingMachine(configuration(), omitted)).toThrow(
      "input.issueOrder omits issue ids: memory-after",
    );
    const drift: TimingMachineInput = {
      ...ordered,
      issueOrder: [
        { kind: "memory", accessId: "memory-after" },
        { kind: "dma", eventId: "dma-middle" },
        { kind: "memory", accessId: "memory-before" },
      ],
    };
    expect(() => runTimingMachine(configuration(), drift)).toThrow(
      "input.issueOrder memory access memory-after disagrees with architecturalInterleave at index 0",
    );
  });

  test("links a CPU event to its preceding instruction fetch", () => {
    const fetch = access("fetch", 0, "instruction-fetch", 0x1000n, 2);
    const cpu: CpuExecutionEvent = {
      id: "fetch:cpu",
      kind: "cpu",
      core: 0,
      instructionAccessId: fetch.id,
      latency: { status: "known", cycles: 3n, calibration: "uncalibrated", source: "caller-cpu-cost" },
    };
    const ordered: TimingMachineInput = {
      ...input([fetch], []),
      cpu: [cpu],
      issueOrder: [
        { kind: "memory", accessId: fetch.id },
        { kind: "cpu", eventId: cpu.id },
      ],
    };
    const result = runTimingMachine(configuration(), ordered);
    expect(result.issuedEvents.at(-1)).toMatchObject({
      origin: { kind: "cpu", instructionAccessId: fetch.id, core: 0 },
      cost: { status: "known", cycles: 3n, source: "caller-cpu-cost" },
    });

    expect(() => runTimingMachine(configuration(), {
      ...ordered,
      issueOrder: [...ordered.issueOrder!].reverse(),
    })).toThrow("input.issueOrder CPU event fetch:cpu must follow instruction access fetch");
    expect(() => runTimingMachine(configuration(), {
      ...ordered,
      cpu: [{ ...cpu, instructionAccessId: "missing" }],
    })).toThrow("input.cpu[0].instructionAccessId must name an instruction-fetch access");
  });
});

describe("scheduled cross-core cache dispatch", () => {
  test("derives shared-cache and MSPI order from ready clocks, independent of caller interleave", () => {
    const core0 = [access("core0-later", 0, "load", 0x2020n)];
    const core1 = [access("core1-earlier", 1, "load", 0x2000n)];
    const memoryIssueSchedule = [
      scheduled("core0-later", 20n),
      scheduled("core1-earlier", 5n),
    ];
    const forward = runTimingMachine(configuration(), {
      ...input(core0, core1, [], ["core0-later", "core1-earlier"]),
      memoryIssueSchedule,
    });
    const reverse = runTimingMachine(configuration(), {
      ...input(core0, core1, [], ["core1-earlier", "core0-later"]),
      memoryIssueSchedule: [...memoryIssueSchedule].reverse(),
    });

    expect(reverse).toEqual(forward);
    expect(forward.architecturalInterleave).toEqual(["core1-earlier", "core0-later"]);
    expect(forward.issuedEvents
      .filter((issued) => issued.origin.kind === "cache" && issued.event.id.endsWith("line-fill"))
      .map((issued) => issued.origin.kind === "cache" ? issued.origin.accessId : null))
      .toEqual(["core1-earlier", "core0-later"]);
    expect(forward.execution.events
      .filter((event) => event.resource === "mspi")
      .map((event) => [event.eventId, event.startCycle, event.endCycle]))
      .toEqual([
        ["cache:core1-earlier:segment:0:cache:0:line-fill", 5n, 15n],
        ["cache:core0-later:segment:0:cache:0:line-fill", 20n, 30n],
      ]);
  });

  test("preserves same-core program order and breaks cross-core cycle ties by core id", () => {
    const core0 = [
      access("core0-first", 0, "load", 0x2000n),
      access("core0-second", 0, "load", 0x2020n),
    ];
    const core1 = [access("core1-tied", 1, "load", 0x2040n)];
    const result = runTimingMachine(configuration(), {
      ...input(core0, core1, [], ["core1-tied", "core0-first", "core0-second"]),
      memoryIssueSchedule: [
        scheduled("core0-second", 5n),
        scheduled("core1-tied", 5n),
        scheduled("core0-first", 5n),
      ],
    });

    expect(result.architecturalInterleave).toEqual([
      "core0-first",
      "core0-second",
      "core1-tied",
    ]);
    expect(result.issuedEvents
      .filter((issued) => issued.origin.kind === "cache" && issued.event.id.endsWith("line-fill"))
      .map((issued) => issued.origin.kind === "cache" ? issued.origin.accessId : null))
      .toEqual(["core0-first", "core0-second", "core1-tied"]);
  });

  test("requires a complete non-regressing ready-clock schedule", () => {
    const core0 = [
      access("core0-first", 0, "load", 0x2000n),
      access("core0-second", 0, "load", 0x2020n),
    ];
    const base = input(core0, [], [], ["core0-first", "core0-second"]);
    expect(() => runTimingMachine(configuration(), {
      ...base,
      memoryIssueSchedule: [scheduled("core0-first", 1n)],
    })).toThrow("input.memoryIssueSchedule omits access ids: core0-second");
    expect(() => runTimingMachine(configuration(), {
      ...base,
      memoryIssueSchedule: [
        scheduled("core0-first", 2n),
        scheduled("core0-second", 1n),
      ],
    })).toThrow("cycle for core0-second precedes its prior core 0 access");
  });
});

describe("fault and unknown-cost barriers", () => {
  test("propagates an unknown MSPI cost causally across both cores", () => {
    const unknownFill: CacheLatency = {
      status: "unknown",
      reason: "no external-memory miss measurement",
      source: "missing-lab-receipt",
    };
    const result = runTimingMachine(
      configuration(unknownFill),
      input(
        [access("flash-unknown", 0, "instruction-fetch", 0x4000n)],
        [access("psram-blocked", 1, "load", 0x2000n), access("sram-after", 1, "load", 0x1000n)],
      ),
    );
    const events = result.execution.events.map((event) => [event.eventId, event.status]);
    expect(events).toEqual([
      ["cache:flash-unknown:segment:0:cache:0:line-fill", "started-unknown-duration"],
      ["cache:psram-blocked:segment:0:cache:0:line-fill", "blocked"],
      ["cache:flash-unknown:segment:0:cache:1:hit", "blocked"],
      ["cache:psram-blocked:segment:0:cache:1:hit", "blocked"],
      ["cache:sram-after:segment:0:cache:0:sram-bypass", "blocked"],
    ]);
    expect(result.status).toBe("blocked");
    expect(result.claim.costCalibration).toBe("unknown");
    expect(result.claim.unknownCostEventIds).toEqual([
      "cache:flash-unknown:segment:0:cache:0:line-fill",
      "cache:psram-blocked:segment:0:cache:0:line-fill",
    ]);
    expect(result.claim.costProvenance[0]).toMatchObject({
      status: "unknown",
      source: "missing-lab-receipt",
    });
  });

  test("faults one core atomically, skips its tail, and lets the other core progress", () => {
    const result = runTimingMachine(
      configuration(),
      input(
        [
          access("before-fault", 0, "load", 0x1000n),
          access("unmapped", 0, "load", 0x3000n),
          access("must-not-run", 0, "load", 0x1004n),
        ],
        [access("other-core", 1, "load", 0x2000n)],
      ),
    );
    expect(result.status).toBe("faulted");
    expect(result.cores[0].accesses.map((item) => item.status)).toEqual([
      "resolved",
      "fault",
      "skipped-after-fault",
    ]);
    expect(result.cores[0].accesses[1]).toMatchObject({
      fault: { kind: "unmapped", atAddress: 0x3000n },
      issuedEventIds: [],
    });
    expect(result.cores[0].accesses[2]).toMatchObject({
      blockedByAccessId: "unmapped",
      issuedEventIds: [],
    });
    expect(result.issuedEvents.some((issued) =>
      (issued.origin.kind === "cache" || issued.origin.kind === "mmio") &&
      issued.origin.accessId === "must-not-run"
    )).toBe(false);
    expect(result.execution.events.some((event) => event.eventId.includes("other-core"))).toBe(true);
    expect(result.execution.status).toBe("complete");
  });
});

describe("claims and repeatability", () => {
  test("never upgrades architecture calibration and emits stable machine JSON", () => {
    const config = configuration();
    const traces = input(
      [access("flash", 0, "instruction-fetch", 0x4000n), access("uart", 0, "store", 0x6000n)],
      [access("sram", 1, "load", 0x1000n)],
      [dma("panel", 4n)],
    );
    const first = runTimingMachine(config, traces);
    const second = runTimingMachine(config, traces);
    expect(second).toEqual(first);
    expect(timingMachineJson(second)).toBe(timingMachineJson(first));
    expect(() => JSON.parse(timingMachineJson(first))).not.toThrow();
    expect(first.claim).toMatchObject({
      architectureCalibration: "uncalibrated",
      architectureSources: [
        { component: "address-map", source: "synthetic-machine-address-map" },
        { component: "cache", source: "synthetic-machine-cache" },
      ],
      costCalibration: "calibrated",
    });
  });
});
