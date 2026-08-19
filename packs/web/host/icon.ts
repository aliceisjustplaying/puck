// icon: the app icon, generated rather than checked in as a binary.
//
// WHY GENERATE IT. A PWA needs a manifest icon to be installable at all,
// and iOS needs an apple-touch-icon PNG specifically (it ignores the
// manifest and it ignores SVG here), so "ship an SVG and be done" does not
// actually produce a home-screen icon on the one device this pack exists
// for. Checking in two PNGs would mean two binaries in a public repo that
// nothing regenerates and nothing checks. Sixty lines of encoder is the
// cheaper of the two.
//
// The glyph is the site's own: a blue disc with a punched-out centre, the
// silhouette a hockey puck reads as from directly above.
//
// PNG here is a hand-rolled minimal encoder (signature, IHDR, one IDAT,
// IEND) because Bun ships deflate but no image encoder, and pulling an npm
// dependency into a pack that must stay self-contained would cost far more
// than this. Bun.deflateSync returns RAW deflate, so the zlib wrapper (the
// two-byte header and the trailing adler32) is added by hand below.

const ACCENT: [number, number, number] = [0x2f, 0x6f, 0xeb];
const INNER: [number, number, number] = [0xfa, 0xfa, 0xfa];
const FIELD: [number, number, number] = [0x0b, 0x0b, 0x0b];

export function iconSvg(): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" fill="#0b0b0b"/><circle cx="16" cy="16" r="14" fill="#2f6feb"/><circle cx="16" cy="16" r="5" fill="#fafafa"/></svg>\n`;
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function adler32(bytes: Uint8Array): number {
  let a = 1;
  let b = 0;
  for (let i = 0; i < bytes.length; i++) {
    a = (a + bytes[i]!) % 65521;
    b = (b + a) % 65521;
  }
  return ((b << 16) | a) >>> 0;
}

function u32(value: number): Uint8Array {
  return new Uint8Array([(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff]);
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const typeBytes = new Uint8Array([...type].map((c) => c.charCodeAt(0)));
  const body = new Uint8Array(typeBytes.length + data.length);
  body.set(typeBytes, 0);
  body.set(data, typeBytes.length);
  const out = new Uint8Array(4 + body.length + 4);
  out.set(u32(data.length), 0);
  out.set(body, 4);
  out.set(u32(crc32(body)), 4 + body.length);
  return out;
}

export function iconPng(size: number): Uint8Array {
  const outerR = size * 0.44;
  const innerR = size * 0.157;
  const cx = (size - 1) / 2;
  const cy = (size - 1) / 2;

  // One filter byte (0, "None") per scanline, then RGB triples. Filter 0
  // throughout: the image is three flat colours, so a predictor buys
  // nothing over what deflate already finds.
  const raw = new Uint8Array(size * (1 + size * 3));
  let o = 0;
  for (let y = 0; y < size; y++) {
    raw[o++] = 0;
    for (let x = 0; x < size; x++) {
      const d = Math.hypot(x - cx, y - cy);
      const c = d <= innerR ? INNER : d <= outerR ? ACCENT : FIELD;
      raw[o++] = c[0];
      raw[o++] = c[1];
      raw[o++] = c[2];
    }
  }

  const deflated = Bun.deflateSync(raw);
  const zlib = new Uint8Array(2 + deflated.length + 4);
  zlib[0] = 0x78; // CMF: deflate, 32K window
  zlib[1] = 0x01; // FLG: no dictionary, fastest-compression level bits
  zlib.set(deflated, 2);
  zlib.set(u32(adler32(raw)), 2 + deflated.length);

  const ihdr = new Uint8Array(13);
  ihdr.set(u32(size), 0);
  ihdr.set(u32(size), 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type 2: truecolour RGB, no alpha (iOS masks its own corners)
  ihdr[10] = 0; // deflate
  ihdr[11] = 0; // adaptive filtering
  ihdr[12] = 0; // no interlace

  const signature = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const parts = [signature, chunk("IHDR", ihdr), chunk("IDAT", zlib), chunk("IEND", new Uint8Array(0))];
  const total = parts.reduce((n, p) => n + p.length, 0);
  const png = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    png.set(p, at);
    at += p.length;
  }
  return png;
}
