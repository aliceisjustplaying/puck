const ELF_HEADER_BYTES = 52;
const ELF_PROGRAM_HEADER_BYTES = 32;
const ELF_CLASS_32 = 1;
const ELF_DATA_LITTLE_ENDIAN = 1;
const ELF_VERSION_CURRENT = 1;
const ELF_TYPE_EXECUTABLE = 2;
const ELF_MACHINE_XTENSA = 94;
const ELF_PROGRAM_LOAD = 1;
const UINT32_LIMIT = 0x1_0000_0000;

export interface Elf32LoadSegment {
  readonly index: number;
  readonly virtualAddress: number;
  readonly physicalAddress: number;
  readonly fileOffset: number;
  readonly fileBytes: number;
  readonly memoryBytes: number;
  readonly alignment: number;
  readonly permissions: Readonly<{ read: boolean; write: boolean; execute: boolean }>;
  readonly bytes: Uint8Array;
  readonly sha256: string;
}

export interface Elf32XtensaImage {
  readonly schemaVersion: 1;
  readonly entryPoint: number;
  readonly elfBytes: number;
  readonly elfSha256: string;
  readonly loadSegments: readonly Elf32LoadSegment[];
  readonly totalFileBytes: number;
  readonly totalMemoryBytes: number;
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function checkedRange(start: number, length: number, limit: number, path: string): number {
  assert(Number.isSafeInteger(start) && start >= 0, `${path} start must be a non-negative safe integer`);
  assert(Number.isSafeInteger(length) && length >= 0, `${path} length must be a non-negative safe integer`);
  const end = start + length;
  assert(Number.isSafeInteger(end) && end <= limit, `${path} exceeds its containing image`);
  return end;
}

/** Parse the ELF structure with a caller-provided digest implementation. */
export function parseXtensaElf32WithDigest(
  input: Uint8Array,
  digest: (bytes: Uint8Array) => string,
): Elf32XtensaImage {
  const bytes = Uint8Array.from(input);
  assert(bytes.byteLength >= ELF_HEADER_BYTES, "ELF header is truncated");
  assert(
    bytes[0] === 0x7f && bytes[1] === 0x45 && bytes[2] === 0x4c && bytes[3] === 0x46,
    "ELF magic is invalid",
  );
  assert(bytes[4] === ELF_CLASS_32, "ELF class must be 32-bit");
  assert(bytes[5] === ELF_DATA_LITTLE_ENDIAN, "ELF data encoding must be little-endian");
  assert(bytes[6] === ELF_VERSION_CURRENT, "ELF identification version must be current");

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  assert(view.getUint16(16, true) === ELF_TYPE_EXECUTABLE, "ELF type must be executable");
  assert(view.getUint32(20, true) === ELF_VERSION_CURRENT, "ELF header version must be current");
  assert(view.getUint16(18, true) === ELF_MACHINE_XTENSA, "ELF machine must be Xtensa");
  assert(view.getUint16(40, true) === ELF_HEADER_BYTES, `ELF header size must be ${ELF_HEADER_BYTES}`);
  const entryPoint = view.getUint32(24, true);
  const programHeaderOffset = view.getUint32(28, true);
  const programHeaderBytes = view.getUint16(42, true);
  const programHeaderCount = view.getUint16(44, true);
  assert(programHeaderBytes === ELF_PROGRAM_HEADER_BYTES, `ELF program header size must be ${ELF_PROGRAM_HEADER_BYTES}`);
  checkedRange(
    programHeaderOffset,
    programHeaderBytes * programHeaderCount,
    bytes.byteLength,
    "ELF program header table",
  );

  const loadSegments: Elf32LoadSegment[] = [];
  let totalFileBytes = 0;
  let totalMemoryBytes = 0;
  for (let index = 0; index < programHeaderCount; index += 1) {
    const offset = programHeaderOffset + index * programHeaderBytes;
    if (view.getUint32(offset, true) !== ELF_PROGRAM_LOAD) continue;
    const fileOffset = view.getUint32(offset + 4, true);
    const virtualAddress = view.getUint32(offset + 8, true);
    const physicalAddress = view.getUint32(offset + 12, true);
    const fileBytes = view.getUint32(offset + 16, true);
    const memoryBytes = view.getUint32(offset + 20, true);
    const flags = view.getUint32(offset + 24, true);
    const alignment = view.getUint32(offset + 28, true);
    assert(fileBytes <= memoryBytes, `ELF PT_LOAD ${index} file size exceeds memory size`);
    checkedRange(fileOffset, fileBytes, bytes.byteLength, `ELF PT_LOAD ${index} file range`);
    checkedRange(virtualAddress, memoryBytes, UINT32_LIMIT, `ELF PT_LOAD ${index} virtual range`);
    checkedRange(physicalAddress, memoryBytes, UINT32_LIMIT, `ELF PT_LOAD ${index} physical range`);
    assert(
      alignment === 0 || (alignment & (alignment - 1)) === 0,
      `ELF PT_LOAD ${index} alignment must be zero or a power of two`,
    );
    assert(
      alignment === 0 || virtualAddress % alignment === fileOffset % alignment,
      `ELF PT_LOAD ${index} file offset and virtual address must be congruent modulo alignment`,
    );
    const segmentBytes = Uint8Array.from(bytes.subarray(fileOffset, fileOffset + fileBytes));
    loadSegments.push(Object.freeze({
      index,
      virtualAddress,
      physicalAddress,
      fileOffset,
      fileBytes,
      memoryBytes,
      alignment,
      permissions: Object.freeze({
        read: (flags & 4) !== 0,
        write: (flags & 2) !== 0,
        execute: (flags & 1) !== 0,
      }),
      bytes: segmentBytes,
      sha256: digest(segmentBytes),
    }));
    totalFileBytes += fileBytes;
    totalMemoryBytes += memoryBytes;
  }
  assert(loadSegments.length > 0, "ELF contains no PT_LOAD segments");
  assert(
    loadSegments.some(
      (segment) =>
        segment.permissions.execute &&
        entryPoint >= segment.virtualAddress &&
        entryPoint < segment.virtualAddress + segment.memoryBytes,
    ),
    "ELF entry point is outside executable PT_LOAD memory",
  );
  return Object.freeze({
    schemaVersion: 1,
    entryPoint,
    elfBytes: bytes.byteLength,
    elfSha256: digest(bytes),
    loadSegments: Object.freeze(loadSegments),
    totalFileBytes,
    totalMemoryBytes,
  });
}
