// site/flasher/md5.test.ts: RFC 1321's own test suite, plus the two cases a
// hand-rolled MD5 gets wrong in ways short strings never show.
//
// This hash is what esptool-js compares against the chip's SPI_FLASH_MD5
// answer, so a wrong digest does not corrupt a flash - it REJECTS a good one,
// every time, on hardware nobody can debug from here. Pinning it against the
// published vectors is what keeps that from being discovered at a bench.
import { describe, expect, test } from "bun:test";
import { md5Hex } from "./md5";

function md5OfString(s: string): string {
  return md5Hex(new TextEncoder().encode(s));
}

describe("md5Hex, against RFC 1321's test suite", () => {
  const vectors: [string, string][] = [
    ["", "d41d8cd98f00b204e9800998ecf8427e"],
    ["a", "0cc175b9c0f1b6a831c399e269772661"],
    ["abc", "900150983cd24fb0d6963f7d28e17f72"],
    ["message digest", "f96b697d7cb7938d525a2f31aaf161d0"],
    ["abcdefghijklmnopqrstuvwxyz", "c3fcd3d76192e4007dfb496cca67e13b"],
    ["ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789", "d174ab98d277d9f5a5611c2c9f419d9f"],
    ["12345678901234567890123456789012345678901234567890123456789012345678901234567890", "57edf4a22be3c955ac49da2e2107b67a"],
  ];
  for (const [input, expected] of vectors) {
    test(`"${input.length > 20 ? `${input.slice(0, 20)}…` : input}" (${input.length} bytes)`, () => {
      expect(md5OfString(input)).toBe(expected);
    });
  }
});

describe("the block-boundary cases short strings never reach", () => {
  // 55, 56 and 64 bytes are where the padding either fits in the last block,
  // needs a whole extra block, or lands exactly on a boundary. An MD5 that
  // gets the length field or the extra block wrong passes every vector above
  // and fails here.
  test("55 bytes: padding and length still fit the same block", () => {
    expect(md5OfString("a".repeat(55))).toBe("ef1772b6dff9a122358552954ad0df65");
  });

  test("56 bytes: the length field forces one more block", () => {
    expect(md5OfString("a".repeat(56))).toBe("3b0c8ac703f828b04c6c197006d17218");
  });

  test("64 bytes: an exact block, fully padded into a second one", () => {
    expect(md5OfString("a".repeat(64))).toBe("014842d480b571495a4a0363793f7367");
  });
});

describe("bytes, not text", () => {
  test("hashes arbitrary bytes including 0x00 and 0xFF", () => {
    // The real input is a firmware image: mostly non-ASCII, with long runs of
    // 0xFF where the merge filled the gaps between partitions.
    const bytes = new Uint8Array(1024);
    for (let i = 0; i < bytes.length; i++) bytes[i] = i & 0xff;
    // Cross-checked against bun's own CryptoHasher, an independent
    // implementation, so this expectation is not this file grading itself.
    expect(md5Hex(bytes)).toBe(new Bun.CryptoHasher("md5").update(bytes).digest("hex"));
  });

  test("agrees with an independent implementation on a megabyte of pseudo-random bytes", () => {
    const bytes = new Uint8Array(1024 * 1024 + 37);
    let x = 123456789;
    for (let i = 0; i < bytes.length; i++) {
      x = (x * 1103515245 + 12345) & 0x7fffffff;
      bytes[i] = (x >>> 16) & 0xff;
    }
    expect(md5Hex(bytes)).toBe(new Bun.CryptoHasher("md5").update(bytes).digest("hex"));
  });
});
