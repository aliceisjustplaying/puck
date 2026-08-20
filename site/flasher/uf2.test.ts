// site/flasher/uf2.test.ts: parses the two real, verified UF2 artifacts
// this gallery ships (site/flash-artifacts/, copied into site/dist/flash/
// by site/build.ts) and checks the parser's numbers against what
// `picotool info -a` reported for each when they were built. No hardware,
// no USB: this is exactly why uf2.ts's parsing is kept pure.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  FAMILY_RP2350_ARM_S,
  FLASH_SECTOR_SIZE,
  PICOBOOT_MAX_ERASE_SPAN,
  PICOBOOT_MAX_WRITE_SIZE,
  Uf2ParseError,
  coalesceWriteRuns,
  computeFlashPlan,
  parseUf2,
  parseUf2Blocks,
  planEraseSpans,
} from "./uf2";

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

  // Refreshed after apps/fluidbox/ports/rp2350-touch-amoled-18/fluid.c
  // dropped the private emu_shim_tilt_get() weak-hook path entirely and
  // started reading f->tilt (app_frame_t.tilt) instead - real firmware
  // (firmware/runtime/runtime_core.c and tilt.c) that this single-app
  // native build has always linked in, but the app itself now calls
  // through app_frame_t rather than a private accessor. The built binary's
  // size, block count and reported binary end moved up a little from the
  // previous artifact's numbers (checked with `picotool info -a` against
  // this rebuilt artifact, same as the previous numbers were).

  test("has 330 total blocks", () => {
    expect(blocks.length).toBe(330);
  });

  test("has one absolute/info block and 329 rp2350-arm-s blocks", () => {
    expect(familyGroups.get(0xe48bff57)?.length).toBe(1);
    expect(familyGroups.get(FAMILY_RP2350_ARM_S)?.length).toBe(329);
  });

  test("every rp2350-arm-s block carries a contiguous 256-byte payload", () => {
    const family = familyGroups.get(FAMILY_RP2350_ARM_S)!;
    for (const b of family) expect(b.payloadSize).toBe(256);
  });

  test("flash plan: range starts at 0x10000000 and covers picotool's reported binary end (0x10014814)", () => {
    const plan = computeFlashPlan(blocks, FAMILY_RP2350_ARM_S);
    const BINARY_END = 0x10014814;
    expect(plan.rangeStart).toBe(0x10000000);
    expect(plan.rangeEnd).toBeGreaterThanOrEqual(BINARY_END);
    expect(plan.chunks.length).toBe(329);
  });

  test("erase range is 4096-aligned and covers the binary end", () => {
    const plan = computeFlashPlan(blocks, FAMILY_RP2350_ARM_S);
    const BINARY_END = 0x10014814;
    expect(plan.eraseStart % FLASH_SECTOR_SIZE).toBe(0);
    expect(plan.eraseEnd % FLASH_SECTOR_SIZE).toBe(0);
    expect(plan.eraseStart).toBeLessThanOrEqual(plan.rangeStart);
    expect(plan.eraseEnd).toBeGreaterThanOrEqual(BINARY_END);
  });
});

describe("coalesceWriteRuns", () => {
  function chunk(addr: number, byte: number, size = 256) {
    return { addr, data: new Uint8Array(size).fill(byte) };
  }

  test("empty input yields no runs", () => {
    expect(coalesceWriteRuns([])).toEqual([]);
  });

  test("contiguous chunks merge into one run, payload bytes preserved in order", () => {
    const chunks = [chunk(0x10000000, 0xaa), chunk(0x10000100, 0xbb), chunk(0x10000200, 0xcc)];
    const runs = coalesceWriteRuns(chunks);
    expect(runs.length).toBe(1);
    expect(runs[0]!.addr).toBe(0x10000000);
    expect(runs[0]!.data.length).toBe(768);
    expect(runs[0]!.data[0]).toBe(0xaa);
    expect(runs[0]!.data[256]).toBe(0xbb);
    expect(runs[0]!.data[512]).toBe(0xcc);
  });

  test("a gap between chunks starts a new run even though the cap isn't reached", () => {
    // second chunk starts a full sector past where the first one ends: a
    // producer-padded gap, per computeFlashPlan's own comment.
    const chunks = [chunk(0x10000000, 0xaa), chunk(0x10001000, 0xbb)];
    const runs = coalesceWriteRuns(chunks);
    expect(runs.length).toBe(2);
    expect(runs[0]).toEqual({ addr: 0x10000000, data: chunks[0]!.data });
    expect(runs[1]).toEqual({ addr: 0x10001000, data: chunks[1]!.data });
  });

  test("a run is capped at maxRunSize even when every chunk is contiguous", () => {
    // 200 * 256B = 51200B of contiguous payload, well past a 1024B test cap.
    const chunks = Array.from({ length: 200 }, (_, i) => chunk(0x10000000 + i * 256, i & 0xff));
    const runs = coalesceWriteRuns(chunks, 1024);
    expect(runs.length).toBe(Math.ceil(51200 / 1024));
    for (const run of runs) expect(run.data.length).toBeLessThanOrEqual(1024);
    // runs still tile the address range with no gap or overlap between them
    for (let i = 1; i < runs.length; i++) {
      expect(runs[i]!.addr).toBe(runs[i - 1]!.addr + runs[i - 1]!.data.length);
    }
    expect(runs[0]!.addr).toBe(0x10000000);
    const totalBytes = runs.reduce((sum, r) => sum + r.data.length, 0);
    expect(totalBytes).toBe(51200);
  });

  test("the default cap is PICOBOOT_MAX_WRITE_SIZE (32768)", () => {
    const chunks = Array.from({ length: 200 }, (_, i) => chunk(0x10000000 + i * 256, 0));
    const runs = coalesceWriteRuns(chunks);
    for (const run of runs) expect(run.data.length).toBeLessThanOrEqual(PICOBOOT_MAX_WRITE_SIZE);
  });

  test("a real artifact's flash plan coalesces 379 chunks into a small handful of runs", () => {
    const bytes = loadArtifact("puck-full.uf2");
    const { blocks } = parseUf2(bytes);
    const plan = computeFlashPlan(blocks, FAMILY_RP2350_ARM_S);
    const runs = coalesceWriteRuns(plan.chunks);
    expect(plan.chunks.length).toBe(379);
    expect(runs.length).toBeLessThan(10);
    expect(runs.reduce((sum, r) => sum + r.data.length, 0)).toBe(plan.chunks.reduce((sum, c) => sum + c.data.length, 0));
  });
});

describe("planEraseSpans", () => {
  test("a range under the cap is a single span", () => {
    const spans = planEraseSpans(0x10000000, 0x10000000 + 24 * FLASH_SECTOR_SIZE);
    expect(spans).toEqual([{ addr: 0x10000000, size: 24 * FLASH_SECTOR_SIZE }]);
  });

  test("a range over the cap splits into aligned spans, the last one a remainder", () => {
    const start = 0x10000000;
    const end = start + PICOBOOT_MAX_ERASE_SPAN + 3 * FLASH_SECTOR_SIZE;
    const spans = planEraseSpans(start, end);
    expect(spans).toEqual([
      { addr: start, size: PICOBOOT_MAX_ERASE_SPAN },
      { addr: start + PICOBOOT_MAX_ERASE_SPAN, size: 3 * FLASH_SECTOR_SIZE },
    ]);
    for (const span of spans) expect(span.size % FLASH_SECTOR_SIZE).toBe(0);
  });

  test("an exact multiple of the cap splits into equal spans with no trailing remainder", () => {
    const start = 0x10000000;
    const end = start + 2 * PICOBOOT_MAX_ERASE_SPAN;
    const spans = planEraseSpans(start, end);
    expect(spans.length).toBe(2);
    expect(spans[0]).toEqual({ addr: start, size: PICOBOOT_MAX_ERASE_SPAN });
    expect(spans[1]).toEqual({ addr: start + PICOBOOT_MAX_ERASE_SPAN, size: PICOBOOT_MAX_ERASE_SPAN });
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
