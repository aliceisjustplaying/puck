// site/flasher/esp32Manifest.test.ts: everything the ESP32 flasher decides
// before a board is involved.
//
// The serial round trip (download mode entered, stub uploaded, blocks
// written, MD5 read back) needs the real board and is checked at the bench.
// What is checkable here is the artifact index: which file is fetched, which
// flash address it is written at, and which malformed manifests are refused
// instead of being handed to esptool-js. A wrong address is not a failed
// flash, it is a bricked board, so this is the layer that has to be pinned.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ManifestError, parseEsp32Manifest, planEsp32Write, MANIFEST_SCHEMA } from "./esp32Manifest";

function goodManifest(): Record<string, unknown> {
  return {
    schema: 1,
    chip: "esp32s3",
    flashSize: "16MB",
    flashMode: "dio",
    flashFreq: "80m",
    images: {
      "esp32-demo": {
        file: "esp32-demo.bin",
        offset: 0,
        bytes: 365168,
        md5: "ce42a6a91f7dd5dd578c4cd2f57a3e8f",
        app: "packs/esp32-s3-touch-amoled-18/firmware/apps/demo.c",
        builtAt: "2026-08-19",
        parts: [
          { offset: 0, file: "bootloader/bootloader.bin", bytes: 20880 },
          { offset: 32768, file: "partition_table/partition-table.bin", bytes: 3072 },
          { offset: 65536, file: "esp32-s3-touch-amoled-18.bin", bytes: 299632 },
        ],
      },
    },
  };
}

describe("parseEsp32Manifest", () => {
  test("reads a manifest the build actually wrote", () => {
    const m = parseEsp32Manifest(goodManifest());
    expect(m.chip).toBe("esp32s3");
    expect(m.flashSize).toBe("16MB");
    expect(m.flashMode).toBe("dio");
    expect(m.flashFreq).toBe("80m");
    expect(Object.keys(m.images)).toEqual(["esp32-demo"]);
    expect(m.images["esp32-demo"]!.parts).toHaveLength(3);
  });

  test("refuses a schema it does not know rather than guessing at the shape", () => {
    const raw = { ...goodManifest(), schema: MANIFEST_SCHEMA + 1 };
    expect(() => parseEsp32Manifest(raw)).toThrow(ManifestError);
    expect(() => parseEsp32Manifest(raw)).toThrow(/schema 2 is not the 1/);
  });

  test("refuses flash parameters esptool-js would not accept", () => {
    // "80MHz" instead of "80m" is the exact typo a hand-written manifest
    // makes, and esptool-js would silently take it as "not keep, not known"
    // and index an undefined out of its own table.
    expect(() => parseEsp32Manifest({ ...goodManifest(), flashFreq: "80MHz" })).toThrow(/"flashFreq" must be one of/);
    expect(() => parseEsp32Manifest({ ...goodManifest(), flashMode: "quad" })).toThrow(/"flashMode" must be one of/);
    expect(() => parseEsp32Manifest({ ...goodManifest(), flashSize: "16M" })).toThrow(/"flashSize" must be one of/);
  });

  test("refuses an offset that is not a plain non-negative integer", () => {
    for (const bad of ["0x10000", -1, 1.5, null]) {
      const raw = goodManifest();
      (raw.images as Record<string, Record<string, unknown>>)["esp32-demo"]!.offset = bad;
      expect(() => parseEsp32Manifest(raw)).toThrow(/"offset" must be a non-negative integer/);
    }
  });

  test("refuses a file name that could point the fetch out of the artifact directory", () => {
    const raw = goodManifest();
    (raw.images as Record<string, Record<string, unknown>>)["esp32-demo"]!.file = "../../../etc/passwd";
    expect(() => parseEsp32Manifest(raw)).toThrow(/bare file name with no path separators/);
  });

  test("refuses an md5 that is not 32 lowercase hex characters", () => {
    const raw = goodManifest();
    (raw.images as Record<string, Record<string, unknown>>)["esp32-demo"]!.md5 = "CE42A6A91F7DD5DD578C4CD2F57A3E8F";
    expect(() => parseEsp32Manifest(raw)).toThrow(/32 lowercase hex/);
  });

  test("refuses an empty index rather than rendering a button with nothing behind it", () => {
    expect(() => parseEsp32Manifest({ ...goodManifest(), images: {} })).toThrow(/"images" is empty/);
  });
});

describe("planEsp32Write", () => {
  test("plans one write, at the image's own offset, from the manifest's own directory", () => {
    const plan = planEsp32Write(parseEsp32Manifest(goodManifest()), "esp32-demo", "../flash/esp32/");
    expect(plan.writes).toEqual([
      {
        address: 0,
        url: "../flash/esp32/esp32-demo.bin",
        bytes: 365168,
        md5: "ce42a6a91f7dd5dd578c4cd2f57a3e8f",
      },
    ]);
    expect(plan.totalBytes).toBe(365168);
    expect(plan.chip).toBe("esp32s3");
  });

  test("a base href without its trailing slash still resolves to the same URL", () => {
    const m = parseEsp32Manifest(goodManifest());
    expect(planEsp32Write(m, "esp32-demo", "../flash/esp32").writes[0]!.url).toBe("../flash/esp32/esp32-demo.bin");
  });

  test("the three parts are documentation: the plan never writes them separately", () => {
    // The whole artifact strategy (build-native.ts's header) is one merged
    // image at offset 0. If this ever becomes three writes, that decision
    // changed and the flasher's progress, verification and failure modes all
    // change with it.
    const plan = planEsp32Write(parseEsp32Manifest(goodManifest()), "esp32-demo", "../flash/esp32/");
    expect(plan.writes).toHaveLength(1);
    expect(plan.writes[0]!.address).toBe(0);
  });

  test("an unknown image id names the ids that do exist", () => {
    const m = parseEsp32Manifest(goodManifest());
    expect(() => planEsp32Write(m, "chrono-esp32", "../flash/esp32/")).toThrow(/no image "chrono-esp32"/);
    expect(() => planEsp32Write(m, "chrono-esp32", "../flash/esp32/")).toThrow(/it has: esp32-demo/);
  });
});

describe("the manifest this repository actually ships", () => {
  // The fixtures above prove the parser; this proves the artifact index in
  // the tree is one the parser accepts, which is what the run pages fetch.
  const path = join(import.meta.dir, "..", "flash-artifacts", "esp32", "manifest.json");

  test("parses, and every image is a merged image at offset 0", () => {
    const manifest = parseEsp32Manifest(JSON.parse(readFileSync(path, "utf8")));
    expect(manifest.chip).toBe("esp32s3");
    const ids = Object.keys(manifest.images);
    expect(ids.length).toBeGreaterThan(0);
    for (const id of ids) {
      const plan = planEsp32Write(manifest, id, "../flash/esp32/");
      expect(plan.writes).toHaveLength(1);
      expect(plan.writes[0]!.address).toBe(0);
      expect(plan.writes[0]!.bytes).toBeGreaterThan(0);
    }
  });

  test("carries the two images the run pages ask for by name", () => {
    const manifest = parseEsp32Manifest(JSON.parse(readFileSync(path, "utf8")));
    expect(Object.keys(manifest.images)).toEqual(expect.arrayContaining(["esp32-demo", "chrono-esp32"]));
  });
});
