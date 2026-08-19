// site/flasher/esp32Manifest.ts: parse site/flash-artifacts/esp32/manifest.json
// and turn it into the write plan esptool-js takes.
//
// Pure: no DOM, no fetch, no esptool-js. Everything a wrong manifest can do to
// a flash is decided here, where a unit test can put it (esp32Manifest.test.ts)
// rather than only a bench session with a board on the desk. That split is the
// same one site/flasher/uf2.ts holds on the RP2350 side: the transport talks to
// hardware, the plan is arithmetic.
//
// The manifest is written by packs/esp32-s3-touch-amoled-18/tools/
// build-native.ts, straight out of the build's own flasher_args.json. Read
// that script's header for why each image is ONE merged binary at offset 0
// rather than the three parts ESP-IDF produces; the `parts` array here is
// documentation of what went into the merge, and deliberately plays no role
// in planWrite() below.

/** Flash size strings esptool-js accepts (its FlashSizeValues). */
const FLASH_SIZES = [
  "keep", "detect", "256KB", "512KB", "1MB", "2MB", "2MB-c1", "4MB", "4MB-c1",
  "8MB", "16MB", "32MB", "64MB", "128MB",
] as const;
/** Flash modes esptool-js accepts (its FlashModeValues). */
const FLASH_MODES = ["keep", "dio", "qio", "dout", "qout"] as const;
/** Flash frequencies esptool-js accepts (its FlashFreqValues). */
const FLASH_FREQS = ["keep", "80m", "60m", "48m", "40m", "30m", "26m", "24m", "20m", "16m", "15m", "12m"] as const;

export type FlashSize = (typeof FLASH_SIZES)[number];
export type FlashMode = (typeof FLASH_MODES)[number];
export type FlashFreq = (typeof FLASH_FREQS)[number];

/** The schema version this file knows how to read. Bumped when the shape changes, never reused for a different shape. */
export const MANIFEST_SCHEMA = 1;

export interface ManifestPart {
  offset: number;
  file: string;
  bytes: number;
}

export interface ManifestImage {
  /** File name, resolved against the manifest's own directory. */
  file: string;
  /** Flash offset this image is written at. 0 for a merged image, which is every image today. */
  offset: number;
  bytes: number;
  /** Lowercase hex MD5 of the file, as built. */
  md5: string;
  /** Repo-relative path of the C file that filled the pack's app slot. */
  app: string;
  builtAt: string;
  /** What the merge was made of: informational, never flashed part by part. */
  parts: ManifestPart[];
}

export interface Esp32Manifest {
  schema: number;
  chip: string;
  flashSize: FlashSize;
  flashMode: FlashMode;
  flashFreq: FlashFreq;
  images: Record<string, ManifestImage>;
}

/**
 * A manifest that could not be read. Separate from the transport's own errors
 * so the UI can say "the site is serving a broken artifact index", which is a
 * deploy problem, rather than "your board did not answer", which is not.
 */
export class ManifestError extends Error {}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireString(obj: Record<string, unknown>, key: string, where: string): string {
  const v = obj[key];
  if (typeof v !== "string" || v.length === 0) {
    throw new ManifestError(`${where}: "${key}" must be a non-empty string, got ${JSON.stringify(v)}`);
  }
  return v;
}

function requireOffset(obj: Record<string, unknown>, key: string, where: string): number {
  const v = obj[key];
  // Offsets and sizes are flash addresses. A float, a negative or a string
  // "0x10000" would all sail through a `typeof v === "number"` check or a
  // Number() coercion and then be handed to the loader as a write address,
  // so each one is refused by name here.
  if (typeof v !== "number" || !Number.isInteger(v) || v < 0) {
    throw new ManifestError(`${where}: "${key}" must be a non-negative integer, got ${JSON.stringify(v)}`);
  }
  return v;
}

function requireEnum<T extends string>(obj: Record<string, unknown>, key: string, allowed: readonly T[], where: string): T {
  const v = obj[key];
  if (typeof v !== "string" || !(allowed as readonly string[]).includes(v)) {
    throw new ManifestError(`${where}: "${key}" must be one of ${allowed.join(", ")}, got ${JSON.stringify(v)}`);
  }
  return v as T;
}

/** Parse and validate a manifest. Throws ManifestError with a specific sentence on anything unusable. */
export function parseEsp32Manifest(raw: unknown): Esp32Manifest {
  if (!isRecord(raw)) throw new ManifestError("manifest: not a JSON object");
  const schema = raw.schema;
  if (schema !== MANIFEST_SCHEMA) {
    throw new ManifestError(`manifest: schema ${JSON.stringify(schema)} is not the ${MANIFEST_SCHEMA} this flasher reads`);
  }
  const chip = requireString(raw, "chip", "manifest");
  const flashSize = requireEnum(raw, "flashSize", FLASH_SIZES, "manifest");
  const flashMode = requireEnum(raw, "flashMode", FLASH_MODES, "manifest");
  const flashFreq = requireEnum(raw, "flashFreq", FLASH_FREQS, "manifest");

  const rawImages = raw.images;
  if (!isRecord(rawImages)) throw new ManifestError('manifest: "images" must be an object keyed by combo id');
  const images: Record<string, ManifestImage> = {};
  for (const [id, value] of Object.entries(rawImages)) {
    const where = `manifest image "${id}"`;
    if (!isRecord(value)) throw new ManifestError(`${where}: not an object`);
    const md5 = requireString(value, "md5", where);
    if (!/^[0-9a-f]{32}$/.test(md5)) {
      throw new ManifestError(`${where}: "md5" must be 32 lowercase hex characters, got ${JSON.stringify(md5)}`);
    }
    const file = requireString(value, "file", where);
    if (file.includes("/") || file.includes("\\")) {
      // The file is resolved against the manifest's own directory. A path
      // separator here would let a manifest point the fetch somewhere else
      // entirely, which is not something an artifact index gets to do.
      throw new ManifestError(`${where}: "file" must be a bare file name with no path separators, got ${JSON.stringify(file)}`);
    }
    const parts: ManifestPart[] = [];
    if (Array.isArray(value.parts)) {
      for (const part of value.parts) {
        if (!isRecord(part)) throw new ManifestError(`${where}: every entry of "parts" must be an object`);
        parts.push({
          offset: requireOffset(part, "offset", `${where} part`),
          file: requireString(part, "file", `${where} part`),
          bytes: requireOffset(part, "bytes", `${where} part`),
        });
      }
    }
    images[id] = {
      file,
      offset: requireOffset(value, "offset", where),
      bytes: requireOffset(value, "bytes", where),
      md5,
      app: typeof value.app === "string" ? value.app : "",
      builtAt: typeof value.builtAt === "string" ? value.builtAt : "",
      parts,
    };
  }
  if (Object.keys(images).length === 0) throw new ManifestError('manifest: "images" is empty');
  return { schema, chip, flashSize, flashMode, flashFreq, images };
}

export interface WriteEntry {
  address: number;
  url: string;
  bytes: number;
  md5: string;
}

export interface WritePlan {
  chip: string;
  flashSize: FlashSize;
  flashMode: FlashMode;
  flashFreq: FlashFreq;
  /** In ascending address order. One entry today, by construction (see this file's header). */
  writes: WriteEntry[];
  /** Total bytes to be written, for progress reporting. */
  totalBytes: number;
}

/**
 * The plan for flashing one image id: which URL goes at which flash address,
 * with the flash parameters the loader must be told about.
 *
 * `baseHref` is the directory the manifest was fetched from; it is joined by
 * plain concatenation rather than by `new URL(...)` so this stays pure and
 * testable with relative hrefs like "../flash/esp32/".
 */
export function planEsp32Write(manifest: Esp32Manifest, imageId: string, baseHref: string): WritePlan {
  const image = manifest.images[imageId];
  if (!image) {
    const known = Object.keys(manifest.images).sort().join(", ");
    throw new ManifestError(`manifest has no image "${imageId}" (it has: ${known || "none"})`);
  }
  const base = baseHref.endsWith("/") ? baseHref : `${baseHref}/`;
  return {
    chip: manifest.chip,
    flashSize: manifest.flashSize,
    flashMode: manifest.flashMode,
    flashFreq: manifest.flashFreq,
    writes: [{ address: image.offset, url: `${base}${image.file}`, bytes: image.bytes, md5: image.md5 }],
    totalBytes: image.bytes,
  };
}
