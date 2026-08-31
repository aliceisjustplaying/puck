import { instantiate } from "../../src/wasm";
import type { Elf32XtensaImage } from "./elf-image";

const PAGE_BYTES = 4096;
const RESULT_WORDS = 27;
const RESULT_BYTES = RESULT_WORDS * 4;
const RESULT_ABI_VERSION = 1;

export const FULL_ELF_STOP_REASONS = {
  returned: 1,
  maxSteps: 2,
  unsupported: 3,
  stepError: 4,
  invalidArgument: 5,
  allocationFailed: 6,
  cpuStopped: 7,
  unloadedPage: 10,
  nonExecutablePage: 11,
  romRefused: 12,
} as const;

export interface SparseElfPage {
  readonly address: number;
  readonly flags: number;
  readonly bytes: Uint8Array;
}

export interface UnsupportedInstruction {
  readonly pc: number;
  readonly encoding: number;
}

export interface FullElfStopRecord {
  readonly abiVersion: number;
  readonly structBytes: number;
  readonly reason: number;
  readonly reasonName: keyof typeof FULL_ELF_STOP_REASONS;
  readonly steps: number;
  readonly startPc: number;
  readonly pc: number;
  readonly returnPc: number;
  readonly unsupportedPc: number;
  readonly unsupportedEncoding: number;
  readonly unsupportedLength: number;
  readonly stackPointer: number;
  readonly registers: readonly number[];
}

export interface FullElfRunResult {
  readonly record: FullElfStopRecord;
  readonly trace: readonly number[];
  readonly loadedPages: number;
  readonly logs: readonly string[];
  readonly romEvents: readonly FullElfRomEvent[];
}

export type FullElfRomEvent = Readonly<
  | { kind: "resetReason"; pc: number; core: number; result: number }
  | { kind: "memset"; pc: number; destination: number; value: number; length: number }
>;

interface FullElfExports {
  memory: WebAssembly.Memory;
  flexe_wasm_elf_begin(): number;
  flexe_wasm_elf_configure_rom(resetReasonCore0: number, resetReasonCore1: number, enableMemset: number): number;
  flexe_wasm_elf_load_page(address: number, flags: number): number;
  flexe_wasm_elf_page_capacity(): number;
  flexe_wasm_elf_page_input(): number;
  flexe_wasm_elf_rom_event_capacity(): number;
  flexe_wasm_elf_rom_event_count(): number;
  flexe_wasm_elf_rom_events(): number;
  flexe_wasm_elf_set_unsupported(count: number): number;
  flexe_wasm_elf_trace(): number;
  flexe_wasm_elf_trace_capacity(): number;
  flexe_wasm_elf_trace_count(): number;
  flexe_wasm_elf_unsupported_capacity(): number;
  flexe_wasm_elf_unsupported_input(): number;
  flexe_wasm_run_elf(entry: number, maxSteps: number): number;
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function permissions(flags: Readonly<{ read: boolean; write: boolean; execute: boolean }>): number {
  return (flags.read ? 4 : 0) | (flags.write ? 2 : 0) | (flags.execute ? 1 : 0);
}

export function buildSparseElfPages(image: Elf32XtensaImage, maxPages = 768): readonly SparseElfPage[] {
  const pages = new Map<number, { address: number; flags: number; bytes: Uint8Array }>();
  for (const segment of image.loadSegments) {
    if (segment.memoryBytes === 0) continue;
    const segmentEnd = segment.virtualAddress + segment.memoryBytes;
    const firstPage = Math.floor(segment.virtualAddress / PAGE_BYTES) * PAGE_BYTES;
    const lastPage = Math.floor((segmentEnd - 1) / PAGE_BYTES) * PAGE_BYTES;
    const segmentFlags = permissions(segment.permissions);
    for (let address = firstPage; address <= lastPage; address += PAGE_BYTES) {
      const existing = pages.get(address);
      if (existing) existing.flags |= segmentFlags;
      else {
        assert(pages.size < maxPages, `ELF needs more than ${maxPages} sparse pages`);
        pages.set(address, { address, flags: segmentFlags, bytes: new Uint8Array(PAGE_BYTES) });
      }
    }
    for (let cleared = 0; cleared < segment.memoryBytes;) {
      const address = segment.virtualAddress + cleared;
      const pageAddress = Math.floor(address / PAGE_BYTES) * PAGE_BYTES;
      const pageOffset = address - pageAddress;
      const count = Math.min(segment.memoryBytes - cleared, PAGE_BYTES - pageOffset);
      pages.get(pageAddress)!.bytes.fill(0, pageOffset, pageOffset + count);
      cleared += count;
    }
    for (let copied = 0; copied < segment.fileBytes;) {
      const address = segment.virtualAddress + copied;
      const pageAddress = Math.floor(address / PAGE_BYTES) * PAGE_BYTES;
      const pageOffset = address - pageAddress;
      const count = Math.min(segment.fileBytes - copied, PAGE_BYTES - pageOffset);
      pages.get(pageAddress)!.bytes.set(segment.bytes.subarray(copied, copied + count), pageOffset);
      copied += count;
    }
  }
  return Object.freeze(
    [...pages.values()]
      .sort((left, right) => left.address - right.address)
      .map((page) => Object.freeze(page)),
  );
}

function stopReasonName(reason: number): keyof typeof FULL_ELF_STOP_REASONS {
  const match = Object.entries(FULL_ELF_STOP_REASONS).find(([, value]) => value === reason);
  if (!match) throw new Error(`unknown full ELF stop reason ${reason}`);
  return match[0] as keyof typeof FULL_ELF_STOP_REASONS;
}

function decodeStopRecord(memory: WebAssembly.Memory, pointer: number): FullElfStopRecord {
  const offset = pointer >>> 0;
  assert(offset + RESULT_BYTES <= memory.buffer.byteLength, "full ELF stop record is outside wasm memory");
  const words = new Uint32Array(memory.buffer, offset, RESULT_WORDS);
  assert(words[0] === RESULT_ABI_VERSION, `unexpected full ELF stop record ABI ${words[0]}`);
  assert(words[1] === RESULT_BYTES, `unexpected full ELF stop record size ${words[1]}`);
  return Object.freeze({
    abiVersion: words[0],
    structBytes: words[1],
    reason: words[2],
    reasonName: stopReasonName(words[2]),
    steps: words[3],
    startPc: words[4],
    pc: words[5],
    returnPc: words[6],
    unsupportedPc: words[7],
    unsupportedEncoding: words[8],
    unsupportedLength: words[9],
    stackPointer: words[10],
    registers: Object.freeze([...words.slice(11, 27)]),
  });
}

function checkPointer(memory: WebAssembly.Memory, pointer: number, bytes: number, label: string): number {
  const offset = pointer >>> 0;
  assert(offset + bytes <= memory.buffer.byteLength, `${label} is outside wasm memory`);
  return offset;
}

export async function runSparseXtensaElf(
  moduleBytes: ArrayBuffer,
  image: Elf32XtensaImage,
  options: Readonly<{
    maxSteps?: number;
    unsupported?: readonly UnsupportedInstruction[];
    rom?: Readonly<{ resetReasons: readonly [number, number]; memset?: boolean }>;
  }> = {},
): Promise<FullElfRunResult> {
  const logs: string[] = [];
  const instance = await instantiate(moduleBytes, (text) => logs.push(text));
  const exports = instance as unknown as FullElfExports;
  assert(exports.memory instanceof WebAssembly.Memory, "full ELF module memory export is missing");
  for (const name of [
    "flexe_wasm_elf_begin",
    "flexe_wasm_elf_configure_rom",
    "flexe_wasm_elf_load_page",
    "flexe_wasm_elf_page_capacity",
    "flexe_wasm_elf_page_input",
    "flexe_wasm_elf_rom_event_capacity",
    "flexe_wasm_elf_rom_event_count",
    "flexe_wasm_elf_rom_events",
    "flexe_wasm_elf_set_unsupported",
    "flexe_wasm_elf_trace",
    "flexe_wasm_elf_trace_capacity",
    "flexe_wasm_elf_trace_count",
    "flexe_wasm_elf_unsupported_capacity",
    "flexe_wasm_elf_unsupported_input",
    "flexe_wasm_run_elf",
  ] as const) {
    assert(typeof exports[name] === "function", `full ELF module export ${name} is missing`);
  }

  const maxSteps = options.maxSteps ?? 256;
  const traceCapacity = exports.flexe_wasm_elf_trace_capacity() >>> 0;
  assert(Number.isSafeInteger(maxSteps) && maxSteps > 0, "full ELF maxSteps must be a positive integer");
  assert(maxSteps <= traceCapacity, `full ELF maxSteps ${maxSteps} exceeds trace capacity ${traceCapacity}`);
  const pageCapacity = exports.flexe_wasm_elf_page_capacity() >>> 0;
  const pages = buildSparseElfPages(image, pageCapacity);
  assert(exports.flexe_wasm_elf_begin() === 1, "full ELF module could not initialize sparse memory");

  const pageInput = checkPointer(exports.memory, exports.flexe_wasm_elf_page_input(), PAGE_BYTES, "ELF page input");
  for (const page of pages) {
    new Uint8Array(exports.memory.buffer, pageInput, PAGE_BYTES).set(page.bytes);
    const status = exports.flexe_wasm_elf_load_page(page.address, page.flags) >>> 0;
    assert(status === 1, `full ELF module refused page 0x${page.address.toString(16)} with status ${status}`);
  }

  if (options.rom) {
    for (const reason of options.rom.resetReasons) {
      assert(Number.isSafeInteger(reason) && reason >= 0 && reason <= 0xffff_ffff, "ROM reset reason is invalid");
    }
    assert(
      exports.flexe_wasm_elf_configure_rom(
        options.rom.resetReasons[0],
        options.rom.resetReasons[1],
        options.rom.memset ? 1 : 0,
      ) === 1,
      "full ELF module refused ROM configuration",
    );
  }

  const unsupported = [...(options.unsupported ?? [])].sort((left, right) => left.pc - right.pc);
  const unsupportedCapacity = exports.flexe_wasm_elf_unsupported_capacity() >>> 0;
  assert(unsupported.length <= unsupportedCapacity, `ELF has more than ${unsupportedCapacity} unsupported markers`);
  for (let index = 0; index < unsupported.length; index++) {
    const marker = unsupported[index]!;
    assert(Number.isSafeInteger(marker.pc) && marker.pc >= 0 && marker.pc <= 0xffff_ffff, "unsupported PC is invalid");
    assert(Number.isSafeInteger(marker.encoding) && marker.encoding >= 0 && marker.encoding <= 0xff_ffff, "unsupported encoding is invalid");
    if (index > 0) assert(unsupported[index - 1]!.pc < marker.pc, "unsupported PCs must be unique");
  }
  const unsupportedBytes = unsupported.length * 8;
  const unsupportedInput = checkPointer(
    exports.memory,
    exports.flexe_wasm_elf_unsupported_input(),
    unsupportedBytes,
    "ELF unsupported input",
  );
  const unsupportedWords = new Uint32Array(exports.memory.buffer, unsupportedInput, unsupported.length * 2);
  for (let index = 0; index < unsupported.length; index++) {
    unsupportedWords[index * 2] = unsupported[index]!.pc;
    unsupportedWords[index * 2 + 1] = unsupported[index]!.encoding;
  }
  const unsupportedStatus = exports.flexe_wasm_elf_set_unsupported(unsupported.length) >>> 0;
  assert(unsupportedStatus === 1, `full ELF module refused unsupported markers with status ${unsupportedStatus}`);

  const record = decodeStopRecord(exports.memory, exports.flexe_wasm_run_elf(image.entryPoint, maxSteps));
  const traceCount = exports.flexe_wasm_elf_trace_count() >>> 0;
  assert(traceCount <= traceCapacity, "full ELF module returned an oversized trace");
  const tracePointer = checkPointer(exports.memory, exports.flexe_wasm_elf_trace(), traceCount * 4, "ELF trace");
  const trace = Object.freeze([...new Uint32Array(exports.memory.buffer, tracePointer, traceCount)]);
  assert(trace.length === record.steps, "full ELF trace and executed step count differ");
  const romEventCount = exports.flexe_wasm_elf_rom_event_count() >>> 0;
  const romEventCapacity = exports.flexe_wasm_elf_rom_event_capacity() >>> 0;
  assert(romEventCount <= romEventCapacity, "full ELF module returned too many ROM events");
  const romEventPointer = checkPointer(exports.memory, exports.flexe_wasm_elf_rom_events(), romEventCount * 20, "ELF ROM events");
  const romEventWords = new Uint32Array(exports.memory.buffer, romEventPointer, romEventCount * 5);
  const romEvents: FullElfRomEvent[] = [];
  for (let index = 0; index < romEventCount; index++) {
    const words = romEventWords.subarray(index * 5, index * 5 + 5);
    if (words[0] === 1) {
      romEvents.push(Object.freeze({ kind: "resetReason", pc: words[1], core: words[2], result: words[3] }));
    } else if (words[0] === 2) {
      romEvents.push(Object.freeze({
        kind: "memset",
        pc: words[1],
        destination: words[2],
        value: words[3],
        length: words[4],
      }));
    } else throw new Error(`unknown full ELF ROM event ${words[0]}`);
  }
  return Object.freeze({
    record,
    trace,
    loadedPages: pages.length,
    logs: Object.freeze(logs),
    romEvents: Object.freeze(romEvents),
  });
}
