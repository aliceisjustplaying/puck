/*
 * Throwaway replay experiment: route the real RGB565 trace through the
 * ESP32-S3 TimingMachine without inventing any missing latency values.
 */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { AddressMapConfiguration, AddressRegion } from "../../packs/esp32-s3-touch-amoled-18/timing/address-map";
import {
  ESP32_S3_CACHE_BANK_TOPOLOGY,
  type CacheConfiguration,
  type CacheLatency
} from "../../packs/esp32-s3-touch-amoled-18/timing/cache";
import {
  parseTimingProfile,
  type CacheLineFillProfileCost
} from "../../packs/esp32-s3-touch-amoled-18/timing/consumer";
import type { TimingMachineConfiguration } from "../../packs/esp32-s3-touch-amoled-18/timing/machine";
import { runRuntimeTimingTrace } from "../../packs/esp32-s3-touch-amoled-18/timing/runtime-trace";
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
import { TRACE_KINDS, decodeTraceBytes, type DecodedTrace } from "./trace-abi";
import { adaptFlexeTraceToRuntimeTiming } from "./trace-timing-adapter";

const TRACE_SHA256 = "5de26fe4432e5af5c95d99d32ee0d3d68260e712bb5dd20c60eb1315f295c4eb";
const TRACE_CAPACITY = 128;
const SRAM_BASE = 0x3fca0000n;
const SRAM_SIZE = 0x10000n;
const EXPERIMENT_FLASH_PHYSICAL_PAGE = 0;
const TRACE_PROVENANCE_SOURCE = "experiments/esp32s3-flexe-wasm/dist/rgb565-execution-trace.bin";
const TIMING_PROFILE_SOURCE = "packs/esp32-s3-touch-amoled-18/timing.json";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function hex(value: number | bigint): string {
  return `0x${value.toString(16)}`;
}

function decodeTrace(bytes: Uint8Array): DecodedTrace {
  assert(createHash("sha256").update(bytes).digest("hex") === TRACE_SHA256, "RGB565 binary trace changed");
  const decoded = decodeTraceBytes(bytes, TRACE_CAPACITY);
  assert(!decoded.overflow, "complete RGB565 trace is marked overflowed");
  assert(decoded.count === 53, `expected 53 trace records, got ${decoded.count}`);
  const records = decoded.records;
  assert(records.filter((record) => record.kind === TRACE_KINDS.instruction).length === 43, "trace lost an instruction fetch");
  assert(records.filter((record) => record.kind === TRACE_KINDS.read).length === 5, "trace lost a source read");
  assert(records.filter((record) => record.kind === TRACE_KINDS.write).length === 5, "trace lost a destination write");
  return decoded;
}

function unknownCost(component: string, source: string): CacheLatency {
  return Object.freeze({
    status: "unknown",
    reason: `${component} has no adopted cycle cost in the ESP32-S3 timing profile`,
    source
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

const here = import.meta.dir;
const dist = join(here, "dist");
const tracePath = join(dist, "rgb565-execution-trace.bin");
const baselinePath = join(here, "esp32s3-timing-replay-baseline.json");
const timingProfilePath = join(here, "../../packs/esp32-s3-touch-amoled-18/timing.json");
const timingMachinePath = join(here, "../../packs/esp32-s3-touch-amoled-18/timing/machine.ts");
const mmuPath = join(here, "../../packs/esp32-s3-touch-amoled-18/timing/mmu.ts");
const cachePath = join(here, "../../packs/esp32-s3-touch-amoled-18/timing/cache.ts");
const sdkconfigPath = join(dirname(DEFAULT_TINYDRAW_ESP32S3_STAGING_ELF), "sdkconfig");
const decodedTrace = decodeTrace(new Uint8Array(await Bun.file(tracePath).arrayBuffer()));
const trace = decodedTrace.records;
const timingProfile = parseTimingProfile(JSON.parse(readFileSync(timingProfilePath, "utf8")));
assert(timingProfile.claimBoundary.cycleAccurate === false, "timing profile claim boundary changed");
assert(
  timingProfile.coreSteadyStateCycles.dependentLoadUseHazard.status === "unmodeled",
  "dependent SRAM load-use hazard left the claim boundary",
);

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

const costSource = `timing profile ${TIMING_PROFILE_SOURCE} SHA-256 ${sha256(timingProfilePath)}`;
const cacheLineFillSource =
  `${costSource}; evidence ${timingProfile.cacheLineFillCycles.evidence}`;
const coreCyclesSource =
  `${costSource}; evidence ${timingProfile.coreSteadyStateCycles.evidence}`;
const cacheHitSource =
  `${costSource}; evidence ${timingProfile.cacheHitAdditiveCycles.evidence}`;
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
      instructionFetch: calibratedCost(
        timingProfile.cacheHitAdditiveCycles.instructionFetch,
        "hot zero-miss instruction-cache hit additive cost",
        cacheHitSource,
      ),
      load: calibratedCost(
        timingProfile.cacheHitAdditiveCycles.load,
        "hot zero-miss data-cache load additive cost; dependent load-use hazard remains unmodeled",
        cacheHitSource,
      ),
      store: unknownCost("data-cache store hit", costSource)
    }),
    lineFill: Object.freeze({
      instruction: Object.freeze({
        flash: calibratedLineFill(
          timingProfile.cacheLineFillCycles.instruction.flash,
          `${cacheLineFillSource}; instruction flash`,
        ),
        psram: unknownCost("instruction-cache PSRAM line fill", costSource),
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
    dirtyWriteback: unknownCost("MSPI dirty writeback", costSource),
    writeThrough: unknownCost("MSPI write-through", costSource),
    uncached: Object.freeze({
      instructionFetch: unknownCost("uncached instruction fetch", costSource),
      load: unknownCost("uncached load", costSource),
      store: unknownCost("uncached store", costSource)
    }),
    sram: Object.freeze({
      instructionFetch: calibratedCost(
        timingProfile.coreSteadyStateCycles.independentSramAccessAdditiveCycles.instructionFetch,
        "independent internal SRAM instruction fetch additive cost",
        coreCyclesSource,
      ),
      load: calibratedCost(
        timingProfile.coreSteadyStateCycles.independentSramAccessAdditiveCycles.load,
        "independent SRAM load additive cost",
        coreCyclesSource,
      ),
      store: calibratedCost(
        timingProfile.coreSteadyStateCycles.independentSramAccessAdditiveCycles.store,
        "independent SRAM store additive cost",
        coreCyclesSource,
      )
    }),
    maintenance: unknownCost("cache maintenance", costSource)
  })
});
const machineConfig: TimingMachineConfiguration = Object.freeze({
  addressMap,
  cache,
  mmioCost: () => unknownCost("MMIO access", costSource)
});
const runtimeTrace = adaptFlexeTraceToRuntimeTiming(decodedTrace, {
  source: TRACE_PROVENANCE_SOURCE,
  sha256: TRACE_SHA256,
  core: 0
}, {
  instructionCpuCost: calibratedCost(
    timingProfile.coreSteadyStateCycles.instructionIssueCycles,
    "steady-state instruction issue",
    coreCyclesSource,
  ),
  dependentSramLoadUseHazard: {
    internalSram: Object.freeze({ base: Number(SRAM_BASE), sizeBytes: Number(SRAM_SIZE) }),
    latency: calibratedCost(
      timingProfile.coreSteadyStateCycles.dependentLoadUseHazard.observedAdditionalCycles,
      "exact dependent internal SRAM load-use",
      coreCyclesSource,
    ),
  },
});
const accesses = runtimeTrace.input.cores[0];
const machine = runRuntimeTimingTrace(machineConfig, runtimeTrace);

assert(machine.status === "complete", `expected adopted costs to complete timing, got ${machine.status}`);
assert(machine.claim.architectureCalibration === "uncalibrated", "replay architecture became calibrated");
assert(machine.claim.costCalibration === "calibrated", "replay did not retain calibrated cost provenance");
assert(machine.claim.coverage === "caller-reported-events-only", "replay overclaimed trace coverage");
assert(machine.claim.cycleAccurate === false, "replay acquired a cycle-accurate claim");
assert(machine.cores[0].status === "complete", "trace address resolution faulted");
assert(machine.cores[0].accesses.length === trace.length, "TimingMachine omitted a trace access");
assert(machine.cores[1].accesses.length === 0, "replay invented core 1 activity");
const coreFinalClock = machine.execution.finalClocks.cores[0];
assert(coreFinalClock.status === "known", "complete replay left the core clock blocked");

const executionById = new Map(machine.execution.events.map((event) => [event.eventId, event]));
const cpuByInstruction = new Map(
  machine.issuedEvents
    .flatMap((issued) => issued.origin.kind === "cpu"
      ? [[issued.origin.instructionAccessId, issued] as const]
      : []),
);
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
  const cpuIssued = cpuByInstruction.get(result.access.id);
  assert(
    (record.kind === TRACE_KINDS.instruction) === (cpuIssued !== undefined),
    `trace access ${result.access.id} CPU grouping changed`,
  );
  const cpu = cpuIssued === undefined ? null : (() => {
    const execution = executionById.get(cpuIssued.event.id);
    assert(execution !== undefined, `missing execution result for ${cpuIssued.event.id}`);
    return {
      eventId: cpuIssued.event.id,
      cost: cpuIssued.cost.status === "known"
        ? { status: "known", cycles: cpuIssued.cost.cycles.toString(10), calibration: cpuIssued.cost.calibration, source: cpuIssued.cost.source }
        : { status: "unknown", cycles: null, reason: cpuIssued.cost.reason, source: cpuIssued.cost.source },
      execution: {
        status: execution.status,
        resource: execution.resource,
        startCycle: execution.startCycle === null ? null : execution.startCycle.toString(10),
        endCycle: execution.endCycle === null ? null : execution.endCycle.toString(10)
      }
    };
  })();
  const timingKnown = emissions.every((emission) => emission.cost.status === "known") &&
    (cpu === null || cpu.cost.status === "known");
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
      status: timingKnown ? "known" : "unknown",
      totalCycles: timingKnown
        ? (
            emissions.reduce((sum, emission) => sum + BigInt(emission.cost.cycles ?? "0"), 0n) +
            BigInt(cpu?.cost.cycles ?? "0")
          ).toString(10)
        : null,
      cpu,
      emissions
    }
  };
});

const emissionKinds = machine.cores[0].accesses.flatMap((result) =>
  result.status === "resolved" ? result.cacheSteps.flatMap((step) => step.emissions.map((emission) => emission.kind)) : []
);
const counts = Object.fromEntries([...new Set(emissionKinds)].sort().map((kind) => [kind, emissionKinds.filter((value) => value === kind).length]));
assert(JSON.stringify(counts) === JSON.stringify({ hit: 44, "line-fill": 2, "sram-bypass": 10 }), `unexpected replay emissions ${JSON.stringify(counts)}`);
const cpuEvents = machine.issuedEvents.filter((issued) => issued.origin.kind === "cpu");
assert(cpuEvents.length === 43, `expected 43 CPU events, got ${cpuEvents.length}`);
assert(cpuEvents.every((event) =>
  event.cost.status === "known" &&
  event.cost.cycles === 1n &&
  event.cost.calibration === "calibrated"
), "CPU events did not use the adopted one-cycle steady-state issue cost");
const dependentLoadUseEvents = cpuEvents.filter((event) =>
  event.cost.status === "known" && event.cost.cycles === 2n
);
assert(dependentLoadUseEvents.length === 0, "staging trace unexpectedly gained a dependent SRAM load-use pair");
assert(machine.issuedEvents.length === 99, `expected 99 issued events, got ${machine.issuedEvents.length}`);
assert(machine.execution.events.filter((event) => event.resource === "mspi").length === 2, "instruction misses did not reach MSPI");
assert(machine.claim.unknownCostEventIds.length === 0, "adopted hot-hit costs left an unknown event");
const calibratedHits = perRecord.flatMap((record) =>
  record.timing.emissions.filter((emission) => emission.kind === "hit")
);
assert(calibratedHits.length === 44, "expected 44 calibrated instruction-cache hits");
assert(calibratedHits.every((emission) =>
  emission.cost.status === "known" &&
  emission.cost.cycles === "0" &&
  emission.cost.calibration === "calibrated"
), "instruction-cache hit did not use adopted zero additive hardware evidence");
const calibratedLineFills = perRecord.flatMap((record) =>
  record.timing.emissions.filter((emission) => emission.kind === "line-fill")
);
assert(calibratedLineFills.length === 2, "expected two calibrated instruction-cache line fills");
assert(calibratedLineFills.every((emission) =>
  emission.cost.status === "known" &&
  emission.cost.calibration === "calibrated" &&
  (emission.cost.cycles === "204" || emission.cost.cycles === "266")
), "instruction-cache line fill did not use adopted hardware evidence");
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
  assert(
    record.timing.emissions[0]?.cost.status === "known" &&
      record.timing.emissions[0].cost.cycles === "0" &&
      record.timing.emissions[0].cost.calibration === "calibrated",
    `${record.access.id} did not use the adopted zero additive independent SRAM cost`,
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
    coreSteadyStateCycles: {
      instructionIssueCycles: timingProfile.coreSteadyStateCycles.instructionIssueCycles,
      independentSramAccessAdditiveCycles:
        timingProfile.coreSteadyStateCycles.independentSramAccessAdditiveCycles,
      dependentLoadUseHazard: timingProfile.coreSteadyStateCycles.dependentLoadUseHazard,
    },
    cacheHitAdditiveCycles: timingProfile.cacheHitAdditiveCycles,
    instructionCache: { bytes: 16_384, lineBytes: 32, sets: 64, ways: 8 },
    dataCache: { bytes: 32_768, lineBytes: 64, sets: 64, ways: 8 },
    latencyStatus: "partially-calibrated"
  },
  summary: {
    status: machine.status,
    traceRecords: trace.length,
    instructionFetches: accesses.filter((access) => access.kind === "instruction-fetch").length,
    loads: accesses.filter((access) => access.kind === "load").length,
    stores: accesses.filter((access) => access.kind === "store").length,
    cpuExecutions: cpuEvents.length,
    dependentSramLoadUseHazards: dependentLoadUseEvents.length,
    issuedEvents: machine.issuedEvents.length,
    emissions: counts,
    mspiEvents: machine.execution.events.filter((event) => event.resource === "mspi").length,
    totalCycles: coreFinalClock.cycle.toString(10),
    totalCyclesReason:
      "complete for caller-reported events; the observed one-cycle dependent load-use hazard is not represented by this trace",
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
    totalCycles: actualBaseline.summary.totalCycles,
    reason: actualBaseline.summary.totalCyclesReason
  },
  provenance: {
    inputs: actualBaseline.inputs,
    runtimeTrace: runtimeTrace.provenance
  },
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
