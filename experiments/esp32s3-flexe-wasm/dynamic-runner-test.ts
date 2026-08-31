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
  DEFAULT_TINYDRAW_ESP32S3_STAGING_ELF,
  DEFAULT_TINYDRAW_ESP32S3_STAGING_SYMBOL,
  EXPECTED_FREESTANDING_EXPORTS,
  EXPECTED_FREESTANDING_IMPORTS,
  FLEXE_COMMIT,
  FLEXE_DISASSEMBLER_SHA256,
  SOURCE_HASHES
} from "./constants";
import { extractElfFunction, type ExtractedElfFunction } from "./elf-fixture";
import { parseFlexeDecoderSurface } from "./isa-inventory";
import { commandVersion, requireSuccess, run, sha256 } from "./lib";

const RESULT_ABI_VERSION = 1;
const RESULT_WORDS = 27;
const RESULT_BYTES = RESULT_WORDS * 4;
const NO_UNSUPPORTED_OFFSET = 0xffffffff;
const INITIAL_STACK = 0x3fcaffc0;

const STOP_REASONS = {
  returned: 1,
  maxSteps: 2,
  unsupported: 3,
  stepError: 4,
  invalidArgument: 5,
  allocationFailed: 6,
  cpuStopped: 7
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
}

interface RunOptions {
  data?: Uint8Array;
  maxSteps?: number;
  unsupported?: { offset: number; encoding: number };
}

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

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function reasonName(value: number): keyof typeof STOP_REASONS {
  const match = Object.entries(STOP_REASONS).find(([, number]) => number === value);
  if (!match) throw new Error(`unknown dynamic runner stop reason ${value}`);
  return match[0] as keyof typeof STOP_REASONS;
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

async function runFresh(
  moduleBytes: ArrayBuffer,
  fixture: ExtractedElfFunction,
  options: RunOptions = {}
): Promise<{ record: StopRecord; logs: string[]; dataOutput: Uint8Array }> {
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

  const inputPointer = exports.flexe_wasm_input() >>> 0;
  const inputCapacity = exports.flexe_wasm_input_capacity() >>> 0;
  assert(fixture.bytes.length <= inputCapacity, `${fixture.symbol} exceeds the dynamic input buffer`);
  assert(
    inputPointer + fixture.bytes.length <= exports.memory.buffer.byteLength,
    "dynamic input buffer is outside wasm memory"
  );
  new Uint8Array(exports.memory.buffer, inputPointer, fixture.bytes.length).set(fixture.bytes);
  const data = options.data;
  let dataOutput = new Uint8Array();
  let recordPointer: number;
  if (data) {
    const dataCapacity = exports.flexe_wasm_data_capacity() >>> 0;
    const dataInputPointer = exports.flexe_wasm_data_input() >>> 0;
    assert(data.length <= dataCapacity, `${fixture.symbol} data exceeds the dynamic data buffer`);
    assert(dataInputPointer + data.length <= exports.memory.buffer.byteLength, "data input is outside wasm memory");
    new Uint8Array(exports.memory.buffer, dataInputPointer, data.length).set(data);
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
    recordPointer = exports.flexe_wasm_run(
      fixture.pc,
      fixture.bytes.length,
      options.maxSteps ?? 64,
      options.unsupported?.offset ?? NO_UNSUPPORTED_OFFSET,
      options.unsupported?.encoding ?? 0
    );
  }
  return { record: decodeStopRecord(exports.memory, recordPointer), logs, dataOutput };
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
assert(scalar.elfSha256 === "87d6a00ffdf18c9bcb7dd3742658b5a1786212f939f5cbafe1b82562a350f70f", "scalar ELF changed");
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

const pie = extractElfFunction(
  DEFAULT_ESP32S3_OBJDUMP,
  DEFAULT_TINYDRAW_ESP32S3_FIXTURE_ELF,
  DEFAULT_TINYDRAW_ESP32S3_FIXTURE_SYMBOL
);
assert(pie.elfSha256 === "2293fb3d35ba2f785e4dce5dfb35d2f33e452150167dc8d24f0e091cfa3e6d53", "PIE fixture ELF changed");
assert(pie.pc === 0x40377a4c, "PIE fixture PC changed");
assert(pie.codeSha256 === "f0503e09af131793fa0dfdf9077a9d433225c08962672d7f492f1496b15d1c75", "PIE fixture code changed");
const pieGap = pie.instructions.find((row) => row.addressValue === 0x40377a54);
assert(pieGap?.objdumpEncoding === "830124", "PIE gap encoding changed");
assert(pieGap.rawMnemonic === "ee.vld.128.ip", "PIE gap mnemonic changed");
const pieRun = await runFresh(moduleBytes, pie, {
  unsupported: {
    offset: pieGap.addressValue - pie.pc,
    encoding: Number.parseInt(pieGap.objdumpEncoding, 16)
  }
});
assert(pieRun.record.reason === STOP_REASONS.unsupported, `PIE fixture stopped with ${pieRun.record.reasonName}`);
assert(pieRun.record.steps === 3, `PIE fixture executed ${pieRun.record.steps} supported instructions`);
assert(pieRun.record.pc === 0x40377a54, `PIE fixture stopped at 0x${pieRun.record.pc.toString(16)}`);
assert(pieRun.record.unsupportedPc === 0x40377a54, "unsupported hook reported the wrong PC");
assert(pieRun.record.unsupportedEncoding === 0x830124, "unsupported hook reported the wrong encoding");
assert(pieRun.record.unsupportedLength === 3, "unsupported hook reported the wrong instruction length");
assert(pieRun.record.registers[4] === 1, "deterministic loop count did not enter the PIE body");
assert(pieRun.logs.length === 0, `PIE fixture emitted logs: ${JSON.stringify(pieRun.logs)}`);

const staging = extractElfFunction(
  DEFAULT_ESP32S3_OBJDUMP,
  DEFAULT_TINYDRAW_ESP32S3_STAGING_ELF,
  DEFAULT_TINYDRAW_ESP32S3_STAGING_SYMBOL
);
assert(staging.elfSha256 === "51cc322381bce60347ca322506c411af17f6b73ef366f3e440d6fdf5c1d5a8e5", "staging ELF changed");
assert(staging.objdumpSha256 === "90a91caa519b895bd457f4eb7c5fd6b14a9c64c0c7d946e78e7f332ea57d7466", "objdump changed");
assert(staging.pc === 0x420d4e10, "staging function PC changed");
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

const objdumpVersion = run([DEFAULT_ESP32S3_OBJDUMP, "--version"]);
requireSuccess(objdumpVersion);
const patchPaths = {
  runner: join(import.meta.dir, "patches/0001-add-wasi-probe.patch"),
  freestanding: join(import.meta.dir, "patches/0002-add-freestanding-shim.patch"),
  machine: join(import.meta.dir, "patches/0003-add-s3-machine-runner.patch")
};
const baseline = JSON.parse(readFileSync(join(import.meta.dir, "esp32s3-dynamic-baseline.json"), "utf8"));
const actualBaseline = {
  inputs: {
    flexeCommit: FLEXE_COMMIT,
    runnerPatchSha256: sha256(patchPaths.runner),
    freestandingPatchSha256: sha256(patchPaths.freestanding),
    machinePatchSha256: sha256(patchPaths.machine),
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
  pie: {
    symbol: pie.symbol,
    pc: `0x${pie.pc.toString(16)}`,
    codeSha256: pie.codeSha256,
    reason: pieRun.record.reasonName,
    supportedSteps: pieRun.record.steps,
    unsupportedPc: `0x${pieRun.record.unsupportedPc.toString(16)}`,
    unsupportedObjdumpEncoding: pieGap.objdumpEncoding,
    unsupportedLength: pieRun.record.unsupportedLength
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
    firstUnsupported: null
  }
};
assert(
  JSON.stringify(actualBaseline) === JSON.stringify({
    inputs: baseline.inputs,
    scalar: baseline.scalar,
    pie: baseline.pie,
    staging: baseline.staging
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
      machine: { path: patchPaths.machine, sha256: actualBaseline.inputs.machinePatchSha256 }
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
    firstUnsupported: {
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
    stop: stagingRun.record
  }
};
mkdirSync(dist, { recursive: true });
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
    firstUnsupported: null
  },
  moduleBytes: report.provenance.module.bytes,
  moduleSha256: report.provenance.module.sha256
}, null, 2));
