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
import { parseTimingProfile } from "../../packs/esp32-s3-touch-amoled-18/timing/consumer";
import { runRuntimeTimingTrace } from "../../packs/esp32-s3-touch-amoled-18/timing/runtime-trace";
import { DEFAULT_TINYDRAW_ESP32S3_FULL_ELF } from "./constants";
import { parseXtensaElf32 } from "./elf-image";
import { buildSparseElfPages, runSparseXtensaElf, type SparseElfPage } from "./full-elf-runner";
import { sha256 } from "./lib";
import { TRACE_KINDS, type DecodedTrace } from "./trace-abi";
import { adaptFlexeTraceToRuntimeTiming } from "./trace-timing-adapter";

const FULL_TRACE_RECORD_SHA256 = "7c762ad8b09dbaa762d0a4274d256525353810d3b057f190cb5ce53fecb1a320";
const CACHE_MMIO_PAGE = 0x600c_4000;
const PAGE_BYTES = 4096;
const EXPECTED_SRAM_PAGES = Object.freeze([
  0x3fca_b000,
  0x3fce_9000,
  0x4037_4000,
  0x4037_5000,
  0x4038_0000,
  0x4038_2000,
]);

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
const adapterPath = join(here, "trace-timing-adapter.ts");
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

assert.equal(run.record.steps, 216);
assert.equal(run.record.pc, 0x4000_18c0);
assert.equal(run.memoryTrace.count, 297);
assert.equal(traceRecordSha256(run.memoryTrace), FULL_TRACE_RECORD_SHA256);
assert.equal(run.memoryTrace.records.filter((record) => record.kind === TRACE_KINDS.instruction).length, 216);
assert.equal(run.memoryTrace.records.filter((record) => record.kind === TRACE_KINDS.read).length, 57);
assert.equal(run.memoryTrace.records.filter((record) => record.kind === TRACE_KINDS.write).length, 24);

const sparsePages = buildSparseElfPages(image);
const sparsePageByAddress = new Map(sparsePages.map((page) => [page.address, page]));
const inheritedPageByAddress = new Map([0x3fce_7000, 0x3fce_8000, 0x3fce_9000].map((address) => [
  address,
  Object.freeze({ address, flags: 6, bytes: new Uint8Array(PAGE_BYTES) }),
]));
const tracePages = observedPages(run.memoryTrace);
assert.deepEqual(tracePages, [...EXPECTED_SRAM_PAGES, CACHE_MMIO_PAGE].sort((left, right) => left - right));

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
assert.equal(timingProfile.coreSteadyStateCycles.dependentLoadUseHazard.status, "unmodeled");
const costSource = `timing profile ${timingProfilePath} SHA-256 ${sha256(timingProfilePath)}`;
const coreCostSource = `${costSource}; evidence ${timingProfile.coreSteadyStateCycles.evidence}`;
const unknown = unknownCost("unused cache path", costSource);
const cache: CacheConfiguration = Object.freeze({
  addressBits: 32,
  metadata: Object.freeze({
    architectureCalibration: "uncalibrated",
    source: "cache geometry is inactive for this all-SRAM and MMIO trace boundary",
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
    lineFill: unknown,
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
});
const machine = runRuntimeTimingTrace({
  addressMap,
  cache,
  mmioCost: () => unknownCost("cache-controller MMIO access", costSource),
}, runtimeTrace);

assert.equal(machine.status, "blocked");
assert.equal(machine.cores[0].status, "complete");
assert.equal(machine.cores[0].accesses.length, 297);
assert(machine.cores[0].accesses.every((access) => access.status === "resolved"));
assert.equal(machine.cores[1].accesses.length, 0);
assert.equal(runtimeTrace.input.cpu?.length, 216);
assert.equal(machine.issuedEvents.filter((event) => event.origin.kind === "cache").length, 270);
assert.equal(machine.issuedEvents.filter((event) => event.origin.kind === "mmio").length, 27);
assert.equal(machine.issuedEvents.filter((event) => event.origin.kind === "cpu").length, 216);
assert.equal(machine.issuedEvents.length, 513);
assert.equal(machine.claim.unknownCostEventIds.length, 27);
assert.equal(machine.issuedEvents.filter((event) => event.cost.status === "known").length, 486);
assert(machine.issuedEvents.filter((event) => event.origin.kind === "cpu").every((event) =>
  event.cost.status === "known" && event.cost.cycles === 1n && event.cost.calibration === "calibrated"
));
assert(machine.issuedEvents.filter((event) => event.origin.kind === "cache").every((event) =>
  event.cost.status === "known" && event.cost.cycles === 0n
));

const issuedProjection = machine.issuedEvents.map((issued) => ({
  issueIndex: issued.issueIndex,
  eventId: issued.event.id,
  eventKind: issued.event.kind,
  originKind: issued.origin.kind,
  cost: issued.cost.status === "known"
    ? { status: issued.cost.status, cycles: issued.cost.cycles.toString(), calibration: issued.cost.calibration }
    : { status: issued.cost.status, reason: issued.cost.reason },
}));
const actualBaseline = {
  schemaVersion: 1,
  inputs: {
    elfSha256: image.elfSha256,
    moduleSha256: createHash("sha256").update(new Uint8Array(moduleBytes)).digest("hex"),
    traceRecordSha256: FULL_TRACE_RECORD_SHA256,
    timingProfileSha256: sha256(timingProfilePath),
    timingMachineSha256: sha256(timingMachinePath),
    adapterSha256: sha256(adapterPath),
  },
  trace: {
    records: run.memoryTrace.count,
    instructions: 216,
    reads: 57,
    writes: 24,
    observedSramPages: EXPECTED_SRAM_PAGES.map((address) => `0x${address.toString(16)}`),
    observedMmioPages: [`0x${CACHE_MMIO_PAGE.toString(16)}`],
  },
  replay: {
    status: machine.status,
    totalCycles: null,
    issuedEvents: machine.issuedEvents.length,
    sramEvents: machine.issuedEvents.filter((event) => event.origin.kind === "cache").length,
    mmioEvents: machine.issuedEvents.filter((event) => event.origin.kind === "mmio").length,
    cpuEvents: machine.issuedEvents.filter((event) => event.origin.kind === "cpu").length,
    knownCostEvents: machine.issuedEvents.filter((event) => event.cost.status === "known").length,
    unknownCostEvents: machine.claim.unknownCostEventIds.length,
    issuedProjectionSha256: createHash("sha256").update(JSON.stringify(issuedProjection)).digest("hex"),
  },
};
const baseline = JSON.parse(readFileSync(baselinePath, "utf8"));
assert.deepEqual(actualBaseline, baseline, "tracked full ELF timing replay baseline changed");

console.log(JSON.stringify(actualBaseline, null, 2));
