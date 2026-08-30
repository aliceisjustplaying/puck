import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_ESP32S3_OBJDUMP,
  DEFAULT_FLEXE_SOURCE,
  DEFAULT_TINYDRAW_ESP32S3_ELF,
  DEFAULT_TINYDRAW_ESP32S3_FIXTURE_ELF,
  DEFAULT_TINYDRAW_ESP32S3_FIXTURE_SYMBOL,
  FLEXE_DISASSEMBLER_SHA256
} from "./constants";
import { buildInventoryReport, normalizeMnemonic, parseDisassembly, parseFlexeDecoderSurface } from "./isa-inventory";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

assert(normalizeMnemonic("rsr.ccount") === "rsr", "special-register aliases must normalize");
assert(normalizeMnemonic("ee.vld.128.ip") === "ee.vld.128.ip", "PIE mnemonics must stay exact");

const parsed = parseDisassembly(`Disassembly of section .iram0.text:
40377a4c <fixture>:
40377a4c:\t002136        \tentry\ta1, 16
40377a4f:\tf03d      \tnop.n
40377a54:\t830124        \tee.vld.128.ip\tq0, a2, 16
`);
assert(parsed.length === 3, "disassembly parser lost fixture instructions");
assert(parsed[2].objdumpEncoding === "830124", "opcode encoding changed");
assert(parsed[2].symbol === "fixture", "symbol association changed");

const surface = parseFlexeDecoderSurface(
  'EMIT("entry\\ta%d, %d"); EMIT("rsr\\ta%d, %s"); EMIT("??gap");',
  FLEXE_DISASSEMBLER_SHA256
);
assert(surface.normalizedMnemonics.includes("entry"), "literal decoder surface lost entry");
assert(surface.normalizedMnemonics.includes("rsr"), "literal decoder surface lost rsr");
assert(!surface.normalizedMnemonics.includes("??gap"), "unknown decoder diagnostics are not instructions");

const report = buildInventoryReport({
  elf: DEFAULT_TINYDRAW_ESP32S3_ELF,
  fixtureElf: DEFAULT_TINYDRAW_ESP32S3_FIXTURE_ELF,
  fixtureSymbol: DEFAULT_TINYDRAW_ESP32S3_FIXTURE_SYMBOL,
  objdump: DEFAULT_ESP32S3_OBJDUMP,
  flexeSource: DEFAULT_FLEXE_SOURCE,
  output: join(import.meta.dir, "dist/test-inventory.json")
});
const baseline = JSON.parse(readFileSync(join(import.meta.dir, "esp32s3-isa-baseline.json"), "utf8"));
assert(
  report.inputs.elf.sha256 === "87d6a00ffdf18c9bcb7dd3742658b5a1786212f939f5cbafe1b82562a350f70f",
  "current panel-probe ELF changed, regenerate and review the inventory"
);
assert(
  report.inputs.fixtureElf.sha256 === "2293fb3d35ba2f785e4dce5dfb35d2f33e452150167dc8d24f0e091cfa3e6d53",
  "SIMD fixture ELF changed, regenerate and review the first gap"
);
assert(
  report.inputs.objdump.sha256 === "90a91caa519b895bd457f4eb7c5fd6b14a9c64c0c7d946e78e7f332ea57d7466",
  "ESP32-S3 objdump changed, regenerate and review the inventory"
);
assert(report.inputs.flexe.decoderSha256 === FLEXE_DISASSEMBLER_SHA256, "flexe decoder hash changed");
assert(report.fixturePath.instructionsBeforeGap.map((row) => row.rawMnemonic).join(",") === "entry,nop.n,loopnez", "fixture prefix changed");
assert(report.fixturePath.firstUnsupported.address === "0x40377a54", "first gap address changed");
assert(report.fixturePath.firstUnsupported.objdumpEncoding === "830124", "first gap encoding changed");
assert(report.fixturePath.firstUnsupported.rawMnemonic === "ee.vld.128.ip", "first gap mnemonic changed");
const actualBaseline = {
  inputs: {
    elfSha256: report.inputs.elf.sha256,
    fixtureElfSha256: report.inputs.fixtureElf.sha256,
    objdumpSha256: report.inputs.objdump.sha256,
    flexeDecoderSha256: report.inputs.flexe.decoderSha256
  },
  coverage: {
    decoderNormalizedMnemonics: report.decoderSurface.normalizedMnemonicCount,
    instructionRows: report.staticExecutableSectionInventory.instructionRows,
    supportedInstructionRows: report.staticExecutableSectionInventory.supportedInstructionRows,
    unsupportedInstructionRows: report.staticExecutableSectionInventory.unsupportedInstructionRows,
    rawMnemonics: report.staticExecutableSectionInventory.rawMnemonicCount,
    supportedRawMnemonics: report.staticExecutableSectionInventory.supportedRawMnemonicCount,
    unsupportedRawMnemonics: report.staticExecutableSectionInventory.unsupportedRawMnemonicCount
  },
  unsupportedMnemonicRows: Object.fromEntries(
    report.staticExecutableSectionInventory.mnemonicInventory
      .filter((row) => !row.supportedByFlexeDecoder)
      .map((row) => [row.rawMnemonic, row.count])
  ),
  fixtureFirstUnsupported: {
    address: report.fixturePath.firstUnsupported.address,
    objdumpEncoding: report.fixturePath.firstUnsupported.objdumpEncoding,
    rawMnemonic: report.fixturePath.firstUnsupported.rawMnemonic,
    operands: report.fixturePath.firstUnsupported.operands
  }
};
assert(
  JSON.stringify(actualBaseline) === JSON.stringify({
    inputs: baseline.inputs,
    coverage: baseline.coverage,
    unsupportedMnemonicRows: baseline.unsupportedMnemonicRows,
    fixtureFirstUnsupported: baseline.fixtureFirstUnsupported
  }),
  "tracked ISA baseline changed"
);

const temporary = mkdtempSync(join(tmpdir(), "puck-isa-reject-"));
const wrongTool = join(temporary, "objdump");
writeFileSync(wrongTool, "#!/bin/sh\nexit 0\n");
chmodSync(wrongTool, 0o755);
let wrongArchitectureRejected = false;
try {
  buildInventoryReport({
    elf: DEFAULT_TINYDRAW_ESP32S3_ELF,
    fixtureElf: DEFAULT_TINYDRAW_ESP32S3_FIXTURE_ELF,
    fixtureSymbol: DEFAULT_TINYDRAW_ESP32S3_FIXTURE_SYMBOL,
    objdump: wrongTool,
    flexeSource: DEFAULT_FLEXE_SOURCE,
    output: join(temporary, "unused.json")
  });
} catch (error) {
  wrongArchitectureRejected = String(error).includes("wrong architecture tool");
}
assert(wrongArchitectureRejected, "wrong architecture tool was accepted");

let wrongArchitectureElfRejected = false;
try {
  buildInventoryReport({
    elf: "/bin/ls",
    fixtureElf: DEFAULT_TINYDRAW_ESP32S3_FIXTURE_ELF,
    fixtureSymbol: DEFAULT_TINYDRAW_ESP32S3_FIXTURE_SYMBOL,
    objdump: DEFAULT_ESP32S3_OBJDUMP,
    flexeSource: DEFAULT_FLEXE_SOURCE,
    output: join(temporary, "unused.json")
  });
} catch (error) {
  wrongArchitectureElfRejected = String(error).includes("file format not recognized");
}
assert(wrongArchitectureElfRejected, "wrong architecture ELF was accepted");

let missingElfRejected = false;
try {
  buildInventoryReport({
    elf: join(temporary, "missing.elf"),
    fixtureElf: DEFAULT_TINYDRAW_ESP32S3_FIXTURE_ELF,
    fixtureSymbol: DEFAULT_TINYDRAW_ESP32S3_FIXTURE_SYMBOL,
    objdump: DEFAULT_ESP32S3_OBJDUMP,
    flexeSource: DEFAULT_FLEXE_SOURCE,
    output: join(temporary, "unused.json")
  });
} catch (error) {
  missingElfRejected = String(error).includes("does not exist");
}
assert(missingElfRejected, "missing ELF was accepted");

console.log(JSON.stringify({
  instructionRows: report.staticExecutableSectionInventory.instructionRows,
  unsupportedRawMnemonics: report.staticExecutableSectionInventory.unsupportedRawMnemonicCount,
  firstUnsupported: report.fixturePath.firstUnsupported
}, null, 2));
