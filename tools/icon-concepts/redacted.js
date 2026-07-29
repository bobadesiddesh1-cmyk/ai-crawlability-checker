// "REDACTED" — app icon for AI Crawlability Lens.
//
// The mark IS the redaction. Three brutally heavy struck-out bars run off the
// left edge in a descending rag, the way blacked-out lines of text do. From the
// last bar a thin tail escapes past the ink to the full measure of the first
// line — the one sliver of content the crawler still gets. A small paper chip
// is punched through the top bar: one fragment that was not covered properly.
//
// No container, no tile, no gradient, no glyph sitting on a plate.
//
// GRID
//   Everything is expressed in 1/16 units and every coordinate is an integer,
//   so at 16x16 each edge falls on a whole pixel (verified: the 16px file
//   contains zero partially-covered pixels).
//
//   col  ..0123456789012345
//   row 0 ................
//   row 1 IIIIIIIIIIIIIII.   bar A  — fully struck, sets the measure
//   row 2 IIIIIIIIIIPPPII.   paper chip: the surviving fragment
//   row 3 IIIIIIIIIIPPPII.
//   row 4 IIIIIIIIIIIIIII.
//   row 5 ................
//   row 6 IIIIIIIIIII.....   bar B  — struck, shorter
//   ...
//   row 11 IIIIII.........   bar C  — struck, shortest
//   row 12 IIIIIIIIIIIIIII.  tail   — thin, escapes past the ink
//   row 13 IIIIIIIIIIIIIII.
//   row 14 IIIIII.........
//   row 15 ................
//
// COLOUR
//   One ink: signal vermilion #E8412F.
//   Redaction wants to be black, but black is unusable here — on Chrome's dark
//   toolbar (#292a2d) near-black sits at ~1.3:1 and the icon disappears. The
//   band of luminance that clears 3:1 against BOTH #f1f3f4 and #292a2d is
//   narrow (relative luminance 0.17–0.28) and only one convincing redaction
//   colour lives in it: the red of a classified stamp. #E8412F measures
//   3.61:1 on the light toolbar and 3.57:1 on the dark one — deliberately
//   balanced rather than optimised for either.
//
//   The paper chip (#FFF7EC) would vanish on a light toolbar if it touched it,
//   so it never does: it is inset with a full unit of ink on all four sides.
//   Its contrast is against the ink (3.75:1), which is the same in both themes.
//
// Usage: node redacted.js <outputDir>
const fs = require('fs');
const zlib = require('zlib');
const path = require('path');

const OUT = process.argv[2];
if (!OUT) {
  console.error('usage: node redacted.js <outputDir>');
  process.exit(1);
}

/* ---------- PNG encoding (no dependencies) ---------- */

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
  ihdr[9] = 6; // colour type: RGBA
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0; // filter: none
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }
  return Buffer.concat([
    sig,
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

/* ---------- the mark ---------- */

const INK = [0xE8, 0x41, 0x2F];   // redaction ink
const PAPER = [0xFF, 0xF7, 0xEC]; // the surviving fragment

// x0 < 0 means the shape bleeds off the left edge of the canvas.
const INK_RECTS = [
  { x0: -1, x1: 15, y0: 1,  y1: 5  }, // bar A — full measure, fully struck
  { x0: -1, x1: 11, y0: 6,  y1: 10 }, // bar B
  { x0: -1, x1: 6,  y0: 11, y1: 15 }, // bar C
  { x0: 6,  x1: 15, y0: 12, y1: 14 }  // the tail that escapes the ink
];

// Inset on all four sides so it is always framed by ink, never by the toolbar.
const PAPER_RECT = { x0: 10, x1: 13, y0: 2, y1: 4 };

const SS = 4; // supersampling factor

function draw(size) {
  const W = size * SS;
  const u = W / 16; // one grid unit, in supersampled pixels
  const acc = new Float64Array(W * W * 4);

  const scale = (r) => ({ x0: r.x0 * u, x1: r.x1 * u, y0: r.y0 * u, y1: r.y1 * u });
  const ink = INK_RECTS.map(scale);
  const paper = scale(PAPER_RECT);
  const hit = (r, x, y) => x >= r.x0 && x < r.x1 && y >= r.y0 && y < r.y1;

  for (let y = 0; y < W; y++) {
    for (let x = 0; x < W; x++) {
      const sx = x + 0.5, sy = y + 0.5;
      let c = null;
      for (const r of ink) if (hit(r, sx, sy)) { c = INK; break; }
      if (hit(paper, sx, sy)) c = PAPER;
      if (!c) continue;
      const i = (y * W + x) * 4;
      acc[i] = c[0]; acc[i + 1] = c[1]; acc[i + 2] = c[2]; acc[i + 3] = 255;
    }
  }

  // Box-downsample, premultiplied so edge pixels do not darken.
  const out = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let dy = 0; dy < SS; dy++) {
        for (let dx = 0; dx < SS; dx++) {
          const i = ((y * SS + dy) * W + (x * SS + dx)) * 4;
          const al = acc[i + 3];
          r += acc[i] * al; g += acc[i + 1] * al; b += acc[i + 2] * al; a += al;
        }
      }
      const o = (y * size + x) * 4;
      if (a === 0) { out[o] = out[o + 1] = out[o + 2] = out[o + 3] = 0; }
      else {
        out[o] = Math.round(r / a);
        out[o + 1] = Math.round(g / a);
        out[o + 2] = Math.round(b / a);
        out[o + 3] = Math.round(a / (SS * SS));
      }
    }
  }
  return out;
}

fs.mkdirSync(OUT, { recursive: true });
for (const size of [16, 32, 48, 128]) {
  const png = encodePng(size, size, draw(size));
  fs.writeFileSync(path.join(OUT, `icon${size}.png`), png);
  console.log(`icon${size}.png  ${png.length} bytes`);
}
