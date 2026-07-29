// Generates the extension icons as real PNGs — no build step in the extension
// itself, this is a one-off asset generator.
const fs = require('fs');
const zlib = require('zlib');
const path = require('path');

const OUT = process.argv[2];

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

// Supersampled drawing for clean edges at every size.
const SS = 4;

function draw(size) {
  const W = size * SS;
  const acc = new Float64Array(W * W * 4);

  const r = W * 0.22;           // corner radius
  const cx = W * 0.44, cy = W * 0.44;
  const lensOuter = W * 0.26;   // lens ring outer radius
  const lensInner = W * 0.175;  // lens ring inner radius

  // handle: from lens edge toward bottom-right
  const hx1 = cx + lensOuter * 0.72, hy1 = cy + lensOuter * 0.72;
  const hx2 = W * 0.80, hy2 = W * 0.80;
  const hw = W * 0.075;

  function insideRounded(x, y) {
    const pad = W * 0.045;
    const x0 = pad, y0 = pad, x1 = W - pad, y1 = W - pad;
    if (x < x0 || x > x1 || y < y0 || y > y1) return false;
    const dx = Math.max(x0 + r - x, 0, x - (x1 - r));
    const dy = Math.max(y0 + r - y, 0, y - (y1 - r));
    return dx * dx + dy * dy <= r * r;
  }

  function distToSegment(px, py, x1, y1, x2, y2) {
    const vx = x2 - x1, vy = y2 - y1;
    const wx = px - x1, wy = py - y1;
    const t = Math.max(0, Math.min(1, (wx * vx + wy * vy) / (vx * vx + vy * vy)));
    const dx = px - (x1 + t * vx), dy = py - (y1 + t * vy);
    return Math.hypot(dx, dy);
  }

  for (let y = 0; y < W; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      if (!insideRounded(x + 0.5, y + 0.5)) continue;

      // Background: blue -> violet diagonal gradient.
      const t = (x + y) / (2 * W);
      let R = Math.round(37 + (124 - 37) * t);
      let G = Math.round(99 + (58 - 99) * t);
      let B = Math.round(235 + (237 - 235) * t);
      let A = 255;

      const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy);

      // Lens glass (translucent white fill).
      if (d < lensInner) {
        R = Math.round(R + (255 - R) * 0.30);
        G = Math.round(G + (255 - G) * 0.30);
        B = Math.round(B + (255 - B) * 0.30);
      }
      // Lens ring (solid white).
      if (d >= lensInner && d <= lensOuter) {
        R = 255; G = 255; B = 255;
      }
      // Handle (solid white).
      if (distToSegment(x + 0.5, y + 0.5, hx1, hy1, hx2, hy2) <= hw / 2) {
        R = 255; G = 255; B = 255;
      }
      // The point of the product: part of the view is missing to a bot.
      // A red wedge across the lower-left of the lens glass.
      if (d < lensInner && (x + 0.5 - cx) - (y + 0.5 - cy) < -lensInner * 0.15) {
        R = 239; G = 68; B = 68;
      }

      acc[i] = R; acc[i + 1] = G; acc[i + 2] = B; acc[i + 3] = A;
    }
  }

  // Box-downsample the supersampled buffer.
  const out = Buffer.alloc(size * size * 4);
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
