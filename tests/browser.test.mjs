/**
 * Browser acceptance test. Not shipped with the extension.
 *
 *  A. Loads the SHIPPED extension unpacked in real Chromium: service worker
 *     registers, popup loads with zero console errors, no host access is
 *     granted up front, no stale DNR rule at rest.
 *  B. End-to-end against a real HTTP server, using a copy of the extension with
 *     the test origin pre-granted (Chrome's optional-permission bubble cannot be
 *     accepted from automation). Proves the declarativeNetRequest User-Agent
 *     swap actually reaches the server, that fetches are sequential, that
 *     robots.txt verdicts are right, that a 403 to one bot reads as "blocked",
 *     and that per-bot content divergence is flagged as possible cloaking.
 *  C. The content-side engine against a real rendered DOM.
 *  D. The overlay never mutates the page.
 */
import { readFileSync, writeFileSync, mkdtempSync, cpSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BOTS } from '../ai-crawlability-lens/data/bot-user-agents.js';

const { chromium } = await (async () => {
  // Playwright is a dev-only dependency and may be installed globally.
  for (const spec of ['playwright', '/opt/node22/lib/node_modules/playwright/index.mjs']) {
    try { return await import(spec); } catch { /* try the next location */ }
  }
  throw new Error('Playwright not found. Install it with: npm i -g playwright');
})();


const EXT = fileURLToPath(new URL('../ai-crawlability-lens', import.meta.url));
let pass = 0, fail = 0;
const is = (a, e, label) => {
  const A = JSON.stringify(a), E = JSON.stringify(e);
  if (A === E) { pass++; console.log(`  ok   ${label}`); }
  else { fail++; console.log(`  FAIL ${label}\n       expected ${E}\n       actual   ${A}`); }
};
const tmp = (p) => mkdtempSync(join(tmpdir(), p));

/* ========================================================================== */
/* Test server                                                                */
/* ========================================================================== */

const ROBOTS = `# test fixture
User-agent: *
Disallow: /private/

User-agent: GPTBot
Disallow: /

User-agent: Google-Extended
Disallow: /

Sitemap: http://127.0.0.1/sitemap.xml
`;

// Twenty stable blocks, so one UA-echo block differing between bots stays well
// under the 15% cloaking threshold.
const FILLER = Array.from({ length: 20 }, (_, i) =>
  `<p>Stable server-rendered paragraph number ${i} with enough words to be a real block.</p>`
).join('\n');

const CLOAKED_EXTRA = Array.from({ length: 14 }, (_, i) =>
  `<p>Content served only to this particular crawler, variant ${i}, quite different indeed.</p>`
).join('\n');

function pageHtml(ua, cloaked) {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Fixture</title>
<meta name="description" content="Fixture page."></head>
<body>
<nav><p>Navigation boilerplate</p></nav>
<main>
  <h1>Server rendered headline</h1>
  <p>Fetched by user agent: ${ua}</p>
  ${cloaked ? CLOAKED_EXTRA : FILLER}
  <div id="late"></div>
</main>
<footer><p>Footer boilerplate</p></footer>
<script>
  document.getElementById('late').innerHTML =
    '<h2>Client injected heading</h2>' +
    '<p>This paragraph only exists after JavaScript has run on the page.</p>';
</script>
</body></html>`;
}

const seenRequests = [];

const server = createServer((req, res) => {
  const ua = req.headers['user-agent'] || '';
  seenRequests.push({ url: req.url, ua, at: Date.now() });

  if (req.url === '/robots.txt') {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end(ROBOTS);
    return;
  }

  // A server that turns PerplexityBot away specifically.
  if (/PerplexityBot/i.test(ua)) {
    res.writeHead(403, { 'content-type': 'text/html' });
    res.end('<html><body><h1>Forbidden</h1></body></html>');
    return;
  }

  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(pageHtml(ua, /ClaudeBot/i.test(ua)));
});

await new Promise((r) => server.listen(0, '127.0.0.1', r));
const PORT = server.address().port;
const ORIGIN = `http://127.0.0.1:${PORT}`;

/* ========================================================================== */
/* A. The shipped extension                                                   */
/* ========================================================================== */
console.log('\nA. shipped extension loads');

const ctxA = await chromium.launchPersistentContext(tmp('aicl-a-'), {
  channel: 'chromium',
  headless: true,
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`]
});

const workerA = ctxA.serviceWorkers()[0] || (await ctxA.waitForEvent('serviceworker', { timeout: 20000 }));
const extIdA = new URL(workerA.url()).host;
is(extIdA.length, 32, `service worker registered (${extIdA})`);

const popupA = await ctxA.newPage();
const popupErrors = [];
popupA.on('pageerror', (e) => popupErrors.push(String(e)));
popupA.on('console', (m) => { if (m.type() === 'error') popupErrors.push(m.text()); });
await popupA.goto(`chrome-extension://${extIdA}/popup/popup.html`);
await popupA.waitForFunction(() => document.getElementById('historyList').children.length > 0, { timeout: 15000 });

is(popupErrors, [], 'popup loaded with zero console errors (all ES module imports resolved)');
is(await popupA.locator('#checkBtn').isDisabled(), true, 'Check disabled when there is no checkable page');
is((await popupA.locator('#launchHint').textContent()).includes('toolbar icon'), true, 'and the reason is explained to the user');
is(await popupA.locator('.foot strong').textContent(), '100% local.', 'privacy statement in the footer');

const envA = await popupA.evaluate(async () => ({
  name: chrome.runtime.getManifest().name,
  mv: chrome.runtime.getManifest().manifest_version,
  perms: chrome.runtime.getManifest().permissions,
  optionalHosts: chrome.runtime.getManifest().optional_host_permissions,
  staticHosts: chrome.runtime.getManifest().host_permissions || [],
  granted: await chrome.permissions.getAll(),
  hasExample: await chrome.permissions.contains({ origins: ['https://example.com/*'] }),
  dnrRules: (await chrome.declarativeNetRequest.getDynamicRules()).length,
  ping: await chrome.runtime.sendMessage({ type: 'AICL_PING' })
}));

is(envA.name, 'AI Crawlability Lens', 'manifest name');
is(envA.mv, 3, 'Manifest V3');
is(envA.perms.sort(), ['activeTab', 'declarativeNetRequest', 'scripting', 'storage'], 'exactly the declared permissions');
is(envA.optionalHosts, ['<all_urls>'], 'host access is OPTIONAL, not declared up front');
is(envA.staticHosts, [], 'no static host_permissions at all');
is(envA.granted.origins || [], [], 'no origin is granted on a fresh install');
is(envA.hasExample, false, 'no access to an arbitrary site');
is(envA.dnrRules, 0, 'no declarativeNetRequest rule installed at rest');
is(envA.ping && envA.ping.ok, true, 'service worker answers messages');

await ctxA.close();

/* ========================================================================== */
/* B. End to end                                                              */
/* ========================================================================== */
console.log('\nB. end-to-end fetch pipeline');

// Chrome's optional-permission bubble cannot be accepted from automation, so
// this copy pre-grants the test origin. Everything else — background.js, the
// DNR rule swap, the sequential loop, robots parsing — is the shipped code.
const extB = tmp('aicl-ext-');
cpSync(EXT, extB, { recursive: true });
const mB = JSON.parse(readFileSync(join(extB, 'manifest.json'), 'utf8'));
mB.host_permissions = [`${ORIGIN}/*`];
writeFileSync(join(extB, 'manifest.json'), JSON.stringify(mB, null, 2));

const ctxB = await chromium.launchPersistentContext(tmp('aicl-b-'), {
  channel: 'chromium',
  headless: true,
  args: [`--disable-extensions-except=${extB}`, `--load-extension=${extB}`]
});
const workerB = ctxB.serviceWorkers()[0] || (await ctxB.waitForEvent('serviceworker', { timeout: 20000 }));
const extIdB = new URL(workerB.url()).host;

const driver = await ctxB.newPage();
await driver.goto(`chrome-extension://${extIdB}/popup/popup.html`);

seenRequests.length = 0;
const fetched = await driver.evaluate(
  async (url) => chrome.runtime.sendMessage({ type: 'AICL_RUN_FETCHES', url }),
  `${ORIGIN}/`
);

is(fetched.ok, true, `pipeline completed${fetched.ok ? '' : ': ' + fetched.error}`);
const R = fetched.result;

/* --- the User-Agent swap actually reached the server -------------------- */
const uaByBot = {};
for (const bot of R.bots) {
  const body = R.perBot[bot.id].html || '';
  const m = body.match(/Fetched by user agent: ([^<]*)/);
  uaByBot[bot.id] = m ? m[1].trim() : null;
}
// Assert the server received EXACTLY the declared string, rather than a
// hand-copied fragment of it. The first version of this test pinned
// "GPTBot/1.2"; when OpenAI moved to 1.4 the test failed on the fix rather
// than on the bug. Comparing against the source of truth cannot drift.
for (const bot of BOTS) {
  const received = uaByBot[bot.id];
  if (R.perBot[bot.id].status !== 'ok') continue;
  is(received, bot.ua, `${bot.label} received its declared User-Agent verbatim`);
}
is(
  uaByBot.generic && !/bot/i.test(uaByBot.generic),
  true,
  'the Generic baseline carries no crawler token'
);
is(new Set(Object.values(uaByBot).filter(Boolean)).size, 5, 'each successful bot got a distinct User-Agent — no rule-swap race');

/* --- sequential, not parallel ------------------------------------------- */
const pageReqs = seenRequests.filter((r) => r.url === '/');
is(pageReqs.length, 6, 'exactly one page request per bot');
const overlapping = pageReqs.some((r, i) => i > 0 && r.at < pageReqs[i - 1].at);
is(overlapping, false, 'page requests arrived in order — fetches are sequential');

/* --- robots.txt --------------------------------------------------------- */
is(R.robots.state, 'ok', 'robots.txt parsed');
is(R.robots.botVerdicts.gptbot.allowed, false, 'GPTBot is disallowed');
is(R.robots.botVerdicts.gptbot.matchedRule, 'Disallow: /', 'and the blocking rule is reported');
is(R.robots.botVerdicts.googlebot.allowed, true, 'Googlebot is allowed');
is(R.robots.botVerdicts.claudebot.allowed, true, 'ClaudeBot is allowed');
is(R.robots.tokenVerdicts['google-extended'].allowed, false, 'Google-Extended is disallowed — separately from Googlebot');
is(R.robots.tokenVerdicts.ccbot.allowed, true, 'CCBot falls back to the * group');
is(R.robots.blockedBotIds, ['gptbot'], 'exactly one fetched bot is robots-blocked');

/* --- server-level blocking --------------------------------------------- */
is(R.perBot.perplexitybot.status, 'blocked', 'a 403 to PerplexityBot reads as "blocked"');
is(R.perBot.perplexitybot.httpStatus, 403, 'with the HTTP status preserved');
is(R.perBot.googlebot.status, 'ok', 'and other bots are unaffected');

/* --- the rule is torn down after the run -------------------------------- */
is(
  (await driver.evaluate(() => chrome.declarativeNetRequest.getDynamicRules())).length,
  0,
  'the UA rule is removed once the run finishes'
);

/* --- full analysis via the content script ------------------------------- */
const target = await ctxB.newPage();
await target.goto(`${ORIGIN}/`, { waitUntil: 'load' });
const targetId = await driver.evaluate(async (u) => {
  const tabs = await chrome.tabs.query({ url: u + '*' });
  return tabs.length ? tabs[0].id : null;
}, `${ORIGIN}/`);
is(typeof targetId, 'number', 'test page tab located');

const analysis = await driver.evaluate(async ({ tabId, url, files }) => {
  await chrome.scripting.executeScript({ target: { tabId }, files });
  const [fw] = await chrome.scripting.executeScript({
    target: { tabId },
    files: ['content/framework-detect.js'],
    world: 'MAIN'
  });
  const res = await chrome.tabs.sendMessage(tabId, { type: 'AICL_RUN', url });
  return { res, framework: fw && fw.result };
}, {
  tabId: targetId,
  url: `${ORIGIN}/`,
  files: [
    'engine/html-extractor.js', 'engine/diff.js', 'engine/cloaking.js', 'engine/verdict.js',
    'content/capture-blocks.js', 'content/overlay.js', 'content/main.js'
  ]
});

is(analysis.res.ok, true, `content-side analysis completed${analysis.res.ok ? '' : ': ' + analysis.res.error}`);
const A = analysis.res.result;

is(A.rendered.containerSelector, 'main', '<main> selected as the content container');
is(A.rendered.totalBlocks, 24, '24 rendered blocks (h1 + UA line + 20 filler + 2 injected)');
is(A.perBot.gptbot.robotsBlocked, true, 'GPTBot flagged as robots-blocked in the analysis');
is(A.perBot.gptbot.score, null, 'and shows no score, because the score would be meaningless');
is(A.perBot.perplexitybot.scoreMeaningful, false, 'a blocked (403) bot shows no score either');
is(A.perBot.googlebot.scoreMeaningful, true, 'Googlebot has a real score');
// The two JS-injected blocks, plus the "Fetched by user agent:" line — which
// genuinely differs, because the browser rendered the page under its own UA and
// Googlebot's raw fetch echoed Googlebot's. A real per-block UA difference,
// correctly reported.
is(
  A.perBot.googlebot.invisibleBlocks.map((b) => b.tag),
  ['p', 'h2', 'p'],
  'the JS-injected blocks plus the genuinely UA-dependent line are invisible'
);
is(
  A.perBot.googlebot.invisibleBlocks[0].text.startsWith('Fetched by user agent:'),
  true,
  'and the UA-dependent line is the one identified'
);
// visible weight = h1(2) + 20 filler paragraphs(20) = 22 ; total = 22 + UA p(1) + h2(2) + p(1) = 26
is(A.perBot.googlebot.score, Math.round((22 / 26) * 100), 'heading-weighted score matches the documented formula');
is(A.defaultBotId, 'claudebot', 'the overlay opens on the worst-scoring non-JS crawler');

/* --- cloaking ----------------------------------------------------------- */
is(A.cloaking.detected, true, 'ClaudeBot being served different content is flagged');
is(A.cloaking.headline.startsWith('Possible user-agent-based cloaking detected'), true, 'phrased as a possibility, not an accusation');
const claudeCmp = A.cloaking.comparisons.find((c) => c.botId === 'claudebot');
const googleCmp = A.cloaking.comparisons.find((c) => c.botId === 'googlebot');
is(claudeCmp.diverges, true, 'ClaudeBot diverges from the baseline');
is(googleCmp.diverges, false, 'Googlebot does not — the per-bot UA echo line alone stays under the threshold');
is(A.cloaking.skipped.map((s) => s.botId), ['perplexitybot'], 'the 403 bot is skipped from the cloaking comparison, not silently dropped');

is(analysis.framework && analysis.framework.id, 'unknown', 'framework detection ran in the MAIN world and returned a bucket');

/* --- why each bot can or cannot read the page --------------------------- */
const gs = (v, id) => v.gates.find((g) => g.id === id).state;

is(A.perBot.gptbot.verdict.state, 'blocked-robots', 'GPTBot verdict: blocked before it even asks');
is(gs(A.perBot.gptbot.verdict, 'robots'), 'fail', 'the robots gate is the one that failed');
is(gs(A.perBot.gptbot.verdict, 'served'), 'skip', 'and the later gates were never reached');
is(A.perBot.gptbot.verdict.because.includes('Disallow: /'), true, 'quoting the actual blocking rule');

is(A.perBot.perplexitybot.verdict.state, 'blocked-server', 'PerplexityBot verdict: refused by the server');
is(
  A.perBot.perplexitybot.verdict.because.includes('specific to this bot'),
  true,
  'and identified as user-agent-specific, because the baseline got a 200'
);

// The fixture is mostly server-rendered, so the readable bots should say so.
is(A.perBot.generic.verdict.state, 'crawlable', 'the baseline can read the mostly-server-rendered fixture');
is(A.perBot.generic.verdict.severity, 'good', 'reported as good');
is(A.perBot.generic.verdict.fix, null, 'with nothing to fix');
is(gs(A.perBot.generic.verdict, 'js'), 'fail', 'while still recording that it cannot run JavaScript');

is(typeof A.pageVerdict.headline, 'string', 'a page-level verdict is produced');
is(A.pageVerdict.severity, 'critical', 'critical, because two bots cannot reach the page at all');
is(A.pageVerdict.headline.includes('GPTBot'), true, 'naming the bots that cannot reach it');

await ctxB.close();
server.close();

/* ========================================================================== */
/* C + D. Engine and overlay against a real DOM                               */
/* ========================================================================== */
console.log('\nC. engine against a real DOM / D. overlay purity');

const files = [
  'engine/html-extractor.js', 'engine/diff.js', 'engine/cloaking.js', 'engine/verdict.js',
  'content/capture-blocks.js', 'content/overlay.js'
].map((f) => readFileSync(join(EXT, f), 'utf8'));

const plain = await chromium.launch({ channel: 'chromium', headless: true });
const page = await plain.newPage();
const pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(String(e)));

const RENDERED_PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Test page</title></head>
<body>
  <nav><p>Nav boilerplate that must be ignored</p></nav>
  <main>
    <h1>Server rendered headline</h1>
    <p>This paragraph is present in the raw HTML the server returns.</p>
    <ul><li>Server list item one</li><li>Server list item two</li>
        <li><style>.mw-parser-output cite.citation{font-style:inherit}</style>List item with nested TemplateStyles CSS</li></ul>
    <div id="late"></div>
  </main>
  <footer><p>Footer boilerplate that must be ignored</p></footer>
  <script>
    document.getElementById('late').innerHTML =
      '<h2>Client injected heading</h2>' +
      '<p>This paragraph only exists after JavaScript has run on the page.</p>' +
      '<blockquote>An injected pull quote nobody without JS will ever read.</blockquote>';
  </script>
</body></html>`;

await page.setContent(RENDERED_PAGE, { waitUntil: 'load' });
for (const src of files) await page.addScriptTag({ content: src });

const result = await page.evaluate((rawHtml) => {
  const rendered = AICL.capture.captureRendered();
  const raw = AICL.extractor.extractBlocksFromHtml(rawHtml);
  const d = AICL.diff.diffBlocks(rendered.blocks, raw.blocks);
  return {
    renderedTexts: rendered.blocks.map((b) => `${b.tag}:${b.text}`),
    rawCount: raw.blocks.length,
    rawHasInjected: raw.blocks.some((b) => b.text.includes('Client injected')),
    container: rendered.containerSelector,
    score: d.score,
    invisible: d.results.filter((r) => !r.visible).map((r) => `${r.tag}:${r.text}`)
  };
}, RENDERED_PAGE);

is(result.container, 'main', '<main> chosen as the content container');
is(result.renderedTexts.some((t) => /boilerplate/.test(t)), false, 'nav and footer boilerplate excluded');
is(result.renderedTexts.length, 8, 'eight rendered content blocks');

// Found in the field on Wikipedia: TemplateStyles puts a <style> inside a <li>,
// and textContent swallowed the stylesheet as page content. The raw side strips
// <style> before extracting, so the live side must too — otherwise the two
// sides measure different things and the CSS surfaces as "invisible content",
// which is a fabricated finding.
is(
  result.renderedTexts.some((t) => t.includes('mw-parser-output') || t.includes('font-style')),
  false,
  'nested <style> CSS is never captured as content text'
);
is(
  result.renderedTexts.includes('li:List item with nested TemplateStyles CSS'),
  true,
  'but the list item\'s real text still is'
);
is(result.rawHasInjected, false, 'DOMParser did NOT execute the page script — the crawler view is faithful');
is(result.rawCount, 5, 'five blocks in the raw HTML');
is(result.invisible, [
  'h2:Client injected heading',
  'p:This paragraph only exists after JavaScript has run on the page.',
  'blockquote:An injected pull quote nobody without JS will ever read.'
], 'exactly the JS-injected blocks reported invisible');
is(result.score, Math.round((6 / 10) * 100), 'heading-weighted score as documented');

const overlay = await page.evaluate(() => {
  const snap = () => document.body.outerHTML;
  const before = snap();

  const shown = AICL.overlay.show({
    botId: 'gptbot',
    order: ['gptbot', 'googlebot'],
    perBot: {
      gptbot: { label: 'GPTBot', score: 60, band: 'amber', invisibleIndices: [5, 6, 7], visibleIndices: [0, 1, 2, 3, 4], totalBlocks: 8, invisibleHeadings: 1, totalHeadings: 2, status: 'ok', statusLabel: 'OK (200)', robotsBlocked: false },
      googlebot: { label: 'Googlebot', score: 100, band: 'green', invisibleIndices: [], visibleIndices: [0, 1, 2, 3, 4, 5, 6, 7], totalBlocks: 8, invisibleHeadings: 0, totalHeadings: 2, status: 'ok', statusLabel: 'OK (200)', robotsBlocked: false }
    }
  });

  const host = document.getElementById('__aicl-overlay-host__');
  const shadow = host && host.shadowRoot;
  const during = snap();
  const out = {
    shownOk: shown.ok,
    hostOutsideBody: host.parentElement === document.documentElement,
    pageBodyUnchangedWhileShown: before === during,
    invisibleBoxes: shadow.querySelectorAll('.box.invisible').length,
    visibleBoxes: shadow.querySelectorAll('.box.visible').length,
    tabs: shadow.querySelectorAll('.tab').length,
    layerIgnoresPointer: getComputedStyle(shadow.querySelector('.layer')).pointerEvents,
    panelTakesPointer: getComputedStyle(shadow.querySelector('.panel')).pointerEvents
  };
  AICL.overlay.selectBot('googlebot');
  out.afterSwitchInvisible = shadow.querySelectorAll('.box.invisible').length;
  AICL.overlay.hide();
  out.pageRestored = before === snap();
  out.hostGone = document.getElementById('__aicl-overlay-host__') === null;
  return out;
});

is(overlay.shownOk, true, 'overlay shows');
is(overlay.hostOutsideBody, true, 'host attached to <html>, not <body> (survives body replacement)');
is(overlay.pageBodyUnchangedWhileShown, true, 'the page body is untouched while the overlay is shown');
is(overlay.invisibleBoxes, 3, 'three red boxes for the three invisible blocks');
is(overlay.visibleBoxes, 5, 'five green outlines for the visible blocks');
is(overlay.tabs, 2, 'one tab per bot');
is(overlay.layerIgnoresPointer, 'none', 'the highlight layer never intercepts clicks');
is(overlay.panelTakesPointer, 'auto', 'the panel itself is clickable');
is(overlay.afterSwitchInvisible, 0, 'switching bots updates the highlights');
is(overlay.pageRestored, true, 'the page is byte-identical after dismissal');
is(overlay.hostGone, true, 'the host element is removed');
is(pageErrors, [], 'no page errors');

await plain.close();

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
