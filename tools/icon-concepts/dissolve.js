// DISSOLVE — app icon for "AI Crawlability Lens".
//
// WHAT IT DRAWS
// A solid slab of matter occupying the left third of the frame, full bleed on
// three sides, whose right edge is coming apart into discrete square pixels
// that thin out and stop before they reach the far edge. Coherent matter ->
// serrated edge -> scattered squares -> void. The proportion is the message:
// what a crawler actually receives is the solid part, and it is a fraction.
//
// CHASSIS RULES OBEYED
//   - No rounded-square app tile. There is no container at all: the ground is
//     transparent and the mark bleeds off the left, top and bottom edges. The
//     silhouette IS the mark, not a plate with a glyph parked on it.
//   - No indigo -> violet gradient. See COLOUR below.
//   - No magnifier, no document-with-text-lines, no stacked layers, no robot.
//   - No letters. Every re-entrant notch was removed from the mass for exactly
//     this reason: an eroded slab with bites taken out of its right edge reads
//     as a capital E almost immediately. The mass is strictly convex now and
//     all the irregularity lives in the detached fragments.
//
// COLOUR
// One warm ember ramp, cooling as it comes apart: a vermilion mass (#E93E12)
// whose fragments shift to burnt orange (#D26516) the further they get from
// the body — heat leaving matter that has stopped holding together. It is a
// CONSTANT-LUMINANCE ramp: every stop sits within Y = .208-.231, so the whole
// mark carries 3.4:1 or better against both a #f1f3f4 and a #292a2d toolbar
// and the travel the eye reads is pure hue. Nothing cool appears anywhere in
// it, so it cannot collapse into the blue-to-purple default.
//
// OPACITY
// Every surviving cell is 100% opaque. Fading the tail with alpha is the
// obvious move and it is wrong: any alpha low enough to read as "nearly gone"
// on white is invisible on charcoal, and vice versa. The decay is expressed
// purely spatially — fewer squares, not fainter ones.
//
// GEOMETRY
// Everything is aligned to a 16 x 16 cell grid, so at 16px one cell is exactly
// one device pixel and nothing is antialiased. The dissolving unit is a 2 x 2
// cell square (2px at 16px, 16px at 128px) — deliberately chunkier and far
// fewer in number than instinct suggests, because 1px confetti is precisely
// what turns to mud in a toolbar.
//
// Dependency-free PNG writer adapted from tools/make-icons.js.

const fs = require('fs');
const zlib = require('zlib');
const path = require('path');

const OUT = process.argv[2];
if (!OUT) {
  console.error('usage: node dissolve.js <outdir>');
  process.exit(1);
}
fs.mkdirSync(OUT, { recursive: true });

/* ------------------------------------------------------------------ PNG */

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
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;

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

/* ----------------------------------------------------------------- spec */

const GRID = 16;          // cells across the canvas (1 cell = 1px at 16px)
const UNIT = 2;           // cells per dissolving square
const NU = GRID / UNIT;   // 8 x 8 field of dissolving squares

const MASS_UNITS = 3;     // solid slab: unit columns 0..2, i.e. 6 of 16 cells

// Fragments, declared as bands of distance from the erosion front. Band d
// lives in unit column MASS_UNITS + d and lists which of the 8 unit rows keep
// a square. Counts run 5, 3, 2, 2, 1 — monotonically thinning, so the eye
// reads decay as a DIRECTION rather than as noise. 13 squares total; more than
// that and 16px silts up, fewer and the trail stops reading as a trail.
//
// Row choices are hand-placed, not dithered. An ordered dither over a field
// only 8 units wide produces a checkerboard at the 50% band, which reads as
// texture, not disintegration.
const BANDS = [
  [0, 2, 3, 5, 7],  // d0 — still tearing off the edge, serrating it
  [1, 4, 6],        // d1
  [0, 5],           // d2
  [2, 6],           // d3
  [3]               // d4 — one last square, nearly at the far edge
];

// Both endpoints are luminance-solved, not eyeballed. Against #f1f3f4 (Y .893)
// and #292a2d (Y .023) the worst-case contrast is maximised at Y = .2127, and
// both stops are pinned to it. Holding luminance flat and letting only hue
// travel is what makes the ramp behave identically on the two toolbars — a
// brightness ramp always fails on one of them, because "nearly gone" on white
// is invisible on charcoal and vice versa.
//                                    light   dark
const C_MASS = [0xE9, 0x3E, 0x12];  // #E93E12 vermilion     3.65 / 3.53
const C_FAR = [0xD2, 0x65, 0x16];   // #D26516 burnt orange  3.36 / 3.84

/* ---------------------------------------------------------------- build */

// Cell map: 0 = void, 1 = solid mass, 2..n = fragment in band (n-2).
function cellMap() {
  const map = new Uint8Array(GRID * GRID);

  for (let y = 0; y < GRID; y++) {
    for (let x = 0; x < MASS_UNITS * UNIT; x++) map[y * GRID + x] = 1;
  }

  BANDS.forEach((rows, d) => {
    const ux = MASS_UNITS + d;
    if (ux >= NU) throw new Error(`band ${d} falls outside the grid`);
    for (const uy of rows) {
      for (let y = uy * UNIT; y < (uy + 1) * UNIT; y++) {
        for (let x = ux * UNIT; x < (ux + 1) * UNIT; x++) map[y * GRID + x] = 2 + d;
      }
    }
  });

  return map;
}

// Colour is constant across a whole fragment — sampled per band, never per
// cell column. Ramping within a 2px square puts a visible seam down its middle
// at 16px.
function bandColour(d) {
  const t = BANDS.length > 1 ? d / (BANDS.length - 1) : 0;
  return C_MASS.map((v, i) => Math.round(v + (C_FAR[i] - v) * t));
}

function draw(size, mono) {
  const px = Buffer.alloc(size * size * 4); // transparent ground, full bleed
  const map = cellMap();
  const s = size / GRID;                    // whole number for 16/32/48/128

  for (let cy = 0; cy < GRID; cy++) {
    for (let cx = 0; cx < GRID; cx++) {
      const v = map[cy * GRID + cx];
      if (v === 0) continue;
      const [r, g, b] = mono ? [0, 0, 0] : (v === 1 ? C_MASS : bandColour(v - 2));
      for (let y = cy * s; y < (cy + 1) * s; y++) {
        for (let x = cx * s; x < (cx + 1) * s; x++) {
          const i = (y * size + x) * 4;
          px[i] = r; px[i + 1] = g; px[i + 2] = b; px[i + 3] = 255;
        }
      }
    }
  }
  return px;
}

/* --------------------------------------------------------------- output */

for (const size of [16, 32, 48, 128]) {
  const png = encodePng(size, size, draw(size, false));
  fs.writeFileSync(path.join(OUT, `icon${size}.png`), png);
  console.log(`icon${size}.png  ${png.length} bytes`);
}

/**
 * The Chrome Web Store listing icon, which is NOT the same image as the
 * extension icon.
 *
 * A toolbar icon is full bleed — it sits alone at 16px and every pixel counts.
 * The Store's image guidelines ask the opposite: 128x128 canvas with the
 * artwork inside a 96x96 box and 16px of transparent margin, because the
 * listing grid draws icons edge to edge and a full-bleed mark renders visibly
 * larger than its neighbours.
 *
 * Drawn at 96 rather than downscaled from 128: the mark is a 16-cell grid, so
 * 96 gives exactly 6px cells and stays as crisp as the shipped icons. Rescaling
 * 128 -> 96 is a 0.75 factor and would soften every edge.
 *
 * Not written into the icons directory on purpose — it is not part of the
 * extension, and tools/package.js zips that directory wholesale.
 */
const STORE_ICON = process.argv[3];
if (STORE_ICON) {
  const ART = 96;
  const PAD = (128 - ART) / 2;
  const art = draw(ART, false);
  const canvas = Buffer.alloc(128 * 128 * 4); // transparent
  for (let y = 0; y < ART; y++) {
    art.copy(canvas, ((y + PAD) * 128 + PAD) * 4, y * ART * 4, (y + 1) * ART * 4);
  }
  const png = encodePng(128, 128, canvas);
  fs.mkdirSync(path.dirname(STORE_ICON), { recursive: true });
  fs.writeFileSync(STORE_ICON, png);
  console.log(`${path.basename(STORE_ICON)}  ${png.length} bytes  (96px art, ${PAD}px margin)`);
}

// Silhouette proof — the mark in flat black, for the "does it hold in one
// colour" test. Not part of the shipped icon set.
if (process.env.SILHOUETTE) {
  for (const size of [16, 128]) {
    fs.writeFileSync(
      path.join(OUT, `silhouette${size}.png`),
      encodePng(size, size, draw(size, true))
    );
  }
}

// ASCII proof of the 16x16 cell map, for fast iteration.
if (process.env.ASCII) {
  const map = cellMap();
  let s = '';
  for (let y = 0; y < GRID; y++) {
    for (let x = 0; x < GRID; x++) s += map[y * GRID + x] === 0 ? '.' : (map[y * GRID + x] === 1 ? '#' : '+');
    s += '\n';
  }
  process.stdout.write(s);
}
