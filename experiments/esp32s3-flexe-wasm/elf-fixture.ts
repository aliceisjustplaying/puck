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

export interface ExtractedElfRange {
  address: number;
  bytes: Uint8Array;
  sha256: string;
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

export function extractElfRange(
  objdump: string,
  elf: string,
  address: number,
  length: number
): ExtractedElfRange {
  if (!Number.isSafeInteger(address) || address < 0 || address > 0xffffffff) {
    throw new Error(`invalid ELF range address ${address}`);
  }
  if (!Number.isSafeInteger(length) || length <= 0) throw new Error(`invalid ELF range length ${length}`);
  const dump = run([
    objdump,
    "-s",
    `--start-address=0x${address.toString(16)}`,
    `--stop-address=0x${(address + length).toString(16)}`,
    elf
  ]);
  requireSuccess(dump);
  const output = new Uint8Array(length);
  const seen = new Uint8Array(length);
  for (const line of dump.stdout.split("\n")) {
    const match = line.match(/^\s*([0-9a-fA-F]+)\s+((?:[0-9a-fA-F]{8}\s*){1,4})/);
    if (!match) continue;
    const rowAddress = Number.parseInt(match[1], 16);
    const hex = match[2].replaceAll(/\s/g, "");
    const row = hex.match(/[0-9a-fA-F]{2}/g)?.map((pair) => Number.parseInt(pair, 16)) ?? [];
    for (let index = 0; index < row.length; index++) {
      const offset = rowAddress + index - address;
      if (offset < 0 || offset >= length) continue;
      output[offset] = row[index];
      seen[offset] = 1;
    }
  }
  if (seen.some((value) => value === 0)) {
    throw new Error(`ELF range 0x${address.toString(16)}..0x${(address + length).toString(16)} is sparse`);
  }
  return {
    address,
    bytes: output,
    sha256: createHash("sha256").update(output).digest("hex")
  };
}
