import { existsSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..", "..");
const SOURCE = join(import.meta.dir, "firmware", "fixture.c");
const DIST = join(import.meta.dir, "dist");
const OUTPUT = join(DIST, "storage-battery.wasm");
const ZIG = process.env.ZIG_EXE ?? "zig";

const EXPORTS = [
  "emu_device", "emu_init", "emu_tick", "emu_fb", "emu_push_count", "emu_push_x",
  "emu_push_y", "emu_push_w", "emu_push_h", "emu_touch", "emu_button",
  "emu_button_verdict", "emu_sensor_event", "emu_battery", "emu_storage_buffer",
  "emu_storage_capacity", "emu_storage_size", "emu_storage_revision", "emu_storage_load",
];

export function buildStorageFixture(): string {
  if (!existsSync(SOURCE)) throw new Error(`source not found: ${SOURCE}`);
  mkdirSync(DIST, { recursive: true });
  const args = [
    "cc", "-target", "wasm32-freestanding", "-O2", "-nostdlib", "-Wl,--no-entry",
    "-Wl,--import-symbols", ...EXPORTS.map((name) => `-Wl,--export=${name}`),
    "-I", join(ROOT, "wasm"), SOURCE, "-o", OUTPUT,
  ];
  let lastExit = -1;
  for (let attempt = 1; attempt <= 5; attempt++) {
    const result = Bun.spawnSync([ZIG, ...args], { stdout: "inherit", stderr: "inherit" });
    if (result.success) return OUTPUT;
    lastExit = result.exitCode;
    if (attempt < 5) Bun.sleepSync(300);
  }
  throw new Error(`zig cc exited ${lastExit} building the storage fixture`);
}

if (import.meta.main) console.log(buildStorageFixture());
