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

function initialRegisters(returnPc: number): number[] {
  const registers = Array<number>(16).fill(0);
  registers[1] = INITIAL_STACK;
  registers[8] = ((2 << 30) | (returnPc & 0x3fff_ffff)) >>> 0;
  registers[10] = INITIAL_SOURCE;
  registers[11] = INITIAL_DESTINATION;
  registers[12] = 1;
  return registers;
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
      assert(width === 2 || width === 3 || width === 4, `trace instruction record ${index} has unsupported width ${width}`);
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
assert(scalar.elfSha256 === "e9681a8015728b95a9e948a56a0cbe4245b1abff812fa0b70b93c4ca1a29f044", "scalar ELF changed");
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

const qrScalarFixture = conformanceFixture("esp32s3_qr_scalar_lane_writes", [
  0x28, 0x0a,
  0x38, 0x1a,
  0x48, 0x2a,
  0x58, 0x3a,
  0xa4, 0x7f, 0xfd,
  0x54, 0x3e, 0xfd,
  0x24, 0x32, 0xfd,
  0x44, 0x3a, 0xfd,
  0x34, 0x36, 0xfd,
  0xb4, 0x00, 0xba
]);
const qrScalarInput = Uint8Array.from({ length: 16 }, (_, index) => (index * 17 + 1) & 0xff);
const qrScalarRun = await runFresh(moduleBytes, qrScalarFixture, { data: qrScalarInput, maxSteps: 10 });
assert(qrScalarRun.record.reason === STOP_REASONS.maxSteps, `QR scalar fixture stopped with ${qrScalarRun.record.reasonName}`);
assert(qrScalarRun.record.steps === 10, `QR scalar fixture executed ${qrScalarRun.record.steps} instructions`);
assert(
  qrScalarRun.dataOutput.every((byte, index) => byte === qrScalarInput[index]),
  `QR scalar fixture output changed: ${Buffer.from(qrScalarRun.dataOutput).toString("hex")}`
);

const qrBitwiseFixture = conformanceFixture("esp32s3_qr_bitwise_logic", [
  0xa4, 0x01, 0x93,
  0xa4, 0x81, 0x93,
  0x64, 0x34, 0xed,
  0xa4, 0xf4, 0xed,
  0x94, 0x35, 0xfd,
  0xc4, 0xff, 0xfd,
  0xb4, 0x01, 0xaa,
  0xb4, 0x81, 0xaa,
  0xb4, 0x01, 0xba,
  0xb4, 0x81, 0xba
]);
const qrBitwiseInput = Uint8Array.from({ length: 64 }, (_, index) => (index * 29 + 7) & 0xff);
const qrBitwiseExpected = new Uint8Array(64);
for (let index = 0; index < 16; index++) {
  const x = qrBitwiseInput[index]!;
  const y = qrBitwiseInput[index + 16]!;
  qrBitwiseExpected[index] = x & y;
  qrBitwiseExpected[index + 16] = y;
  qrBitwiseExpected[index + 32] = x ^ y;
  qrBitwiseExpected[index + 48] = (~(x ^ y)) & 0xff;
}
const qrBitwiseRun = await runFresh(moduleBytes, qrBitwiseFixture, { data: qrBitwiseInput, maxSteps: 10 });
assert(qrBitwiseRun.record.reason === STOP_REASONS.maxSteps, "QR bitwise fixture did not finish");
assert(qrBitwiseRun.record.steps === 10, "QR bitwise fixture executed the wrong instruction count");
assert(
  qrBitwiseRun.dataOutput.every((byte, index) => byte === qrBitwiseExpected[index]),
  `QR bitwise fixture output changed: ${Buffer.from(qrBitwiseRun.dataOutput).toString("hex")}`
);
assert(qrBitwiseRun.record.registers[10] === INITIAL_SOURCE + 32, "QR bitwise loads applied the wrong postincrements");
assert(qrBitwiseRun.record.registers[11] === INITIAL_DESTINATION + 64, "QR bitwise stores applied the wrong postincrements");

const qrCompareInput = Uint8Array.from([
  0x00, 0x00, 0x01, 0x00, 0xff, 0xff, 0x00, 0x80,
  0x34, 0x12, 0xcd, 0xab, 0x55, 0x55, 0xaa, 0xaa,
  0x00, 0x00, 0x02, 0x00, 0xff, 0xff, 0xff, 0x7f,
  0x34, 0x12, 0xba, 0xdc, 0x55, 0x55, 0x11, 0x11
]);
const qrCompareFixture = conformanceFixture("esp32s3_qr_compare_eq_s16", [
  0xa4, 0x01, 0x93,
  0xa4, 0x81, 0x93,
  0x94, 0x1a, 0xae,
  0xb4, 0x01, 0xaa
]);
const qrCompareExpected = Uint8Array.from([
  0xff, 0xff, 0x00, 0x00, 0xff, 0xff, 0x00, 0x00,
  0xff, 0xff, 0x00, 0x00, 0xff, 0xff, 0x00, 0x00,
  0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
  0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00
]);
const qrCompareRun = await runFresh(moduleBytes, qrCompareFixture, { data: qrCompareInput, maxSteps: 4 });
assert(qrCompareRun.record.reason === STOP_REASONS.maxSteps, "QR comparison fixture did not finish");
assert(qrCompareRun.record.steps === 4, "QR comparison fixture executed the wrong instruction count");
assert(
  qrCompareRun.dataOutput.every((byte, index) => byte === qrCompareExpected[index]),
  `QR comparison fixture output changed: ${Buffer.from(qrCompareRun.dataOutput).toString("hex")}`
);

const unsupportedQrCompareFixture = conformanceFixture("esp32s3_unsupported_vcmp_lt_s16", [0xf4, 0x1a, 0xae]);
const unsupportedQrCompareRun = await runFresh(moduleBytes, unsupportedQrCompareFixture, {
  maxSteps: 1,
  unsupported: { offset: 0, encoding: 0xae1af4 }
});
assert(unsupportedQrCompareRun.record.reason === STOP_REASONS.unsupported, "adjacent QR comparison did not fail closed");
assert(unsupportedQrCompareRun.record.steps === 0, "adjacent QR comparison was counted as executed");
assert(unsupportedQrCompareRun.trace.count === 0, "adjacent QR comparison leaked a trace record");
assert(
  unsupportedQrCompareRun.record.registers.every(
    (value, index) => value === initialRegisters(unsupportedQrCompareRun.record.returnPc)[index]
  ),
  "adjacent QR comparison changed registers"
);

const qrPreluInput = Uint8Array.from([
  0x01, 0x00, 0xff, 0xff, 0x00, 0x80, 0x00, 0x00,
  0x34, 0x12, 0xfe, 0xff, 0xd4, 0xfe, 0xff, 0x7f,
  0x02, 0x00, 0x02, 0x00, 0xff, 0xff, 0x05, 0x00,
  0x10, 0x00, 0xff, 0x7f, 0xd4, 0xfe, 0x03, 0x00,
  0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
  0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
  0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
  0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00
]);
const qrPreluFixture = conformanceFixture("esp32s3_qr_parametric_relu", [
  0xa4, 0x01, 0x93,
  0xa4, 0x81, 0x93,
  0xc4, 0x1a, 0xac,
  0xd4, 0xba, 0xac,
  0xb4, 0x01, 0xaa,
  0xb4, 0x81, 0xaa
]);
const qrPreluExpected = Uint8Array.from([
  0x01, 0x00, 0xff, 0xff, 0x00, 0x00, 0x00, 0x00,
  0x34, 0x12, 0xff, 0xff, 0x00, 0x00, 0xff, 0x7f,
  0x01, 0x00, 0xfe, 0x00, 0x00, 0x80, 0x00, 0x00,
  0x34, 0x12, 0x02, 0x81, 0x90, 0x04, 0xfd, 0x7f,
  0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
  0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
  0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
  0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00
]);
const qrPreluRun = await runFresh(moduleBytes, qrPreluFixture, { data: qrPreluInput, maxSteps: 6 });
assert(qrPreluRun.record.reason === STOP_REASONS.maxSteps, "QR PRELU fixture did not finish");
assert(qrPreluRun.record.steps === 6, "QR PRELU fixture executed the wrong instruction count");
assert(
  qrPreluRun.dataOutput.every((byte, index) => byte === qrPreluExpected[index]),
  `QR PRELU fixture output changed: ${Buffer.from(qrPreluRun.dataOutput).toString("hex")}`
);

const unsupportedQrReluFixture = conformanceFixture("esp32s3_unsupported_vrelu_s16", [0xd4, 0x1c, 0xdd]);
const unsupportedQrReluRun = await runFresh(moduleBytes, unsupportedQrReluFixture, {
  maxSteps: 1,
  unsupported: { offset: 0, encoding: 0xdd1cd4 }
});
assert(unsupportedQrReluRun.record.reason === STOP_REASONS.unsupported, "adjacent QR ReLU did not fail closed");
assert(unsupportedQrReluRun.record.steps === 0, "adjacent QR ReLU was counted as executed");
assert(unsupportedQrReluRun.trace.count === 0, "adjacent QR ReLU leaked a trace record");

const unsupportedQrNeighborFixture = conformanceFixture("esp32s3_unsupported_zero_qacc", [0x44, 0x08, 0x25]);
const unsupportedQrNeighborRun = await runFresh(moduleBytes, unsupportedQrNeighborFixture, {
  maxSteps: 1,
  unsupported: { offset: 0, encoding: 0x250844 }
});
assert(unsupportedQrNeighborRun.record.reason === STOP_REASONS.unsupported, "adjacent QACC zero did not fail closed");
assert(unsupportedQrNeighborRun.record.steps === 0, "adjacent QACC zero was counted as executed");
assert(unsupportedQrNeighborRun.trace.count === 0, "adjacent QACC zero leaked a trace record");
assert(unsupportedQrNeighborRun.dataOutput.length === 0, "adjacent QACC zero exposed data output");

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

const srcInput = Uint8Array.from({ length: 64 }, (_, index) => (index * 11 + 3) & 0xff);
const srcShifted = Uint8Array.from([...srcInput.slice(5, 16), ...srcInput.slice(16, 21)]);
const srcQueueShifted = Uint8Array.from([...srcInput.slice(5, 16), ...srcShifted.slice(0, 5)]);
const srcExpected = new Uint8Array(64);
srcExpected.set(srcShifted, 0);
srcExpected.set(srcShifted, 16);
srcExpected.set(srcQueueShifted, 32);
srcExpected.set(srcShifted, 48);
const srcFixture = conformanceFixture("esp32s3_qr_concatenate_shift", [
  0xa4, 0x81, 0x83,
  0xa4, 0x01, 0x93,
  0x0c, 0x59,
  0x90, 0x0d, 0xf3,
  0x04, 0x13, 0xdc,
  0xb4, 0x01, 0x8a,
  0x24, 0x13, 0xdc,
  0xb4, 0x01, 0x9a,
  0x04, 0x17, 0xdc,
  0xb4, 0x01, 0x8a,
  0xb4, 0x81, 0x8a
]);
const srcRun = await runFresh(moduleBytes, srcFixture, { data: srcInput, maxSteps: 11 });
assert(srcRun.record.reason === STOP_REASONS.maxSteps, `QR SRC fixture stopped with ${srcRun.record.reasonName}`);
assert(srcRun.record.steps === 11, `QR SRC fixture executed ${srcRun.record.steps} instructions`);
assert(
  srcRun.dataOutput.every((byte, index) => byte === srcExpected[index]),
  `QR SRC fixture output changed: ${Buffer.from(srcRun.dataOutput).toString("hex")}`
);
assert(srcRun.record.registers[10] === INITIAL_SOURCE + 32, "QR SRC fixture changed its load pointer");
assert(srcRun.record.registers[11] === INITIAL_DESTINATION + 64, "QR SRC fixture changed its store pointer");

const srcAliasFixture = conformanceFixture("esp32s3_qr_concatenate_shift_aliased_update", [
  0xa4, 0x81, 0x83,
  0xa4, 0x01, 0x93,
  0x14, 0x17, 0xdc,
  0xb4, 0x81, 0x8a
]);
const srcAliasExpected = new Uint8Array(srcInput.length);
srcAliasExpected.set(srcInput.slice(16, 32));
const srcAliasRun = await runFresh(moduleBytes, srcAliasFixture, { data: srcInput, maxSteps: 4 });
assert(srcAliasRun.record.reason === STOP_REASONS.maxSteps, "aliased QR SRC QUP fixture did not finish");
assert(srcAliasRun.record.steps === 4, "aliased QR SRC QUP fixture executed the wrong instruction count");
assert(
  srcAliasRun.dataOutput.every((byte, index) => byte === srcAliasExpected[index]),
  `aliased QR SRC QUP output changed: ${Buffer.from(srcAliasRun.dataOutput).toString("hex")}`
);

const srcIpFixture = conformanceFixture("esp32s3_qr_concatenate_shift_immediate_load", [
  0xa4, 0x81, 0x83,
  0xa4, 0x7f, 0xd3,
  0x0c, 0x99,
  0x90, 0x0d, 0xf3,
  0x3b, 0xaa,
  0xae, 0x72, 0xab, 0xe3,
  0xb4, 0x81, 0x8a,
  0xb4, 0x81, 0x9a
]);
const srcIpInput = srcInput.slice(0, 32);
const srcIpExpected = Uint8Array.from([...srcIpInput.slice(9, 25), ...srcIpInput.slice(0, 16)]);
const srcIpRun = await runFresh(moduleBytes, srcIpFixture, { data: srcIpInput, maxSteps: 8 });
assert(srcIpRun.record.reason === STOP_REASONS.maxSteps, `QR SRC IP fixture stopped with ${srcIpRun.record.reasonName}`);
assert(srcIpRun.record.steps === 8, `QR SRC IP fixture executed ${srcIpRun.record.steps} instructions`);
assert(
  srcIpRun.dataOutput.every((byte, index) => byte === srcIpExpected[index]),
  `QR SRC IP output changed: ${Buffer.from(srcIpRun.dataOutput).toString("hex")}`
);
assert(srcIpRun.record.registers[10] === INITIAL_SOURCE - 29, "QR SRC IP did not sign-extend the unaligned base postincrement");
assert(srcIpRun.record.registers[11] === INITIAL_DESTINATION + 32, "QR SRC IP changed its store pointer");

const srcXpFixture = conformanceFixture("esp32s3_qr_concatenate_shift_register_load", [
  0xa4, 0x81, 0x83,
  0xa4, 0x7f, 0xd3,
  0x0c, 0xf9,
  0x90, 0x0d, 0xf3,
  0x0c, 0x7c,
  0x3b, 0xaa,
  0xae, 0x4c, 0x23, 0xe8,
  0xb4, 0x81, 0x8a,
  0xb4, 0x81, 0x9a
]);
const srcXpExpected = Uint8Array.from([...srcIpInput.slice(15, 31), ...srcIpInput.slice(0, 16)]);
const srcXpRun = await runFresh(moduleBytes, srcXpFixture, { data: srcIpInput, maxSteps: 9 });
assert(srcXpRun.record.reason === STOP_REASONS.maxSteps, `QR SRC XP fixture stopped with ${srcXpRun.record.reasonName}`);
assert(srcXpRun.record.steps === 9, `QR SRC XP fixture executed ${srcXpRun.record.steps} instructions`);
assert(
  srcXpRun.dataOutput.every((byte, index) => byte === srcXpExpected[index]),
  `QR SRC XP output changed: ${Buffer.from(srcXpRun.dataOutput).toString("hex")}`
);
assert(srcXpRun.record.registers[10] === INITIAL_SOURCE + 10, "QR SRC XP did not increment the original unaligned base");
assert(srcXpRun.record.registers[11] === INITIAL_DESTINATION + 32, "QR SRC XP changed its store pointer");
assert(srcXpRun.record.registers[12] === 7, "QR SRC XP changed its increment register");

const unsupportedSrcIpNeighborFixture = conformanceFixture("esp32s3_unsupported_src_q_ld_ip_neighbor", [
  0x2e, 0x49, 0x20, 0xe0
]);
const unsupportedSrcIpNeighborRun = await runFresh(moduleBytes, unsupportedSrcIpNeighborFixture, {
  maxSteps: 1,
  unsupported: { offset: 0, encoding: 0x492e }
});
assert(unsupportedSrcIpNeighborRun.record.reason === STOP_REASONS.unsupported, `adjacent QR SRC IP form stopped with ${unsupportedSrcIpNeighborRun.record.reasonName}`);
assert(unsupportedSrcIpNeighborRun.record.steps === 0, "adjacent QR SRC IP form was counted as executed");
assert(unsupportedSrcIpNeighborRun.record.unsupportedLength === 2, "adjacent QR SRC IP form changed decoder width");
assert(unsupportedSrcIpNeighborRun.trace.count === 0, "adjacent QR SRC IP form leaked a trace record");
assert(unsupportedSrcIpNeighborRun.dataOutput.length === 0, "adjacent QR SRC IP form exposed data output");

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

const halfQrXpFixture = conformanceFixture("esp32s3_qr_half_register_postincrement", [
  0xa4, 0xbc, 0x9d,
  0xa4, 0x6c, 0xad,
  0xb4, 0xcc, 0xdd,
  0xb4, 0x0c, 0xed
]);
const halfQrXpExpected = new Uint8Array(32);
halfQrXpExpected.set(halfQrInput.slice(0, 8), 0);
halfQrXpExpected.set(halfQrInput.slice(16, 24), 16);
const halfQrXpRun = await runFresh(moduleBytes, halfQrXpFixture, { data: halfQrInput, maxSteps: 4 });
assert(halfQrXpRun.record.reason === STOP_REASONS.maxSteps, "QR half XP fixture did not finish");
assert(halfQrXpRun.record.steps === 4, "QR half XP fixture executed the wrong instruction count");
assert(
  halfQrXpRun.dataOutput.every((byte, index) => byte === halfQrXpExpected[index]),
  `QR half XP fixture output changed: ${Buffer.from(halfQrXpRun.dataOutput).toString("hex")}`
);
assert(halfQrXpRun.record.registers[10] === INITIAL_SOURCE + 32, "QR half XP loads applied the wrong register increments");
assert(halfQrXpRun.record.registers[11] === INITIAL_DESTINATION + 32, "QR half XP stores applied the wrong register increments");

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

const float64IpFixture = conformanceFixture("esp32s3_float_pair_immediate_postincrement", [
  0xae, 0x05, 0x10, 0xe0,
  0xbf, 0x07, 0x1f, 0xe3
]);
const float64IpInput = Uint8Array.from([0x01, 0x00, 0xc0, 0x7f, 0xef, 0xbe, 0xad, 0xde]);
const float64IpRun = await runFresh(moduleBytes, float64IpFixture, { data: float64IpInput, maxSteps: 2 });
assert(float64IpRun.record.reason === STOP_REASONS.maxSteps, `float-pair IP fixture stopped with ${float64IpRun.record.reasonName}`);
assert(float64IpRun.record.steps === 2, `float-pair IP fixture executed ${float64IpRun.record.steps} instructions`);
assert(
  float64IpRun.dataOutput.every((byte, index) => byte === float64IpInput[index]),
  `float-pair IP fixture changed payload bits: ${Buffer.from(float64IpRun.dataOutput).toString("hex")}`
);
assert(float64IpRun.record.registers[10] === INITIAL_SOURCE + 8, "float-pair load did not apply its immediate postincrement");
assert(float64IpRun.record.registers[11] === INITIAL_DESTINATION - 8, "float-pair store did not sign-extend its immediate postincrement");

const unsupportedFloat64IpFixture = conformanceFixture("esp32s3_unsupported_float_pair_ip_neighbor", [
  0x2e, 0x00, 0x10, 0xe4
]);
const unsupportedFloat64IpRun = await runFresh(moduleBytes, unsupportedFloat64IpFixture, {
  maxSteps: 1,
  unsupported: { offset: 0, encoding: 0x002e }
});
assert(unsupportedFloat64IpRun.record.reason === STOP_REASONS.unsupported, "adjacent float-pair IP form did not fail closed");
assert(unsupportedFloat64IpRun.record.steps === 0, "adjacent float-pair IP form was counted as executed");
assert(unsupportedFloat64IpRun.trace.count === 0, "adjacent float-pair IP refusal leaked a trace record");
assert(unsupportedFloat64IpRun.dataOutput.length === 0, "adjacent float-pair IP refusal exposed data output");
assert(
  unsupportedFloat64IpRun.record.registers.every(
    (value, index) => value === initialRegisters(unsupportedFloat64IpRun.record.returnPc)[index]
  ),
  "adjacent float-pair IP refusal changed registers"
);

const float128Fixture = conformanceFixture("esp32s3_float_quad_immediate_and_register_postincrement", [
  0x3b, 0xaa,
  0x3b, 0xbb,
  0xaf, 0x21, 0x30, 0x80,
  0xbf, 0x21, 0x30, 0x90,
  0xaf, 0x6c, 0x72, 0x8a,
  0xbf, 0x6c, 0x72, 0x9a
]);
const float128Input = Uint8Array.from({ length: 32 }, (_, index) => (index * 17 + 1) & 0xff);
const float128Run = await runFresh(moduleBytes, float128Fixture, { data: float128Input, maxSteps: 6 });
assert(float128Run.record.reason === STOP_REASONS.maxSteps, `float-quad fixture stopped with ${float128Run.record.reasonName}`);
assert(float128Run.record.steps === 6, `float-quad fixture executed ${float128Run.record.steps} instructions`);
assert(
  float128Run.dataOutput.every((byte, index) => byte === float128Input[index]),
  `float-quad fixture changed payload bits: ${Buffer.from(float128Run.dataOutput).toString("hex")}`
);
assert(float128Run.record.registers[10] === INITIAL_SOURCE + 35, "float-quad loads applied the wrong postincrements");
assert(float128Run.record.registers[11] === INITIAL_DESTINATION + 35, "float-quad stores applied the wrong postincrements");

const unsupportedQaccXpFixture = conformanceFixture("esp32s3_unsupported_vmulas_u16_qacc_ld_xp", [
  0xae, 0x0c, 0x95, 0xf1
]);
const unsupportedQaccXpRun = await runFresh(moduleBytes, unsupportedQaccXpFixture, {
  maxSteps: 1,
  unsupported: { offset: 0, encoding: 0x0cae }
});
assert(unsupportedQaccXpRun.record.reason === STOP_REASONS.unsupported, "adjacent QACC XP MAC form did not fail closed");
assert(unsupportedQaccXpRun.record.steps === 0, "adjacent QACC XP MAC form was counted as executed");
assert(unsupportedQaccXpRun.trace.count === 0, "adjacent QACC XP MAC refusal leaked a trace record");
assert(unsupportedQaccXpRun.dataOutput.length === 0, "adjacent QACC XP MAC refusal exposed data output");
assert(
  unsupportedQaccXpRun.record.registers.every(
    (value, index) => value === initialRegisters(unsupportedQaccXpRun.record.returnPc)[index]
  ),
  "adjacent QACC XP MAC refusal changed registers"
);

const signedVmulasQupFixture = conformanceFixture("esp32s3_vmulas_s16_accx_ld_ip_qup", [
  0xa4, 0x81, 0x83,
  0xa4, 0x01, 0x93,
  0xa4, 0x81, 0x93,
  0xa4, 0x01, 0xa3,
  0x0c, 0x19,
  0x90, 0x0d, 0xf3,
  0xae, 0x5f, 0x34, 0x0c,
  0x00, 0xc0, 0xe3,
  0x10, 0xd0, 0xe3,
  0xb4, 0x81, 0x9a
]);
const signedVmulasInput = new Uint8Array(80);
const signedVmulasView = new DataView(signedVmulasInput.buffer);
const signedVmulasX = [1, -2, 300, -400, 5, 6, -7, 8];
const signedVmulasY = [9, 10, -11, -12, 13, -14, 15, 16];
signedVmulasX.forEach((value, lane) => signedVmulasView.setInt16(lane * 2, value, true));
signedVmulasY.forEach((value, lane) => signedVmulasView.setInt16(16 + lane * 2, value, true));
for (let index = 32; index < signedVmulasInput.length; index++) signedVmulasInput[index] = index + 1;
const signedVmulasExpected = new Uint8Array(80);
signedVmulasExpected.set(signedVmulasInput.slice(33, 49));
const signedVmulasRun = await runFresh(moduleBytes, signedVmulasQupFixture, {
  data: signedVmulasInput,
  maxSteps: 10
});
assert(signedVmulasRun.record.reason === STOP_REASONS.maxSteps, `signed VMULAS QUP fixture stopped with ${signedVmulasRun.record.reasonName} after ${signedVmulasRun.record.steps} at 0x${signedVmulasRun.record.pc.toString(16)}`);
assert(signedVmulasRun.record.steps === 10, `signed VMULAS QUP fixture executed ${signedVmulasRun.record.steps} instructions`);
assert(
  signedVmulasRun.dataOutput.every((byte, index) => byte === signedVmulasExpected[index]),
  `signed VMULAS QUP output changed: ${Buffer.from(signedVmulasRun.dataOutput).toString("hex")}`
);
assert(signedVmulasRun.record.registers[10] === INITIAL_SOURCE + 48, "signed VMULAS QUP applied the wrong immediate");
assert(signedVmulasRun.record.registers[11] === INITIAL_DESTINATION + 16, "signed VMULAS QUP store applied the wrong immediate");
assert(signedVmulasRun.record.registers[12] === 1493, "signed VMULAS QUP produced the wrong ACCX low word");
assert(signedVmulasRun.record.registers[13] === 0, "signed VMULAS QUP produced the wrong ACCX high byte");

const immediateVmulasCases = [
  { name: "s8", opcodeHigh: 0x2c, accxLow: 0xffff_f8d6, accxHigh: 0xff },
  { name: "u16", opcodeHigh: 0x4c, accxLow: 0xffaf_05d5, accxHigh: 0 },
  { name: "u8", opcodeHigh: 0x6c, accxLow: 0x0001_b1d6, accxHigh: 0 }
] as const;
const immediateVmulasRuns = [];
for (const vmulasCase of immediateVmulasCases) {
  const fixture = conformanceFixture(`esp32s3_vmulas_${vmulasCase.name}_accx_ld_ip_qup`, [
    0xa4, 0x81, 0x83,
    0xa4, 0x01, 0x93,
    0xa4, 0x81, 0x93,
    0xa4, 0x01, 0xa3,
    0x0c, 0x19,
    0x90, 0x0d, 0xf3,
    0xae, 0x5f, 0x34, vmulasCase.opcodeHigh,
    0x00, 0xc0, 0xe3,
    0x10, 0xd0, 0xe3,
    0xb4, 0x81, 0x9a
  ]);
  const run = await runFresh(moduleBytes, fixture, { data: signedVmulasInput, maxSteps: 10 });
  assert(run.record.reason === STOP_REASONS.maxSteps, `${vmulasCase.name} ACCX immediate VMULAS QUP stopped with ${run.record.reasonName}`);
  assert(run.record.steps === 10, `${vmulasCase.name} ACCX immediate VMULAS QUP executed ${run.record.steps} instructions`);
  assert(
    run.dataOutput.every((byte, index) => byte === signedVmulasExpected[index]),
    `${vmulasCase.name} ACCX immediate VMULAS QUP output changed: ${Buffer.from(run.dataOutput).toString("hex")}`
  );
  assert(run.record.registers[10] === INITIAL_SOURCE + 48, `${vmulasCase.name} ACCX immediate VMULAS QUP applied the wrong immediate`);
  assert(run.record.registers[12] === vmulasCase.accxLow, `${vmulasCase.name} ACCX immediate VMULAS QUP produced the wrong low word`);
  assert(run.record.registers[13] === vmulasCase.accxHigh, `${vmulasCase.name} ACCX immediate VMULAS QUP produced the wrong high byte`);
  immediateVmulasRuns.push({ vmulasCase, fixture, run });
}

const unsignedVmulasQupFixture = conformanceFixture("esp32s3_vmulas_u8_accx_ld_xp_qup", [
  0xa4, 0x81, 0x83,
  0xa4, 0x01, 0x93,
  0xa4, 0x81, 0x93,
  0xa4, 0x01, 0xa3,
  0x7c, 0xf9,
  0x90, 0x00, 0xf3,
  0x90, 0x01, 0xf3,
  0x0c, 0x19,
  0x90, 0x0d, 0xf3,
  0xae, 0x5c, 0x34, 0xc8,
  0x00, 0xc0, 0xe3,
  0x10, 0xd0, 0xe3,
  0xb4, 0x81, 0x9a
]);
const unsignedVmulasInput = Uint8Array.from({ length: 80 }, (_, index) => index + 1);
const unsignedVmulasExpected = new Uint8Array(80);
unsignedVmulasExpected.set(unsignedVmulasInput.slice(33, 49));
const unsignedVmulasRun = await runFresh(moduleBytes, unsignedVmulasQupFixture, {
  data: unsignedVmulasInput,
  maxSteps: 13
});
assert(unsignedVmulasRun.record.reason === STOP_REASONS.maxSteps, `unsigned VMULAS QUP fixture stopped with ${unsignedVmulasRun.record.reasonName}`);
assert(unsignedVmulasRun.record.steps === 13, `unsigned VMULAS QUP fixture executed ${unsignedVmulasRun.record.steps} instructions`);
assert(
  unsignedVmulasRun.dataOutput.every((byte, index) => byte === unsignedVmulasExpected[index]),
  `unsigned VMULAS QUP output changed: ${Buffer.from(unsignedVmulasRun.dataOutput).toString("hex")}`
);
assert(unsignedVmulasRun.record.registers[10] === INITIAL_SOURCE + 104, "unsigned VMULAS QUP applied the wrong register increment");
assert(unsignedVmulasRun.record.registers[12] === 0xffff_ffff, "unsigned VMULAS QUP did not saturate ACCX low");
assert(unsignedVmulasRun.record.registers[13] === 0xff, "unsigned VMULAS QUP did not saturate ACCX high");

const registerVmulasCases = [
  { name: "s16", opcodeHigh: 0xb0, accxLow: 0x07be_56a7, accxHigh: 0 },
  { name: "s8", opcodeHigh: 0xb8, accxLow: 0x0000_0e57, accxHigh: 0 },
  { name: "u16", opcodeHigh: 0xc0, accxLow: 0xffff_ffff, accxHigh: 0xff }
] as const;
const registerVmulasRuns = [];
for (const vmulasCase of registerVmulasCases) {
  const fixture = conformanceFixture(`esp32s3_vmulas_${vmulasCase.name}_accx_ld_xp_qup`, [
    0xa4, 0x81, 0x83,
    0xa4, 0x01, 0x93,
    0xa4, 0x81, 0x93,
    0xa4, 0x01, 0xa3,
    0x7c, 0xf9,
    0x90, 0x00, 0xf3,
    0x90, 0x01, 0xf3,
    0x0c, 0x19,
    0x90, 0x0d, 0xf3,
    0xae, 0x5c, 0x34, vmulasCase.opcodeHigh,
    0x00, 0xc0, 0xe3,
    0x10, 0xd0, 0xe3,
    0xb4, 0x81, 0x9a
  ]);
  const run = await runFresh(moduleBytes, fixture, { data: unsignedVmulasInput, maxSteps: 13 });
  assert(run.record.reason === STOP_REASONS.maxSteps, `${vmulasCase.name} ACCX register VMULAS QUP stopped with ${run.record.reasonName}`);
  assert(run.record.steps === 13, `${vmulasCase.name} ACCX register VMULAS QUP executed ${run.record.steps} instructions`);
  assert(
    run.dataOutput.every((byte, index) => byte === unsignedVmulasExpected[index]),
    `${vmulasCase.name} ACCX register VMULAS QUP output changed: ${Buffer.from(run.dataOutput).toString("hex")}`
  );
  assert(run.record.registers[10] === INITIAL_SOURCE + 104, `${vmulasCase.name} ACCX register VMULAS QUP applied the wrong increment`);
  assert(run.record.registers[12] === vmulasCase.accxLow, `${vmulasCase.name} ACCX register VMULAS QUP produced the wrong low word`);
  assert(run.record.registers[13] === vmulasCase.accxHigh, `${vmulasCase.name} ACCX register VMULAS QUP produced the wrong high byte`);
  registerVmulasRuns.push({ vmulasCase, fixture, run });
}

const accxLoadExpected = new Uint8Array(signedVmulasInput.length);
accxLoadExpected.set(signedVmulasInput.slice(32, 48));
const accxLoadCases = [
  { name: "s16-ip", middle: 0x00, baseLow: 0x51, accxLow: 0x0000_05d5, accxHigh: 0, sourceAfter: 48 },
  { name: "s8-ip", middle: 0x02, baseLow: 0x51, accxLow: 0xffff_f8d6, accxHigh: 0xff, sourceAfter: 48 },
  { name: "u16-ip", middle: 0x04, baseLow: 0x51, accxLow: 0xffaf_05d5, accxHigh: 0, sourceAfter: 48 },
  { name: "u8-ip", middle: 0x06, baseLow: 0x51, accxLow: 0x0001_b1d6, accxHigh: 0, sourceAfter: 48 },
  { name: "s16-xp", middle: 0x10, baseLow: 0x5c, accxLow: 0x0000_05d5, accxHigh: 0, sourceAfter: 72 },
  { name: "s8-xp", middle: 0x12, baseLow: 0x5c, accxLow: 0xffff_f8d6, accxHigh: 0xff, sourceAfter: 72 },
  { name: "u16-xp", middle: 0x14, baseLow: 0x5c, accxLow: 0xffaf_05d5, accxHigh: 0, sourceAfter: 72 },
  { name: "u8-xp", middle: 0x16, baseLow: 0x5c, accxLow: 0x0001_b1d6, accxHigh: 0, sourceAfter: 72 }
] as const;
const accxLoadRuns = [];
for (const vmulasCase of accxLoadCases) {
  const fixture = conformanceFixture(`esp32s3_vmulas_${vmulasCase.name}_accx_load`, [
    0xa4, 0x81, 0x83,
    0xa4, 0x01, 0x93,
    0xae, vmulasCase.baseLow, vmulasCase.middle, 0xf0,
    0x00, 0xd0, 0xe3,
    0x10, 0xe0, 0xe3,
    0xb4, 0x01, 0x8a
  ]);
  const run = await runFresh(moduleBytes, fixture, { data: signedVmulasInput, maxSteps: 6 });
  assert(run.record.reason === STOP_REASONS.maxSteps, `${vmulasCase.name} ACCX load VMULAS stopped with ${run.record.reasonName}`);
  assert(run.record.steps === 6, `${vmulasCase.name} ACCX load VMULAS executed ${run.record.steps} instructions`);
  assert(
    run.dataOutput.every((byte, index) => byte === accxLoadExpected[index]),
    `${vmulasCase.name} ACCX load VMULAS output changed: ${Buffer.from(run.dataOutput).toString("hex")}`
  );
  assert(run.record.registers[10] === INITIAL_SOURCE + vmulasCase.sourceAfter, `${vmulasCase.name} ACCX load VMULAS applied the wrong increment: 0x${run.record.registers[10].toString(16)}`);
  assert(run.record.registers[11] === INITIAL_DESTINATION + 16, `${vmulasCase.name} ACCX load VMULAS store applied the wrong increment`);
  assert(run.record.registers[13] === vmulasCase.accxLow, `${vmulasCase.name} ACCX load VMULAS produced the wrong low word`);
  assert(run.record.registers[14] === vmulasCase.accxHigh, `${vmulasCase.name} ACCX load VMULAS produced the wrong high byte`);
  accxLoadRuns.push({ vmulasCase, fixture, run });
}

function expectedQaccProductOutput(input: Uint8Array, elementBits: 8 | 16, signed: boolean): Uint8Array {
  const output = new Uint8Array(input.length);
  const packed = new Uint8Array(40);
  const view = new DataView(input.buffer, input.byteOffset, input.byteLength);
  const lanes = 128 / elementBits;
  const lanesPerBank = lanes / 2;
  const laneBits = elementBits === 16 ? 40 : 20;
  const elementBytes = elementBits / 8;
  for (let lane = 0; lane < lanes; lane++) {
    const offset = lane * elementBytes;
    const x = elementBits === 16
      ? (signed ? view.getInt16(offset, true) : view.getUint16(offset, true))
      : (signed ? view.getInt8(offset) : view.getUint8(offset));
    const yOffset = 16 + offset;
    const y = elementBits === 16
      ? (signed ? view.getInt16(yOffset, true) : view.getUint16(yOffset, true))
      : (signed ? view.getInt8(yOffset) : view.getUint8(yOffset));
    const value = BigInt.asUintN(laneBits, BigInt(x) * BigInt(y));
    const bankOffset = lane < lanesPerBank ? 0 : 20;
    const bankLane = lane % lanesPerBank;
    const bitOffset = bankLane * laneBits;
    for (let bit = 0; bit < laneBits; bit++) {
      if ((value & (1n << BigInt(bit))) !== 0n) {
        const outputBit = bitOffset + bit;
        packed[bankOffset + Math.floor(outputBit / 8)]! |= 1 << (outputBit % 8);
      }
    }
  }
  output.set(packed.subarray(0, 20), 0);
  output.set(packed.subarray(20), 32);
  return output;
}

const qaccVmulasInput = Uint8Array.from({ length: 64 }, (_, index) => (index * 37 + 129) & 0xff);
const qaccVmulasCases = [
  { name: "s16", instructionPrefix: 0x11, elementBits: 16 as const, signed: true },
  { name: "s8", instructionPrefix: 0x31, elementBits: 8 as const, signed: true },
  { name: "u16", instructionPrefix: 0x51, elementBits: 16 as const, signed: false },
  { name: "u8", instructionPrefix: 0x71, elementBits: 8 as const, signed: false }
] as const;
const qaccVmulasRuns = [];
for (const qaccCase of qaccVmulasCases) {
  const fixture = conformanceFixture(`esp32s3_vmulas_${qaccCase.name}_qacc_ld_ip_qup`, [
    0xa4, 0x01, 0x83,
    0xa4, 0x81, 0x83,
    0xae, 0x01, 0xb4, qaccCase.instructionPrefix,
    0xb4, 0x01, 0x0c,
    0xb4, 0x04, 0x1d,
    0xb4, 0x01, 0x0d,
    0xb4, 0x01, 0x12
  ]);
  const run = await runFresh(moduleBytes, fixture, { data: qaccVmulasInput, maxSteps: 7 });
  const expected = expectedQaccProductOutput(qaccVmulasInput, qaccCase.elementBits, qaccCase.signed);
  assert(run.record.reason === STOP_REASONS.maxSteps, `${qaccCase.name} QACC QUP stopped with ${run.record.reasonName}`);
  assert(run.record.steps === 7, `${qaccCase.name} QACC QUP executed ${run.record.steps} instructions`);
  assert(run.record.registers[10] === INITIAL_SOURCE + 48, `${qaccCase.name} QACC QUP applied the wrong immediate: 0x${run.record.registers[10].toString(16)}`);
  assert(
    run.dataOutput.every((byte, index) => byte === expected[index]),
    `${qaccCase.name} QACC QUP output changed: actual=${JSON.stringify([...run.dataOutput])} expected=${JSON.stringify([...expected])}`
  );
  qaccVmulasRuns.push({ qaccCase, fixture, run });
}

const qaccVmulasXpCases = [
  { name: "s16", instructionPrefix: 0xb5, elementBits: 16 as const, signed: true },
  { name: "s8", instructionPrefix: 0xbd, elementBits: 8 as const, signed: true },
  { name: "u16", instructionPrefix: 0xc5, elementBits: 16 as const, signed: false },
  { name: "u8", instructionPrefix: 0xcd, elementBits: 8 as const, signed: false }
] as const;
const qaccVmulasXpRuns = [];
for (const qaccCase of qaccVmulasXpCases) {
  const fixture = conformanceFixture(`esp32s3_vmulas_${qaccCase.name}_qacc_ld_xp_qup`, [
    0xa4, 0x01, 0x83,
    0xa4, 0x81, 0x83,
    0xae, 0x0c, 0xb4, qaccCase.instructionPrefix,
    0xb4, 0x01, 0x0c,
    0xb4, 0x04, 0x1d,
    0xb4, 0x01, 0x0d,
    0xb4, 0x01, 0x12
  ]);
  const run = await runFresh(moduleBytes, fixture, { data: qaccVmulasInput, maxSteps: 7 });
  const expected = expectedQaccProductOutput(qaccVmulasInput, qaccCase.elementBits, qaccCase.signed);
  assert(run.record.reason === STOP_REASONS.maxSteps, `${qaccCase.name} QACC XP QUP stopped with ${run.record.reasonName}`);
  assert(run.record.steps === 7, `${qaccCase.name} QACC XP QUP executed ${run.record.steps} instructions`);
  assert(run.record.registers[10] === INITIAL_SOURCE + 64, `${qaccCase.name} QACC XP QUP applied the wrong register increment: 0x${run.record.registers[10].toString(16)}`);
  assert(
    run.dataOutput.every((byte, index) => byte === expected[index]),
    `${qaccCase.name} QACC XP QUP output changed: ${Buffer.from(run.dataOutput).toString("hex")}`
  );
  qaccVmulasXpRuns.push({ qaccCase, fixture, run });
}

function packQacc40(values: readonly bigint[]): Uint8Array {
  let packed = 0n;
  values.forEach((value, lane) => {
    packed |= BigInt.asUintN(40, value) << BigInt(lane * 40);
  });
  return Uint8Array.from({ length: 20 }, (_, index) => Number((packed >> BigInt(index * 8)) & 0xffn));
}

const qaccSaturationCode = [
  0xa4, 0x01, 0x00,
  0xa4, 0x04, 0x16,
  0xa4, 0x01, 0x06,
  0xa4, 0x04, 0x1e,
  0xa4, 0x01, 0x83,
  0xa4, 0x81, 0x83,
  0xae, 0x01, 0xb4, 0x11,
  0xb4, 0x01, 0x0c,
  0xb4, 0x04, 0x1d,
  0xb4, 0x01, 0x0d,
  0xb4, 0x04, 0x12
] as const;
const qaccSaturationCases = [
  {
    name: "signed",
    instructionPrefix: 0x11,
    initial: [(1n << 39n) - 2n, -(1n << 39n) + 1n, 0n, 0n],
    x: [2, 2],
    y: [2, -2],
    expected: [(1n << 39n) - 1n, -(1n << 39n), 0n, 0n]
  },
  {
    name: "unsigned",
    instructionPrefix: 0x51,
    initial: [(1n << 40n) - 2n, 0n, 0n, 0n],
    x: [2],
    y: [2],
    expected: [(1n << 40n) - 1n, 0n, 0n, 0n]
  }
] as const;
const qaccSaturationRuns = [];
for (const saturationCase of qaccSaturationCases) {
  const code: number[] = [...qaccSaturationCode];
  code[21] = saturationCase.instructionPrefix;
  const fixture = conformanceFixture(`esp32s3_vmulas_qacc_${saturationCase.name}_saturation`, code);
  const input = new Uint8Array(112);
  input.set(packQacc40(saturationCase.initial), 0);
  const view = new DataView(input.buffer);
  saturationCase.x.forEach((value, lane) => view.setInt16(64 + lane * 2, value, true));
  saturationCase.y.forEach((value, lane) => view.setInt16(80 + lane * 2, value, true));
  const expected = new Uint8Array(input.length);
  expected.set(packQacc40(saturationCase.expected), 0);
  const run = await runFresh(moduleBytes, fixture, { data: input, maxSteps: 11 });
  assert(run.record.reason === STOP_REASONS.maxSteps, `${saturationCase.name} QACC saturation stopped with ${run.record.reasonName}`);
  assert(run.record.steps === 11, `${saturationCase.name} QACC saturation executed ${run.record.steps} instructions`);
  assert(run.dataOutput.every((byte, index) => byte === expected[index]), `${saturationCase.name} QACC saturation output changed: ${Buffer.from(run.dataOutput).toString("hex")}`);
  assert(run.record.registers[10] === INITIAL_SOURCE + 112, `${saturationCase.name} QACC saturation used the wrong source increments`);
  assert(run.record.registers[11] === INITIAL_DESTINATION + 64, `${saturationCase.name} QACC saturation used the wrong destination increments`);
  qaccSaturationRuns.push({ saturationCase, fixture, run });
}

const qaccQupShiftFixture = conformanceFixture("esp32s3_vmulas_qacc_observable_qup", [
  0xa4, 0x01, 0x83,
  0xa4, 0x81, 0x83,
  0xa4, 0x81, 0x93,
  0xa4, 0x01, 0xa3,
  0x0c, 0x39,
  0x90, 0x0d, 0xf3,
  0xae, 0x01, 0xb4, 0x11,
  0xb4, 0x81, 0x9a,
  0xb4, 0x01, 0x9a
]);
const qaccQupShiftInput = Uint8Array.from([
  ...Array.from({ length: 16 }, (_, index) => 0x01 + index),
  ...Array.from({ length: 16 }, (_, index) => 0x21 + index),
  ...Array.from({ length: 16 }, (_, index) => 0x40 + index),
  ...Array.from({ length: 16 }, (_, index) => 0x80 + index),
  ...Array.from({ length: 16 }, (_, index) => 0xc0 + index)
]);
const qaccQupShiftExpected = Uint8Array.from([
  ...Array.from({ length: 13 }, (_, index) => 0x43 + index),
  0x80, 0x81, 0x82,
  ...Array.from({ length: 16 }, (_, index) => 0xc0 + index)
]);
const qaccQupShiftRun = await runFresh(moduleBytes, qaccQupShiftFixture, { data: qaccQupShiftInput, maxSteps: 9 });
assert(qaccQupShiftRun.record.reason === STOP_REASONS.maxSteps, `observable QACC QUP stopped with ${qaccQupShiftRun.record.reasonName}`);
assert(qaccQupShiftRun.record.steps === 9, `observable QACC QUP executed ${qaccQupShiftRun.record.steps} instructions`);
assert(qaccQupShiftRun.dataOutput.slice(0, 32).every((byte, index) => byte === qaccQupShiftExpected[index]), `observable QACC QUP output changed: ${Buffer.from(qaccQupShiftRun.dataOutput.slice(0, 32)).toString("hex")}`);
assert(qaccQupShiftRun.record.registers[9] === 3, "observable QACC QUP did not preserve SAR_BYTE source");
assert(qaccQupShiftRun.record.registers[10] === INITIAL_SOURCE + 80, "observable QACC QUP used the wrong source increment");
assert(qaccQupShiftRun.record.registers[11] === INITIAL_DESTINATION + 32, "observable QACC QUP used the wrong destination increment");

const qaccNegativeUnalignedFixture = conformanceFixture("esp32s3_vmulas_qacc_negative_ip_unaligned", [
  0x3b, 0xaa,
  0xa4, 0x01, 0x83,
  0xa4, 0x81, 0x83,
  0xae, 0x0e, 0xb4, 0x1d,
  0xb4, 0x01, 0x9a
]);
const qaccNegativeUnalignedInput = Uint8Array.from({ length: 64 }, (_, index) => 0xa0 + index);
const qaccNegativeUnalignedRun = await runFresh(moduleBytes, qaccNegativeUnalignedFixture, { data: qaccNegativeUnalignedInput, maxSteps: 5 });
assert(qaccNegativeUnalignedRun.record.reason === STOP_REASONS.maxSteps, `unaligned QACC negative IP stopped with ${qaccNegativeUnalignedRun.record.reasonName}`);
assert(qaccNegativeUnalignedRun.record.steps === 5, `unaligned QACC negative IP executed ${qaccNegativeUnalignedRun.record.steps} instructions`);
assert(qaccNegativeUnalignedRun.dataOutput.slice(0, 16).every((byte, index) => byte === 0xc0 + index), `unaligned QACC negative IP load changed: ${Buffer.from(qaccNegativeUnalignedRun.dataOutput.slice(0, 16)).toString("hex")}`);
assert(qaccNegativeUnalignedRun.record.registers[10] === INITIAL_SOURCE + 3, "unaligned QACC negative IP used the wrong aligned address or increment");
assert(qaccNegativeUnalignedRun.record.registers[11] === INITIAL_DESTINATION + 16, "unaligned QACC negative IP store used the wrong increment");

const unsupportedQaccHammingOneFixture = conformanceFixture("esp32s3_unsupported_qacc_hamming_one_stf", [0xae, 0x01, 0xb4, 0x91]);
const unsupportedQaccHammingOneRun = await runFresh(moduleBytes, unsupportedQaccHammingOneFixture, {
  maxSteps: 1,
  unsupported: { offset: 0, encoding: 0x91b4_01ae }
});
assert(unsupportedQaccHammingOneRun.record.reason === STOP_REASONS.unsupported, "Hamming-1 QACC neighbor did not fail closed");
assert(unsupportedQaccHammingOneRun.record.steps === 0, "Hamming-1 QACC neighbor was counted as executed");
assert(unsupportedQaccHammingOneRun.trace.count === 0, "Hamming-1 QACC neighbor leaked a trace record");
assert(unsupportedQaccHammingOneRun.dataOutput.length === 0, "Hamming-1 QACC neighbor exposed data output");
assert(unsupportedQaccHammingOneRun.record.registers.every((value, index) => value === initialRegisters(unsupportedQaccHammingOneRun.record.returnPc)[index]), "Hamming-1 QACC neighbor changed registers");

const accxMemoryFixture = conformanceFixture("esp32s3_accx_memory_roundtrip", [
  0x3b, 0xaa,
  0xa4, 0x7f, 0x4e,
  0x3b, 0xbb,
  0xb4, 0x7f, 0x42,
  0x00, 0x20, 0xe3,
  0x10, 0x30, 0xe3
]);
const accxMemoryInput = Uint8Array.from([0x78, 0x56, 0x34, 0x12, 0xef, 0xbe, 0xad, 0xde]);
const accxMemoryExpected = Uint8Array.from([0x78, 0x56, 0x34, 0x12, 0xef, 0x00, 0x00, 0x00]);
const accxMemoryRun = await runFresh(moduleBytes, accxMemoryFixture, { data: accxMemoryInput, maxSteps: 6 });
assert(accxMemoryRun.record.reason === STOP_REASONS.maxSteps, `ACCX memory fixture stopped with ${accxMemoryRun.record.reasonName}`);
assert(accxMemoryRun.record.steps === 6, `ACCX memory fixture executed ${accxMemoryRun.record.steps} instructions`);
assert(
  accxMemoryRun.dataOutput.every((byte, index) => byte === accxMemoryExpected[index]),
  `ACCX memory fixture output changed: ${Buffer.from(accxMemoryRun.dataOutput).toString("hex")}`
);
assert(accxMemoryRun.record.registers[2] === 0x12345678, "ACCX memory load changed its low word");
assert(accxMemoryRun.record.registers[3] === 0xef, "ACCX memory load did not mask its high byte");
assert(accxMemoryRun.record.registers[10] === (INITIAL_SOURCE - 5) >>> 0, "ACCX memory load applied the wrong signed immediate");
assert(accxMemoryRun.record.registers[11] === (INITIAL_DESTINATION - 5) >>> 0, "ACCX memory store applied the wrong signed immediate");

const qaccMemoryFixture = conformanceFixture("esp32s3_qacc_memory_roundtrip", [
  0x3b, 0xaa,
  0xa4, 0x7f, 0x40,
  0xa2, 0xca, 0x13,
  0xa4, 0x7f, 0x56,
  0xa2, 0xca, 0x11,
  0xa4, 0x7f, 0x46,
  0xa2, 0xca, 0x12,
  0xa4, 0x7f, 0x5e,
  0x3b, 0xbb,
  0xb4, 0x7f, 0x4c,
  0xb2, 0xcb, 0x13,
  0xb4, 0x7f, 0x5d,
  0xb2, 0xcb, 0x11,
  0xb4, 0x7f, 0x4d,
  0xb2, 0xcb, 0x12,
  0xb4, 0x7f, 0x52,
  0xb0, 0x20, 0xe3,
  0x60, 0x30, 0xe3
]);
const qaccMemoryInput = Uint8Array.from({ length: 32 }, (_, index) => (index * 9 + 7) & 0xff);
const qaccMemoryRun = await runFresh(moduleBytes, qaccMemoryFixture, { data: qaccMemoryInput, maxSteps: 18 });
assert(qaccMemoryRun.record.reason === STOP_REASONS.maxSteps, `QACC memory fixture stopped with ${qaccMemoryRun.record.reasonName}`);
assert(qaccMemoryRun.record.steps === 18, `QACC memory fixture executed ${qaccMemoryRun.record.steps} instructions`);
assert(
  qaccMemoryRun.dataOutput.every((byte, index) => byte === qaccMemoryInput[index]),
  `QACC memory fixture changed payload bits: ${Buffer.from(qaccMemoryRun.dataOutput).toString("hex")}`
);
assert(qaccMemoryRun.record.registers[10] === INITIAL_SOURCE + 17, "QACC memory loads applied the wrong signed immediates");
assert(qaccMemoryRun.record.registers[11] === INITIAL_DESTINATION + 17, "QACC memory stores applied the wrong signed immediates");
assert(qaccMemoryRun.record.registers[2] === 0x463d342b, "QACC_L high-word load used the wrong aligned source address");
assert(qaccMemoryRun.record.registers[3] === 0xd6cdc4bb, "QACC_H high-word load used the wrong aligned source address");

const uaMemoryFixture = conformanceFixture("esp32s3_ua_state_memory_roundtrip", [
  0x3b, 0xaa,
  0xa4, 0x7f, 0x50,
  0x3b, 0xbb,
  0xb4, 0x7f, 0x5c,
  0xf0, 0x20, 0xe3,
  0x20, 0x31, 0xe3
]);
const uaMemoryInput = Uint8Array.from({ length: 16 }, (_, index) => (index * 13 + 2) & 0xff);
const uaMemoryRun = await runFresh(moduleBytes, uaMemoryFixture, { data: uaMemoryInput, maxSteps: 6 });
assert(uaMemoryRun.record.reason === STOP_REASONS.maxSteps, `UA_STATE memory fixture stopped with ${uaMemoryRun.record.reasonName}`);
assert(uaMemoryRun.record.steps === 6, `UA_STATE memory fixture executed ${uaMemoryRun.record.steps} instructions`);
assert(
  uaMemoryRun.dataOutput.every((byte, index) => byte === uaMemoryInput[index]),
  `UA_STATE memory fixture changed payload bits: ${Buffer.from(uaMemoryRun.dataOutput).toString("hex")}`
);
assert(uaMemoryRun.record.registers[10] === (INITIAL_SOURCE - 13) >>> 0, "UA_STATE load applied the wrong signed immediate");
assert(uaMemoryRun.record.registers[11] === (INITIAL_DESTINATION - 13) >>> 0, "UA_STATE store applied the wrong signed immediate");
assert(uaMemoryRun.record.registers[2] === 0x291c0f02, "UA_STATE load changed its low word");
assert(uaMemoryRun.record.registers[3] === 0xc5b8ab9e, "UA_STATE load changed its high word");

const alignedLoadFixture = conformanceFixture("esp32s3_usar_and_broadcast_loads", [
  0x3b, 0xaa,
  0xa4, 0x7f, 0xd1,
  0xd0, 0x20, 0xe3,
  0xb4, 0x00, 0x9a,
  0xb2, 0xcb, 0x10,
  0xa2, 0xca, 0x13,
  0xa4, 0xff, 0xd2,
  0xb4, 0x80, 0x9a
]);
const alignedLoadInput = Uint8Array.from({ length: 32 }, (_, index) => (index * 11 + 5) & 0xff);
const alignedLoadExpected = new Uint8Array(32);
alignedLoadExpected.set(alignedLoadInput.slice(0, 16), 0);
for (let index = 16; index < 32; index++) alignedLoadExpected[index] = alignedLoadInput[4 + ((index - 16) & 3)]!;
const alignedLoadRun = await runFresh(moduleBytes, alignedLoadFixture, { data: alignedLoadInput, maxSteps: 8 });
assert(alignedLoadRun.record.reason === STOP_REASONS.maxSteps, `aligned-load fixture stopped with ${alignedLoadRun.record.reasonName}`);
assert(alignedLoadRun.record.steps === 8, `aligned-load fixture executed ${alignedLoadRun.record.steps} instructions`);
assert(
  alignedLoadRun.dataOutput.every((byte, index) => byte === alignedLoadExpected[index]),
  `aligned-load fixture output changed: ${Buffer.from(alignedLoadRun.dataOutput).toString("hex")}`
);
assert(alignedLoadRun.record.registers[2] === 3, "USAR load did not preserve the unaligned address nibble in SAR_BYTE");
assert(alignedLoadRun.record.registers[10] === INITIAL_SOURCE + 2, "aligned loads applied the wrong signed immediates");
assert(alignedLoadRun.record.registers[11] === INITIAL_DESTINATION + 16, "aligned-load stores used the wrong destination");

const alignedMoreFixture = conformanceFixture("esp32s3_more_aligned_transfers", [
  0x3b, 0xaa,
  0xa4, 0x0c, 0xad,
  0x3b, 0xbb,
  0xb4, 0x7f, 0xe4,
  0xa4, 0x81, 0x95,
  0xb2, 0xcb, 0x15,
  0xb4, 0x80, 0x9a,
  0xd0, 0x20, 0xe3
]);
const alignedMoreInput = Uint8Array.from({ length: 32 }, (_, index) => (index * 5 + 6) & 0xff);
const alignedMoreExpected = new Uint8Array(32);
alignedMoreExpected.set(alignedMoreInput.slice(0, 8), 0);
for (let index = 16; index < 32; index++) alignedMoreExpected[index] = alignedMoreInput[18 + ((index - 16) & 1)]!;
const alignedMoreRun = await runFresh(moduleBytes, alignedMoreFixture, { data: alignedMoreInput, maxSteps: 8 });
assert(alignedMoreRun.record.reason === STOP_REASONS.maxSteps, `additional aligned fixture stopped with ${alignedMoreRun.record.reasonName}`);
assert(alignedMoreRun.record.steps === 8, `additional aligned fixture executed ${alignedMoreRun.record.steps} instructions`);
assert(
  alignedMoreRun.dataOutput.every((byte, index) => byte === alignedMoreExpected[index]),
  `additional aligned fixture output changed: ${Buffer.from(alignedMoreRun.dataOutput).toString("hex")}`
);
assert(alignedMoreRun.record.registers[2] === 3, "USAR XP did not preserve the unaligned address nibble");
assert(alignedMoreRun.record.registers[10] === INITIAL_SOURCE + 21, "additional aligned loads applied the wrong postincrements");
assert(alignedMoreRun.record.registers[11] === INITIAL_DESTINATION + 16, "low-half store applied the wrong postincrement");

const unsupportedBroadcastXpFixture = conformanceFixture("esp32s3_unsupported_vldbc_16_xp", [0xa4, 0x4c, 0x8d]);
const unsupportedBroadcastXpRun = await runFresh(moduleBytes, unsupportedBroadcastXpFixture, {
  maxSteps: 1,
  unsupported: { offset: 0, encoding: 0x8d4ca4 }
});
assert(unsupportedBroadcastXpRun.record.reason === STOP_REASONS.unsupported, "adjacent broadcast XP did not fail closed");
assert(unsupportedBroadcastXpRun.record.steps === 0, "adjacent broadcast XP was counted as executed");
assert(unsupportedBroadcastXpRun.trace.count === 0, "adjacent broadcast XP leaked a trace record");
assert(unsupportedBroadcastXpRun.dataOutput.length === 0, "adjacent broadcast XP exposed data output");

const signedQaccLoadFixture = conformanceFixture("esp32s3_signed_qacc_lane_load", [
  0x5b, 0xaa,
  0xa4, 0x7f, 0x41,
  0x70, 0x20, 0xe3,
  0x80, 0x30, 0xe3,
  0x90, 0x40, 0xe3,
  0xa0, 0x50, 0xe3,
  0xb0, 0x60, 0xe3,
  0x20, 0x70, 0xe3,
  0x30, 0x80, 0xe3,
  0x40, 0x90, 0xe3,
  0x50, 0xc0, 0xe3,
  0x60, 0xd0, 0xe3
]);
const signedQaccLoadInput = Uint8Array.from([
  0x01, 0x00, 0xff, 0x7f, 0x00, 0x80, 0xff, 0xff,
  0x34, 0x12, 0xdc, 0xfe, 0x00, 0x40, 0x00, 0xc0
]);
const signedQaccLoadRun = await runFresh(moduleBytes, signedQaccLoadFixture, {
  data: signedQaccLoadInput,
  maxSteps: 12
});
assert(signedQaccLoadRun.record.reason === STOP_REASONS.maxSteps, `signed QACC fixture stopped with ${signedQaccLoadRun.record.reasonName}`);
assert(signedQaccLoadRun.record.steps === 12, `signed QACC fixture executed ${signedQaccLoadRun.record.steps} instructions`);
assert(signedQaccLoadRun.record.registers[10] === (INITIAL_SOURCE - 11) >>> 0, "signed QACC load applied the wrong postincrement");
const signedQaccRegisters = [2, 3, 4, 5, 6, 7, 8, 9, 12, 13];
const signedQaccExpected = [
  0x00000001, 0x007fff00, 0x80000000, 0xffffffff, 0xffffffff,
  0x00001234, 0xfffedc00, 0x4000ffff, 0x00000000, 0xffffffc0
];
assert(
  signedQaccRegisters.every((register, index) => signedQaccLoadRun.record.registers[register] === signedQaccExpected[index]),
  "signed QACC load packed or sign-extended a 40-bit lane incorrectly"
);

const unsignedQaccU16Fixture = conformanceFixture("esp32s3_unsigned_qacc_u16_load", [
  0x5b, 0xaa,
  0xa4, 0x7f, 0x45,
  0x70, 0x20, 0xe3,
  0x80, 0x30, 0xe3,
  0x90, 0x40, 0xe3,
  0xa0, 0x50, 0xe3,
  0xb0, 0x60, 0xe3,
  0x20, 0x70, 0xe3,
  0x30, 0x80, 0xe3,
  0x40, 0x90, 0xe3,
  0x50, 0xc0, 0xe3,
  0x60, 0xd0, 0xe3
]);
const unsignedQaccU16Run = await runFresh(moduleBytes, unsignedQaccU16Fixture, {
  data: signedQaccLoadInput,
  maxSteps: 12
});
const unsignedQaccU16Expected = [
  0x00000001, 0x007fff00, 0x80000000, 0xff000000, 0x000000ff,
  0x00001234, 0x00fedc00, 0x40000000, 0x00000000, 0x000000c0
];
assert(unsignedQaccU16Run.record.reason === STOP_REASONS.maxSteps, "unsigned U16 QACC fixture did not finish");
assert(unsignedQaccU16Run.record.steps === 12, "unsigned U16 QACC fixture executed the wrong instruction count");
assert(unsignedQaccU16Run.record.registers[10] === (INITIAL_SOURCE - 11) >>> 0, "unsigned U16 QACC load applied the wrong postincrement");
assert(
  signedQaccRegisters.every((register, index) => unsignedQaccU16Run.record.registers[register] === unsignedQaccU16Expected[index]),
  "unsigned U16 QACC load packed or zero-extended a 40-bit lane incorrectly"
);

const unsignedQaccU8Input = Uint8Array.from([
  0x01, 0x7f, 0x80, 0xff, 0x12, 0xfe, 0x40, 0xc0,
  0x02, 0x55, 0xaa, 0x99, 0x11, 0x22, 0x33, 0x44
]);
const unsignedQaccU8Fixture = conformanceFixture("esp32s3_unsigned_qacc_u8_load", [
  0x5b, 0xaa,
  0xa4, 0x02, 0x15,
  0x70, 0x20, 0xe3,
  0x80, 0x30, 0xe3,
  0x90, 0x40, 0xe3,
  0xa0, 0x50, 0xe3,
  0xb0, 0x60, 0xe3,
  0x20, 0x70, 0xe3,
  0x30, 0x80, 0xe3,
  0x40, 0x90, 0xe3,
  0x50, 0xc0, 0xe3,
  0x60, 0xd0, 0xe3
]);
const unsignedQaccU8Run = await runFresh(moduleBytes, unsignedQaccU8Fixture, {
  data: unsignedQaccU8Input,
  maxSteps: 12
});
const unsignedQaccU8Expected = [
  0x07f00001, 0xf0008000, 0x0012000f, 0x40000fe0, 0x000c0000,
  0x05500002, 0x9000aa00, 0x00110009, 0x33000220, 0x00044000
];
assert(unsignedQaccU8Run.record.reason === STOP_REASONS.maxSteps, "unsigned U8 QACC fixture did not finish");
assert(unsignedQaccU8Run.record.steps === 12, "unsigned U8 QACC fixture executed the wrong instruction count");
assert(unsignedQaccU8Run.record.registers[10] === INITIAL_SOURCE + 37, "unsigned U8 QACC load applied the wrong postincrement");
assert(
  signedQaccRegisters.every((register, index) => unsignedQaccU8Run.record.registers[register] === unsignedQaccU8Expected[index]),
  "unsigned U8 QACC load packed or zero-extended a 20-bit lane incorrectly"
);

const unsupportedQaccLaneFixture = conformanceFixture("esp32s3_unsupported_ldqa_u16_128_xp", [0xa4, 0x4c, 0x7a]);
const unsupportedQaccLaneRun = await runFresh(moduleBytes, unsupportedQaccLaneFixture, {
  maxSteps: 1,
  unsupported: { offset: 0, encoding: 0x7a4ca4 }
});
assert(unsupportedQaccLaneRun.record.reason === STOP_REASONS.unsupported, "adjacent unsigned QACC XP load did not fail closed");
assert(unsupportedQaccLaneRun.record.steps === 0, "adjacent unsigned QACC load was counted as executed");
assert(unsupportedQaccLaneRun.trace.count === 0, "adjacent unsigned QACC refusal leaked a trace record");
assert(unsupportedQaccLaneRun.dataOutput.length === 0, "adjacent unsigned QACC refusal exposed data output");
assert(
  unsupportedQaccLaneRun.record.registers.every(
    (value, index) => value === initialRegisters(unsupportedQaccLaneRun.record.returnPc)[index]
  ),
  "adjacent unsigned QACC refusal changed registers"
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
const failedStepRegisters = initialRegisters(unknownUserRegisterRun.record.returnPc);
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
assert(pie.elfSha256 === "3cb3f1d4751a14132e5a4e6e1d936cbd81cf8b04a9a9ac3d9470a104c93c6a1b", "PIE fixture ELF changed");
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
assert(staging.elfSha256 === "55164f2c9c6ab825dba9c2d8bd05319e381e6e2ce0cb6d4272fdb2e3a7cd415f", "staging ELF changed");
assert(staging.objdumpSha256 === "90a91caa519b895bd457f4eb7c5fd6b14a9c64c0c7d946e78e7f332ea57d7466", "objdump changed");
assert(staging.pc === 0x4205824c, "staging function PC changed");
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
  qrScalarIsa: {
    codeSha256: qrScalarFixture.codeSha256,
    outputHex: Buffer.from(qrScalarRun.dataOutput).toString("hex"),
    reason: qrScalarRun.record.reasonName,
    steps: qrScalarRun.record.steps,
    unsupportedCodeSha256: unsupportedQrNeighborFixture.codeSha256,
    unsupportedReason: unsupportedQrNeighborRun.record.reasonName,
    unsupportedEncoding: `0x${unsupportedQrNeighborRun.record.unsupportedEncoding.toString(16)}`
  },
  qrBitwiseIsa: {
    codeSha256: qrBitwiseFixture.codeSha256,
    outputHex: Buffer.from(qrBitwiseRun.dataOutput).toString("hex"),
    reason: qrBitwiseRun.record.reasonName,
    steps: qrBitwiseRun.record.steps,
    sourceAfter: `0x${qrBitwiseRun.record.registers[10].toString(16)}`,
    destinationAfter: `0x${qrBitwiseRun.record.registers[11].toString(16)}`
  },
  qrCompareIsa: {
    codeSha256: qrCompareFixture.codeSha256,
    outputHex: Buffer.from(qrCompareRun.dataOutput).toString("hex"),
    reason: qrCompareRun.record.reasonName,
    steps: qrCompareRun.record.steps,
    unsupportedCodeSha256: unsupportedQrCompareFixture.codeSha256,
    unsupportedReason: unsupportedQrCompareRun.record.reasonName,
    unsupportedEncoding: `0x${unsupportedQrCompareRun.record.unsupportedEncoding.toString(16)}`
  },
  qrPreluIsa: {
    codeSha256: qrPreluFixture.codeSha256,
    outputHex: Buffer.from(qrPreluRun.dataOutput).toString("hex"),
    reason: qrPreluRun.record.reasonName,
    steps: qrPreluRun.record.steps,
    unsupportedCodeSha256: unsupportedQrReluFixture.codeSha256,
    unsupportedReason: unsupportedQrReluRun.record.reasonName,
    unsupportedEncoding: `0x${unsupportedQrReluRun.record.unsupportedEncoding.toString(16)}`
  },
  qrXpIsa: {
    codeSha256: qrXpFixture.codeSha256,
    outputHex: Buffer.from(qrXpRun.dataOutput).toString("hex"),
    reason: qrXpRun.record.reasonName,
    steps: qrXpRun.record.steps,
    sourceAfter: `0x${qrXpRun.record.registers[10].toString(16)}`,
    incrementValue: qrXpRun.record.registers[12]
  },
  srcIsa: {
    codeSha256: srcFixture.codeSha256,
    outputHex: Buffer.from(srcRun.dataOutput).toString("hex"),
    reason: srcRun.record.reasonName,
    steps: srcRun.record.steps,
    sourceAfter: `0x${srcRun.record.registers[10].toString(16)}`,
    destinationAfter: `0x${srcRun.record.registers[11].toString(16)}`,
    aliasCodeSha256: srcAliasFixture.codeSha256,
    aliasOutputHex: Buffer.from(srcAliasRun.dataOutput).toString("hex"),
    immediateCodeSha256: srcIpFixture.codeSha256,
    immediateOutputHex: Buffer.from(srcIpRun.dataOutput).toString("hex"),
    immediateSourceAfter: `0x${srcIpRun.record.registers[10].toString(16)}`,
    registerCodeSha256: srcXpFixture.codeSha256,
    registerOutputHex: Buffer.from(srcXpRun.dataOutput).toString("hex"),
    registerSourceAfter: `0x${srcXpRun.record.registers[10].toString(16)}`,
    neighborCodeSha256: unsupportedSrcIpNeighborFixture.codeSha256,
    neighborReason: unsupportedSrcIpNeighborRun.record.reasonName,
    neighborLength: unsupportedSrcIpNeighborRun.record.unsupportedLength
  },
  halfQrIsa: {
    codeSha256: halfQrFixture.codeSha256,
    outputHex: Buffer.from(halfQrRun.dataOutput).toString("hex"),
    reason: halfQrRun.record.reasonName,
    steps: halfQrRun.record.steps,
    sourceAfter: `0x${halfQrRun.record.registers[10].toString(16)}`,
    destinationAfter: `0x${halfQrRun.record.registers[11].toString(16)}`
  },
  halfQrXpIsa: {
    codeSha256: halfQrXpFixture.codeSha256,
    outputHex: Buffer.from(halfQrXpRun.dataOutput).toString("hex"),
    reason: halfQrXpRun.record.reasonName,
    steps: halfQrXpRun.record.steps,
    sourceAfter: `0x${halfQrXpRun.record.registers[10].toString(16)}`,
    destinationAfter: `0x${halfQrXpRun.record.registers[11].toString(16)}`
  },
  float64XpIsa: {
    codeSha256: float64XpFixture.codeSha256,
    outputHex: Buffer.from(float64XpRun.dataOutput).toString("hex"),
    reason: float64XpRun.record.reasonName,
    steps: float64XpRun.record.steps,
    sourceAfter: `0x${float64XpRun.record.registers[10].toString(16)}`,
    destinationAfter: `0x${float64XpRun.record.registers[11].toString(16)}`
  },
  float64IpIsa: {
    codeSha256: float64IpFixture.codeSha256,
    outputHex: Buffer.from(float64IpRun.dataOutput).toString("hex"),
    reason: float64IpRun.record.reasonName,
    steps: float64IpRun.record.steps,
    sourceAfter: `0x${float64IpRun.record.registers[10].toString(16)}`,
    destinationAfter: `0x${float64IpRun.record.registers[11].toString(16)}`,
    unsupportedCodeSha256: unsupportedFloat64IpFixture.codeSha256,
    unsupportedReason: unsupportedFloat64IpRun.record.reasonName,
    unsupportedEncoding: `0x${unsupportedFloat64IpRun.record.unsupportedEncoding.toString(16)}`
  },
  float128Isa: {
    codeSha256: float128Fixture.codeSha256,
    outputHex: Buffer.from(float128Run.dataOutput).toString("hex"),
    reason: float128Run.record.reasonName,
    steps: float128Run.record.steps,
    sourceAfter: `0x${float128Run.record.registers[10].toString(16)}`,
    destinationAfter: `0x${float128Run.record.registers[11].toString(16)}`,
    unsupportedCodeSha256: unsupportedQaccXpFixture.codeSha256,
    unsupportedReason: unsupportedQaccXpRun.record.reasonName,
    unsupportedEncoding: `0x${unsupportedQaccXpRun.record.unsupportedEncoding.toString(16)}`
  },
  vmulasQupIsa: {
    signedCodeSha256: signedVmulasQupFixture.codeSha256,
    signedOutputHex: Buffer.from(signedVmulasRun.dataOutput).toString("hex"),
    signedReason: signedVmulasRun.record.reasonName,
    signedSteps: signedVmulasRun.record.steps,
    signedSourceAfter: `0x${signedVmulasRun.record.registers[10].toString(16)}`,
    signedAccxLow: `0x${signedVmulasRun.record.registers[12].toString(16)}`,
    signedAccxHigh: `0x${signedVmulasRun.record.registers[13].toString(16)}`,
    immediateVariants: immediateVmulasRuns.map(({ vmulasCase, fixture, run }) => ({
      name: vmulasCase.name,
      codeSha256: fixture.codeSha256,
      outputHex: Buffer.from(run.dataOutput).toString("hex"),
      reason: run.record.reasonName,
      steps: run.record.steps,
      sourceAfter: `0x${run.record.registers[10].toString(16)}`,
      accxLow: `0x${run.record.registers[12].toString(16)}`,
      accxHigh: `0x${run.record.registers[13].toString(16)}`
    })),
    unsignedCodeSha256: unsignedVmulasQupFixture.codeSha256,
    unsignedOutputHex: Buffer.from(unsignedVmulasRun.dataOutput).toString("hex"),
    unsignedReason: unsignedVmulasRun.record.reasonName,
    unsignedSteps: unsignedVmulasRun.record.steps,
    unsignedSourceAfter: `0x${unsignedVmulasRun.record.registers[10].toString(16)}`,
    unsignedAccxLow: `0x${unsignedVmulasRun.record.registers[12].toString(16)}`,
    unsignedAccxHigh: `0x${unsignedVmulasRun.record.registers[13].toString(16)}`,
    registerVariants: registerVmulasRuns.map(({ vmulasCase, fixture, run }) => ({
      name: vmulasCase.name,
      codeSha256: fixture.codeSha256,
      outputHex: Buffer.from(run.dataOutput).toString("hex"),
      reason: run.record.reasonName,
      steps: run.record.steps,
      sourceAfter: `0x${run.record.registers[10].toString(16)}`,
      accxLow: `0x${run.record.registers[12].toString(16)}`,
      accxHigh: `0x${run.record.registers[13].toString(16)}`
    })),
    nonQupVariants: accxLoadRuns.map(({ vmulasCase, fixture, run }) => ({
      name: vmulasCase.name,
      codeSha256: fixture.codeSha256,
      outputHex: Buffer.from(run.dataOutput).toString("hex"),
      reason: run.record.reasonName,
      steps: run.record.steps,
      sourceAfter: `0x${run.record.registers[10].toString(16)}`,
      destinationAfter: `0x${run.record.registers[11].toString(16)}`,
      accxLow: `0x${run.record.registers[13].toString(16)}`,
      accxHigh: `0x${run.record.registers[14].toString(16)}`
    })),
    unsupportedCodeSha256: unsupportedQaccXpFixture.codeSha256,
    unsupportedReason: unsupportedQaccXpRun.record.reasonName,
    unsupportedEncoding: `0x${unsupportedQaccXpRun.record.unsupportedEncoding.toString(16)}`
  },
  qaccVmulasQupIsa: {
    immediateVariants: qaccVmulasRuns.map(({ qaccCase, fixture, run }) => ({
      name: qaccCase.name,
      codeSha256: fixture.codeSha256,
      outputHex: Buffer.from(run.dataOutput).toString("hex"),
      reason: run.record.reasonName,
      steps: run.record.steps,
      sourceAfter: `0x${run.record.registers[10].toString(16)}`
    })),
    registerVariants: qaccVmulasXpRuns.map(({ qaccCase, fixture, run }) => ({
      name: qaccCase.name,
      codeSha256: fixture.codeSha256,
      outputHex: Buffer.from(run.dataOutput).toString("hex"),
      reason: run.record.reasonName,
      steps: run.record.steps,
      sourceAfter: `0x${run.record.registers[10].toString(16)}`
    })),
    edgeCases: {
      saturation: qaccSaturationRuns.map(({ saturationCase, fixture, run }) => ({
        name: saturationCase.name,
        codeSha256: fixture.codeSha256,
        lowBankHex: Buffer.from(run.dataOutput.slice(0, 20)).toString("hex"),
        highBankHex: Buffer.from(run.dataOutput.slice(32, 52)).toString("hex"),
        reason: run.record.reasonName,
        steps: run.record.steps,
        sourceAfter: `0x${run.record.registers[10].toString(16)}`,
        destinationAfter: `0x${run.record.registers[11].toString(16)}`
      })),
      qupShift: {
        codeSha256: qaccQupShiftFixture.codeSha256,
        outputHex: Buffer.from(qaccQupShiftRun.dataOutput.slice(0, 32)).toString("hex"),
        reason: qaccQupShiftRun.record.reasonName,
        steps: qaccQupShiftRun.record.steps,
        sourceAfter: `0x${qaccQupShiftRun.record.registers[10].toString(16)}`,
        destinationAfter: `0x${qaccQupShiftRun.record.registers[11].toString(16)}`
      },
      negativeIpUnaligned: {
        codeSha256: qaccNegativeUnalignedFixture.codeSha256,
        outputHex: Buffer.from(qaccNegativeUnalignedRun.dataOutput.slice(0, 16)).toString("hex"),
        reason: qaccNegativeUnalignedRun.record.reasonName,
        steps: qaccNegativeUnalignedRun.record.steps,
        sourceAfter: `0x${qaccNegativeUnalignedRun.record.registers[10].toString(16)}`,
        destinationAfter: `0x${qaccNegativeUnalignedRun.record.registers[11].toString(16)}`
      },
      hammingOneUnsupported: {
        codeSha256: unsupportedQaccHammingOneFixture.codeSha256,
        reason: unsupportedQaccHammingOneRun.record.reasonName,
        steps: unsupportedQaccHammingOneRun.record.steps,
        encoding: `0x${unsupportedQaccHammingOneRun.record.unsupportedEncoding.toString(16)}`,
        traceRecords: unsupportedQaccHammingOneRun.trace.count
      }
    }
  },
  accxMemoryIsa: {
    codeSha256: accxMemoryFixture.codeSha256,
    outputHex: Buffer.from(accxMemoryRun.dataOutput).toString("hex"),
    reason: accxMemoryRun.record.reasonName,
    steps: accxMemoryRun.record.steps,
    sourceAfter: `0x${accxMemoryRun.record.registers[10].toString(16)}`,
    destinationAfter: `0x${accxMemoryRun.record.registers[11].toString(16)}`,
    lowValue: `0x${accxMemoryRun.record.registers[2].toString(16)}`,
    highValue: `0x${accxMemoryRun.record.registers[3].toString(16)}`
  },
  qaccMemoryIsa: {
    codeSha256: qaccMemoryFixture.codeSha256,
    outputHex: Buffer.from(qaccMemoryRun.dataOutput).toString("hex"),
    reason: qaccMemoryRun.record.reasonName,
    steps: qaccMemoryRun.record.steps,
    sourceAfter: `0x${qaccMemoryRun.record.registers[10].toString(16)}`,
    destinationAfter: `0x${qaccMemoryRun.record.registers[11].toString(16)}`,
    lowHighValue: `0x${qaccMemoryRun.record.registers[2].toString(16)}`,
    highHighValue: `0x${qaccMemoryRun.record.registers[3].toString(16)}`
  },
  uaMemoryIsa: {
    codeSha256: uaMemoryFixture.codeSha256,
    outputHex: Buffer.from(uaMemoryRun.dataOutput).toString("hex"),
    reason: uaMemoryRun.record.reasonName,
    steps: uaMemoryRun.record.steps,
    sourceAfter: `0x${uaMemoryRun.record.registers[10].toString(16)}`,
    destinationAfter: `0x${uaMemoryRun.record.registers[11].toString(16)}`,
    lowValue: `0x${uaMemoryRun.record.registers[2].toString(16)}`,
    highValue: `0x${uaMemoryRun.record.registers[3].toString(16)}`
  },
  alignedLoadIsa: {
    codeSha256: alignedLoadFixture.codeSha256,
    outputHex: Buffer.from(alignedLoadRun.dataOutput).toString("hex"),
    reason: alignedLoadRun.record.reasonName,
    steps: alignedLoadRun.record.steps,
    sourceAfter: `0x${alignedLoadRun.record.registers[10].toString(16)}`,
    destinationAfter: `0x${alignedLoadRun.record.registers[11].toString(16)}`,
    sarByte: alignedLoadRun.record.registers[2]
  },
  alignedMoreIsa: {
    codeSha256: alignedMoreFixture.codeSha256,
    outputHex: Buffer.from(alignedMoreRun.dataOutput).toString("hex"),
    reason: alignedMoreRun.record.reasonName,
    steps: alignedMoreRun.record.steps,
    sourceAfter: `0x${alignedMoreRun.record.registers[10].toString(16)}`,
    destinationAfter: `0x${alignedMoreRun.record.registers[11].toString(16)}`,
    sarByte: alignedMoreRun.record.registers[2],
    unsupportedCodeSha256: unsupportedBroadcastXpFixture.codeSha256,
    unsupportedReason: unsupportedBroadcastXpRun.record.reasonName,
    unsupportedEncoding: `0x${unsupportedBroadcastXpRun.record.unsupportedEncoding.toString(16)}`
  },
  signedQaccLoadIsa: {
    codeSha256: signedQaccLoadFixture.codeSha256,
    reason: signedQaccLoadRun.record.reasonName,
    steps: signedQaccLoadRun.record.steps,
    sourceAfter: `0x${signedQaccLoadRun.record.registers[10].toString(16)}`,
    lowWords: signedQaccRegisters.slice(0, 5).map((register) => `0x${signedQaccLoadRun.record.registers[register].toString(16)}`),
    highWords: signedQaccRegisters.slice(5).map((register) => `0x${signedQaccLoadRun.record.registers[register].toString(16)}`)
  },
  unsignedQaccLoadIsa: {
    u16CodeSha256: unsignedQaccU16Fixture.codeSha256,
    u16SourceAfter: `0x${unsignedQaccU16Run.record.registers[10].toString(16)}`,
    u16Words: signedQaccRegisters.map((register) => `0x${unsignedQaccU16Run.record.registers[register].toString(16)}`),
    u8CodeSha256: unsignedQaccU8Fixture.codeSha256,
    u8SourceAfter: `0x${unsignedQaccU8Run.record.registers[10].toString(16)}`,
    u8Words: signedQaccRegisters.map((register) => `0x${unsignedQaccU8Run.record.registers[register].toString(16)}`),
    unsupportedCodeSha256: unsupportedQaccLaneFixture.codeSha256,
    unsupportedReason: unsupportedQaccLaneRun.record.reasonName,
    unsupportedEncoding: `0x${unsupportedQaccLaneRun.record.unsupportedEncoding.toString(16)}`
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
    qrScalarIsa: baseline.qrScalarIsa,
    qrBitwiseIsa: baseline.qrBitwiseIsa,
    qrCompareIsa: baseline.qrCompareIsa,
    qrPreluIsa: baseline.qrPreluIsa,
    qrXpIsa: baseline.qrXpIsa,
    srcIsa: baseline.srcIsa,
    halfQrIsa: baseline.halfQrIsa,
    halfQrXpIsa: baseline.halfQrXpIsa,
    float64XpIsa: baseline.float64XpIsa,
    float64IpIsa: baseline.float64IpIsa,
    float128Isa: baseline.float128Isa,
    vmulasQupIsa: baseline.vmulasQupIsa,
    qaccVmulasQupIsa: baseline.qaccVmulasQupIsa,
    accxMemoryIsa: baseline.accxMemoryIsa,
    qaccMemoryIsa: baseline.qaccMemoryIsa,
    uaMemoryIsa: baseline.uaMemoryIsa,
    alignedLoadIsa: baseline.alignedLoadIsa,
    alignedMoreIsa: baseline.alignedMoreIsa,
    signedQaccLoadIsa: baseline.signedQaccLoadIsa,
    unsignedQaccLoadIsa: baseline.unsignedQaccLoadIsa,
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
