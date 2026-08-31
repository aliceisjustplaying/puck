import {
  TRACE_ABI_VERSION,
  TRACE_HEADER_BYTES,
  TRACE_KINDS,
  TRACE_RECORD_BYTES,
  decodeTraceBytes,
  type TraceRecord,
} from "./trace-abi";

const CAPACITY = 9;

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function encode(records: readonly TraceRecord[]): Uint8Array {
  const bytes = new Uint8Array(TRACE_HEADER_BYTES + records.length * TRACE_RECORD_BYTES);
  const view = new DataView(bytes.buffer);
  for (const [index, value] of [
    TRACE_ABI_VERSION,
    TRACE_HEADER_BYTES,
    TRACE_RECORD_BYTES,
    records.length,
    CAPACITY,
    0,
  ].entries()) {
    view.setUint32(index * 4, value, true);
  }
  for (const [index, record] of records.entries()) {
    const offset = TRACE_HEADER_BYTES + index * TRACE_RECORD_BYTES;
    for (const [word, value] of [
      record.kind,
      record.pc,
      record.address,
      record.value,
      record.width,
      record.instruction,
    ].entries()) {
      view.setUint32(offset + word * 4, value, true);
    }
  }
  return bytes;
}

function record(kind: number, width: number): TraceRecord {
  return { kind, pc: 0x42000000, address: 0x3fca0000, value: 0x12345678, width, instruction: 0x004136 };
}

function expectFailure(records: readonly TraceRecord[], message: string): void {
  try {
    decodeTraceBytes(encode(records), CAPACITY);
  } catch (error) {
    assert(error instanceof Error && error.message === message, `unexpected decoder error: ${String(error)}`);
    return;
  }
  throw new Error(`decoder accepted invalid records: ${message}`);
}

const valid = [
  record(TRACE_KINDS.instruction, 2),
  record(TRACE_KINDS.instruction, 3),
  record(TRACE_KINDS.instruction, 4),
  record(TRACE_KINDS.read, 1),
  record(TRACE_KINDS.read, 2),
  record(TRACE_KINDS.read, 4),
  record(TRACE_KINDS.write, 1),
  record(TRACE_KINDS.write, 2),
  record(TRACE_KINDS.write, 4),
];
assert(decodeTraceBytes(encode(valid), CAPACITY).count === valid.length, "valid trace widths did not decode");
expectFailure([record(TRACE_KINDS.instruction, 1)], "trace instruction record 0 has unsupported width 1");
expectFailure([record(TRACE_KINDS.instruction, 5)], "trace instruction record 0 has unsupported width 5");
expectFailure([record(TRACE_KINDS.read, 3)], "trace data record 0 has unsupported width 3");
expectFailure([record(TRACE_KINDS.write, 3)], "trace data record 0 has unsupported width 3");

console.log(JSON.stringify({ validWidths: 9, rejectedWidths: 4 }));
