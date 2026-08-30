#!/usr/bin/env bun

import { resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "../../..");
const checks = [
  {
    name: "pack checks",
    command: [process.execPath, "run", "packs/esp32-s3-touch-amoled-18/gate/run.ts"],
  },
  {
    name: "timing tests",
    command: [process.execPath, "run", "pack:esp32:timing:test"],
  },
] as const;

const failures: string[] = [];
for (const check of checks) {
  console.log(`\n== ${check.name} ==`);
  try {
    const result = Bun.spawnSync({
      cmd: [...check.command],
      cwd: ROOT,
      stdout: "inherit",
      stderr: "inherit",
    });
    if (result.exitCode !== 0) failures.push(check.name);
  } catch (error) {
    failures.push(check.name);
    console.error(error instanceof Error ? error.message : String(error));
  }
}

if (failures.length > 0) {
  console.error(`\nFAIL: ${failures.join(", ")}`);
  process.exit(1);
}

console.log(`\nPASS: ${checks.length} ESP32-S3 gate groups`);
