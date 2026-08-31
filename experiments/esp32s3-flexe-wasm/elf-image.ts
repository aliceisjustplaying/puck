import { createHash } from "node:crypto";
import { parseXtensaElf32WithDigest, type Elf32XtensaImage } from "./elf-image-core";

export type { Elf32LoadSegment, Elf32XtensaImage } from "./elf-image-core";

function digest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Parse only the executable surface needed by the WebAssembly Xtensa runner. */
export function parseXtensaElf32(input: Uint8Array): Elf32XtensaImage {
  return parseXtensaElf32WithDigest(input, digest);
}
