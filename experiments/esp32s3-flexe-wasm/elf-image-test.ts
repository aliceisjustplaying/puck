import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DEFAULT_TINYDRAW_ESP32S3_FULL_ELF } from "./constants";
import { parseXtensaElf32 } from "./elf-image";

const ELF_HEADER_BYTES = 52;
const PROGRAM_HEADER_BYTES = 32;
const PAYLOAD_OFFSET = ELF_HEADER_BYTES + PROGRAM_HEADER_BYTES;

function syntheticElf(): Uint8Array {
  const bytes = new Uint8Array(PAYLOAD_OFFSET + 4);
  bytes.set([0x7f, 0x45, 0x4c, 0x46, 1, 1, 1]);
  const view = new DataView(bytes.buffer);
  view.setUint16(16, 2, true);
  view.setUint16(18, 94, true);
  view.setUint32(20, 1, true);
  view.setUint32(24, 0x4000_0000, true);
  view.setUint32(28, ELF_HEADER_BYTES, true);
  view.setUint16(40, ELF_HEADER_BYTES, true);
  view.setUint16(42, PROGRAM_HEADER_BYTES, true);
  view.setUint16(44, 1, true);
  view.setUint32(ELF_HEADER_BYTES, 1, true);
  view.setUint32(ELF_HEADER_BYTES + 4, PAYLOAD_OFFSET, true);
  view.setUint32(ELF_HEADER_BYTES + 8, 0x4000_0000, true);
  view.setUint32(ELF_HEADER_BYTES + 12, 0x4000_0000, true);
  view.setUint32(ELF_HEADER_BYTES + 16, 4, true);
  view.setUint32(ELF_HEADER_BYTES + 20, 8, true);
  view.setUint32(ELF_HEADER_BYTES + 24, 5, true);
  view.setUint32(ELF_HEADER_BYTES + 28, 4, true);
  bytes.set([0xde, 0xad, 0xbe, 0xef], PAYLOAD_OFFSET);
  return bytes;
}

function mutate(offset: number, width: 1 | 2 | 4, value: number): Uint8Array {
  const bytes = syntheticElf();
  const view = new DataView(bytes.buffer);
  if (width === 1) view.setUint8(offset, value);
  if (width === 2) view.setUint16(offset, value, true);
  if (width === 4) view.setUint32(offset, value, true);
  return bytes;
}

const synthetic = syntheticElf();
const parsedSynthetic = parseXtensaElf32(synthetic);
assert.equal(parsedSynthetic.entryPoint, 0x4000_0000);
assert.equal(parsedSynthetic.loadSegments.length, 1);
assert.deepEqual([...parsedSynthetic.loadSegments[0]!.bytes], [0xde, 0xad, 0xbe, 0xef]);
assert.deepEqual(parsedSynthetic.loadSegments[0]!.permissions, {
  read: true,
  write: false,
  execute: true,
});
synthetic[PAYLOAD_OFFSET] = 0;
assert.equal(parsedSynthetic.loadSegments[0]!.bytes[0], 0xde, "parsed image must own its segment bytes");

const malformed: readonly [string, Uint8Array, RegExp][] = [
  ["magic", mutate(0, 1, 0), /magic/],
  ["class", mutate(4, 1, 2), /32-bit/],
  ["endianness", mutate(5, 1, 2), /little-endian/],
  ["ident version", mutate(6, 1, 0), /identification version/],
  ["type", mutate(16, 2, 1), /type must be executable/],
  ["machine", mutate(18, 2, 3), /machine must be Xtensa/],
  ["header version", mutate(20, 4, 0), /header version/],
  ["header size", mutate(40, 2, 51), /header size/],
  ["program header size", mutate(42, 2, 31), /program header size/],
  ["program table range", mutate(28, 4, 80), /program header table/],
  ["file larger than memory", mutate(ELF_HEADER_BYTES + 16, 4, 9), /file size exceeds memory size/],
  ["file range", mutate(ELF_HEADER_BYTES + 4, 4, 86), /file range/],
  ["virtual overflow", mutate(ELF_HEADER_BYTES + 8, 4, 0xffff_fffc), /virtual range/],
  ["physical overflow", mutate(ELF_HEADER_BYTES + 12, 4, 0xffff_fffc), /physical range/],
  ["alignment", mutate(ELF_HEADER_BYTES + 28, 4, 3), /alignment must be zero or a power of two/],
  ["alignment congruence", mutate(ELF_HEADER_BYTES + 8, 4, 0x4000_0002), /congruent/],
  ["no load segment", mutate(ELF_HEADER_BYTES, 4, 0), /no PT_LOAD/],
  ["entry outside", mutate(24, 4, 0x4000_0008), /entry point is outside/],
];
for (const [name, bytes, expected] of malformed) {
  assert.throws(() => parseXtensaElf32(bytes), expected, name);
}

const real = parseXtensaElf32(readFileSync(DEFAULT_TINYDRAW_ESP32S3_FULL_ELF));
assert.equal(real.entryPoint, 0x4037_5c9c);
assert.equal(real.elfBytes, 21_598_616);
assert.equal(real.elfSha256, "51cc322381bce60347ca322506c411af17f6b73ef366f3e440d6fdf5c1d5a8e5");
assert.equal(real.loadSegments.length, 8);
assert.equal(real.totalFileBytes, 1_506_239);
assert.equal(real.totalMemoryBytes, 3_835_451);
assert.deepEqual(
  real.loadSegments.map(({ index, virtualAddress, fileBytes, memoryBytes, permissions }) => ({
    index,
    virtualAddress,
    fileBytes,
    memoryBytes,
    permissions,
  })),
  [
    { index: 0, virtualAddress: 0x3c00_0020, fileBytes: 0, memoryBytes: 983_040, permissions: { read: true, write: true, execute: false } },
    { index: 1, virtualAddress: 0x3c00_0020, fileBytes: 0, memoryBytes: 1_310_688, permissions: { read: true, write: true, execute: false } },
    { index: 2, virtualAddress: 0x3c0f_0020, fileBytes: 293_276, memoryBytes: 307_267, permissions: { read: true, write: true, execute: false } },
    { index: 3, virtualAddress: 0x3fc8_8000, fileBytes: 147_032, memoryBytes: 168_256, permissions: { read: true, write: true, execute: false } },
    { index: 4, virtualAddress: 0x4037_4000, fileBytes: 141_067, memoryBytes: 141_312, permissions: { read: true, write: true, execute: true } },
    { index: 5, virtualAddress: 0x4200_0020, fileBytes: 924_828, memoryBytes: 924_828, permissions: { read: true, write: false, execute: true } },
    { index: 6, virtualAddress: 0x5000_0000, fileBytes: 36, memoryBytes: 36, permissions: { read: true, write: true, execute: false } },
    { index: 7, virtualAddress: 0x600f_ffe8, fileBytes: 0, memoryBytes: 24, permissions: { read: true, write: true, execute: false } },
  ],
);

console.log(JSON.stringify({
  malformedCases: malformed.length,
  realElfSha256: real.elfSha256,
  realEntryPoint: `0x${real.entryPoint.toString(16)}`,
  realLoadSegments: real.loadSegments.length,
}, null, 2));
