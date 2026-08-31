import { adaptFlexeTraceToRuntimeTiming } from "./trace-timing-adapter";
import {
  TRACE_ABI_VERSION,
  TRACE_HEADER_BYTES,
  TRACE_KINDS,
  TRACE_RECORD_BYTES,
  type DecodedTrace,
} from "./trace-abi";
import { XTENSA_MEMW_INSTRUCTION_ENCODING } from "../../packs/esp32-s3-touch-amoled-18/timing/trace-adapter";
import { scheduleExecution } from "../../packs/esp32-s3-touch-amoled-18/timing/execution";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const decoded: DecodedTrace = {
  abiVersion: TRACE_ABI_VERSION,
  headerBytes: TRACE_HEADER_BYTES,
  recordBytes: TRACE_RECORD_BYTES,
  count: 3,
  capacity: 8,
  overflow: false,
  records: [
    { kind: TRACE_KINDS.instruction, pc: 0x42000000, address: 0, value: 0, width: 3, instruction: 0x123456 },
    { kind: TRACE_KINDS.read, pc: 0x42000003, address: 0x3fca1000, value: 0x1234, width: 2, instruction: 0 },
    { kind: TRACE_KINDS.write, pc: 0x42000006, address: 0x3fca2000, value: 0x3412, width: 2, instruction: 0 },
  ],
};
const sha256 = "b".repeat(64);
const trace = adaptFlexeTraceToRuntimeTiming(decoded, {
  source: "synthetic flexe trace",
  sha256,
  core: 1,
}, {
  instructionCpuCost: {
    status: "known",
    cycles: 1n,
    calibration: "calibrated",
    source: "synthetic steady-state issue evidence",
  },
});
const accesses = trace.input.cores[1];
assert(trace.input.cores[0].length === 0, "flexe bridge invented core 0 activity");
assert(accesses.length === 3, "flexe bridge omitted a trace record");
assert(trace.input.cpu?.length === 1, "flexe bridge omitted the instruction CPU event");
assert(
  trace.input.cpu[0]?.latency.status === "known" && trace.input.cpu[0].latency.cycles === 1n,
  "flexe bridge lost the caller-supplied steady-state issue cost",
);
assert(
  JSON.stringify(trace.input.issueOrder) === JSON.stringify([
    { kind: "memory", accessId: "trace:00:instruction-fetch" },
    { kind: "memory", accessId: "trace:01:load" },
    { kind: "memory", accessId: "trace:02:store" },
    { kind: "cpu", eventId: "trace:00:instruction-fetch:cpu" },
  ]),
  "flexe bridge lost instruction and data grouping",
);
assert(
  JSON.stringify(accesses.map((access) => [access.id, access.kind, access.address.toString(16), access.bytes])) ===
    JSON.stringify([
      ["trace:00:instruction-fetch", "instruction-fetch", "42000000", 3],
      ["trace:01:load", "load", "3fca1000", 2],
      ["trace:02:store", "store", "3fca2000", 2],
    ]),
  "flexe bridge changed the ABI record accounting",
);
assert(trace.provenance?.digest?.value === sha256, "flexe bridge lost the trace digest");
assert(trace.provenance.bounds.capacity === 8, "flexe bridge lost the trace capacity");
assert(trace.claim.coverage === "caller-reported-events-only", "flexe bridge overclaimed coverage");
assert(trace.claim.cycleAccurate === false, "flexe bridge made a cycle claim");
assert(accesses[2]?.storeBuffer === undefined, "flexe bridge enabled store buffering by default");
assert(trace.input.fence === undefined, "flexe bridge invented a default fence");

const sameValueTrace = adaptFlexeTraceToRuntimeTiming({
  ...decoded,
  count: 4,
  records: [
    { kind: TRACE_KINDS.read, pc: 0x42000000, address: 0x600c0060, value: 0x1234, width: 4, instruction: 0 },
    { kind: TRACE_KINDS.write, pc: 0x42000003, address: 0x600c0060, value: 0x1234, width: 4, instruction: 0 },
    { kind: TRACE_KINDS.write, pc: 0x42000006, address: 0x600c0060, value: 0x5678, width: 4, instruction: 0 },
    { kind: TRACE_KINDS.write, pc: 0x42000009, address: 0x600c0064, value: 0, width: 4, instruction: 0 },
  ],
}, {
  source: "synthetic same-value trace",
  sha256,
  core: 0,
});
assert(
  sameValueTrace.input.cores[0].map((access) => access.writeEffect ?? null).join(",") ===
    ",same-value,,",
  "flexe bridge classified a changed or prior-state-unknown write as same-value",
);

const callbackTrace = adaptFlexeTraceToRuntimeTiming(decoded, {
  source: "synthetic flexe trace",
  sha256,
  core: 1,
}, {
  instructionCpuCost: {
    status: "known",
    cycles: 1n,
    calibration: "calibrated",
    source: "synthetic steady-state issue evidence",
  },
  romCallbacks: [{ kind: "memset", pc: 0x400011e8, afterInstructionCount: 1 }],
});
const callbackCpu = callbackTrace.input.cpu?.[1];
assert(callbackTrace.input.cpu?.length === 2, "flexe bridge omitted the configured ROM callback CPU boundary");
assert(
  callbackCpu?.id === "trace:00:instruction-fetch:rom-callback:0:memset" &&
    callbackCpu.instructionAccessId === "trace:00:instruction-fetch" &&
    callbackCpu.latency.status === "unknown" &&
    callbackCpu.latency.reason.includes("memset at 0x400011e8") &&
    callbackCpu.latency.source?.includes("afterInstructionCount 1"),
  "flexe bridge assigned cost or lost provenance for the configured ROM callback",
);
assert(
  JSON.stringify(callbackTrace.input.issueOrder?.slice(-2)) === JSON.stringify([
    { kind: "cpu", eventId: "trace:00:instruction-fetch:cpu" },
    { kind: "cpu", eventId: "trace:00:instruction-fetch:rom-callback:0:memset" },
  ]),
  "flexe bridge did not attach the ROM callback after its preceding call instruction",
);

const knownCallbackTrace = adaptFlexeTraceToRuntimeTiming(decoded, {
  source: "synthetic flexe trace",
  sha256,
  core: 1,
}, {
  romCallbacks: [{
    kind: "memset",
    pc: 0x400011e8,
    afterInstructionCount: 1,
    cpuCost: {
      status: "known",
      cycles: 31n,
      calibration: "calibrated",
      source: "synthetic matched ROM callback receipt",
    },
  }],
});
assert(
  knownCallbackTrace.input.cpu?.[1]?.latency.status === "known" &&
    knownCallbackTrace.input.cpu[1].latency.cycles === 31n,
  "flexe bridge lost the caller-supplied exact ROM callback cost",
);

for (const afterInstructionCount of [0, 2]) {
  let invalidRomBoundaryFailure: unknown = null;
  try {
    adaptFlexeTraceToRuntimeTiming(decoded, {
      source: "synthetic invalid ROM boundary",
      sha256,
      core: 1,
    }, {
      romCallbacks: [{ kind: "memset", pc: 0x400011e8, afterInstructionCount }],
    });
  } catch (error) {
    invalidRomBoundaryFailure = error;
  }
  assert(
    invalidRomBoundaryFailure instanceof Error && invalidRomBoundaryFailure.message.includes("afterInstructionCount"),
    `flexe bridge accepted ROM callback afterInstructionCount ${afterInstructionCount}`,
  );
}
const twoInstructionDecoded: DecodedTrace = {
  ...decoded,
  count: 2,
  records: [
    decoded.records[0]!,
    { ...decoded.records[0]!, pc: 0x42000003 },
  ],
};
let unorderedRomBoundaryFailure: unknown = null;
try {
  adaptFlexeTraceToRuntimeTiming(twoInstructionDecoded, {
    source: "synthetic unordered ROM boundaries",
    sha256,
    core: 1,
  }, {
    romCallbacks: [
      { kind: "cache", pc: 0x4000186c, afterInstructionCount: 2 },
      { kind: "memset", pc: 0x400011e8, afterInstructionCount: 1 },
    ],
  });
} catch (error) {
  unorderedRomBoundaryFailure = error;
}
assert(
  unorderedRomBoundaryFailure instanceof Error && unorderedRomBoundaryFailure.message.includes("ordered"),
  "flexe bridge accepted out-of-order ROM callback instruction boundaries",
);

const L32R_A2 = 0xffff21;
const literalDecoded: DecodedTrace = {
  ...decoded,
  count: 4,
  records: [
    { kind: TRACE_KINDS.instruction, pc: 0x42000010, address: 0, value: 0, width: 3, instruction: L32R_A2 },
    { kind: TRACE_KINDS.read, pc: 0x42000010, address: 0x42000000, value: 0x12345678, width: 4, instruction: 0 },
    { kind: TRACE_KINDS.instruction, pc: 0x42000013, address: 0, value: 0, width: 3, instruction: 0x002232 },
    { kind: TRACE_KINDS.read, pc: 0x42000013, address: 0x42000004, value: 0x87654321, width: 4, instruction: 0 },
  ],
};
const literalTrace = adaptFlexeTraceToRuntimeTiming(literalDecoded, {
  source: "synthetic exact L32R trace",
  sha256,
  core: 0,
});
assert(
  literalTrace.input.cores[0].map((access) => access.kind).join(",") ===
    "instruction-fetch,literal-load,instruction-fetch,load",
  "Flexe bridge did not classify only the exact L32R-owned read as a literal load",
);
assert(
  literalTrace.provenance?.extensions?.[0]?.kind === "literal-load" &&
    literalTrace.provenance.extensions[0].source.includes("exact Xtensa L32R encoding"),
  "Flexe bridge lost exact L32R extension provenance",
);
let inconsistentEncodingFailure: unknown = null;
try {
  adaptFlexeTraceToRuntimeTiming({
    ...literalDecoded,
    count: 2,
    records: [
      literalDecoded.records[0]!,
      { ...literalDecoded.records[0]!, instruction: 0xffff31 },
    ],
  }, {
    source: "synthetic inconsistent instruction identity",
    sha256,
    core: 0,
  });
} catch (error) {
  inconsistentEncodingFailure = error;
}
assert(
  inconsistentEncodingFailure instanceof Error && inconsistentEncodingFailure.message.includes("inconsistent encodings"),
  "Flexe bridge accepted inconsistent encodings for one instruction PC",
);

const bufferedDecoded: DecodedTrace = {
  ...decoded,
  count: 3,
  records: [
    { kind: TRACE_KINDS.instruction, pc: 0x42000100, address: 0, value: 0, width: 3, instruction: 0x123456 },
    { kind: TRACE_KINDS.write, pc: 0x42000100, address: 0x3fca2000, value: 0x3412, width: 2, instruction: 0 },
    {
      kind: TRACE_KINDS.instruction,
      pc: 0x42000103,
      address: 0,
      value: 0,
      width: 3,
      instruction: XTENSA_MEMW_INSTRUCTION_ENCODING,
    },
  ],
};
const known = (cycles: bigint, source: string) => ({
  status: "known" as const,
  cycles,
  calibration: "uncalibrated" as const,
  source,
});
const buffered = adaptFlexeTraceToRuntimeTiming(bufferedDecoded, {
  source: "synthetic buffered flexe trace",
  sha256,
  core: 1,
}, {
  instructionCpuCost: known(1n, "caller instruction cost"),
  storeBuffer: {
    retirementLatency: known(1n, "caller store retirement cost"),
    memwLatency: known(2n, "caller memw cost"),
  },
});
assert(
  buffered.input.cores[1][1]?.storeBuffer?.retirementLatency.status === "known",
  "flexe bridge did not enable the observed write buffer",
);
assert(buffered.input.cpu?.length === 1, "flexe bridge counted memw as an ordinary CPU event");
assert(buffered.input.fence?.length === 1, "flexe bridge did not classify exact memw");
assert(buffered.input.fence[0]?.instructionAccessId === "trace:02:instruction-fetch", "memw fence lost its fetch link");
assert(
  JSON.stringify(buffered.input.issueOrder) === JSON.stringify([
    { kind: "memory", accessId: "trace:00:instruction-fetch" },
    { kind: "memory", accessId: "trace:01:store" },
    { kind: "cpu", eventId: "trace:00:instruction-fetch:cpu" },
    { kind: "memory", accessId: "trace:02:instruction-fetch" },
    { kind: "fence", eventId: "trace:02:instruction-fetch:fence" },
  ]),
  "flexe bridge changed buffered store or fence order",
);

const L32I_A3_A2 = 0x002232;
const ADDX4_A4_A3_A5 = 0xa04350;
const ADDX4_A4_A6_A5 = 0xa04650;
const S32C1I_A4_A2 = 0x00e242;
const SUB_A3_A3_A4 = 0xc03340;
const loadUseOptions = {
  instructionCpuCost: {
    status: "known" as const,
    cycles: 1n,
    calibration: "calibrated" as const,
    source: "measured steady-state issue",
  },
  dependentSramLoadUseHazard: {
    internalSram: { base: 0x3fca0000, sizeBytes: 0x10000 },
    latency: {
      status: "known" as const,
      cycles: 1n,
      calibration: "calibrated" as const,
      source: "measured dependent addx4 plus l32i recurrence",
    },
  },
};
function loadUseTrace(consumerInstruction: number, overrides: Partial<DecodedTrace> = {}): DecodedTrace {
  return {
    abiVersion: TRACE_ABI_VERSION,
    headerBytes: TRACE_HEADER_BYTES,
    recordBytes: TRACE_RECORD_BYTES,
    count: 3,
    capacity: 8,
    overflow: false,
    records: [
      {
        kind: TRACE_KINDS.instruction,
        pc: 0x42001000,
        address: 0,
        value: 0,
        width: 3,
        instruction: L32I_A3_A2,
      },
      {
        kind: TRACE_KINDS.read,
        pc: 0x42001000,
        address: 0x3fca0010,
        value: 0x12345678,
        width: 4,
        instruction: 0,
      },
      {
        kind: TRACE_KINDS.instruction,
        pc: 0x42001003,
        address: 0,
        value: 0,
        width: 3,
        instruction: consumerInstruction,
      },
    ],
    ...overrides,
  };
}
function adaptLoadUse(decodedTrace: DecodedTrace) {
  return adaptFlexeTraceToRuntimeTiming(decodedTrace, {
    source: "synthetic exact Flexe load-use trace",
    sha256,
    core: 0,
  }, loadUseOptions);
}
function expectLoadUseFailure(decodedTrace: DecodedTrace, message: string): void {
  let failure: unknown = null;
  try {
    adaptLoadUse(decodedTrace);
  } catch (error) {
    failure = error;
  }
  assert(failure instanceof Error && failure.message.includes(message), `missing refusal: ${message}`);
}

const dependentLoadUse = adaptLoadUse(loadUseTrace(ADDX4_A4_A3_A5));
assert(
  dependentLoadUse.input.cpu?.map((event) => event.latency.status === "known" ? event.latency.cycles : null)
    .join(",") === "1,1,1",
  "exact dependent SRAM load-use did not add one consumer cycle",
);
assert(
  dependentLoadUse.input.cpu[1]?.latency.status === "known" &&
    dependentLoadUse.input.cpu[1].latency.source.includes("a3 0x42001000 -> 0x42001003"),
  "dependent SRAM load-use lost register and PC provenance",
);
assert(
  dependentLoadUse.input.cpu[1]?.id === "trace:02:instruction-fetch:pre-data-cpu" &&
    scheduleExecution(dependentLoadUse.input.cpu ?? []).events.map((event) => event.endCycle).join(",") === "1,2,3",
  "dependent SRAM load-use did not delay the consumer ready clock by one cycle",
);
assert(
  dependentLoadUse.input.cores[0][1]?.kind === "load" &&
    dependentLoadUse.input.cores[0][1]?.storeBuffer === undefined,
  "dependent SRAM load-use changed the independent zero-additive memory path",
);

const independentLoadUse = adaptLoadUse(loadUseTrace(ADDX4_A4_A6_A5));
assert(
  independentLoadUse.input.cpu?.every((event) => event.latency.status === "known" && event.latency.cycles === 1n),
  "independent SRAM load gained a hazard cycle",
);

const fourByteConsumerBase = loadUseTrace(0x8000_003e);
const fourByteConsumer = adaptLoadUse(Object.freeze({
  ...fourByteConsumerBase,
  records: Object.freeze(fourByteConsumerBase.records.map((record, index) =>
    index === 2 ? Object.freeze({ ...record, width: 4 }) : record)),
}));
assert(
  fourByteConsumer.input.cpu?.[1]?.latency.status === "known" &&
    fourByteConsumer.input.cpu[1].latency.source.includes("a3"),
  "four-byte float consumer lost its exact base-register load-use dependency",
);

const fourByteProducerBase = loadUseTrace(ADDX4_A4_A3_A5);
const fourByteProducer = adaptLoadUse(Object.freeze({
  ...fourByteProducerBase,
  records: Object.freeze(fourByteProducerBase.records.map((record, index) =>
    index === 0
      ? Object.freeze({ ...record, width: 4, instruction: 0x8000_002e })
      : index === 2
        ? Object.freeze({ ...record, pc: 0x4200_1004 })
        : record)),
}));
assert(
  fourByteProducer.input.cpu?.length === 2,
  "four-byte float load was misclassified as a scalar GPR load-use producer",
);

function atomicLoadUseTrace(writeWidth = 4): DecodedTrace {
  return {
    ...loadUseTrace(SUB_A3_A3_A4),
    count: 4,
    records: [
      {
        kind: TRACE_KINDS.instruction,
        pc: 0x4037e0ec,
        address: 0,
        value: 0,
        width: 3,
        instruction: S32C1I_A4_A2,
      },
      {
        kind: TRACE_KINDS.read,
        pc: 0x4037e0ec,
        address: 0x3fca6a44,
        value: 0xb34448ff,
        width: 4,
        instruction: 0,
      },
      {
        kind: TRACE_KINDS.write,
        pc: 0x4037e0ec,
        address: 0x3fca6a44,
        value: 0,
        width: writeWidth,
        instruction: 0,
      },
      {
        kind: TRACE_KINDS.instruction,
        pc: 0x4037e0ef,
        address: 0,
        value: 0,
        width: 3,
        instruction: SUB_A3_A3_A4,
      },
    ],
  };
}

const atomicLoadUse = adaptLoadUse(atomicLoadUseTrace());
assert(
  atomicLoadUse.input.cpu?.length === 3 &&
    atomicLoadUse.input.cpu[1]?.latency.source?.includes("a4 0x4037e0ec -> 0x4037e0ef"),
  "exact dependent S32C1I SRAM read/write lost its load-use hazard",
);
expectLoadUseFailure(atomicLoadUseTrace(2), "S32C1I read/write shape");

const BEQZ_A2_PLUS_8 = 0x004216;
function beqzTrace(nextPc: number): DecodedTrace {
  return {
    ...decoded,
    count: 2,
    records: [
      {
        kind: TRACE_KINDS.instruction,
        pc: 0x42002000,
        address: 0,
        value: 0,
        width: 3,
        instruction: BEQZ_A2_PLUS_8,
      },
      {
        kind: TRACE_KINDS.instruction,
        pc: nextPc,
        address: 0,
        value: 0,
        width: 3,
        instruction: 0x002232,
      },
    ],
  };
}
function adaptBeqz(decodedTrace: DecodedTrace) {
  return adaptFlexeTraceToRuntimeTiming(decodedTrace, {
    source: "synthetic exact Flexe beqz trace",
    sha256,
    core: 0,
  }, {
    instructionCpuCost: known(1n, "measured steady-state issue"),
    beqzCpuCost: {
      taken: {
        status: "known",
        cycles: 3n,
        calibration: "calibrated",
        source: "synthetic calibrated beqz taken path",
      },
      notTaken: {
        status: "known",
        cycles: 1n,
        calibration: "calibrated",
        source: "synthetic calibrated beqz not-taken path",
      },
    },
  });
}
const takenBeqz = adaptBeqz(beqzTrace(0x42002008));
const notTakenBeqz = adaptBeqz(beqzTrace(0x42002003));
const takenBeqzCpu = takenBeqz.input.cpu?.[0];
const notTakenBeqzCpu = notTakenBeqz.input.cpu?.[0];
assert(
  takenBeqzCpu?.latency.status === "known" &&
    takenBeqzCpu.latency.cycles === 3n &&
    takenBeqzCpu.latency.source.includes("exact beqz taken 0x42002000 -> 0x42002008"),
  "exact taken beqz lost its calibrated path cost",
);
assert(
  notTakenBeqzCpu?.latency.status === "known" &&
    notTakenBeqzCpu.latency.cycles === 1n &&
    notTakenBeqzCpu.latency.source.includes("exact beqz not-taken 0x42002000 -> 0x42002003"),
  "exact not-taken beqz lost its calibrated path cost",
);
let impossibleBeqzFailure: unknown = null;
try {
  adaptBeqz(beqzTrace(0x42002006));
} catch (error) {
  impossibleBeqzFailure = error;
}
assert(
  impossibleBeqzFailure instanceof Error && impossibleBeqzFailure.message.includes("neither sequential"),
  "exact beqz timing accepted an impossible successor",
);
assert(
  scheduleExecution(independentLoadUse.input.cpu ?? []).events.map((event) => event.endCycle).join(",") === "1,2",
  "independent SRAM load changed the steady-state ready clock",
);
const externalBase = loadUseTrace(ADDX4_A4_A3_A5);
const externalLoadUse = Object.freeze({
  ...externalBase,
  records: Object.freeze(externalBase.records.map((record, index) =>
    index === 1 ? Object.freeze({ ...record, address: 0x3fcb0010 }) : record)),
});
assert(
  adaptLoadUse(externalLoadUse).input.cpu?.every(
    (event) => event.latency.status === "known" && event.latency.cycles === 1n,
  ),
  "load outside the caller-declared internal SRAM range gained a hazard cycle",
);
const exactRangeGap = adaptFlexeTraceToRuntimeTiming(loadUseTrace(ADDX4_A4_A3_A5), {
  source: "synthetic exact Flexe multi-range gap trace",
  sha256,
  core: 0,
}, {
  ...loadUseOptions,
  dependentSramLoadUseHazard: {
    ...loadUseOptions.dependentSramLoadUseHazard,
    internalSram: undefined,
    internalSramRanges: [
      { base: 0x3fc9f000, sizeBytes: 0x1000 },
      { base: 0x3fcb0000, sizeBytes: 0x1000 },
    ],
  },
});
assert(
  exactRangeGap.input.cpu?.length === 2,
  "separate exact SRAM ranges broadened classification across their gap",
);

const mismatchedBase = loadUseTrace(ADDX4_A4_A3_A5);
const mismatchedIssuer = Object.freeze({
  ...mismatchedBase,
  records: Object.freeze(mismatchedBase.records.map((record, index) =>
    index === 1 ? Object.freeze({ ...record, pc: 0x42001003 }) : record)),
});
expectLoadUseFailure(mismatchedIssuer, "issuer PC does not match");
const nonsequentialBase = loadUseTrace(ADDX4_A4_A3_A5);
const nonsequential = Object.freeze({
  ...nonsequentialBase,
  records: Object.freeze(nonsequentialBase.records.map((record, index) =>
    index === 2 ? Object.freeze({ ...record, pc: 0x42001006 }) : record)),
});
expectLoadUseFailure(nonsequential, "nonsequential successor");
expectLoadUseFailure(loadUseTrace(0x000003), "unsupported register-use form");
expectLoadUseFailure(loadUseTrace(ADDX4_A4_A3_A5, { overflow: true }), "complete non-overflow trace");
const dependentStoreBase = loadUseTrace(0x006232);
const dependentStore = adaptLoadUse(Object.freeze({
  ...dependentStoreBase,
  count: 4,
  records: Object.freeze([
    ...dependentStoreBase.records,
    Object.freeze({
      kind: TRACE_KINDS.write,
      pc: 0x42001003,
      address: 0x3fca0020,
      value: 0x12345678,
      width: 4,
      instruction: 0,
    }),
  ]),
}));
assert(
  JSON.stringify((dependentStore.input.issueOrder ?? []).slice(3)) === JSON.stringify([
    { kind: "memory", accessId: "trace:02:instruction-fetch" },
    { kind: "cpu", eventId: "trace:02:instruction-fetch:pre-data-cpu" },
    { kind: "memory", accessId: "trace:03:store" },
    { kind: "cpu", eventId: "trace:02:instruction-fetch:cpu" },
  ]),
  "dependent store hazard was not placed after fetch and before data",
);
let wrongLatencyFailure: unknown = null;
try {
  adaptFlexeTraceToRuntimeTiming(loadUseTrace(ADDX4_A4_A3_A5), {
    source: "synthetic wrong hazard latency",
    sha256,
    core: 0,
  }, {
    ...loadUseOptions,
    dependentSramLoadUseHazard: {
      ...loadUseOptions.dependentSramLoadUseHazard,
      latency: known(2n, "not the measured hazard"),
    },
  });
} catch (error) {
  wrongLatencyFailure = error;
}
assert(
  wrongLatencyFailure instanceof Error && wrongLatencyFailure.message.includes("exactly 1 cycle"),
  "Flexe bridge accepted a non-measured load-use latency",
);

console.log(JSON.stringify({
  records: accesses.length,
  cpuEvents: trace.input.cpu.length,
  bufferedFences: buffered.input.fence.length,
  dependentLoadUseCycles: dependentLoadUse.input.cpu[1]?.latency.status === "known"
    ? dependentLoadUse.input.cpu[1].latency.cycles.toString()
    : null,
  core: 1,
  sha256,
}));
