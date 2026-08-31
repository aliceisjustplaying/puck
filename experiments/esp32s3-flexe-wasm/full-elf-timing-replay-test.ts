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

const FULL_TRACE_RECORD_SHA256 = "2866191c22b56eb319a7f37e915cf9c4c22389ee36f8bac600fb30cd026ee98c";
const RTC_MMIO_PAGE = 0x6000_8000;
const REGI2C_MMIO_PAGE = 0x6000_e000;
const SYSTEM_MMIO_PAGE = 0x600c_0000;
const CACHE_MMIO_PAGE = 0x600c_4000;
const PAGE_BYTES = 4096;
const EXPECTED_SRAM_PAGES = Object.freeze([
  0x3fca_b000,
  0x3fca_c000,
  0x3fce_9000,
  0x4037_4000,
  0x4037_5000,
  0x4037_7000,
  0x4037_e000,
  0x4037_f000,
  0x4038_0000,
  0x4038_1000,
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
const beqzClassifierPath = join(here, "flexe-beqz.ts");
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
  maxSteps: 512,
  rom: { resetReasons: [1, 1], memset: true, cacheBootstrap: true, cpuTicksPerUs: 40 },
});

assert.equal(run.record.steps, 455);
assert.equal(run.record.pc, 0x4000_1c38);
assert.equal(run.memoryTrace.count, 622);
assert.equal(traceRecordSha256(run.memoryTrace), FULL_TRACE_RECORD_SHA256);
assert.equal(run.memoryTrace.records.filter((record) => record.kind === TRACE_KINDS.instruction).length, 455);
assert.equal(run.memoryTrace.records.filter((record) => record.kind === TRACE_KINDS.read).length, 107);
assert.equal(run.memoryTrace.records.filter((record) => record.kind === TRACE_KINDS.write).length, 60);

const sparsePages = buildSparseElfPages(image);
const sparsePageByAddress = new Map(sparsePages.map((page) => [page.address, page]));
const inheritedPageByAddress = new Map([0x3fce_7000, 0x3fce_8000, 0x3fce_9000].map((address) => [
  address,
  Object.freeze({ address, flags: 6, bytes: new Uint8Array(PAGE_BYTES) }),
]));
const tracePages = observedPages(run.memoryTrace);
assert.deepEqual(
  tracePages,
  [...EXPECTED_SRAM_PAGES, ...EXPECTED_FLASH_PAGES, RTC_MMIO_PAGE, REGI2C_MMIO_PAGE, SYSTEM_MMIO_PAGE, CACHE_MMIO_PAGE]
    .sort((left, right) => left - right),
);

const addressRegions: AddressRegion[] = tracePages.map((address) => {
  if (address === RTC_MMIO_PAGE || address === REGI2C_MMIO_PAGE ||
      address === SYSTEM_MMIO_PAGE || address === CACHE_MMIO_PAGE) {
    const rtc = address === RTC_MMIO_PAGE;
    const regi2c = address === REGI2C_MMIO_PAGE;
    const system = address === SYSTEM_MMIO_PAGE;
    return Object.freeze({
      id: rtc
        ? "full-elf:rtc-controller-mmio"
        : regi2c
          ? "full-elf:regi2c-controller-mmio"
        : system
          ? "full-elf:system-controller-mmio"
          : "full-elf:cache-controller-mmio",
      base: BigInt(address),
      size: BigInt(PAGE_BYTES),
      kind: "mmio",
      permissions: Object.freeze({ read: true, write: true, execute: false }),
      cacheability: "uncached",
      physical: Object.freeze({
        backingId: rtc
          ? "esp32-s3-rtc-controller"
          : regi2c
            ? "esp32-s3-regi2c-controller"
          : system
            ? "esp32-s3-system-controller"
            : "esp32-s3-cache-controller",
        offset: 0n,
      }),
      peripheral: rtc ? "rtc-controller" : regi2c ? "regi2c-controller" : system ? "system-controller" : "cache-controller",
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
    source: "full ELF trace observed pages, PT_LOAD permissions, inherited stack range, and explicit controller ROM models",
  }),
  regions: Object.freeze(addressRegions),
});

const timingProfile = parseTimingProfile(JSON.parse(readFileSync(timingProfilePath, "utf8")));
assert.equal(timingProfile.coreSteadyStateCycles.dependentLoadUseHazard.status, "unmodeled");
const costSource = `timing profile ${timingProfilePath} SHA-256 ${sha256(timingProfilePath)}`;
const coreCostSource = `${costSource}; evidence ${timingProfile.coreSteadyStateCycles.evidence}`;
const branchCostSource =
  `${costSource}; evidence ${timingProfile.coreSteadyStateCycles.conditionalBranchCycles.evidence}`;
const cacheLineFillSource = `${costSource}; evidence ${timingProfile.cacheLineFillCycles.evidence}`;
const cacheHitSource = `${costSource}; evidence ${timingProfile.cacheHitAdditiveCycles.evidence}`;
const mmioCostSource = `${costSource}; evidence ${timingProfile.mmioAccessCycles.evidence}`;
const mmioCostsByAccess = new Map(timingProfile.mmioAccessCycles.entries.map((entry) => [
  `${entry.address}:${entry.operation}:${entry.bytes}:${entry.peripheral}`,
  entry,
]));
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
    hit: Object.freeze({
      instructionFetch: calibratedCost(
        timingProfile.cacheHitAdditiveCycles.instructionFetch,
        "hot zero-miss instruction-cache hit additive cost",
        cacheHitSource,
      ),
      load: calibratedCost(
        timingProfile.cacheHitAdditiveCycles.load,
        "hot zero-miss data-cache load additive cost",
        cacheHitSource,
      ),
      store: unknown,
    }),
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
      instructionFetch: calibratedCost(
        timingProfile.coreSteadyStateCycles.independentSramAccessAdditiveCycles.instructionFetch,
        "independent internal SRAM instruction fetch additive cost",
        coreCostSource,
      ),
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
const romCallbacks = run.romEvents.filter((event) =>
  event.kind !== "systemMmioRead" &&
  event.kind !== "systemMmioWrite" &&
  event.kind !== "rtcMmioRead" &&
  event.kind !== "rtcMmioWrite" &&
  event.kind !== "regi2cMmioRead" &&
  event.kind !== "regi2cMmioWrite"
);
assert.equal(romCallbacks.length, 16);
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
  beqzCpuCost: {
    notTaken: calibratedCost(
      timingProfile.coreSteadyStateCycles.conditionalBranchCycles.beqz.notTaken,
      "exact beqz not-taken CPU cost",
      branchCostSource,
    ),
    taken: calibratedCost(
      timingProfile.coreSteadyStateCycles.conditionalBranchCycles.beqz.taken,
      "exact beqz taken CPU cost",
      branchCostSource,
    ),
  },
  romCallbacks,
});
const machine = runRuntimeTimingTrace({
  addressMap,
  cache,
  mmioCost: (segment, access) => {
    const operation = access.kind === "load" ? "read" : access.kind === "store" ? "write" : null;
    const address = `0x${segment.virtualAddress.toString(16).padStart(8, "0")}`;
    const entry = operation === null || segment.peripheral === null
      ? undefined
      : mmioCostsByAccess.get(`${address}:${operation}:${segment.bytes}:${segment.peripheral}`);
    return entry === undefined
      ? unknownCost("no exact matched boot-controller MMIO access receipt", costSource)
      : calibratedCost(entry.cycles, "exact matched ESP32-S3 MMIO access", mmioCostSource);
  },
}, runtimeTrace);
assert.equal(machine.status, "blocked");
assert.equal(machine.cores[0].status, "complete");
assert.equal(machine.cores[0].accesses.length, 622);
assert(machine.cores[0].accesses.every((access) => access.status === "resolved"));
assert.equal(machine.cores[1].accesses.length, 0);
assert.equal(runtimeTrace.input.cpu?.length, 502);
assert.equal(machine.issuedEvents.filter((event) => event.origin.kind === "cache").length, 571);
assert.equal(machine.issuedEvents.filter((event) => event.origin.kind === "mmio").length, 54);
const cpuEvents = machine.issuedEvents.filter((event) => event.origin.kind === "cpu");
const loadUseHazards = cpuEvents.filter((event) => event.event.id.endsWith(":pre-data-cpu"));
const instructionCpuEvents = cpuEvents.filter((event) => event.event.id.endsWith(":cpu"));
const exactBeqzNotTaken = instructionCpuEvents.filter((event) =>
  event.cost.status === "known" && event.cost.source.includes("exact beqz not-taken")
);
const exactBeqzTaken = instructionCpuEvents.filter((event) =>
  event.cost.status === "known" && event.cost.source.includes("exact beqz taken")
);
const exactMmioEvents = machine.issuedEvents.filter((event) =>
  event.origin.kind === "mmio" && event.cost.status === "known" &&
  event.cost.source.includes("exact matched ESP32-S3 MMIO access")
);
const romCallbackCpuEvents = cpuEvents.filter((event) => event.event.id.includes(":rom-callback:"));
assert.equal(cpuEvents.length, 502);
assert.equal(loadUseHazards.length, 31);
assert.equal(instructionCpuEvents.length, 455);
assert.equal(exactBeqzNotTaken.length, 3);
assert.equal(exactBeqzTaken.length, 0);
assert.equal(romCallbackCpuEvents.length, 16);
assert.equal(machine.issuedEvents.length, 1127);
assert.equal(exactMmioEvents.length, 28);
assert.equal(machine.claim.unknownCostEventIds.length, 42);
assert.equal(machine.issuedEvents.filter((event) => event.cost.status === "known").length, 1085);
assert([...instructionCpuEvents, ...loadUseHazards].every((event) =>
  event.cost.status === "known" && event.cost.cycles === 1n && event.cost.calibration === "calibrated"
));
assert(romCallbackCpuEvents.every((event) =>
  event.cost.status === "unknown" &&
  event.cost.reason.includes("has no adopted CPU duration") &&
  event.cost.source?.includes("afterInstructionCount")
));
assert(loadUseHazards.every((event) =>
  event.cost.status === "known" && event.cost.source.includes("dependent internal SRAM load-use a")
));
assert.equal(machine.issuedEvents.filter((event) =>
  event.origin.kind === "cache" && event.event.kind === "instruction-fetch" && event.cost.status === "unknown"
).length, 0);
assert.equal(machine.issuedEvents.filter((event) =>
  event.origin.kind === "cache" && event.event.kind === "literal-load" && event.cost.status === "unknown"
).length, 0);
assert.equal(machine.issuedEvents.filter((event) =>
  event.origin.kind === "mmio" && event.cost.status === "unknown"
).length, 26);
const cacheEvents = machine.issuedEvents.filter((event) => event.origin.kind === "cache");
assert(cacheEvents.every((event) => event.cost.status === "known"));
const mmioBreakdownByKey = new Map<string, {
  address: string;
  operation: "read" | "write";
  bytes: number;
  peripheral: string;
  count: number;
}>();
for (const issued of machine.issuedEvents) {
  if (issued.origin.kind !== "mmio") continue;
  const access = machine.cores[issued.origin.core].accesses[issued.origin.programIndex];
  assert(access?.status === "resolved");
  assert(issued.event.kind === "mmio");
  const address = `0x${access.access.address.toString(16)}`;
  const key = `${address}:${issued.event.operation}:${issued.event.bytes}:${issued.event.peripheral}`;
  const previous = mmioBreakdownByKey.get(key);
  mmioBreakdownByKey.set(key, {
    address,
    operation: issued.event.operation,
    bytes: issued.event.bytes,
    peripheral: issued.event.peripheral,
    count: (previous?.count ?? 0) + 1,
  });
}
const mmioAccessBreakdown = [...mmioBreakdownByKey.values()].sort((left, right) =>
  left.address.localeCompare(right.address) ||
  left.operation.localeCompare(right.operation) ||
  left.peripheral.localeCompare(right.peripheral)
);
assert.equal(mmioAccessBreakdown.reduce((sum, entry) => sum + entry.count, 0), 54);
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
assert(flashHits.every((event) => event.cost.status === "known" && event.cost.cycles === 0n));
assert.equal(cacheEvents.filter((event) => event.cost.status === "known" && event.cost.cycles === 0n).length, 568);

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
const romCallbackEvidenceProjection = romCallbackCpuEvents.map((issued) => ({
  issueIndex: issued.issueIndex,
  eventId: issued.event.id,
  instructionAccessId: issued.origin.kind === "cpu" ? issued.origin.instructionAccessId : null,
  reason: issued.cost.status === "unknown" ? issued.cost.reason : null,
  source: issued.cost.status === "unknown" ? issued.cost.source : null,
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
    beqzClassifierSha256: sha256(beqzClassifierPath),
  },
  trace: {
    records: run.memoryTrace.count,
    instructions: 455,
    reads: 107,
    writes: 60,
    observedSramPages: EXPECTED_SRAM_PAGES.map((address) => `0x${address.toString(16)}`),
    observedFlashPages: EXPECTED_FLASH_PAGES.map((address) => `0x${address.toString(16)}`),
    observedMmioPages: [RTC_MMIO_PAGE, REGI2C_MMIO_PAGE, SYSTEM_MMIO_PAGE, CACHE_MMIO_PAGE]
      .map((address) => `0x${address.toString(16)}`),
  },
  replay: {
    status: machine.status,
    totalCycles: null,
    issuedEvents: machine.issuedEvents.length,
    memoryEvents: machine.issuedEvents.filter((event) => event.origin.kind === "cache").length,
    mmioEvents: machine.issuedEvents.filter((event) => event.origin.kind === "mmio").length,
    mmioAccessBreakdown,
    cpuEvents: cpuEvents.length,
    romCallbackEvents: romCallbackCpuEvents.length,
    dependentSramLoadUseHazards: loadUseHazards.length,
    exactBeqzNotTaken: exactBeqzNotTaken.length,
    exactBeqzTaken: exactBeqzTaken.length,
    exactMmioEvents: exactMmioEvents.length,
    knownCostEvents: machine.issuedEvents.filter((event) => event.cost.status === "known").length,
    unknownCostEvents: machine.claim.unknownCostEventIds.length,
    issuedProjectionSha256: createHash("sha256").update(JSON.stringify(issuedProjection)).digest("hex"),
    loadUseEvidenceSha256: createHash("sha256")
      .update(JSON.stringify(loadUseEvidenceProjection))
      .digest("hex"),
    romCallbackEvidenceSha256: createHash("sha256")
      .update(JSON.stringify(romCallbackEvidenceProjection))
      .digest("hex"),
  },
};
const baseline = JSON.parse(readFileSync(baselinePath, "utf8"));
assert.deepEqual(actualBaseline, baseline, "tracked full ELF timing replay baseline changed");

console.log(JSON.stringify(actualBaseline, null, 2));
