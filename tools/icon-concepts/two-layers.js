// "TWO LAYERS" icon concept for AI Crawlability Lens.
//
// Two rounded-rect planes offset on the diagonal:
//   front (lower-left)  = solid white          -> the page a human sees
//   rear  (upper-right) = hollow, outlined     -> the document a crawler receives
// A knockout gap in the plate colour runs around the front plane so the two
// never merge into one blob at small sizes.
//
// Dependency-free PNG encoder (same approach as tools/make-icons.js).
const fs = require('fs');
const zlib = require('zlib');
const path = require('path');

const OUT = process.argv[2];
const VARIANT = process.argv[3] || 'red'; // 'red' | 'white'

if (!OUT) {
  console.error('usage: node two-layers.js <outdir> [variant]');
  process.exit(1);
}
fs.mkdirSync(OUT, { recursive: true });

/* ---------------------------------------------------------------- PNG ---- */

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
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;

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

/* ------------------------------------------------------------- geometry -- */

const SS = 8; // supersampling factor

// Signed distance to a rounded rectangle. Negative inside.
function sdRoundRect(px, py, cx, cy, hw, hh, r) {
  const dx = Math.abs(px - cx) - (hw - r);
  const dy = Math.abs(py - cy) - (hh - r);
  const outside = Math.hypot(Math.max(dx, 0), Math.max(dy, 0));
  const inside = Math.min(Math.max(dx, dy), 0);
  return outside + inside - r;
}

// All values are fractions of the canvas edge, chosen as sixteenths (or
// thirty-seconds) so that every edge lands on an integer pixel boundary at
// 16, 32, 48 and 128 px. That is what keeps the 16px rendering crisp instead
// of smearing every edge across two half-lit pixels.
const G = {
  platePad: 0.0625,   // 1px at 16
  plateR: 0.21875,

  planeHalf: 0.21875, // planes are 7px at 16 (2..9 front, 7..14 rear)
  planeR: 0.0625,     // 1px at 16, 8px at 128
  offset: 0.15625,    // 2.5px at 16 -> 2px of overlap
  centre: 0.500,

  stroke: 0.09375,    // rear outline: 1.5px at 16
  gap: 0.0625,        // knockout gap around the front plane: 1px at 16
  rearDim: 0.56       // how far the rear plane's hollow interior is darkened
};

const STROKE_COLOUR = VARIANT === 'white' ? [255, 255, 255] : [239, 68, 68];

function draw(size) {
  const W = size * SS;
  const out = Buffer.alloc(size * size * 4);
  const acc = new Float64Array(W * W * 4);

  const plateR = W * G.plateR;
  const pad = W * G.platePad;
  const hw = W * G.planeHalf;
  const pr = W * G.planeR;
  const off = W * G.offset;
  const c = W * G.centre;

  // front plane: pushed down-left. rear plane: pushed up-right.
  const fx = c - off, fy = c + off;
  const rx = c + off, ry = c - off;

  const stroke = W * G.stroke;
  const gap = W * G.gap;

  for (let y = 0; y < W; y++) {
    for (let x = 0; x < W; x++) {
      const px = x + 0.5, py = y + 0.5;

      // Plate.
      const plate = sdRoundRect(px, py, W / 2, W / 2, W / 2 - pad, W / 2 - pad, plateR);
      if (plate > 0) continue;

      // Indigo -> violet diagonal gradient.
      const t = (px + py) / (2 * W);
      let R = 37 + (124 - 37) * t;
      let Gc = 99 + (58 - 99) * t;
      let B = 235 + (237 - 235) * t;

      const rear = sdRoundRect(px, py, rx, ry, hw, hw, pr);
      const front = sdRoundRect(px, py, fx, fy, hw, hw, pr);

      if (rear < 0) {
        if (rear > -stroke) {
          R = STROKE_COLOUR[0]; Gc = STROKE_COLOUR[1]; B = STROKE_COLOUR[2];
        } else {
          // Hollow interior: a recessed, emptier panel.
          R *= G.rearDim; Gc *= G.rearDim; B *= G.rearDim;
        }
      }

      // Knockout gap in the plate colour, so front and rear never touch.
      if (front < gap) {
        R = 37 + (124 - 37) * t;
        Gc = 99 + (58 - 99) * t;
        B = 235 + (237 - 235) * t;
      }

      // Front plane: solid white.
      if (front < 0) { R = 255; Gc = 255; B = 255; }

      const i = (y * W + x) * 4;
      acc[i] = R; acc[i + 1] = Gc; acc[i + 2] = B; acc[i + 3] = 255;
    }
  }

  // Box downsample, alpha-weighted.
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r0 = 0, g0 = 0, b0 = 0, a0 = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const i = ((y * SS + sy) * W + (x * SS + sx)) * 4;
          const a = acc[i + 3];
          r0 += acc[i] * a; g0 += acc[i + 1] * a; b0 += acc[i + 2] * a; a0 += a;
        }
      }
      const o = (y * size + x) * 4;
      if (a0 === 0) { out[o] = 0; out[o + 1] = 0; out[o + 2] = 0; out[o + 3] = 0; }
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
