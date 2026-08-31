import { describe, expect, test } from "bun:test";
import {
  eventUsesMspi,
  scheduleExecution,
  type CalibrationStatus,
  type DmaEvent,
  type ExecutionEvent,
  type EventLatency,
} from "./execution";

function known(cycles: bigint, calibration: CalibrationStatus = "calibrated"): EventLatency {
  return { status: "known", cycles, calibration, source: "synthetic-test-cost" };
}

function coreLoad(
  id: string,
  core: 0 | 1,
  memory: "sram" | "psram" | "flash",
  latency: EventLatency,
): ExecutionEvent {
  return { id, kind: "load", core, memory, bytes: 4, latency };
}

function bufferedStore(
  id: string,
  core: 0 | 1,
  latency: EventLatency,
  retirementLatency: EventLatency = known(1n),
  memory: "sram" | "psram" | "flash" = "psram",
): ExecutionEvent {
  return {
    id,
    kind: "store",
    core,
    memory,
    bytes: 4,
    latency,
    storeBuffer: { retirementLatency },
  };
}

function cpu(id: string, core: 0 | 1, cycles: bigint): ExecutionEvent {
  return { id, kind: "cpu", core, instructionAccessId: `${id}:instruction`, latency: known(cycles) };
}

function fence(id: string, core: 0 | 1, cycles: bigint = 2n): ExecutionEvent {
  return { id, kind: "fence", core, operation: "memw", latency: known(cycles) };
}

function dma(
  id: string,
  channel: string,
  earliestCycle: bigint,
  memory: "sram" | "psram" | "flash",
  latency: EventLatency,
): DmaEvent {
  return {
    id,
    kind: "dma",
    channel,
    earliest: { cycle: earliestCycle, calibration: "calibrated", source: "synthetic-submit" },
    source: { kind: "memory", memory },
    destination: { kind: "mmio", peripheral: "panel" },
    bytes: 32,
    latency,
  };
}

function projection(events: ReturnType<typeof scheduleExecution>["events"]): string[] {
  return events.map((event) => {
    const start = event.startCycle === null ? "?" : event.startCycle.toString();
    const end = event.endCycle === null ? "?" : event.endCycle.toString();
    return `${event.resultIndex}:${event.eventId}:${event.status}:${start}-${end}:${event.resource ?? "local"}`;
  });
}

describe("deterministic two-core execution", () => {
  test("interleaves core streams by their per-core ready clocks", () => {
    const result = scheduleExecution([
      coreLoad("c0-long", 0, "sram", known(10n)),
      coreLoad("c1-short", 1, "sram", known(2n)),
      coreLoad("c0-next", 0, "sram", known(1n)),
      coreLoad("c1-next", 1, "sram", known(3n)),
    ]);

    expect(result.events.map((event) => event.eventId)).toEqual([
      "c0-long",
      "c1-short",
      "c1-next",
      "c0-next",
    ]);
    expect(
      result.events.map((event) =>
        event.status === "completed" ? [event.startCycle, event.endCycle] : null,
      ),
    ).toEqual([
      [0n, 10n],
      [0n, 2n],
      [2n, 5n],
      [10n, 11n],
    ]);
    expect(result.finalClocks.cores).toEqual([
      { status: "known", cycle: 11n, calibration: "calibrated" },
      { status: "known", cycle: 5n, calibration: "calibrated" },
    ]);
  });

  test("uses core 0, core 1, then lexical DMA channel order for same-cycle ties", () => {
    const result = scheduleExecution([
      dma("dma-z", "zeta", 0n, "sram", known(1n)),
      coreLoad("core-1", 1, "sram", known(1n)),
      dma("dma-a", "alpha", 0n, "sram", known(1n)),
      coreLoad("core-0", 0, "sram", known(1n)),
    ]);
    expect(result.events.map((event) => event.eventId)).toEqual([
      "core-0",
      "core-1",
      "dma-a",
      "dma-z",
    ]);
    expect(result.events.every((event) => event.startCycle === 0n)).toBe(true);
  });

  test("repeats the same complete result including result indices", () => {
    const input = [
      coreLoad("a", 0, "sram", known(7n, "uncalibrated")),
      coreLoad("b", 1, "flash", known(4n)),
      dma("c", "panel", 2n, "psram", known(8n)),
    ] as const;
    const first = scheduleExecution(input);
    const second = scheduleExecution(input);
    expect(second).toEqual(first);
    expect(projection(second.events)).toEqual(projection(first.events));
  });
});

describe("resource arbitration", () => {
  test("serializes flash and PSRAM traffic on one MSPI clock", () => {
    const result = scheduleExecution([
      coreLoad("flash", 0, "flash", known(5n)),
      coreLoad("psram", 1, "psram", known(3n)),
    ]);
    expect(projection(result.events)).toEqual([
      "0:flash:completed:0-5:mspi",
      "1:psram:completed:5-8:mspi",
    ]);
    const psram = result.events[1];
    expect(psram?.status).toBe("completed");
    if (psram?.status === "completed") expect(psram.waitCycles).toBe(5n);
    expect(result.finalClocks.mspi).toEqual({
      status: "known",
      cycle: 8n,
      calibration: "calibrated",
    });
  });

  test("preserves first-line and subsequent-line durations on the shared MSPI clock", () => {
    const result = scheduleExecution([
      coreLoad("flash-first", 0, "flash", known(11n)),
      coreLoad("flash-subsequent", 0, "flash", known(3n)),
      coreLoad("psram-first", 1, "psram", known(17n)),
    ], { sameCycleTieBreak: "input-order" });
    expect(projection(result.events)).toEqual([
      "0:flash-first:completed:0-11:mspi",
      "1:flash-subsequent:completed:11-14:mspi",
      "2:psram-first:completed:14-31:mspi",
    ]);
  });

  test("lets SRAM and MMIO progress independently while MSPI is occupied", () => {
    const result = scheduleExecution([
      coreLoad("flash-long", 0, "flash", known(20n)),
      coreLoad("sram", 1, "sram", known(3n)),
      {
        id: "mmio",
        kind: "mmio",
        core: 1,
        peripheral: "uart",
        operation: "write",
        bytes: 1,
        latency: known(2n),
      },
    ]);
    expect(projection(result.events)).toEqual([
      "0:flash-long:completed:0-20:mspi",
      "1:sram:completed:0-3:local",
      "2:mmio:completed:3-5:local",
    ]);
    expect(result.finalClocks.cores[1]).toEqual({
      status: "known",
      cycle: 5n,
      calibration: "calibrated",
    });
  });

  test("propagates an uncalibrated bus predecessor into later starts and ends", () => {
    const result = scheduleExecution([
      coreLoad("estimated-flash", 0, "flash", known(5n, "uncalibrated")),
      coreLoad("measured-psram", 1, "psram", known(3n, "calibrated")),
      coreLoad("measured-sram", 0, "sram", known(1n, "calibrated")),
    ]);
    const psram = result.events.find((event) => event.eventId === "measured-psram");
    const sram = result.events.find((event) => event.eventId === "measured-sram");
    expect(psram?.status).toBe("completed");
    expect(sram?.status).toBe("completed");
    if (psram?.status === "completed") {
      expect(psram.startCalibration).toBe("uncalibrated");
      expect(psram.endCalibration).toBe("uncalibrated");
    }
    if (sram?.status === "completed") expect(sram.endCalibration).toBe("uncalibrated");
    expect(result.calibration).toEqual({
      status: "uncalibrated",
      uncalibratedEventIds: ["estimated-flash", "measured-sram", "measured-psram"],
      unknownEventIds: [],
    });
  });
});

describe("one-entry store buffers", () => {
  test("retires an opted-in store while preserving legacy blocking stores", () => {
    const legacy = scheduleExecution([
      { id: "write", kind: "store", core: 0, memory: "psram", bytes: 4, latency: known(10n) },
      cpu("cpu-after", 0, 3n),
    ]);
    expect(projection(legacy.events)).toEqual([
      "0:write:completed:0-10:mspi",
      "1:cpu-after:completed:10-13:local",
    ]);
    expect(legacy.finalClocks.storeBuffers).toBeUndefined();

    const buffered = scheduleExecution([
      bufferedStore("write", 0, known(10n)),
      cpu("cpu-after", 0, 3n),
    ]);
    expect(projection(buffered.events)).toEqual([
      "0:write:completed:0-1:local",
      "1:cpu-after:completed:1-4:local",
      "2:write:drain:completed:1-11:mspi",
    ]);
    expect(buffered.events[2]?.actor).toEqual({ kind: "store-buffer", core: 0 });
    expect(buffered.finalClocks.storeBuffers?.[0]).toEqual({
      status: "known",
      cycle: 11n,
      calibration: "calibrated",
    });
  });

  test("holds a memw fence until the prior store drains", () => {
    const result = scheduleExecution([
      bufferedStore("write", 0, known(10n)),
      fence("fence", 0),
    ]);
    expect(projection(result.events)).toEqual([
      "0:write:completed:0-1:local",
      "1:write:drain:completed:1-11:mspi",
      "2:fence:completed:11-13:local",
    ]);
  });

  test("blocks a second same-core store while the one entry is full", () => {
    const result = scheduleExecution([
      bufferedStore("first", 0, known(10n)),
      bufferedStore("second", 0, known(4n)),
    ]);
    expect(projection(result.events)).toEqual([
      "0:first:completed:0-1:local",
      "1:first:drain:completed:1-11:mspi",
      "2:second:completed:11-12:local",
      "3:second:drain:completed:12-16:mspi",
    ]);
  });

  test("gives each core an independent buffer", () => {
    const result = scheduleExecution([
      bufferedStore("core0", 0, known(10n)),
      bufferedStore("core1", 1, known(5n)),
    ]);
    expect(projection(result.events)).toEqual([
      "0:core0:completed:0-1:local",
      "1:core1:completed:0-1:local",
      "2:core0:drain:completed:1-11:mspi",
      "3:core1:drain:completed:11-16:mspi",
    ]);
  });

  test("keeps an unknown drain explicit while independent CPU work progresses", () => {
    const result = scheduleExecution([
      bufferedStore("write", 0, { status: "unknown", reason: "no store drain receipt" }),
      cpu("cpu-after", 0, 3n),
      fence("fence", 0),
    ]);
    expect(projection(result.events)).toEqual([
      "0:write:completed:0-1:local",
      "1:cpu-after:completed:1-4:local",
      "2:write:drain:started-unknown-duration:1-?:mspi",
      "3:fence:blocked:?-?:local",
    ]);
    expect(result.finalClocks.storeBuffers?.[0]).toEqual({
      status: "blocked",
      atCycle: 1n,
      blockedBy: "write:drain",
      reason: "no store drain receipt",
    });
    expect(result.calibration.unknownEventIds).toEqual(["write:drain", "fence"]);
  });
});

describe("unknown latency blocking", () => {
  test("blocks its core and shared MSPI without stopping independent SRAM on the other core", () => {
    const result = scheduleExecution([
      coreLoad("flash-unknown", 0, "flash", { status: "unknown", reason: "no flash miss measurement" }),
      coreLoad("core1-sram", 1, "sram", known(4n)),
      coreLoad("core0-after", 0, "sram", known(1n)),
      coreLoad("core1-psram", 1, "psram", known(2n)),
      coreLoad("core1-after", 1, "sram", known(1n)),
    ]);

    expect(projection(result.events)).toEqual([
      "0:flash-unknown:started-unknown-duration:0-?:mspi",
      "1:core1-sram:completed:0-4:local",
      "2:core1-psram:blocked:?-?:mspi",
      "3:core0-after:blocked:?-?:local",
      "4:core1-after:blocked:?-?:local",
    ]);
    const blockedBus = result.events[2];
    expect(blockedBus?.status).toBe("blocked");
    if (blockedBus?.status === "blocked") expect(blockedBus.blockedBy).toBe("flash-unknown");
    expect(result.status).toBe("blocked");
    expect(result.calibration.status).toBe("unknown");
    expect(result.calibration.unknownEventIds).toEqual([
      "flash-unknown",
      "core1-psram",
      "core0-after",
      "core1-after",
    ]);
  });

  test("keeps an unknown SRAM duration local to its core", () => {
    const result = scheduleExecution([
      coreLoad("sram-unknown", 0, "sram", { status: "unknown", reason: "no SRAM latency receipt" }),
      coreLoad("flash-known", 1, "flash", known(6n)),
    ]);
    expect(projection(result.events)).toEqual([
      "0:sram-unknown:started-unknown-duration:0-?:local",
      "1:flash-known:completed:0-6:mspi",
    ]);
    expect(result.finalClocks.mspi).toEqual({
      status: "known",
      cycle: 6n,
      calibration: "calibrated",
    });
  });

  test("refuses an event with no supplied latency", () => {
    const missingLatency = {
      id: "missing",
      kind: "load",
      core: 0,
      memory: "sram",
      bytes: 4,
    } as unknown as ExecutionEvent;
    expect(() => scheduleExecution([missingLatency])).toThrow(
      "latency is required; the scheduler has no default chip costs",
    );
  });
});

describe("typed event surface", () => {
  test("covers every event kind and maps only external-memory work to MSPI", () => {
    const events: ExecutionEvent[] = [
      { id: "fetch", kind: "instruction-fetch", core: 0, memory: "flash", bytes: 16, latency: known(1n) },
      { id: "load", kind: "load", core: 0, memory: "sram", bytes: 4, latency: known(1n) },
      { id: "store", kind: "store", core: 0, memory: "psram", bytes: 4, latency: known(1n) },
      { id: "atomic", kind: "atomic", core: 1, memory: "sram", bytes: 4, operation: "cas", latency: known(1n) },
      { id: "cache", kind: "cache-op", core: 1, operation: "invalidate", backing: "flash", latency: known(1n) },
      { id: "mmio", kind: "mmio", core: 1, peripheral: "gpio", operation: "read", bytes: 4, latency: known(1n) },
      { id: "cpu", kind: "cpu", core: 1, instructionAccessId: "fetch", latency: known(1n) },
      { id: "fence", kind: "fence", core: 1, operation: "memw", latency: known(1n) },
      dma("dma", "panel", 0n, "psram", known(1n)),
    ];
    expect(events.map((event) => [event.kind, eventUsesMspi(event)])).toEqual([
      ["instruction-fetch", true],
      ["load", false],
      ["store", true],
      ["atomic", false],
      ["cache-op", true],
      ["mmio", false],
      ["cpu", false],
      ["fence", false],
      ["dma", true],
    ]);
    const expectedKinds: Array<ExecutionEvent["kind"]> = [
      "instruction-fetch",
      "load",
      "store",
      "atomic",
      "cache-op",
      "mmio",
      "cpu",
      "fence",
      "dma",
    ];
    expect(scheduleExecution(events).events.map((event) => event.kind).sort()).toEqual(expectedKinds.sort());
  });
});
