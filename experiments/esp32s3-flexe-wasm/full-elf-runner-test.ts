import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { DEFAULT_TINYDRAW_ESP32S3_FULL_ELF } from "./constants";
import { parseXtensaElf32, type Elf32LoadSegment, type Elf32XtensaImage } from "./elf-image";
import { FULL_ELF_STOP_REASONS, buildSparseElfPages, runSparseXtensaElf } from "./full-elf-runner";

const modulePath = resolve(
  process.env.FLEXE_WASM_DIST ?? join(import.meta.dir, "dist"),
  "flexe-probe-freestanding.wasm",
);
const moduleBytes = await Bun.file(modulePath).arrayBuffer();
const image = parseXtensaElf32(readFileSync(DEFAULT_TINYDRAW_ESP32S3_FULL_ELF));
const pages = buildSparseElfPages(image);
const pageByAddress = new Map(pages.map((page) => [page.address, page]));
const runnerMemory = {
  initialStack: 0x3fce_9700,
  inheritedZeroRanges: [{
    address: 0x3fce_7000,
    bytes: 0x3000,
    flags: 6,
    provenance: "gate-harness bootloader.map lines 4588-4592: bootloader_usable_dram_end",
  }],
} as const;

function syntheticSegment(
  index: number,
  virtualAddress: number,
  bytes: Iterable<number>,
  memoryBytes: number,
  permissions: Elf32LoadSegment["permissions"],
): Elf32LoadSegment {
  const contents = Uint8Array.from(bytes);
  return Object.freeze({
    index,
    virtualAddress,
    physicalAddress: virtualAddress,
    fileOffset: 0,
    fileBytes: contents.length,
    memoryBytes,
    alignment: 1,
    permissions: Object.freeze(permissions),
    bytes: contents,
    sha256: createHash("sha256").update(contents).digest("hex"),
  });
}

const crossPageEntry = 0x4037_0fff;
const crossPageImage: Elf32XtensaImage = Object.freeze({
  schemaVersion: 1,
  entryPoint: crossPageEntry,
  elfBytes: 3,
  elfSha256: "synthetic-cross-page-fetch",
  loadSegments: Object.freeze([
    syntheticSegment(0, crossPageEntry, [0x32], 1, { read: true, write: false, execute: true }),
    syntheticSegment(1, crossPageEntry + 1, [0xa0, 0x28], 2, { read: true, write: false, execute: true }),
    syntheticSegment(2, 0x3fce_9000, [], 0x1000, { read: true, write: true, execute: false }),
  ]),
  totalFileBytes: 3,
  totalMemoryBytes: 0x1003,
});
const crossPageRun = await runSparseXtensaElf(moduleBytes, crossPageImage, {
  initialStack: 0x3fce_a000,
  maxSteps: 1,
});
assert.equal(crossPageRun.record.reason, FULL_ELF_STOP_REASONS.maxSteps);
assert.equal(crossPageRun.record.steps, 1);
assert.equal(crossPageRun.record.pc, crossPageEntry + 3);
assert.equal(crossPageRun.record.registers[3], 40);
assert.deepEqual(crossPageRun.trace, [crossPageEntry]);

const nonExecutableTrailingImage: Elf32XtensaImage = Object.freeze({
  ...crossPageImage,
  loadSegments: Object.freeze(crossPageImage.loadSegments.map((segment) =>
    segment.index === 1
      ? Object.freeze({ ...segment, permissions: Object.freeze({ read: true, write: false, execute: false }) })
      : segment
  )),
});
const nonExecutableTrailingRun = await runSparseXtensaElf(moduleBytes, nonExecutableTrailingImage, {
  initialStack: 0x3fce_a000,
  maxSteps: 1,
});
assert.equal(nonExecutableTrailingRun.record.reason, FULL_ELF_STOP_REASONS.nonExecutablePage);
assert.equal(nonExecutableTrailingRun.record.steps, 0);
assert.equal(nonExecutableTrailingRun.record.pc, crossPageEntry);
assert.deepEqual(nonExecutableTrailingRun.trace, []);

const topBoundaryImage: Elf32XtensaImage = Object.freeze({
  schemaVersion: 1,
  entryPoint: 0xffff_ffff,
  elfBytes: 1,
  elfSha256: "synthetic-top-boundary-fetch",
  loadSegments: Object.freeze([
    syntheticSegment(0, 0xffff_ffff, [0x32], 1, { read: true, write: false, execute: true }),
    syntheticSegment(1, 0x3fce_9000, [], 0x1000, { read: true, write: true, execute: false }),
  ]),
  totalFileBytes: 1,
  totalMemoryBytes: 0x1001,
});
const topBoundaryRun = await runSparseXtensaElf(moduleBytes, topBoundaryImage, {
  initialStack: 0x3fce_a000,
  maxSteps: 1,
});
assert.equal(topBoundaryRun.record.reason, FULL_ELF_STOP_REASONS.unloadedPage);
assert.equal(topBoundaryRun.record.steps, 0);
assert.equal(topBoundaryRun.record.pc, 0xffff_ffff);
assert.deepEqual(topBoundaryRun.trace, []);

const permissionCode = {
  read8: [0x2d, 0x01, 0x22, 0xc2, 0x10, 0x32, 0x02, 0x00],
  read16: [0x2d, 0x01, 0xfb, 0x22, 0x32, 0x12, 0x00],
  read32: [0x2d, 0x01, 0xfb, 0x22, 0x38, 0x02],
  write8: [0x2d, 0x01, 0x22, 0xc2, 0x10, 0x32, 0x42, 0x00],
  write16: [0x2d, 0x01, 0xfb, 0x22, 0x32, 0x52, 0x00],
  write32: [0x2d, 0x01, 0xfb, 0x22, 0x39, 0x02],
} as const;
const unmappedCodePrefix = [0x36, 0x21, 0x00, 0x22, 0xa5, 0x00, 0xc0, 0x22, 0x01] as const;
const unmappedPermissionCode = {
  read8: [...unmappedCodePrefix, 0x32, 0x02, 0x00],
  read16: [...unmappedCodePrefix, 0x32, 0x12, 0x00],
  read32: [...unmappedCodePrefix, 0x38, 0x02],
  write8: [...unmappedCodePrefix, 0x32, 0x42, 0x00],
  write16: [...unmappedCodePrefix, 0x32, 0x52, 0x00],
  write32: [...unmappedCodePrefix, 0x39, 0x02],
} as const;
const permissionCodeBase = 0x4037_2000;
const permissionDataBase = 0x3fce_9000;
const permissionTrailingPage = permissionDataBase + 0x1000;
const permissionStack = permissionDataBase + 0x0ff0;

async function assertDataRefusal(
  code: readonly number[],
  width: 1 | 2 | 4,
  isWrite: boolean,
  boundary: "permission" | "cross-unmapped",
): Promise<void> {
  const firstBytes = new Uint8Array(4096).fill(0xa5);
  const trailingBytes = new Uint8Array(4096).fill(0x5a);
  const permissionDeniedFlags = isWrite ? 4 : 2;
  const targetAddress = width === 1 ? permissionTrailingPage : permissionDataBase + 0x0fff;
  const dataSegments = [
    syntheticSegment(1, permissionDataBase, firstBytes, firstBytes.length, {
      read: true,
      write: true,
      execute: false,
    }),
  ];
  if (boundary === "permission") {
    dataSegments.push(syntheticSegment(2, permissionTrailingPage, trailingBytes, trailingBytes.length, {
      read: isWrite,
      write: !isWrite,
      execute: false,
    }));
  }
  const totalDataBytes = dataSegments.reduce((total, segment) => total + segment.fileBytes, 0);
  const image: Elf32XtensaImage = Object.freeze({
    schemaVersion: 1,
    entryPoint: permissionCodeBase,
    elfBytes: code.length + totalDataBytes,
    elfSha256: `synthetic-${isWrite ? "write" : "read"}-${width}-${boundary}`,
    loadSegments: Object.freeze([
      syntheticSegment(0, permissionCodeBase, code, code.length, { read: true, write: false, execute: true }),
      ...dataSegments,
    ]),
    totalFileBytes: code.length + totalDataBytes,
    totalMemoryBytes: code.length + totalDataBytes,
  });
  const capturePages = boundary === "permission"
    ? [permissionDataBase, permissionTrailingPage]
    : [permissionDataBase];
  const run = await runSparseXtensaElf(moduleBytes, image, {
    initialStack: permissionStack,
    maxSteps: 3,
    capturePages,
  });
  assert.equal(
    run.record.reason,
    isWrite ? FULL_ELF_STOP_REASONS.writePermission : FULL_ELF_STOP_REASONS.readPermission,
  );
  assert.equal(run.record.steps, 2);
  assert.equal(run.record.pc, permissionCodeBase + (width === 1 ? 5 : 4));
  assert.deepEqual(run.trace, [permissionCodeBase, permissionCodeBase + 2]);
  assert.deepEqual(run.memoryFault, {
    abiVersion: 1,
    structBytes: 40,
    pc: permissionCodeBase + (width === 1 ? 5 : 4),
    address: targetAddress,
    width,
    isWrite,
    deniedAddress: permissionTrailingPage,
    deniedPage: permissionTrailingPage,
    deniedFlags: boundary === "permission" ? permissionDeniedFlags : 0,
  });
  assert.deepEqual(run.capturedPages[0]?.bytes, firstBytes, `${boundary} refusal partially changed the first page`);
  if (boundary === "permission") {
    assert.deepEqual(run.capturedPages[1]?.bytes, trailingBytes, "permission refusal changed the denied page");
  }
}

async function assertFullyUnmappedRefusal(
  code: readonly number[],
  width: 1 | 2 | 4,
  isWrite: boolean,
): Promise<void> {
  const stackBytes = new Uint8Array(4096).fill(0xa5);
  const image: Elf32XtensaImage = Object.freeze({
    schemaVersion: 1,
    entryPoint: permissionCodeBase,
    elfBytes: code.length + stackBytes.length,
    elfSha256: `synthetic-${isWrite ? "write" : "read"}-${width}-fully-unmapped`,
    loadSegments: Object.freeze([
      syntheticSegment(0, permissionCodeBase, code, code.length, { read: true, write: false, execute: true }),
      syntheticSegment(1, permissionDataBase, stackBytes, stackBytes.length, {
        read: true,
        write: true,
        execute: false,
      }),
    ]),
    totalFileBytes: code.length + stackBytes.length,
    totalMemoryBytes: code.length + stackBytes.length,
  });
  const run = await runSparseXtensaElf(moduleBytes, image, {
    initialStack: permissionStack,
    maxSteps: 4,
    capturePages: [permissionDataBase],
  });
  assert.equal(
    run.record.reason,
    isWrite ? FULL_ELF_STOP_REASONS.writePermission : FULL_ELF_STOP_REASONS.readPermission,
  );
  assert.equal(run.record.steps, 3);
  assert.equal(run.record.pc, permissionCodeBase + unmappedCodePrefix.length);
  assert.deepEqual(run.trace, [permissionCodeBase, permissionCodeBase + 3, permissionCodeBase + 6]);
  assert.deepEqual(run.memoryFault, {
    abiVersion: 1,
    structBytes: 40,
    pc: permissionCodeBase + unmappedCodePrefix.length,
    address: 0x5000_0000,
    width,
    isWrite,
    deniedAddress: 0x5000_0000,
    deniedPage: 0x5000_0000,
    deniedFlags: 0,
  });
  assert.deepEqual(run.capturedPages[0]?.bytes, stackBytes, "unmapped refusal changed loaded memory");
}

for (const boundary of ["permission", "cross-unmapped"] as const) {
  await assertDataRefusal(permissionCode.read8, 1, false, boundary);
  await assertDataRefusal(permissionCode.read16, 2, false, boundary);
  await assertDataRefusal(permissionCode.read32, 4, false, boundary);
  await assertDataRefusal(permissionCode.write8, 1, true, boundary);
  await assertDataRefusal(permissionCode.write16, 2, true, boundary);
  await assertDataRefusal(permissionCode.write32, 4, true, boundary);
}
await assertFullyUnmappedRefusal(unmappedPermissionCode.read8, 1, false);
await assertFullyUnmappedRefusal(unmappedPermissionCode.read16, 2, false);
await assertFullyUnmappedRefusal(unmappedPermissionCode.read32, 4, false);
await assertFullyUnmappedRefusal(unmappedPermissionCode.write8, 1, true);
await assertFullyUnmappedRefusal(unmappedPermissionCode.write16, 2, true);
await assertFullyUnmappedRefusal(unmappedPermissionCode.write32, 4, true);

assert.equal(image.entryPoint, 0x4037_5c9c);
assert.equal(image.elfSha256, "51cc322381bce60347ca322506c411af17f6b73ef366f3e440d6fdf5c1d5a8e5");
assert.equal(pages.length, 625);
assert.equal(pages[0]!.address, 0x3c00_0000);
assert.equal(pages.at(-1)!.address, 0x600f_f000);
assert.equal(pages.find((page) => page.address === 0x4037_5000)!.flags, 7);
assert.equal(pages.find((page) => page.address === 0x4200_0000)!.flags, 5);
assert.equal(pages.find((page) => page.address === 0x3fca_b000)!.bytes[0xe58], 0, "PT_LOAD BSS must be zero");
assert.throws(() => buildSparseElfPages(image, 624), /more than 624 sparse pages/);

const bounded = await runSparseXtensaElf(moduleBytes, image, { ...runnerMemory, maxSteps: 4 });
assert.equal(bounded.record.reason, FULL_ELF_STOP_REASONS.maxSteps);
assert.equal(bounded.record.steps, 4);
assert.equal(bounded.record.pc, 0x4037_5ca7);
assert.deepEqual(bounded.trace, [0x4037_5c9c, 0x4037_5c9f, 0x4037_5ca2, 0x4037_5ca5]);
assert.equal(bounded.loadedPages, 628);
assert.deepEqual(bounded.logs, []);
assert.deepEqual(bounded.romEvents, []);

const firstStop = await runSparseXtensaElf(moduleBytes, image, { ...runnerMemory, maxSteps: 64 });
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
  ...runnerMemory,
  maxSteps: 256,
  unsupported: [{ pc: 0x4037_5ce7, encoding: 0xf3_e780 }],
  rom: { resetReasons: [1, 1], memset: true },
});
assert.equal(romProgress.record.reason, FULL_ELF_STOP_REASONS.unsupported);
assert.equal(romProgress.record.steps, 31);
assert.equal(romProgress.record.pc, 0x4037_5ce7);
assert.equal(romProgress.record.unsupportedEncoding, 0xf3_e780);
assert.deepEqual(romProgress.romEvents, [
  { kind: "resetReason", pc: 0x4000_057c, core: 0, result: 1 },
  { kind: "resetReason", pc: 0x4000_057c, core: 1, result: 1 },
  { kind: "memset", pc: 0x4000_11e8, destination: 0x3fca_be60, value: 0, length: 0x52e0 },
  { kind: "memset", pc: 0x4000_11e8, destination: 0x5000_0000, value: 0, length: 0 },
]);

const lx7Progress = await runSparseXtensaElf(moduleBytes, image, {
  ...runnerMemory,
  maxSteps: 256,
  rom: { resetReasons: [1, 1], memset: true },
});
assert.equal(lx7Progress.record.reason, FULL_ELF_STOP_REASONS.readPermission);
assert.equal(lx7Progress.record.steps, 38);
assert.equal(lx7Progress.record.pc, 0x4037_5c44);
assert.equal(lx7Progress.record.unsupportedPc, 0);
assert(lx7Progress.trace.includes(0x4037_5ce7), "LX7 run did not execute wur.threadptr");
assert.deepEqual(lx7Progress.romEvents, romProgress.romEvents);
assert.deepEqual(lx7Progress.memoryFault, {
  abiVersion: 1,
  structBytes: 40,
  pc: 0x4037_5c44,
  address: 0x600c_4064,
  width: 4,
  isWrite: false,
  deniedAddress: 0x600c_4064,
  deniedPage: 0x600c_4000,
  deniedFlags: 0,
});

const refusedInstruction = await runSparseXtensaElf(moduleBytes, image, {
  ...runnerMemory,
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
  ...runnerMemory,
  maxSteps: 64,
  unsupported: [{ pc: image.entryPoint, encoding: 0 }],
});
assert.equal(mismatchedMarker.record.reason, FULL_ELF_STOP_REASONS.unloadedPage);
assert.equal(mismatchedMarker.record.steps, 6);

const unloadedEntry = await runSparseXtensaElf(moduleBytes, { ...image, entryPoint: 0x4000_057c }, { ...runnerMemory, maxSteps: 1 });
assert.equal(unloadedEntry.record.reason, FULL_ELF_STOP_REASONS.unloadedPage);
assert.equal(unloadedEntry.record.steps, 0);
const nonExecutableEntry = await runSparseXtensaElf(moduleBytes, { ...image, entryPoint: 0x3fc8_8000 }, { ...runnerMemory, maxSteps: 1 });
assert.equal(nonExecutableEntry.record.reason, FULL_ELF_STOP_REASONS.nonExecutablePage);
assert.equal(nonExecutableEntry.record.steps, 0);

await assert.rejects(
  runSparseXtensaElf(moduleBytes, image, { ...runnerMemory, maxSteps: 257 }),
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
    inheritedPages: 3,
    initialStack: hex(runnerMemory.initialStack),
    initialStackProvenance: runnerMemory.inheritedZeroRanges[0].provenance,
    runnerPatchSha256: createHash("sha256")
      .update(readFileSync(join(import.meta.dir, "patches/0001-add-wasi-probe.patch")))
      .digest("hex"),
    esp32s3PatchSha256: createHash("sha256")
      .update(readFileSync(join(import.meta.dir, "patches/0003-add-esp32s3-lx7-subset.patch")))
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
    unsupportedEncoding: romProgress.record.unsupportedEncoding.toString(16).padStart(6, "0"),
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
  lx7Progress: {
    reason: lx7Progress.record.reasonName,
    steps: lx7Progress.record.steps,
    pc: hex(lx7Progress.record.pc),
    traceSha256: traceSha256(lx7Progress.trace),
    stackPointer: hex(lx7Progress.record.stackPointer),
    registers: lx7Progress.record.registers.map(paddedHex),
    memoryFault: lx7Progress.memoryFault && {
      pc: hex(lx7Progress.memoryFault.pc),
      address: hex(lx7Progress.memoryFault.address),
      width: lx7Progress.memoryFault.width,
      isWrite: lx7Progress.memoryFault.isWrite,
      deniedAddress: hex(lx7Progress.memoryFault.deniedAddress),
      deniedPage: hex(lx7Progress.memoryFault.deniedPage),
      deniedFlags: lx7Progress.memoryFault.deniedFlags,
    },
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
  elfPages: pages.length,
  loadedPages: bounded.loadedPages,
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
  lx7Progress: {
    reason: lx7Progress.record.reasonName,
    steps: lx7Progress.record.steps,
    pc: `0x${lx7Progress.record.pc.toString(16)}`,
  },
}, null, 2));
