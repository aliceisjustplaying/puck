import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runRuntimeTimingReport } from "./runtime-report";

const fixturePath = join(import.meta.dir, "fixtures", "runtime-sram-trace.json");

describe("pack runtime timing report", () => {
  test("replays the scoped SRAM fixture to a complete non-cycle-accurate result", async () => {
    const json = await runRuntimeTimingReport(fixturePath);
    expect(await runRuntimeTimingReport(fixturePath)).toBe(json);
    const result = JSON.parse(json);

    expect(result.status).toBe("complete");
    expect(result.claim).toMatchObject({
      architectureCalibration: "uncalibrated",
      coverage: "caller-reported-events-only",
      cycleAccurate: false,
      countsOnlyInstrumentedEvents: true,
      hostTraceTimeIsSimulatedTime: false,
    });
    expect(result.provenance).toMatchObject({
      source: "synthetic bounded ESP32-S3 runtime callback trace",
      format: "puck-esp32s3-runtime-trace-v1",
      bounds: { capacity: 4, observed: 4, overflow: false },
    });
    expect(result.provenance.digest.value).toMatch(/^[0-9a-f]{64}$/);
    expect(result.issuedEvents).toHaveLength(6);
    expect(result.claim.costCalibration).toBe("calibrated");
    expect(result.claim.unknownCostEventIds).toEqual([]);
    expect(result.claim.directUncalibratedEventIds).toEqual([]);
    expect(result.execution.status).toBe("complete");
    expect(result.execution.finalClocks.cores[0]).toEqual({
      status: "known",
      cycle: "2",
      calibration: "calibrated",
    });
    expect(result.issuedEvents.filter((event: { cost: { status: string } }) => event.cost.status === "known"))
      .toHaveLength(6);
    expect(result.issuedEvents.filter((event: { event: { kind: string } }) =>
      event.event.kind === "instruction-fetch"
    ).map((event: { cost: { cycles: string; source: string } }) => ({
      cycles: event.cost.cycles,
      source: event.cost.source.includes("internal SRAM instruction-fetch additive cost"),
    }))).toEqual([
      { cycles: "0", source: true },
      { cycles: "0", source: true },
    ]);
  });

  test("rejects schema drift before constructing a replay", async () => {
    const directory = mkdtempSync(join(tmpdir(), "puck-runtime-report-"));
    const path = join(directory, "bad.json");
    try {
      const artifact = JSON.parse(readFileSync(fixturePath, "utf8"));
      artifact.guessedCycles = 7;
      writeFileSync(path, `${JSON.stringify(artifact)}\n`);
      await expect(runRuntimeTimingReport(path)).rejects.toThrow("runtime trace keys must be exactly");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("reports an undeclared address as a machine fault", async () => {
    const directory = mkdtempSync(join(tmpdir(), "puck-runtime-report-"));
    const path = join(directory, "unmapped.json");
    try {
      const artifact = JSON.parse(readFileSync(fixturePath, "utf8"));
      artifact.observations[1].address = "0x3fcc0000";
      writeFileSync(path, `${JSON.stringify(artifact)}\n`);
      const result = JSON.parse(await runRuntimeTimingReport(path));
      expect(result.status).toBe("faulted");
      expect(result.cores[0].accesses[1].fault).toMatchObject({
        kind: "unmapped",
        atAddress: "1070333952",
      });
      expect(result.claim.cycleAccurate).toBe(false);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
