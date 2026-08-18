// Locates the arm-none-eabi binutils this checker parses instead of writing
// an ELF parser (docs/decisions/0006's whole point). `PICO_TOOLCHAIN_PATH`,
// if set, wins - the same variable the build instructions in packs/rp2350-touch-amoled-18/README.md
// set - otherwise this tries the Arm GNU Toolchain installer's default
// location on Windows, and finally falls back to a bare PATH lookup, which is
// what makes this work unchanged on Linux and macOS.

import { existsSync } from "node:fs";
import { join } from "node:path";

const FALLBACK_DIR =
  "C:\\Program Files (x86)\\Arm GNU Toolchain arm-none-eabi\\14.2 rel1\\bin";

function resolve(tool: string): string {
  const dir = process.env.PICO_TOOLCHAIN_PATH
    ? join(process.env.PICO_TOOLCHAIN_PATH, "bin")
    : FALLBACK_DIR;
  for (const candidate of [join(dir, `${tool}.exe`), join(dir, tool)]) {
    if (existsSync(candidate)) return candidate;
  }
  return tool; // last resort: hope it's on PATH
}

export const OBJDUMP = resolve("arm-none-eabi-objdump");
export const NM = resolve("arm-none-eabi-nm");
