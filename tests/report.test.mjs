/** Builds the export report from a real analysis result and checks it is a
 *  valid, fully self-contained document. */
import { readFileSync, writeFileSync, mkdtempSync, cpSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildReportHtml } from '../ai-crawlability-lens/shared/report.js';

const { chromium } = await (async () => {
  // Playwright is a dev-only dependency and may be installed globally.
  for (const spec of ['playwright', '/opt/node22/lib/node_modules/playwright/index.mjs']) {
    try { return await import(spec); } catch { /* try the next location */ }
  }
  throw new Error('Playwright not found. Install it with: npm i -g playwright');
})();


const EXT = fileURLToPath(new URL('../ai-crawlability-lens', import.meta.url));
let pass = 0, fail = 0;
const is = (a, e, l) => { const A=JSON.stringify(a), E=JSON.stringify(e);
  if (A===E){pass++;console.log(`  ok   ${l}`);} else {fail++;console.log(`  FAIL ${l}\n       expected ${E}\n       actual   ${A}`);} };
const tmp = (p) => mkdtempSync(join(tmpdir(), p));

const ROBOTS = `User-agent: *\nDisallow: /private/\n\nUser-agent: GPTBot\nDisallow: /\n\nUser-agent: Google-Extended\nDisallow: /\n`;
const FILLER = Array.from({length:12},(_,i)=>`<p>Server paragraph ${i} with a reasonable amount of real words in it.</p>`).join('\n');
const server = createServer((req,res)=>{
  const ua = req.headers['user-agent']||'';
  if (req.url==='/robots.txt'){res.writeHead(200,{'content-type':'text/plain'});res.end(ROBOTS);return;}
  if (/PerplexityBot/i.test(ua)){res.writeHead(403);res.end('<html><body><h1>Forbidden</h1></body></html>');return;}
  res.writeHead(200,{'content-type':'text/html; charset=utf-8'});
  res.end(`<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Fixture page</title>
<meta name="description" content="A fixture."><link rel="canonical" href="http://x/"></head><body><main>
<h1>Server rendered headline</h1>${FILLER}<div id="late"></div></main>
<script>document.getElementById('late').innerHTML='<h2>Injected heading</h2><p>Injected paragraph that no non-JS crawler will ever see.</p>';</script>
</body></html>`);
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const ORIGIN = `http://127.0.0.1:${server.address().port}`;

const ext = tmp('rep-ext-'); cpSync(EXT, ext, {recursive:true});
const m = JSON.parse(readFileSync(join(ext,'manifest.json'),'utf8'));
m.host_permissions = [`${ORIGIN}/*`];
writeFileSync(join(ext,'manifest.json'), JSON.stringify(m,null,2));

const ctx = await chromium.launchPersistentContext(tmp('rep-'), {channel:'chromium',headless:true,
  args:[`--disable-extensions-except=${ext}`,`--load-extension=${ext}`]});
const w = ctx.serviceWorkers()[0] || await ctx.waitForEvent('serviceworker',{timeout:20000});
const id = new URL(w.url()).host;
const target = await ctx.newPage(); await target.goto(`${ORIGIN}/`,{waitUntil:'load'});
const driver = await ctx.newPage(); await driver.goto(`chrome-extension://${id}/popup/popup.html`);

const out = await driver.evaluate(async ({url,files}) => {
  const tabs = await chrome.tabs.query({url: url+'*'});
  const tabId = tabs[0].id;
  await chrome.scripting.executeScript({target:{tabId}, files});
  const [fw] = await chrome.scripting.executeScript({target:{tabId}, files:['content/framework-detect.js'], world:'MAIN'});
  const res = await chrome.tabs.sendMessage(tabId, {type:'AICL_RUN', url});
  return {res, framework: fw && fw.result};
}, {url:`${ORIGIN}/`, files:['engine/html-extractor.js','engine/diff.js','engine/cloaking.js','content/capture-blocks.js','content/overlay.js','content/main.js']});

is(out.res.ok, true, 'analysis produced');
const html = buildReportHtml(out.res.result, out.framework);
const file = join(tmp('rep-out-'), 'report.html');
writeFileSync(file, html);

is(html.startsWith('<!doctype html>'), true, 'report is a complete HTML document');
is(/<script/i.test(html), false, 'report contains no scripts');
is(/(src|href)\s*=\s*["']https?:/i.test(html.replace(/<a href="http[^"]*">/g,'')), false, 'no external stylesheet/image/font references');

const check = await chromium.launch({channel:'chromium',headless:true});
const rp = await check.newPage();
const errs = [], external = [];
rp.on('pageerror', e=>errs.push(String(e)));
rp.on('console', m=>{ if(m.type()==='error') errs.push(m.text()); });
rp.on('request', r => { if (!r.url().startsWith('file://')) external.push(r.url()); });
await rp.goto('file://'+file, {waitUntil:'load'});

is(errs, [], 'report opens with zero errors');
is(external, [], 'report makes zero network requests when opened');
const text = await rp.locator('body').innerText();
for (const needle of ['AI Crawlability report','CRITICAL — blocked in robots.txt','GPTBot',
                      'Google-Extended is not Googlebot','Per-bot results','Content invisible to bots',
                      'Injected paragraph that no non-JS crawler will ever see','Framework and recommendation',
                      'Methodology','Privacy']) {
  is(text.includes(needle), true, `report contains "${needle}"`);
}
is(text.includes('No cloaking detected'), true, 'report states the no-cloaking finding plainly');
is((await rp.locator('table').count()) >= 3, true, 'report has the per-bot, robots and metadata tables');
await rp.screenshot({path: join(tmpdir(),'report.png'), fullPage:true});
console.log('screenshot: '+join(tmpdir(),'report.png'));

await check.close(); await ctx.close(); server.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail?1:0);
