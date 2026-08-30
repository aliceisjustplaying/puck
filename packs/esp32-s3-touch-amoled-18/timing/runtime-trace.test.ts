import { describe, expect, test } from "bun:test";
import type { AddressMapConfiguration } from "./address-map";
import {
  ESP32_S3_CACHE_BANK_TOPOLOGY,
  type CacheConfiguration,
  type CacheLatency,
} from "./cache";
import type { DmaEvent } from "./execution";
import type { TimingMachineConfiguration } from "./machine";
import {
  RuntimeTimingTraceRecorder,
  runRuntimeTimingTrace,
  type RuntimeMemoryObservation,
  type RuntimeTimingTrace,
} from "./runtime-trace";

const known = (cycles: bigint): CacheLatency => ({
  status: "known",
  cycles,
  calibration: "uncalibrated",
  source: "synthetic-runtime-trace-cost",
});

function addressMap(): AddressMapConfiguration {
  return {
    addressBits: 32,
    metadata: {
      architectureCalibration: "uncalibrated",
      source: "synthetic-runtime-address-map",
    },
    regions: [
      {
        id: "sram",
        base: 0x1000n,
        size: 0x100n,
        kind: "sram",
        permissions: { read: true, write: true, execute: true },
        cacheability: "uncached",
        physical: { backingId: "internal-sram", offset: 0n },
      },
      {
        id: "psram",
        base: 0x2000n,
        size: 0x100n,
        kind: "psram",
        permissions: { read: true, write: true, execute: false },
        cacheability: "cached",
        physical: { backingId: "external-psram", offset: 0n },
      },
    ],
  };
}

function cache(): CacheConfiguration {
  return {
    addressBits: 32,
    metadata: {
      architectureCalibration: "uncalibrated",
      source: "synthetic-runtime-cache",
    },
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
        instructionFetch: known(1n),
        load: known(1n),
        store: known(1n),
      },
      lineFill: known(5n),
      dirtyWriteback: known(5n),
      writeThrough: known(5n),
      uncached: {
        instructionFetch: known(3n),
        load: known(3n),
        store: known(3n),
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

function configuration(): TimingMachineConfiguration {
  return {
    addressMap: addressMap(),
    cache: cache(),
    mmioCost: () => known(2n),
  };
}

function dma(id = "panel-dma"): DmaEvent {
  return {
    id,
    kind: "dma",
    channel: "panel",
    earliest: {
      cycle: 0n,
      calibration: "uncalibrated",
      source: "runtime-dma-submit",
    },
    source: { kind: "memory", memory: "psram" },
    destination: { kind: "mmio", peripheral: "panel" },
    bytes: 64,
    latency: {
      status: "known",
      cycles: 4n,
      calibration: "uncalibrated",
      source: "runtime-dma-cost",
    },
  };
}

describe("runtime observation seam", () => {
  test("turns callback order into exact per-core streams and architectural interleave", () => {
    const recorder = new RuntimeTimingTraceRecorder("synthetic-interpreter-callbacks");
    expect(recorder.recordMemory({ core: 1, kind: "load", address: 0x2000n, bytes: 4 })).toBe(
      "runtime-access:0",
    );
    recorder.recordDma(dma());
    expect(recorder.recordMemory({ core: 0, kind: "load", address: 0x1000n, bytes: 4 })).toBe(
      "runtime-access:1",
    );
    expect(recorder.recordMemory({ core: 1, kind: "load", address: 0x2004n, bytes: 4 })).toBe(
      "runtime-access:2",
    );

    const trace = recorder.snapshot();
    expect(trace.claim).toEqual({
      architectureCalibration: "uncalibrated",
      coverage: "caller-reported-events-only",
      source: "synthetic-interpreter-callbacks",
    });
    expect(trace.input.cores.map((core) => core.map((access) => access.id))).toEqual([
      ["runtime-access:1"],
      ["runtime-access:0", "runtime-access:2"],
    ]);
    expect(trace.input.architecturalInterleave).toEqual([
      "runtime-access:0",
      "runtime-access:1",
      "runtime-access:2",
    ]);
    expect(trace.observationOrder).toEqual([
      { sequence: 0, kind: "memory", accessId: "runtime-access:0" },
      { sequence: 1, kind: "dma", eventId: "panel-dma" },
      { sequence: 2, kind: "memory", accessId: "runtime-access:1" },
      { sequence: 3, kind: "memory", accessId: "runtime-access:2" },
    ]);
  });

  test("runs recorded observations through the existing machine without inferred costs", () => {
    const recorder = new RuntimeTimingTraceRecorder("synthetic-interpreter-callbacks");
    recorder.recordMemory({ core: 1, kind: "load", address: 0x2000n, bytes: 4 });
    recorder.recordDma(dma());
    recorder.recordMemory({ core: 0, kind: "load", address: 0x1000n, bytes: 4 });
    recorder.recordMemory({ core: 1, kind: "load", address: 0x2004n, bytes: 4 });

    const result = runRuntimeTimingTrace(configuration(), recorder.snapshot());
    expect(result.architecturalInterleave).toEqual([
      "runtime-access:0",
      "runtime-access:1",
      "runtime-access:2",
    ]);
    expect(result.cores[1].accesses.map((access) =>
      access.status === "resolved"
        ? access.cacheSteps.flatMap((step) => step.emissions.map((emission) => emission.kind))
        : access.status,
    )).toEqual([
      ["line-fill", "hit"],
      ["hit"],
    ]);
    expect(result.execution.events.find((event) => event.eventId === "panel-dma")).toMatchObject({
      status: "completed",
      resource: "mspi",
      startCycle: 5n,
      endCycle: 9n,
    });
    expect(result.claim.architectureCalibration).toBe("uncalibrated");
    expect(result.claim.costCalibration).toBe("uncalibrated");
  });

  test("returns immutable repeatable snapshots while recording can continue", () => {
    const recorder = new RuntimeTimingTraceRecorder("repeatable-runtime");
    recorder.recordMemory({ core: 0, kind: "load", address: 0x1000n, bytes: 4 });
    const first = recorder.snapshot();
    expect(recorder.snapshot()).toEqual(first);
    recorder.recordMemory({ core: 1, kind: "store", address: 0x2000n, bytes: 4 });
    expect(first.input.architecturalInterleave).toEqual(["runtime-access:0"]);
    expect(recorder.snapshot().input.architecturalInterleave).toEqual([
      "runtime-access:0",
      "runtime-access:1",
    ]);
    expect(Object.isFrozen(first.input.cores[0])).toBe(true);
    expect(Object.isFrozen(first.observationOrder)).toBe(true);
  });
});

describe("runtime trace refusal boundary", () => {
  test("rejects malformed observations and duplicate event IDs", () => {
    expect(() => new RuntimeTimingTraceRecorder("")).toThrow(
      "runtime trace source must be a non-empty string",
    );
    const recorder = new RuntimeTimingTraceRecorder("refusal-test");
    expect(() => recorder.recordMemory({
      core: 2,
      kind: "load",
      address: 0n,
      bytes: 4,
    } as unknown as RuntimeMemoryObservation)).toThrow("runtime memory observation core must be 0 or 1");
    expect(() => recorder.recordMemory({
      core: 0,
      kind: "load",
      address: -1n,
      bytes: 4,
    })).toThrow("runtime memory observation address must be a non-negative bigint");
    recorder.recordDma(dma("duplicate"));
    expect(() => recorder.recordDma(dma("duplicate"))).toThrow(
      "runtime trace event id duplicate is already in use",
    );
  });

  test("rejects forged coverage and schema claims", () => {
    const recorder = new RuntimeTimingTraceRecorder("claim-test");
    const trace = recorder.snapshot();
    const wrongSchema = { ...trace, schemaVersion: 2 } as unknown as RuntimeTimingTrace;
    expect(() => runRuntimeTimingTrace(configuration(), wrongSchema)).toThrow(
      "runtime timing trace schemaVersion must be 1",
    );
    const overclaim = {
      ...trace,
      claim: { ...trace.claim, architectureCalibration: "calibrated" },
    } as unknown as RuntimeTimingTrace;
    expect(() => runRuntimeTimingTrace(configuration(), overclaim)).toThrow(
      "runtime timing trace claim must remain uncalibrated and caller-reported-events-only",
    );
  });
});
