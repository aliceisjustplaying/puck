/*
 * Throwaway replay experiment: route the real RGB565 trace through the
 * ESP32-S3 TimingMachine without inventing any missing latency values.
 */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { AddressMapConfiguration, AddressRegion, VirtualMemoryAccess } from "../../packs/esp32-s3-touch-amoled-18/timing/address-map";
import {
  ESP32_S3_CACHE_BANK_TOPOLOGY,
  type CacheConfiguration,
  type CacheLatency
} from "../../packs/esp32-s3-touch-amoled-18/timing/cache";
import {
  runTimingMachine,
  type TimingMachineConfiguration
} from "../../packs/esp32-s3-touch-amoled-18/timing/machine";
import {
  ESP32_S3_EXTERNAL_WINDOWS,
  ESP32_S3_IDF_V6_0_2_MMU_METADATA,
  ESP32_S3_MMU_ENTRY_COUNT,
  ESP32_S3_MMU_PAGE_SIZE_BYTES,
  Esp32S3ExternalMmu,
  adaptExternalMmuSnapshotToAddressMap,
  type ExternalMmuEntryConfiguration
} from "../../packs/esp32-s3-touch-amoled-18/timing/mmu";
import { DEFAULT_TINYDRAW_ESP32S3_STAGING_ELF } from "./constants";
import { sha256 } from "./lib";
import { TRACE_KINDS, decodeTraceBytes, type TraceRecord } from "./trace-abi";

const TRACE_SHA256 = "5de26fe4432e5af5c95d99d32ee0d3d68260e712bb5dd20c60eb1315f295c4eb";
const TRACE_CAPACITY = 128;
const SRAM_BASE = 0x3fca0000n;
const SRAM_SIZE = 0x10000n;
const EXPERIMENT_FLASH_PHYSICAL_PAGE = 0;

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function hex(value: number | bigint): string {
  return `0x${value.toString(16)}`;
}

function decodeTrace(bytes: Uint8Array): TraceRecord[] {
  assert(createHash("sha256").update(bytes).digest("hex") === TRACE_SHA256, "RGB565 binary trace changed");
  const decoded = decodeTraceBytes(bytes, TRACE_CAPACITY);
  assert(!decoded.overflow, "complete RGB565 trace is marked overflowed");
  assert(decoded.count === 53, `expected 53 trace records, got ${decoded.count}`);
  const records = [...decoded.records];
  assert(records.filter((record) => record.kind === TRACE_KINDS.instruction).length === 43, "trace lost an instruction fetch");
  assert(records.filter((record) => record.kind === TRACE_KINDS.read).length === 5, "trace lost a source read");
  assert(records.filter((record) => record.kind === TRACE_KINDS.write).length === 5, "trace lost a destination write");
  return records;
}

function accessFor(record: TraceRecord, index: number): VirtualMemoryAccess {
  const kind =
    record.kind === TRACE_KINDS.instruction
      ? "instruction-fetch"
      : record.kind === TRACE_KINDS.read
        ? "load"
        : "store";
  const address = record.kind === TRACE_KINDS.instruction ? record.pc : record.address;
  return Object.freeze({
    id: `trace:${index.toString().padStart(2, "0")}:${kind}`,
    core: 0 as const,
    kind,
    address: BigInt(address),
    bytes: record.width
  });
}

function unknownCost(component: string, source: string): CacheLatency {
  return Object.freeze({
    status: "unknown",
    reason: `${component} has no adopted cycle cost in the ESP32-S3 timing profile`,
    source
  });
}

const here = import.meta.dir;
const dist = join(here, "dist");
const tracePath = join(dist, "rgb565-execution-trace.bin");
const baselinePath = join(here, "esp32s3-timing-replay-baseline.json");
const timingProfilePath = join(here, "../../packs/esp32-s3-touch-amoled-18/timing.json");
const timingMachinePath = join(here, "../../packs/esp32-s3-touch-amoled-18/timing/machine.ts");
const mmuPath = join(here, "../../packs/esp32-s3-touch-amoled-18/timing/mmu.ts");
const cachePath = join(here, "../../packs/esp32-s3-touch-amoled-18/timing/cache.ts");
const sdkconfigPath = join(dirname(DEFAULT_TINYDRAW_ESP32S3_STAGING_ELF), "sdkconfig");
const trace = decodeTrace(new Uint8Array(await Bun.file(tracePath).arrayBuffer()));
const timingProfile = JSON.parse(readFileSync(timingProfilePath, "utf8"));
assert(timingProfile.claimBoundary?.cycleAccurate === false, "timing profile claim boundary changed");

const sdkconfig = readFileSync(sdkconfigPath, "utf8");
for (const line of [
  "CONFIG_ESP32S3_INSTRUCTION_CACHE_SIZE=0x4000",
  "CONFIG_ESP32S3_ICACHE_ASSOCIATED_WAYS=8",
  "CONFIG_ESP32S3_INSTRUCTION_CACHE_LINE_SIZE=32",
  "CONFIG_ESP32S3_DATA_CACHE_SIZE=0x8000",
  "CONFIG_ESP32S3_DCACHE_ASSOCIATED_WAYS=8",
  "CONFIG_ESP32S3_DATA_CACHE_LINE_SIZE=64"
]) {
  assert(sdkconfig.includes(`${line}\n`), `staging sdkconfig no longer contains ${line}`);
}

const firstInstruction = trace.find((record) => record.kind === TRACE_KINDS.instruction);
assert(firstInstruction !== undefined, "trace has no instruction records");
const iromIndex = Number((BigInt(firstInstruction.pc) - ESP32_S3_EXTERNAL_WINDOWS.irom.low) / ESP32_S3_MMU_PAGE_SIZE_BYTES);
assert(iromIndex === 5, `staging function moved to MMU entry ${iromIndex}`);
const mmuEntries: ExternalMmuEntryConfiguration[] = Array.from(
  { length: ESP32_S3_MMU_ENTRY_COUNT },
  (_, index) => ({ index, state: "invalid" as const })
);
mmuEntries[iromIndex] = {
  index: iromIndex,
  state: "mapped",
  target: "flash",
  physicalPage: EXPERIMENT_FLASH_PHYSICAL_PAGE
};
const mmu = new Esp32S3ExternalMmu({ metadata: ESP32_S3_IDF_V6_0_2_MMU_METADATA, entries: mmuEntries });
const externalMap = adaptExternalMmuSnapshotToAddressMap(mmu.snapshot());
const sramRegion: AddressRegion = Object.freeze({
  id: "experiment:dram",
  base: SRAM_BASE,
  size: SRAM_SIZE,
  kind: "sram",
  permissions: Object.freeze({ read: true, write: true, execute: false }),
  cacheability: "uncached",
  physical: Object.freeze({ backingId: "esp32-s3-internal-sram", offset: 0n })
});
const addressMap: AddressMapConfiguration = Object.freeze({
  addressBits: 32,
  metadata: Object.freeze({
    architectureCalibration: "uncalibrated",
    source:
      `${externalMap.metadata.source}; experiment route maps IROM entry ${iromIndex} to flash physical page ` +
      `${EXPERIMENT_FLASH_PHYSICAL_PAGE} and ${hex(SRAM_BASE)}..${hex(SRAM_BASE + SRAM_SIZE)} to internal SRAM`
  }),
  regions: Object.freeze([...externalMap.regions, sramRegion].sort((left, right) => (left.base < right.base ? -1 : 1)))
});

const costSource = `timing profile ${timingProfilePath} SHA-256 ${sha256(timingProfilePath)}`;
const cache: CacheConfiguration = Object.freeze({
  addressBits: 32,
  metadata: Object.freeze({
    architectureCalibration: "uncalibrated",
    source: `staging sdkconfig ${sdkconfigPath} SHA-256 ${sha256(sdkconfigPath)}`
  }),
  topology: ESP32_S3_CACHE_BANK_TOPOLOGY,
  instruction: Object.freeze({
    lineSizeBytes: 32,
    sets: 64,
    ways: 8,
    replacement: "least-recently-used",
    writePolicy: "read-only"
  }),
  data: Object.freeze({
    lineSizeBytes: 64,
    sets: 64,
    ways: 8,
    replacement: "least-recently-used",
    writePolicy: "write-back",
    allocateOnStoreMiss: true,
    dirtyInvalidate: "writeback"
  }),
  costs: Object.freeze({
    hit: Object.freeze({
      instructionFetch: unknownCost("instruction-cache hit", costSource),
      load: unknownCost("data-cache load hit", costSource),
      store: unknownCost("data-cache store hit", costSource)
    }),
    lineFill: unknownCost("MSPI cache-line fill", costSource),
    dirtyWriteback: unknownCost("MSPI dirty writeback", costSource),
    writeThrough: unknownCost("MSPI write-through", costSource),
    uncached: Object.freeze({
      instructionFetch: unknownCost("uncached instruction fetch", costSource),
      load: unknownCost("uncached load", costSource),
      store: unknownCost("uncached store", costSource)
    }),
    sram: Object.freeze({
      instructionFetch: unknownCost("internal SRAM instruction fetch", costSource),
      load: unknownCost("internal SRAM load", costSource),
      store: unknownCost("internal SRAM store", costSource)
    }),
    maintenance: unknownCost("cache maintenance", costSource)
  })
});
const machineConfig: TimingMachineConfiguration = Object.freeze({
  addressMap,
  cache,
  mmioCost: () => unknownCost("MMIO access", costSource)
});
const accesses = trace.map(accessFor);
const machine = runTimingMachine(machineConfig, {
  cores: [accesses, []],
  architecturalInterleave: accesses.map((access) => access.id),
  dma: []
});

assert(machine.status === "blocked", `expected unknown costs to block timing, got ${machine.status}`);
assert(machine.claim.architectureCalibration === "uncalibrated", "replay architecture became calibrated");
assert(machine.claim.costCalibration === "unknown", "replay costs became calibrated without evidence");
assert(machine.cores[0].status === "complete", "trace address resolution faulted");
assert(machine.cores[0].accesses.length === trace.length, "TimingMachine omitted a trace access");
assert(machine.cores[1].accesses.length === 0, "replay invented core 1 activity");

const executionById = new Map(machine.execution.events.map((event) => [event.eventId, event]));
const perRecord = machine.cores[0].accesses.map((result, index) => {
  assert(result.status === "resolved", `trace access ${index} did not resolve`);
  const emissions = result.cacheSteps.flatMap((step) => step.emissions).map((emission) => {
    const execution = executionById.get(emission.event.id);
    assert(execution !== undefined, `missing execution result for ${emission.event.id}`);
    return {
      kind: emission.kind,
      eventId: emission.event.id,
      lineAddress: emission.lineAddress === null ? null : hex(emission.lineAddress),
      bytes: emission.bytes,
      cost: emission.cost.status === "known"
        ? { status: "known", cycles: emission.cost.cycles.toString(10), calibration: emission.cost.calibration, source: emission.cost.source }
        : { status: "unknown", cycles: null, reason: emission.cost.reason, source: emission.cost.source },
      execution: {
        status: execution.status,
        resource: execution.resource,
        startCycle: execution.startCycle === null ? null : execution.startCycle.toString(10),
        endCycle: execution.endCycle === null ? null : execution.endCycle.toString(10)
      }
    };
  });
  const record = trace[index]!;
  return {
    traceIndex: index,
    trace: {
      kind: record.kind === TRACE_KINDS.instruction ? "instruction" : record.kind === TRACE_KINDS.read ? "read" : "write",
      pc: hex(record.pc),
      address: record.kind === TRACE_KINDS.instruction ? null : hex(record.address),
      width: record.width,
      value: record.kind === TRACE_KINDS.instruction ? null : hex(record.value),
      instruction: record.kind === TRACE_KINDS.instruction ? hex(record.instruction) : null
    },
    access: {
      id: result.access.id,
      kind: result.access.kind,
      address: hex(result.access.address),
      bytes: result.access.bytes
    },
    resolution: result.resolution.segments.map((segment) => ({
      regionId: segment.regionId,
      kind: segment.kind,
      cacheability: segment.cacheability,
      physicalBackingId: segment.physicalBackingId,
      physicalOffset: hex(segment.physicalOffset)
    })),
    timing: {
      status: emissions.every((emission) => emission.cost.status === "known") ? "known" : "unknown",
      totalCycles: emissions.every((emission) => emission.cost.status === "known")
        ? emissions.reduce((sum, emission) => sum + BigInt(emission.cost.cycles ?? "0"), 0n).toString(10)
        : null,
      emissions
    }
  };
});

const emissionKinds = machine.cores[0].accesses.flatMap((result) =>
  result.status === "resolved" ? result.cacheSteps.flatMap((step) => step.emissions.map((emission) => emission.kind)) : []
);
const counts = Object.fromEntries([...new Set(emissionKinds)].sort().map((kind) => [kind, emissionKinds.filter((value) => value === kind).length]));
assert(JSON.stringify(counts) === JSON.stringify({ hit: 44, "line-fill": 2, "sram-bypass": 10 }), `unexpected replay emissions ${JSON.stringify(counts)}`);
assert(machine.issuedEvents.length === 56, `expected 56 issued events, got ${machine.issuedEvents.length}`);
assert(machine.execution.events.filter((event) => event.resource === "mspi").length === 2, "instruction misses did not reach MSPI");
assert(machine.claim.unknownCostEventIds.length === 56, "an event acquired an unproven cycle cost");
const crossingFetch = perRecord.find((record) => record.trace.pc === "0x4205823e");
assert(crossingFetch !== undefined, "trace lost the cache-line crossing fetch");
assert(
  JSON.stringify(crossingFetch.timing.emissions.map((emission) => [emission.kind, emission.lineAddress])) ===
    JSON.stringify([["hit", "0x8220"], ["line-fill", "0x8240"], ["hit", "0x8240"]]),
  "the three-byte fetch at 0x4205823e no longer spans two instruction-cache lines"
);
for (const record of perRecord.filter((candidate) => candidate.trace.kind !== "instruction")) {
  assert(record.resolution[0]?.physicalBackingId === "esp32-s3-internal-sram", `${record.access.id} left SRAM`);
  assert(
    JSON.stringify(record.timing.emissions.map((emission) => emission.kind)) === JSON.stringify(["sram-bypass"]),
    `${record.access.id} did not use the SRAM bypass path`
  );
}

const perRecordJson = JSON.stringify(perRecord);
const perRecordSha256 = createHash("sha256").update(perRecordJson).digest("hex");
const actualBaseline = {
  inputs: {
    traceSha256: TRACE_SHA256,
    stagingElfSha256: sha256(DEFAULT_TINYDRAW_ESP32S3_STAGING_ELF),
    sdkconfigSha256: sha256(sdkconfigPath),
    timingProfileSha256: sha256(timingProfilePath),
    timingMachineSha256: sha256(timingMachinePath),
    mmuSha256: sha256(mmuPath),
    cacheSha256: sha256(cachePath)
  },
  configuration: {
    iromMmuEntry: iromIndex,
    flashPhysicalPage: EXPERIMENT_FLASH_PHYSICAL_PAGE,
    sramBase: hex(SRAM_BASE),
    sramBytes: Number(SRAM_SIZE),
    instructionCache: { bytes: 16_384, lineBytes: 32, sets: 64, ways: 8 },
    dataCache: { bytes: 32_768, lineBytes: 64, sets: 64, ways: 8 },
    latencyStatus: "unknown"
  },
  summary: {
    status: machine.status,
    traceRecords: trace.length,
    instructionFetches: accesses.filter((access) => access.kind === "instruction-fetch").length,
    loads: accesses.filter((access) => access.kind === "load").length,
    stores: accesses.filter((access) => access.kind === "store").length,
    issuedEvents: machine.issuedEvents.length,
    emissions: counts,
    mspiEvents: machine.execution.events.filter((event) => event.resource === "mspi").length,
    totalCycles: null,
    totalCyclesReason: "all cache and SRAM latency costs remain unadopted",
    perRecordSha256
  }
};
const baseline = JSON.parse(readFileSync(baselinePath, "utf8"));
assert(JSON.stringify(actualBaseline) === JSON.stringify({
  inputs: baseline.inputs,
  configuration: baseline.configuration,
  summary: baseline.summary
}), `tracked timing replay baseline changed: ${JSON.stringify(actualBaseline)}`);

const report = {
  schemaVersion: 1,
  claim: {
    mode: "deterministic-trace-replay-experiment",
    cycleAccurate: false,
    architectureCalibration: machine.claim.architectureCalibration,
    costCalibration: machine.claim.costCalibration,
    totalCycles: null,
    reason: actualBaseline.summary.totalCyclesReason
  },
  provenance: actualBaseline.inputs,
  configuration: {
    ...actualBaseline.configuration,
    flashPhysicalPageClaim: "experiment route only, not an observed hardware MMU snapshot",
    replacementAndWritePolicies: "required machine inputs, not exercised by this trace"
  },
  summary: actualBaseline.summary,
  perRecord
};
mkdirSync(dist, { recursive: true });
writeFileSync(join(dist, "rgb565-timing-replay.json"), `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(actualBaseline.summary, null, 2));
