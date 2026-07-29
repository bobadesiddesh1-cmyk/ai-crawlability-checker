// "THE HALF-BLIND BOT" — app icon concept for AI Crawlability Lens.
//
// A reductive bot head: rounded-square visor form in the product's indigo->violet
// gradient, with two eyes. One eye is lit (white); the other is a dead socket —
// it is looking at your page, but only half-registering it.
//
// Dependency-free PNG encoder (zlib + manual chunks/CRC), 4x supersampled and
// box-downsampled, same approach as tools/make-icons.js.
//
//   node tools/icon-concepts/half-blind-bot.js <outdir> [variant]

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
const RED    = [0xef, 0x44, 0x44]; // #ef4444  "invisible / missing"
const WHITE  = [0xff, 0xff, 0xff];
const SOCKET = [0x0b, 0x10, 0x2b]; // near-black navy: the dead eye

/* --------------------------------------------------------------- shapes --- */

// All shape maths is in normalised 0..1 space so it is resolution independent.

function roundRect(u, v, x0, y0, x1, y1, r) {
  if (u < x0 || u > x1 || v < y0 || v > y1) return false;
  const dx = Math.max(x0 + r - u, 0, u - (x1 - r));
  const dy = Math.max(y0 + r - v, 0, v - (y1 - r));
  return dx * dx + dy * dy <= r * r;
}

/* ------------------------------------------------------------------ art --- */

// Layout constants, shared by every variant so they stay comparable.
const HEAD = { x0: 0.055, y0: 0.075, x1: 0.945, y1: 0.925, r: 0.235 };

const EYE_CY = 0.50;
const EYE_HW = 0.125; // half width
const EYE_HH = 0.145; // half height
const EYE_R  = 0.055;
const EYE_LX = 0.335; // centre of lit eye
const EYE_RX = 0.665; // centre of dead eye

const VISOR = { x0: 0.155, y0: 0.325, x1: 0.845, y1: 0.675, r: 0.115 };

// Rounded rect with independent top and bottom corner radii (helmet shape).
function helmetRect(u, v, x0, y0, x1, y1, rt, rb) {
  if (u < x0 || u > x1 || v < y0 || v > y1) return false;
  const top = v < (y0 + y1) / 2;
  const r = top ? rt : rb;
  const dx = Math.max(x0 + r - u, 0, u - (x1 - r));
  const dy = top ? Math.max(y0 + r - v, 0) : Math.max(v - (y1 - r), 0);
  return dx * dx + dy * dy <= r * r;
}

function shade(u, v, variant) {
  const helmet = 'PQ'.includes(variant);
  const inHead = helmet
    ? helmetRect(u, v, HEAD.x0, HEAD.y0, HEAD.x1, HEAD.y1, 0.30, 0.15)
    : roundRect(u, v, HEAD.x0, HEAD.y0, HEAD.x1, HEAD.y1, HEAD.r);
  if (!inHead) return null;

  // Body: indigo -> violet along the diagonal. Variants K/L run the ramp the
  // other way so the dead (right) eye sits on blue, maximising hue contrast.
  const reversed = variant === 'K' || variant === 'L';
  let t = Math.min(1, Math.max(0, (u + v) / 2));
  if (reversed) t = 1 - t;
  let col = [
    INDIGO[0] + (VIOLET[0] - INDIGO[0]) * t,
    INDIGO[1] + (VIOLET[1] - INDIGO[1]) * t,
    INDIGO[2] + (VIOLET[2] - INDIGO[2]) * t
  ];

  const litEye  = roundRect(u, v, EYE_LX - EYE_HW, EYE_CY - EYE_HH, EYE_LX + EYE_HW, EYE_CY + EYE_HH, EYE_R);
  const deadEye = roundRect(u, v, EYE_RX - EYE_HW, EYE_CY - EYE_HH, EYE_RX + EYE_HW, EYE_CY + EYE_HH, EYE_R);

  switch (variant) {
    // A — two eyes, dead eye is a black socket.
    case 'A':
      if (litEye) col = WHITE;
      else if (deadEye) col = SOCKET;
      break;

    // B — two eyes, dead eye is red.
    case 'B':
      if (litEye) col = WHITE;
      else if (deadEye) col = RED;
      break;

    // C — a single visor slit, left half lit, right half dead.
    case 'C': {
      if (roundRect(u, v, VISOR.x0, VISOR.y0, VISOR.x1, VISOR.y1, VISOR.r)) {
        col = u < 0.5 ? WHITE : SOCKET;
      }
      break;
    }

    // D — dark visor band holding a white eye and a red eye.
    case 'D': {
      if (roundRect(u, v, VISOR.x0, VISOR.y0, VISOR.x1, VISOR.y1, VISOR.r)) col = SOCKET;
      if (litEye) col = WHITE;
      else if (deadEye) col = RED;
      break;
    }

    // E — dead socket with a red core: dark ring reads at 16px, red reads above.
    case 'E':
      if (litEye) col = WHITE;
      else if (deadEye) {
        const inner = roundRect(
          u, v,
          EYE_RX - EYE_HW * 0.52, EYE_CY - EYE_HH * 0.52,
          EYE_RX + EYE_HW * 0.52, EYE_CY + EYE_HH * 0.52,
          EYE_R * 0.5
        );
        col = inner ? RED : SOCKET;
      }
      break;

    // F — asymmetric eyes: the dead one is a squashed slit, i.e. shut.
    case 'F':
      if (litEye) col = WHITE;
      else if (roundRect(u, v, EYE_RX - EYE_HW, EYE_CY - EYE_HH * 0.34, EYE_RX + EYE_HW, EYE_CY + EYE_HH * 0.34, EYE_R * 0.5)) {
        col = SOCKET;
      }
      break;

    // G — tight goggle bar hugging the eyes, white + red.
    case 'G': {
      if (roundRect(u, v, EYE_LX - EYE_HW - 0.045, EYE_CY - EYE_HH - 0.045, EYE_RX + EYE_HW + 0.045, EYE_CY + EYE_HH + 0.045, 0.085)) col = SOCKET;
      if (litEye) col = WHITE;
      else if (deadEye) col = RED;
      break;
    }

    // H — like B but a deeper red (#dc2626) for more contrast on violet.
    case 'H':
      if (litEye) col = WHITE;
      else if (deadEye) col = [0xdc, 0x26, 0x26];
      break;

    // I — circular eyes instead of rounded squares.
    case 'I': {
      const dl = Math.hypot(u - EYE_LX, v - EYE_CY);
      const dr = Math.hypot(u - EYE_RX, v - EYE_CY);
      if (dl <= 0.135) col = WHITE;
      else if (dr <= 0.135) col = SOCKET;
      break;
    }

    // J — dead eye is a black socket, lit eye white, both inside a black visor.
    case 'J': {
      if (roundRect(u, v, VISOR.x0, VISOR.y0, VISOR.x1, VISOR.y1, VISOR.r)) col = SOCKET;
      if (litEye) col = WHITE;
      break;
    }

    // K — brand #ef4444 dead eye on a reversed (violet->indigo) ramp.
    case 'K':
      if (litEye) col = WHITE;
      else if (deadEye) col = RED;
      break;

    // L — deeper red dead eye on a reversed ramp.
    case 'L':
      if (litEye) col = WHITE;
      else if (deadEye) col = [0xdc, 0x26, 0x26];
      break;

    default:
      throw new Error('unknown variant ' + variant);
  }

  return [col[0], col[1], col[2], 255];
}

const SS = 4;

function draw(size, variant) {
  const W = size * SS;
  const acc = new Float64Array(W * W * 4);
  for (let y = 0; y < W; y++) {
    for (let x = 0; x < W; x++) {
      const px = shade((x + 0.5) / W, (y + 0.5) / W, variant);
      if (!px) continue;
      const i = (y * W + x) * 4;
      acc[i] = px[0]; acc[i + 1] = px[1]; acc[i + 2] = px[2]; acc[i + 3] = px[3];
    }
  }

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
  const variant = process.argv[3] || 'A';
  if (!out) {
    console.error('usage: node half-blind-bot.js <outdir> [variant]');
    process.exit(1);
  }
  fs.mkdirSync(out, { recursive: true });
  for (const size of SIZES) {
    const png = encodePng(size, size, draw(size, variant));
    fs.writeFileSync(path.join(out, `icon${size}.png`), png);
    console.log(`icon${size}.png  ${png.length} bytes  (variant ${variant})`);
  }
}

module.exports = { draw, encodePng, SIZES };

if (require.main === module) main();
