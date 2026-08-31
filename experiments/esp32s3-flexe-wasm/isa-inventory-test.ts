import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_ESP32S3_OBJDUMP,
  DEFAULT_FLEXE_SOURCE,
  DEFAULT_TINYDRAW_ESP32S3_ELF,
  DEFAULT_TINYDRAW_ESP32S3_FIXTURE_ELF,
  DEFAULT_TINYDRAW_ESP32S3_FIXTURE_SYMBOL,
  DEFAULT_TINYDRAW_ESP32S3_FULL_ELF,
  FLEXE_DISASSEMBLER_SHA256
} from "./constants";
import { ESP32S3_FULL_ELF_UNSUPPORTED_INVENTORY } from "./esp32s3-full-elf-unsupported";
import { buildInventoryReport, normalizeMnemonic, parseDisassembly, parseFlexeDecoderSurface } from "./isa-inventory";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

assert(normalizeMnemonic("rsr.ccount") === "rsr", "special-register aliases must normalize");
assert(normalizeMnemonic("wur.threadptr") === "wur", "implemented user-register aliases must normalize");
assert(normalizeMnemonic("rur.accx_1") === "rur", "implemented ACCX aliases must normalize");
assert(normalizeMnemonic("rur.qacc_h_0") === "rur.qacc_h_0", "unknown user registers must remain explicit gaps");
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
assert(surface.normalizedMnemonics.includes("s32nb"), "ESP32-S3 scalar patch surface lost s32nb");
assert(surface.normalizedMnemonics.includes("ee.vld.128.ip"), "ESP32-S3 PIE patch surface lost vector load");
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
  report.inputs.elf.sha256 === "a46349d9bc5eb3e58fad64f95e433c0b505ea3fa9737664d2d0f4945534b9644",
  "current panel-probe ELF changed, regenerate and review the inventory"
);
assert(
  report.inputs.fixtureElf.sha256 === "591c4d9b5ade8f978f2a910e48e2bf9af345c781bdbed1ac6f1ffa2383c7a742",
  "SIMD fixture ELF changed, regenerate and review the first gap"
);
assert(
  report.inputs.objdump.sha256 === "90a91caa519b895bd457f4eb7c5fd6b14a9c64c0c7d946e78e7f332ea57d7466",
  "ESP32-S3 objdump changed, regenerate and review the inventory"
);
assert(report.inputs.flexe.decoderSha256 === FLEXE_DISASSEMBLER_SHA256, "flexe decoder hash changed");
assert(
  report.fixturePath.instructionsBeforeGap.map((row) => row.rawMnemonic).join(",") ===
    "entry,nop.n,loopnez,ee.vld.128.ip,ee.vld.128.ip,ee.vunzip.8,ee.vzip.8,ee.vst.128.ip,ee.vst.128.ip,retw.n",
  "fixture covered path changed"
);
assert(report.fixturePath.firstUnsupported === null, "PIE fixture still has an unsupported instruction");
const fullElfReport = buildInventoryReport({
  elf: DEFAULT_TINYDRAW_ESP32S3_FULL_ELF,
  fixtureElf: DEFAULT_TINYDRAW_ESP32S3_FIXTURE_ELF,
  fixtureSymbol: DEFAULT_TINYDRAW_ESP32S3_FIXTURE_SYMBOL,
  objdump: DEFAULT_ESP32S3_OBJDUMP,
  flexeSource: DEFAULT_FLEXE_SOURCE,
  output: join(import.meta.dir, "dist/test-full-elf-inventory.json")
});
assert(
  fullElfReport.inputs.elf.sha256 === ESP32S3_FULL_ELF_UNSUPPORTED_INVENTORY.elfSha256,
  "tracked full-ELF unsupported inventory belongs to a different image"
);
assert(
  fullElfReport.inputs.objdump.sha256 === ESP32S3_FULL_ELF_UNSUPPORTED_INVENTORY.objdumpSha256,
  "tracked full-ELF unsupported inventory belongs to a different objdump"
);
assert(
  fullElfReport.inputs.flexe.decoderSha256 === ESP32S3_FULL_ELF_UNSUPPORTED_INVENTORY.flexeDecoderSha256,
  "tracked full-ELF unsupported inventory belongs to a different decoder"
);
assert(
  fullElfReport.staticExecutableSectionInventory.unsupportedInstructionRows ===
    ESP32S3_FULL_ELF_UNSUPPORTED_INVENTORY.unsupportedRows,
  "tracked full-ELF unsupported row count changed"
);
const fullElfByteRows = fullElfReport.staticExecutableSectionInventory.mnemonicInventory
  .find((row) => row.rawMnemonic === ".byte")?.count ?? 0;
assert(
  fullElfByteRows === ESP32S3_FULL_ELF_UNSUPPORTED_INVENTORY.excludedByteRows,
  "tracked full-ELF undecodable byte count changed"
);
assert(
  JSON.stringify(fullElfReport.staticExecutableSectionInventory.unsupportedInstructionMarkers
    .map(({ pc, encoding }) => [pc, encoding])) ===
    JSON.stringify(ESP32S3_FULL_ELF_UNSUPPORTED_INVENTORY.markers),
  "tracked full-ELF unsupported marker set changed"
);
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
  fixtureFirstUnsupported: report.fixturePath.firstUnsupported
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
