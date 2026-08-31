import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { instantiate } from "../../src/wasm";
import { parseEsp32S3Elf, type Esp32S3ElfImage } from "../../packs/esp32-s3-touch-amoled-18/timing/elf-image";
import { ESP32_S3_ROM_BOOT_STACK_TOP } from "../../packs/esp32-s3-touch-amoled-18/timing/s3-machine";

const MACHINE_RESULT_ABI_VERSION = 2;
const MACHINE_RESULT_WORDS = 17;
const MACHINE_RESULT_BYTES = MACHINE_RESULT_WORDS * 4;

const MACHINE_STOP_REASONS = {
  maxSteps: 1,
  unmappedExecute: 2,
  unsupportedMmioRead: 3,
  unsupportedMmioWrite: 4,
  unmappedRead: 5,
  unmappedWrite: 6,
  stepError: 7,
  cpuStopped: 8,
  invalidArgument: 9,
  pageCapacity: 10,
  unsupportedRomCall: 11,
} as const;

interface MachineExports {
  memory: WebAssembly.Memory;
  flexe_wasm_machine_input(): number;
  flexe_wasm_machine_input_capacity(): number;
  flexe_wasm_machine_reset(): number;
  flexe_wasm_machine_map(address: number, length: number): number;
  flexe_wasm_machine_load(address: number, length: number): number;
  flexe_wasm_machine_begin(entry: number, stackPointer: number): number;
  flexe_wasm_machine_run(maxSteps: number): number;
}

export interface Esp32S3MachineStop {
  readonly abiVersion: number;
  readonly structBytes: number;
  readonly reason: number;
  readonly reasonName: keyof typeof MACHINE_STOP_REASONS;
  readonly steps: number;
  readonly pc: number;
  readonly faultAddress: number;
  readonly accessWidth: number;
  readonly writeValue: number;
  readonly vecbase: number;
  readonly ps: number;
  readonly intenable: number;
  readonly interrupt: number;
  readonly exccause: number;
  readonly excvaddr: number;
  readonly stackPointer: number;
  readonly romResetReasonCalls: number;
  readonly resetReason: number;
}

export interface Esp32S3ElfMachineRun {
  readonly schemaVersion: 1;
  readonly elfSha256: string;
  readonly entry: number;
  readonly loadSegments: number;
  readonly mappedBytes: number;
  readonly loadedBytes: number;
  readonly stop: Esp32S3MachineStop;
  readonly logs: readonly string[];
  readonly claim: Readonly<{
    architectureCalibration: "uncalibrated";
    cycleAccurate: false;
    executionCore: "pinned-flexe-lx6";
    targetGap: "ESP32-S3-LX7";
    rom: "esp-rom-reset-reason-api-only";
    mmuMappings: "caller-supplied-ELF-pages-only";
  }>;
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function reasonName(value: number): keyof typeof MACHINE_STOP_REASONS {
  const found = Object.entries(MACHINE_STOP_REASONS).find(([, reason]) => reason === value);
  if (!found) throw new Error(`unknown machine stop reason ${value}`);
  return found[0] as keyof typeof MACHINE_STOP_REASONS;
}

function decodeStop(memory: WebAssembly.Memory, pointerValue: number): Esp32S3MachineStop {
  const pointer = pointerValue >>> 0;
  assert(pointer + MACHINE_RESULT_BYTES <= memory.buffer.byteLength, "machine stop record is outside wasm memory");
  const words = new Uint32Array(memory.buffer, pointer, MACHINE_RESULT_WORDS);
  assert(words[0] === MACHINE_RESULT_ABI_VERSION, `unexpected machine result ABI ${words[0]}`);
  assert(words[1] === MACHINE_RESULT_BYTES, `unexpected machine result size ${words[1]}`);
  return Object.freeze({
    abiVersion: words[0],
    structBytes: words[1],
    reason: words[2],
    reasonName: reasonName(words[2]),
    steps: words[3],
    pc: words[4],
    faultAddress: words[5],
    accessWidth: words[6],
    writeValue: words[7],
    vecbase: words[8],
    ps: words[9],
    intenable: words[10],
    interrupt: words[11],
    exccause: words[12],
    excvaddr: words[13],
    stackPointer: words[14],
    romResetReasonCalls: words[15],
    resetReason: words[16],
  });
}

function exportsOf(instance: WebAssembly.Instance["exports"]): MachineExports {
  const candidate = instance as unknown as Partial<MachineExports>;
  for (const name of [
    "flexe_wasm_machine_input",
    "flexe_wasm_machine_input_capacity",
    "flexe_wasm_machine_reset",
    "flexe_wasm_machine_map",
    "flexe_wasm_machine_load",
    "flexe_wasm_machine_begin",
    "flexe_wasm_machine_run",
  ] as const) {
    assert(typeof candidate[name] === "function", `${name} export is missing`);
  }
  assert(candidate.memory instanceof WebAssembly.Memory, "machine memory export is missing");
  return candidate as MachineExports;
}

function mapAndLoad(
  exports: MachineExports,
  image: Esp32S3ElfImage,
): { mappedBytes: number; loadedBytes: number } {
  const inputPointer = exports.flexe_wasm_machine_input() >>> 0;
  const inputCapacity = exports.flexe_wasm_machine_input_capacity() >>> 0;
  assert(inputCapacity > 0, "machine input capacity is zero");
  assert(inputPointer + inputCapacity <= exports.memory.buffer.byteLength, "machine input is outside wasm memory");

  let mappedBytes = 0;
  let loadedBytes = 0;
  for (const segment of image.loadSegments) {
    if (segment.memoryBytes === 0) continue;
    assert(
      exports.flexe_wasm_machine_map(segment.virtualAddress, segment.memoryBytes) === 1,
      `machine refused ELF segment ${segment.index} mapping`,
    );
    mappedBytes += segment.memoryBytes;
    for (let offset = 0; offset < segment.fileBytes; offset += inputCapacity) {
      const chunk = segment.data.subarray(offset, Math.min(offset + inputCapacity, segment.fileBytes));
      new Uint8Array(exports.memory.buffer, inputPointer, chunk.length).set(chunk);
      assert(
        exports.flexe_wasm_machine_load(segment.virtualAddress + offset, chunk.length) === 1,
        `machine refused ELF segment ${segment.index} load at offset ${offset}`,
      );
      loadedBytes += chunk.length;
    }
  }

  const stackPage = (ESP32_S3_ROM_BOOT_STACK_TOP - 1) & ~0xfff;
  assert(exports.flexe_wasm_machine_map(stackPage, 0x1000) === 1, "machine refused the sourced ROM boot stack page");
  mappedBytes += 0x1000;
  return { mappedBytes, loadedBytes };
}

/** Load a complete real ELF image and run its entry until a bounded stop. */
export async function runEsp32S3ElfMachine(
  moduleBytes: ArrayBuffer,
  elfBytes: Uint8Array,
  maxSteps = 1_000,
): Promise<Esp32S3ElfMachineRun> {
  assert(Number.isSafeInteger(maxSteps) && maxSteps > 0, "maxSteps must be a positive safe integer");
  const image = parseEsp32S3Elf(elfBytes);
  const logs: string[] = [];
  const instance = await instantiate(moduleBytes, (text) => logs.push(text));
  const exports = exportsOf(instance);
  decodeStop(exports.memory, exports.flexe_wasm_machine_reset());
  const loaded = mapAndLoad(exports, image);
  const begin = decodeStop(
    exports.memory,
    exports.flexe_wasm_machine_begin(image.entry, ESP32_S3_ROM_BOOT_STACK_TOP),
  );
  assert(begin.reasonName === "maxSteps", `machine refused ELF entry with ${begin.reasonName}`);
  const stop = decodeStop(exports.memory, exports.flexe_wasm_machine_run(maxSteps));
  return Object.freeze({
    schemaVersion: 1,
    elfSha256: createHash("sha256").update(elfBytes).digest("hex"),
    entry: image.entry,
    loadSegments: image.loadSegments.length,
    mappedBytes: loaded.mappedBytes,
    loadedBytes: loaded.loadedBytes,
    stop,
    logs: Object.freeze(logs),
    claim: Object.freeze({
      architectureCalibration: "uncalibrated",
      cycleAccurate: false,
      executionCore: "pinned-flexe-lx6",
      targetGap: "ESP32-S3-LX7",
      rom: "esp-rom-reset-reason-api-only",
      mmuMappings: "caller-supplied-ELF-pages-only",
    }),
  });
}

if (import.meta.main) {
  const [modulePathValue, elfPathValue, maxStepsValue] = process.argv.slice(2);
  if (!modulePathValue || !elfPathValue) {
    throw new Error("usage: bun run machine-runner.ts <flexe-probe-freestanding.wasm> <esp32s3.elf> [max-steps]");
  }
  const modulePath = resolve(modulePathValue);
  const elfPath = resolve(elfPathValue);
  const maxSteps = maxStepsValue === undefined ? 1_000 : Number(maxStepsValue);
  const result = await runEsp32S3ElfMachine(
    await Bun.file(modulePath).arrayBuffer(),
    new Uint8Array(await Bun.file(elfPath).arrayBuffer()),
    maxSteps,
  );
  console.log(JSON.stringify(result, null, 2));
}
