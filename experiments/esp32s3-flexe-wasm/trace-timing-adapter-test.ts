import { adaptFlexeTraceToRuntimeTiming } from "./trace-timing-adapter";
import {
  TRACE_ABI_VERSION,
  TRACE_HEADER_BYTES,
  TRACE_KINDS,
  TRACE_RECORD_BYTES,
  type DecodedTrace,
} from "./trace-abi";
import { XTENSA_MEMW_INSTRUCTION_ENCODING } from "../../packs/esp32-s3-touch-amoled-18/timing/trace-adapter";

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

console.log(JSON.stringify({
  records: accesses.length,
  cpuEvents: trace.input.cpu.length,
  bufferedFences: buffered.input.fence.length,
  core: 1,
  sha256,
}));
