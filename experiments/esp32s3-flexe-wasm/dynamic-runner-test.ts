import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { instantiate } from "../../src/wasm";
import {
  DEFAULT_ESP32S3_OBJDUMP,
  DEFAULT_FLEXE_SOURCE,
  DEFAULT_TINYDRAW_ESP32S3_ELF,
  DEFAULT_TINYDRAW_ESP32S3_FIXTURE_ELF,
  DEFAULT_TINYDRAW_ESP32S3_FIXTURE_SYMBOL,
  DEFAULT_TINYDRAW_ESP32S3_FULL_ELF,
  DEFAULT_TINYDRAW_ESP32S3_STAGING_ELF,
  DEFAULT_TINYDRAW_ESP32S3_STAGING_SYMBOL,
  EXPECTED_FREESTANDING_EXPORTS,
  EXPECTED_FREESTANDING_IMPORTS,
  FLEXE_COMMIT,
  FLEXE_DISASSEMBLER_SHA256,
  SOURCE_HASHES
} from "./constants";
import {
  extractElfFunction,
  extractElfRange,
  type ExtractedElfFunction,
  type ExtractedElfRange
} from "./elf-fixture";
import { parseFlexeDecoderSurface } from "./isa-inventory";
import { commandVersion, requireSuccess, run, sha256 } from "./lib";

const RESULT_ABI_VERSION = 1;
const RESULT_WORDS = 27;
const RESULT_BYTES = RESULT_WORDS * 4;
const NO_UNSUPPORTED_OFFSET = 0xffffffff;
const INITIAL_STACK = 0x3fcaffc0;
const INITIAL_SOURCE = 0x3fca1000;
const INITIAL_DESTINATION = 0x3fca2000;
const TRACE_ABI_VERSION = 1;
const TRACE_HEADER_WORDS = 6;
const TRACE_RECORD_WORDS = 6;
const TRACE_HEADER_BYTES = TRACE_HEADER_WORDS * 4;
const TRACE_RECORD_BYTES = TRACE_RECORD_WORDS * 4;
const TRACE_CAPACITY = 128;

const STOP_REASONS = {
  returned: 1,
  maxSteps: 2,
  unsupported: 3,
  stepError: 4,
  invalidArgument: 5,
  allocationFailed: 6,
  cpuStopped: 7,
  traceOverflow: 8,
  unmappedAccess: 9
} as const;

const TRACE_KINDS = {
  instruction: 1,
  read: 2,
  write: 3
} as const;

interface DynamicExports {
  memory: WebAssembly.Memory;
  flexe_wasm_data_capacity(): number;
  flexe_wasm_data_input(): number;
  flexe_wasm_data_output(): number;
  flexe_wasm_input(): number;
  flexe_wasm_input_capacity(): number;
  flexe_wasm_run(
    pc: number,
    codeLength: number,
    maxSteps: number,
    unsupportedOffset: number,
    unsupportedEncoding: number
  ): number;
  flexe_wasm_run_data(
    pc: number,
    codeLength: number,
    maxSteps: number,
    unsupportedOffset: number,
    unsupportedEncoding: number,
    dataLength: number
  ): number;
  flexe_wasm_trace(): number;
  flexe_wasm_trace_bytes(): number;
  flexe_wasm_trace_capacity(): number;
  flexe_wasm_run_auxiliary(
    pc: number,
    codeLength: number,
    maxSteps: number,
    auxiliaryAddress: number,
    auxiliaryLength: number
  ): number;
}

interface RunOptions {
  auxiliary?: ExtractedElfRange;
  data?: Uint8Array;
  maxSteps?: number;
  unsupported?: { offset: number; encoding: number };
}

type RunnerFixture = Pick<ExtractedElfFunction, "symbol" | "pc" | "bytes">;

interface StopRecord {
  abiVersion: number;
  structBytes: number;
  reason: number;
  reasonName: keyof typeof STOP_REASONS;
  steps: number;
  startPc: number;
  pc: number;
  returnPc: number;
  unsupportedPc: number;
  unsupportedEncoding: number;
  unsupportedLength: number;
  stackPointer: number;
  registers: number[];
}

interface TraceRecord {
  kind: number;
  kindName: keyof typeof TRACE_KINDS;
  pc: number;
  address: number;
  value: number;
  width: number;
  instruction: number;
}

interface ExecutionTrace {
  abiVersion: number;
  headerBytes: number;
  recordBytes: number;
  count: number;
  capacity: number;
  overflow: boolean;
  records: TraceRecord[];
  rawBytes: Uint8Array;
  sha256: string;
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function conformanceFixture(symbol: string, bytes: number[], pc = 0x4037f000): ExtractedElfFunction {
  const code = Uint8Array.from(bytes);
  return {
    symbol,
    pc,
    endPc: pc + code.length,
    bytes: code,
    codeSha256: createHash("sha256").update(code).digest("hex"),
    elfSha256: "instruction-conformance-fixture",
    objdumpSha256: "instruction-conformance-fixture",
    instructions: []
  };
}

function reasonName(value: number): keyof typeof STOP_REASONS {
  const match = Object.entries(STOP_REASONS).find(([, number]) => number === value);
  if (!match) throw new Error(`unknown dynamic runner stop reason ${value}`);
  return match[0] as keyof typeof STOP_REASONS;
}

function traceKindName(value: number): keyof typeof TRACE_KINDS {
  const match = Object.entries(TRACE_KINDS).find(([, number]) => number === value);
  if (!match) throw new Error(`unknown trace kind ${value}`);
  return match[0] as keyof typeof TRACE_KINDS;
}

function decodeStopRecord(memory: WebAssembly.Memory, pointer: number): StopRecord {
  const offset = pointer >>> 0;
  if (offset + RESULT_BYTES > memory.buffer.byteLength) {
    throw new Error(`stop record pointer ${offset} is outside wasm memory`);
  }
  const words = new Uint32Array(memory.buffer, offset, RESULT_WORDS);
  assert(words[0] === RESULT_ABI_VERSION, `unexpected stop record ABI ${words[0]}`);
  assert(words[1] === RESULT_BYTES, `unexpected stop record size ${words[1]}`);
  return {
    abiVersion: words[0],
    structBytes: words[1],
    reason: words[2],
    reasonName: reasonName(words[2]),
    steps: words[3],
    startPc: words[4],
    pc: words[5],
    returnPc: words[6],
    unsupportedPc: words[7],
    unsupportedEncoding: words[8],
    unsupportedLength: words[9],
    stackPointer: words[10],
    registers: [...words.slice(11, 27)]
  };
}

function decodeTrace(exports: DynamicExports): ExecutionTrace {
  const pointer = exports.flexe_wasm_trace() >>> 0;
  const byteLength = exports.flexe_wasm_trace_bytes() >>> 0;
  assert(pointer + byteLength <= exports.memory.buffer.byteLength, "trace buffer is outside wasm memory");
  assert(byteLength >= TRACE_HEADER_BYTES, `trace buffer is only ${byteLength} bytes`);
  const rawBytes = Uint8Array.from(new Uint8Array(exports.memory.buffer, pointer, byteLength));
  const view = new DataView(rawBytes.buffer, rawBytes.byteOffset, rawBytes.byteLength);
  const abiVersion = view.getUint32(0, true);
  const headerBytes = view.getUint32(4, true);
  const recordBytes = view.getUint32(8, true);
  const count = view.getUint32(12, true);
  const capacity = view.getUint32(16, true);
  const overflowWord = view.getUint32(20, true);
  assert(abiVersion === TRACE_ABI_VERSION, `unexpected trace ABI ${abiVersion}`);
  assert(headerBytes === TRACE_HEADER_BYTES, `unexpected trace header size ${headerBytes}`);
  assert(recordBytes === TRACE_RECORD_BYTES, `unexpected trace record size ${recordBytes}`);
  assert(capacity === TRACE_CAPACITY, `unexpected trace capacity ${capacity}`);
  assert(exports.flexe_wasm_trace_capacity() === capacity, "trace capacity export disagrees with its header");
  assert(count <= capacity, `trace count ${count} exceeds capacity ${capacity}`);
  assert(byteLength === headerBytes + count * recordBytes, "trace byte length disagrees with its header");
  assert(overflowWord === 0 || overflowWord === 1, `invalid trace overflow flag ${overflowWord}`);
  const records: TraceRecord[] = [];
  for (let index = 0; index < count; index++) {
    const offset = headerBytes + index * recordBytes;
    const kind = view.getUint32(offset, true);
    const width = view.getUint32(offset + 16, true);
    if (kind === TRACE_KINDS.instruction) {
      assert(width === 2 || width === 3, `trace instruction record ${index} has unsupported width ${width}`);
    } else {
      assert(width === 1 || width === 2 || width === 4, `trace data record ${index} has unsupported width ${width}`);
    }
    records.push({
      kind,
      kindName: traceKindName(kind),
      pc: view.getUint32(offset + 4, true),
      address: view.getUint32(offset + 8, true),
      value: view.getUint32(offset + 12, true),
      width,
      instruction: view.getUint32(offset + 20, true)
    });
  }
  return {
    abiVersion,
    headerBytes,
    recordBytes,
    count,
    capacity,
    overflow: overflowWord === 1,
    records,
    rawBytes,
    sha256: createHash("sha256").update(rawBytes).digest("hex")
  };
}

async function runFresh(
  moduleBytes: ArrayBuffer,
  fixture: RunnerFixture,
  options: RunOptions = {}
): Promise<{ record: StopRecord; logs: string[]; dataOutput: Uint8Array; trace: ExecutionTrace }> {
  const logs: string[] = [];
  const instance = await instantiate(moduleBytes, (text) => logs.push(text));
  const exports = instance as unknown as DynamicExports;
  assert(typeof exports.flexe_wasm_input === "function", "dynamic input export is missing");
  assert(typeof exports.flexe_wasm_input_capacity === "function", "dynamic capacity export is missing");
  assert(typeof exports.flexe_wasm_run === "function", "dynamic runner export is missing");
  assert(typeof exports.flexe_wasm_data_capacity === "function", "data capacity export is missing");
  assert(typeof exports.flexe_wasm_data_input === "function", "data input export is missing");
  assert(typeof exports.flexe_wasm_data_output === "function", "data output export is missing");
  assert(typeof exports.flexe_wasm_run_data === "function", "data runner export is missing");
  assert(typeof exports.flexe_wasm_trace === "function", "trace buffer export is missing");
  assert(typeof exports.flexe_wasm_trace_bytes === "function", "trace byte length export is missing");
  assert(typeof exports.flexe_wasm_trace_capacity === "function", "trace capacity export is missing");
  assert(typeof exports.flexe_wasm_run_auxiliary === "function", "auxiliary runner export is missing");

  const inputPointer = exports.flexe_wasm_input() >>> 0;
  const inputCapacity = exports.flexe_wasm_input_capacity() >>> 0;
  assert(fixture.bytes.length <= inputCapacity, `${fixture.symbol} exceeds the dynamic input buffer`);
  assert(
    inputPointer + fixture.bytes.length <= exports.memory.buffer.byteLength,
    "dynamic input buffer is outside wasm memory"
  );
  new Uint8Array(exports.memory.buffer, inputPointer, fixture.bytes.length).set(fixture.bytes);
  const data = options.data;
  const auxiliary = options.auxiliary;
  assert(!(data && auxiliary), "data and auxiliary mappings are mutually exclusive");
  let dataOutput = new Uint8Array();
  let recordPointer: number;
  if (data || auxiliary) {
    const mappedInput = data ?? auxiliary!.bytes;
    const dataCapacity = exports.flexe_wasm_data_capacity() >>> 0;
    const dataInputPointer = exports.flexe_wasm_data_input() >>> 0;
    assert(mappedInput.length <= dataCapacity, `${fixture.symbol} mapped input exceeds the dynamic data buffer`);
    assert(dataInputPointer + mappedInput.length <= exports.memory.buffer.byteLength, "data input is outside wasm memory");
    new Uint8Array(exports.memory.buffer, dataInputPointer, mappedInput.length).set(mappedInput);
    if (data) {
      recordPointer = exports.flexe_wasm_run_data(
        fixture.pc,
        fixture.bytes.length,
        options.maxSteps ?? 64,
        options.unsupported?.offset ?? NO_UNSUPPORTED_OFFSET,
        options.unsupported?.encoding ?? 0,
        data.length
      );
      const dataOutputPointer = exports.flexe_wasm_data_output() >>> 0;
      assert(dataOutputPointer + data.length <= exports.memory.buffer.byteLength, "data output is outside wasm memory");
      dataOutput = Uint8Array.from(new Uint8Array(exports.memory.buffer, dataOutputPointer, data.length));
    } else {
      assert(!options.unsupported, "auxiliary runs do not accept an unsupported marker");
      recordPointer = exports.flexe_wasm_run_auxiliary(
        fixture.pc,
        fixture.bytes.length,
        options.maxSteps ?? 64,
        auxiliary!.address,
        auxiliary!.bytes.length
      );
    }
  } else {
    recordPointer = exports.flexe_wasm_run(
      fixture.pc,
      fixture.bytes.length,
      options.maxSteps ?? 64,
      options.unsupported?.offset ?? NO_UNSUPPORTED_OFFSET,
      options.unsupported?.encoding ?? 0
    );
  }
  const record = decodeStopRecord(exports.memory, recordPointer);
  const trace = decodeTrace(exports);
  assert(
    trace.overflow === (record.reason === STOP_REASONS.traceOverflow),
    "trace overflow flag and stop reason disagree"
  );
  return { record, logs, dataOutput, trace };
}

const dist = resolve(process.env.FLEXE_WASM_DIST ?? join(import.meta.dir, "dist"));
const flexeSource = resolve(process.env.FLEXE_SOURCE ?? DEFAULT_FLEXE_SOURCE);
const modulePath = join(dist, "flexe-probe-freestanding.wasm");
const moduleBytes = await Bun.file(modulePath).arrayBuffer();
const moduleSha256 = createHash("sha256").update(new Uint8Array(moduleBytes)).digest("hex");
const module = await WebAssembly.compile(moduleBytes);
const imports = WebAssembly.Module.imports(module).map((item) => `${item.module}.${item.name}`).sort();
const exports = WebAssembly.Module.exports(module).map((item) => item.name).sort();
assert(
  JSON.stringify(imports) === JSON.stringify([...EXPECTED_FREESTANDING_IMPORTS].sort()),
  `dynamic module import closure changed: ${JSON.stringify(imports)}`
);
assert(
  JSON.stringify(exports) === JSON.stringify([...EXPECTED_FREESTANDING_EXPORTS].sort()),
  `dynamic module export closure changed: ${JSON.stringify(exports)}`
);

const scalar = extractElfFunction(
  DEFAULT_ESP32S3_OBJDUMP,
  DEFAULT_TINYDRAW_ESP32S3_ELF,
  "tlsf_alloc_overhead"
);
assert(scalar.elfSha256 === "a46349d9bc5eb3e58fad64f95e433c0b505ea3fa9737664d2d0f4945534b9644", "scalar ELF changed");
assert(scalar.objdumpSha256 === "90a91caa519b895bd457f4eb7c5fd6b14a9c64c0c7d946e78e7f332ea57d7466", "objdump changed");
assert(scalar.pc === 0x403808f4, "scalar function PC changed");
assert(scalar.codeSha256 === "cebc5d75741ee728f371bf15e6f834d1cacd50ce35b264385313c30b542ee7b7", "scalar code changed");
assert(scalar.instructions.map((row) => row.rawMnemonic).join(",") === "entry,movi.n,retw.n", "scalar instruction path changed");
const scalarRun = await runFresh(moduleBytes, scalar);
assert(scalarRun.record.reason === STOP_REASONS.returned, `scalar stopped with ${scalarRun.record.reasonName}`);
assert(scalarRun.record.steps === 3, `scalar executed ${scalarRun.record.steps} instructions`);
assert(scalarRun.record.pc === scalarRun.record.returnPc, "scalar did not reach the synthetic caller");
assert(scalarRun.record.stackPointer === INITIAL_STACK, "scalar did not restore the caller stack pointer");
assert(scalarRun.record.registers[10] === 4, `scalar returned ${scalarRun.record.registers[10]} in caller a10`);
assert(scalarRun.logs.length === 0, `scalar emitted logs: ${JSON.stringify(scalarRun.logs)}`);
const boundedRun = await runFresh(moduleBytes, scalar, { maxSteps: 2 });
assert(boundedRun.record.reason === STOP_REASONS.maxSteps, "scalar ignored the instruction bound");
assert(boundedRun.record.steps === 2, `bounded scalar executed ${boundedRun.record.steps} instructions`);
assert(boundedRun.record.pc === 0x403808f9, "bounded scalar did not stop before retw.n");

const scalarIsaFixture = conformanceFixture("esp32s3_scalar_load_store", [
  0x36, 0x21, 0x00,
  0x48, 0x02,
  0x40, 0x03, 0x59,
  0x03, 0x82, 0x01,
  0x03, 0xc3, 0x01,
  0x1d, 0xf0
]);
const scalarIsaInput = Uint8Array.from([0x78, 0x56, 0x34, 0x12]);
const scalarIsaRun = await runFresh(moduleBytes, scalarIsaFixture, { data: scalarIsaInput });
assert(scalarIsaRun.record.reason === STOP_REASONS.returned, `scalar ISA fixture stopped with ${scalarIsaRun.record.reasonName}`);
assert(scalarIsaRun.record.steps === 6, `scalar ISA fixture executed ${scalarIsaRun.record.steps} instructions`);
assert(
  scalarIsaRun.dataOutput.every((byte, index) => byte === scalarIsaInput[index]),
  `scalar ISA fixture output changed: ${Buffer.from(scalarIsaRun.dataOutput).toString("hex")}`
);
assert(scalarIsaRun.record.registers[10] === 0x3fca1004, "lsip did not post-increment its base");
assert(scalarIsaRun.record.registers[11] === 0x3fca2004, "ssip did not post-increment its base");

const qrIsaFixture = conformanceFixture("esp32s3_qr_load_store", [
  0x36, 0x21, 0x00,
  0x24, 0x20, 0xcd,
  0x34, 0x60, 0xcd,
  0x1d, 0xf0
]);
const qrIsaInput = Uint8Array.from({ length: 16 }, (_, index) => index * 11);
const qrIsaRun = await runFresh(moduleBytes, qrIsaFixture, { data: qrIsaInput });
assert(qrIsaRun.record.reason === STOP_REASONS.returned, `QR ISA fixture stopped with ${qrIsaRun.record.reasonName}`);
assert(qrIsaRun.record.steps === 4, `QR ISA fixture executed ${qrIsaRun.record.steps} instructions`);
assert(
  qrIsaRun.dataOutput.every((byte, index) => byte === qrIsaInput[index]),
  `QR ISA fixture output changed: ${Buffer.from(qrIsaRun.dataOutput).toString("hex")}`
);

const qrXpFixture = conformanceFixture("esp32s3_qr_register_postincrement_load", [
  0x3b, 0xaa,
  0xa4, 0xac, 0xbd,
  0xb4, 0xe0, 0xfd
]);
const qrXpInput = Uint8Array.from({ length: 16 }, (_, index) => (index * 13 + 5) & 0xff);
const qrXpRun = await runFresh(moduleBytes, qrXpFixture, { data: qrXpInput, maxSteps: 3 });
assert(qrXpRun.record.reason === STOP_REASONS.maxSteps, `QR XP fixture stopped with ${qrXpRun.record.reasonName}`);
assert(qrXpRun.record.steps === 3, `QR XP fixture executed ${qrXpRun.record.steps} instructions`);
assert(
  qrXpRun.dataOutput.every((byte, index) => byte === qrXpInput[index]),
  `QR XP fixture output changed: ${Buffer.from(qrXpRun.dataOutput).toString("hex")}`
);
assert(qrXpRun.record.registers[10] === INITIAL_SOURCE + 11, "QR XP load did not add its register postincrement");
assert(qrXpRun.record.registers[12] === 8, "QR XP load changed its increment register");

const halfQrFixture = conformanceFixture("esp32s3_qr_half_load_store", [
  0xa4, 0xa0, 0xfd,
  0xa2, 0xca, 0x13,
  0xa4, 0xff, 0xf9,
  0xa2, 0xca, 0x12,
  0xa4, 0xff, 0xf8,
  0xb4, 0xe0, 0xfd,
  0xb2, 0xcb, 0x13,
  0xb4, 0xff, 0xfb
]);
const halfQrInput = Uint8Array.from({ length: 32 }, (_, index) => (index * 7 + 3) & 0xff);
const halfQrExpected = new Uint8Array(32);
halfQrExpected.set(halfQrInput.slice(16, 32), 0);
halfQrExpected.set(halfQrInput.slice(24, 32), 16);
const halfQrRun = await runFresh(moduleBytes, halfQrFixture, { data: halfQrInput, maxSteps: 8 });
assert(halfQrRun.record.reason === STOP_REASONS.maxSteps, `QR half fixture stopped with ${halfQrRun.record.reasonName}`);
assert(halfQrRun.record.steps === 8, `QR half fixture executed ${halfQrRun.record.steps} instructions`);
assert(
  halfQrRun.dataOutput.every((byte, index) => byte === halfQrExpected[index]),
  `QR half fixture output changed: ${Buffer.from(halfQrRun.dataOutput).toString("hex")}`
);
assert(halfQrRun.record.registers[10] === INITIAL_SOURCE + 21, "QR half loads did not apply signed post-increments");
assert(halfQrRun.record.registers[11] === INITIAL_DESTINATION + 11, "QR half store did not apply its signed post-increment");

const unsupportedXpFixture = conformanceFixture("esp32s3_unsupported_vld_l_64_xp", [0xa4, 0x3c, 0x8d]);
const unsupportedXpRun = await runFresh(moduleBytes, unsupportedXpFixture, {
  maxSteps: 1,
  unsupported: { offset: 0, encoding: 0x8d3ca4 }
});
assert(unsupportedXpRun.record.reason === STOP_REASONS.unsupported, "adjacent half XP form did not fail closed");
assert(unsupportedXpRun.record.steps === 0, "adjacent half XP form was counted as executed");
assert(unsupportedXpRun.trace.count === 0, "adjacent half XP refusal leaked a trace record");
assert(unsupportedXpRun.dataOutput.length === 0, "adjacent half XP refusal exposed data output");
const unsupportedXpRegisters = Array<number>(16).fill(0);
unsupportedXpRegisters[1] = INITIAL_STACK;
unsupportedXpRegisters[8] = ((2 << 30) | (unsupportedXpRun.record.returnPc & 0x3fff_ffff)) >>> 0;
unsupportedXpRegisters[10] = INITIAL_SOURCE;
unsupportedXpRegisters[11] = INITIAL_DESTINATION;
unsupportedXpRegisters[12] = 1;
assert(
  unsupportedXpRun.record.registers.every((value, index) => value === unsupportedXpRegisters[index]),
  "adjacent half XP refusal changed registers"
);

const float64XpFixture = conformanceFixture("esp32s3_float_pair_register_postincrement", [
  0x3b, 0xaa,
  0xa0, 0xfc, 0x06,
  0x3b, 0xbb,
  0xb0, 0xfc, 0x07
]);
const float64XpInput = Uint8Array.from([0x01, 0x00, 0xc0, 0x7f, 0xef, 0xbe, 0xad, 0xde]);
const float64XpRun = await runFresh(moduleBytes, float64XpFixture, { data: float64XpInput, maxSteps: 4 });
assert(float64XpRun.record.reason === STOP_REASONS.maxSteps, `float-pair XP fixture stopped with ${float64XpRun.record.reasonName}`);
assert(float64XpRun.record.steps === 4, `float-pair XP fixture executed ${float64XpRun.record.steps} instructions`);
assert(
  float64XpRun.dataOutput.every((byte, index) => byte === float64XpInput[index]),
  `float-pair XP fixture changed payload bits: ${Buffer.from(float64XpRun.dataOutput).toString("hex")}`
);
assert(float64XpRun.record.registers[10] === INITIAL_SOURCE + 7, "float-pair load did not add its register postincrement");
assert(float64XpRun.record.registers[11] === INITIAL_DESTINATION + 7, "float-pair store did not add its register postincrement");

const unsupportedFloat128Fixture = conformanceFixture("esp32s3_unsupported_ldf_128_xp", [0xae, 0x1c, 0x0f, 0x8f]);
const unsupportedFloat128Run = await runFresh(moduleBytes, unsupportedFloat128Fixture, {
  maxSteps: 1,
  unsupported: { offset: 0, encoding: 0x1cae }
});
assert(unsupportedFloat128Run.record.reason === STOP_REASONS.unsupported, "adjacent float-128 XP form did not fail closed");
assert(unsupportedFloat128Run.record.steps === 0, "adjacent float-128 XP form was counted as executed");
assert(unsupportedFloat128Run.trace.count === 0, "adjacent float-128 XP refusal leaked a trace record");
assert(unsupportedFloat128Run.dataOutput.length === 0, "adjacent float-128 XP refusal exposed data output");
assert(
  unsupportedFloat128Run.record.registers.every((value, index) => value === unsupportedXpRegisters[index]),
  "adjacent float-128 XP refusal changed registers"
);

const threadptrFixture = conformanceFixture("esp32s3_threadptr_roundtrip", [
  0x36, 0x21, 0x00,
  0x81, 0x12, 0xfa,
  0x80, 0xe7, 0xf3,
  0x70, 0x2e, 0xe3,
  0x1d, 0xf0
], 0x40375ce1);
const threadptrLiterals = extractElfRange(DEFAULT_ESP32S3_OBJDUMP, DEFAULT_TINYDRAW_ESP32S3_FULL_ELF, 0x40374000, 4096);
const threadptrRun = await runFresh(moduleBytes, threadptrFixture, { auxiliary: threadptrLiterals });
assert(threadptrRun.record.reason === STOP_REASONS.returned, `THREADPTR fixture stopped with ${threadptrRun.record.reasonName}`);
assert(threadptrRun.record.steps === 5, `THREADPTR fixture executed ${threadptrRun.record.steps} instructions`);
assert(
  threadptrRun.record.registers[10] === 0x3fcabf20,
  `THREADPTR round trip returned 0x${threadptrRun.record.registers[10].toString(16)}`
);

const accxFixture = conformanceFixture("esp32s3_accx_roundtrip", [
  0xb2, 0xa1, 0xab,
  0xa0, 0x00, 0xf3,
  0xb0, 0x01, 0xf3,
  0x00, 0xc0, 0xe3,
  0x10, 0xd0, 0xe3
]);
const accxRun = await runFresh(moduleBytes, accxFixture, { maxSteps: 5 });
assert(accxRun.record.reason === STOP_REASONS.maxSteps, `ACCX fixture stopped with ${accxRun.record.reasonName}`);
assert(accxRun.record.steps === 5, `ACCX fixture executed ${accxRun.record.steps} instructions`);
assert(accxRun.record.registers[12] === INITIAL_SOURCE, "ACCX_0 round trip changed its value");
assert(accxRun.record.registers[13] === 0xab, "ACCX_1 did not preserve exactly its low 8 bits");

const qaccFixture = conformanceFixture("esp32s3_qacc_roundtrip", [
  0xa0, 0x02, 0xf3, 0xa0, 0x03, 0xf3, 0xa0, 0x04, 0xf3, 0xa0, 0x05, 0xf3, 0xa0, 0x06, 0xf3,
  0xb0, 0x07, 0xf3, 0xb0, 0x08, 0xf3, 0xb0, 0x09, 0xf3, 0xb0, 0x0a, 0xf3, 0xb0, 0x0b, 0xf3,
  0x20, 0x20, 0xe3, 0x30, 0x30, 0xe3, 0x40, 0x40, 0xe3, 0x50, 0x50, 0xe3, 0x60, 0x60, 0xe3,
  0x70, 0x70, 0xe3, 0x80, 0x90, 0xe3, 0x90, 0xd0, 0xe3, 0xa0, 0xe0, 0xe3, 0xb0, 0xf0, 0xe3
]);
const qaccRun = await runFresh(moduleBytes, qaccFixture, { maxSteps: 20 });
assert(qaccRun.record.reason === STOP_REASONS.maxSteps, `QACC fixture stopped with ${qaccRun.record.reasonName}`);
assert(qaccRun.record.steps === 20, `QACC fixture executed ${qaccRun.record.steps} instructions`);
assert(
  [2, 3, 4, 5, 6].every((register) => qaccRun.record.registers[register] === INITIAL_SOURCE),
  "QACC high bank round trip changed a value"
);
assert(
  [7, 9, 13, 14, 15].every((register) => qaccRun.record.registers[register] === INITIAL_DESTINATION),
  "QACC low bank round trip changed a value"
);

const sarFftFixture = conformanceFixture("esp32s3_sar_fft_roundtrip", [
  0xa2, 0xa1, 0xab,
  0xb2, 0xa1, 0xc5,
  0xa0, 0x0d, 0xf3,
  0xb0, 0x0e, 0xf3,
  0xd0, 0xc0, 0xe3,
  0xe0, 0xd0, 0xe3
]);
const sarFftRun = await runFresh(moduleBytes, sarFftFixture, { maxSteps: 6 });
assert(sarFftRun.record.reason === STOP_REASONS.maxSteps, `SAR/FFT fixture stopped with ${sarFftRun.record.reasonName}`);
assert(sarFftRun.record.steps === 6, `SAR/FFT fixture executed ${sarFftRun.record.steps} instructions`);
assert(sarFftRun.record.registers[12] === 0xb, "SAR_BYTE did not preserve exactly its low 4 bits");
assert(sarFftRun.record.registers[13] === 0x5, "FFT_BIT_WIDTH did not preserve exactly its low 4 bits");

const uaStateFixture = conformanceFixture("esp32s3_ua_state_roundtrip", [
  0x1c, 0x1a, 0x2c, 0x2b, 0x3c, 0x3c, 0x4c, 0x4d,
  0xa0, 0x0f, 0xf3, 0xb0, 0x10, 0xf3, 0xc0, 0x11, 0xf3, 0xd0, 0x12, 0xf3,
  0xf0, 0x20, 0xe3, 0x00, 0x31, 0xe3, 0x10, 0x41, 0xe3, 0x20, 0x51, 0xe3
]);
const uaStateRun = await runFresh(moduleBytes, uaStateFixture, { maxSteps: 12 });
assert(uaStateRun.record.reason === STOP_REASONS.maxSteps, `UA_STATE fixture stopped with ${uaStateRun.record.reasonName}`);
assert(uaStateRun.record.steps === 12, `UA_STATE fixture executed ${uaStateRun.record.steps} instructions`);
assert(
  uaStateRun.record.registers.slice(2, 6).every((value, index) => value === [0x11, 0x22, 0x33, 0x44][index]),
  "UA_STATE round trip changed a value"
);

const unknownUserRegisterFixture = conformanceFixture("esp32s3_unknown_user_register", [0x80, 0x0c, 0xf3]);
const unknownUserRegisterRun = await runFresh(moduleBytes, unknownUserRegisterFixture, { maxSteps: 1 });
assert(
  unknownUserRegisterRun.record.reason === STOP_REASONS.stepError,
  `unknown user register stopped with ${unknownUserRegisterRun.record.reasonName}`
);
assert(unknownUserRegisterRun.record.steps === 0, "unknown user register was counted as executed");
assert(unknownUserRegisterRun.record.pc === unknownUserRegisterFixture.pc, "failed decoder step changed PC");
assert(unknownUserRegisterRun.trace.count === 0, "failed decoder step leaked a trace record");
const failedStepRegisters = Array<number>(16).fill(0);
failedStepRegisters[1] = INITIAL_STACK;
failedStepRegisters[8] = ((2 << 30) | (unknownUserRegisterRun.record.returnPc & 0x3fff_ffff)) >>> 0;
failedStepRegisters[10] = INITIAL_SOURCE;
failedStepRegisters[11] = INITIAL_DESTINATION;
failedStepRegisters[12] = 1;
assert(
  unknownUserRegisterRun.record.registers.every((value, index) => value === failedStepRegisters[index]),
  "failed decoder step changed registers",
);

const entry = extractElfFunction(DEFAULT_ESP32S3_OBJDUMP, DEFAULT_TINYDRAW_ESP32S3_ELF, "call_start_cpu0");
const entryAuxiliary = extractElfRange(DEFAULT_ESP32S3_OBJDUMP, DEFAULT_TINYDRAW_ESP32S3_ELF, 0x40374000, 4096);
assert(entry.pc === 0x40375a54, "reset entry PC changed");
assert(entry.codeSha256 === "a29017f57f57d4a02c87b4e63e0ade179c21e3382b264bf5cd4217defc984aaf", "reset entry code changed");
assert(entryAuxiliary.sha256 === "f2f990dd3f25c373615b4d0d9bb58e372d32a19db242ebf7c9c2e999c61e3b2e", "reset literal page changed");
assert(
  entry.instructions.slice(0, 6).map((row) => row.rawMnemonic).join(",") ===
    "entry,l32r,wsr.vecbase,movi.n,l32r,callx8",
  "reset entry prefix changed"
);
const entryRun = await runFresh(moduleBytes, entry, { auxiliary: entryAuxiliary, maxSteps: 5 });
assert(entryRun.record.reason === STOP_REASONS.maxSteps, `reset entry stopped with ${entryRun.record.reasonName}`);
assert(entryRun.record.steps === 5, `reset entry executed ${entryRun.record.steps} instructions`);
assert(entryRun.record.pc === 0x40375a62, `reset entry stopped at 0x${entryRun.record.pc.toString(16)}`);
assert(entryRun.record.registers[8] === 0x4000057c, "second reset literal load did not resolve the ROM target");

const pie = extractElfFunction(
  DEFAULT_ESP32S3_OBJDUMP,
  DEFAULT_TINYDRAW_ESP32S3_FIXTURE_ELF,
  DEFAULT_TINYDRAW_ESP32S3_FIXTURE_SYMBOL
);
assert(pie.elfSha256 === "591c4d9b5ade8f978f2a910e48e2bf9af345c781bdbed1ac6f1ffa2383c7a742", "PIE fixture ELF changed");
assert(pie.pc === 0x40377698, "PIE fixture PC changed");
assert(pie.codeSha256 === "f0503e09af131793fa0dfdf9077a9d433225c08962672d7f492f1496b15d1c75", "PIE fixture code changed");
const pieGap = pie.instructions.find((row) => row.addressValue === 0x403776a0);
assert(pieGap?.objdumpEncoding === "830124", "PIE gap encoding changed");
assert(pieGap.rawMnemonic === "ee.vld.128.ip", "PIE gap mnemonic changed");
const pieRefusalRun = await runFresh(moduleBytes, pie, {
  unsupported: {
    offset: pieGap.addressValue - pie.pc,
    encoding: Number.parseInt(pieGap.objdumpEncoding, 16)
  }
});
const pieBoundaryRun = await runFresh(moduleBytes, pie, { maxSteps: 3 });
assert(pieRefusalRun.record.reason === STOP_REASONS.unsupported, `PIE refusal stopped with ${pieRefusalRun.record.reasonName}`);
assert(pieRefusalRun.record.steps === 3, `PIE refusal executed ${pieRefusalRun.record.steps} supported instructions`);
assert(pieRefusalRun.record.pc === pieGap.addressValue, `PIE refusal stopped at 0x${pieRefusalRun.record.pc.toString(16)}`);
assert(pieRefusalRun.record.unsupportedPc === pieGap.addressValue, "unsupported hook reported the wrong PC");
assert(pieRefusalRun.record.unsupportedEncoding === 0x830124, "unsupported hook reported the wrong encoding");
assert(pieRefusalRun.record.unsupportedLength === 3, "unsupported hook reported the wrong instruction length");
assert(pieRefusalRun.record.registers[4] === 1, "deterministic loop count did not enter the PIE body");
assert(pieBoundaryRun.record.reason === STOP_REASONS.maxSteps, "PIE boundary control did not reach its step bound");
assert(
  pieRefusalRun.record.pc === pieBoundaryRun.record.pc &&
    pieRefusalRun.record.stackPointer === pieBoundaryRun.record.stackPointer &&
    JSON.stringify(pieRefusalRun.record.registers) === JSON.stringify(pieBoundaryRun.record.registers),
  "unsupported hook changed architectural state at its instruction boundary"
);
const pieInput = Uint8Array.from([0x34, 0x12]);
const pieRun = await runFresh(moduleBytes, pie, { data: pieInput });
assert(pieRun.record.reason === STOP_REASONS.returned, `PIE fixture stopped with ${pieRun.record.reasonName}`);
assert(pieRun.record.steps === 10, `PIE fixture executed ${pieRun.record.steps} instructions`);
assert(pieRun.record.pc === pieRun.record.returnPc, "PIE fixture did not reach the synthetic caller");
assert(pieRun.record.unsupportedPc === 0, "PIE fixture reported an unsupported instruction");
assert(Buffer.from(pieRun.dataOutput).toString("hex") === "1234", "PIE byte-swap output changed");
assert(pieRun.logs.length === 0, `PIE fixture emitted logs: ${JSON.stringify(pieRun.logs)}`);

const staging = extractElfFunction(
  DEFAULT_ESP32S3_OBJDUMP,
  DEFAULT_TINYDRAW_ESP32S3_STAGING_ELF,
  DEFAULT_TINYDRAW_ESP32S3_STAGING_SYMBOL
);
assert(staging.elfSha256 === "522b33cb491bbc9c8a61a364b3c986c7f1d013bcdf228f79791981f7fcad1491", "staging ELF changed");
assert(staging.objdumpSha256 === "90a91caa519b895bd457f4eb7c5fd6b14a9c64c0c7d946e78e7f332ea57d7466", "objdump changed");
assert(staging.pc === 0x42058230, "staging function PC changed");
assert(staging.codeSha256 === "a545acd197c5b75f0351256aa6a9c8a7028cb42f91e617c28317fa560d873877", "staging code changed");
const stagingMnemonics = staging.instructions.map((row) => row.rawMnemonic);
assert(
  stagingMnemonics.join(",") ===
    "entry,blti,add.n,addi,srli,addi,loop,l16ui,addi.n,extui,slli,or,s16i,addi.n,retw.n",
  "staging instruction path changed"
);
const decoderPath = join(flexeSource, "src/xtensa_disasm.c");
const decoderText = readFileSync(decoderPath, "utf8");
assert(sha256(decoderPath) === FLEXE_DISASSEMBLER_SHA256, "flexe decoder source changed");
const decoder = parseFlexeDecoderSurface(decoderText, FLEXE_DISASSEMBLER_SHA256);
const decoderMnemonics = new Set(decoder.normalizedMnemonics);
const stagingGap = staging.instructions.find((row) => !decoderMnemonics.has(row.normalizedMnemonic));
if (stagingGap) throw new Error(`staging decoder gap at ${stagingGap.address}`);
const stagingInput = Uint8Array.from([0x34, 0x12, 0xcd, 0xab, 0xff, 0x00, 0x1f, 0xf8, 0xe0, 0x07]);
const expectedStagingOutput = Uint8Array.from([0x12, 0x34, 0xab, 0xcd, 0x00, 0xff, 0xf8, 0x1f, 0x07, 0xe0]);
const stagingRun = await runFresh(moduleBytes, staging, { data: stagingInput, maxSteps: 128 });
const stagingOutputSha256 = createHash("sha256").update(stagingRun.dataOutput).digest("hex");
assert(stagingRun.record.reason === STOP_REASONS.returned, `staging stopped with ${stagingRun.record.reasonName}`);
assert(stagingRun.record.steps === 43, `staging executed ${stagingRun.record.steps} instructions`);
assert(stagingRun.record.pc === stagingRun.record.returnPc, "staging did not reach the synthetic caller");
assert(stagingRun.record.stackPointer === INITIAL_STACK, "staging did not restore the caller stack pointer");
assert(
  stagingRun.dataOutput.every((byte, index) => byte === expectedStagingOutput[index]),
  `staging output changed: ${Buffer.from(stagingRun.dataOutput).toString("hex")}`
);
assert(stagingRun.logs.length === 0, `staging emitted logs: ${JSON.stringify(stagingRun.logs)}`);
assert(!stagingRun.trace.overflow, "staging trace overflowed");
assert(stagingRun.trace.count === 53, `staging emitted ${stagingRun.trace.count} trace records`);
const instructionTuple = (index: number): number[] => {
  const row = staging.instructions[index];
  return [
    TRACE_KINDS.instruction,
    row.addressValue,
    0,
    0,
    row.objdumpEncoding.length / 2,
    Number.parseInt(row.objdumpEncoding, 16)
  ];
};
const expectedStagingTrace: number[][] = [];
for (let index = 0; index <= 6; index++) expectedStagingTrace.push(instructionTuple(index));
for (let pixel = 0; pixel < stagingInput.length / 2; pixel++) {
  expectedStagingTrace.push(instructionTuple(7));
  expectedStagingTrace.push([
    TRACE_KINDS.read,
    staging.instructions[7].addressValue,
    INITIAL_SOURCE + pixel * 2,
    stagingInput[pixel * 2] | (stagingInput[pixel * 2 + 1] << 8),
    2,
    0
  ]);
  for (let index = 8; index <= 12; index++) expectedStagingTrace.push(instructionTuple(index));
  expectedStagingTrace.push([
    TRACE_KINDS.write,
    staging.instructions[12].addressValue,
    INITIAL_DESTINATION + pixel * 2,
    expectedStagingOutput[pixel * 2] | (expectedStagingOutput[pixel * 2 + 1] << 8),
    2,
    0
  ]);
  expectedStagingTrace.push(instructionTuple(13));
}
expectedStagingTrace.push(instructionTuple(14));
const actualStagingTrace = stagingRun.trace.records.map((record) => [
  record.kind,
  record.pc,
  record.address,
  record.value,
  record.width,
  record.instruction
]);
assert(
  JSON.stringify(actualStagingTrace) === JSON.stringify(expectedStagingTrace),
  "staging instruction or data-access trace changed"
);
assert(
  stagingRun.trace.records.filter((record) => record.kind === TRACE_KINDS.instruction).length === 43,
  "staging trace does not contain 43 instructions"
);
assert(
  stagingRun.trace.records.filter((record) => record.kind === TRACE_KINDS.read).length === 5,
  "staging trace does not contain five source reads"
);
assert(
  stagingRun.trace.records.filter((record) => record.kind === TRACE_KINDS.write).length === 5,
  "staging trace does not contain five destination writes"
);

const overflowInput = Uint8Array.from({ length: 28 }, (_, index) => index);
const overflowFixture: RunnerFixture = {
  symbol: `${staging.symbol}:memory-overflow`,
  pc: staging.pc - 6,
  bytes: Uint8Array.from([0x3d, 0xf0, 0x3d, 0xf0, 0x3d, 0xf0, ...staging.bytes]),
};
const overflowRun = await runFresh(moduleBytes, overflowFixture, { data: overflowInput, maxSteps: 256 });
assert(overflowRun.record.reason === STOP_REASONS.traceOverflow, "trace overflow was not an explicit stop");
assert(overflowRun.record.steps === 101, `overflow run executed ${overflowRun.record.steps} instructions`);
assert(
  overflowRun.record.pc === staging.instructions[7].addressValue,
  `overflow run stopped at 0x${overflowRun.record.pc.toString(16)}`
);
assert(overflowRun.trace.overflow, "overflow run did not set the trace overflow flag");
assert(overflowRun.trace.count === TRACE_CAPACITY - 1, "overflow run retained a partial memory instruction");
assert(
  overflowRun.trace.records.filter((record) => record.kind === TRACE_KINDS.read).length === 13,
  "overflow run retained the read that exceeded trace capacity",
);
assert(
  overflowRun.trace.records.filter((record) => record.kind === TRACE_KINDS.write).length === 13,
  "overflow run lost a completed write before trace overflow",
);
assert(
  overflowRun.record.registers[9] === 0x191819,
  `overflowing read advanced architectural register state: 0x${overflowRun.record.registers[9]!.toString(16)}`,
);
assert(
  overflowRun.dataOutput.slice(0, 26).every((byte, index) => byte === overflowInput[index ^ 1]),
  "overflow rollback corrupted completed destination writes",
);
assert(
  overflowRun.dataOutput.slice(26).every((byte) => byte === 0),
  "overflowing instruction advanced destination memory",
);
assert(overflowRun.logs.length === 0, `overflow run emitted logs: ${JSON.stringify(overflowRun.logs)}`);

const instructionOverflowFixture: RunnerFixture = {
  symbol: "trace_instruction_overflow",
  pc: 0x420d6000,
  bytes: Uint8Array.from(
    Array.from({ length: TRACE_CAPACITY + 1 }, () => [0x3d, 0xf0]).flat()
  )
};
const instructionBoundaryRun = await runFresh(moduleBytes, instructionOverflowFixture, {
  maxSteps: TRACE_CAPACITY
});
const instructionOverflowRun = await runFresh(moduleBytes, instructionOverflowFixture, { maxSteps: 256 });
assert(
  instructionBoundaryRun.record.reason === STOP_REASONS.maxSteps,
  "instruction-overflow control did not reach its step bound"
);
assert(
  instructionOverflowRun.record.reason === STOP_REASONS.traceOverflow,
  "instruction record overflow was not an explicit stop"
);
assert(instructionOverflowRun.record.steps === TRACE_CAPACITY, "instruction overflow changed the completed step count");
assert(instructionOverflowRun.trace.count === TRACE_CAPACITY, "instruction overflow changed the committed trace count");
assert(instructionOverflowRun.trace.overflow, "instruction overflow did not preserve the overflow flag");
assert(
  instructionOverflowRun.record.pc === instructionBoundaryRun.record.pc &&
    instructionOverflowRun.record.stackPointer === instructionBoundaryRun.record.stackPointer &&
    JSON.stringify(instructionOverflowRun.record.registers) === JSON.stringify(instructionBoundaryRun.record.registers),
  "instruction overflow changed architectural state beyond the last committed instruction"
);

const mmioFixture: RunnerFixture = {
  symbol: "unmapped_mmio_read",
  pc: 0x420d7000,
  bytes: Uint8Array.from([
    0x36, 0x41, 0x00,
    0xa2, 0xa3, 0xff,
    0xc0, 0xaa, 0x01,
    0x0c, 0x49,
    0x00, 0x99, 0x11,
    0x90, 0xaa, 0x20,
    0x98, 0x0a,
    0x1d, 0xf0
  ])
};
const mmioRun = await runFresh(moduleBytes, mmioFixture, { data: Uint8Array.of(0, 0), maxSteps: 32 });
assert(mmioRun.record.reason === STOP_REASONS.unmappedAccess, "unmapped MMIO read reached the slow path");
assert(mmioRun.record.steps === 6, `unmapped MMIO fixture committed ${mmioRun.record.steps} instructions`);
assert(mmioRun.record.pc === mmioFixture.pc + 17, "unmapped MMIO fixture stopped at the wrong boundary");
assert(mmioRun.record.registers[10] === 0x3ff40000, "unmapped MMIO fixture built the wrong address");
assert(mmioRun.record.registers[9] === 0x00040000, "refused MMIO read changed its destination register");
assert(mmioRun.dataOutput.every((byte) => byte === 0), "refused MMIO read invoked the slow-path callback");
assert(!mmioRun.trace.overflow, "unmapped MMIO refusal was misclassified as trace overflow");
assert(mmioRun.trace.count === 6, "unmapped MMIO refusal retained a partial instruction");

const objdumpVersion = run([DEFAULT_ESP32S3_OBJDUMP, "--version"]);
requireSuccess(objdumpVersion);
const patchPaths = {
  runner: join(import.meta.dir, "patches/0001-add-wasi-probe.patch"),
  freestanding: join(import.meta.dir, "patches/0002-add-freestanding-shim.patch"),
  esp32s3: join(import.meta.dir, "patches/0003-add-esp32s3-lx7-subset.patch")
};
const baseline = JSON.parse(readFileSync(join(import.meta.dir, "esp32s3-dynamic-baseline.json"), "utf8"));
const actualBaseline = {
  inputs: {
    flexeCommit: FLEXE_COMMIT,
    runnerPatchSha256: sha256(patchPaths.runner),
    freestandingPatchSha256: sha256(patchPaths.freestanding),
    esp32s3PatchSha256: sha256(patchPaths.esp32s3),
    moduleBytes: statSync(modulePath).size,
    moduleSha256,
    objdumpSha256: sha256(DEFAULT_ESP32S3_OBJDUMP),
    scalarElfSha256: scalar.elfSha256,
    pieElfSha256: pie.elfSha256,
    stagingElfSha256: staging.elfSha256
  },
  scalar: {
    symbol: scalar.symbol,
    pc: `0x${scalar.pc.toString(16)}`,
    codeSha256: scalar.codeSha256,
    mnemonics: scalar.instructions.map((row) => row.rawMnemonic),
    reason: scalarRun.record.reasonName,
    steps: scalarRun.record.steps,
    returnRegister: "a10",
    returnValue: scalarRun.record.registers[10],
    boundedReason: boundedRun.record.reasonName,
    boundedSteps: boundedRun.record.steps,
    boundedPc: `0x${boundedRun.record.pc.toString(16)}`
  },
  scalarIsa: {
    codeSha256: scalarIsaFixture.codeSha256,
    outputHex: Buffer.from(scalarIsaRun.dataOutput).toString("hex"),
    reason: scalarIsaRun.record.reasonName,
    steps: scalarIsaRun.record.steps,
    sourceAfter: `0x${scalarIsaRun.record.registers[10].toString(16)}`,
    destinationAfter: `0x${scalarIsaRun.record.registers[11].toString(16)}`
  },
  qrIsa: {
    codeSha256: qrIsaFixture.codeSha256,
    outputHex: Buffer.from(qrIsaRun.dataOutput).toString("hex"),
    reason: qrIsaRun.record.reasonName,
    steps: qrIsaRun.record.steps
  },
  qrXpIsa: {
    codeSha256: qrXpFixture.codeSha256,
    outputHex: Buffer.from(qrXpRun.dataOutput).toString("hex"),
    reason: qrXpRun.record.reasonName,
    steps: qrXpRun.record.steps,
    sourceAfter: `0x${qrXpRun.record.registers[10].toString(16)}`,
    incrementValue: qrXpRun.record.registers[12]
  },
  halfQrIsa: {
    codeSha256: halfQrFixture.codeSha256,
    outputHex: Buffer.from(halfQrRun.dataOutput).toString("hex"),
    reason: halfQrRun.record.reasonName,
    steps: halfQrRun.record.steps,
    sourceAfter: `0x${halfQrRun.record.registers[10].toString(16)}`,
    destinationAfter: `0x${halfQrRun.record.registers[11].toString(16)}`,
    unsupportedCodeSha256: unsupportedXpFixture.codeSha256,
    unsupportedReason: unsupportedXpRun.record.reasonName,
    unsupportedEncoding: `0x${unsupportedXpRun.record.unsupportedEncoding.toString(16)}`
  },
  float64XpIsa: {
    codeSha256: float64XpFixture.codeSha256,
    outputHex: Buffer.from(float64XpRun.dataOutput).toString("hex"),
    reason: float64XpRun.record.reasonName,
    steps: float64XpRun.record.steps,
    sourceAfter: `0x${float64XpRun.record.registers[10].toString(16)}`,
    destinationAfter: `0x${float64XpRun.record.registers[11].toString(16)}`,
    unsupportedCodeSha256: unsupportedFloat128Fixture.codeSha256,
    unsupportedReason: unsupportedFloat128Run.record.reasonName,
    unsupportedEncoding: `0x${unsupportedFloat128Run.record.unsupportedEncoding.toString(16)}`
  },
  threadptrIsa: {
    codeSha256: threadptrFixture.codeSha256,
    literalPageSha256: threadptrLiterals.sha256,
    reason: threadptrRun.record.reasonName,
    steps: threadptrRun.record.steps,
    returnRegister: "a10",
    returnValue: `0x${threadptrRun.record.registers[10].toString(16)}`,
    unknownCodeSha256: unknownUserRegisterFixture.codeSha256,
    unknownReason: unknownUserRegisterRun.record.reasonName,
    unknownSteps: unknownUserRegisterRun.record.steps,
    unknownPc: `0x${unknownUserRegisterRun.record.pc.toString(16)}`
  },
  accxIsa: {
    codeSha256: accxFixture.codeSha256,
    reason: accxRun.record.reasonName,
    steps: accxRun.record.steps,
    lowValue: `0x${accxRun.record.registers[12].toString(16)}`,
    highValue: `0x${accxRun.record.registers[13].toString(16)}`
  },
  qaccIsa: {
    codeSha256: qaccFixture.codeSha256,
    reason: qaccRun.record.reasonName,
    steps: qaccRun.record.steps,
    highValue: `0x${qaccRun.record.registers[2].toString(16)}`,
    lowValue: `0x${qaccRun.record.registers[7].toString(16)}`
  },
  sarFftIsa: {
    codeSha256: sarFftFixture.codeSha256,
    reason: sarFftRun.record.reasonName,
    steps: sarFftRun.record.steps,
    sarByte: sarFftRun.record.registers[12],
    fftBitWidth: sarFftRun.record.registers[13]
  },
  uaStateIsa: {
    codeSha256: uaStateFixture.codeSha256,
    reason: uaStateRun.record.reasonName,
    steps: uaStateRun.record.steps,
    values: uaStateRun.record.registers.slice(2, 6)
  },
  entry: {
    symbol: entry.symbol,
    pc: `0x${entry.pc.toString(16)}`,
    codeSha256: entry.codeSha256,
    literalPageSha256: entryAuxiliary.sha256,
    reason: entryRun.record.reasonName,
    steps: entryRun.record.steps,
    stopPc: `0x${entryRun.record.pc.toString(16)}`,
    nextRomTarget: `0x${entryRun.record.registers[8].toString(16)}`
  },
  pie: {
    symbol: pie.symbol,
    pc: `0x${pie.pc.toString(16)}`,
    codeSha256: pie.codeSha256,
    reason: pieRun.record.reasonName,
    supportedSteps: pieRun.record.steps,
    outputHex: Buffer.from(pieRun.dataOutput).toString("hex"),
    firstUnsupported: null
  },
  staging: {
    symbol: staging.symbol,
    pc: `0x${staging.pc.toString(16)}`,
    codeSha256: staging.codeSha256,
    outputSha256: stagingOutputSha256,
    mnemonics: stagingMnemonics,
    inputHex: Buffer.from(stagingInput).toString("hex"),
    outputHex: Buffer.from(stagingRun.dataOutput).toString("hex"),
    reason: stagingRun.record.reasonName,
    steps: stagingRun.record.steps,
    firstUnsupported: null,
    trace: {
      abiVersion: stagingRun.trace.abiVersion,
      recordBytes: stagingRun.trace.recordBytes,
      records: stagingRun.trace.count,
      instructionRecords: stagingRun.trace.records.filter((record) => record.kind === TRACE_KINDS.instruction).length,
      readRecords: stagingRun.trace.records.filter((record) => record.kind === TRACE_KINDS.read).length,
      writeRecords: stagingRun.trace.records.filter((record) => record.kind === TRACE_KINDS.write).length,
      overflow: stagingRun.trace.overflow,
      sha256: stagingRun.trace.sha256
    },
    overflowTest: {
      prefixInstructions: 3,
      inputBytes: overflowInput.length,
      overflowKind: "read",
      reason: overflowRun.record.reasonName,
      steps: overflowRun.record.steps,
      pc: `0x${overflowRun.record.pc.toString(16)}`,
      records: overflowRun.trace.count,
      instructionRecords: overflowRun.trace.records.filter((record) => record.kind === TRACE_KINDS.instruction).length,
      readRecords: overflowRun.trace.records.filter((record) => record.kind === TRACE_KINDS.read).length,
      writeRecords: overflowRun.trace.records.filter((record) => record.kind === TRACE_KINDS.write).length,
      capacity: overflowRun.trace.capacity,
      overflow: overflowRun.trace.overflow,
      registerA9: `0x${overflowRun.record.registers[9]!.toString(16)}`,
      outputSha256: createHash("sha256").update(overflowRun.dataOutput).digest("hex"),
      traceSha256: overflowRun.trace.sha256
    }
  },
  boundaries: {
    unsupported: {
      reason: pieRefusalRun.record.reasonName,
      steps: pieRefusalRun.record.steps,
      pc: `0x${pieRefusalRun.record.pc.toString(16)}`,
      matchesStepBoundState: true
    },
    instructionOverflow: {
      reason: instructionOverflowRun.record.reasonName,
      steps: instructionOverflowRun.record.steps,
      pc: `0x${instructionOverflowRun.record.pc.toString(16)}`,
      records: instructionOverflowRun.trace.count,
      overflow: instructionOverflowRun.trace.overflow,
      matchesStepBoundState: true
    },
    unmappedMmio: {
      reason: mmioRun.record.reasonName,
      steps: mmioRun.record.steps,
      pc: `0x${mmioRun.record.pc.toString(16)}`,
      traceRecords: mmioRun.trace.count,
      slowCallbackInvocations: mmioRun.dataOutput[0]
    }
  }
};
assert(
  JSON.stringify(actualBaseline) === JSON.stringify({
    inputs: baseline.inputs,
    scalar: baseline.scalar,
    scalarIsa: baseline.scalarIsa,
    qrIsa: baseline.qrIsa,
    qrXpIsa: baseline.qrXpIsa,
    halfQrIsa: baseline.halfQrIsa,
    float64XpIsa: baseline.float64XpIsa,
    threadptrIsa: baseline.threadptrIsa,
    accxIsa: baseline.accxIsa,
    qaccIsa: baseline.qaccIsa,
    sarFftIsa: baseline.sarFftIsa,
    uaStateIsa: baseline.uaStateIsa,
    entry: baseline.entry,
    pie: baseline.pie,
    staging: baseline.staging,
    boundaries: baseline.boundaries
  }),
  "tracked dynamic execution baseline changed"
);

const report = {
  schemaVersion: 1,
  provenance: {
    flexeCommit: FLEXE_COMMIT,
    flexeSourceHashes: SOURCE_HASHES,
    patches: {
      runner: { path: patchPaths.runner, sha256: actualBaseline.inputs.runnerPatchSha256 },
      freestanding: {
        path: patchPaths.freestanding,
        sha256: actualBaseline.inputs.freestandingPatchSha256
      },
      esp32s3: {
        path: patchPaths.esp32s3,
        sha256: actualBaseline.inputs.esp32s3PatchSha256
      }
    },
    zig: { executable: process.env.ZIG_EXE ?? "zig", version: commandVersion(process.env.ZIG_EXE ?? "zig") },
    module: {
      path: modulePath,
      bytes: statSync(modulePath).size,
      sha256: moduleSha256,
      imports,
      exports
    },
    objdump: {
      path: DEFAULT_ESP32S3_OBJDUMP,
      version: objdumpVersion.stdout.trim().split("\n")[0],
      sha256: sha256(DEFAULT_ESP32S3_OBJDUMP)
    }
  },
  scalar: {
    elf: DEFAULT_TINYDRAW_ESP32S3_ELF,
    elfSha256: scalar.elfSha256,
    symbol: scalar.symbol,
    pc: `0x${scalar.pc.toString(16)}`,
    codeSha256: scalar.codeSha256,
    objdumpEncodings: scalar.instructions.map((row) => row.objdumpEncoding),
    mnemonics: scalar.instructions.map((row) => row.rawMnemonic),
    stop: scalarRun.record,
    boundedStop: boundedRun.record
  },
  pie: {
    elf: DEFAULT_TINYDRAW_ESP32S3_FIXTURE_ELF,
    elfSha256: pie.elfSha256,
    symbol: pie.symbol,
    pc: `0x${pie.pc.toString(16)}`,
    codeSha256: pie.codeSha256,
    firstUnsupported: null,
    exercisedS3Instruction: {
      address: pieGap.address,
      objdumpEncoding: pieGap.objdumpEncoding,
      mnemonic: pieGap.rawMnemonic
    },
    stop: pieRun.record
  },
  staging: {
    elf: DEFAULT_TINYDRAW_ESP32S3_STAGING_ELF,
    elfSha256: staging.elfSha256,
    symbol: staging.symbol,
    pc: `0x${staging.pc.toString(16)}`,
    codeSha256: staging.codeSha256,
    objdumpEncodings: staging.instructions.map((row) => row.objdumpEncoding),
    mnemonics: stagingMnemonics,
    inputHex: Buffer.from(stagingInput).toString("hex"),
    outputHex: Buffer.from(stagingRun.dataOutput).toString("hex"),
    outputSha256: stagingOutputSha256,
    firstUnsupported: null,
    stop: stagingRun.record,
    trace: {
      abiVersion: stagingRun.trace.abiVersion,
      headerBytes: stagingRun.trace.headerBytes,
      recordBytes: stagingRun.trace.recordBytes,
      count: stagingRun.trace.count,
      capacity: stagingRun.trace.capacity,
      overflow: stagingRun.trace.overflow,
      sha256: stagingRun.trace.sha256,
      records: stagingRun.trace.records
    },
    overflowTest: {
      inputBytes: overflowInput.length,
      stop: overflowRun.record,
      trace: {
        count: overflowRun.trace.count,
        capacity: overflowRun.trace.capacity,
        overflow: overflowRun.trace.overflow,
        sha256: overflowRun.trace.sha256
      }
    }
  },
  boundaries: {
    unsupported: {
      stop: pieRefusalRun.record,
      stepBoundControl: pieBoundaryRun.record
    },
    instructionOverflow: {
      stop: instructionOverflowRun.record,
      stepBoundControl: instructionBoundaryRun.record,
      trace: {
        count: instructionOverflowRun.trace.count,
        capacity: instructionOverflowRun.trace.capacity,
        overflow: instructionOverflowRun.trace.overflow,
        sha256: instructionOverflowRun.trace.sha256
      }
    },
    unmappedMmio: {
      stop: mmioRun.record,
      trace: {
        count: mmioRun.trace.count,
        overflow: mmioRun.trace.overflow,
        sha256: mmioRun.trace.sha256
      },
      slowCallbackInvocations: mmioRun.dataOutput[0]
    }
  }
};
mkdirSync(dist, { recursive: true });
writeFileSync(join(dist, "rgb565-execution-trace.bin"), stagingRun.trace.rawBytes);
writeFileSync(join(dist, "dynamic-execution.json"), `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify({
  scalar: { reason: scalarRun.record.reasonName, steps: scalarRun.record.steps, returnValue: 4 },
  pie: {
    reason: pieRun.record.reasonName,
    steps: pieRun.record.steps,
    pc: `0x${pieRun.record.pc.toString(16)}`,
    objdumpEncoding: pieGap.objdumpEncoding
  },
  staging: {
    reason: stagingRun.record.reasonName,
    steps: stagingRun.record.steps,
    outputHex: Buffer.from(stagingRun.dataOutput).toString("hex"),
    firstUnsupported: null,
    traceRecords: stagingRun.trace.count,
    traceSha256: stagingRun.trace.sha256
  },
  moduleBytes: report.provenance.module.bytes,
  moduleSha256: report.provenance.module.sha256
}, null, 2));
