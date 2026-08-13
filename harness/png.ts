// A minimal, dependency-free 24-bit RGB PNG encoder: one IDAT chunk, filter
// type None on every scanline, compressed with Bun's built-in deflate. No
// image library, because this repo's only other dependency is
// puppeteer-core (for the DOM-based headless check in scripts/verify.ts)
// and this is a small enough amount of bytes to just write directly.
//
// Bun.deflateSync produces raw DEFLATE (RFC 1951); PNG's IDAT chunk needs a
// zlib-wrapped stream (RFC 1950: a 2-byte header, then the deflate data,
// then a 4-byte Adler-32 trailer), so both are added by hand around the
// compressed bytes.

function crc32(buf: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i]!;
    for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1;
  }
  return (c ^ 0xffffffff) >>> 0;
}

function adler32(buf: Uint8Array): number {
  let a = 1, b = 0;
  const MOD = 65521;
  for (let i = 0; i < buf.length; i++) {
    a = (a + buf[i]!) % MOD;
    b = (b + a) % MOD;
  }
  return ((b << 16) | a) >>> 0;
}

function u32be(n: number): Uint8Array {
  return new Uint8Array([(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff]);
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const typeBytes = new TextEncoder().encode(type);
  const body = new Uint8Array(typeBytes.length + data.length);
  body.set(typeBytes, 0);
  body.set(data, typeBytes.length);
  const out = new Uint8Array(4 + body.length + 4);
  out.set(u32be(data.length), 0);
  out.set(body, 4);
  out.set(u32be(crc32(body)), 4 + body.length);
  return out;
}

function concat(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return out;
}

// rgb: width * height * 3 bytes, row-major, top-left origin.
export function encodeRGBPNG(width: number, height: number, rgb: Uint8Array): Uint8Array {
  const sig = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);

  const ihdrData = new Uint8Array(13);
  ihdrData.set(u32be(width), 0);
  ihdrData.set(u32be(height), 4);
  ihdrData[8] = 8; // bit depth
  ihdrData[9] = 2; // color type: RGB
  ihdrData[10] = 0; // compression
  ihdrData[11] = 0; // filter
  ihdrData[12] = 0; // interlace
  const ihdr = chunk("IHDR", ihdrData);

  // Filter type None (0) prefixed to every scanline.
  const stride = width * 3;
  const raw = new Uint8Array((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    raw.set(rgb.subarray(y * stride, y * stride + stride), y * (stride + 1) + 1);
  }

  const deflated = Bun.deflateSync(raw, { level: 6 });
  const zlibStream = new Uint8Array(2 + deflated.length + 4);
  zlibStream[0] = 0x78; // CMF: deflate, 32K window
  zlibStream[1] = 0x9c; // FLG: default compression, checksum valid
  zlibStream.set(deflated, 2);
  zlibStream.set(u32be(adler32(raw)), 2 + deflated.length);
  const idat = chunk("IDAT", zlibStream);

  const iend = chunk("IEND", new Uint8Array(0));

  return concat([sig, ihdr, idat, iend]);
}
