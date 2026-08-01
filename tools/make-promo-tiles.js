/**
 * tools/make-promo-tiles.js
 *
 * Builds the Chrome Web Store promo tiles.
 *
 *     node tools/make-promo-tiles.js
 *
 * Dev-only, like the other generators: needs Playwright.
 *
 * The Store asks for 440x280 ("small") and 1400x560 ("marquee"), both
 * "JPEG or 24-bit PNG (no alpha)". The no-alpha part is the trap: a PNG written
 * over a transparent ground comes out RGBA and is rejected. Every tile here
 * paints an opaque background first, which makes the encoder emit RGB — the
 * same reason docs/store/*.png already pass.
 *
 * Deliberately typographic rather than a screenshot collage. At 440x280 in a
 * listing grid a screenshot is unreadable mush; a mark and one sentence still
 * carry at that size.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'docs', 'store');

const ICON = 'data:image/png;base64,' +
  fs.readFileSync(path.join(ROOT, 'ai-crawlability-lens', 'icons', 'icon128.png')).toString('base64');

const TILES = [
  {
    name: 'promo-small-440x280.png',
    w: 440,
    h: 280,
    html: `
      <div class="pad">
        <img src="${ICON}" width="52" height="52" alt="">
        <h1>What GPTBot actually sees</h1>
        <p>Your page fetched as each AI crawler — raw, unrendered.</p>
      </div>`
  },
  {
    name: 'promo-marquee-1400x560.png',
    w: 1400,
    h: 560,
    marquee: true,
    html: `
      <div class="pad row">
        <img src="${ICON}" width="150" height="150" alt="">
        <div>
          <h1>Googlebot renders your JavaScript.\nGPTBot doesn’t.</h1>
          <p>See exactly which content never reaches ChatGPT, Perplexity and Claude.</p>
        </div>
      </div>`
  }
];

function page(tile) {
  return `<!doctype html><html><head><meta charset="utf-8"><style>
  *{box-sizing:border-box;margin:0;padding:0}
  /* Opaque ground, not transparent — this is what keeps the PNG 24-bit. */
  html,body{width:${tile.w}px;height:${tile.h}px;overflow:hidden;background:#f6f2ef}
  body{font-family:ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;color:#1a1512;
       display:flex;align-items:center}
  .pad{padding:0 ${tile.marquee ? 88 : 34}px;width:100%}
  .row{display:flex;align-items:center;gap:64px}
  img{display:block;margin-bottom:${tile.marquee ? 0 : 20}px;flex:none}
  h1{font-size:${tile.marquee ? 62 : 27}px;line-height:1.1;letter-spacing:-.03em;font-weight:680;
     margin-bottom:${tile.marquee ? 22 : 10}px;
     /* balance makes pleasing short lines and leaves a third of a 1400px tile
        empty; the marquee wants the width used. */
     text-wrap:${tile.marquee ? 'nowrap' : 'balance'};white-space:pre-line}
  p{font-size:${tile.marquee ? 25 : 14.5}px;line-height:1.45;color:#6b615a}
</style></head><body>${tile.html}</body></html>`;
}

(async () => {
  let chromium;
  for (const spec of ['playwright', '/opt/node22/lib/node_modules/playwright/index.js']) {
    try { ({ chromium } = require(spec)); break; } catch { /* next */ }
  }
  if (!chromium) {
    console.error('Playwright not found. Install it with: npm i -g playwright');
    process.exit(1);
  }

  fs.mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch({ channel: 'chromium', headless: true });

  for (const tile of TILES) {
    const p = await browser.newPage({ viewport: { width: tile.w, height: tile.h }, deviceScaleFactor: 1 });
    await p.setContent(page(tile), { waitUntil: 'load' });
    const file = path.join(OUT, tile.name);
    // omitBackground stays false: a transparent ground would produce RGBA.
    await p.screenshot({ path: file, omitBackground: false });
    await p.close();

    const b = fs.readFileSync(file);
    const colourType = b[25];
    console.log(
      `${path.relative(ROOT, file)}  ${b.readUInt32BE(16)}x${b.readUInt32BE(20)}  ` +
      `${colourType === 2 ? '24-bit RGB, no alpha' : `COLOUR TYPE ${colourType} — the Store will reject this`}`
    );
    if (colourType !== 2) process.exitCode = 1;
  }

  await browser.close();
})();
