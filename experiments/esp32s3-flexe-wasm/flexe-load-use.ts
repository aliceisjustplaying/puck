import type { EventLatency } from "../../packs/esp32-s3-touch-amoled-18/timing/execution";
import { XTENSA_MEMW_INSTRUCTION_ENCODING } from "../../packs/esp32-s3-touch-amoled-18/timing/trace-adapter";
import { TRACE_KINDS, type DecodedTrace, type TraceRecord } from "./trace-abi";

type KnownLatency = Extract<EventLatency, Readonly<{ status: "known" }>>;

export interface FlexeDependentSramLoadUseHazardOptions {
  readonly internalSram?: Readonly<{
    readonly base: number;
    readonly sizeBytes: number;
  }>;
  readonly internalSramRanges?: readonly Readonly<{
    readonly base: number;
    readonly sizeBytes: number;
  }>[];
  readonly latency: EventLatency;
}

export interface FlexeLoadUseHazard {
  readonly producerRecordIndex: number;
  readonly consumerRecordIndex: number;
  readonly register: number;
  readonly latency: KnownLatency;
}

interface InstructionGroup {
  readonly recordIndex: number;
  readonly instruction: TraceRecord;
  readonly data: readonly Readonly<{ recordIndex: number; record: TraceRecord }>[];
}

function requireUint32(value: unknown, path: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > 0xffff_ffff) {
    throw new Error(`${path} must be an unsigned 32-bit integer`);
  }
  return value as number;
}

function requireKnownLatency(value: EventLatency | undefined, path: string): KnownLatency {
  if (value?.status !== "known") throw new Error(`${path} must be a known latency`);
  if (typeof value.cycles !== "bigint" || value.cycles < 0n) {
    throw new Error(`${path}.cycles must be a non-negative bigint`);
  }
  if (value.calibration !== "calibrated" && value.calibration !== "uncalibrated") {
    throw new Error(`${path}.calibration must be calibrated or uncalibrated`);
  }
  if (typeof value.source !== "string" || value.source.length === 0) {
    throw new Error(`${path}.source must be a non-empty string`);
  }
  return value;
}

function validateInstruction(record: TraceRecord, index: number): void {
  requireUint32(record.pc, `flexe trace instruction ${index}.pc`);
  if (record.width !== 2 && record.width !== 3 && record.width !== 4) {
    throw new Error(`flexe trace instruction ${index} has unsupported width ${record.width}`);
  }
  const limit = 2 ** (record.width * 8);
  if (!Number.isSafeInteger(record.instruction) || record.instruction < 0 || record.instruction >= limit) {
    throw new Error(`flexe trace instruction ${index}.instruction must fit its width`);
  }
}

function instructionGroups(decoded: DecodedTrace): readonly InstructionGroup[] {
  if (decoded.overflow) {
    throw new Error("Flexe dependent SRAM load-use mode requires a complete non-overflow trace");
  }
  if (decoded.count !== decoded.records.length || decoded.count > decoded.capacity) {
    throw new Error("Flexe dependent SRAM load-use mode requires exact trace bounds");
  }
  const groups: Array<{
    recordIndex: number;
    instruction: TraceRecord;
    data: Array<Readonly<{ recordIndex: number; record: TraceRecord }>>;
  }> = [];
  let current: (typeof groups)[number] | null = null;
  for (const [recordIndex, record] of decoded.records.entries()) {
    if (record.kind === TRACE_KINDS.instruction) {
      validateInstruction(record, recordIndex);
      current = { recordIndex, instruction: record, data: [] };
      groups.push(current);
      continue;
    }
    if (record.kind !== TRACE_KINDS.read && record.kind !== TRACE_KINDS.write) {
      throw new Error(`flexe trace record ${recordIndex} has unsupported kind ${record.kind}`);
    }
    if (current === null) {
      throw new Error(`flexe trace data record ${recordIndex} has no preceding instruction`);
    }
    if (record.pc !== current.instruction.pc) {
      throw new Error(`flexe trace data record ${recordIndex} issuer PC does not match its instruction`);
    }
    if (record.instruction !== 0) {
      throw new Error(`flexe trace data record ${recordIndex} must not carry an instruction encoding`);
    }
    current.data.push(Object.freeze({ recordIndex, record }));
  }
  return Object.freeze(groups.map((group) => Object.freeze({
    ...group,
    data: Object.freeze([...group.data]),
  })));
}

function exactLoadDestination(instruction: TraceRecord, dataWidth: number, recordIndex: number): number | null {
  const encoding = instruction.instruction;
  const op0 = encoding & 0xf;
  const t = (encoding >>> 4) & 0xf;
  if (instruction.width === 4) return null;
  if (instruction.width === 2 && op0 === 8) {
    if (dataWidth !== 4) {
      throw new Error(`flexe trace instruction ${recordIndex} l32i.n data width must be 4`);
    }
    return t;
  }
  if (instruction.width === 3 && op0 === 1) {
    if (dataWidth !== 4) {
      throw new Error(`flexe trace instruction ${recordIndex} l32r data width must be 4`);
    }
    return t;
  }
  if (instruction.width === 3 && op0 === 2) {
    const r = (encoding >>> 12) & 0xf;
    const width = r === 0 ? 1 : r === 1 || r === 9 ? 2 : r === 2 || r === 11 ? 4 : null;
    if (width === null) {
      throw new Error(
        `flexe trace instruction ${recordIndex} encoding 0x${encoding.toString(16)} ` +
        "is not an exact supported scalar load",
      );
    }
    if (dataWidth !== width) {
      throw new Error(
        `flexe trace instruction ${recordIndex} load width ${width} disagrees with data width ${dataWidth}`,
      );
    }
    return t;
  }
  throw new Error(
    `flexe trace instruction ${recordIndex} encoding 0x${encoding.toString(16)} ` +
    "is not an exact supported scalar load",
  );
}

function exactSourceRegisters(instruction: TraceRecord, recordIndex: number): readonly number[] {
  const encoding = instruction.instruction;
  const op0 = encoding & 0xf;
  const t = (encoding >>> 4) & 0xf;
  const s = (encoding >>> 8) & 0xf;
  const r = (encoding >>> 12) & 0xf;
  if (instruction.width === 4) {
    const opcode = (encoding & 0xf800_000e) >>> 0;
    if (opcode !== 0x8000_000e && opcode !== 0x8800_000e &&
        opcode !== 0x9000_000e && opcode !== 0x9800_000e) {
      throw new Error(
        `flexe trace instruction ${recordIndex} encoding 0x${encoding.toString(16)} ` +
        "has an unsupported four-byte register-use form",
      );
    }
    const base = (encoding >>> 4) & 0xf;
    if (opcode !== 0x8800_000e && opcode !== 0x9800_000e) return Object.freeze([base]);
    const increment = (encoding >>> 8) & 0xf;
    return Object.freeze(base === increment ? [base] : [base, increment]);
  }
  if (instruction.width === 2) {
    if (op0 === 8 || op0 === 11) return Object.freeze([s]);
    if (op0 === 9 || op0 === 10) return Object.freeze([s, t]);
    if (op0 === 12) return Object.freeze(((t >>> 2) & 3) < 2 ? [] : [s]);
    if (op0 === 13 && r === 0) return Object.freeze([s]);
    if (op0 === 13 && r === 15 && s === 0 && t === 3) return Object.freeze([]);
    throw new Error(
      `flexe trace instruction ${recordIndex} encoding 0x${encoding.toString(16)} ` +
      "has an unsupported narrow register-use form",
    );
  }
  if (instruction.width === 3 && op0 === 2) {
    if (r === 0 || r === 1 || r === 2 || r === 9 || r === 11 || r === 12 || r === 13) {
      return Object.freeze([s]);
    }
    if (r === 4 || r === 5 || r === 6 || r === 14 || r === 15) {
      return Object.freeze([s, t]);
    }
    if (r === 10) return Object.freeze([]);
    throw new Error(
      `flexe trace instruction ${recordIndex} encoding 0x${encoding.toString(16)} ` +
      "has an unsupported LSAI register-use form",
    );
  }
  if (instruction.width === 3 && op0 === 1) return Object.freeze([]);
  if (instruction.width === 3 && op0 === 5) return Object.freeze([]);
  if (instruction.width === 3 && op0 === 6) {
    const n = (encoding >>> 4) & 3;
    const m = (encoding >>> 6) & 3;
    if (n === 0) return Object.freeze([]);
    if (n === 1 || n === 2 || m === 0 || m === 2 || m === 3) return Object.freeze([s]);
    if (n === 3 && m === 1) {
      if (r === 0 || r === 1) return Object.freeze([]);
      if (r === 8 || r === 9 || r === 10) return Object.freeze([s]);
      throw new Error(`flexe trace instruction ${recordIndex} has an unsupported B1 register-use form`);
    }
  }
  if (instruction.width === 3 && op0 === 7) {
    return Object.freeze(r === 6 || r === 7 || r === 14 || r === 15 ? [s] : [s, t]);
  }
  if (instruction.width === 3 && op0 === 0) {
    const op1 = (encoding >>> 16) & 0xf;
    const op2 = (encoding >>> 20) & 0xf;
    if (op1 === 0 && (op2 === 1 || op2 === 2 || op2 === 3 || (op2 >= 8 && op2 <= 15))) {
      return Object.freeze([s, t]);
    }
    if (encoding === XTENSA_MEMW_INSTRUCTION_ENCODING) return Object.freeze([]);
    if (op1 === 0 && op2 === 0 && r === 0) {
      const m = (encoding >>> 6) & 3;
      const n = (encoding >>> 4) & 3;
      if (m === 2 && (n === 0 || n === 1) && s === 0) return Object.freeze([0]);
      if (m === 2 && n === 2) return Object.freeze([s]);
      if (m === 3) return Object.freeze([s]);
    }
    if (op1 === 1 && (op2 === 0 || op2 === 1)) return Object.freeze([s]);
    if (op1 === 1 && (op2 === 2 || op2 === 3 || op2 === 4 || op2 === 6)) {
      return Object.freeze([t]);
    }
    if (op1 === 1 && op2 === 9 && s === 0) return Object.freeze([t]);
    if (op1 === 1 && op2 === 10 && t === 0) return Object.freeze([s]);
    if (op1 === 1 && op2 === 11 && s === 0) return Object.freeze([t]);
    if (op1 === 1 && (op2 === 8 || op2 === 12 || op2 === 13)) return Object.freeze([s, t]);
    if (op1 === 2 && op2 <= 4) return Object.freeze([]);
    if (op1 === 2 && (op2 === 6 || op2 === 7 || op2 === 8 || (op2 >= 10 && op2 <= 15))) {
      return Object.freeze([s, t]);
    }
    if (op1 === 3 && (op2 === 0 || op2 === 14)) return Object.freeze([]);
    if (op1 === 3 && (op2 === 1 || op2 === 15)) return Object.freeze([t]);
    if (op1 === 3 && (op2 === 2 || op2 === 3 || op2 === 12 || op2 === 13)) {
      return Object.freeze([s]);
    }
    if (op1 === 3 && op2 >= 4 && op2 <= 11) return Object.freeze([s, t]);
    if (op1 === 4 || op1 === 5) return Object.freeze([t]);
    throw new Error(
      `flexe trace instruction ${recordIndex} encoding 0x${encoding.toString(16)} ` +
      "has an unsupported QRST register-use form",
    );
  }
  throw new Error(
    `flexe trace instruction ${recordIndex} encoding 0x${encoding.toString(16)} ` +
    "has an unsupported register-use form",
  );
}

function hazardEventLatency(
  hazardLatency: KnownLatency,
  producer: TraceRecord,
  consumer: TraceRecord,
  register: number,
): KnownLatency {
  return Object.freeze({
    status: "known",
    cycles: hazardLatency.cycles,
    calibration: hazardLatency.calibration,
    source:
      `${hazardLatency.source}; dependent internal SRAM load-use a${register} ` +
      `0x${producer.pc.toString(16)} -> 0x${consumer.pc.toString(16)}`,
  });
}

interface InternalSramRange {
  readonly base: number;
  readonly limit: number;
}

function internalSramRanges(options: FlexeDependentSramLoadUseHazardOptions): readonly InternalSramRange[] {
  if (options.internalSram !== undefined && options.internalSramRanges !== undefined) {
    throw new Error("Flexe dependent SRAM load-use accepts one internalSram source");
  }
  const input = options.internalSram === undefined
    ? options.internalSramRanges
    : [options.internalSram];
  if (!Array.isArray(input) || input.length === 0) {
    throw new Error("Flexe dependent SRAM load-use requires at least one exact SRAM range");
  }
  const ranges = input.map((range, index) => {
    const base = requireUint32(range?.base, `Flexe dependent SRAM ranges[${index}].base`);
    if (!Number.isSafeInteger(range?.sizeBytes) || range.sizeBytes <= 0) {
      throw new Error(`Flexe dependent SRAM ranges[${index}].sizeBytes must be a positive safe integer`);
    }
    const limit = base + range.sizeBytes;
    if (!Number.isSafeInteger(limit) || limit > 0x1_0000_0000) {
      throw new Error(`Flexe dependent SRAM ranges[${index}] must fit the 32-bit address space`);
    }
    return Object.freeze({ base, limit });
  });
  for (const [index, range] of ranges.entries()) {
    if (index > 0 && range.base < ranges[index - 1]!.limit) {
      throw new Error("Flexe dependent SRAM ranges must be ordered and non-overlapping");
    }
  }
  return Object.freeze(ranges);
}

function accessIsInternalSram(
  address: number,
  end: number,
  ranges: readonly InternalSramRange[],
  instructionRecordIndex: number,
): boolean {
  let cursor = address;
  let overlaps = false;
  for (const range of ranges) {
    if (range.limit <= cursor) continue;
    if (range.base >= end) break;
    overlaps = true;
    if (range.base > cursor) {
      throw new Error(
        `flexe trace data access owned by instruction ${instructionRecordIndex} crosses the SRAM boundary`,
      );
    }
    cursor = Math.min(end, range.limit);
    if (cursor === end) return true;
  }
  if (overlaps) {
    throw new Error(
      `flexe trace data access owned by instruction ${instructionRecordIndex} crosses the SRAM boundary`,
    );
  }
  return false;
}

export function detectFlexeDependentSramLoadUseHazards(
  decoded: DecodedTrace,
  instructionLatency: EventLatency | undefined,
  options: FlexeDependentSramLoadUseHazardOptions | undefined,
): ReadonlyMap<number, FlexeLoadUseHazard> {
  if (options === undefined) return new Map();
  if (typeof options !== "object" || options === null) {
    throw new Error("Flexe dependent SRAM load-use options must be an object");
  }
  requireKnownLatency(
    instructionLatency,
    "Flexe dependent SRAM load-use instructionCpuCost",
  );
  const hazardLatency = requireKnownLatency(
    options.latency,
    "Flexe dependent SRAM load-use latency",
  );
  if (hazardLatency.cycles !== 1n) {
    throw new Error("Flexe dependent SRAM load-use latency must be exactly 1 cycle");
  }
  const ranges = internalSramRanges(options);

  const groups = instructionGroups(decoded);
  const hazards = new Map<number, FlexeLoadUseHazard>();
  for (const [groupIndex, group] of groups.entries()) {
    const overlapping = group.data.filter(({ record }) => {
      const address = requireUint32(record.address, `flexe trace data address for record ${group.recordIndex}`);
      const end = address + record.width;
      return accessIsInternalSram(address, end, ranges, group.recordIndex);
    });
    const internalLoads = overlapping.filter(({ record }) => record.kind === TRACE_KINDS.read);
    if (internalLoads.length === 0) continue;
    if (internalLoads.length !== 1 || group.data.length !== 1) {
      throw new Error(
        `flexe trace instruction ${group.recordIndex} must own exactly one data read for load-use classification`,
      );
    }
    const next = groups[groupIndex + 1];
    if (next === undefined) {
      throw new Error(`flexe trace SRAM load instruction ${group.recordIndex} has no observed successor`);
    }
    const sequentialPc = group.instruction.pc + group.instruction.width;
    if (next.instruction.pc !== sequentialPc) {
      throw new Error(`flexe trace SRAM load instruction ${group.recordIndex} has a nonsequential successor`);
    }
    const load = internalLoads[0]!.record;
    const register = exactLoadDestination(group.instruction, load.width, group.recordIndex);
    if (register === null) continue;
    const sources = exactSourceRegisters(next.instruction, next.recordIndex);
    if (!sources.includes(register)) continue;
    hazards.set(next.recordIndex, Object.freeze({
      producerRecordIndex: group.recordIndex,
      consumerRecordIndex: next.recordIndex,
      register,
      latency: hazardEventLatency(hazardLatency, group.instruction, next.instruction, register),
    }));
  }
  return hazards;
}
