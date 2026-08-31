import type { EventLatency } from "../../packs/esp32-s3-touch-amoled-18/timing/execution";
import { TRACE_KINDS, type DecodedTrace, type TraceRecord } from "./trace-abi";

type KnownLatency = Extract<EventLatency, Readonly<{ status: "known" }>>;

export interface FlexeBeqzTimingOptions {
  readonly taken: EventLatency;
  readonly notTaken: EventLatency;
}

function requireKnownLatency(value: EventLatency, path: string): KnownLatency {
  if (value.status !== "known") throw new Error(`${path} must be a known latency`);
  if (typeof value.cycles !== "bigint" || value.cycles < 0n) {
    throw new Error(`${path}.cycles must be a non-negative bigint`);
  }
  if (value.calibration !== "calibrated") {
    throw new Error(`${path}.calibration must be calibrated`);
  }
  if (typeof value.source !== "string" || value.source.length === 0) {
    throw new Error(`${path}.source must be a non-empty string`);
  }
  return value;
}

function isExactBeqz(record: TraceRecord): boolean {
  const encoding = record.instruction;
  return record.width === 3 &&
    (encoding & 0xf) === 6 &&
    ((encoding >>> 4) & 3) === 1 &&
    ((encoding >>> 6) & 3) === 0;
}

function signExtend12(value: number): number {
  return (value & 0x800) === 0 ? value : value - 0x1000;
}

function outcomeLatency(
  latency: KnownLatency,
  outcome: "taken" | "not-taken",
  branch: TraceRecord,
  nextPc: number,
): KnownLatency {
  return Object.freeze({
    ...latency,
    source:
      `${latency.source}; exact beqz ${outcome} ` +
      `0x${branch.pc.toString(16)} -> 0x${nextPc.toString(16)}`,
  });
}

export function classifyFlexeBeqzCpuCosts(
  decoded: DecodedTrace,
  options: FlexeBeqzTimingOptions | undefined,
): ReadonlyMap<number, KnownLatency> {
  if (options === undefined) return new Map();
  if (typeof options !== "object" || options === null) {
    throw new Error("Flexe beqz timing options must be an object");
  }
  if (decoded.overflow || decoded.count !== decoded.records.length || decoded.count > decoded.capacity) {
    throw new Error("Flexe beqz timing requires a complete non-overflow trace");
  }
  const takenLatency = requireKnownLatency(options.taken, "Flexe beqz taken latency");
  const notTakenLatency = requireKnownLatency(options.notTaken, "Flexe beqz notTaken latency");
  const instructions = decoded.records
    .map((record, recordIndex) => Object.freeze({ record, recordIndex }))
    .filter(({ record }) => record.kind === TRACE_KINDS.instruction);
  const costs = new Map<number, KnownLatency>();
  for (const [instructionIndex, current] of instructions.entries()) {
    if (!isExactBeqz(current.record)) continue;
    const next = instructions[instructionIndex + 1];
    if (next === undefined) {
      throw new Error(`flexe trace beqz instruction ${current.recordIndex} has no observed successor`);
    }
    const sequentialPc = (current.record.pc + current.record.width) >>> 0;
    const immediate = signExtend12((current.record.instruction >>> 12) & 0xfff);
    const targetPc = (current.record.pc + 4 + immediate) >>> 0;
    if (next.record.pc === targetPc) {
      costs.set(current.recordIndex, outcomeLatency(takenLatency, "taken", current.record, targetPc));
      continue;
    }
    if (next.record.pc === sequentialPc) {
      costs.set(
        current.recordIndex,
        outcomeLatency(notTakenLatency, "not-taken", current.record, sequentialPc),
      );
      continue;
    }
    throw new Error(
      `flexe trace beqz instruction ${current.recordIndex} successor ` +
      `0x${next.record.pc.toString(16)} is neither sequential nor its exact target`,
    );
  }
  return costs;
}
