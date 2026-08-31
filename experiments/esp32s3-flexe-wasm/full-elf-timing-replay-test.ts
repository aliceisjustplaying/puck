import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { AddressMapConfiguration, AddressRegion } from "../../packs/esp32-s3-touch-amoled-18/timing/address-map";
import {
  ESP32_S3_CACHE_BANK_TOPOLOGY,
  type CacheConfiguration,
  type CacheLatency,
} from "../../packs/esp32-s3-touch-amoled-18/timing/cache";
import {
  parseTimingProfile,
  type CacheLineFillProfileCost,
} from "../../packs/esp32-s3-touch-amoled-18/timing/consumer";
import { runRuntimeTimingTrace } from "../../packs/esp32-s3-touch-amoled-18/timing/runtime-trace";
import { DEFAULT_TINYDRAW_ESP32S3_FULL_ELF } from "./constants";
import { parseXtensaElf32 } from "./elf-image";
import { buildSparseElfPages, runSparseXtensaElf, type SparseElfPage } from "./full-elf-runner";
import { sha256 } from "./lib";
import { TRACE_KINDS, type DecodedTrace } from "./trace-abi";
import { adaptFlexeTraceToRuntimeTiming } from "./trace-timing-adapter";

const FULL_TRACE_RECORD_SHA256 = "e278adc72c086dc8e132a15fcd48ed180b995f36ae1897fa5ff6047af73a3d55";
const CACHE_MMIO_PAGE = 0x600c_4000;
const PAGE_BYTES = 4096;
const EXPECTED_SRAM_PAGES = Object.freeze([
  0x3fca_b000,
  0x3fce_9000,
  0x4037_4000,
  0x4037_5000,
  0x4037_7000,
  0x4038_0000,
  0x4038_2000,
]);
const EXPECTED_FLASH_PAGES = Object.freeze([0x4200_0000, 0x4200_3000]);

function unknownCost(component: string, source: string): CacheLatency {
  return Object.freeze({
    status: "unknown",
    reason: `${component} has no adopted cycle cost in the ESP32-S3 timing profile`,
    source,
  });
}

function calibratedCost(cycles: number, component: string, source: string): CacheLatency {
  return Object.freeze({
    status: "known",
    cycles: BigInt(cycles),
    calibration: "calibrated",
    source: `${source}; ${component}`,
  });
}

function calibratedLineFill(
  cost: CacheLineFillProfileCost,
  source: string,
): Readonly<{
  firstLineLatency: CacheLatency;
  subsequentLineServiceInterval: CacheLatency;
}> {
  return Object.freeze({
    firstLineLatency: calibratedCost(cost.firstLineCycles, "first line", source),
    subsequentLineServiceInterval: calibratedCost(
      cost.subsequentLineCycles,
      "contiguous subsequent line",
      source,
    ),
  });
}

function traceRecordSha256(trace: DecodedTrace): string {
  const bytes = new Uint8Array(trace.records.length * 24);
  const view = new DataView(bytes.buffer);
  trace.records.forEach((record, index) => {
    const offset = index * 24;
    view.setUint32(offset, record.kind, true);
    view.setUint32(offset + 4, record.pc, true);
    view.setUint32(offset + 8, record.address, true);
    view.setUint32(offset + 12, record.value, true);
    view.setUint32(offset + 16, record.width, true);
    view.setUint32(offset + 20, record.instruction, true);
  });
  return createHash("sha256").update(bytes).digest("hex");
}

function pageFlags(page: SparseElfPage): AddressRegion["permissions"] {
  return Object.freeze({
    read: (page.flags & 4) !== 0,
    write: (page.flags & 2) !== 0,
    execute: (page.flags & 1) !== 0,
  });
}

function observedPages(trace: DecodedTrace): readonly number[] {
  const pages = new Set<number>();
  for (const record of trace.records) {
    const address = record.kind === TRACE_KINDS.instruction ? record.pc : record.address;
    const lastAddress = address + record.width - 1;
    pages.add(Math.floor(address / PAGE_BYTES) * PAGE_BYTES);
    pages.add(Math.floor(lastAddress / PAGE_BYTES) * PAGE_BYTES);
  }
  return Object.freeze([...pages].sort((left, right) => left - right));
}

const here = import.meta.dir;
const modulePath = join(here, "dist/flexe-probe-freestanding.wasm");
const baselinePath = join(here, "esp32s3-full-elf-timing-replay-baseline.json");
const timingProfilePath = join(here, "../../packs/esp32-s3-touch-amoled-18/timing.json");
const timingMachinePath = join(here, "../../packs/esp32-s3-touch-amoled-18/timing/machine.ts");
const neutralAdapterPath = join(here, "../../packs/esp32-s3-touch-amoled-18/timing/trace-adapter.ts");
const adapterPath = join(here, "trace-timing-adapter.ts");
const loadUseClassifierPath = join(here, "flexe-load-use.ts");
const moduleBytes = await Bun.file(modulePath).arrayBuffer();
const image = parseXtensaElf32(readFileSync(DEFAULT_TINYDRAW_ESP32S3_FULL_ELF));
const run = await runSparseXtensaElf(moduleBytes, image, {
  initialStack: 0x3fce_9700,
  inheritedZeroRanges: [{
    address: 0x3fce_7000,
    bytes: 0x3000,
    flags: 6,
    provenance: "gate-harness bootloader.map lines 4588-4592: bootloader_usable_dram_end",
  }],
  maxSteps: 256,
  rom: { resetReasons: [1, 1], memset: true, cacheBootstrap: true },
});

assert.equal(run.record.steps, 238);
assert.equal(run.record.pc, 0x4037_71a5);
assert.equal(run.memoryTrace.count, 325);
assert.equal(traceRecordSha256(run.memoryTrace), FULL_TRACE_RECORD_SHA256);
assert.equal(run.memoryTrace.records.filter((record) => record.kind === TRACE_KINDS.instruction).length, 238);
assert.equal(run.memoryTrace.records.filter((record) => record.kind === TRACE_KINDS.read).length, 63);
assert.equal(run.memoryTrace.records.filter((record) => record.kind === TRACE_KINDS.write).length, 24);

const sparsePages = buildSparseElfPages(image);
const sparsePageByAddress = new Map(sparsePages.map((page) => [page.address, page]));
const inheritedPageByAddress = new Map([0x3fce_7000, 0x3fce_8000, 0x3fce_9000].map((address) => [
  address,
  Object.freeze({ address, flags: 6, bytes: new Uint8Array(PAGE_BYTES) }),
]));
const tracePages = observedPages(run.memoryTrace);
assert.deepEqual(
  tracePages,
  [...EXPECTED_SRAM_PAGES, ...EXPECTED_FLASH_PAGES, CACHE_MMIO_PAGE].sort((left, right) => left - right),
);

const addressRegions: AddressRegion[] = tracePages.map((address) => {
  if (address === CACHE_MMIO_PAGE) {
    return Object.freeze({
      id: "full-elf:cache-controller-mmio",
      base: BigInt(address),
      size: BigInt(PAGE_BYTES),
      kind: "mmio",
      permissions: Object.freeze({ read: true, write: true, execute: false }),
      cacheability: "uncached",
      physical: Object.freeze({ backingId: "esp32-s3-cache-controller", offset: 0n }),
      peripheral: "cache-controller",
    });
  }
  const page = sparsePageByAddress.get(address) ?? inheritedPageByAddress.get(address);
  assert(page !== undefined, `observed page 0x${address.toString(16)} was not loaded by the full ELF runner`);
  if (EXPECTED_FLASH_PAGES.includes(address)) {
    return Object.freeze({
      id: `full-elf:flash-page:${address.toString(16)}`,
      base: BigInt(address),
      size: BigInt(PAGE_BYTES),
      kind: "flash",
      permissions: pageFlags(page),
      cacheability: "cached",
      physical: Object.freeze({
        backingId: "full-elf:irom-flash",
        offset: BigInt(address - EXPECTED_FLASH_PAGES[0]!),
      }),
    });
  }
  assert(EXPECTED_SRAM_PAGES.includes(address), `observed page 0x${address.toString(16)} lacks an SRAM classification`);
  return Object.freeze({
    id: `full-elf:sram-page:${address.toString(16)}`,
    base: BigInt(address),
    size: BigInt(PAGE_BYTES),
    kind: "sram",
    permissions: pageFlags(page),
    cacheability: "uncached",
    physical: Object.freeze({ backingId: `full-elf-loaded-page:${address.toString(16)}`, offset: 0n }),
  });
});
const addressMap: AddressMapConfiguration = Object.freeze({
  addressBits: 32,
  metadata: Object.freeze({
    architectureCalibration: "uncalibrated",
    source: "full ELF trace observed pages, PT_LOAD permissions, inherited stack range, and explicit cache-controller ROM model",
  }),
  regions: Object.freeze(addressRegions),
});

const timingProfile = parseTimingProfile(JSON.parse(readFileSync(timingProfilePath, "utf8")));
const costSource = `timing profile ${timingProfilePath} SHA-256 ${sha256(timingProfilePath)}`;
const coreCostSource = `${costSource}; evidence ${timingProfile.coreSteadyStateCycles.evidence}`;
const cacheLineFillSource = `${costSource}; evidence ${timingProfile.cacheLineFillCycles.evidence}`;
const unknown = unknownCost("unused cache path", costSource);
const cache: CacheConfiguration = Object.freeze({
  addressBits: 32,
  metadata: Object.freeze({
    architectureCalibration: "uncalibrated",
    source: "observed direct-app cache geometry with calibrated flash line-fill costs",
  }),
  topology: ESP32_S3_CACHE_BANK_TOPOLOGY,
  instruction: Object.freeze({
    lineSizeBytes: 32,
    sets: 64,
    ways: 8,
    replacement: "least-recently-used",
    writePolicy: "read-only",
  }),
  data: Object.freeze({
    lineSizeBytes: 64,
    sets: 64,
    ways: 8,
    replacement: "least-recently-used",
    writePolicy: "write-back",
    allocateOnStoreMiss: true,
    dirtyInvalidate: "writeback",
  }),
  costs: Object.freeze({
    hit: Object.freeze({ instructionFetch: unknown, load: unknown, store: unknown }),
    lineFill: Object.freeze({
      instruction: Object.freeze({
        flash: calibratedLineFill(
          timingProfile.cacheLineFillCycles.instruction.flash,
          `${cacheLineFillSource}; instruction flash`,
        ),
        psram: unknown,
      }),
      data: Object.freeze({
        flash: calibratedLineFill(
          timingProfile.cacheLineFillCycles.data.flash,
          `${cacheLineFillSource}; data flash`,
        ),
        psram: calibratedLineFill(
          timingProfile.cacheLineFillCycles.data.psram,
          `${cacheLineFillSource}; data PSRAM`,
        ),
      }),
    }),
    dirtyWriteback: unknown,
    writeThrough: unknown,
    uncached: Object.freeze({ instructionFetch: unknown, load: unknown, store: unknown }),
    sram: Object.freeze({
      instructionFetch: unknownCost("internal SRAM instruction fetch", costSource),
      load: calibratedCost(
        timingProfile.coreSteadyStateCycles.independentSramAccessAdditiveCycles.load,
        "independent SRAM load additive cost",
        coreCostSource,
      ),
      store: calibratedCost(
        timingProfile.coreSteadyStateCycles.independentSramAccessAdditiveCycles.store,
        "independent SRAM store additive cost",
        coreCostSource,
      ),
    }),
    maintenance: unknown,
  }),
});
const runtimeTrace = adaptFlexeTraceToRuntimeTiming(run.memoryTrace, {
  source: "full ELF runner committed execution trace",
  sha256: FULL_TRACE_RECORD_SHA256,
  core: 0,
}, {
  instructionCpuCost: calibratedCost(
    timingProfile.coreSteadyStateCycles.instructionIssueCycles,
    "steady-state instruction issue",
    coreCostSource,
  ),
  dependentSramLoadUseHazard: {
    internalSramRanges: Object.freeze(EXPECTED_SRAM_PAGES.map((base) => Object.freeze({
      base,
      sizeBytes: PAGE_BYTES,
    }))),
    latency: calibratedCost(
      timingProfile.coreSteadyStateCycles.dependentLoadUseHazard.observedAdditionalCycles,
      "exact dependent internal SRAM load-use",
      coreCostSource,
    ),
  },
});
const machine = runRuntimeTimingTrace({
  addressMap,
  cache,
  mmioCost: () => unknownCost("cache-controller MMIO access", costSource),
}, runtimeTrace);

assert.equal(machine.status, "blocked");
assert.equal(machine.cores[0].status, "complete");
assert.equal(machine.cores[0].accesses.length, 325);
assert(machine.cores[0].accesses.every((access) => access.status === "resolved"));
assert.equal(machine.cores[1].accesses.length, 0);
assert.equal(runtimeTrace.input.cpu?.length, 262);
assert.equal(machine.issuedEvents.filter((event) => event.origin.kind === "cache").length, 301);
assert.equal(machine.issuedEvents.filter((event) => event.origin.kind === "mmio").length, 27);
const cpuEvents = machine.issuedEvents.filter((event) => event.origin.kind === "cpu");
const loadUseHazards = cpuEvents.filter((event) => event.event.id.endsWith(":pre-data-cpu"));
const instructionCpuEvents = cpuEvents.filter((event) => event.event.id.endsWith(":cpu"));
assert.equal(cpuEvents.length, 262);
assert.equal(loadUseHazards.length, 24);
assert.equal(instructionCpuEvents.length, 238);
assert.equal(machine.issuedEvents.length, 590);
assert.equal(machine.claim.unknownCostEventIds.length, 305);
assert.equal(machine.issuedEvents.filter((event) => event.cost.status === "known").length, 285);
assert(cpuEvents.every((event) =>
  event.cost.status === "known" && event.cost.cycles === 1n && event.cost.calibration === "calibrated"
));
assert(loadUseHazards.every((event) =>
  event.cost.status === "known" && event.cost.source.includes("dependent internal SRAM load-use a")
));
assert.equal(machine.issuedEvents.filter((event) =>
  event.origin.kind === "cache" && event.event.kind === "instruction-fetch" && event.cost.status === "unknown"
).length, 238);
assert.equal(machine.issuedEvents.filter((event) =>
  event.origin.kind === "cache" && event.event.kind === "literal-load" && event.cost.status === "unknown"
).length, 40);
assert.equal(machine.issuedEvents.filter((event) =>
  event.origin.kind === "mmio" && event.cost.status === "unknown"
).length, 27);
assert(machine.issuedEvents.filter((event) =>
  event.origin.kind === "cache" && event.origin.regionId.startsWith("full-elf:sram-page:") &&
  (event.event.kind === "load" || event.event.kind === "store")
).every((event) => event.cost.status === "known" && event.cost.cycles === 0n));
const flashLineFills = machine.issuedEvents.filter((event) =>
  event.origin.kind === "cache" && event.origin.regionId.startsWith("full-elf:flash-page:") &&
  event.event.id.endsWith(":line-fill")
);
const flashHits = machine.issuedEvents.filter((event) =>
  event.origin.kind === "cache" && event.origin.regionId.startsWith("full-elf:flash-page:") &&
  event.event.id.endsWith(":hit")
);
assert.equal(flashLineFills.length, 3);
assert(flashLineFills.every((event) => event.cost.status === "known" && event.cost.cycles === 204n));
assert.equal(flashHits.length, 6);
assert(flashHits.every((event) => event.cost.status === "unknown"));

const issuedProjection = machine.issuedEvents.map((issued) => ({
  issueIndex: issued.issueIndex,
  eventId: issued.event.id,
  eventKind: issued.event.kind,
  originKind: issued.origin.kind,
  cost: issued.cost.status === "known"
    ? { status: issued.cost.status, cycles: issued.cost.cycles.toString(), calibration: issued.cost.calibration }
    : { status: issued.cost.status, reason: issued.cost.reason },
}));
const loadUseEvidenceProjection = loadUseHazards.map((issued) => ({
  issueIndex: issued.issueIndex,
  eventId: issued.event.id,
  instructionAccessId: issued.origin.kind === "cpu" ? issued.origin.instructionAccessId : null,
  evidence: issued.cost.status === "known"
    ? issued.cost.source.slice(issued.cost.source.lastIndexOf("dependent internal SRAM load-use"))
    : null,
}));
const actualBaseline = {
  schemaVersion: 1,
  inputs: {
    elfSha256: image.elfSha256,
    moduleSha256: createHash("sha256").update(new Uint8Array(moduleBytes)).digest("hex"),
    traceRecordSha256: FULL_TRACE_RECORD_SHA256,
    timingProfileSha256: sha256(timingProfilePath),
    timingMachineSha256: sha256(timingMachinePath),
    neutralAdapterSha256: sha256(neutralAdapterPath),
    adapterSha256: sha256(adapterPath),
    loadUseClassifierSha256: sha256(loadUseClassifierPath),
  },
  trace: {
    records: run.memoryTrace.count,
    instructions: 238,
    reads: 63,
    writes: 24,
    observedSramPages: EXPECTED_SRAM_PAGES.map((address) => `0x${address.toString(16)}`),
    observedFlashPages: EXPECTED_FLASH_PAGES.map((address) => `0x${address.toString(16)}`),
    observedMmioPages: [`0x${CACHE_MMIO_PAGE.toString(16)}`],
  },
  replay: {
    status: machine.status,
    totalCycles: null,
    issuedEvents: machine.issuedEvents.length,
    memoryEvents: machine.issuedEvents.filter((event) => event.origin.kind === "cache").length,
    mmioEvents: machine.issuedEvents.filter((event) => event.origin.kind === "mmio").length,
    cpuEvents: cpuEvents.length,
    dependentSramLoadUseHazards: loadUseHazards.length,
    knownCostEvents: machine.issuedEvents.filter((event) => event.cost.status === "known").length,
    unknownCostEvents: machine.claim.unknownCostEventIds.length,
    issuedProjectionSha256: createHash("sha256").update(JSON.stringify(issuedProjection)).digest("hex"),
    loadUseEvidenceSha256: createHash("sha256")
      .update(JSON.stringify(loadUseEvidenceProjection))
      .digest("hex"),
  },
};
const baseline = JSON.parse(readFileSync(baselinePath, "utf8"));
assert.deepEqual(actualBaseline, baseline, "tracked full ELF timing replay baseline changed");

console.log(JSON.stringify(actualBaseline, null, 2));
