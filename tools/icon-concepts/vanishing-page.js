// Concept: "THE VANISHING PAGE"
// A document whose bottom simply does not exist. Two chunky white content bars
// sit at the top of an indigo->violet page; the page is severed by a hard red
// edge and below it there is nothing at all — the region a JS-blind crawler
// never receives.
//
// Dependency-free PNG encoder (zlib + manual chunks/CRC), 4x supersampled.
// Usage: node vanishing-page.js <outputDir>
const fs = require('fs');
const zlib = require('zlib');
const path = require('path');

const OUT = process.argv[2];
if (!OUT) {
  console.error('usage: node vanishing-page.js <outputDir>');
  process.exit(1);
}
fs.mkdirSync(OUT, { recursive: true });

function crc32(buf) {
  let c;
  const table = [];
  for (let n = 0; n < 256; n++) {
    c = n;
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
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // colour type RGBA
  ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;

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

const SS = 4;

// --- geometry, all in fractions of the canvas -------------------------------
// Every edge is snapped to the 16px pixel grid (n/16) so the smallest icon
// lands on whole pixels instead of blurring across them.
const PAGE_X0 = 3 / 16, PAGE_X1 = 13 / 16;
const PAGE_Y0 = 1 / 16;
const CUT_Y   = 10 / 16;        // where the page stops existing
const TOP_R   = 0.090;          // top corner radius
// The red cut: the last row of the page, flush with its edges. (An overhanging
// line was tried and rejected — it read as a stand/base, i.e. a laptop.)
const BAND = { x0: 3 / 16, x1: 13 / 16, y0: 9 / 16, y1: 10 / 16 };

const BAR_X0  = 4 / 16;
const BAR1    = { y0: 2 / 16, y1: 4 / 16, x1: 12 / 16 };
const BAR2    = { y0: 5 / 16, y1: 7 / 16, x1: 9 / 16 };

function roundedBar(x, y, x0, y0, x1, y1) {
  const r = Math.min((y1 - y0) / 2, (x1 - x0) / 2, 0.02);
  if (x < x0 || x > x1 || y < y0 || y > y1) return false;
  const dx = Math.max(x0 + r - x, 0, x - (x1 - r));
  const dy = Math.max(y0 + r - y, 0, y - (y1 - r));
  return dx * dx + dy * dy <= r * r;
}

function draw(size) {
  const W = size * SS;
  const px = new Float64Array(W * W * 4);

  for (let iy = 0; iy < W; iy++) {
    for (let ix = 0; ix < W; ix++) {
      const x = (ix + 0.5) / W;
      const y = (iy + 0.5) / W;
      const i = (iy * W + ix) * 4;

      // --- red cut line (drawn independently: it overhangs the page)
      if (roundedBar(x, y, BAND.x0, BAND.y0, BAND.x1, BAND.y1)) {
        px[i] = 239; px[i + 1] = 68; px[i + 2] = 68; px[i + 3] = 255;
        continue;
      }

      // --- page silhouette: rounded top corners, hard flat bottom at CUT_Y
      if (x < PAGE_X0 || x > PAGE_X1 || y < PAGE_Y0 || y > CUT_Y) continue;
      const dx = Math.max(PAGE_X0 + TOP_R - x, 0, x - (PAGE_X1 - TOP_R));
      const dy = Math.max(PAGE_Y0 + TOP_R - y, 0);
      if (dx * dx + dy * dy > TOP_R * TOP_R) continue;

      // --- fill: indigo -> violet on the diagonal
      const t = Math.min(1, Math.max(0, (x - PAGE_X0 + y - PAGE_Y0) / 1.05));
      let R = Math.round(37 + (124 - 37) * t);
      let G = Math.round(99 + (58 - 99) * t);
      let B = Math.round(235 + (237 - 235) * t);

      // --- content bars (white), only above the cut
      if (roundedBar(x, y, BAR_X0, BAR1.y0, BAR1.x1, BAR1.y1) ||
          roundedBar(x, y, BAR_X0, BAR2.y0, BAR2.x1, BAR2.y1)) {
        R = 255; G = 255; B = 255;
      }

      px[i] = R; px[i + 1] = G; px[i + 2] = B; px[i + 3] = 255;
    }
  }

  // box downsample, premultiplied
  const out = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r0 = 0, g0 = 0, b0 = 0, a0 = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const i = ((y * SS + sy) * W + (x * SS + sx)) * 4;
          const a = px[i + 3];
          r0 += px[i] * a; g0 += px[i + 1] * a; b0 += px[i + 2] * a; a0 += a;
        }
      }
      const o = (y * size + x) * 4;
      if (a0 === 0) { out[o] = out[o + 1] = out[o + 2] = out[o + 3] = 0; }
      else {
        out[o] = Math.round(r0 / a0);
        out[o + 1] = Math.round(g0 / a0);
        out[o + 2] = Math.round(b0 / a0);
        out[o + 3] = Math.round(a0 / (SS * SS));
      }
    }
  }
  return out;
}

for (const size of [16, 32, 48, 128]) {
  const png = encodePng(size, size, draw(size));
  fs.writeFileSync(path.join(OUT, `icon${size}.png`), png);
  console.log(`icon${size}.png  ${png.length} bytes`);
}
