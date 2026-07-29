/**
 * tools/make-store-shots.js
 *
 * Builds the Chrome Web Store screenshots at the required 1280x800.
 *
 *     node tools/make-store-shots.js
 *
 * Dev-only, like the test suites: needs Playwright (`npm i -g playwright`).
 *
 * The Store demands 1280x800 or 640x400. The real popup is 420px wide and the
 * report is several thousand pixels tall, so neither fits the frame on its own.
 * These compose the ACTUAL captured UI — the same PNGs in docs/screenshots,
 * produced by driving the real extension — onto a 1280x800 canvas with one line
 * of context each. Nothing is mocked up or redrawn; the only addition is the
 * background and the caption.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SHOTS = path.join(ROOT, 'docs', 'screenshots');
const OUT = path.join(ROOT, 'docs', 'store');

const PANELS = [
  {
    file: 'popup-results.png',
    kicker: 'The verdict, and why',
    title: 'GPTBot, PerplexityBot and ClaudeBot don’t run your JavaScript',
    body: 'Every crawler gets a plain-English verdict and the gate chain behind it — blocked in robots.txt, refused by your server, or simply not in the HTML.',
    fit: 'tall'
  },
  {
    file: 'overlay.png',
    kicker: 'On the page itself',
    title: 'See exactly which blocks never reach a crawler',
    body: 'Red is missing from the raw HTML. Green made it. Switch crawlers and the map redraws — drawn over the page, never modifying it.',
    fit: 'wide'
  },
  {
    file: 'report.png',
    kicker: 'Hand it to a developer',
    title: 'A self-contained HTML report',
    body: 'One file, no external references, zero network requests when opened. Per-bot diagnosis, robots.txt findings and the exact content that is invisible.',
    fit: 'tall'
  }
];

const dataUri = (f) => 'data:image/png;base64,' + fs.readFileSync(path.join(SHOTS, f)).toString('base64');

function html(panel) {
  return `<!doctype html><html><head><meta charset="utf-8"><style>
  *{box-sizing:border-box;margin:0;padding:0}
  html,body{width:1280px;height:800px;overflow:hidden}
  body{background:#f6f2ef;font-family:ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;
       color:#1a1512;display:flex;align-items:center;gap:56px;padding:0 64px}
  .copy{width:430px;flex:none}
  .kicker{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;letter-spacing:.14em;
          text-transform:uppercase;color:#d3390f;margin-bottom:16px}
  h1{font-size:38px;line-height:1.14;letter-spacing:-.028em;font-weight:680;margin-bottom:18px;text-wrap:balance}
  p{font-size:17px;line-height:1.55;color:#6b615a}
  .shot{flex:1;height:800px;display:flex;align-items:center;justify-content:center;position:relative}
  .frame{border:1px solid #e0d8d1;border-radius:14px;box-shadow:0 24px 60px -24px rgba(26,21,18,.34);
         overflow:hidden;background:#fff}
  .tall img{display:block;width:404px;object-fit:cover;object-position:top}
  .tall{height:720px}
  .wide img{display:block;width:660px}
  .wide{max-height:560px}
</style></head><body>
  <div class="copy">
    <div class="kicker">${panel.kicker}</div>
    <h1>${panel.title}</h1>
    <p>${panel.body}</p>
  </div>
  <div class="shot">
    <div class="frame ${panel.fit}"><img src="${dataUri(panel.file)}" alt=""></div>
  </div>
</body></html>`;
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

  for (const [i, panel] of PANELS.entries()) {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });
    await page.setContent(html(panel), { waitUntil: 'load' });
    const file = path.join(OUT, `store-${i + 1}-${panel.file}`);
    await page.screenshot({ path: file });
    await page.close();
    console.log(`${path.relative(ROOT, file)}  1280x800`);
  }

  await browser.close();
})();
