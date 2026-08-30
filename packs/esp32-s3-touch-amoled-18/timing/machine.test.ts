import { describe, expect, test } from "bun:test";
import type { AddressMapConfiguration, AddressRegion, VirtualMemoryAccess } from "./address-map";
import {
  ESP32_S3_CACHE_BANK_TOPOLOGY,
  type CacheConfiguration,
  type CacheLatency,
} from "./cache";
import type { DmaEvent } from "./execution";
import {
  runTimingMachine,
  timingMachineJson,
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

function cache(lineFill: CacheLatency = known(10n)): CacheConfiguration {
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

function configuration(lineFill: CacheLatency = known(10n)): TimingMachineConfiguration {
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
    expect(result.issuedEvents.some((issued) => issued.origin.kind !== "dma" && issued.origin.accessId === "must-not-run")).toBe(false);
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
