import { constants as fsConstants, accessSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import {
  DEFAULT_ESP32S3_OBJDUMP,
  DEFAULT_FLEXE_SOURCE,
  DEFAULT_TINYDRAW_ESP32S3_ELF,
  DEFAULT_TINYDRAW_ESP32S3_FIXTURE_ELF,
  DEFAULT_TINYDRAW_ESP32S3_FIXTURE_SYMBOL,
  FLEXE_COMMIT,
  FLEXE_DISASSEMBLER_SHA256
} from "./constants";
import { requireSuccess, run, sha256, verifySource } from "./lib";

export interface InstructionRow {
  address: string;
  addressValue: number;
  objdumpEncoding: string;
  rawMnemonic: string;
  normalizedMnemonic: string;
  operands: string;
  section: string;
  symbol: string | null;
}

export interface DecoderSurface {
  sourceSha256: string;
  normalizedMnemonics: string[];
}

export const ESP32S3_PATCHED_MNEMONICS = [
  "ee.andq",
  "ee.vld.128.ip",
  "ee.vld.128.xp",
  "ee.vld.h.64.ip",
  "ee.vld.h.64.xp",
  "ee.vld.l.64.ip",
  "ee.vld.l.64.xp",
  "ee.vldbc.16.ip",
  "ee.vldbc.32.ip",
  "ee.vcmp.eq.s16",
  "ee.vprelu.s16",
  "ee.vprelu.s8",
  "ee.ldf.64.ip",
  "ee.ldf.64.xp",
  "ee.ldf.128.ip",
  "ee.ldf.128.xp",
  "ee.ld.128.usar.ip",
  "ee.ld.128.usar.xp",
  "ee.movi.32.q",
  "ee.notq",
  "ee.orq",
  "ee.ldqa.s16.128.ip",
  "ee.ldqa.u16.128.ip",
  "ee.ldqa.u8.128.ip",
  "ee.ld.accx.ip",
  "ee.ld.ua_state.ip",
  "ee.ld.qacc_h.h.32.ip",
  "ee.ld.qacc_h.l.128.ip",
  "ee.ld.qacc_l.h.32.ip",
  "ee.ld.qacc_l.l.128.ip",
  "ee.st.qacc_l.l.128.ip",
  "ee.st.qacc_h.h.32.ip",
  "ee.st.qacc_h.l.128.ip",
  "ee.st.qacc_l.h.32.ip",
  "ee.st.accx.ip",
  "ee.st.ua_state.ip",
  "ee.stf.64.ip",
  "ee.stf.64.xp",
  "ee.stf.128.ip",
  "ee.stf.128.xp",
  "ee.vst.128.ip",
  "ee.vst.l.64.ip",
  "ee.vst.l.64.xp",
  "ee.vst.h.64.ip",
  "ee.vst.h.64.xp",
  "ee.vunzip.8",
  "ee.vzip.8",
  "ee.zero.q",
  "ee.xorq",
  "ld.qr",
  "lsip",
  "s32nb",
  "ssip",
  "st.qr"
] as const;

interface SectionRow {
  name: string;
  size: number;
  vma: number;
}

interface ToolOptions {
  elf: string;
  fixtureElf: string;
  fixtureSymbol: string;
  objdump: string;
  flexeSource: string;
  output: string;
}

export interface InventoryReport {
  schemaVersion: 1;
  inputs: {
    elf: { path: string; sha256: string; bytes: number; entry: string };
    fixtureElf: { path: string; sha256: string; bytes: number; symbol: string };
    objdump: { path: string; sha256: string; version: string };
    flexe: { repository: string; commit: string; decoderPath: string; decoderSha256: string };
  };
  validation: {
    fileFormat: "elf32-xtensa-le";
    architecture: "xtensa";
    esp32s3AddressEvidence: Record<string, string>;
  };
  decoderSurface: {
    normalizedMnemonicCount: number;
    normalizedMnemonics: string[];
  };
  staticExecutableSectionInventory: {
    caveat: string;
    instructionRows: number;
    supportedInstructionRows: number;
    unsupportedInstructionRows: number;
    rawMnemonicCount: number;
    supportedRawMnemonicCount: number;
    unsupportedRawMnemonicCount: number;
    unsupportedInstructionMarkers: Array<{
      pc: number;
      encoding: number;
      objdumpEncoding: string;
      rawMnemonic: string;
    }>;
    opcodeMnemonicPairs: Array<{
      normalizedMnemonic: string;
      rawMnemonic: string;
      objdumpEncoding: string;
      supportedByFlexeDecoder: boolean;
      count: number;
      firstAddress: string;
      firstSection: string;
      firstSymbol: string | null;
    }>;
    mnemonicInventory: Array<{
      normalizedMnemonic: string;
      rawMnemonic: string;
      supportedByFlexeDecoder: boolean;
      count: number;
      uniqueObjdumpEncodings: number;
      firstAddress: string;
      firstSection: string;
      firstSymbol: string | null;
    }>;
  };
  fixturePath: {
    definition: string;
    instructionsBeforeGap: Array<Pick<InstructionRow, "address" | "objdumpEncoding" | "rawMnemonic" | "operands">>;
    firstUnsupported: Pick<InstructionRow, "address" | "objdumpEncoding" | "rawMnemonic" | "normalizedMnemonic" | "operands"> | null;
  };
}

const SPECIAL_REGISTER_MNEMONICS = /^(rsr|wsr|xsr)\..*$/;
const SUPPORTED_USER_REGISTER_MNEMONICS = /^(rur|wur)\.(accx_[01]|qacc_[hl]_[0-4]|sar_byte|fft_bit_width|ua_state_[0-3]|threadptr|fcr|fsr)$/;

export function normalizeMnemonic(mnemonic: string): string {
  if (SPECIAL_REGISTER_MNEMONICS.test(mnemonic)) return mnemonic.replace(SPECIAL_REGISTER_MNEMONICS, "$1");
  if (SUPPORTED_USER_REGISTER_MNEMONICS.test(mnemonic)) {
    return mnemonic.replace(SUPPORTED_USER_REGISTER_MNEMONICS, "$1");
  }
  return mnemonic;
}

export function parseFlexeDecoderSurface(sourceText: string, sourceSha256: string): DecoderSurface {
  const mnemonics = new Set<string>();
  for (const match of sourceText.matchAll(/EMIT\("([^"\\]*(?:\\.[^"\\]*)*)"/g)) {
    const format = match[1].replaceAll("\\t", "\t");
    const mnemonic = format.split(/[\t ]/, 1)[0];
    if (mnemonic && !mnemonic.startsWith("?") && !mnemonic.includes("%")) {
      mnemonics.add(normalizeMnemonic(mnemonic));
    }
  }

  const q = ["ll", "hl", "lh", "hh"];
  for (const suffix of q) {
    mnemonics.add(`mula.da.${suffix}.lddec`);
    mnemonics.add(`mula.da.${suffix}.ldinc`);
    mnemonics.add(`mula.dd.${suffix}.lddec`);
    mnemonics.add(`mula.dd.${suffix}.ldinc`);
  }
  for (const operation of ["mul", "mula", "muls", "umul"]) {
    for (const source of ["aa", "ad", "da", "dd"]) {
      for (const suffix of q) mnemonics.add(`${operation}.${source}.${suffix}`);
    }
  }
  for (const mnemonic of ESP32S3_PATCHED_MNEMONICS) mnemonics.add(mnemonic);

  return { sourceSha256, normalizedMnemonics: [...mnemonics].sort() };
}

export function parseDisassembly(text: string): InstructionRow[] {
  const instructions: InstructionRow[] = [];
  let section = "";
  let symbol: string | null = null;
  for (const line of text.split("\n")) {
    const sectionMatch = line.match(/^Disassembly of section (.+):$/);
    if (sectionMatch) {
      section = sectionMatch[1];
      symbol = null;
      continue;
    }
    const symbolMatch = line.match(/^\s*([0-9a-fA-F]+) <(.+)>:$/);
    if (symbolMatch) {
      symbol = symbolMatch[2];
      continue;
    }
    const instructionMatch = line.match(
      /^\s*([0-9a-fA-F]+):\s+((?:[0-9a-fA-F]{2}){1,4})\s+([^\s]+)(?:\s+(.*?))?\s*$/
    );
    if (!instructionMatch) continue;
    const rawMnemonic = instructionMatch[3];
    instructions.push({
      address: `0x${instructionMatch[1].toLowerCase()}`,
      addressValue: Number.parseInt(instructionMatch[1], 16),
      objdumpEncoding: instructionMatch[2].toLowerCase(),
      rawMnemonic,
      normalizedMnemonic: normalizeMnemonic(rawMnemonic),
      operands: instructionMatch[4] ?? "",
      section,
      symbol
    });
  }
  return instructions;
}

function requireFile(path: string, label: string, executable = false): void {
  if (!existsSync(path)) throw new Error(`${label} does not exist: ${path}`);
  if (!statSync(path).isFile()) throw new Error(`${label} is not a regular file: ${path}`);
  if (executable) {
    try {
      accessSync(path, fsConstants.X_OK);
    } catch {
      throw new Error(`${label} is not executable: ${path}`);
    }
  }
}

function parseSections(text: string): SectionRow[] {
  const sections: SectionRow[] = [];
  for (const line of text.split("\n")) {
    const match = line.match(/^\s*\d+\s+(\S+)\s+([0-9a-fA-F]+)\s+([0-9a-fA-F]+)/);
    if (!match) continue;
    sections.push({
      name: match[1],
      size: Number.parseInt(match[2], 16),
      vma: Number.parseInt(match[3], 16)
    });
  }
  return sections;
}

function requireEsp32s3Elf(objdump: string, elf: string): {
  entry: string;
  evidence: Record<string, string>;
} {
  const file = run([objdump, "-f", elf]);
  requireSuccess(file);
  if (!file.stdout.includes("file format elf32-xtensa-le")) {
    throw new Error(`${elf} is not an elf32-xtensa-le executable`);
  }
  if (!file.stdout.includes("architecture: xtensa")) {
    throw new Error(`${elf} is not an Xtensa executable`);
  }
  const entryMatch = file.stdout.match(/start address (0x[0-9a-fA-F]+)/);
  if (!entryMatch) throw new Error(`${elf} has no readable entry address`);

  const header = run([objdump, "-h", elf]);
  requireSuccess(header);
  const sections = parseSections(header.stdout);
  const required = [
    { name: ".iram0.vectors", min: 0x40370000, max: 0x403e0000 },
    { name: ".flash.text", min: 0x42000000, max: 0x44000000 },
    { name: ".dram0.data", min: 0x3fc80000, max: 0x3fe00000 }
  ];
  const evidence: Record<string, string> = {};
  for (const expected of required) {
    const section = sections.find((candidate) => candidate.name === expected.name && candidate.size > 0);
    if (!section || section.vma < expected.min || section.vma >= expected.max) {
      throw new Error(
        `${elf} lacks ESP32-S3 ${expected.name} address evidence in ` +
          `0x${expected.min.toString(16)}..0x${expected.max.toString(16)}`
      );
    }
    evidence[expected.name] = `0x${section.vma.toString(16)}`;
  }
  return { entry: entryMatch[1].toLowerCase(), evidence };
}

function summarizeInventory(instructions: InstructionRow[], supported: Set<string>) {
  const opcodePairs = new Map<string, {
    normalizedMnemonic: string;
    rawMnemonic: string;
    objdumpEncoding: string;
    supportedByFlexeDecoder: boolean;
    count: number;
    firstAddress: string;
    firstAddressValue: number;
    firstSection: string;
    firstSymbol: string | null;
  }>();
  const mnemonics = new Map<string, {
    normalizedMnemonic: string;
    rawMnemonic: string;
    supportedByFlexeDecoder: boolean;
    count: number;
    encodings: Set<string>;
    firstAddress: string;
    firstAddressValue: number;
    firstSection: string;
    firstSymbol: string | null;
  }>();

  for (const instruction of instructions) {
    const isSupported = supported.has(instruction.normalizedMnemonic);
    const pairKey = `${instruction.normalizedMnemonic}\0${instruction.rawMnemonic}\0${instruction.objdumpEncoding}`;
    const pair = opcodePairs.get(pairKey);
    if (pair) {
      pair.count += 1;
      if (instruction.addressValue < pair.firstAddressValue) {
        pair.firstAddress = instruction.address;
        pair.firstAddressValue = instruction.addressValue;
        pair.firstSection = instruction.section;
        pair.firstSymbol = instruction.symbol;
      }
    } else {
      opcodePairs.set(pairKey, {
        normalizedMnemonic: instruction.normalizedMnemonic,
        rawMnemonic: instruction.rawMnemonic,
        objdumpEncoding: instruction.objdumpEncoding,
        supportedByFlexeDecoder: isSupported,
        count: 1,
        firstAddress: instruction.address,
        firstAddressValue: instruction.addressValue,
        firstSection: instruction.section,
        firstSymbol: instruction.symbol
      });
    }

    const mnemonicKey = `${instruction.normalizedMnemonic}\0${instruction.rawMnemonic}`;
    const mnemonic = mnemonics.get(mnemonicKey);
    if (mnemonic) {
      mnemonic.count += 1;
      mnemonic.encodings.add(instruction.objdumpEncoding);
      if (instruction.addressValue < mnemonic.firstAddressValue) {
        mnemonic.firstAddress = instruction.address;
        mnemonic.firstAddressValue = instruction.addressValue;
        mnemonic.firstSection = instruction.section;
        mnemonic.firstSymbol = instruction.symbol;
      }
    } else {
      mnemonics.set(mnemonicKey, {
        normalizedMnemonic: instruction.normalizedMnemonic,
        rawMnemonic: instruction.rawMnemonic,
        supportedByFlexeDecoder: isSupported,
        count: 1,
        encodings: new Set([instruction.objdumpEncoding]),
        firstAddress: instruction.address,
        firstAddressValue: instruction.addressValue,
        firstSection: instruction.section,
        firstSymbol: instruction.symbol
      });
    }
  }

  const pairRows = [...opcodePairs.values()]
    .sort((a, b) =>
      a.normalizedMnemonic.localeCompare(b.normalizedMnemonic) ||
      a.rawMnemonic.localeCompare(b.rawMnemonic) ||
      a.objdumpEncoding.localeCompare(b.objdumpEncoding)
    )
    .map(({ firstAddressValue: _firstAddressValue, ...pair }) => pair);
  const mnemonicRows = [...mnemonics.values()]
    .sort((a, b) =>
      a.normalizedMnemonic.localeCompare(b.normalizedMnemonic) || a.rawMnemonic.localeCompare(b.rawMnemonic)
    )
    .map(({ encodings, firstAddressValue: _firstAddressValue, ...mnemonic }) => ({
      ...mnemonic,
      uniqueObjdumpEncodings: encodings.size
    }));
  const supportedRows = instructions.filter((row) => supported.has(row.normalizedMnemonic)).length;
  const unsupportedInstructionMarkers = instructions
    .filter((row) => row.rawMnemonic !== ".byte" && !supported.has(row.normalizedMnemonic))
    .map((row) => {
      const objdumpEncoding = Number.parseInt(row.objdumpEncoding, 16);
      const decoderLength = (objdumpEncoding & 8) !== 0 ? 2 : 3;
      return {
        pc: row.addressValue,
        encoding: objdumpEncoding & (decoderLength === 2 ? 0xffff : 0xff_ffff),
        objdumpEncoding: row.objdumpEncoding,
        rawMnemonic: row.rawMnemonic
      };
    });
  return {
    instructionRows: instructions.length,
    supportedInstructionRows: supportedRows,
    unsupportedInstructionRows: instructions.length - supportedRows,
    rawMnemonicCount: mnemonicRows.length,
    supportedRawMnemonicCount: mnemonicRows.filter((row) => row.supportedByFlexeDecoder).length,
    unsupportedRawMnemonicCount: mnemonicRows.filter((row) => !row.supportedByFlexeDecoder).length,
    unsupportedInstructionMarkers,
    opcodeMnemonicPairs: pairRows,
    mnemonicInventory: mnemonicRows
  };
}

function parseArguments(args: string[]): ToolOptions {
  const options: ToolOptions = {
    elf: resolve(process.env.TINYDRAW_ESP32S3_ELF ?? DEFAULT_TINYDRAW_ESP32S3_ELF),
    fixtureElf: resolve(
      process.env.TINYDRAW_ESP32S3_FIXTURE_ELF ?? DEFAULT_TINYDRAW_ESP32S3_FIXTURE_ELF
    ),
    fixtureSymbol: process.env.TINYDRAW_ESP32S3_FIXTURE_SYMBOL ?? DEFAULT_TINYDRAW_ESP32S3_FIXTURE_SYMBOL,
    objdump: resolve(process.env.ESP32S3_OBJDUMP ?? DEFAULT_ESP32S3_OBJDUMP),
    flexeSource: resolve(process.env.FLEXE_SOURCE ?? DEFAULT_FLEXE_SOURCE),
    output: resolve(process.env.ESP32S3_ISA_REPORT ?? join(import.meta.dir, "dist/esp32s3-isa-inventory.json"))
  };
  const destinations = new Map<string, keyof ToolOptions>([
    ["--elf", "elf"],
    ["--fixture-elf", "fixtureElf"],
    ["--fixture-symbol", "fixtureSymbol"],
    ["--objdump", "objdump"],
    ["--flexe-source", "flexeSource"],
    ["--out", "output"]
  ]);
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index];
    const value = args[index + 1];
    const destination = destinations.get(name);
    if (!destination || value === undefined) throw new Error(`unknown or incomplete argument: ${name}`);
    options[destination] = destination === "fixtureSymbol" ? value : resolve(value);
  }
  return options;
}

export function buildInventoryReport(options: ToolOptions): InventoryReport {
  requireFile(options.objdump, "ESP32-S3 objdump", true);
  if (basename(options.objdump) !== "xtensa-esp32s3-elf-objdump") {
    throw new Error(`wrong architecture tool: expected xtensa-esp32s3-elf-objdump, got ${basename(options.objdump)}`);
  }
  requireFile(options.elf, "TinyDraw ELF");
  requireFile(options.fixtureElf, "TinyDraw fixture ELF");
  verifySource(options.flexeSource);

  const decoderPath = join(options.flexeSource, "src/xtensa_disasm.c");
  requireFile(decoderPath, "pinned flexe decoder source");
  const decoderSha256 = sha256(decoderPath);
  if (decoderSha256 !== FLEXE_DISASSEMBLER_SHA256) {
    throw new Error(
      `src/xtensa_disasm.c has sha256 ${decoderSha256}, expected ${FLEXE_DISASSEMBLER_SHA256}`
    );
  }
  const surface = parseFlexeDecoderSurface(readFileSync(decoderPath, "utf8"), decoderSha256);
  const supported = new Set(surface.normalizedMnemonics);

  const elfValidation = requireEsp32s3Elf(options.objdump, options.elf);
  requireEsp32s3Elf(options.objdump, options.fixtureElf);
  const disassembly = run([options.objdump, "-d", options.elf]);
  requireSuccess(disassembly);
  const instructions = parseDisassembly(disassembly.stdout);
  if (instructions.length === 0) throw new Error(`${options.elf} produced no disassembly rows`);

  const fixtureDisassembly = run([
    options.objdump,
    "-d",
    `--disassemble=${options.fixtureSymbol}`,
    options.fixtureElf
  ]);
  requireSuccess(fixtureDisassembly);
  const fixtureInstructions = parseDisassembly(fixtureDisassembly.stdout).filter(
    (row) => row.symbol === options.fixtureSymbol || row.symbol?.startsWith(`${options.fixtureSymbol}+`)
  );
  if (fixtureInstructions.length === 0) {
    throw new Error(`fixture symbol ${options.fixtureSymbol} has no disassembly rows`);
  }
  const gapIndex = fixtureInstructions.findIndex((row) => !supported.has(row.normalizedMnemonic));
  const firstUnsupported = gapIndex < 0 ? null : fixtureInstructions[gapIndex];

  const version = run([options.objdump, "--version"]);
  requireSuccess(version);
  const elfStat = statSync(options.elf);
  const fixtureStat = statSync(options.fixtureElf);
  const summary = summarizeInventory(instructions, supported);
  return {
    schemaVersion: 1,
    inputs: {
      elf: {
        path: options.elf,
        sha256: sha256(options.elf),
        bytes: elfStat.size,
        entry: elfValidation.entry
      },
      fixtureElf: {
        path: options.fixtureElf,
        sha256: sha256(options.fixtureElf),
        bytes: fixtureStat.size,
        symbol: options.fixtureSymbol
      },
      objdump: {
        path: options.objdump,
        sha256: sha256(options.objdump),
        version: version.stdout.trim().split("\n")[0]
      },
      flexe: {
        repository: "https://github.com/levkropp/flexe",
        commit: FLEXE_COMMIT,
        decoderPath: "src/xtensa_disasm.c",
        decoderSha256
      }
    },
    validation: {
      fileFormat: "elf32-xtensa-le",
      architecture: "xtensa",
      esp32s3AddressEvidence: elfValidation.evidence
    },
    decoderSurface: {
      normalizedMnemonicCount: surface.normalizedMnemonics.length,
      normalizedMnemonics: surface.normalizedMnemonics
    },
    staticExecutableSectionInventory: {
      caveat:
        "GNU objdump -d linearly decodes executable sections, including unreachable padding and literal pools. " +
        "Counts are a deterministic static surface inventory, not dynamic execution coverage.",
      ...summary
    },
    fixturePath: {
      definition:
        `Linear path from ${options.fixtureSymbol} with a4 nonzero, so loopnez enters its body.`,
      instructionsBeforeGap: (gapIndex < 0 ? fixtureInstructions : fixtureInstructions.slice(0, gapIndex)).map(
        ({ address, objdumpEncoding, rawMnemonic, operands }) => ({
          address,
          objdumpEncoding,
          rawMnemonic,
          operands
        })
      ),
      firstUnsupported: firstUnsupported ? {
        address: firstUnsupported.address,
        objdumpEncoding: firstUnsupported.objdumpEncoding,
        rawMnemonic: firstUnsupported.rawMnemonic,
        normalizedMnemonic: firstUnsupported.normalizedMnemonic,
        operands: firstUnsupported.operands
      } : null
    }
  };
}

if (import.meta.main) {
  const options = parseArguments(process.argv.slice(2));
  const report = buildInventoryReport(options);
  mkdirSync(dirname(options.output), { recursive: true });
  writeFileSync(options.output, `${JSON.stringify(report, null, 2)}\n`);
  const inventory = report.staticExecutableSectionInventory;
  console.log(JSON.stringify({
    output: options.output,
    elfSha256: report.inputs.elf.sha256,
    objdumpSha256: report.inputs.objdump.sha256,
    decoderSha256: report.inputs.flexe.decoderSha256,
    instructionRows: inventory.instructionRows,
    supportedInstructionRows: inventory.supportedInstructionRows,
    unsupportedInstructionRows: inventory.unsupportedInstructionRows,
    rawMnemonicCount: inventory.rawMnemonicCount,
    unsupportedRawMnemonicCount: inventory.unsupportedRawMnemonicCount,
    firstUnsupported: report.fixturePath.firstUnsupported
  }, null, 2));
}
