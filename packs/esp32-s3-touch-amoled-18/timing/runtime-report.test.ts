import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runRuntimeTimingReport } from "./runtime-report";

const fixturePath = join(import.meta.dir, "fixtures", "runtime-sram-trace.json");

describe("pack runtime timing report", () => {
  test("replays bounded runtime callbacks through the timing machine without hiding unknown costs", async () => {
    const json = await runRuntimeTimingReport(fixturePath);
    expect(await runRuntimeTimingReport(fixturePath)).toBe(json);
    const result = JSON.parse(json);

    expect(result.status).toBe("blocked");
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
    expect(result.claim.unknownCostEventIds).toEqual([
      "cache:runtime:fetch:0:segment:0:cache:0:sram-bypass",
      "cache:runtime:fetch:1:segment:0:cache:0:sram-bypass",
    ]);
    expect(result.claim.directUncalibratedEventIds).toEqual([]);
    expect(result.execution.status).toBe("blocked");
    expect(result.issuedEvents.filter((event: { cost: { status: string } }) => event.cost.status === "known"))
      .toHaveLength(4);
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
      expect(result.status).toBe("faulted-and-blocked");
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
