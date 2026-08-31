import { describe, expect, test } from "bun:test";
import { TRACE_KINDS, type DecodedTrace } from "../trace-abi";
import { hex32, parseAddress, parseStepLimit, summarizeTrace } from "./core";

describe("ESP32-S3 browser runner core", () => {
  test("validates the bounded run controls", () => {
    expect(parseStepLimit("1")).toBe(1);
    expect(parseStepLimit("1024")).toBe(1024);
    expect(() => parseStepLimit("1025")).toThrow("1 to 1024");
    expect(parseAddress("0x3fce9700")).toBe(0x3fce_9700);
    expect(() => parseAddress("0x3fce9701")).toThrow("16-byte aligned");
    expect(hex32(0x2a)).toBe("0x0000002a");
  });

  test("summarizes instruction and data trace records", () => {
    const trace: DecodedTrace = Object.freeze({
      abiVersion: 1,
      headerBytes: 24,
      recordBytes: 24,
      count: 4,
      capacity: 1024,
      overflow: false,
      records: Object.freeze([
        Object.freeze({ kind: TRACE_KINDS.instruction, pc: 0x4037_1000, address: 0, value: 0, width: 3, instruction: 1 }),
        Object.freeze({ kind: TRACE_KINDS.read, pc: 0x4037_1000, address: 0x3fca_1000, value: 1, width: 2, instruction: 1 }),
        Object.freeze({ kind: TRACE_KINDS.write, pc: 0x4037_1003, address: 0x3fca_2000, value: 1, width: 2, instruction: 2 }),
        Object.freeze({ kind: TRACE_KINDS.instruction, pc: 0x4037_1003, address: 0, value: 0, width: 3, instruction: 2 }),
      ]),
    });
    expect(summarizeTrace(trace)).toEqual({
      records: 4,
      capacity: 1024,
      overflow: false,
      instructions: 2,
      reads: 1,
      writes: 1,
      firstPc: 0x4037_1000,
      lastPc: 0x4037_1003,
    });
  });

  test("browser entry bundles without server-only imports", async () => {
    const result = await Bun.build({
      entrypoints: [new URL("./main.ts", import.meta.url).pathname],
      target: "browser",
      format: "esm",
      write: false,
    });
    expect(result.success).toBe(true);
  });
});
