// site/flasher/md5.ts: MD5 of a byte array, as lowercase hex.
//
// This exists for exactly one caller: esptool-js's FlashOptions.
// calculateMD5Hash. Give writeFlash that callback and it hashes each image
// before sending it, then asks the chip for the MD5 of the flash range it
// just wrote and refuses the flash if the two disagree - which is the only
// end-to-end verification available over this transport. Leave the callback
// out and the write is unverified. So the choice is not "MD5 or something
// stronger", it is "MD5 or nothing": the digest is the ROM loader's own
// SPI_FLASH_MD5 command, not ours to pick.
//
// Written out here rather than pulled in as a dependency because the whole
// site ships self-contained bundles with no CDN (site/build.ts), and a
// 60-line hash is not worth a package. It is verified against RFC 1321's own
// test suite in md5.test.ts.
//
// Not a security primitive and never used as one: MD5 is broken for
// collision resistance, and this compares a file we just fetched same-origin
// against what a chip on the end of a USB cable read back. That is a
// transmission check.

const K = new Int32Array(64);
for (let i = 0; i < 64; i++) K[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 4294967296);

// Per-round left-rotation amounts, RFC 1321 section 3.4.
const S = [
  7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
  5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
  4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
  6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
];

function rotl(x: number, c: number): number {
  return (x << c) | (x >>> (32 - c));
}

/** MD5 of `bytes`, as 32 lowercase hex characters. */
export function md5Hex(bytes: Uint8Array): string {
  const bitLenLo = (bytes.length << 3) >>> 0;
  const bitLenHi = Math.floor(bytes.length / 536870912) >>> 0; // length * 8 / 2^32

  // Padded length: message + 0x80 + zeros + 8 length bytes, rounded to 64.
  const paddedLen = ((bytes.length + 9 + 63) & ~63) >>> 0;

  let a0 = 0x67452301;
  let b0 = 0xefcdab89;
  let c0 = 0x98badcfe;
  let d0 = 0x10325476;

  const block = new Uint8Array(64);
  const m = new Int32Array(16);
  const view = new DataView(block.buffer);

  for (let offset = 0; offset < paddedLen; offset += 64) {
    // Build this 64-byte block out of the message, the 0x80 terminator, the
    // zero fill and the little-endian bit length, without ever allocating a
    // padded copy of the whole message (a 1MB firmware image would otherwise
    // be duplicated in memory for no reason).
    block.fill(0);
    for (let i = 0; i < 64; i++) {
      const idx = offset + i;
      if (idx < bytes.length) block[i] = bytes[idx]!;
      else if (idx === bytes.length) block[i] = 0x80;
    }
    if (offset + 64 === paddedLen) {
      view.setUint32(56, bitLenLo, true);
      view.setUint32(60, bitLenHi, true);
    }
    for (let i = 0; i < 16; i++) m[i] = view.getInt32(i * 4, true);

    let a = a0;
    let b = b0;
    let c = c0;
    let d = d0;
    for (let i = 0; i < 64; i++) {
      let f: number;
      let g: number;
      if (i < 16) {
        f = (b & c) | (~b & d);
        g = i;
      } else if (i < 32) {
        f = (d & b) | (~d & c);
        g = (5 * i + 1) & 15;
      } else if (i < 48) {
        f = b ^ c ^ d;
        g = (3 * i + 5) & 15;
      } else {
        f = c ^ (b | ~d);
        g = (7 * i) & 15;
      }
      const tmp = d;
      d = c;
      c = b;
      const sum = (a + f + K[i]! + m[g]!) | 0;
      b = (b + rotl(sum, S[i]!)) | 0;
      a = tmp;
    }
    a0 = (a0 + a) | 0;
    b0 = (b0 + b) | 0;
    c0 = (c0 + c) | 0;
    d0 = (d0 + d) | 0;
  }

  const out = new Uint8Array(16);
  const outView = new DataView(out.buffer);
  outView.setInt32(0, a0, true);
  outView.setInt32(4, b0, true);
  outView.setInt32(8, c0, true);
  outView.setInt32(12, d0, true);
  let hex = "";
  for (let i = 0; i < 16; i++) hex += out[i]!.toString(16).padStart(2, "0");
  return hex;
}
