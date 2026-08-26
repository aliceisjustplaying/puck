// compare-gameos-esp32-shell-vs-donor.ts: structural + pixel comparison
// between this bundle's own captured shell frame (see
// capture-gameos-esp32-shell-frame.ts) and the donor's own reference
// screenshot (apps/gameos/reference/esp32-gameos/media/launcher.png,
// downloaded byte-for-byte from MikeWilson/esp32-gameos - NOTICE.md).
//
// Both images are the SAME 368x448 indexed-then-upscaled panel shape, so a
// region that corresponds to the identical vendored draw calls in both
// (the GUNSHIP tile at grid slot 0, the bottom bar) should read as exactly
// the same pixels - modulo ONE expected, explained gap: the donor's own
// screenshot tool and this repository's own canvas-based capture
// (src/panel.ts) each pick their own RGB565 -> RGB888 channel-expansion
// convention (bit-replicate vs plain left-shift) when turning a 5/6/5
// panel value into a screenshot's 8-bit-per-channel pixel. That is a
// display/capture-tool artifact, not a rendering difference, so this
// script compares at 5/6/5 precision (`q()` below) rather than raw 8-bit -
// see this bundle's donor-shell-comparison/README.md for the measured
// per-channel offset that confirms this diagnosis (R/B off by up to 6,
// G off by up to 3 - exactly the replicate-vs-shift gap for 5-bit and
// 6-bit channels respectively, checked by hand, not assumed).
//
// Run with: bun run scripts/compare-gameos-esp32-shell-vs-donor.ts
import { decodeRGBPNG } from "../harness/png";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const DONOR_PNG = join(ROOT, "apps", "gameos", "reference", "esp32-gameos", "media", "launcher.png");
const OURS_PNG = join(ROOT, "apps", "gameos", "reference", "esp32-gameos", "donor-shell-comparison", "our-shell-boot.png");

const W = 368, H = 448;

function q(v: number, bits: number): number {
  return v >> (8 - bits);
}

function diffRegion(
  a: { rgb: Uint8Array },
  b: { rgb: Uint8Array },
  x0: number, y0: number, x1: number, y1: number
): { diff: number; total: number } {
  let diff = 0, total = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = (y * W + x) * 3;
      total++;
      const rEq = q(a.rgb[i]!, 5) === q(b.rgb[i]!, 5);
      const gEq = q(a.rgb[i + 1]!, 6) === q(b.rgb[i + 1]!, 6);
      const bEq = q(a.rgb[i + 2]!, 5) === q(b.rgb[i + 2]!, 5);
      if (!rEq || !gEq || !bEq) diff++;
    }
  }
  return { diff, total };
}

function report(label: string, r: { diff: number; total: number }): void {
  const pct = ((100 * r.diff) / r.total).toFixed(1);
  console.log(`${label}: ${r.diff}/${r.total} px differ (${pct}%)`);
}

function main(): void {
  const donor = decodeRGBPNG(readFileSync(DONOR_PNG));
  const ours = decodeRGBPNG(readFileSync(OURS_PNG));
  if (donor.width !== W || donor.height !== H || ours.width !== W || ours.height !== H) {
    console.error(`FAIL: expected both images at ${W}x${H}, got donor ${donor.width}x${donor.height}, ours ${ours.width}x${ours.height}`);
    process.exit(1);
  }

  // GUNSHIP tile, grid slot 0 (col0/row0 in BOTH images - the donor's
  // registry.c snapshot and this port's vendored registry.c agree on which
  // game occupies slot 0): render-space cx=4,cy=10,w=84,h=58 -> panel
  // (2x) x:[8,176) y:[20,136).
  report("GUNSHIP tile (grid slot 0)", diffRegion(donor, ours, 8, 20, 176, 136));

  // Bottom bar (SET button, GAMEOS label, USB indicator): render-space
  // y:198-224 -> panel y:396-448, full width.
  report("bottom bar (SET/GAMEOS/USB)", diffRegion(donor, ours, 0, 396, 368, 448));

  // Whole frame, for the record - expected to differ: this port's real,
  // unmodified registry.c lists five games (gunship/golf/slots/aimtest/
  // diag), the donor's own media/launcher.png predates golf.c/slots.c
  // being wired into g_games[] (git log on that file, this bundle's own
  // README) and shows only three (gunship/aimtest/diag) - see
  // donor-shell-comparison/README.md for the full argument.
  report("whole frame (content differs - see README)", diffRegion(donor, ours, 0, 0, W, H));
}

main();
