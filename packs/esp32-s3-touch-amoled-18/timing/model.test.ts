import { describe, expect, test } from "bun:test";
import { compareTime, partitionBytes, scheduleTransfer, type ScheduleResult } from "./model";

const CLOCKS = {
  queueDepth: 3,
  cpuProducer: { hz: 240_000_000n, calibration: "uncalibrated" as const },
  panelDma: { hz: 40_000_000n, calibration: "calibrated" as const },
};

const STARTUP_TRANSFER = {
  totalBytes: 329_728,
  maxStripBytes: 32_768,
  producerCost: {
    fixedCycles: 0n,
    cyclesPerByte: { numerator: 1n, denominator: 1n },
    calibration: "uncalibrated" as const,
  },
  panelDmaCost: {
    fixedCycles: 0n,
    cyclesPerByte: { numerator: 2n, denominator: 1n },
    calibration: "uncalibrated" as const,
  },
};

function eventProjection(result: ScheduleResult): string[] {
  return result.events.map(
    (event) =>
      `${event.at.numerator}/${event.at.denominator}:${event.kind}:${event.stripIndex}:${event.bytes}:${event.queueOccupancy}`,
  );
}

describe("partitionBytes", () => {
  test("partitions the 368x448x2 startup transfer into ten full strips and one partial strip", () => {
    const strips = partitionBytes(329_728, 32_768);
    expect(strips).toHaveLength(11);
    expect(strips.slice(0, 10)).toEqual(Array(10).fill(32_768));
    expect(strips[10]).toBe(2_048);
    expect(strips.reduce((sum, bytes) => sum + bytes, 0)).toBe(329_728);
  });
});

describe("scheduleTransfer", () => {
  test("overlaps CPU production with panel DMA on separate clocks", () => {
    const result = scheduleTransfer(CLOCKS, STARTUP_TRANSFER);
    const first = result.strips[0]!;
    const second = result.strips[1]!;

    expect(first.producerCycles).toBe(32_768n);
    expect(first.panelDmaCycles).toBe(65_536n);
    expect(compareTime(second.producerStartedAt, first.panelStartedAt)).toBe(0);
    expect(compareTime(second.producedAt, first.completedAt)).toBe(-1);
    expect(result.clocks.cpuProducer.hz).toBe(240_000_000n);
    expect(result.clocks.panelDma.hz).toBe(40_000_000n);
  });

  test("bounds outstanding work at three and records producer queue waits", () => {
    const result = scheduleTransfer(CLOCKS, STARTUP_TRANSFER);
    const waits = result.events.filter((event) => event.kind === "queue-wait-start");
    const waitEnds = result.events.filter((event) => event.kind === "queue-wait-end");
    const submits = result.events.filter((event) => event.kind === "submit");

    expect(waits.map((event) => event.stripIndex)).toEqual([3, 4, 5, 6, 7, 8, 9, 10]);
    expect(waitEnds).toHaveLength(8);
    expect(result.strips.map((strip) => strip.queueWait.numerator > 0n)).toEqual([
      false,
      false,
      false,
      true,
      true,
      true,
      true,
      true,
      true,
      true,
      true,
    ]);
    expect(Math.max(...submits.map((event) => event.queueOccupancy))).toBe(3);
    expect(submits.every((event) => event.queueOccupancy <= 3)).toBe(true);
  });

  test("emits one ordered submit, start, and completion for all 11 strips", () => {
    const result = scheduleTransfer(CLOCKS, STARTUP_TRANSFER);
    const kinds = ["submit", "panel-start", "panel-complete"] as const;

    expect(result.totalBytes).toBe(329_728);
    expect(result.strips.map((strip) => strip.bytes)).toEqual([...Array(10).fill(32_768), 2_048]);
    for (const kind of kinds) {
      const matching = result.events.filter((event) => event.kind === kind);
      expect(matching).toHaveLength(11);
      expect(matching.map((event) => event.stripIndex)).toEqual([...Array(11).keys()]);
    }
    for (let index = 1; index < result.events.length; index++) {
      expect(compareTime(result.events[index - 1]!.at, result.events[index]!.at)).not.toBe(1);
    }

    const firstSubmitTime = result.strips[0]!.submittedAt;
    expect(
      result.events
        .filter((event) => compareTime(event.at, firstSubmitTime) === 0)
        .map((event) => `${event.kind}:${event.stripIndex}`),
    ).toEqual(["producer-complete:0", "submit:0", "panel-start:0", "producer-start:1"]);

    const firstCompletionTime = result.strips[0]!.completedAt;
    expect(
      result.events
        .filter((event) => compareTime(event.at, firstCompletionTime) === 0)
        .map((event) => `${event.kind}:${event.stripIndex}`),
    ).toEqual(["panel-complete:0", "queue-wait-end:3", "submit:3", "panel-start:1", "producer-start:4"]);
  });

  test("marks the result uncalibrated and names every estimated input", () => {
    const result = scheduleTransfer(CLOCKS, STARTUP_TRANSFER);
    expect(result.calibration).toEqual({
      status: "uncalibrated",
      uncalibratedInputs: ["cpuProducer.clock", "producerCost", "panelDmaCost"],
    });
  });

  test("repeats byte-for-byte equivalent event projections", () => {
    const first = scheduleTransfer(CLOCKS, STARTUP_TRANSFER);
    const second = scheduleTransfer(CLOCKS, STARTUP_TRANSFER);
    expect(eventProjection(second)).toEqual(eventProjection(first));
    expect(second).toEqual(first);
  });
});
