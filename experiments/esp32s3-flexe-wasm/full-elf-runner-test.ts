import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { DEFAULT_TINYDRAW_ESP32S3_STAGING_ELF } from "./constants";
import { parseXtensaElf32 } from "./elf-image";
import { FULL_ELF_STOP_REASONS, buildSparseElfPages, runSparseXtensaElf } from "./full-elf-runner";

const modulePath = resolve(
  process.env.FLEXE_WASM_DIST ?? join(import.meta.dir, "dist"),
  "flexe-probe-freestanding.wasm",
);
const moduleBytes = await Bun.file(modulePath).arrayBuffer();
const image = parseXtensaElf32(readFileSync(DEFAULT_TINYDRAW_ESP32S3_STAGING_ELF));
const pages = buildSparseElfPages(image);
const pageByAddress = new Map(pages.map((page) => [page.address, page]));

assert.equal(image.entryPoint, 0x4037_5c9c);
assert.equal(image.elfSha256, "51cc322381bce60347ca322506c411af17f6b73ef366f3e440d6fdf5c1d5a8e5");
assert.equal(pages.length, 625);
assert.equal(pages[0]!.address, 0x3c00_0000);
assert.equal(pages.at(-1)!.address, 0x600f_f000);
assert.equal(pages.find((page) => page.address === 0x4037_5000)!.flags, 7);
assert.equal(pages.find((page) => page.address === 0x4200_0000)!.flags, 5);
assert.equal(pages.find((page) => page.address === 0x3fca_b000)!.bytes[0xe58], 0, "PT_LOAD BSS must be zero");
assert.throws(() => buildSparseElfPages(image, 624), /more than 624 sparse pages/);

const bounded = await runSparseXtensaElf(moduleBytes, image, { maxSteps: 4 });
assert.equal(bounded.record.reason, FULL_ELF_STOP_REASONS.maxSteps);
assert.equal(bounded.record.steps, 4);
assert.equal(bounded.record.pc, 0x4037_5ca7);
assert.deepEqual(bounded.trace, [0x4037_5c9c, 0x4037_5c9f, 0x4037_5ca2, 0x4037_5ca5]);
assert.equal(bounded.loadedPages, 625);
assert.deepEqual(bounded.logs, []);
assert.deepEqual(bounded.romEvents, []);

const firstStop = await runSparseXtensaElf(moduleBytes, image, { maxSteps: 64 });
assert.equal(firstStop.record.reason, FULL_ELF_STOP_REASONS.unloadedPage);
assert.equal(firstStop.record.steps, 6);
assert.equal(firstStop.record.pc, 0x4000_057c);
assert.deepEqual(firstStop.trace, [
  0x4037_5c9c,
  0x4037_5c9f,
  0x4037_5ca2,
  0x4037_5ca5,
  0x4037_5ca7,
  0x4037_5caa,
]);
assert.deepEqual(firstStop.logs, []);
assert.deepEqual(firstStop.romEvents, []);

const romProgress = await runSparseXtensaElf(moduleBytes, image, {
  maxSteps: 256,
  rom: { resetReasons: [1, 1], memset: true },
});
assert.equal(romProgress.record.reason, FULL_ELF_STOP_REASONS.unloadedPage);
assert.equal(romProgress.record.steps, 57);
assert.equal(romProgress.record.pc, 0x4000_186c);
assert.deepEqual(romProgress.romEvents, [
  { kind: "resetReason", pc: 0x4000_057c, core: 0, result: 1 },
  { kind: "resetReason", pc: 0x4000_057c, core: 1, result: 1 },
  { kind: "memset", pc: 0x4000_11e8, destination: 0x3fca_be60, value: 0, length: 0x52e0 },
  { kind: "memset", pc: 0x4000_11e8, destination: 0x5000_0000, value: 0, length: 0 },
]);

const refusedInstruction = await runSparseXtensaElf(moduleBytes, image, {
  maxSteps: 64,
  unsupported: [{ pc: image.entryPoint, encoding: 0x00_8136 }],
});
assert.equal(refusedInstruction.record.reason, FULL_ELF_STOP_REASONS.unsupported);
assert.equal(refusedInstruction.record.steps, 0);
assert.equal(refusedInstruction.record.pc, image.entryPoint);
assert.equal(refusedInstruction.record.unsupportedPc, image.entryPoint);
assert.equal(refusedInstruction.record.unsupportedEncoding, 0x00_8136);
assert.equal(refusedInstruction.record.unsupportedLength, 3);
assert.deepEqual(refusedInstruction.trace, []);
const mismatchedMarker = await runSparseXtensaElf(moduleBytes, image, {
  maxSteps: 64,
  unsupported: [{ pc: image.entryPoint, encoding: 0 }],
});
assert.equal(mismatchedMarker.record.reason, FULL_ELF_STOP_REASONS.unloadedPage);
assert.equal(mismatchedMarker.record.steps, 6);

const unloadedEntry = await runSparseXtensaElf(moduleBytes, { ...image, entryPoint: 0x4000_057c }, { maxSteps: 1 });
assert.equal(unloadedEntry.record.reason, FULL_ELF_STOP_REASONS.unloadedPage);
assert.equal(unloadedEntry.record.steps, 0);
const nonExecutableEntry = await runSparseXtensaElf(moduleBytes, { ...image, entryPoint: 0x3fc8_8000 }, { maxSteps: 1 });
assert.equal(nonExecutableEntry.record.reason, FULL_ELF_STOP_REASONS.nonExecutablePage);
assert.equal(nonExecutableEntry.record.steps, 0);

await assert.rejects(
  runSparseXtensaElf(moduleBytes, image, { maxSteps: 257 }),
  /exceeds trace capacity 256/,
);

const hex = (value: number): string => `0x${value.toString(16)}`;
const paddedHex = (value: number): string => `0x${value.toString(16).padStart(8, "0")}`;
const traceSha256 = (trace: readonly number[]): string => {
  const bytes = new Uint8Array(trace.length * 4);
  const view = new DataView(bytes.buffer);
  trace.forEach((pc, index) => view.setUint32(index * 4, pc, true));
  return createHash("sha256").update(bytes).digest("hex");
};
const instructionAt = (pc: number): { pc: string; encoding: string } => {
  const pageAddress = Math.floor(pc / 4096) * 4096;
  const offset = pc - pageAddress;
  const bytes = pageByAddress.get(pageAddress)!.bytes;
  const length = (bytes[offset]! & 8) !== 0 ? 2 : 3;
  let encoding = 0;
  for (let index = 0; index < length; index++) encoding |= bytes[offset + index]! << (index * 8);
  return { pc: hex(pc), encoding: encoding.toString(16).padStart(length * 2, "0") };
};
const baseline = JSON.parse(readFileSync(join(import.meta.dir, "esp32s3-full-elf-baseline.json"), "utf8"));
const actualBaseline = {
  schemaVersion: 1,
  inputs: {
    elfBytes: image.elfBytes,
    elfSha256: image.elfSha256,
    entryPoint: hex(image.entryPoint),
    loadSegments: image.loadSegments.length,
    sparsePages: pages.length,
    runnerPatchSha256: createHash("sha256")
      .update(readFileSync(join(import.meta.dir, "patches/0001-add-wasi-probe.patch")))
      .digest("hex"),
    moduleBytes: statSync(modulePath).size,
    moduleSha256: createHash("sha256").update(new Uint8Array(moduleBytes)).digest("hex"),
  },
  bounded: {
    reason: bounded.record.reasonName,
    steps: bounded.record.steps,
    pc: hex(bounded.record.pc),
    trace: bounded.trace.map(hex),
  },
  firstStop: {
    reason: firstStop.record.reasonName,
    steps: firstStop.record.steps,
    pc: hex(firstStop.record.pc),
    instructions: firstStop.trace.map(instructionAt),
    stackPointer: hex(firstStop.record.stackPointer),
    registers: firstStop.record.registers.map(paddedHex),
  },
  romProgress: {
    resetReasons: [1, 1],
    reason: romProgress.record.reasonName,
    steps: romProgress.record.steps,
    pc: hex(romProgress.record.pc),
    traceSha256: traceSha256(romProgress.trace),
    stackPointer: hex(romProgress.record.stackPointer),
    registers: romProgress.record.registers.map(paddedHex),
    events: romProgress.romEvents.map((event) => event.kind === "resetReason"
      ? { kind: event.kind, pc: hex(event.pc), core: event.core, result: event.result }
      : {
          kind: event.kind,
          pc: hex(event.pc),
          destination: hex(event.destination),
          value: event.value,
          length: event.length,
        }),
  },
  unsupportedRefusal: {
    reason: refusedInstruction.record.reasonName,
    steps: refusedInstruction.record.steps,
    pc: hex(refusedInstruction.record.pc),
    encoding: `0x${refusedInstruction.record.unsupportedEncoding.toString(16).padStart(6, "0")}`,
    length: refusedInstruction.record.unsupportedLength,
  },
};
assert.deepEqual(actualBaseline, baseline, "tracked full ELF execution baseline changed");

console.log(JSON.stringify({
  elfSha256: image.elfSha256,
  entryPoint: `0x${image.entryPoint.toString(16)}`,
  loadedPages: pages.length,
  bounded: {
    reason: bounded.record.reasonName,
    steps: bounded.record.steps,
    pc: `0x${bounded.record.pc.toString(16)}`,
  },
  firstStop: {
    reason: firstStop.record.reasonName,
    steps: firstStop.record.steps,
    pc: `0x${firstStop.record.pc.toString(16)}`,
  },
  romProgress: {
    reason: romProgress.record.reasonName,
    steps: romProgress.record.steps,
    pc: `0x${romProgress.record.pc.toString(16)}`,
    events: romProgress.romEvents.length,
  },
}, null, 2));
