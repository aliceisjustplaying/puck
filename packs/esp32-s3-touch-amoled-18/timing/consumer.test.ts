import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  SNAPSHOT_V1_BYTES,
  SNAPSHOT_V1_FIELDS,
  buildTimingReport,
  decodeOptionalTimingExports,
  parseTimingProfile,
  stableTimingJson,
  type TimingProfileV1,
} from "./consumer";

const SCHEMA_POINTER = 64;
const SNAPSHOT_POINTER = 4_096;

function profileObject(): Record<string, unknown> {
  return {
    schemaVersion: 1,
    claimBoundary: {
      mode: "shadow-ledger",
      cycleAccurate: false,
      countsOnlyInstrumentedEvents: true,
      hostTraceTimeIsSimulatedTime: false,
    },
    cpu: { cores: 2, hz: 240_000_000, frequencyStatus: "configured" },
    psram: {
      mode: "octal",
      dtr: true,
      busHz: 80_000_000,
      frequencyStatus: "configured",
      calibrated: false,
      throughputBytesPerSecond: null,
    },
    flash: {
      mode: "qio",
      hz: null,
      frequencyStatus: "unknown",
      calibrated: false,
      throughputBytesPerSecond: null,
    },
    panel: {
      interface: "qspi",
      lanes: 4,
      busHz: 40_000_000,
      frequencyStatus: "measured",
      frequencyCalibrated: true,
      bitsPerPixel: 16,
      payloadBytesPerSecond: 20_000_000,
      throughputCalibrated: false,
      payloadStatus: "derived-from-measured-frequency",
    },
  };
}

function schemaObject(): Record<string, unknown> {
  return {
    schemaVersion: 1,
    byteOrder: "little",
    snapshotBytes: SNAPSHOT_V1_BYTES,
    claim: "accounted-events-only",
    cpuHz: 240_000_000,
    panelBusHz: 40_000_000,
    panelLanes: 4,
    panelPayloadBytesPerSecond: 20_000_000,
    observationReset: "start-of-emu_tick",
    scopes: {
      schema: "schema",
      sequence: "instance-monotonic",
      live: "instance-live",
      observation: "since-last-reset",
      lifetime: "instance-lifetime",
    },
    fields: SNAPSHOT_V1_FIELDS,
  };
}

interface SyntheticOptions {
  readonly schema?: Record<string, unknown>;
  readonly schemaPointer?: number;
  readonly snapshotPointer?: number;
  readonly exportedSize?: number;
  readonly headerVersion?: number;
  readonly headerSize?: number;
}

function syntheticExports(options: SyntheticOptions = {}): Record<string, unknown> {
  const memory = new WebAssembly.Memory({ initial: 1 });
  const schemaPointer = options.schemaPointer ?? SCHEMA_POINTER;
  const snapshotPointer = options.snapshotPointer ?? SNAPSHOT_POINTER;
  const exportedSize = options.exportedSize ?? SNAPSHOT_V1_BYTES;
  const bytes = new Uint8Array(memory.buffer);
  if (schemaPointer >= 0 && schemaPointer < bytes.byteLength) {
    const schemaBytes = new TextEncoder().encode(JSON.stringify(options.schema ?? schemaObject()));
    bytes.set(schemaBytes.subarray(0, Math.max(0, bytes.byteLength - schemaPointer - 1)), schemaPointer);
    if (schemaPointer + schemaBytes.length < bytes.byteLength) bytes[schemaPointer + schemaBytes.length] = 0;
  }
  if (snapshotPointer >= 0 && snapshotPointer + SNAPSHOT_V1_BYTES <= bytes.byteLength) {
    const view = new DataView(memory.buffer, snapshotPointer, SNAPSHOT_V1_BYTES);
    view.setUint32(0, options.headerVersion ?? 1, true);
    view.setUint32(4, options.headerSize ?? SNAPSHOT_V1_BYTES, true);
    const values: Partial<Record<(typeof SNAPSHOT_V1_FIELDS)[number][0], bigint>> = {
      observation_sequence: 0n,
      internal_allocation_live_bytes: 65_536n,
      psram_allocation_live_bytes: 329_728n,
      unclassified_allocation_live_bytes: 0n,
      internal_read_bytes: 329_728n,
      internal_write_bytes: 329_728n,
      psram_read_bytes: 329_728n,
      psram_write_bytes: 0n,
      flash_read_bytes: 0n,
      flash_write_bytes: 0n,
      unclassified_read_bytes: 0n,
      unclassified_write_bytes: 0n,
      panel_write_bytes: 329_728n,
      panel_submit_count: 11n,
      panel_wire_clocks: 659_456n,
      panel_payload_cpu_cycles: 3_956_736n,
      allocation_registry_overflow_count: 0n,
    };
    for (const [name, offset, type] of SNAPSHOT_V1_FIELDS) {
      if (type === "u64") view.setBigUint64(offset, values[name] ?? 0n, true);
    }
  }
  return {
    memory,
    emu_timing_schema: () => schemaPointer,
    emu_timing_snapshot: () => snapshotPointer,
    emu_timing_snapshot_size: () => exportedSize,
  };
}

function clone(value: Record<string, unknown>): Record<string, unknown> {
  return structuredClone(value) as Record<string, unknown>;
}

describe("decodeOptionalTimingExports", () => {
  test("gracefully reports that all optional timing exports are absent", () => {
    expect(decodeOptionalTimingExports({ memory: new WebAssembly.Memory({ initial: 1 }) })).toEqual({
      status: "absent",
    });
  });

  test("rejects a partial optional export surface", () => {
    expect(() =>
      decodeOptionalTimingExports({
        memory: new WebAssembly.Memory({ initial: 1 }),
        emu_timing_schema: () => 1,
      }),
    ).toThrow("timing exports are partial");
  });

  test("rejects schema and snapshot pointers outside memory", () => {
    expect(() => decodeOptionalTimingExports(syntheticExports({ schemaPointer: 70_000 }))).toThrow(
      "timing schema pointer is outside wasm memory",
    );
    expect(() => decodeOptionalTimingExports(syntheticExports({ snapshotPointer: 65_500 }))).toThrow(
      "timing snapshot layout exceeds wasm memory",
    );
  });

  test("rejects layout and schema drift", () => {
    expect(() => decodeOptionalTimingExports(syntheticExports({ exportedSize: 136 }))).toThrow(
      "expected 144",
    );
    expect(() => decodeOptionalTimingExports(syntheticExports({ headerSize: 136 }))).toThrow(
      "header size 136",
    );
    expect(() => decodeOptionalTimingExports(syntheticExports({ headerVersion: 2 }))).toThrow(
      "version 2 is unsupported",
    );

    const badSchema = schemaObject();
    badSchema.fields = SNAPSHOT_V1_FIELDS.map((field, index) =>
      index === 2 ? [field[0], 16, field[2], field[3]] : field,
    );
    expect(() => decodeOptionalTimingExports(syntheticExports({ schema: badSchema }))).toThrow(
      "does not match snapshot v1 layout",
    );
  });
});

describe("timing profile claim boundary", () => {
  test("parses the checked-in timing profile", async () => {
    const value = await Bun.file(join(import.meta.dir, "..", "timing.json")).json();
    expect(parseTimingProfile(value).claimBoundary.mode).toBe("shadow-ledger");
  });

  test("rejects cycle, host-time, memory, and panel-throughput overclaims", () => {
    const cycle = clone(profileObject());
    (cycle.claimBoundary as Record<string, unknown>).cycleAccurate = true;
    expect(() => parseTimingProfile(cycle)).toThrow("cycleAccurate must be false");

    const hostTime = clone(profileObject());
    (hostTime.claimBoundary as Record<string, unknown>).hostTraceTimeIsSimulatedTime = true;
    expect(() => parseTimingProfile(hostTime)).toThrow("hostTraceTimeIsSimulatedTime must be false");

    const psram = clone(profileObject());
    (psram.psram as Record<string, unknown>).calibrated = true;
    expect(() => parseTimingProfile(psram)).toThrow("psram.calibrated must be false");

    const panel = clone(profileObject());
    (panel.panel as Record<string, unknown>).throughputCalibrated = true;
    expect(() => parseTimingProfile(panel)).toThrow("panel.throughputCalibrated must be false");
  });
});

describe("stable combined report", () => {
  const profile: TimingProfileV1 = parseTimingProfile(profileObject());

  test("combines the accounted startup ledger with an explicitly uncalibrated schedule", () => {
    const availability = decodeOptionalTimingExports(syntheticExports());
    const report = buildTimingReport(availability, profile);
    expect(report.timingExports).toBe("present");
    expect(report.ledger?.status).toBe("accounted-events-only");
    expect(report.ledger?.values.panel_write_bytes).toBe(329_728n);
    expect(report.scheduler?.status).toBe("uncalibrated");
    expect(report.scheduler?.uncalibratedInputs).toEqual([
      "cpuProducer.clock",
      "producerCost",
      "panelDmaCost",
    ]);
    expect(report.scheduler?.result.strips).toHaveLength(11);
    expect(report.scheduler?.result.strips.at(-1)?.bytes).toBe(2_048);
  });

  test("emits stable JSON and decimal strings for every bigint", () => {
    const availability = decodeOptionalTimingExports(syntheticExports());
    const first = stableTimingJson(buildTimingReport(availability, profile));
    const second = stableTimingJson(buildTimingReport(availability, profile));
    expect(second).toBe(first);
    expect(first).toContain('"panel_write_bytes": "329728"');
    expect(first).toContain('"status": "uncalibrated"');
  });

  test("keeps absence successful and explicit in JSON", () => {
    const report = buildTimingReport({ status: "absent" }, profile);
    expect(JSON.parse(stableTimingJson(report))).toEqual({
      reportVersion: 1,
      timingExports: "absent",
      claimBoundary: profile.claimBoundary,
      ledger: null,
      scheduler: null,
    });
  });
});
