import { lstat, readFile, readdir, writeFile } from "node:fs/promises";
import type { Stats } from "node:fs";
import { extname, isAbsolute, relative, resolve, sep } from "node:path";

import {
  buildCalibrationCandidates,
  parseHardwareCalibrationReceipt,
  type CacheCounterPredictor,
  type CalibrationCandidate,
  type ExactCacheCounterSummary,
  type ExactCounterSeriesSummary,
  type ExactIntegerSummary,
  type ExactRational,
  type ExactRationalSummary,
  type ParsedHardwareCalibrationReceipt,
} from "./calibration";

export interface CalibrationReportOptions {
  readonly inputs: readonly string[];
  readonly cwd?: string;
  readonly outputPath?: string;
}

export interface CalibrationReportArtifact {
  readonly receiptPaths: readonly string[];
  readonly outputPath: string | null;
  readonly report: CalibrationReportV1;
  readonly json: string;
}

interface DecimalRational {
  readonly numerator: string;
  readonly denominator: string;
}

interface DecimalIntegerSummary {
  readonly min: string;
  readonly p50: string;
  readonly p90: string;
  readonly p99: string;
  readonly max: string;
}

interface DecimalRationalSummary {
  readonly min: DecimalRational;
  readonly p50: DecimalRational;
  readonly p90: DecimalRational;
  readonly p99: DecimalRational;
  readonly max: DecimalRational;
}

interface DecimalCounterSeriesSummary {
  readonly total: string;
  readonly squaredTotal: string;
  readonly cycleProductTotal: string;
  readonly values: DecimalIntegerSummary;
}

interface DecimalCacheCounterSummary {
  readonly count: number;
  readonly cyclesTotal: string;
  readonly cyclesSquaredTotal: string;
  readonly predictorOrder: readonly CacheCounterPredictor[];
  readonly gramMatrix: readonly (readonly string[])[];
  readonly ibus: Readonly<{
    accesses: DecimalCounterSeriesSummary;
    misses: DecimalCounterSeriesSummary;
  }>;
  readonly dbus: Readonly<{
    accesses: DecimalCounterSeriesSummary;
    flashMisses: DecimalCounterSeriesSummary;
    psramMisses: DecimalCounterSeriesSummary;
  }>;
}

export interface CalibrationReportV1 {
  readonly reportVersion: 1;
  readonly status: "candidate";
  readonly review: Readonly<{
    microbenchmarkToArchitecturalCost: "unreviewed";
    cacheClaim: "not-claimed";
    isaClaim: "not-claimed";
  }>;
  readonly receiptCount: number;
  readonly candidateCount: number;
  readonly candidates: readonly Readonly<{
    candidateVersion: 1;
    status: "candidate";
    review: CalibrationCandidate["review"];
    measurement: CalibrationCandidate["measurement"];
    cohort: CalibrationCandidate["cohort"];
    evidence: CalibrationCandidate["evidence"];
    samples: Readonly<{
      count: number;
      cycles: DecimalIntegerSummary;
      bytesPerSample: string;
      cyclesPerByte: DecimalRationalSummary | null;
      cacheCounters?: DecimalCacheCounterSummary;
    }>;
  }>[];
}

export class CalibrationReportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CalibrationReportError";
  }
}

interface ResolvedInputs {
  readonly receiptPaths: readonly string[];
  readonly outputPath: string | null;
}

function fail(message: string): never {
  throw new CalibrationReportError(message);
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function absolutePath(path: string, cwd: string): string {
  if (path.length === 0) return fail("input and output paths must not be empty");
  return isAbsolute(path) ? resolve(path) : resolve(cwd, path);
}

function isNestedPath(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return path.length > 0 && path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path);
}

function fileIdentity(stat: Stats): string {
  return `${stat.dev}:${stat.ino}`;
}

async function outputStat(path: string): Promise<Stats | null> {
  try {
    return await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function resolveReceiptInputs(options: CalibrationReportOptions): Promise<ResolvedInputs> {
  if (options.inputs.length === 0) fail("receipt inputs must not be empty");
  const cwd = resolve(options.cwd ?? process.cwd());
  const outputPath = options.outputPath === undefined ? null : absolutePath(options.outputPath, cwd);
  if (outputPath !== null && extname(outputPath) !== ".json") {
    fail(`output path must end in .json: ${outputPath}`);
  }

  const normalizedInputs = options.inputs.map((input) => absolutePath(input, cwd));
  const explicit = new Set<string>();
  for (const path of normalizedInputs) {
    if (explicit.has(path)) fail(`duplicate input path: ${path}`);
    explicit.add(path);
  }
  const discovered = new Set<string>();
  const identities = new Map<string, string>();
  const directories: string[] = [];
  const addReceipt = (path: string, stat: Stats): void => {
    if (discovered.has(path)) fail(`duplicate receipt path: ${path}`);
    const identity = fileIdentity(stat);
    const previous = identities.get(identity);
    if (previous !== undefined) fail(`duplicate receipt file identity: ${previous} and ${path}`);
    discovered.add(path);
    identities.set(identity, path);
  };
  for (const path of normalizedInputs.sort(compareText)) {
    if (outputPath === path) fail(`output path collides with input: ${path}`);

    const stat = await lstat(path);
    if (stat.isSymbolicLink()) fail(`symlink inputs are refused: ${path}`);
    if (stat.isDirectory()) {
      directories.push(path);
      if (outputPath !== null && isNestedPath(path, outputPath)) {
        fail(`output path must not be inside an input directory: ${outputPath}`);
      }
      const entries = (await readdir(path)).sort(compareText);
      for (const entry of entries) {
        const child = resolve(path, entry);
        const childStat = await lstat(child);
        if (childStat.isSymbolicLink()) fail(`symlinks inside input directories are refused: ${child}`);
        if (childStat.isDirectory()) fail(`nested input directories are refused: ${child}`);
        if (!childStat.isFile()) fail(`non-regular input directory entry is refused: ${child}`);
        if (extname(entry) !== ".json") continue;
        addReceipt(child, childStat);
      }
      continue;
    }
    if (!stat.isFile()) fail(`non-regular input is refused: ${path}`);
    if (extname(path) !== ".json") fail(`receipt file path must end in .json: ${path}`);
    addReceipt(path, stat);
  }

  for (const directory of directories) {
    for (const path of discovered) {
      if (explicit.has(path) && isNestedPath(directory, path)) {
        fail(`duplicate receipt path supplied directly and through directory: ${path}`);
      }
    }
  }
  if (discovered.size === 0) fail("receipt inputs contain no .json files");
  if (outputPath !== null && discovered.has(outputPath)) {
    fail(`output path collides with receipt input: ${outputPath}`);
  }
  if (outputPath !== null) {
    const stat = await outputStat(outputPath);
    if (stat?.isSymbolicLink()) fail(`symlink output paths are refused: ${outputPath}`);
    if (stat !== null && !stat.isFile()) fail(`output path must be a regular file or absent: ${outputPath}`);
    if (stat?.isFile()) {
      const input = identities.get(fileIdentity(stat));
      if (input !== undefined) fail(`output path collides with receipt input identity ${input}: ${outputPath}`);
    }
  }
  return Object.freeze({
    receiptPaths: Object.freeze([...discovered].sort(compareText)),
    outputPath,
  });
}

function decimalIntegerSummary(summary: ExactIntegerSummary): DecimalIntegerSummary {
  return Object.freeze({
    min: summary.min.toString(),
    p50: summary.p50.toString(),
    p90: summary.p90.toString(),
    p99: summary.p99.toString(),
    max: summary.max.toString(),
  });
}

function decimalRational(value: ExactRational): DecimalRational {
  return Object.freeze({
    numerator: value.numerator.toString(),
    denominator: value.denominator.toString(),
  });
}

function decimalRationalSummary(summary: ExactRationalSummary): DecimalRationalSummary {
  return Object.freeze({
    min: decimalRational(summary.min),
    p50: decimalRational(summary.p50),
    p90: decimalRational(summary.p90),
    p99: decimalRational(summary.p99),
    max: decimalRational(summary.max),
  });
}

function decimalCounterSeriesSummary(summary: ExactCounterSeriesSummary): DecimalCounterSeriesSummary {
  return Object.freeze({
    total: summary.total.toString(),
    squaredTotal: summary.squaredTotal.toString(),
    cycleProductTotal: summary.cycleProductTotal.toString(),
    values: decimalIntegerSummary(summary.values),
  });
}

function decimalCacheCounterSummary(summary: ExactCacheCounterSummary): DecimalCacheCounterSummary {
  return Object.freeze({
    count: summary.count,
    cyclesTotal: summary.cyclesTotal.toString(),
    cyclesSquaredTotal: summary.cyclesSquaredTotal.toString(),
    predictorOrder: summary.predictorOrder,
    gramMatrix: Object.freeze(
      summary.gramMatrix.map((row) => Object.freeze(row.map((value) => value.toString()))),
    ),
    ibus: Object.freeze({
      accesses: decimalCounterSeriesSummary(summary.ibus.accesses),
      misses: decimalCounterSeriesSummary(summary.ibus.misses),
    }),
    dbus: Object.freeze({
      accesses: decimalCounterSeriesSummary(summary.dbus.accesses),
      flashMisses: decimalCounterSeriesSummary(summary.dbus.flashMisses),
      psramMisses: decimalCounterSeriesSummary(summary.dbus.psramMisses),
    }),
  });
}

function serializeCandidate(candidate: CalibrationCandidate): CalibrationReportV1["candidates"][number] {
  return Object.freeze({
    candidateVersion: 1,
    status: "candidate",
    review: candidate.review,
    measurement: candidate.measurement,
    cohort: candidate.cohort,
    evidence: candidate.evidence,
    samples: Object.freeze({
      count: candidate.samples.count,
      cycles: decimalIntegerSummary(candidate.samples.cycles),
      bytesPerSample: candidate.samples.bytesPerSample.toString(),
      cyclesPerByte:
        candidate.samples.cyclesPerByte === null
          ? null
          : decimalRationalSummary(candidate.samples.cyclesPerByte),
      ...(candidate.samples.cacheCounters === undefined
        ? {}
        : { cacheCounters: decimalCacheCounterSummary(candidate.samples.cacheCounters) }),
    }),
  });
}

async function readReceipts(paths: readonly string[]): Promise<readonly ParsedHardwareCalibrationReceipt[]> {
  const receipts: ParsedHardwareCalibrationReceipt[] = [];
  for (const path of paths) {
    let json: string;
    try {
      json = await readFile(path, "utf8");
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      fail(`could not read receipt ${path}: ${detail}`);
    }
    try {
      receipts.push(parseHardwareCalibrationReceipt(json));
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      fail(`invalid receipt ${path}: ${detail}`);
    }
  }
  return Object.freeze(receipts);
}

export async function buildCalibrationReport(
  options: CalibrationReportOptions,
): Promise<CalibrationReportArtifact> {
  const resolved = await resolveReceiptInputs(options);
  const receipts = await readReceipts(resolved.receiptPaths);
  const candidates = buildCalibrationCandidates(receipts).map(serializeCandidate);
  const report: CalibrationReportV1 = Object.freeze({
    reportVersion: 1,
    status: "candidate",
    review: Object.freeze({
      microbenchmarkToArchitecturalCost: "unreviewed",
      cacheClaim: "not-claimed",
      isaClaim: "not-claimed",
    }),
    receiptCount: receipts.length,
    candidateCount: candidates.length,
    candidates: Object.freeze(candidates),
  });
  return Object.freeze({
    receiptPaths: resolved.receiptPaths,
    outputPath: resolved.outputPath,
    report,
    json: `${JSON.stringify(report, null, 2)}\n`,
  });
}

export async function writeCalibrationReport(
  options: CalibrationReportOptions & Readonly<{ outputPath: string }>,
): Promise<CalibrationReportArtifact> {
  const artifact = await buildCalibrationReport(options);
  await writeFile(artifact.outputPath!, artifact.json, "utf8");
  return artifact;
}

interface CliIo {
  readonly cwd: string;
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
}

function parseCliArguments(args: readonly string[]): { inputs: string[]; outputPath?: string } {
  const inputs: string[] = [];
  let outputPath: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!;
    if (argument === "--output" || argument === "-o") {
      if (outputPath !== undefined) fail("--output may be specified only once");
      const value = args[index + 1];
      if (value === undefined || value.startsWith("-")) fail("--output requires a path");
      outputPath = value;
      index += 1;
    } else if (argument.startsWith("-")) {
      fail(`unknown option: ${argument}`);
    } else {
      inputs.push(argument);
    }
  }
  return outputPath === undefined ? { inputs } : { inputs, outputPath };
}

export async function runCalibrationReportCli(args: readonly string[], io: CliIo): Promise<number> {
  try {
    const options = parseCliArguments(args);
    if (options.outputPath === undefined) {
      const artifact = await buildCalibrationReport({ inputs: options.inputs, cwd: io.cwd });
      io.stdout(artifact.json);
    } else {
      await writeCalibrationReport({
        inputs: options.inputs,
        cwd: io.cwd,
        outputPath: options.outputPath,
      });
    }
    return 0;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    io.stderr(`${JSON.stringify({ ok: false, error: detail })}\n`);
    return 1;
  }
}

if (import.meta.main) {
  const exitCode = await runCalibrationReportCli(Bun.argv.slice(2), {
    cwd: process.cwd(),
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text),
  });
  if (exitCode !== 0) process.exitCode = exitCode;
}
