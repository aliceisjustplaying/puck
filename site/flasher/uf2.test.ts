// site/flasher/uf2.test.ts: parses the two real, verified UF2 artifacts
// this gallery ships (site/flash-artifacts/, copied into site/dist/flash/
// by site/build.ts) and checks the parser's numbers against what
// `picotool info -a` reported for each when they were built. No hardware,
// no USB: this is exactly why uf2.ts's parsing is kept pure.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { FAMILY_RP2350_ARM_S, FLASH_SECTOR_SIZE, Uf2ParseError, computeFlashPlan, parseUf2, parseUf2Blocks } from "./uf2";

const DIR = join(import.meta.dir, "..", "flash-artifacts");

function loadArtifact(name: string): Uint8Array {
  const buf = readFileSync(join(DIR, name));
  return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
}

describe("puck-full.uf2 (full firmware, boots chrono)", () => {
  const bytes = loadArtifact("puck-full.uf2");
  const { blocks, familyGroups } = parseUf2(bytes);

  test("has 380 total blocks", () => {
    expect(blocks.length).toBe(380);
  });

  test("has one absolute/info block (family 0xE48BFF57) and 379 rp2350-arm-s blocks", () => {
    expect(familyGroups.get(0xe48bff57)?.length).toBe(1);
    expect(familyGroups.get(FAMILY_RP2350_ARM_S)?.length).toBe(379);
  });

  test("every rp2350-arm-s block carries a contiguous 256-byte payload", () => {
    const family = familyGroups.get(FAMILY_RP2350_ARM_S)!;
    for (const b of family) expect(b.payloadSize).toBe(256);
  });

  test("flash plan: range starts at 0x10000000 and covers picotool's reported binary end (0x10017a70)", () => {
    const plan = computeFlashPlan(blocks, FAMILY_RP2350_ARM_S);
    const BINARY_END = 0x10017a70;
    expect(plan.rangeStart).toBe(0x10000000);
    expect(plan.rangeEnd).toBeGreaterThanOrEqual(BINARY_END);
    expect(plan.chunks.length).toBe(379);
  });

  test("erase range is 4096-aligned and covers the binary end", () => {
    const plan = computeFlashPlan(blocks, FAMILY_RP2350_ARM_S);
    const BINARY_END = 0x10017a70;
    expect(plan.eraseStart % FLASH_SECTOR_SIZE).toBe(0);
    expect(plan.eraseEnd % FLASH_SECTOR_SIZE).toBe(0);
    expect(plan.eraseStart).toBeLessThanOrEqual(plan.rangeStart);
    expect(plan.eraseEnd).toBeGreaterThanOrEqual(BINARY_END);
  });
});

describe("fluidbox-rp2350.uf2 (single-app fluid build)", () => {
  const bytes = loadArtifact("fluidbox-rp2350.uf2");
  const { blocks, familyGroups } = parseUf2(bytes);

  // Refreshed after apps/fluidbox/ports/rp2350-touch-amoled-18/fluid.c's
  // emu_shim_tilt_get() changed from a plain `extern` declaration to a weak
  // default definition (the fix for the native single-app build's
  // undefined-reference failure - the emulator's own emu_shim.c still
  // provides the strong, real definition that wins in that build, see that
  // function's own comment): the weak function body adds a handful of
  // instructions to the native single-app link, so the built binary is
  // slightly bigger and its block count and reported binary end both moved
  // up from the previous artifact's numbers.

  test("has 306 total blocks", () => {
    expect(blocks.length).toBe(306);
  });

  test("has one absolute/info block and 305 rp2350-arm-s blocks", () => {
    expect(familyGroups.get(0xe48bff57)?.length).toBe(1);
    expect(familyGroups.get(FAMILY_RP2350_ARM_S)?.length).toBe(305);
  });

  test("every rp2350-arm-s block carries a contiguous 256-byte payload", () => {
    const family = familyGroups.get(FAMILY_RP2350_ARM_S)!;
    for (const b of family) expect(b.payloadSize).toBe(256);
  });

  test("flash plan: range starts at 0x10000000 and covers picotool's reported binary end (0x10013004)", () => {
    const plan = computeFlashPlan(blocks, FAMILY_RP2350_ARM_S);
    const BINARY_END = 0x10013004;
    expect(plan.rangeStart).toBe(0x10000000);
    expect(plan.rangeEnd).toBeGreaterThanOrEqual(BINARY_END);
    expect(plan.chunks.length).toBe(305);
  });

  test("erase range is 4096-aligned and covers the binary end", () => {
    const plan = computeFlashPlan(blocks, FAMILY_RP2350_ARM_S);
    const BINARY_END = 0x10013004;
    expect(plan.eraseStart % FLASH_SECTOR_SIZE).toBe(0);
    expect(plan.eraseEnd % FLASH_SECTOR_SIZE).toBe(0);
    expect(plan.eraseStart).toBeLessThanOrEqual(plan.rangeStart);
    expect(plan.eraseEnd).toBeGreaterThanOrEqual(BINARY_END);
  });
});

describe("parser error handling", () => {
  test("rejects a length that isn't a multiple of 512", () => {
    expect(() => parseUf2Blocks(new Uint8Array(511))).toThrow(Uf2ParseError);
  });

  test("rejects a block with a bad start magic", () => {
    const bytes = loadArtifact("fluidbox-rp2350.uf2").slice();
    bytes[0] = 0x00; // corrupt magicStart0 of the first block
    expect(() => parseUf2Blocks(bytes)).toThrow(Uf2ParseError);
  });

  test("computeFlashPlan throws for a family with no blocks", () => {
    const bytes = loadArtifact("fluidbox-rp2350.uf2");
    const { blocks } = parseUf2(bytes);
    expect(() => computeFlashPlan(blocks, 0xdeadbeef)).toThrow(Uf2ParseError);
  });
});
