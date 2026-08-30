import { createHash } from "node:crypto";
import { parseDisassembly, type InstructionRow } from "./isa-inventory";
import { requireSuccess, run, sha256 } from "./lib";

export interface ExtractedElfFunction {
  symbol: string;
  pc: number;
  endPc: number;
  bytes: Uint8Array;
  codeSha256: string;
  elfSha256: string;
  objdumpSha256: string;
  instructions: InstructionRow[];
}

export function objdumpEncodingBytes(encoding: string): number[] {
  if (!/^(?:[0-9a-fA-F]{2}){1,4}$/.test(encoding)) {
    throw new Error(`invalid objdump encoding: ${encoding}`);
  }
  const bytePairs = encoding.match(/[0-9a-fA-F]{2}/g);
  if (!bytePairs) throw new Error(`empty objdump encoding: ${encoding}`);
  return bytePairs.reverse().map((pair) => Number.parseInt(pair, 16));
}

export function extractElfFunction(objdump: string, elf: string, symbol: string): ExtractedElfFunction {
  const disassembly = run([objdump, "-d", `--disassemble=${symbol}`, elf]);
  requireSuccess(disassembly);
  const instructions = parseDisassembly(disassembly.stdout).filter(
    (row) => row.symbol === symbol || row.symbol?.startsWith(`${symbol}+`)
  );
  if (instructions.length === 0) throw new Error(`ELF symbol ${symbol} has no instructions`);

  const bytes: number[] = [];
  let nextAddress = instructions[0].addressValue;
  for (const instruction of instructions) {
    if (instruction.addressValue !== nextAddress) {
      throw new Error(
        `ELF symbol ${symbol} is not contiguous at ${instruction.address}; expected 0x${nextAddress.toString(16)}`
      );
    }
    const instructionBytes = objdumpEncodingBytes(instruction.objdumpEncoding);
    bytes.push(...instructionBytes);
    nextAddress += instructionBytes.length;
  }

  const code = Uint8Array.from(bytes);
  return {
    symbol,
    pc: instructions[0].addressValue,
    endPc: nextAddress,
    bytes: code,
    codeSha256: createHash("sha256").update(code).digest("hex"),
    elfSha256: sha256(elf),
    objdumpSha256: sha256(objdump),
    instructions
  };
}
