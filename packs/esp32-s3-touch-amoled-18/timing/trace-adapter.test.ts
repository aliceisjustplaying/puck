import { describe, expect, test } from "bun:test";
import type { AddressMapConfiguration } from "./address-map";
import {
  ESP32_S3_CACHE_BANK_TOPOLOGY,
  type CacheConfiguration,
  type CacheLatency,
} from "./cache";
import type { DmaEvent } from "./execution";
import type { TimingMachineConfiguration } from "./machine";
import { runtimeTimingResultJson, runRuntimeTimingTrace } from "./runtime-trace";
import {
  adaptNeutralTimingTrace,
  XTENSA_MEMW_INSTRUCTION_ENCODING,
  type BoundedNeutralTrace,
  type NeutralTraceObservation,
} from "./trace-adapter";

const DIGEST = "a".repeat(64);

function observation(
  id: string,
  sequence: number,
  core: 0 | 1,
  kind: NeutralTraceObservation["kind"],
  address: bigint,
  width: number,
): NeutralTraceObservation {
  return { id, sequence, core, kind, address, width };
}

function neutral(observations: readonly NeutralTraceObservation[]): BoundedNeutralTrace {
  return {
    schemaVersion: 1,
    capacity: observations.length,
    overflow: false,
    provenance: {
      source: "synthetic-neutral-trace",
      format: "synthetic-v1",
      digest: { algorithm: "sha256", value: DIGEST },
    },
    observations,
  };
}

function unknown(component: string): CacheLatency {
  return {
    status: "unknown",
    reason: `${component} has no adopted cost`,
    source: "synthetic-unknown-costs",
  };
}

function known(cycles: bigint, source = "caller-instruction-cost"): CacheLatency {
  return { status: "known", cycles, calibration: "uncalibrated", source };
}

function configuration(costFor: (component: string) => CacheLatency = unknown): TimingMachineConfiguration {
  const addressMap: AddressMapConfiguration = {
    addressBits: 32,
    metadata: { architectureCalibration: "uncalibrated", source: "synthetic-map" },
    regions: [{
      id: "sram",
      base: 0x1000n,
      size: 0x1000n,
      kind: "sram",
      permissions: { read: true, write: true, execute: true },
      cacheability: "uncached",
      physical: { backingId: "sram", offset: 0n },
    }],
  };
  const cache: CacheConfiguration = {
    addressBits: 32,
    metadata: { architectureCalibration: "uncalibrated", source: "synthetic-cache" },
    topology: ESP32_S3_CACHE_BANK_TOPOLOGY,
    instruction: {
      lineSizeBytes: 16,
      sets: 1,
      ways: 1,
      replacement: "least-recently-used",
      writePolicy: "read-only",
    },
    data: {
      lineSizeBytes: 16,
      sets: 1,
      ways: 1,
      replacement: "least-recently-used",
      writePolicy: "write-back",
      allocateOnStoreMiss: true,
      dirtyInvalidate: "writeback",
    },
    costs: {
      hit: {
        instructionFetch: costFor("instruction hit"),
        load: costFor("load hit"),
        store: costFor("store hit"),
      },
      lineFill: costFor("line fill"),
      dirtyWriteback: costFor("writeback"),
      writeThrough: costFor("write through"),
      uncached: {
        instructionFetch: costFor("uncached instruction"),
        load: costFor("uncached load"),
        store: costFor("uncached store"),
      },
      sram: {
        instructionFetch: costFor("SRAM instruction"),
        load: costFor("SRAM load"),
        store: costFor("SRAM store"),
      },
      maintenance: costFor("maintenance"),
    },
  };
  return { addressMap, cache, mmioCost: () => costFor("MMIO") };
}

function dma(): DmaEvent {
  return {
    id: "panel-dma",
    kind: "dma",
    channel: "panel",
    earliest: { cycle: 0n, calibration: "uncalibrated", source: "caller DMA readiness" },
    source: { kind: "memory", memory: "sram" },
    destination: { kind: "mmio", peripheral: "panel" },
    bytes: 64,
    latency: { status: "unknown", reason: "caller supplied no DMA cost" },
  };
}

describe("bounded neutral timing trace adapter", () => {
  test("preserves explicit two-core streams, total order, IDs, and provenance", () => {
    const trace = adaptNeutralTimingTrace(neutral([
      observation("core-1-write", 2, 1, "write", 0x1104n, 2),
      observation("core-1-read", 0, 1, "read", 0x1100n, 4),
      observation("core-0-instruction", 1, 0, "instruction", 0x1000n, 3),
    ]));

    expect(trace.input.cores.map((core) => core.map((access) => access.id))).toEqual([
      ["core-0-instruction"],
      ["core-1-read", "core-1-write"],
    ]);
    expect(trace.input.architecturalInterleave).toEqual([
      "core-1-read",
      "core-0-instruction",
      "core-1-write",
    ]);
    expect(trace.observationOrder).toEqual([
      { sequence: 0, kind: "memory", accessId: "core-1-read" },
      { sequence: 1, kind: "memory", accessId: "core-0-instruction" },
      {
        sequence: 2,
        kind: "cpu",
        eventId: "core-0-instruction:cpu",
        instructionAccessId: "core-0-instruction",
      },
      { sequence: 3, kind: "memory", accessId: "core-1-write" },
    ]);
    expect(trace.input.cpu).toEqual([{
      id: "core-0-instruction:cpu",
      kind: "cpu",
      core: 0,
      instructionAccessId: "core-0-instruction",
      latency: {
        status: "unknown",
        reason: "instruction core-0-instruction has no caller-supplied CPU cost",
        source: "synthetic-neutral-trace",
      },
    }]);
    expect(trace.provenance).toEqual({
      source: "synthetic-neutral-trace",
      format: "synthetic-v1",
      digest: { algorithm: "sha256", value: DIGEST },
      bounds: { capacity: 3, observed: 3, overflow: false },
      extensions: [],
    });
    expect(trace.claim).toMatchObject({
      coverage: "caller-reported-events-only",
      cycleAccurate: false,
      countsOnlyInstrumentedEvents: true,
    });
  });

  test("rejects duplicate and gapped total observation order", () => {
    expect(() => adaptNeutralTimingTrace(neutral([
      observation("a", 0, 0, "read", 0x1000n, 4),
      observation("b", 0, 1, "read", 0x1004n, 4),
    ]))).toThrow("neutral trace total observation order must contain sequence 1 exactly once");
    expect(() => adaptNeutralTimingTrace(neutral([
      observation("a", 1, 0, "read", 0x1000n, 4),
    ]))).toThrow("neutral trace total observation order must contain sequence 0 exactly once");
  });

  test("retains overflow and refuses records beyond the declared bound", () => {
    const bounded = {
      ...neutral([observation("only", 0, 0, "read", 0x1000n, 4)]),
      overflow: true,
    };
    expect(adaptNeutralTimingTrace(bounded).provenance?.bounds).toEqual({
      capacity: 1,
      observed: 1,
      overflow: true,
    });
    expect(() => adaptNeutralTimingTrace({ ...bounded, capacity: 0 })).toThrow(
      "neutral trace observed 1 records beyond capacity 0",
    );
  });

  test("rejects unsupported kinds and widths at the neutral boundary", () => {
    expect(() => adaptNeutralTimingTrace(neutral([
      observation("bad-kind", 0, 0, "maintenance" as NeutralTraceObservation["kind"], 0x1000n, 4),
    ]))).toThrow("neutral trace observations[0].kind must be instruction, read, or write");
    expect(() => adaptNeutralTimingTrace(neutral([
      observation("bad-instruction", 0, 0, "instruction", 0x1000n, 4),
    ]))).toThrow("neutral trace observations[0].width 4 is unsupported for instruction");
    expect(() => adaptNeutralTimingTrace(neutral([
      observation("bad-data", 0, 0, "read", 0x1000n, 3),
    ]))).toThrow("neutral trace observations[0].width 3 is unsupported for read");
    expect(() => adaptNeutralTimingTrace(neutral([{
      ...observation("costed-read", 0, 0, "read", 0x1000n, 4),
      cpuCost: known(1n),
    }]))).toThrow("neutral trace observations[0].cpuCost is only valid for an instruction observation");
  });

  test("keeps literal loads behind a caller-sourced read extension", () => {
    const ordinary = observation("ordinary", 0, 0, "read", 0x1000n, 4);
    const literal: NeutralTraceObservation = {
      ...observation("literal", 1, 0, "read", 0x1004n, 4),
      extension: { kind: "literal-load", source: "caller decoder classification" },
    };
    const trace = adaptNeutralTimingTrace(neutral([ordinary, literal]));
    expect(trace.input.cores[0].map((access) => access.kind)).toEqual(["load", "literal-load"]);
    expect(trace.provenance?.extensions).toEqual([{
      accessId: "literal",
      kind: "literal-load",
      source: "caller decoder classification",
    }]);

    expect(() => adaptNeutralTimingTrace(neutral([{
      ...observation("instruction", 0, 0, "instruction", 0x1000n, 2),
      extension: { kind: "literal-load", source: "invalid extension" },
    }]))).toThrow("neutral trace observations[0] literal-load extension requires a read observation");
  });

  test("coexists with explicitly ordered DMA without inventing a transfer", () => {
    const trace = adaptNeutralTimingTrace(neutral([
      observation("before", 0, 0, "read", 0x1000n, 4),
      observation("after", 2, 1, "write", 0x1004n, 4),
    ]), [{ sequence: 1, event: dma() }]);
    expect(trace.input.dma.map((event) => event.id)).toEqual(["panel-dma"]);
    expect(trace.input.issueOrder).toEqual([
      { kind: "memory", accessId: "before" },
      { kind: "dma", eventId: "panel-dma" },
      { kind: "memory", accessId: "after" },
    ]);
    expect(trace.observationOrder.map((entry) => entry.kind)).toEqual(["memory", "dma", "memory"]);
  });

  test("retains unknown costs and refuses cycle claims", () => {
    const trace = adaptNeutralTimingTrace(neutral([
      observation("fetch", 0, 0, "instruction", 0x1000n, 2),
      observation("read", 1, 0, "read", 0x1004n, 4),
      observation("write", 2, 0, "write", 0x1008n, 4),
    ]));
    const result = runRuntimeTimingTrace(configuration(), trace);
    expect(result.status).toBe("blocked");
    expect(result.claim.costCalibration).toBe("unknown");
    expect(result.claim.cycleAccurate).toBe(false);
    expect(result.claim.coverage).toBe("caller-reported-events-only");
    expect(result.claim.unknownCostEventIds).toHaveLength(4);
    expect(result.provenance).toEqual(trace.provenance);
  });

  test("lets an unknown instruction cost finish its group, block its core, and leave the other core independent", () => {
    const trace = adaptNeutralTimingTrace(neutral([
      observation("instruction", 0, 0, "instruction", 0x1000n, 2),
      observation("instruction-read", 1, 0, "read", 0x1004n, 4),
      observation("other-core-read", 2, 1, "read", 0x1100n, 4),
      {
        ...observation("next-instruction", 3, 0, "instruction", 0x1008n, 2),
        cpuCost: known(1n, "caller-next-instruction-cost"),
      },
    ]));
    const result = runRuntimeTimingTrace(configuration(() => known(1n, "known-memory-cost")), trace);
    expect(result.status).toBe("blocked");
    expect(result.claim.costCalibration).toBe("unknown");
    expect(result.claim.cycleAccurate).toBe(false);
    expect(result.claim.unknownCostEventIds).toEqual(["instruction:cpu"]);
    expect(result.claim.costProvenance.find((cost) => cost.eventId === "instruction:cpu")).toEqual({
      status: "unknown",
      eventId: "instruction:cpu",
      calibration: "unknown",
      reason: "instruction instruction has no caller-supplied CPU cost",
      source: "synthetic-neutral-trace",
    });
    expect(result.execution.events.map((event) => [event.eventId, event.status])).toEqual([
      ["cache:instruction:segment:0:cache:0:sram-bypass", "completed"],
      ["cache:other-core-read:segment:0:cache:0:sram-bypass", "completed"],
      ["cache:instruction-read:segment:0:cache:0:sram-bypass", "completed"],
      ["instruction:cpu", "started-unknown-duration"],
      ["cache:next-instruction:segment:0:cache:0:sram-bypass", "blocked"],
      ["next-instruction:cpu", "blocked"],
    ]);
  });

  test("serializes supplied CPU costs after each instruction's fetch and data while other cores progress", () => {
    const trace = adaptNeutralTimingTrace(neutral([
      { ...observation("c0-instruction", 0, 0, "instruction", 0x1000n, 2), cpuCost: known(3n, "c0-cost") },
      { ...observation("c1-instruction", 1, 1, "instruction", 0x1100n, 2), cpuCost: known(2n, "c1-cost") },
      observation("c0-read", 2, 0, "read", 0x1004n, 4),
      observation("c1-write", 3, 1, "write", 0x1104n, 4),
      { ...observation("c0-next", 4, 0, "instruction", 0x1008n, 2), cpuCost: known(1n, "c0-next-cost") },
    ]));
    expect(trace.input.issueOrder).toEqual([
      { kind: "memory", accessId: "c0-instruction" },
      { kind: "memory", accessId: "c1-instruction" },
      { kind: "memory", accessId: "c0-read" },
      { kind: "cpu", eventId: "c0-instruction:cpu" },
      { kind: "memory", accessId: "c1-write" },
      { kind: "cpu", eventId: "c1-instruction:cpu" },
      { kind: "memory", accessId: "c0-next" },
      { kind: "cpu", eventId: "c0-next:cpu" },
    ]);

    const result = runRuntimeTimingTrace(configuration(() => known(1n, "known-memory-cost")), trace);
    expect(result.status).toBe("complete");
    const windows = Object.fromEntries(result.execution.events.map((event) => [
      event.eventId,
      event.status === "completed" ? [event.startCycle, event.endCycle] : event.status,
    ]));
    expect(windows).toMatchObject({
      "cache:c0-instruction:segment:0:cache:0:sram-bypass": [0n, 1n],
      "cache:c0-read:segment:0:cache:0:sram-bypass": [1n, 2n],
      "c0-instruction:cpu": [2n, 5n],
      "cache:c0-next:segment:0:cache:0:sram-bypass": [5n, 6n],
      "c0-next:cpu": [6n, 7n],
      "cache:c1-instruction:segment:0:cache:0:sram-bypass": [0n, 1n],
      "cache:c1-write:segment:0:cache:0:sram-bypass": [1n, 2n],
      "c1-instruction:cpu": [2n, 4n],
    });
    expect(result.claim.costProvenance.filter((cost) => cost.eventId.endsWith(":cpu"))).toEqual([
      { status: "known", eventId: "c0-instruction:cpu", calibration: "uncalibrated", cycles: 3n, source: "c0-cost" },
      { status: "known", eventId: "c1-instruction:cpu", calibration: "uncalibrated", cycles: 2n, source: "c1-cost" },
      { status: "known", eventId: "c0-next:cpu", calibration: "uncalibrated", cycles: 1n, source: "c0-next-cost" },
    ]);
    expect(
      JSON.parse(runtimeTimingResultJson(result)).claim.costProvenance
        .filter((cost: { eventId: string }) => cost.eventId.endsWith(":cpu"))
        .map((cost: { cycles: string; source: string }) => [cost.cycles, cost.source]),
    ).toEqual([
      ["3", "c0-cost"],
      ["2", "c1-cost"],
      ["1", "c0-next-cost"],
    ]);
  });

  test("retires an opted-in Flexe-style write and holds exact memw until its drain", () => {
    const instructionEncoding = (value: number) => Object.freeze({
      value,
      source: "synthetic Flexe ABI instruction field",
    });
    const trace = adaptNeutralTimingTrace(neutral([
      {
        ...observation("store-instruction", 0, 0, "instruction", 0x1000n, 3),
        cpuCost: known(1n, "store instruction cost"),
        instructionEncoding: instructionEncoding(0x123456),
      },
      {
        ...observation("write", 1, 0, "write", 0x1100n, 4),
        issuingInstructionAddress: 0x1000n,
      },
      {
        ...observation("memw", 2, 0, "instruction", 0x1003n, 3),
        instructionEncoding: instructionEncoding(XTENSA_MEMW_INSTRUCTION_ENCODING),
      },
    ]), [], {
      storeBuffer: {
        retirementLatency: known(1n, "store retirement cost"),
        memwLatency: known(2n, "memw cost"),
      },
    });

    expect(trace.input.cores[0][1]?.storeBuffer).toEqual({
      retirementLatency: known(1n, "store retirement cost"),
    });
    expect(trace.input.cpu?.map((event) => event.id)).toEqual(["store-instruction:cpu"]);
    expect(trace.input.fence).toEqual([{
      id: "memw:fence",
      kind: "fence",
      core: 0,
      operation: "memw",
      instructionAccessId: "memw",
      latency: known(2n, "memw cost"),
    }]);
    expect(trace.input.issueOrder).toEqual([
      { kind: "memory", accessId: "store-instruction" },
      { kind: "memory", accessId: "write" },
      { kind: "cpu", eventId: "store-instruction:cpu" },
      { kind: "memory", accessId: "memw" },
      { kind: "fence", eventId: "memw:fence" },
    ]);

    const result = runRuntimeTimingTrace(configuration((component) =>
      known(component === "SRAM store" ? 5n : 1n, `known ${component}`),
    ), trace);
    expect(result.execution.events.map((event) => [
      event.eventId,
      event.status === "completed" ? event.startCycle : event.status,
      event.status === "completed" ? event.endCycle : event.status,
    ])).toEqual([
      ["cache:store-instruction:segment:0:cache:0:sram-bypass", 0n, 1n],
      ["cache:write:segment:0:cache:0:sram-bypass", 1n, 2n],
      ["cache:write:segment:0:cache:0:sram-bypass:drain", 2n, 7n],
      ["store-instruction:cpu", 2n, 3n],
      ["cache:memw:segment:0:cache:0:sram-bypass", 3n, 4n],
      ["memw:fence", 7n, 9n],
    ]);
    expect(result.claim.costProvenance.filter((cost) =>
      cost.eventId.includes("cache:write"),
    )).toEqual([
      {
        status: "known",
        eventId: "cache:write:segment:0:cache:0:sram-bypass",
        calibration: "uncalibrated",
        cycles: 1n,
        source: "store retirement cost",
      },
      {
        status: "known",
        eventId: "cache:write:segment:0:cache:0:sram-bypass:drain",
        calibration: "uncalibrated",
        cycles: 5n,
        source: "known SRAM store",
      },
    ]);
    expect(result.provenance?.extensions).toEqual([{
      accessId: "memw",
      kind: "memw",
      source: "synthetic Flexe ABI instruction field",
    }]);
  });

  test("keeps store buffering opt-in and fails closed on incomplete instruction identity", () => {
    const rawMemw: NeutralTraceObservation = {
      ...observation("memw", 0, 0, "instruction", 0x1000n, 3),
      cpuCost: known(1n),
      instructionEncoding: {
        value: XTENSA_MEMW_INSTRUCTION_ENCODING,
        source: "synthetic encoding",
      },
    };
    const defaultTrace = adaptNeutralTimingTrace(neutral([rawMemw]));
    expect(defaultTrace.input.fence).toBeUndefined();
    expect(defaultTrace.input.cpu?.map((event) => event.id)).toEqual(["memw:cpu"]);

    const options = {
      storeBuffer: {
        retirementLatency: known(1n, "retirement"),
        memwLatency: known(1n, "memw"),
      },
    } as const;
    expect(() => adaptNeutralTimingTrace(neutral([
      observation("missing-encoding", 0, 0, "instruction", 0x1000n, 3),
    ]), [], options)).toThrow("instructionEncoding is required in store-buffer mode");
    expect(() => adaptNeutralTimingTrace(neutral([{
      ...observation("orphan-write", 0, 0, "write", 0x1100n, 4),
      issuingInstructionAddress: 0x1000n,
    }]), [], options)).toThrow("has no preceding instruction");
    expect(() => adaptNeutralTimingTrace(neutral([{
      ...rawMemw,
      width: 2,
      cpuCost: undefined,
    }]), [], options)).toThrow("memw encoding requires exact three-byte width");
    expect(() => adaptNeutralTimingTrace(neutral([
      {
        ...observation("instruction", 0, 0, "instruction", 0x1000n, 3),
        instructionEncoding: { value: 0x123456, source: "synthetic encoding" },
      },
      {
        ...observation("wrong-owner", 1, 0, "write", 0x1100n, 4),
        issuingInstructionAddress: 0x1003n,
      },
    ]), [], options)).toThrow("issuing PC does not match its preceding instruction");
    expect(() => adaptNeutralTimingTrace(neutral([
      { ...rawMemw, cpuCost: undefined },
      {
        ...observation("memw-data", 1, 0, "read", 0x1100n, 4),
        issuingInstructionAddress: 0x1000n,
      },
    ]), [], options)).toThrow("memw instruction cannot own data observation memw-data");
    expect(() => adaptNeutralTimingTrace({ ...neutral([rawMemw]), overflow: true }, [], options)).toThrow(
      "store-buffer mode requires a complete non-overflow trace",
    );
  });
});
