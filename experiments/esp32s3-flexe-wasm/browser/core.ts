import { parseXtensaElf32WithDigest, type Elf32XtensaImage } from "../elf-image-core";
import type { FullElfRunResult } from "../full-elf-runner";
import { TRACE_KINDS, type DecodedTrace } from "../trace-abi";

export const DEFAULT_MAX_STEPS = 256;
export const MAX_STEPS = 1024;
export const DEFAULT_INITIAL_STACK = 0x3fce_9700;
export const GATE_HARNESS_STACK_MEMORY = Object.freeze({
  address: 0x3fce_7000,
  bytes: 0x3000,
  flags: 6,
  provenance: "TinyDraw gate-harness bootloader usable DRAM",
});

export interface TraceSummary {
  readonly records: number;
  readonly capacity: number;
  readonly overflow: boolean;
  readonly instructions: number;
  readonly reads: number;
  readonly writes: number;
  readonly firstPc: number | null;
  readonly lastPc: number | null;
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function sha256(bytes: Uint8Array): Promise<string> {
  const copy = Uint8Array.from(bytes);
  const digest = await globalThis.crypto.subtle.digest("SHA-256", copy.buffer);
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join("");
}

export async function parseBrowserElf(input: Uint8Array): Promise<Elf32XtensaImage> {
  const parsed = parseXtensaElf32WithDigest(input, () => "");
  const [elfSha256, ...segmentHashes] = await Promise.all([
    sha256(input),
    ...parsed.loadSegments.map((segment) => sha256(segment.bytes)),
  ]);
  return Object.freeze({
    ...parsed,
    elfSha256,
    loadSegments: Object.freeze(parsed.loadSegments.map((segment, index) => Object.freeze({
      ...segment,
      sha256: segmentHashes[index]!,
    }))),
  });
}

export function parseStepLimit(value: string): number {
  const steps = Number(value);
  assert(Number.isInteger(steps) && steps >= 1 && steps <= MAX_STEPS, `steps must be an integer from 1 to ${MAX_STEPS}`);
  return steps;
}

export function parseAddress(value: string): number {
  assert(/^0x[0-9a-f]{1,8}$/i.test(value.trim()), "initial stack must be a 32-bit hexadecimal address");
  const address = Number.parseInt(value.trim().slice(2), 16);
  assert(address > 0 && address <= 0xffff_ffff, "initial stack must be a nonzero 32-bit address");
  assert(address % 16 === 0, "initial stack must be 16-byte aligned");
  return address;
}

export function hex32(value: number): string {
  return `0x${(value >>> 0).toString(16).padStart(8, "0")}`;
}

export function summarizeTrace(trace: DecodedTrace): TraceSummary {
  let instructions = 0;
  let reads = 0;
  let writes = 0;
  let firstPc: number | null = null;
  let lastPc: number | null = null;
  for (const record of trace.records) {
    if (record.kind === TRACE_KINDS.instruction) {
      instructions += 1;
      if (firstPc === null) firstPc = record.pc;
      lastPc = record.pc;
    } else if (record.kind === TRACE_KINDS.read) reads += 1;
    else if (record.kind === TRACE_KINDS.write) writes += 1;
  }
  return Object.freeze({
    records: trace.count,
    capacity: trace.capacity,
    overflow: trace.overflow,
    instructions,
    reads,
    writes,
    firstPc,
    lastPc,
  });
}

export function summarizeRun(result: FullElfRunResult): Readonly<{
  stopReason: string;
  pc: string;
  steps: number;
  registers: readonly string[];
  loadedPages: number;
  trace: TraceSummary;
}> {
  return Object.freeze({
    stopReason: result.record.reasonName,
    pc: hex32(result.record.pc),
    steps: result.record.steps,
    registers: Object.freeze(result.record.registers.map(hex32)),
    loadedPages: result.loadedPages,
    trace: summarizeTrace(result.memoryTrace),
  });
}
