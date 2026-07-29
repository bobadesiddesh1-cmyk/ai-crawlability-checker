// AI Crawlability Lens — icon concept: "THE FACADE"
// ---------------------------------------------------------------------------
// A film-set flat / false front: a building front propped up by a single strut,
// with a doorway you can see straight through to the toolbar behind it.
//
// Why this mark: the product's own words are "a page that is a shell". A facade
// IS a shell. It passes as a building from the street (ranks in Google, passes
// every SEO check) and has nothing behind it (no content until JS runs). The
// tool's job is to walk around the back and show you the strut.
//
// Constraints honoured:
//   * Two shapes: the front (with a knockout doorway) + the strut.
//   * All structural edges land on whole 1/16ths, so at 16px they are whole
//     pixels. No half-pixel smear on any load-bearing edge.
//   * Silhouette-first: works as solid black on white (set FLAT=1 to check).
//   * Transparent doorway — the void takes on whatever the toolbar is, so the
//     "nothing behind it" idea is carried by the medium, not by a fill colour.
//
// No dependencies. Node 22.  usage: node wildcard.js <outdir> [previewdir]
const fs = require('fs');
const zlib = require('zlib');
const path = require('path');

const OUT = process.argv[2];
const PREVIEW = process.argv[3] || null;
if (!OUT) { console.error('usage: node wildcard.js <outdir> [previewdir]'); process.exit(1); }
fs.mkdirSync(OUT, { recursive: true });

const FLAT = process.env.FLAT === '1';   // silhouette test: solid black

// ---------------------------------------------------------------------------
// PNG encoding (adapted from tools/make-icons.js)
// ---------------------------------------------------------------------------
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
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const stride = width * 4 + 1;
  const raw = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    raw[y * stride] = 0;
    rgba.copy(raw, y * stride + 1, y * width * 4, (y + 1) * width * 4);
  }
  return Buffer.concat([
    sig, chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

// ---------------------------------------------------------------------------
// Geometry — unit space is a 16 x 16 grid, y down.
// Every structural edge below is a whole number of units.
// ---------------------------------------------------------------------------
const G = {
  // Cornice — the overhanging cap. Architectural cue that says "building
  // front" rather than "board", and it gives the silhouette a T-shouldered
  // top so the wall can never read as a letterform. 1u overhang each side.
  cornX0: 1,   cornX1: 11,   cornY0: 1,   cornY1: 3,
  // The wall of the flat.
  bodyX0: 2,   bodyX1: 10,   bodyY0: 3,   bodyY1: 14,
  // Doorway knockout — ENCLOSED (a solid plinth survives beneath it), so the
  // front stays a mass with a hole in it rather than turning into an arch.
  // Deliberately huge: 4u x 7u out of an 8u x 11u wall. The front is mostly
  // hole. Transparent, so whatever is behind the toolbar shows through it.
  doorX0: 4,   doorX1: 8,    doorSpring: 7,  doorFoot: 12,
  // The kicker: the prop that gives the game away. Held at EXACTLY 45deg so it
  // rasterises to a clean stair at 16px instead of a shallow smear, and so the
  // triangle of daylight between it and the wall stays open and readable.
  kickAx: 10,  kickAy: 9,    kickBx: 13.6, kickBy: 12.6, kickHalf: 1.05,
};

const DOOR_CX = (G.doorX0 + G.doorX1) / 2;      // 6
const DOOR_R  = (G.doorX1 - G.doorX0) / 2;      // 2

// Solid front, before the doorway is punched out.
function inFront(x, y) {
  const inCornice = x >= G.cornX0 && x <= G.cornX1 && y >= G.cornY0 && y <= G.cornY1;
  const inBody    = x >= G.bodyX0 && x <= G.bodyX1 && y >= G.bodyY0 && y <= G.bodyY1;
  return inCornice || inBody;
}

// The void: you can see straight through the front to the toolbar behind it.
function inDoorway(x, y) {
  if (x < G.doorX0 || x > G.doorX1) return false;
  if (y > G.doorFoot) return false;
  if (y >= G.doorSpring) return true;                       // shaft
  const dx = x - DOOR_CX, dy = y - G.doorSpring;            // arch
  return dx * dx + dy * dy <= DOOR_R * DOOR_R;
}

function distToSegment(px, py, x1, y1, x2, y2) {
  const vx = x2 - x1, vy = y2 - y1;
  const wx = px - x1, wy = py - y1;
  const t = Math.max(0, Math.min(1, (wx * vx + wy * vy) / (vx * vx + vy * vy)));
  const dx = px - (x1 + t * vx), dy = py - (y1 + t * vy);
  return Math.hypot(dx, dy);
}

function inKicker(x, y) {
  if (y > G.bodyY1) return false;                           // stands on the
  if (x < G.bodyX1) return false;                           // same ground line
  return distToSegment(x, y, G.kickAx, G.kickAy, G.kickBx, G.kickBy) <= G.kickHalf;
}

// mask: 0 = nothing, 1 = the front, 2 = the kicker
function sample(x, y) {
  if (inFront(x, y) && !inDoorway(x, y)) return 1;
  if (inKicker(x, y)) return 2;
  return 0;
}

// ---------------------------------------------------------------------------
// Colour.
//   One family: a construction / set-build rust. Deliberately not blue.
//   Every tone sits in the luminance window Y in [0.15, 0.26], which clears
//   ~3:1 against BOTH a light (#f1f3f4) and a dark (#292a2d) toolbar. Nothing
//   here relies on hue to be legible.
// ---------------------------------------------------------------------------
const RUST_HI  = [0xDB, 0x6E, 0x3A];   // top of the flat, catching light   Y~.24
const RUST_LO  = [0xB8, 0x4C, 0x22];   // base of the flat                  Y~.16
const STRUT_C  = [0xBC, 0x52, 0x27];   // the prop — deliberately still      Y~.18
                                       // inside the both-toolbars window.

function lerp3(a, b, t) {
  return [
    Math.round(a[0] + (b[0] - a[0]) * t),
    Math.round(a[1] + (b[1] - a[1]) * t),
    Math.round(a[2] + (b[2] - a[2]) * t),
  ];
}

function colourFor(mask, x, y, modulation) {
  if (FLAT) return [0, 0, 0];
  if (mask === 2) return STRUT_C;
  // Gentle top-to-bottom shift on the flat. Scaled down at small sizes so the
  // 16px raster is effectively one flat colour.
  const t = Math.max(0, Math.min(1, (y - G.cornY0) / (G.bodyY1 - G.cornY0)));
  const mid = lerp3(RUST_HI, RUST_LO, 0.5);
  const full = lerp3(RUST_HI, RUST_LO, t);
  return lerp3(mid, full, modulation);
}

// ---------------------------------------------------------------------------
// Raster: supersample, then box-downsample with premultiplied alpha.
// ---------------------------------------------------------------------------
function draw(size) {
  const SS = size <= 32 ? 8 : 4;
  const W = size * SS;
  const scale = 16 / W;                       // pixel -> unit
  const modulation = size >= 48 ? 1 : size >= 32 ? 0.5 : 0.25;

  const hi = Buffer.alloc(W * W * 4);
  for (let y = 0; y < W; y++) {
    for (let x = 0; x < W; x++) {
      const ux = (x + 0.5) * scale, uy = (y + 0.5) * scale;
      const m = sample(ux, uy);
      const i = (y * W + x) * 4;
      if (!m) { hi[i + 3] = 0; continue; }
      const c = colourFor(m, ux, uy, modulation);
      hi[i] = c[0]; hi[i + 1] = c[1]; hi[i + 2] = c[2]; hi[i + 3] = 255;
    }
  }

  const out = Buffer.alloc(size * size * 4);
  const n = SS * SS;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const i = ((y * SS + sy) * W + (x * SS + sx)) * 4;
          const al = hi[i + 3];
          r += hi[i] * al; g += hi[i + 1] * al; b += hi[i + 2] * al; a += al;
        }
      }
      const o = (y * size + x) * 4;
      if (a === 0) { out[o] = out[o + 1] = out[o + 2] = out[o + 3] = 0; }
      else {
        out[o] = Math.round(r / a);
        out[o + 1] = Math.round(g / a);
        out[o + 2] = Math.round(b / a);
        out[o + 3] = Math.round(a / n);
      }
    }
  }
  return out;
}

const rasters = {};
for (const size of [16, 32, 48, 128]) {
  const rgba = draw(size);
  rasters[size] = rgba;
  const png = encodePng(size, size, rgba);
  fs.writeFileSync(path.join(OUT, `icon${size}.png`), png);
  console.log(`icon${size}.png  ${png.length} bytes`);
}

// ---------------------------------------------------------------------------
// Preview sheet: the icon composited on a real light and a real dark toolbar,
// nearest-neighbour magnified so individual pixels are inspectable.
// ---------------------------------------------------------------------------
if (PREVIEW) {
  fs.mkdirSync(PREVIEW, { recursive: true });
  const LIGHT = [0xf1, 0xf3, 0xf4];
  const DARK  = [0x29, 0x2a, 0x2d];

  function sheet(size, zoom) {
    const src = rasters[size];
    const tile = size * zoom;
    const gap = 8;
    const W = tile * 2 + gap * 3;
    const H = tile + gap * 2;
    const buf = Buffer.alloc(W * H * 4);
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const o = (y * W + x) * 4;
        let bg = [0x80, 0x80, 0x80];
        let sx = -1, sy = -1;
        if (y >= gap && y < gap + tile) {
          if (x >= gap && x < gap + tile) { bg = LIGHT; sx = ((x - gap) / zoom) | 0; sy = ((y - gap) / zoom) | 0; }
          else if (x >= gap * 2 + tile && x < gap * 2 + tile * 2) { bg = DARK; sx = ((x - gap * 2 - tile) / zoom) | 0; sy = ((y - gap) / zoom) | 0; }
        }
        let [r, g, b] = bg;
        if (sx >= 0) {
          const i = (sy * size + sx) * 4;
          const a = src[i + 3] / 255;
          r = Math.round(src[i] * a + r * (1 - a));
          g = Math.round(src[i + 1] * a + g * (1 - a));
          b = Math.round(src[i + 2] * a + b * (1 - a));
        }
        buf[o] = r; buf[o + 1] = g; buf[o + 2] = b; buf[o + 3] = 255;
      }
    }
    return { buf, W, H };
  }

  for (const [size, zoom] of [[16, 14], [32, 7], [48, 5], [128, 2]]) {
    const { buf, W, H } = sheet(size, zoom);
    fs.writeFileSync(path.join(PREVIEW, `preview${size}.png`), encodePng(W, H, buf));
  }
  console.log(`previews -> ${PREVIEW}`);
}
