export const TRACE_ABI_VERSION = 1;
export const TRACE_HEADER_BYTES = 24;
export const TRACE_RECORD_BYTES = 24;

export const TRACE_KINDS = {
  instruction: 1,
  read: 2,
  write: 3,
} as const;

export interface TraceRecord {
  readonly kind: number;
  readonly pc: number;
  readonly address: number;
  readonly value: number;
  readonly width: number;
  readonly instruction: number;
}

export interface DecodedTrace {
  readonly abiVersion: number;
  readonly headerBytes: number;
  readonly recordBytes: number;
  readonly count: number;
  readonly capacity: number;
  readonly overflow: boolean;
  readonly records: readonly TraceRecord[];
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function validateRecord(record: TraceRecord, index: number): void {
  assert(
    record.kind === TRACE_KINDS.instruction ||
      record.kind === TRACE_KINDS.read ||
      record.kind === TRACE_KINDS.write,
    `trace record ${index} has unknown kind ${record.kind}`,
  );
  if (record.kind === TRACE_KINDS.instruction) {
    assert(
      record.width === 2 || record.width === 3,
      `trace instruction record ${index} has unsupported width ${record.width}`,
    );
    return;
  }
  assert(
    record.width === 1 || record.width === 2 || record.width === 4,
    `trace data record ${index} has unsupported width ${record.width}`,
  );
}

export function decodeTraceBytes(bytes: Uint8Array, expectedCapacity?: number): DecodedTrace {
  assert(bytes.byteLength >= TRACE_HEADER_BYTES, "trace header is truncated");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const abiVersion = view.getUint32(0, true);
  const headerBytes = view.getUint32(4, true);
  const recordBytes = view.getUint32(8, true);
  const count = view.getUint32(12, true);
  const capacity = view.getUint32(16, true);
  const overflowWord = view.getUint32(20, true);
  assert(abiVersion === TRACE_ABI_VERSION, `unexpected trace ABI ${abiVersion}`);
  assert(headerBytes === TRACE_HEADER_BYTES, `unexpected trace header size ${headerBytes}`);
  assert(recordBytes === TRACE_RECORD_BYTES, `unexpected trace record size ${recordBytes}`);
  if (expectedCapacity !== undefined) {
    assert(capacity === expectedCapacity, `unexpected trace capacity ${capacity}`);
  }
  assert(count <= capacity, `trace count ${count} exceeds capacity ${capacity}`);
  assert(bytes.byteLength === headerBytes + count * recordBytes, "trace byte length disagrees with its header");
  assert(overflowWord === 0 || overflowWord === 1, `invalid trace overflow flag ${overflowWord}`);

  const records: TraceRecord[] = [];
  for (let index = 0; index < count; index += 1) {
    const offset = headerBytes + index * recordBytes;
    const record = Object.freeze({
      kind: view.getUint32(offset, true),
      pc: view.getUint32(offset + 4, true),
      address: view.getUint32(offset + 8, true),
      value: view.getUint32(offset + 12, true),
      width: view.getUint32(offset + 16, true),
      instruction: view.getUint32(offset + 20, true),
    });
    validateRecord(record, index);
    records.push(record);
  }
  return Object.freeze({
    abiVersion,
    headerBytes,
    recordBytes,
    count,
    capacity,
    overflow: overflowWord === 1,
    records: Object.freeze(records),
  });
}
