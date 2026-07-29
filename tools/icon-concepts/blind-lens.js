// AI Crawlability Lens — icon concept: "THE BLIND LENS"
//
// A magnifier whose field of view is partly dead. A thick white lens ring and
// handle sit on the product's indigo->violet tile; a hard-edged wedge is bitten
// straight out of the lens — ring included — and filled with the "missing"
// red. The instrument is looking, but a slice of what it should see isn't there.
//
// Dependency-free PNG encoder (zlib + manual chunk/CRC), 4x supersampled.
// Usage: node blind-lens.js <outputDir>
const fs = require('fs');
const zlib = require('zlib');
const path = require('path');

const OUT = process.argv[2];
if (!OUT) {
  console.error('usage: node blind-lens.js <outputDir>');
  process.exit(1);
}

/* ------------------------------------------------------------------ PNG --- */

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) crc = CRC_TABLE[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
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
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/* --------------------------------------------------------------- palette -- */

const INDIGO = [37, 99, 235];   // #2563eb
const VIOLET = [124, 58, 237];  // #7c3aed
const RED    = [239, 68, 68];   // #ef4444
const WHITE  = [255, 255, 255];

// The glass is the tile gradient pushed deep, so the lens disc has mass.
const GLASS_DARKEN = 0.42;

/* --------------------------------------------------------------- drawing -- */

const SS = 4; // supersample factor

// The blind region is a half-plane clipped to the glass: a hard straight cut
// across the field of view, with everything beyond it dead. A straight chord
// (rather than a pie wedge from the centre) keeps this from reading as a chart
// slice, and holds a solid, contiguous mass of red down at 16px.
//
// BLIND_NORMAL points from the live side toward the dead side, in screen space
// (atan2(dy, dx), y growing downward). ~209deg tilts the cut off vertical so it
// reads as a deliberate edge rather than a half-full meter.
const BLIND_NORMAL = 209 * (Math.PI / 180);
// Offset of the cut from the lens centre, as a fraction of the glass radius.
// Tuned so the dead side and the surviving glass both keep real mass at 16px.
const BLIND_OFFSET = 0.10;

function draw(size) {
  const W = size * SS;
  const px = new Float64Array(W * W * 4); // straight RGBA, alpha 0..1

  // --- geometry, all relative to the supersampled tile -----------------
  const pad = W * 0.025;
  const tileR = W * 0.225; // tile corner radius

  const cx = W * 0.440;
  const cy = W * 0.415;
  const ringOuter = W * 0.355;
  const ringInner = W * 0.252; // => ring stroke 0.103W (1.65px @16)

  // Handle: a fat white bar running down-right out of the lens.
  const dir = Math.PI / 4; // 45deg, down-right
  const hx1 = cx + Math.cos(dir) * (ringInner + (ringOuter - ringInner) * 0.4);
  const hy1 = cy + Math.sin(dir) * (ringInner + (ringOuter - ringInner) * 0.4);
  // Stop short of the tile's rounded corner so the round cap reads as a
  // deliberate terminal rather than a clipped edge.
  const hx2 = cx + Math.cos(dir) * (W * 0.575);
  const hy2 = cy + Math.sin(dir) * (W * 0.575);
  const halfHandle = W * 0.078; // => 0.156W wide (2.5px @16)

  function tileAlpha(x, y) {
    const x0 = pad, y0 = pad, x1 = W - pad, y1 = W - pad;
    if (x < x0 || x > x1 || y < y0 || y > y1) return 0;
    const dx = Math.max(x0 + tileR - x, 0, x - (x1 - tileR));
    const dy = Math.max(y0 + tileR - y, 0, y - (y1 - tileR));
    return dx * dx + dy * dy <= tileR * tileR ? 1 : 0;
  }

  function distToSegment(pxx, pyy, x1, y1, x2, y2) {
    const vx = x2 - x1, vy = y2 - y1;
    const wx = pxx - x1, wy = pyy - y1;
    const t = Math.max(0, Math.min(1, (wx * vx + wy * vy) / (vx * vx + vy * vy)));
    return Math.hypot(pxx - (x1 + t * vx), pyy - (y1 + t * vy));
  }

  for (let y = 0; y < W; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      const sx = x + 0.5, sy = y + 0.5;

      const a = tileAlpha(sx, sy);
      if (a === 0) continue;

      // Base: indigo -> violet on the diagonal.
      const t = Math.min(1, Math.max(0, (sx + sy) / (2 * W)));
      let R = INDIGO[0] + (VIOLET[0] - INDIGO[0]) * t;
      let G = INDIGO[1] + (VIOLET[1] - INDIGO[1]) * t;
      let B = INDIGO[2] + (VIOLET[2] - INDIGO[2]) * t;

      const d = Math.hypot(sx - cx, sy - cy);
      // Signed distance across the cut; positive is the dead side.
      const cut = (sx - cx) * Math.cos(BLIND_NORMAL)
                + (sy - cy) * Math.sin(BLIND_NORMAL);
      const isBlind = cut >= ringInner * BLIND_OFFSET;

      const onHandle = distToSegment(sx, sy, hx1, hy1, hx2, hy2) <= halfHandle;

      // Glass: a deep, darkened version of the tile so the lens disc reads as
      // a solid mass at 16px rather than relying on the ring outline alone.
      if (d < ringInner) {
        R *= GLASS_DARKEN; G *= GLASS_DARKEN; B *= GLASS_DARKEN;
      }

      // The blind field: a hard-edged region of dead glass. The bezel stays
      // closed so the circle silhouette survives; what's missing is what the
      // instrument should be seeing.
      if (isBlind && d < ringInner) {
        R = RED[0]; G = RED[1]; B = RED[2];
      }

      // Bezel + handle, drawn last so they stay crisp against both.
      if ((d >= ringInner && d <= ringOuter) || onHandle) {
        R = WHITE[0]; G = WHITE[1]; B = WHITE[2];
      }

      px[i] = R; px[i + 1] = G; px[i + 2] = B; px[i + 3] = a;
    }
  }

  // Box-downsample with alpha weighting.
  const out = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0, aSum = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const i = ((y * SS + sy) * W + (x * SS + sx)) * 4;
          const a = px[i + 3];
          r += px[i] * a; g += px[i + 1] * a; b += px[i + 2] * a; aSum += a;
        }
      }
      const o = (y * size + x) * 4;
      if (aSum === 0) { out[o] = out[o + 1] = out[o + 2] = out[o + 3] = 0; }
      else {
        out[o] = Math.round(r / aSum);
        out[o + 1] = Math.round(g / aSum);
        out[o + 2] = Math.round(b / aSum);
        out[o + 3] = Math.round((aSum / (SS * SS)) * 255);
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
