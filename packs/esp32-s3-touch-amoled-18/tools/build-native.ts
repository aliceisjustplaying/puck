// build-native.ts: builds this pack's REAL HARDWARE firmware with ESP-IDF and
// emits the single merged image a browser flasher can write in one shot.
// TypeScript, run with `bun` (AGENTS.md: everything here that is not firmware
// is .ts).
//
// This is the ESP-IDF-side equivalent of the sibling pack's
// packs/rp2350-touch-amoled-18/tools/build-native.ts, and of this pack's own
// wasm/build.ts --app flag. The app selection is deliberately the same shape
// in all three: this pack has one app SLOT (`g_demoApp`), not one app, so
// --app <file.c> is nothing but "compile that C file into the slot" -
// firmware/main/CMakeLists.txt's PUCK_APP_SOURCE, which is the ONLY knob
// needed here (no generated roster, unlike the RP2350 sibling, because that
// pack has an app TABLE and this one has a single slot).
//
// Usage:
//   bun run packs/esp32-s3-touch-amoled-18/tools/build-native.ts \
//     --id esp32-demo --out site/flash-artifacts/esp32/esp32-demo.bin
//   bun run packs/esp32-s3-touch-amoled-18/tools/build-native.ts \
//     --app apps/chrono/ports/esp32-s3-touch-amoled-18/chrono.c \
//     --id chrono-esp32 --out site/flash-artifacts/esp32/chrono-esp32.bin
//
// WHY A MERGED IMAGE AND NOT THREE PARTS. `idf.py build` produces three
// separate binaries (bootloader at 0x0, partition table at 0x8000, app at
// 0x10000) and a build/flasher_args.json that names those offsets plus the
// flash mode/size/frequency. esptool-js can write all three - its
// FlashOptions.fileArray is an array of {data, address} - so parts+offsets
// would work. This script emits ONE merged raw image at offset 0 anyway
// (`esptool merge-bin --format raw`), for four reasons that are all about the
// browser side:
//
//   1. One artifact per run page is one fetch, one MD5 verification pass and
//      one monotonic progress bar. Three parts means three of each, and a
//      partial failure that leaves the board with two of three images written.
//   2. The gaps merge-bin fills with 0xFF compress to nothing under
//      writeFlash's `compress: true`, so the extra ~64KB between the
//      partition table and the app costs no meaningful wire time.
//   3. esptool-js only patches the flash mode/size/frequency header of the
//      image written at the chip's BOOTLOADER_FLASH_OFFSET (its
//      _updateImageFlashParams bails out at any other address). A merged
//      image at 0 IS that image, so the browser and this script agree about
//      the flash parameters by construction; merge-bin has already baked the
//      same values in from flasher_args.json.
//   4. The download-it-yourself fallback link on the run page hands a human
//      one file with one offset, which is the same promise the RP2350 page's
//      .uf2 makes.
//
// The manifest still records the three parts and their offsets (they are what
// the merged image is made of, and a reader deserves to see them), but nothing
// in the flashing path reads them.
//
// TOOLCHAIN. ESP-IDF v6.0.2 at ~/esp/esp-idf-v6.0.2 with its tools under
// ~/.espressif, which is the install packs/esp32-s3-touch-amoled-18/docs/
// decisions/0001-what-the-first-flash-found.md's first flash was built with.
// Nothing is on PATH by default: rather than reimplementing export.ps1's
// guesswork, this script asks IDF itself (`idf_tools.py export --format
// key-value`) for the environment and hands that to the child processes.
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

const TOOLS_DIR = import.meta.dir; // packs/esp32-s3-touch-amoled-18/tools
const DEVICE_ROOT = resolve(TOOLS_DIR, ".."); // packs/esp32-s3-touch-amoled-18/
const REPO_ROOT = resolve(DEVICE_ROOT, "..", ".."); // the puck repo root
const FIRMWARE = join(DEVICE_ROOT, "firmware");

const HOME = homedir();
const IDF_PATH = process.env.IDF_PATH ?? join(HOME, "esp", "esp-idf-v6.0.2");
const IDF_TOOLS_PATH = process.env.IDF_TOOLS_PATH ?? join(HOME, ".espressif");

// ---- arguments -----------------------------------------------------------

interface Args {
  appPath: string | null;
  id: string;
  out: string;
  manifest: string | null;
}

function parseArgs(argv: string[]): Args {
  function value(flag: string): string | null {
    const i = argv.indexOf(flag);
    if (i === -1) return null;
    const v = argv[i + 1];
    if (!v || v.startsWith("--")) {
      console.error(`${flag} needs an argument`);
      process.exit(1);
    }
    return v;
  }
  const appRaw = value("--app");
  const out = value("--out");
  if (!out) {
    console.error("--out needs a path argument (where the merged .bin is written)");
    process.exit(1);
  }
  const appPath = appRaw ? resolve(process.cwd(), appRaw) : null;
  const id = value("--id") ?? (appPath ? (appPath.replace(/\.c$/, "").split(/[\\/]/).pop() ?? "port") : "demo");
  const manifestRaw = value("--manifest");
  return {
    appPath,
    id,
    out: resolve(process.cwd(), out),
    manifest: manifestRaw ? resolve(process.cwd(), manifestRaw) : null,
  };
}

const ARGS = parseArgs(process.argv.slice(2));

if (ARGS.appPath && !existsSync(ARGS.appPath)) {
  console.error(`--app source not found: ${ARGS.appPath}`);
  process.exit(1);
}

// ---- the ESP-IDF environment ---------------------------------------------

/**
 * The python interpreter of the IDF virtualenv matching this checkout.
 * ~/.espressif/python_env holds one env per IDF minor version
 * (idf5.5_py3.11_env, idf6.0_py3.14_env, ...), so the checkout's own
 * version.txt picks it rather than a hardcoded name that silently goes stale
 * the next time IDF is updated.
 */
function findIdfPython(): string {
  const envRoot = join(IDF_TOOLS_PATH, "python_env");
  if (!existsSync(envRoot)) {
    console.error(`no IDF python envs at ${envRoot}: is ESP-IDF installed? (see this pack's README)`);
    process.exit(1);
  }
  const versionFile = join(IDF_PATH, "version.txt");
  let prefix = "";
  if (existsSync(versionFile)) {
    const m = /v?(\d+)\.(\d+)/.exec(readFileSync(versionFile, "utf8").trim());
    if (m) prefix = `idf${m[1]}.${m[2]}_`;
  }
  const candidates = readdirSync(envRoot).filter((d) => (prefix ? d.startsWith(prefix) : d.startsWith("idf")));
  if (candidates.length === 0) {
    console.error(`no python env under ${envRoot} matching "${prefix}*" for the IDF checkout at ${IDF_PATH}`);
    process.exit(1);
  }
  candidates.sort();
  const python = join(envRoot, candidates[candidates.length - 1]!, "Scripts", "python.exe");
  const posix = join(envRoot, candidates[candidates.length - 1]!, "bin", "python");
  if (existsSync(python)) return python;
  if (existsSync(posix)) return posix;
  console.error(`the IDF python env ${candidates[candidates.length - 1]} has no python executable`);
  process.exit(1);
}

const IDF_PYTHON = findIdfPython();

if (!existsSync(join(IDF_PATH, "tools", "idf.py"))) {
  console.error(`no idf.py under ${IDF_PATH}: set IDF_PATH to the ESP-IDF checkout this pack builds against (v6.0.2).`);
  process.exit(1);
}

/**
 * The environment ESP-IDF's own tooling says its builds need.
 *
 * `idf_tools.py export --format key-value` prints KEY=VALUE lines with the
 * tool directories resolved for the installed versions; its PATH line ends in
 * the literal `%PATH%`, which stands for whatever PATH the caller already had.
 * Asking IDF rather than hardcoding ~/.espressif/tools/<tool>/<version>/bin
 * paths is what keeps this script working across an IDF update: those version
 * directories change, this call does not.
 *
 * The command also prints an ERROR to stderr about idf-exe not being on PATH
 * before it prints the values. That complaint is about the `idf.py` shim
 * wrapper, which this script does not use (it runs tools/idf.py through the
 * venv python directly), so the values are still what matters.
 */
// Windows environment variable names are case-INSENSITIVE, but a plain JS
// object's keys are not, and bun hands `process.env` over with Windows'
// own casing ("Path", not "PATH"). Spreading that object and then adding
// "PATH" produces a child environment carrying BOTH, and which one the
// child's CreateProcess resolves is not something to rely on: the first
// version of this script did exactly that and idf.py answered `"cmake" must
// be available on the PATH`. So every write goes through here, which drops
// any existing key that differs only by case.
function setEnv(env: Record<string, string>, key: string, value: string): void {
  const lower = key.toLowerCase();
  for (const existing of Object.keys(env)) {
    if (existing !== key && existing.toLowerCase() === lower) delete env[existing];
  }
  env[key] = value;
}

function getEnv(env: Record<string, string>, key: string): string | undefined {
  const lower = key.toLowerCase();
  for (const existing of Object.keys(env)) {
    if (existing.toLowerCase() === lower) return env[existing];
  }
  return undefined;
}

function idfEnv(): Record<string, string> {
  const base: Record<string, string> = { ...(process.env as Record<string, string>) };
  setEnv(base, "IDF_PATH", IDF_PATH);
  setEnv(base, "IDF_TOOLS_PATH", IDF_TOOLS_PATH);
  const result = Bun.spawnSync([IDF_PYTHON, join(IDF_PATH, "tools", "idf_tools.py"), "export", "--format", "key-value"], {
    env: base,
    stdout: "pipe",
    stderr: "pipe",
  });
  const text = new TextDecoder().decode(result.stdout);
  const env: Record<string, string> = { ...base };
  const inheritedPath = getEnv(base, "PATH") ?? "";
  let sawPath = false;
  for (const line of text.split(/\r?\n/)) {
    const m = /^([A-Za-z_][A-Za-z_0-9]*)=(.*)$/.exec(line.trim());
    if (!m) continue;
    const key = m[1]!;
    let value = m[2]!;
    if (value.includes("%PATH%")) {
      value = value.replace("%PATH%", inheritedPath);
      if (key.toLowerCase() === "path") sawPath = true;
    }
    setEnv(env, key, value);
  }
  if (!sawPath) {
    console.error("idf_tools.py export did not print a PATH line; the ESP-IDF install looks incomplete.");
    console.error(new TextDecoder().decode(result.stderr));
    process.exit(1);
  }
  return env;
}

const CHILD_ENV = idfEnv();

function run(cmd: string[], label: string, cwd = REPO_ROOT): void {
  console.log(`$ ${cmd.join(" ")}`);
  const result = Bun.spawnSync(cmd, { stdout: "inherit", stderr: "inherit", env: CHILD_ENV, cwd });
  if (!result.success) {
    console.error(`${label} failed (exit ${result.exitCode})`);
    process.exit(result.exitCode ?? 1);
  }
}

function capture(cmd: string[], label: string): string {
  const result = Bun.spawnSync(cmd, { stdout: "pipe", stderr: "pipe", env: CHILD_ENV, cwd: REPO_ROOT });
  const out = new TextDecoder().decode(result.stdout) + new TextDecoder().decode(result.stderr);
  if (!result.success) {
    console.error(out);
    console.error(`${label} failed (exit ${result.exitCode})`);
    process.exit(result.exitCode ?? 1);
  }
  return out;
}

// ---- the build -----------------------------------------------------------

// One out-of-tree build dir per app, same reasoning as the RP2350 sibling's:
// never committed (.gitignore), regenerable from this script and the tree.
// The default app reuses firmware/build/ (the path README.md documents by
// hand, so a plain `idf.py build` in firmware/ still works); an --app build
// gets firmware/build-app/<id>/ so it never clobbers the default build's
// CMake cache. That separation matters more here than it does on the RP2350:
// PUCK_APP_SOURCE is a CACHED CMake variable (firmware/main/CMakeLists.txt
// says so), so two apps sharing one build directory would need the flag on
// every invocation and would silently rebuild the world each time.
const BUILD_DIR = ARGS.appPath ? join(FIRMWARE, "build-app", ARGS.id) : join(FIRMWARE, "build");
mkdirSync(BUILD_DIR, { recursive: true });

const idfPy = [IDF_PYTHON, join(IDF_PATH, "tools", "idf.py"), "-C", FIRMWARE, "-B", BUILD_DIR];

run([...idfPy, "set-target", "esp32s3"], "idf.py set-target esp32s3");
run(
  [...idfPy, ...(ARGS.appPath ? [`-DPUCK_APP_SOURCE=${ARGS.appPath}`] : []), "build"],
  "idf.py build"
);

// ---- what the build says about flashing ----------------------------------

interface FlasherArgs {
  flash_settings: { flash_mode: string; flash_size: string; flash_freq: string };
  flash_files: Record<string, string>;
  extra_esptool_args: { chip: string; before: string; after: string; stub: boolean };
}

const flasherArgsPath = join(BUILD_DIR, "flasher_args.json");
if (!existsSync(flasherArgsPath)) {
  console.error(`the build reported success but ${flasherArgsPath} does not exist`);
  process.exit(1);
}
const flasherArgs = JSON.parse(readFileSync(flasherArgsPath, "utf8")) as FlasherArgs;

// The parts, lowest offset first: this ordering is what merge-bin needs and
// what the manifest publishes.
const parts = Object.entries(flasherArgs.flash_files)
  .map(([offset, file]) => ({ offset: Number.parseInt(offset, 16), file }))
  .sort((a, b) => a.offset - b.offset);

if (parts.length === 0 || parts[0]!.offset !== 0) {
  console.error(`flasher_args.json's lowest flash offset is not 0x0 (${JSON.stringify(parts)}); a merged image at offset 0 would be wrong.`);
  process.exit(1);
}

// ---- merge, then verify what was merged ----------------------------------

mkdirSync(dirname(ARGS.out), { recursive: true });

const mergeCmd = [
  IDF_PYTHON,
  "-m",
  "esptool",
  "--chip",
  flasherArgs.extra_esptool_args.chip,
  "merge-bin",
  "--format",
  "raw",
  "--output",
  ARGS.out,
  "--flash-mode",
  flasherArgs.flash_settings.flash_mode,
  "--flash-size",
  flasherArgs.flash_settings.flash_size,
  "--flash-freq",
  flasherArgs.flash_settings.flash_freq,
  ...parts.flatMap((p) => [`0x${p.offset.toString(16)}`, p.file]),
];
run(mergeCmd, "esptool merge-bin", BUILD_DIR);

if (!existsSync(ARGS.out)) {
  console.error(`esptool merge-bin reported success but ${ARGS.out} does not exist`);
  process.exit(1);
}

// image-info on the merged file is the check that the first bytes really are
// an ESP32-S3 bootloader image carrying the flash parameters just asked for -
// i.e. that a browser writing this file at offset 0 is writing something the
// ROM will boot, not a blob with the right size. Printed in full because it
// is the receipt this script exists to produce.
//
// It reads the image AT THE START of the file and nothing else, so on a
// merged file it describes the BOOTLOADER: right chip, right flash
// parameters, valid checksum and hash. That is genuinely the part a wrong
// merge breaks, but it says nothing about the app sitting 64KB further in, so
// the app's own binary is run through image-info too, from the build
// directory where it still exists on its own.
for (const [label, target] of [
  ["merged image", ARGS.out],
  ["app image", join(BUILD_DIR, parts[parts.length - 1]!.file)],
] as const) {
  console.log(`--- esptool image-info: ${label} ---`);
  console.log(
    capture(
      [IDF_PYTHON, "-m", "esptool", "--chip", flasherArgs.extra_esptool_args.chip, "image-info", target],
      `esptool image-info (${label})`
    )
  );
}

const merged = new Uint8Array(await Bun.file(ARGS.out).arrayBuffer());
if (merged[0] !== 0xe9) {
  console.error(`the merged image does not start with the ESP image magic 0xE9 (got 0x${merged[0]?.toString(16)})`);
  process.exit(1);
}

const md5 = new Bun.CryptoHasher("md5").update(merged).digest("hex");

// ---- the manifest --------------------------------------------------------

interface ManifestImage {
  file: string;
  offset: number;
  bytes: number;
  md5: string;
  app: string;
  builtAt: string;
  parts: { offset: number; file: string; bytes: number }[];
}

interface Manifest {
  schema: number;
  chip: string;
  flashSize: string;
  flashMode: string;
  flashFreq: string;
  images: Record<string, ManifestImage>;
}

if (ARGS.manifest) {
  const existing: Manifest | null = existsSync(ARGS.manifest)
    ? (JSON.parse(readFileSync(ARGS.manifest, "utf8")) as Manifest)
    : null;
  const manifest: Manifest = existing ?? {
    schema: 1,
    chip: flasherArgs.extra_esptool_args.chip,
    flashSize: flasherArgs.flash_settings.flash_size,
    flashMode: flasherArgs.flash_settings.flash_mode,
    flashFreq: flasherArgs.flash_settings.flash_freq,
    images: {},
  };
  // Every image in one manifest is built from one pack against one
  // sdkconfig.defaults, so a disagreement here means two different
  // configurations are about to be served from the same page. Loud, not
  // silently overwritten.
  const drift: string[] = [];
  if (manifest.chip !== flasherArgs.extra_esptool_args.chip) drift.push(`chip ${manifest.chip} vs ${flasherArgs.extra_esptool_args.chip}`);
  if (manifest.flashSize !== flasherArgs.flash_settings.flash_size) drift.push(`flash size ${manifest.flashSize} vs ${flasherArgs.flash_settings.flash_size}`);
  if (manifest.flashMode !== flasherArgs.flash_settings.flash_mode) drift.push(`flash mode ${manifest.flashMode} vs ${flasherArgs.flash_settings.flash_mode}`);
  if (manifest.flashFreq !== flasherArgs.flash_settings.flash_freq) drift.push(`flash freq ${manifest.flashFreq} vs ${flasherArgs.flash_settings.flash_freq}`);
  if (drift.length > 0) {
    console.error(`${ARGS.manifest} was written by a build with different flash settings: ${drift.join(", ")}`);
    process.exit(1);
  }

  manifest.images[ARGS.id] = {
    file: ARGS.out.split(/[\\/]/).pop()!,
    offset: 0,
    bytes: merged.byteLength,
    md5,
    app: (ARGS.appPath ?? join(FIRMWARE, "apps", "demo.c")).replace(REPO_ROOT, "").replace(/^[\\/]/, "").replace(/\\/g, "/"),
    builtAt: new Date().toISOString().slice(0, 10),
    parts: parts.map((p) => ({
      offset: p.offset,
      file: p.file,
      bytes: Bun.file(join(BUILD_DIR, p.file)).size,
    })),
  };
  const ordered: Manifest = {
    ...manifest,
    images: Object.fromEntries(Object.keys(manifest.images).sort().map((k) => [k, manifest.images[k]!])),
  };
  writeFileSync(ARGS.manifest, `${JSON.stringify(ordered, null, 2)}\n`, "utf8");
  console.log(`manifest -> ${ARGS.manifest} (${Object.keys(ordered.images).length} image(s))`);
}

console.log(`built ${ARGS.out} (${merged.byteLength} bytes, md5 ${md5})`);
