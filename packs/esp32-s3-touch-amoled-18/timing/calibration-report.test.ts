import { afterEach, describe, expect, test } from "bun:test";
import { link, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

import {
  buildCalibrationReport,
  runCalibrationReportCli,
  writeCalibrationReport,
} from "./calibration-report";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function temporaryDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "puck-calibration-report-"));
  temporaryDirectories.push(path);
  return path;
}

function receiptJson(
  bootId: string,
  kernel: string,
  options: { dirty?: boolean; commit?: string; cacheCounters?: boolean } = {},
): string {
  const core = 0;
  return `${JSON.stringify({
    schemaVersion: 1,
    receiptKind: "esp32s3-hardware-calibration",
    captureMode: "hardware",
    capturedAt: bootId === "boot-a" ? "2026-08-30T20:00:00.000Z" : "2026-08-30T20:01:00.000Z",
    git: {
      repository: "https://github.com/aliceisjustplaying/tinydraw.git",
      commit: options.commit ?? "0123456789abcdef0123456789abcdef01234567",
      dirty: options.dirty ?? false,
    },
    toolchain: {
      target: "esp32s3",
      espIdfVersion: "v6.0.2",
      compiler: "GNU",
      compilerVersion: "15.2.0",
    },
    sdkconfig: {
      path: "esp32/sdkconfig.defaults",
      sha256: "a".repeat(64),
      cpuHz: 240_000_000,
      psramMode: "octal",
      psramBusHz: 80_000_000,
      flashMode: "qio",
      flashBusHz: 80_000_000,
    },
    boot: {
      bootId,
      bootLogSha256: (bootId === "boot-a" ? "b" : "c").repeat(64),
      resetReason: "power-on",
      chipModel: "ESP32-S3",
      chipRevision: 1,
      cpuCores: 2,
      psramBytes: 8 * 1024 * 1024,
      flashBytes: 16 * 1024 * 1024,
    },
    counter: { source: "xtensa-ccount", bits: 32, hz: 240_000_000, core },
    measurement: {
      kind: "ccount-kernel",
      kernel,
      memoryPath: kernel.startsWith("flash") ? "flash-to-internal" : "internal-to-internal",
      bytesPerIteration: 4,
      iterationsPerSample: 1,
      warmupIterations: 8,
      samples: Array.from({ length: 100 }, (_, ordinal) => {
        const cycles = ordinal + 1;
        const startCcount = 1000 + ordinal * 1000;
        return {
          ordinal,
          startCore: core,
          endCore: core,
          startCcount,
          endCcount: startCcount + cycles,
          cycles,
          ...(options.cacheCounters
            ? {
                cacheCounters: {
                  ibus: { accesses: ordinal + 1, misses: ordinal % 2 },
                  dbus: { accesses: 2 * (ordinal + 1), flashMisses: 1, psramMisses: 0 },
                },
              }
            : {}),
        };
      }),
    },
  })}\n`;
}

async function writeCohort(directory: string): Promise<string[]> {
  const paths = [
    join(directory, "z-boot-b.json"),
    join(directory, "a-boot-a.json"),
    join(directory, "z-boot-a.json"),
    join(directory, "a-boot-b.json"),
  ];
  await writeFile(paths[0]!, receiptJson("boot-b", "z-kernel"));
  await writeFile(paths[1]!, receiptJson("boot-a", "a-kernel"));
  await writeFile(paths[2]!, receiptJson("boot-a", "z-kernel"));
  await writeFile(paths[3]!, receiptJson("boot-b", "a-kernel"));
  return paths;
}

function sha256(text: string): string {
  return new Bun.CryptoHasher("sha256").update(text).digest("hex");
}

describe("stable calibration report", () => {
  test("reads directories deterministically and emits decimal evidence without profile claims", async () => {
    const directory = await temporaryDirectory();
    const paths = await writeCohort(directory);
    await writeFile(join(directory, "ignored.txt"), "not a receipt");

    const fromDirectory = await buildCalibrationReport({ inputs: [directory] });
    const fromFiles = await buildCalibrationReport({ inputs: [...paths].reverse() });
    expect(fromDirectory.json).toBe(fromFiles.json);
    expect(fromDirectory.receiptPaths).toEqual([...paths].sort());
    expect(fromDirectory.report.candidates.map((candidate) => candidate.measurement.kernel)).toEqual([
      "a-kernel",
      "z-kernel",
    ]);
    expect(fromDirectory.report.candidates[0]!.samples).toEqual({
      count: 200,
      cycles: { min: "1", p50: "50", p90: "90", p99: "99", max: "100" },
      bytesPerSample: "4",
      cyclesPerByte: {
        min: { numerator: "1", denominator: "4" },
        p50: { numerator: "25", denominator: "2" },
        p90: { numerator: "45", denominator: "2" },
        p99: { numerator: "99", denominator: "4" },
        max: { numerator: "25", denominator: "1" },
      },
    });
    for (const path of paths) {
      expect(fromDirectory.json).toContain(sha256(await readFile(path, "utf8")));
    }
    expect(fromDirectory.json).toContain("b".repeat(64));
    expect(fromDirectory.json).toContain("c".repeat(64));
    expect(fromDirectory.json).toContain('"microbenchmarkToArchitecturalCost": "unreviewed"');
    expect(fromDirectory.json).not.toContain("timing.json");
    expect(fromDirectory.json).not.toContain('"calibrated"');
    expect(sha256(fromDirectory.json)).toBe("cddcc912628819c074e66e5a447329853884b023b789944ac0610f5048a4d38a");
  });

  test("writes byte-identical output and the CLI emits the same bytes", async () => {
    const directory = await temporaryDirectory();
    const receiptDirectory = join(directory, "receipts");
    await mkdir(receiptDirectory);
    await writeCohort(receiptDirectory);
    const outputPath = join(directory, "candidate-report.json");
    const written = await writeCalibrationReport({ inputs: [receiptDirectory], outputPath });
    expect(await readFile(outputPath, "utf8")).toBe(written.json);

    const stdout: string[] = [];
    const stderr: string[] = [];
    const exitCode = await runCalibrationReportCli([receiptDirectory], {
      cwd: directory,
      stdout: (text) => stdout.push(text),
      stderr: (text) => stderr.push(text),
    });
    expect(exitCode).toBe(0);
    expect(stdout).toEqual([written.json]);
    expect(stderr).toEqual([]);
  });

  test("serializes exact cache-counter multivariate moments as decimal strings", async () => {
    const directory = await temporaryDirectory();
    const first = join(directory, "boot-a.json");
    const second = join(directory, "boot-b.json");
    await writeFile(first, receiptJson("boot-a", "flash-kernel", { cacheCounters: true }));
    await writeFile(second, receiptJson("boot-b", "flash-kernel", { cacheCounters: true }));

    const candidate = (await buildCalibrationReport({ inputs: [second, first] })).report.candidates[0]!;
    expect(candidate.review.cacheClaim).toBe("not-claimed");
    expect(candidate.samples.cacheCounters).toEqual({
      count: 200,
      cyclesTotal: "10100",
      cyclesSquaredTotal: "676700",
      predictorOrder: [
        "ibus.accesses",
        "ibus.misses",
        "dbus.accesses",
        "dbus.flashMisses",
        "dbus.psramMisses",
      ],
      gramMatrix: [
        ["676700", "5100", "1353400", "10100", "0"],
        ["5100", "100", "10200", "100", "0"],
        ["1353400", "10200", "2706800", "20200", "0"],
        ["10100", "100", "20200", "200", "0"],
        ["0", "0", "0", "0", "0"],
      ],
      ibus: {
        accesses: {
          total: "10100",
          squaredTotal: "676700",
          cycleProductTotal: "676700",
          values: { min: "1", p50: "50", p90: "90", p99: "99", max: "100" },
        },
        misses: {
          total: "100",
          squaredTotal: "100",
          cycleProductTotal: "5100",
          values: { min: "0", p50: "0", p90: "1", p99: "1", max: "1" },
        },
      },
      dbus: {
        accesses: {
          total: "20200",
          squaredTotal: "2706800",
          cycleProductTotal: "1353400",
          values: { min: "2", p50: "100", p90: "180", p99: "198", max: "200" },
        },
        flashMisses: {
          total: "200",
          squaredTotal: "200",
          cycleProductTotal: "10100",
          values: { min: "1", p50: "1", p90: "1", p99: "1", max: "1" },
        },
        psramMisses: {
          total: "0",
          squaredTotal: "0",
          cycleProductTotal: "0",
          values: { min: "0", p50: "0", p90: "0", p99: "0", max: "0" },
        },
      },
    });
  });
});

describe("filesystem refusal boundary", () => {
  test("refuses empty inputs, empty directories, duplicate paths, and non-json files", async () => {
    const directory = await temporaryDirectory();
    await expect(buildCalibrationReport({ inputs: [] })).rejects.toThrow("receipt inputs must not be empty");
    await expect(buildCalibrationReport({ inputs: [directory] })).rejects.toThrow(
      "receipt inputs contain no .json files",
    );
    const receipt = join(directory, "receipt.json");
    await writeFile(receipt, receiptJson("boot-a", "a-kernel"));
    await expect(buildCalibrationReport({ inputs: [receipt, `${directory}/./receipt.json`] })).rejects.toThrow(
      "duplicate input path",
    );
    const text = join(directory, "receipt.txt");
    await writeFile(text, "ignored");
    await expect(buildCalibrationReport({ inputs: [text] })).rejects.toThrow(
      "receipt file path must end in .json",
    );
  });

  test("refuses symlinks, nested directories, and direct plus directory duplicates", async () => {
    const directory = await temporaryDirectory();
    const receipts = join(directory, "receipts");
    await mkdir(receipts);
    const receipt = join(receipts, "receipt.json");
    await writeFile(receipt, receiptJson("boot-a", "a-kernel"));
    const linked = join(directory, "linked.json");
    await symlink(receipt, linked);
    await expect(buildCalibrationReport({ inputs: [linked] })).rejects.toThrow("symlink inputs are refused");

    const nested = join(receipts, "nested");
    await mkdir(nested);
    await expect(buildCalibrationReport({ inputs: [receipts] })).rejects.toThrow(
      `nested input directories are refused: ${nested}`,
    );
    await rm(nested, { recursive: true });
    await expect(buildCalibrationReport({ inputs: [receipts, receipt] })).rejects.toThrow("duplicate receipt path");
  });

  test("refuses every output collision and symlink output", async () => {
    const directory = await temporaryDirectory();
    const receipts = join(directory, "receipts");
    await mkdir(receipts);
    const paths = await writeCohort(receipts);
    await expect(buildCalibrationReport({ inputs: [paths[0]!], outputPath: paths[0]! })).rejects.toThrow(
      "output path collides with input",
    );
    await expect(
      buildCalibrationReport({ inputs: [receipts], outputPath: join(receipts, "report.json") }),
    ).rejects.toThrow("output path must not be inside an input directory");
    const target = join(directory, "target.json");
    const linked = join(directory, "linked-output.json");
    await writeFile(target, "{}");
    await symlink(target, linked);
    await expect(buildCalibrationReport({ inputs: [receipts], outputPath: linked })).rejects.toThrow(
      "symlink output paths are refused",
    );
    const hardlinked = join(directory, "hardlinked-output.json");
    await link(paths[0]!, hardlinked);
    await expect(buildCalibrationReport({ inputs: [receipts], outputPath: hardlinked })).rejects.toThrow(
      "output path collides with receipt input identity",
    );
  });
});

describe("receipt and cohort refusal boundary", () => {
  test("propagates schema fixture, dirty build, and cohort drift failures deterministically", async () => {
    const directory = await temporaryDirectory();
    const schemaFixture = JSON.parse(receiptJson("boot-a", "a-kernel")) as Record<string, unknown>;
    schemaFixture.captureMode = "schema-fixture";
    const fixturePath = join(directory, "fixture.json");
    await writeFile(fixturePath, JSON.stringify(schemaFixture));
    await expect(buildCalibrationReport({ inputs: [fixturePath] })).rejects.toThrow(
      '$.captureMode must be "hardware"',
    );

    const dirtyPath = join(directory, "dirty.json");
    await writeFile(dirtyPath, receiptJson("boot-a", "a-kernel", { dirty: true }));
    await expect(buildCalibrationReport({ inputs: [dirtyPath] })).rejects.toThrow("$.git.dirty must be false");

    const cleanPath = join(directory, "clean.json");
    const driftPath = join(directory, "drift.json");
    await writeFile(cleanPath, receiptJson("boot-a", "a-kernel"));
    await writeFile(driftPath, receiptJson("boot-b", "a-kernel", { commit: "f".repeat(40) }));
    await expect(buildCalibrationReport({ inputs: [driftPath, cleanPath] })).rejects.toThrow(
      "cohort provenance must agree",
    );
  });

  test("pins CLI errors as one stable JSON line", async () => {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const exitCode = await runCalibrationReportCli([], {
      cwd: resolve("."),
      stdout: (text) => stdout.push(text),
      stderr: (text) => stderr.push(text),
    });
    expect(exitCode).toBe(1);
    expect(stdout).toEqual([]);
    expect(stderr).toEqual([
      '{"ok":false,"error":"receipt inputs must not be empty"}\n',
    ]);
  });
});
