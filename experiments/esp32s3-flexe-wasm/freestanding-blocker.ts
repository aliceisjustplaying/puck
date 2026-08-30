import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DEFAULT_FLEXE_SOURCE } from "./constants";
import { run, verifySource } from "./lib";

const source = resolve(process.env.FLEXE_SOURCE ?? DEFAULT_FLEXE_SOURCE);
const zig = process.env.ZIG_EXE ?? "zig";
verifySource(source);

const stage = mkdtempSync(join(tmpdir(), "puck-flexe-freestanding-"));
try {
  const result = run(
    [
      zig,
      "cc",
      "-target",
      "wasm32-freestanding",
      "-std=c17",
      "-O2",
      "-DPREDECODE_FLASH_MB=0",
      "-Isrc",
      "-c",
      "src/xtensa.c",
      "-o",
      join(stage, "xtensa.o")
    ],
    source,
    {
      ZIG_GLOBAL_CACHE_DIR: join(stage, "zig-global-cache"),
      ZIG_LOCAL_CACHE_DIR: join(stage, "zig-local-cache")
    }
  );
  const diagnostic = `${result.stdout}${result.stderr}`;
  if (result.exitCode === 0 || !diagnostic.includes("fatal error: 'string.h' file not found")) {
    throw new Error(
      `expected the pinned source to stop at the freestanding libc boundary, got exit ${result.exitCode}\n${diagnostic}`
    );
  }
  console.log("blocked: wasm32-freestanding has no string.h for flexe memory.h");
} finally {
  rmSync(stage, { recursive: true, force: true });
}

