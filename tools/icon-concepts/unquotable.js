// UNQUOTABLE — app icon for "AI Crawlability Lens".
//
// Concept: a quotation mark that cannot close.
// A quote is a pair. Here the first mark lands solid and the second is only its
// own empty outline — the shape of a citation with nothing inside it. That is
// what a JS-rendered page looks like to GPTBot: the outline of an answer, no
// substance to quote.
//
// Rules this obeys:
//   * No container tile. The mark is its own silhouette, full-bleed left to
//     right, on transparency.
//   * No gradient of any kind, and no blue/violet. One flat vermillion.
//   * Two shapes only.
//   * Every edge sits on a whole 1/16 of the canvas, so at 16px every boundary
//     lands on a pixel line. Nothing in the design is antialiased at 16px except
//     the two diagonal tails, which are meant to be diagonal.
//
// Dependency-free PNG writer, adapted from tools/make-icons.js.

const fs = require('fs');
const zlib = require('zlib');
const path = require('path');

/* ------------------------------------------------------------------ PNG --- */

function crc32(buf) {
  const table = [];
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) crc = table[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td), 0);
  return Buffer.concat([len, td, crc]);
}

function encodePng(width, height, rgba) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;

  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0;
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }

  return Buffer.concat([
    sig,
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

/* ------------------------------------------------------------------ ink --- */

// Colour story: one flat vermillion, the colour of an editor's mark and of a
// pull quote — not a tech gradient. Its relative luminance (~0.21) sits between
// the light (#f1f3f4, L 0.89) and dark (#292a2d, L 0.023) Chrome toolbars, so
// the same single ink clears ~3.5:1 against both. Nothing is layered, nothing
// is graded.
const INK = [0xde, 0x4b, 0x2a];

/* ------------------------------------------------------------- geometry --- */
// All coordinates are 16ths of the canvas.
//
//   x:  0 ....... 7   9 ....... 16      two 7-wide marks, 2-wide gap, full bleed
//   head: y 1..8 (a solid 7x7 block)
//   tail: sheared bar dropping from the head's bottom-right to y 14
//
// The hollow mark is the identical blade with a 3x3 window punched out of the
// head, leaving 2-unit walls on all four sides. At 16px that is a 3px void
// inside 2px walls — the largest crisp counter this canvas can hold.

const HEAD_TOP = 1;
const HEAD_BOTTOM = 8;
const TAIL_BOTTOM = 14;
const MARK_W = 7;
const TAIL_TOP_LEFT = 3;   // where the tail's left edge meets the head
const TAIL_BOT_RIGHT = 3;  // tail's bottom-right x, relative to the mark
const TAIL_BOT_LEFT = 1;   // tail's bottom-left x, relative to the mark

const SOLID_X = 0;
const HOLLOW_X = 9;

const WINDOW = { x0: 11, y0: 3, x1: 14, y1: 6 };

function blade(L) {
  return [
    [L, HEAD_TOP],
    [L + MARK_W, HEAD_TOP],
    [L + MARK_W, HEAD_BOTTOM],
    [L + TAIL_BOT_RIGHT, TAIL_BOTTOM],
    [L + TAIL_BOT_LEFT, TAIL_BOTTOM],
    [L + TAIL_TOP_LEFT, HEAD_BOTTOM],
    [L, HEAD_BOTTOM]
  ];
}

const MARK_SOLID = blade(SOLID_X);
const MARK_HOLLOW = blade(HOLLOW_X);

function pointInPoly(x, y, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

// Coverage (0 or 1) at a point in 16-unit grid space.
function coverage(gx, gy) {
  if (pointInPoly(gx, gy, MARK_SOLID)) return 1;
  if (!pointInPoly(gx, gy, MARK_HOLLOW)) return 0;
  const inWindow =
    gx >= WINDOW.x0 && gx <= WINDOW.x1 && gy >= WINDOW.y0 && gy <= WINDOW.y1;
  return inWindow ? 0 : 1;
}

/* --------------------------------------------------------------- raster --- */

const SS = 4; // supersampling factor

function draw(size, colour = INK) {
  const W = size * SS;
  const unit = W / 16;
  const out = Buffer.alloc(size * size * 4);

  const mask = new Float64Array(W * W);
  for (let y = 0; y < W; y++) {
    for (let x = 0; x < W; x++) {
      mask[y * W + x] = coverage((x + 0.5) / unit, (y + 0.5) / unit);
    }
  }

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let a = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) a += mask[(y * SS + sy) * W + (x * SS + sx)];
      }
      a /= SS * SS;
      const o = (y * size + x) * 4;
      out[o] = colour[0];
      out[o + 1] = colour[1];
      out[o + 2] = colour[2];
      out[o + 3] = Math.round(a * 255);
    }
  }
  return out;
}

module.exports = { draw, encodePng, coverage, INK };

/* ----------------------------------------------------------------- main --- */

if (require.main === module) {
  const OUT = process.argv[2];
  if (!OUT) {
    console.error('usage: node unquotable.js <output-dir>');
    process.exit(1);
  }
  fs.mkdirSync(OUT, { recursive: true });
  for (const size of [16, 32, 48, 128]) {
    const png = encodePng(size, size, draw(size));
    fs.writeFileSync(path.join(OUT, `icon${size}.png`), png);
    console.log(`icon${size}.png  ${png.length} bytes`);
  }
}
