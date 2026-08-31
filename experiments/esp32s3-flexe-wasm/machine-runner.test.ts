import { join, resolve } from "node:path";
import { expect, test } from "bun:test";
import { DEFAULT_TINYDRAW_ESP32S3_ELF } from "./constants";
import { runEsp32S3ElfMachine } from "./machine-runner";

const modulePath = resolve(
  process.env.FLEXE_WASM_DIST ?? join(import.meta.dir, "dist"),
  "flexe-probe-freestanding.wasm",
);
const elfPath = resolve(process.env.ESP32S3_MACHINE_ELF ?? DEFAULT_TINYDRAW_ESP32S3_ELF);

test("real TinyDraw ELF crosses the sourced reset-reason ROM boundary", async () => {
  const run = await runEsp32S3ElfMachine(
    await Bun.file(modulePath).arrayBuffer(),
    new Uint8Array(await Bun.file(elfPath).arrayBuffer()),
    1_000,
  );

  expect(run.stop).toMatchObject({
    abiVersion: 2,
    reasonName: "unmappedExecute",
    steps: 19,
    pc: 0x4000_11e8,
    faultAddress: 0x4000_11e8,
    vecbase: 0x4037_4000,
    ps: 0x0006_0000,
    stackPointer: 0x3fce_b6d0,
    romResetReasonCalls: 2,
    resetReason: 1,
  });
  expect(run.logs).toEqual([]);
  expect(run.claim).toMatchObject({
    architectureCalibration: "uncalibrated",
    cycleAccurate: false,
    rom: "esp-rom-reset-reason-api-only",
  });
});
