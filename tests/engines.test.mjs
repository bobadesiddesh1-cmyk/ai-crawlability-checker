// Self-review harness for the pure engines. Not shipped with the extension.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  parseRobotsTxt,
  isPathAllowed,
  evaluateBots,
  normalizePathForMatching,
  compilePathPattern
} from '../ai-crawlability-lens/engine/robots-parser.js';

globalThis.self = globalThis;
const ROOT = fileURLToPath(new URL('../ai-crawlability-lens', import.meta.url));
new Function(readFileSync(`${ROOT}/engine/diff.js`, 'utf8'))();
new Function(readFileSync(`${ROOT}/engine/cloaking.js`, 'utf8'))();
new Function(readFileSync(`${ROOT}/engine/verdict.js`, 'utf8'))();
const { diff, cloaking, verdict } = globalThis.AICL;

let pass = 0, fail = 0;
function is(actual, expected, label) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; console.log(`  ok   ${label}`); }
  else { fail++; console.log(`  FAIL ${label}\n       expected ${e}\n       actual   ${a}`); }
}

/* ------------------------------------------------------------------ robots */
console.log('\nrobots.txt parser');

const R1 = parseRobotsTxt(`
# comment
User-agent: *
Disallow: /private/

User-agent: GPTBot
Disallow: /

User-agent: Googlebot
User-agent: Bingbot
Disallow: /admin
Allow: /admin/public

Sitemap: https://example.com/sitemap.xml
`);

is(R1.groups.length, 3, 'three groups parsed');
is(R1.sitemaps, ['https://example.com/sitemap.xml'], 'sitemap collected');
is(R1.groups[2].agents, ['Googlebot', 'Bingbot'], 'consecutive User-agent lines share a group');

is(isPathAllowed(R1, 'GPTBot', '/blog/post').allowed, false, 'GPTBot Disallow: / blocks everything');
is(isPathAllowed(R1, 'PerplexityBot', '/blog/post').allowed, true, 'PerplexityBot falls back to * and /blog is fine');
is(isPathAllowed(R1, 'PerplexityBot', '/private/x').allowed, false, '* group Disallow: /private/ applies');
is(isPathAllowed(R1, 'Googlebot', '/admin').allowed, false, 'Googlebot blocked by /admin');
is(isPathAllowed(R1, 'Googlebot', '/admin/public/page').allowed, true, 'longer Allow overrides broader Disallow');
is(isPathAllowed(R1, 'Googlebot', '/private/x').allowed, true, 'specific group is NOT merged with the * group');

// Allow beats Disallow on an equal-length tie.
const R2 = parseRobotsTxt('User-agent: *\nDisallow: /a\nAllow: /a\n');
is(isPathAllowed(R2, 'GPTBot', '/a').allowed, true, 'equal-length tie goes to Allow');

// Empty Disallow means allow-all.
const R3 = parseRobotsTxt('User-agent: GPTBot\nDisallow:\n');
is(isPathAllowed(R3, 'GPTBot', '/anything').allowed, true, 'empty Disallow allows everything');

// Wildcards and end-anchors.
const R4 = parseRobotsTxt('User-agent: *\nDisallow: /*.pdf$\nDisallow: /x/*/y\n');
is(isPathAllowed(R4, 'CCBot', '/docs/report.pdf').allowed, false, '*.pdf$ blocks a pdf');
is(isPathAllowed(R4, 'CCBot', '/docs/report.pdf?v=2').allowed, true, '$ anchors the end, so ?v=2 is not blocked');
is(isPathAllowed(R4, 'CCBot', '/x/anything/y').allowed, false, 'mid-pattern wildcard matches');
is(compilePathPattern('/a$b').test('/a$b'), true, 'mid-pattern $ is a literal');

// Longest-prefix group selection.
const R5 = parseRobotsTxt('User-agent: Googlebot\nDisallow: /\n\nUser-agent: Googlebot-News\nDisallow:\n');
is(isPathAllowed(R5, 'Googlebot-News', '/a').allowed, true, 'longest matching product token wins');
is(isPathAllowed(R5, 'Googlebot', '/a').allowed, false, 'plain Googlebot still uses its own group');

// Same-agent groups merge.
const R6 = parseRobotsTxt('User-agent: GPTBot\nDisallow: /a\n\nUser-agent: GPTBot\nDisallow: /b\n');
is(isPathAllowed(R6, 'GPTBot', '/b').allowed, false, 'duplicate groups for one agent are merged');

// No robots.txt at all.
const R7 = parseRobotsTxt('');
is(isPathAllowed(R7, 'GPTBot', '/x').allowed, true, 'empty file allows everything');

// Multi-token bot: strictest verdict wins.
const R8 = parseRobotsTxt('User-agent: anthropic-ai\nDisallow: /\n');
const v8 = evaluateBots(R8, [{ id: 'claudebot', label: 'ClaudeBot', robotsTokens: ['ClaudeBot', 'anthropic-ai'] }], '/x');
is(v8.claudebot.allowed, false, 'ClaudeBot blocked via the anthropic-ai token');
is(v8.claudebot.token, 'anthropic-ai', 'the blocking token is the one reported');

// Comments after a value, and an unknown field mid-header.
const R9 = parseRobotsTxt('User-agent: GPTBot  # the OpenAI crawler\nCrawl-delay: 10\nDisallow: /x # nope\n');
is(isPathAllowed(R9, 'GPTBot', '/x').allowed, false, 'trailing comments and Crawl-delay are handled');

is(normalizePathForMatching('https://a.com/b/c?d=1#frag'), '/b/c?d=1', 'full URL reduced to path+query, fragment dropped');

/* -------------------------------------------------------------------- diff */
console.log('\ndiff engine');

const mk = (tag, text, index) => ({
  tag, text, match: text.toLowerCase(), index, weight: /^h[1-6]$/.test(tag) ? 2 : 1
});

const rendered = [
  mk('h1', 'Server rendered headline', 0),
  mk('p', 'This paragraph is in the raw HTML from the server.', 1),
  mk('h2', 'Client injected heading', 2),
  mk('p', 'This paragraph only appears after hydration runs.', 3)
];
const raw = [
  mk('h1', 'Server rendered headline', 0),
  mk('p', 'This paragraph is in the raw HTML from the server.', 1)
];

const d = diff.diffBlocks(rendered, raw);
is(d.visibleCount, 2, 'two blocks visible');
is(d.invisibleCount, 2, 'two blocks invisible');
is(d.invisibleIndices, [2, 3], 'the client-injected indices are the invisible ones');
// weights: visible = 2 (h1) + 1 (p) = 3; total = 2+1+2+1 = 6 -> 50
is(d.score, 50, 'headings weighted double: 3/6 -> 50');
is(d.invisibleHeadings, 1, 'one invisible heading counted');

// Near-match tolerance: an extra word plus different casing still matches.
const near = diff.diffBlocks(
  [mk('p', 'The quick brown fox jumps over the lazy dog today', 0)],
  [mk('p', 'the quick brown fox jumps over the lazy dog', 0)]
);
is(near.visibleCount, 1, '90% token overlap counts as visible');

// Short blocks require an exact match.
const short = diff.diffBlocks([mk('p', 'Buy now', 0)], [mk('p', 'Buy later', 0)]);
is(short.visibleCount, 0, 'a 2-token block does not near-match');

// Substring inside a larger raw block.
const sub = diff.diffBlocks(
  [mk('p', 'inside a bigger block', 0)],
  [mk('p', 'text before inside a bigger block and after', 0)]
);
is(sub.visibleCount, 1, 'substring of a larger raw block counts as visible');

// A substring must not straddle two unrelated raw blocks.
const straddle = diff.diffBlocks(
  [mk('p', 'alpha beta', 0)],
  [mk('p', 'alpha', 0), mk('p', 'beta', 1)]
);
is(straddle.visibleCount, 0, 'a match cannot straddle two separate raw blocks');

is(diff.diffBlocks([], []).score, null, 'no blocks scores null, not 0');
is([diff.scoreBand(0), diff.scoreBand(39), diff.scoreBand(40), diff.scoreBand(75), diff.scoreBand(76)],
   ['red', 'red', 'amber', 'amber', 'green'], 'score bands: 40 and 75 are both amber');

/* ---------------------------------------------------------------- cloaking */
console.log('\ncloaking engine');

const same = [mk('p', 'one', 0), mk('p', 'two', 1), mk('p', 'three', 2), mk('p', 'four', 3)];
const okRaw = (blocks) => ({ status: 'ok', httpStatus: 200, rawBlocks: blocks });

const cNone = cloaking.detectCloaking(
  { generic: okRaw(same), gptbot: okRaw(same), googlebot: okRaw(same) },
  'generic',
  { generic: 'Generic non-JS bot', gptbot: 'GPTBot', googlebot: 'Googlebot' }
);
is(cNone.detected, false, 'identical raw HTML across bots -> no cloaking');
is(cNone.headline, 'No cloaking detected — all bots receive the same raw HTML.', 'the no-cloaking case is stated plainly');

const differentForGpt = [mk('p', 'one', 0), mk('p', 'nine', 1), mk('p', 'ten', 2), mk('p', 'eleven', 3)];
const cYes = cloaking.detectCloaking(
  { generic: okRaw(same), gptbot: okRaw(differentForGpt) },
  'generic',
  { generic: 'Generic non-JS bot', gptbot: 'GPTBot' }
);
is(cYes.detected, true, 'a materially different body for GPTBot is flagged');
is(cYes.headline.startsWith('Possible user-agent-based cloaking detected'), true, 'flagged neutrally, not as an accusation');

// Reordering is not cloaking.
const reordered = [same[3], same[2], same[1], same[0]];
const cReorder = cloaking.detectCloaking(
  { generic: okRaw(same), gptbot: okRaw(reordered) },
  'generic',
  { generic: 'Generic non-JS bot', gptbot: 'GPTBot' }
);
is(cReorder.detected, false, 'reordered blocks are not reported as cloaking');

// One block different out of four = 2/5 = 40% Jaccard distance -> flagged.
// Verify the threshold boundary with a larger set: 1 of 20 differing.
const big = Array.from({ length: 20 }, (_, i) => mk('p', `block ${i}`, i));
const bigOneOff = big.slice(0, 19).concat([mk('p', 'block different', 19)]);
const cSmall = cloaking.detectCloaking(
  { generic: okRaw(big), gptbot: okRaw(bigOneOff) },
  'generic',
  { generic: 'Generic non-JS bot', gptbot: 'GPTBot' }
);
is(cSmall.detected, false, 'one differing block in twenty (9.5%) stays under the 15% threshold');

// A 403 is a blocking finding, not a cloaking finding.
const cBlocked = cloaking.detectCloaking(
  { generic: okRaw(same), gptbot: { status: 'blocked', httpStatus: 403, rawBlocks: [] } },
  'generic',
  { generic: 'Generic non-JS bot', gptbot: 'GPTBot' }
);
is(cBlocked.detected, false, 'a 403 is excluded from the cloaking comparison');
is(cBlocked.skipped.length, 1, 'the 403 bot is reported as skipped, not silently dropped');

/* ----------------------------------------------------------------- verdict */
console.log('\nverdict engine');

// A bot is a per-bot entry as content/main.js assembles it.
const bot = (over) => Object.assign({
  label: 'ClaudeBot', executesJs: false, isBaseline: false,
  robotsBlocked: false, robotsRule: 'Allow: /', robotsGroup: '*',
  status: 'ok', httpStatus: 200, contentType: 'text/html', error: null,
  score: 90, scoreMeaningful: true,
  totalBlocks: 20, invisibleCount: 2, invisibleHeadings: 0, totalHeadings: 4
}, over);

const gateState = (v, id) => v.gates.find((g) => g.id === id).state;

// Gate 1 wins outright: robots.txt is evaluated before anything else, and
// everything downstream is never reached.
const vRobots = verdict.buildVerdict(bot({
  label: 'GPTBot', robotsBlocked: true, robotsRule: 'Disallow: /', robotsGroup: 'gptbot', score: null
}));
is(vRobots.state, 'blocked-robots', 'a robots.txt disallow is the verdict');
is(vRobots.severity, 'critical', 'and it is critical');
is(vRobots.headline, 'GPTBot is not allowed to crawl this page.', 'headline names the bot and the outcome');
is(vRobots.because.includes('Disallow: /'), true, 'the blocking rule is quoted');
is(gateState(vRobots, 'robots'), 'fail', 'the robots gate fails');
is(['served', 'html', 'source', 'js'].map((g) => gateState(vRobots, g)),
   ['skip', 'skip', 'skip', 'skip'], 'every later gate is skipped — it was never reached');

// A robots block outranks a bad score: the fix is robots.txt, not the frontend.
const vRobotsAndCsr = verdict.buildVerdict(bot({
  label: 'GPTBot', robotsBlocked: true, robotsRule: 'Disallow: /', score: 4, invisibleCount: 19
}));
is(vRobotsAndCsr.state, 'blocked-robots', 'robots.txt outranks a low score');
is(vRobotsAndCsr.fix.includes('Nothing else on this page needs to change'), true,
   'and the fix points at robots.txt, not at rendering');

// Gate 2: refused by the server.
const vBlocked = verdict.buildVerdict(
  bot({ label: 'PerplexityBot', status: 'blocked', httpStatus: 403, score: null }),
  { baselineOk: true, baselineLabel: 'Generic non-JS bot' }
);
is(vBlocked.state, 'blocked-server', 'a 403 is a server-block verdict');
is(vBlocked.because.includes('specific to this bot'), true,
   'a 200 for the baseline makes the refusal user-agent-specific, and it says so');
is(gateState(vBlocked, 'robots'), 'pass', 'robots passed before the server refused');
is(gateState(vBlocked, 'source'), 'skip', 'content gate never reached');
is(vBlocked.fix.includes('firewall'), true, 'the fix points at bot management, not rendering');

// Without a baseline 200 we must not claim the block is UA-specific.
const vBlockedNoBase = verdict.buildVerdict(
  bot({ status: 'blocked', httpStatus: 403, score: null }), { baselineOk: false }
);
is(vBlockedNoBase.because.includes('specific to this bot'), false,
   'no baseline 200 means no claim about it being user-agent-specific');

// Gate 4 for a crawler that cannot recover: the decisive failure.
const vCsr = verdict.buildVerdict(bot({ score: 24, invisibleCount: 13, invisibleHeadings: 3, totalBlocks: 17 }));
is(vCsr.state, 'not-crawlable', 'a non-JS crawler on a client-rendered page cannot read it');
is(vCsr.severity, 'critical', 'which is critical');
is(vCsr.because.includes('Nothing is blocking the request'), true,
   'and it says explicitly that access is not the problem');
is(gateState(vCsr, 'source'), 'fail', 'the content gate is what failed');
is(gateState(vCsr, 'js'), 'fail', 'and no JavaScript execution to recover it');

// Same page, but a crawler that renders: a risk, not a verdict.
const vCsrJs = verdict.buildVerdict(bot({
  label: 'Googlebot', executesJs: true, score: 24, invisibleCount: 13, invisibleHeadings: 3, totalBlocks: 17
}));
is(vCsrJs.state, 'partial', 'the same page is only "partial" for a JS-rendering crawler');
is(vCsrJs.severity, 'warn', 'a warning, not a critical');
is(vCsrJs.because.includes('will probably catch up'), true, 'and it is honest about the uncertainty');
is(gateState(vCsrJs, 'js'), 'pass', 'the JavaScript gate passes for Googlebot');

// A well server-rendered page.
const vGood = verdict.buildVerdict(bot({ score: 96, invisibleCount: 1 }));
is(vGood.state, 'crawlable', 'a server-rendered page is crawlable');
is(vGood.severity, 'good', 'and reads as good');
is(vGood.fix, null, 'with nothing to fix');
is(vGood.because.includes('no JavaScript required'), true, 'and it says why it works, not just that it does');

// Band boundaries.
is([75, 74, 40, 39].map((s) => verdict.buildVerdict(bot({ score: s })).state),
   ['crawlable', 'partial', 'partial', 'not-crawlable'], 'verdict bands line up with the score bands');

// Non-HTML response is a warning, not a failure.
const vXml = verdict.buildVerdict(bot({ contentType: 'application/json' }));
is(gateState(vXml, 'html'), 'warn', 'a non-HTML Content-Type warns');

// Page-level summary picks the most urgent cause.
const withVerdicts = (list) => list.map((b) => {
  const full = bot(b);
  full.verdict = verdict.buildVerdict(full);
  return full;
});

const sBlocked = verdict.summarisePage(withVerdicts([
  { label: 'Googlebot', executesJs: true, score: 90 },
  { label: 'GPTBot', robotsBlocked: true, robotsRule: 'Disallow: /', score: null },
  { label: 'ClaudeBot', score: 90 }
]));
is(sBlocked.severity, 'critical', 'a blocked bot makes the page-level verdict critical');
is(sBlocked.headline.includes('GPTBot'), true, 'and names it');
is(sBlocked.detail.includes('Fix access first'), true, 'ordering the fixes correctly');

const sCsr = verdict.summarisePage(withVerdicts([
  { label: 'Googlebot', executesJs: true, score: 24 },
  { label: 'GPTBot', score: 24 },
  { label: 'ClaudeBot', score: 24 }
]));
is(sCsr.severity, 'critical', 'AI crawlers that cannot read the page is critical');
is(sCsr.headline.includes('cannot read it'), true, 'and the headline says so plainly');

const sFine = verdict.summarisePage(withVerdicts([
  { label: 'Googlebot', executesJs: true, score: 98 },
  { label: 'GPTBot', score: 98 },
  { label: 'ClaudeBot', score: 98 }
]));
is(sFine.severity, 'good', 'a well server-rendered page reads as good');
is(sFine.headline, 'Every AI crawler checked can reach and read this page.', 'stated plainly');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
