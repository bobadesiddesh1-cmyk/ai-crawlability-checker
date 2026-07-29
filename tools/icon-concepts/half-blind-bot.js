// "THE HALF-BLIND BOT" — app icon concept for AI Crawlability Lens.
//
// A reductive, geometric crawler head: a rounded-square visor form carrying the
// product's indigo -> violet gradient, with two identical eyes. The left eye is
// lit (pure white); the right eye is an extinguished socket. Same shape, same
// size, same position — only the light differs. The bot is looking at your page
// and only half-registering it.
//
// Three shapes total: head, lit eye, dead eye. Nothing else survives 16px.
//
// Colour notes (measured, not guessed):
//   - White lit eye on the gradient body ....... 5.7:1 luminance contrast
//   - Dead socket #2b0510 on the gradient body . 3.2:1
//   - Brand red #ef4444 as a solid dead eye .... 1.5:1  <- rejected
// A solid #ef4444 eye only separates from the indigo/violet body by *hue*, which
// is exactly what antialiasing destroys at 16px (and what colour-blind users
// never had). So the dead eye is instead a near-black **extinguished red**
// (#2b0510): it holds full luminance contrast at 16px, and at 48/128px it reads
// visibly warm — the "invisible content" red, burnt out — rather than as a
// generic black square.
//
// Rejected during the study: a half-filled visor slit (reads as a UI toggle
// switch), a dark visor band holding both eyes (busy at 16px), circular eyes
// (edges go soft at 16px), a red core inside a dark socket (muddies to maroon
// sludge), a shut-eye dash for the dead side (reads sleepy/cute, and the dash is
// a hairline), and a helmet head with squared-off bottom corners (blockier at
// 16px for no gain).
//
// Dependency-free PNG encoder (zlib + manual chunks/CRC), 4x supersampled and
// box-downsampled — same approach as tools/make-icons.js.
//
//   node tools/icon-concepts/half-blind-bot.js <outdir>

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
  ihdr[9] = 6; // colour type RGBA
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

/* -------------------------------------------------------------- palette --- */

const INDIGO = [0x25, 0x63, 0xeb]; // #2563eb
const VIOLET = [0x7c, 0x3a, 0xed]; // #7c3aed
const WHITE  = [0xff, 0xff, 0xff]; // the lit eye
const SOCKET = [0x2b, 0x05, 0x10]; // the dead eye: extinguished #ef4444

/* --------------------------------------------------------------- layout --- */

// Normalised 0..1 space, so the geometry is resolution independent.

const HEAD = { x0: 0.055, y0: 0.075, x1: 0.945, y1: 0.925, r: 0.235 };

const EYE = {
  cy: 0.50,
  hw: 0.135, // half width  -> 4.3px at 16
  hh: 0.165, // half height -> 5.3px at 16
  r: 0.06,
  litX: 0.32,
  deadX: 0.68  // 1.4px gap between the eyes at 16px: still separates cleanly
};

function roundRect(u, v, x0, y0, x1, y1, r) {
  if (u < x0 || u > x1 || v < y0 || v > y1) return false;
  const dx = Math.max(x0 + r - u, 0, u - (x1 - r));
  const dy = Math.max(y0 + r - v, 0, v - (y1 - r));
  return dx * dx + dy * dy <= r * r;
}

function eye(u, v, cx) {
  return roundRect(u, v, cx - EYE.hw, EYE.cy - EYE.hh, cx + EYE.hw, EYE.cy + EYE.hh, EYE.r);
}

/* ------------------------------------------------------------------ art --- */

function shade(u, v) {
  if (!roundRect(u, v, HEAD.x0, HEAD.y0, HEAD.x1, HEAD.y1, HEAD.r)) return null;

  // Body: indigo -> violet along the diagonal. Mid-tone on purpose, so the mark
  // holds its own against both a white and a near-black browser toolbar.
  const t = Math.min(1, Math.max(0, (u + v) / 2));
  let col = [
    INDIGO[0] + (VIOLET[0] - INDIGO[0]) * t,
    INDIGO[1] + (VIOLET[1] - INDIGO[1]) * t,
    INDIGO[2] + (VIOLET[2] - INDIGO[2]) * t
  ];

  if (eye(u, v, EYE.litX)) col = WHITE;
  else if (eye(u, v, EYE.deadX)) col = SOCKET;

  return [col[0], col[1], col[2], 255];
}

const SS = 4; // supersampling factor

function draw(size) {
  const W = size * SS;
  const acc = new Float64Array(W * W * 4);
  for (let y = 0; y < W; y++) {
    for (let x = 0; x < W; x++) {
      const px = shade((x + 0.5) / W, (y + 0.5) / W);
      if (!px) continue;
      const i = (y * W + x) * 4;
      acc[i] = px[0]; acc[i + 1] = px[1]; acc[i + 2] = px[2]; acc[i + 3] = px[3];
    }
  }

  // Box-downsample, compositing in premultiplied alpha so the rounded edge
  // does not pick up a dark fringe.
  const out = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const i = ((y * SS + sy) * W + (x * SS + sx)) * 4;
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

/* ----------------------------------------------------------------- main --- */

const SIZES = [16, 32, 48, 128];

function main() {
  const out = process.argv[2];
  if (!out) {
    console.error('usage: node half-blind-bot.js <outdir>');
    process.exit(1);
  }
  fs.mkdirSync(out, { recursive: true });
  for (const size of SIZES) {
    const png = encodePng(size, size, draw(size));
    fs.writeFileSync(path.join(out, `icon${size}.png`), png);
    console.log(`icon${size}.png  ${png.length} bytes`);
  }
}

module.exports = { draw, encodePng, SIZES };

if (require.main === module) main();
