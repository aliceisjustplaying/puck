// site/flasher/uf2.ts: a UF2 (USB Flashing Format) parser.
//
// UF2 is Microsoft's flashing container format: a flat sequence of
// 512-byte blocks, each self-describing (its own target address, payload
// size, and position in the sequence), designed to be written to a
// FAT-formatted BOOTSEL drive one block at a time with no ordering
// requirement. We don't use the BOOTSEL-drive path here (see flash.ts,
// which speaks PICOBOOT directly over WebUSB instead), but we still need
// to parse the same container: it's what ships as the .uf2 artifact, and
// it's the thing a person drags onto the drive by hand as the fallback.
//
// Block layout (512 bytes, all fields little-endian):
//   0   u32 magicStart0   0x0A324655 ("UF2\n")
//   4   u32 magicStart1   0x9E5D5157
//   8   u32 flags
//   12  u32 targetAddr    where this block's payload gets written
//   16  u32 payloadSize   bytes of `data` that are meaningful (usually 256)
//   20  u32 blockNo       this block's index within its family's sequence
//   24  u32 numBlocks     total blocks in that sequence
//   28  u32 fileSize/familyID  (familyID when flags & FAMILY_ID_PRESENT)
//   32  u8  data[476]     payload, left-padded with payloadSize bytes used
//   508 u32 magicEnd      0x0AB16F30
//
// A real RP2350 picotool-produced UF2 is NOT one single blockNo/numBlocks
// sequence: it interleaves an "absolute" pseudo-family (0xE48BFF57,
// targetAddr 0x10FFFF00, a sentinel address used for picotool's own
// multi-family bookkeeping, not a real flash write) with the actual
// firmware family (rp2350-arm-s, 0xE48BFF59). Confirmed by inspecting both
// checked-in artifacts by hand: block 0 of each file belongs to the
// 0xE48BFF57 family alone, and every other block belongs to 0xE48BFF59
// with its own self-consistent blockNo 0..N-1 / numBlocks=N. So sequence
// validation groups by family and validates each group independently,
// rather than assuming the whole file is one sequence.

export const UF2_MAGIC_START0 = 0x0a324655;
export const UF2_MAGIC_START1 = 0x9e5d5157;
export const UF2_MAGIC_END = 0x0ab16f30;

export const UF2_FLAG_NOT_MAIN_FLASH = 0x00000001;
export const UF2_FLAG_FILE_CONTAINER = 0x00001000;
export const UF2_FLAG_FAMILY_ID_PRESENT = 0x00002000;
export const UF2_FLAG_MD5_PRESENT = 0x00004000;
export const UF2_FLAG_EXTENSION_TAGS_PRESENT = 0x00008000;

// The only family this flasher ever targets: RP2350's Arm, secure image
// family (per the RP2350 UF2 family ID table). Any other family present in
// a parsed file (e.g. the 0xE48BFF57 absolute/info block above) is left
// alone: it is not part of the flash plan we build.
export const FAMILY_RP2350_ARM_S = 0xe48bff59;
export const FAMILY_RP2040 = 0xe48bff56;

export const UF2_BLOCK_SIZE = 512;
export const UF2_DATA_AREA_SIZE = 476;
export const FLASH_SECTOR_SIZE = 4096;

// PICOBOOT command budgets. FLASH_ERASE and WRITE both accept a size well
// beyond one sector/block (the bootrom happily erases or writes tens of KB
// per command), so the flash cycle should issue as few of each as
// practical rather than one FLASH_ERASE per 4096-byte sector or one WRITE
// per 256-byte UF2 payload: each command costs a full USB round-trip
// (command packet out, ack in), and for a ~190KB image that was ~24 erase
// commands plus ~380 write commands before this budgeting existed, most of
// that time spent waiting on round-trips rather than moving bytes (at
// full-speed USB's 12Mbit/s, 190KB of raw transfer is only ~1.2s).
export const PICOBOOT_MAX_WRITE_SIZE = 32768; // 32KB: comfortably below any bulk-transfer/timeout concern, few enough commands to matter.
export const PICOBOOT_MAX_ERASE_SPAN = 256 * 1024; // 256KB: caps a single erase's device-side duration so it can't risk a USB timeout.

export interface Uf2Block {
  index: number; // this block's position in the file (not blockNo)
  flags: number;
  targetAddr: number;
  payloadSize: number;
  blockNo: number;
  numBlocks: number;
  familyId: number | null; // null when UF2_FLAG_FAMILY_ID_PRESENT is unset
  payload: Uint8Array; // exactly payloadSize bytes
}

export class Uf2ParseError extends Error {}

/** Parse the raw bytes of a .uf2 file into its constituent 512-byte blocks. */
export function parseUf2Blocks(bytes: Uint8Array): Uf2Block[] {
  if (bytes.length === 0 || bytes.length % UF2_BLOCK_SIZE !== 0) {
    throw new Uf2ParseError(`UF2 file size ${bytes.length} is not a nonzero multiple of ${UF2_BLOCK_SIZE}`);
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const count = bytes.length / UF2_BLOCK_SIZE;
  const blocks: Uf2Block[] = [];
  for (let i = 0; i < count; i++) {
    const base = i * UF2_BLOCK_SIZE;
    const magic0 = view.getUint32(base + 0, true);
    const magic1 = view.getUint32(base + 4, true);
    const magicEnd = view.getUint32(base + 508, true);
    if (magic0 !== UF2_MAGIC_START0 || magic1 !== UF2_MAGIC_START1) {
      throw new Uf2ParseError(`block ${i}: bad start magic (0x${magic0.toString(16)} 0x${magic1.toString(16)})`);
    }
    if (magicEnd !== UF2_MAGIC_END) {
      throw new Uf2ParseError(`block ${i}: bad end magic (0x${magicEnd.toString(16)})`);
    }
    const flags = view.getUint32(base + 8, true);
    const targetAddr = view.getUint32(base + 12, true);
    const payloadSize = view.getUint32(base + 16, true);
    const blockNo = view.getUint32(base + 20, true);
    const numBlocks = view.getUint32(base + 24, true);
    const familyOrFileSize = view.getUint32(base + 28, true);
    if (payloadSize > UF2_DATA_AREA_SIZE) {
      throw new Uf2ParseError(`block ${i}: payloadSize ${payloadSize} exceeds the ${UF2_DATA_AREA_SIZE}-byte data area`);
    }
    const payload = bytes.slice(base + 32, base + 32 + payloadSize);
    blocks.push({
      index: i,
      flags,
      targetAddr,
      payloadSize,
      blockNo,
      numBlocks,
      familyId: flags & UF2_FLAG_FAMILY_ID_PRESENT ? familyOrFileSize : null,
      payload,
    });
  }
  return blocks;
}

/** Group parsed blocks by family ID (null-family blocks grouped under the key `-1`). */
export function groupByFamily(blocks: Uf2Block[]): Map<number, Uf2Block[]> {
  const groups = new Map<number, Uf2Block[]>();
  for (const b of blocks) {
    const key = b.familyId ?? -1;
    const list = groups.get(key);
    if (list) list.push(b);
    else groups.set(key, [b]);
  }
  return groups;
}

export interface Uf2WriteChunk {
  addr: number;
  data: Uint8Array;
}

export interface Uf2FlashPlan {
  familyId: number;
  chunks: Uf2WriteChunk[];
  /** Inclusive start of the address range this family's blocks cover. */
  rangeStart: number;
  /** Exclusive end of the address range this family's blocks cover. */
  rangeEnd: number;
  /** Inclusive, 4096-aligned start of the sectors that must be erased. */
  eraseStart: number;
  /** Exclusive, 4096-aligned end of the sectors that must be erased. */
  eraseEnd: number;
}

function alignDown(addr: number, align: number): number {
  return addr - (addr % align);
}
function alignUp(addr: number, align: number): number {
  const rem = addr % align;
  return rem === 0 ? addr : addr + (align - rem);
}

/**
 * Validate one family's blocks form a complete, contiguous, monotonically
 * increasing sequence, and build the flat write-chunk list plus flash/erase
 * ranges for it. Throws on any inconsistency: a gap, a duplicate blockNo, a
 * numBlocks mismatch, or an address that goes backwards or overlaps the
 * previous chunk. `targetAddr` "monotonic within erase alignment" means we
 * don't require every block to be exactly `payloadSize` bytes after the
 * last (a producer could legally pad), only that it never decreases and
 * never overlaps a previously written chunk.
 */
export function computeFlashPlan(blocks: Uf2Block[], familyId: number): Uf2FlashPlan {
  const family = blocks.filter((b) => b.familyId === familyId);
  if (family.length === 0) {
    throw new Uf2ParseError(`no blocks found for family 0x${familyId.toString(16)}`);
  }
  const sorted = [...family].sort((a, b) => a.blockNo - b.blockNo);
  const numBlocks = sorted[0]!.numBlocks;
  for (let i = 0; i < sorted.length; i++) {
    const b = sorted[i]!;
    if (b.numBlocks !== numBlocks) {
      throw new Uf2ParseError(
        `family 0x${familyId.toString(16)}: numBlocks disagreement (block index ${b.index} says ${b.numBlocks}, expected ${numBlocks})`
      );
    }
    if (b.blockNo !== i) {
      throw new Uf2ParseError(`family 0x${familyId.toString(16)}: expected blockNo ${i}, got ${b.blockNo} (block index ${b.index})`);
    }
  }
  if (sorted.length !== numBlocks) {
    throw new Uf2ParseError(`family 0x${familyId.toString(16)}: numBlocks says ${numBlocks} but ${sorted.length} blocks are present`);
  }

  const chunks: Uf2WriteChunk[] = [];
  let prevEnd = -1;
  let rangeStart = Infinity;
  let rangeEnd = -Infinity;
  for (const b of sorted) {
    if (b.targetAddr < prevEnd) {
      throw new Uf2ParseError(
        `family 0x${familyId.toString(16)}: block ${b.blockNo} targetAddr 0x${b.targetAddr.toString(16)} overlaps or goes backwards past 0x${prevEnd.toString(16)}`
      );
    }
    chunks.push({ addr: b.targetAddr, data: b.payload });
    rangeStart = Math.min(rangeStart, b.targetAddr);
    rangeEnd = Math.max(rangeEnd, b.targetAddr + b.payloadSize);
    prevEnd = b.targetAddr + b.payloadSize;
  }

  return {
    familyId,
    chunks,
    rangeStart,
    rangeEnd,
    eraseStart: alignDown(rangeStart, FLASH_SECTOR_SIZE),
    eraseEnd: alignUp(rangeEnd, FLASH_SECTOR_SIZE),
  };
}

export interface Uf2WriteRun {
  addr: number;
  data: Uint8Array;
}

/**
 * Coalesce a flash plan's per-block write chunks (in practice one per
 * 256-byte UF2 payload) into large contiguous runs, so the flash cycle can
 * issue one PICOBOOT WRITE command per run instead of one per chunk.
 * `chunks` must already be ordered by ascending, non-overlapping address
 * (computeFlashPlan's output is). A run keeps absorbing the next chunk as
 * long as that chunk starts exactly where the run currently ends (no gap:
 * a producer is allowed to pad, per computeFlashPlan's own comment, and a
 * gap must start a new run rather than silently skip the hole) and the
 * merge wouldn't exceed `maxRunSize`; either condition failing starts a
 * new run.
 */
export function coalesceWriteRuns(chunks: Uf2WriteChunk[], maxRunSize = PICOBOOT_MAX_WRITE_SIZE): Uf2WriteRun[] {
  if (chunks.length === 0) return [];
  const runs: Uf2WriteRun[] = [];

  let runAddr = chunks[0]!.addr;
  let parts: Uint8Array[] = [chunks[0]!.data];
  let runLen = chunks[0]!.data.length;
  let nextExpectedAddr = runAddr + runLen;

  const flush = () => {
    const combined = new Uint8Array(runLen);
    let offset = 0;
    for (const part of parts) {
      combined.set(part, offset);
      offset += part.length;
    }
    runs.push({ addr: runAddr, data: combined });
  };

  for (let i = 1; i < chunks.length; i++) {
    const chunk = chunks[i]!;
    const contiguous = chunk.addr === nextExpectedAddr;
    const fitsCap = runLen + chunk.data.length <= maxRunSize;
    if (contiguous && fitsCap) {
      parts.push(chunk.data);
      runLen += chunk.data.length;
      nextExpectedAddr = chunk.addr + chunk.data.length;
    } else {
      flush();
      runAddr = chunk.addr;
      parts = [chunk.data];
      runLen = chunk.data.length;
      nextExpectedAddr = runAddr + runLen;
    }
  }
  flush();

  return runs;
}

export interface EraseSpan {
  addr: number;
  size: number;
}

/**
 * Split a flash plan's [eraseStart, eraseEnd) range into as few
 * FLASH_ERASE commands as possible, capping each span at `maxSpanSize`
 * bytes. Both bounds are already 4096-aligned (computeFlashPlan
 * guarantees it), and every span this produces stays aligned too, since
 * maxSpanSize is itself a multiple of FLASH_SECTOR_SIZE.
 */
export function planEraseSpans(eraseStart: number, eraseEnd: number, maxSpanSize = PICOBOOT_MAX_ERASE_SPAN): EraseSpan[] {
  const spans: EraseSpan[] = [];
  for (let addr = eraseStart; addr < eraseEnd; addr += maxSpanSize) {
    spans.push({ addr, size: Math.min(maxSpanSize, eraseEnd - addr) });
  }
  return spans;
}

export interface ParsedUf2 {
  blocks: Uf2Block[];
  familyGroups: Map<number, Uf2Block[]>;
}

export function parseUf2(bytes: Uint8Array): ParsedUf2 {
  const blocks = parseUf2Blocks(bytes);
  return { blocks, familyGroups: groupByFamily(blocks) };
}
