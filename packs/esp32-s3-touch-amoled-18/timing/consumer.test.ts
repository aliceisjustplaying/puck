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
    coreSteadyStateCycles: {
      status: "partially-calibrated",
      evidence: "timing/evidence/synthetic-sram-evidence.json",
      instructionIssueCycles: 1,
      independentSramAccessAdditiveCycles: { instructionFetch: 0, load: 0, store: 0 },
      dependentLoadUseHazard: {
        status: "unmodeled",
        observedAdditionalCycles: 1,
        reason: "synthetic traces have no register dependencies",
      },
      conditionalBranchCycles: {
        status: "partially-calibrated",
        evidence: "timing/evidence/synthetic-beqz-adoption.json",
        beqz: { notTaken: 1, taken: 3 },
      },
    },
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
      hz: 80_000_000,
      frequencyStatus: "configured",
      calibrated: false,
      throughputBytesPerSecond: null,
    },
    cacheLineFillCycles: {
      status: "calibrated",
      evidence: "timing/evidence/synthetic-cache-burst-adoption.json",
      instruction: {
        flash: { firstLineCycles: 204, subsequentLineCycles: 266 },
        psram: null,
      },
      data: {
        flash: { firstLineCycles: 115, subsequentLineCycles: 473 },
        psram: { firstLineCycles: 82, subsequentLineCycles: 170 },
      },
    },
    cacheHitAdditiveCycles: {
      status: "partially-calibrated",
      evidence: "timing/evidence/synthetic-hot-hit-adoption.json",
      instructionFetch: 0,
      load: 0,
      store: null,
    },
    mmioAccessCycles: {
      status: "partially-calibrated",
      evidence: "timing/evidence/synthetic-mmio-adoption.json",
      entries: [
        {
          address: "0x600c0010",
          operation: "read",
          bytes: 4,
          peripheral: "system-controller",
          cycles: 8,
        },
        {
          address: "0x600c4130",
          operation: "read",
          bytes: 4,
          peripheral: "cache-controller",
          cycles: 8,
        },
      ],
    },
    romCallbackCycles: {
      status: "partially-calibrated",
      evidence: "timing/evidence/synthetic-rom-callback-adoption.json",
      entries: [
        {
          kind: "memset",
          pc: "0x400011e8",
          destination: "0x50000000",
          value: 0,
          length: 0,
          cycles: 31,
        },
      ],
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
    const profile = parseTimingProfile(value);
    expect(profile.claimBoundary.mode).toBe("shadow-ledger");
    expect(profile.cacheLineFillCycles.data.flash).toEqual({
      firstLineCycles: 115,
      subsequentLineCycles: 473,
    });
    expect(profile.cacheHitAdditiveCycles).toEqual({
      status: "partially-calibrated",
      evidence:
        "packs/esp32-s3-touch-amoled-18/timing/evidence/esp32s3-rev02-tinydraw-1ddd64b-4a2c659-hot-hit-adoption.json",
      instructionFetch: 0,
      load: 0,
      store: null,
    });
    expect(profile.mmioAccessCycles).toEqual({
      status: "partially-calibrated",
      evidence:
        "packs/esp32-s3-touch-amoled-18/timing/evidence/esp32s3-rev02-tinydraw-e8a9f0e-mmio-write-adoption.json",
      entries: [
        {
          address: "0x600c0010",
          operation: "read",
          bytes: 4,
          peripheral: "system-controller",
          cycles: 8,
        },
        {
          address: "0x600c0060",
          operation: "read",
          bytes: 4,
          peripheral: "system-controller",
          cycles: 8,
        },
        {
          address: "0x600c0060",
          operation: "write",
          bytes: 4,
          peripheral: "system-controller",
          writeEffect: "same-value",
          cycles: 3,
        },
        {
          address: "0x600c4004",
          operation: "read",
          bytes: 4,
          peripheral: "cache-controller",
          cycles: 8,
        },
        {
          address: "0x600c4004",
          operation: "write",
          bytes: 4,
          peripheral: "cache-controller",
          writeEffect: "same-value",
          cycles: 3,
        },
        {
          address: "0x600c404c",
          operation: "read",
          bytes: 4,
          peripheral: "cache-controller",
          cycles: 8,
        },
        {
          address: "0x600c4064",
          operation: "read",
          bytes: 4,
          peripheral: "cache-controller",
          cycles: 8,
        },
        {
          address: "0x600c4064",
          operation: "write",
          bytes: 4,
          peripheral: "cache-controller",
          writeEffect: "same-value",
          cycles: 3,
        },
        {
          address: "0x600c40a0",
          operation: "read",
          bytes: 4,
          peripheral: "cache-controller",
          cycles: 8,
        },
        {
          address: "0x600c4130",
          operation: "read",
          bytes: 4,
          peripheral: "cache-controller",
          cycles: 8,
        },
      ],
    });
    expect(profile.romCallbackCycles).toEqual({
      status: "partially-calibrated",
      evidence:
        "packs/esp32-s3-touch-amoled-18/timing/evidence/esp32s3-rev02-tinydraw-d42615b-xtos-intlevel-adoption.json",
      entries: [
        { kind: "memset", pc: "0x400011e8", destination: "0x3fcabe60", value: 0, length: 0x52e0, cycles: 6_659 },
        { kind: "memset", pc: "0x400011e8", destination: "0x50000000", value: 0, length: 0, cycles: 31 },
        { kind: "cpuTicksPerUs", pc: "0x40001a4c", ticksPerUs: 40, callinc: 2, cycles: 9 },
        {
          kind: "intlevelRestore",
          pc: "0x40001c38",
          restorePs: "0x00040c00",
          previousPs: "0x00040c03",
          callinc: 2,
          cycles: 15,
        },
        {
          kind: "bbpllRomWrite",
          pc: "0x40005d60",
          block: 0x66,
          hostId: 1,
          register: 4,
          data: 0x6b,
          callinc: 2,
          currentIntlevel: 3,
          priorIntlevelRestoreCount: 1,
          priorWriteCount: 0,
          cycles: 836,
        },
      ],
    });
    expect(profile.coreSteadyStateCycles).toEqual({
      status: "partially-calibrated",
      evidence:
        "packs/esp32-s3-touch-amoled-18/timing/evidence/esp32s3-rev02-tinydraw-bf169bc-counters-candidate.json",
      instructionIssueCycles: 1,
      independentSramAccessAdditiveCycles: { instructionFetch: 0, load: 0, store: 0 },
      dependentLoadUseHazard: {
        status: "unmodeled",
        observedAdditionalCycles: 1,
        reason: "runtime traces do not identify register dependencies",
      },
      conditionalBranchCycles: {
        status: "partially-calibrated",
        evidence:
          "packs/esp32-s3-touch-amoled-18/timing/evidence/esp32s3-rev02-tinydraw-2bf3ffd-beqz-adoption.json",
        beqz: { notTaken: 1, taken: 3 },
      },
    });
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

    const incompleteCache = clone(profileObject());
    (incompleteCache.cacheLineFillCycles as Record<string, unknown>).status = "candidate";
    expect(() => parseTimingProfile(incompleteCache)).toThrow(
      'cacheLineFillCycles.status must be "calibrated"',
    );

    const changedIssue = clone(profileObject());
    (changedIssue.coreSteadyStateCycles as Record<string, unknown>).instructionIssueCycles = 2;
    expect(() => parseTimingProfile(changedIssue)).toThrow(
      "coreSteadyStateCycles.instructionIssueCycles must be 1",
    );

    const additiveLoad = clone(profileObject());
    const additive = (additiveLoad.coreSteadyStateCycles as Record<string, unknown>)
      .independentSramAccessAdditiveCycles as Record<string, unknown>;
    additive.load = 1;
    expect(() => parseTimingProfile(additiveLoad)).toThrow(
      "independentSramAccessAdditiveCycles.load must be 0",
    );

    const cacheHitStore = clone(profileObject());
    (cacheHitStore.cacheHitAdditiveCycles as Record<string, unknown>).store = 0;
    expect(() => parseTimingProfile(cacheHitStore)).toThrow(
      "cacheHitAdditiveCycles.store must be null",
    );

    const modeledHazard = clone(profileObject());
    const hazard = (modeledHazard.coreSteadyStateCycles as Record<string, unknown>)
      .dependentLoadUseHazard as Record<string, unknown>;
    hazard.status = "calibrated";
    expect(() => parseTimingProfile(modeledHazard)).toThrow(
      'dependentLoadUseHazard.status must be "unmodeled"',
    );

    const changedHazard = clone(profileObject());
    const changedHazardValue = (changedHazard.coreSteadyStateCycles as Record<string, unknown>)
      .dependentLoadUseHazard as Record<string, unknown>;
    changedHazardValue.observedAdditionalCycles = 2;
    expect(() => parseTimingProfile(changedHazard)).toThrow(
      "dependentLoadUseHazard.observedAdditionalCycles must be 1",
    );

    const changedBeqz = clone(profileObject());
    const beqz = ((changedBeqz.coreSteadyStateCycles as Record<string, unknown>)
      .conditionalBranchCycles as Record<string, unknown>).beqz as Record<string, unknown>;
    beqz.taken = 2;
    expect(() => parseTimingProfile(changedBeqz)).toThrow(
      "conditionalBranchCycles.beqz.taken must be 3",
    );

    const broadMmioAddress = clone(profileObject());
    const broadEntries = (broadMmioAddress.mmioAccessCycles as Record<string, unknown>).entries as
      Record<string, unknown>[];
    broadEntries[0]!.address = "0x600c0000/0x1000";
    expect(() => parseTimingProfile(broadMmioAddress)).toThrow(
      "address must be one canonical lowercase 32-bit hex address",
    );

    const duplicateMmio = clone(profileObject());
    const duplicateEntries = (duplicateMmio.mmioAccessCycles as Record<string, unknown>).entries as
      Record<string, unknown>[];
    duplicateEntries[1] = structuredClone(duplicateEntries[0]!);
    expect(() => parseTimingProfile(duplicateMmio)).toThrow("must not contain duplicate access classes");

    const readWriteEffect = clone(profileObject());
    const readWriteEffectEntries = (readWriteEffect.mmioAccessCycles as Record<string, unknown>).entries as
      Record<string, unknown>[];
    readWriteEffectEntries[0]!.writeEffect = "same-value";
    expect(() => parseTimingProfile(readWriteEffect)).toThrow(
      "writeEffect is only valid for a write operation",
    );

    const invalidWriteEffect = clone(profileObject());
    const invalidWriteEntries = (invalidWriteEffect.mmioAccessCycles as Record<string, unknown>).entries as
      Record<string, unknown>[];
    invalidWriteEntries.splice(1, 0, {
      address: "0x600c0010",
      operation: "write",
      bytes: 4,
      peripheral: "system-controller",
      writeEffect: "changed-value",
      cycles: 3,
    });
    expect(() => parseTimingProfile(invalidWriteEffect)).toThrow("writeEffect must be same-value");

    const broadRomPc = clone(profileObject());
    const broadRomEntries = (broadRomPc.romCallbackCycles as Record<string, unknown>).entries as
      Record<string, unknown>[];
    broadRomEntries[0]!.pc = "0x400011e8/0x100";
    expect(() => parseTimingProfile(broadRomPc)).toThrow(
      "pc must be one canonical lowercase 32-bit hex address",
    );

    const duplicateRom = clone(profileObject());
    const duplicateRomEntries = (duplicateRom.romCallbackCycles as Record<string, unknown>).entries as
      Record<string, unknown>[];
    duplicateRomEntries.push(structuredClone(duplicateRomEntries[0]!));
    expect(() => parseTimingProfile(duplicateRom)).toThrow("must not contain duplicate callback classes");
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
