import { describe, expect, test } from "bun:test";
import {
  CacheStateMachine,
  ESP32_S3_CACHE_BANK_TOPOLOGY,
  type CacheConfiguration,
  type CacheLineFillCost,
  type CacheLatency,
} from "./cache";
import { scheduleExecution, type ExecutionEvent } from "./execution";

const measured = (cycles: bigint): CacheLatency => ({
  status: "known",
  cycles,
  calibration: "calibrated",
  source: "synthetic-test-receipt",
});

function configuration(
  overrides: Partial<{
    replacement: "least-recently-used" | "round-robin";
    dataWritePolicy: "write-back" | "write-through";
    allocateOnStoreMiss: boolean;
    dirtyInvalidate: "writeback" | "discard";
    lineFill: CacheLineFillCost;
    ways: number;
    instructionSharing: "per-core" | "shared";
    dataSharing: "per-core" | "shared";
  }> = {},
): CacheConfiguration {
  return {
    addressBits: 32,
    metadata: {
      architectureCalibration: "uncalibrated",
      source: "schema-only-cache-architecture",
    },
    topology: {
      instruction: overrides.instructionSharing ?? ESP32_S3_CACHE_BANK_TOPOLOGY.instruction,
      data: overrides.dataSharing ?? ESP32_S3_CACHE_BANK_TOPOLOGY.data,
    },
    instruction: {
      lineSizeBytes: 16,
      sets: 1,
      ways: overrides.ways ?? 2,
      replacement: overrides.replacement ?? "least-recently-used",
      writePolicy: "read-only",
    },
    data: {
      lineSizeBytes: 16,
      sets: 1,
      ways: overrides.ways ?? 2,
      replacement: overrides.replacement ?? "least-recently-used",
      writePolicy: overrides.dataWritePolicy ?? "write-back",
      allocateOnStoreMiss: overrides.allocateOnStoreMiss ?? true,
      dirtyInvalidate: overrides.dirtyInvalidate ?? "writeback",
    },
    costs: {
      hit: {
        instructionFetch: measured(1n),
        load: measured(1n),
        store: measured(1n),
      },
      lineFill: overrides.lineFill ?? measured(8n),
      dirtyWriteback: measured(9n),
      writeThrough: measured(6n),
      uncached: {
        instructionFetch: measured(7n),
        load: measured(7n),
        store: measured(7n),
      },
      sram: {
        instructionFetch: measured(2n),
        load: measured(2n),
        store: measured(2n),
      },
      maintenance: measured(2n),
    },
  };
}

function events(step: ReturnType<CacheStateMachine["process"]>): ExecutionEvent[] {
  return step.emissions.map((emission) => emission.event);
}

function kinds(step: ReturnType<CacheStateMachine["process"]>): string[] {
  return step.emissions.map((emission) => emission.kind);
}

describe("configuration and address boundaries", () => {
  test("requires every geometry, policy, source, and latency input", () => {
    const noLineSize = configuration() as unknown as { instruction: { lineSizeBytes?: number } };
    delete noLineSize.instruction.lineSizeBytes;
    expect(() => new CacheStateMachine(noLineSize as unknown as CacheConfiguration)).toThrow(
      "instruction.lineSizeBytes must be a positive safe integer",
    );

    const noFillCost = configuration() as unknown as { costs: { lineFill?: CacheLatency } };
    delete noFillCost.costs.lineFill;
    expect(() => new CacheStateMachine(noFillCost as unknown as CacheConfiguration)).toThrow(
      "lineFill is required; the cache model has no default latency",
    );

    const noTopology = configuration() as unknown as { topology?: CacheConfiguration["topology"] };
    delete noTopology.topology;
    expect(() => new CacheStateMachine(noTopology as unknown as CacheConfiguration)).toThrow(
      "config.topology is required",
    );

    const invalidTopology = configuration() as unknown as {
      topology: { instruction: string; data: string };
    };
    invalidTopology.topology.data = "clustered";
    expect(() => new CacheStateMachine(invalidTopology as unknown as CacheConfiguration)).toThrow(
      "config.topology.data must be per-core or shared",
    );

    const architectureOverclaim = configuration() as unknown as {
      metadata: { architectureCalibration: string };
    };
    architectureOverclaim.metadata.architectureCalibration = "calibrated";
    expect(() => new CacheStateMachine(architectureOverclaim as unknown as CacheConfiguration)).toThrow(
      "architectureCalibration must remain uncalibrated",
    );
  });

  test("uses bigint addresses and rejects overflow of the configured address space", () => {
    const machine = new CacheStateMachine(configuration());
    expect(() =>
      machine.process({
        id: "number-address",
        kind: "load",
        core: 0,
        memory: "psram",
        address: 3 as unknown as bigint,
        bytes: 1,
        cacheability: "cached",
      }),
    ).toThrow("address must be a non-negative bigint");
    expect(() =>
      machine.process({
        id: "overflow",
        kind: "load",
        core: 0,
        memory: "psram",
        address: 0xffff_ffffn,
        bytes: 2,
        cacheability: "cached",
      }),
    ).toThrow("exceeds the configured 32-bit address space");

    expect(() =>
      machine.process({
        id: "invalid-memory",
        kind: "load",
        core: 0,
        memory: "rom" as unknown as "flash",
        address: 0n,
        bytes: 1,
        cacheability: "cached",
      }),
    ).toThrow("memory must be sram, psram, or flash");
  });
});

describe("line boundaries and bank topology", () => {
  test("splits a cross-line instruction fetch exactly and fills both lines", () => {
    const machine = new CacheStateMachine(configuration());
    const first = machine.process({
      id: "cross",
      kind: "instruction-fetch",
      core: 0,
      memory: "flash",
      address: 14n,
      bytes: 4,
      cacheability: "cached",
    });
    expect(kinds(first)).toEqual(["line-fill", "hit", "line-fill", "hit"]);
    expect(first.emissions.map((emission) => [emission.address, emission.bytes, emission.lineAddress])).toEqual([
      [0n, 16, 0n],
      [14n, 2, 0n],
      [16n, 16, 16n],
      [16n, 2, 16n],
    ]);
    expect(first.emissions.filter((emission) => emission.kind === "line-fill").map((emission) => emission.event.kind)).toEqual([
      "instruction-fetch",
      "instruction-fetch",
    ]);

    const second = machine.process({
      id: "cross-again",
      kind: "instruction-fetch",
      core: 0,
      memory: "flash",
      address: 14n,
      bytes: 4,
      cacheability: "cached",
    });
    expect(kinds(second)).toEqual(["hit", "hit"]);
  });

  test("selects line-fill cost by cache kind and external backing", () => {
    const lineFill: CacheLineFillCost = {
      instruction: { flash: measured(11n), psram: measured(12n) },
      data: { flash: measured(21n), psram: measured(22n) },
    };
    const cases = [
      { kind: "instruction-fetch" as const, memory: "flash" as const, cycles: 11n },
      { kind: "instruction-fetch" as const, memory: "psram" as const, cycles: 12n },
      { kind: "load" as const, memory: "flash" as const, cycles: 21n },
      { kind: "load" as const, memory: "psram" as const, cycles: 22n },
    ];
    for (const [index, candidate] of cases.entries()) {
      const step = new CacheStateMachine(configuration({ lineFill })).process({
        id: `scoped-fill-${index}`,
        core: 0,
        kind: candidate.kind,
        memory: candidate.memory,
        address: 0n,
        bytes: 4,
        cacheability: "cached",
      });
      expect(step.emissions[0]).toMatchObject({
        kind: "line-fill",
        cost: { status: "known", cycles: candidate.cycles },
      });
    }
  });

  test("models per-core instruction banks and one shared data bank", () => {
    const machine = new CacheStateMachine(configuration());
    const traces = [
      machine.process({ id: "c0d", kind: "load", core: 0, memory: "psram", address: 0n, bytes: 4, cacheability: "cached" }),
      machine.process({ id: "c1d", kind: "load", core: 1, memory: "psram", address: 0n, bytes: 4, cacheability: "cached" }),
      machine.process({ id: "c0i", kind: "instruction-fetch", core: 0, memory: "flash", address: 0n, bytes: 4, cacheability: "cached" }),
      machine.process({ id: "c1i", kind: "instruction-fetch", core: 1, memory: "flash", address: 0n, bytes: 4, cacheability: "cached" }),
    ];
    expect(traces.map(kinds)).toEqual([
      ["line-fill", "hit"],
      ["hit"],
      ["line-fill", "hit"],
      ["line-fill", "hit"],
    ]);
    expect(
      kinds(machine.process({ id: "c0d-hit", kind: "load", core: 0, memory: "psram", address: 0n, bytes: 4, cacheability: "cached" })),
    ).toEqual(["hit"]);
  });

  test("keeps bank sharing configurable for non-board experiments", () => {
    const machine = new CacheStateMachine(configuration({ dataSharing: "per-core" }));
    const core0 = machine.process({
      id: "private-c0",
      kind: "load",
      core: 0,
      memory: "psram",
      address: 0n,
      bytes: 4,
      cacheability: "cached",
    });
    const core1 = machine.process({
      id: "private-c1",
      kind: "load",
      core: 1,
      memory: "psram",
      address: 0n,
      bytes: 4,
      cacheability: "cached",
    });
    expect([kinds(core0), kinds(core1)]).toEqual([
      ["line-fill", "hit"],
      ["line-fill", "hit"],
    ]);
  });

  test("keeps flash and PSRAM lines with the same address distinct in one data cache", () => {
    const machine = new CacheStateMachine(configuration());
    const flash = machine.process({
      id: "data-flash",
      kind: "load",
      core: 0,
      memory: "flash",
      address: 0n,
      bytes: 4,
      cacheability: "cached",
    });
    const psram = machine.process({
      id: "data-psram",
      kind: "load",
      core: 0,
      memory: "psram",
      address: 0n,
      bytes: 4,
      cacheability: "cached",
    });
    expect(flash.emissions[0]?.event).toMatchObject({ kind: "load", memory: "flash", bytes: 16 });
    expect(psram.emissions[0]?.event).toMatchObject({ kind: "load", memory: "psram", bytes: 16 });
    expect(
      kinds(machine.process({ id: "flash-hit", kind: "load", core: 0, memory: "flash", address: 0n, bytes: 4, cacheability: "cached" })),
    ).toEqual(["hit"]);
    expect(
      kinds(machine.process({ id: "psram-hit", kind: "load", core: 0, memory: "psram", address: 0n, bytes: 4, cacheability: "cached" })),
    ).toEqual(["hit"]);
  });

  test("bypasses external cache state and MSPI for internal SRAM", () => {
    const machine = new CacheStateMachine(configuration());
    const sram = machine.process({
      id: "sram-cross-line",
      kind: "load",
      core: 1,
      memory: "sram",
      address: 15n,
      bytes: 3,
      cacheability: "cached",
    });
    expect(kinds(sram)).toEqual(["sram-bypass"]);
    expect(sram.emissions[0]).toMatchObject({
      address: 15n,
      bytes: 3,
      lineAddress: null,
      event: { kind: "load", memory: "sram", bytes: 3 },
    });
    const schedule = scheduleExecution(events(sram));
    expect(schedule.events[0]).toMatchObject({ status: "completed", resource: null });
    expect(schedule.finalClocks.mspi).toEqual({
      status: "known",
      cycle: 0n,
      calibration: "calibrated",
    });
  });
});

describe("replacement and writes", () => {
  test("uses deterministic LRU replacement and writes back a dirty victim before filling", () => {
    const run = (): string[] => {
      const machine = new CacheStateMachine(configuration());
      machine.process({ id: "store-0", kind: "store", core: 0, memory: "psram", address: 0n, bytes: 4, cacheability: "cached" });
      machine.process({ id: "store-16", kind: "store", core: 0, memory: "psram", address: 16n, bytes: 4, cacheability: "cached" });
      machine.process({ id: "touch-0", kind: "load", core: 0, memory: "psram", address: 0n, bytes: 4, cacheability: "cached" });
      const eviction = machine.process({
        id: "load-32",
        kind: "load",
        core: 0,
        memory: "psram",
        address: 32n,
        bytes: 4,
        cacheability: "cached",
      });
      expect(eviction.emissions[0]).toMatchObject({
        kind: "dirty-writeback",
        address: 16n,
        bytes: 16,
        lineAddress: 16n,
        event: { kind: "store", memory: "psram", bytes: 16 },
      });
      return eviction.emissions.map(
        (emission) => `${emission.kind}:${emission.address?.toString()}:${emission.event.id}`,
      );
    };
    expect(run()).toEqual(run());
  });

  test("writes a dirty mixed-region victim back to the region that supplied its line", () => {
    const machine = new CacheStateMachine(configuration({ ways: 1 }));
    machine.process({
      id: "dirty-psram",
      kind: "store",
      core: 0,
      memory: "psram",
      address: 0n,
      bytes: 4,
      cacheability: "cached",
    });
    const replaceWithFlash = machine.process({
      id: "replace-with-flash",
      kind: "load",
      core: 0,
      memory: "flash",
      address: 0n,
      bytes: 4,
      cacheability: "cached",
    });
    expect(kinds(replaceWithFlash)).toEqual(["dirty-writeback", "line-fill", "hit"]);
    expect(replaceWithFlash.emissions[0]?.event).toMatchObject({
      kind: "store",
      memory: "psram",
      bytes: 16,
    });
    expect(replaceWithFlash.emissions[1]?.event).toMatchObject({
      kind: "load",
      memory: "flash",
      bytes: 16,
    });
  });

  test("pins round-robin replacement independently of hits", () => {
    const machine = new CacheStateMachine(configuration({ replacement: "round-robin" }));
    machine.process({ id: "rr-0", kind: "load", core: 0, memory: "psram", address: 0n, bytes: 1, cacheability: "cached" });
    machine.process({ id: "rr-16", kind: "load", core: 0, memory: "psram", address: 16n, bytes: 1, cacheability: "cached" });
    machine.process({ id: "rr-hit-0", kind: "load", core: 0, memory: "psram", address: 0n, bytes: 1, cacheability: "cached" });
    machine.process({ id: "rr-32", kind: "load", core: 0, memory: "psram", address: 32n, bytes: 1, cacheability: "cached" });
    const zeroAgain = machine.process({
      id: "rr-zero-again",
      kind: "load",
      core: 0,
      memory: "psram",
      address: 0n,
      bytes: 1,
      cacheability: "cached",
    });
    expect(kinds(zeroAgain)).toEqual(["line-fill", "hit"]);
  });

  test("honors explicit write-through without write allocation", () => {
    const machine = new CacheStateMachine(
      configuration({ dataWritePolicy: "write-through", allocateOnStoreMiss: false }),
    );
    const store = machine.process({
      id: "wt-store",
      kind: "store",
      core: 0,
      memory: "psram",
      address: 0n,
      bytes: 4,
      cacheability: "cached",
    });
    expect(kinds(store)).toEqual(["write-through"]);
    expect(store.emissions[0]?.event).toMatchObject({ kind: "store", memory: "psram", bytes: 4 });
    expect(
      kinds(machine.process({ id: "wt-load", kind: "load", core: 0, memory: "psram", address: 0n, bytes: 4, cacheability: "cached" })),
    ).toEqual(["line-fill", "hit"]);
  });

  test("labels a write-back store miss as uncached when allocation is disabled", () => {
    const machine = new CacheStateMachine(configuration({ allocateOnStoreMiss: false }));
    const store = machine.process({
      id: "write-around",
      kind: "store",
      core: 0,
      memory: "psram",
      address: 0n,
      bytes: 4,
      cacheability: "cached",
    });
    expect(kinds(store)).toEqual(["uncached"]);
    expect(store.emissions[0]?.cost).toEqual(measured(7n));
  });

  test("rejects stores to memory-mapped flash before mutating cache state", () => {
    const machine = new CacheStateMachine(configuration());
    expect(() =>
      machine.process({
        id: "flash-store",
        kind: "store",
        core: 0,
        memory: "flash",
        address: 0n,
        bytes: 4,
        cacheability: "cached",
      }),
    ).toThrow("cannot store to memory-mapped flash");
  });
});

describe("maintenance and uncached paths", () => {
  test("flushes dirty lines without invalidating and invalidates with the configured writeback policy", () => {
    const machine = new CacheStateMachine(configuration());
    machine.process({ id: "dirty", kind: "store", core: 0, memory: "psram", address: 0n, bytes: 4, cacheability: "cached" });
    const flush = machine.process({ id: "flush", kind: "flush", core: 0, cache: "data", scope: { kind: "all" } });
    expect(kinds(flush)).toEqual(["dirty-writeback", "flush"]);
    expect(
      kinds(machine.process({ id: "after-flush", kind: "load", core: 0, memory: "psram", address: 0n, bytes: 4, cacheability: "cached" })),
    ).toEqual(["hit"]);

    machine.process({ id: "dirty-again", kind: "store", core: 0, memory: "psram", address: 0n, bytes: 4, cacheability: "cached" });
    const invalidate = machine.process({
      id: "invalidate",
      kind: "invalidate",
      core: 0,
      cache: "data",
      scope: { kind: "range", address: 1n, bytes: 1 },
    });
    expect(kinds(invalidate)).toEqual(["dirty-writeback", "invalidate"]);
    expect(
      kinds(machine.process({ id: "after-invalidate", kind: "load", core: 0, memory: "psram", address: 0n, bytes: 4, cacheability: "cached" })),
    ).toEqual(["line-fill", "hit"]);
  });

  test("discards dirty data only when that invalidate policy is explicit", () => {
    const machine = new CacheStateMachine(configuration({ dirtyInvalidate: "discard" }));
    machine.process({ id: "dirty", kind: "store", core: 0, memory: "psram", address: 0n, bytes: 4, cacheability: "cached" });
    const invalidate = machine.process({
      id: "discard",
      kind: "invalidate",
      core: 0,
      cache: "data",
      scope: { kind: "all" },
    });
    expect(kinds(invalidate)).toEqual(["invalidate"]);
  });

  test("splits uncached cross-line accesses without changing cache state", () => {
    const machine = new CacheStateMachine(configuration());
    const uncached = machine.process({
      id: "uncached",
      kind: "load",
      core: 0,
      memory: "psram",
      address: 15n,
      bytes: 3,
      cacheability: "uncached",
    });
    expect(kinds(uncached)).toEqual(["uncached", "uncached"]);
    expect(uncached.emissions.map((emission) => [emission.address, emission.bytes])).toEqual([
      [15n, 1],
      [16n, 2],
    ]);
    expect(
      kinds(machine.process({ id: "still-miss", kind: "load", core: 0, memory: "psram", address: 15n, bytes: 1, cacheability: "cached" })),
    ).toEqual(["line-fill", "hit"]);
  });
});

describe("execution integration and claim boundary", () => {
  test("routes flash and PSRAM fills through the execution layer's shared MSPI path", () => {
    const machine = new CacheStateMachine(configuration());
    const instruction = machine.process({
      id: "ifill",
      kind: "instruction-fetch",
      core: 0,
      memory: "flash",
      address: 0n,
      bytes: 4,
      cacheability: "cached",
    });
    const data = machine.process({
      id: "dfill",
      kind: "load",
      core: 1,
      memory: "psram",
      address: 0n,
      bytes: 4,
      cacheability: "cached",
    });
    const schedule = scheduleExecution([...events(instruction), ...events(data)]);
    const fills = schedule.events.filter((event) => event.resource === "mspi");
    expect(fills.map((event) => [event.kind, event.startCycle, event.endCycle])).toEqual([
      ["instruction-fetch", 0n, 8n],
      ["load", 8n, 16n],
    ]);
  });

  test("propagates an unknown fill cost and never upgrades architecture calibration", () => {
    const machine = new CacheStateMachine(
      configuration({
        lineFill: {
          status: "unknown",
          reason: "no line-fill measurement",
          source: "missing-hardware-receipt",
        },
      }),
    );
    const step = machine.process({
      id: "unknown-fill",
      kind: "load",
      core: 0,
      memory: "psram",
      address: 0n,
      bytes: 4,
      cacheability: "cached",
    });
    expect(step.claim).toEqual({
      architectureCalibration: "uncalibrated",
      source: "schema-only-cache-architecture",
      costCalibration: "unknown",
      uncalibratedCostEventIds: [],
      unknownCostEventIds: ["cache:unknown-fill:0:line-fill"],
    });
    expect(step.emissions[0]?.cost).toEqual({
      status: "unknown",
      reason: "no line-fill measurement",
      source: "missing-hardware-receipt",
    });
    const schedule = scheduleExecution(events(step));
    expect(schedule.events.map((event) => event.status)).toEqual([
      "started-unknown-duration",
      "blocked",
    ]);
    expect(schedule.calibration.status).toBe("unknown");
  });

  test("keeps the architecture claim uncalibrated even when every supplied cost is calibrated", () => {
    const step = new CacheStateMachine(configuration()).process({
      id: "all-measured-costs",
      kind: "load",
      core: 0,
      memory: "psram",
      address: 0n,
      bytes: 4,
      cacheability: "cached",
    });
    expect(step.claim.architectureCalibration).toBe("uncalibrated");
    expect(step.claim.costCalibration).toBe("calibrated");
  });
});
