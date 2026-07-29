/**
 * data/bot-user-agents.js
 *
 * The bots we fetch as, and the robots.txt product tokens we evaluate.
 *
 * ES module. Imported by background.js (module service worker), popup/popup.js
 * and shared/report.js.
 *
 * ---------------------------------------------------------------------------
 * WHY THESE SIX
 * ---------------------------------------------------------------------------
 * They cover the meaningfully distinct behaviours, not every crawler name:
 *
 *   Googlebot      — executes JavaScript, on a delayed render budget.
 *   Bingbot        — executes JavaScript, different (smaller) budget.
 *   GPTBot         — raw HTML only. Does not execute JavaScript.
 *   PerplexityBot  — raw HTML only. Does not execute JavaScript.
 *   ClaudeBot      — raw HTML only. Does not execute JavaScript.
 *   Generic        — plain browser UA, no bot token. The control: it represents
 *                    every crawler that does not special-case a known bot name,
 *                    and it is the baseline the cloaking check compares against.
 *
 * Adding more AI crawler names would add table rows without adding information:
 * absent cloaking, every non-JS crawler receives byte-identical HTML, which is
 * exactly what the Generic baseline already measures.
 *
 * ---------------------------------------------------------------------------
 * MAINTENANCE — READ THIS BEFORE TRUSTING A RESULT
 * ---------------------------------------------------------------------------
 * User-Agent strings drift, and a stale one fails SILENTLY. The tool still
 * fetches, diffs, scores and reports with full confidence — it is just
 * answering "what does this string see" rather than "what does GPTBot see".
 *
 * It corrupts exactly the two findings that depend on the server recognising
 * the UA: server-level blocking, and cloaking. A WAF that blocks the real
 * GPTBot may not match a stale string, so the tool reports "GPTBot can read
 * this" when it cannot. The rendering diff is unaffected — absent cloaking,
 * every non-JS fetch receives identical HTML whatever the UA.
 *
 * So each entry carries `source` and `lastVerified`. To re-check, open the
 * source URL and compare the string CHARACTER BY CHARACTER, including
 * parenthesis placement — a 2026-07-29 pass against the live docs found
 * GPTBot pinned at 1.2 when OpenAI had moved to 1.4, and PerplexityBot with
 * its closing parenthesis in the wrong place.
 *
 * STILL UNCONFIRMED: ClaudeBot and Bingbot. Neither vendor page states the
 * string in fetchable HTML, so both are from observed traffic rather than a
 * quotable source. Treat them as the least reliable rows here.
 */

/**
 * @typedef {Object} BotDefinition
 * @property {string}   id            Stable internal key.
 * @property {string}   label         Display name.
 * @property {string}   ua            User-Agent string sent via declarativeNetRequest.
 * @property {string[]} robotsTokens  robots.txt product tokens to evaluate for this bot.
 *                                    More than one means "strictest verdict wins".
 * @property {boolean}  executesJs    Whether this crawler runs JavaScript.
 * @property {boolean}  isBaseline    True for the cloaking-comparison control.
 * @property {string}   note          One-line plain-English explanation for the UI.
 * @property {string}   source        Where the UA string is documented.
 * @property {string}   lastVerified  ISO date the string was last checked.
 */

/** @type {BotDefinition[]} */
export const BOTS = [
  {
    id: 'googlebot',
    label: 'Googlebot',
    ua: 'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; Googlebot/2.1; +http://www.google.com/bot.html) Chrome/131.0.0.0 Safari/537.36',
    robotsTokens: ['Googlebot'],
    executesJs: true,
    isBaseline: false,
    note: 'Renders JavaScript on a delayed budget. A low raw score here is a warning, not a verdict.',
    source: 'https://developers.google.com/search/docs/crawling-indexing/google-common-crawlers',
    lastVerified: '2026-07-29 (checked against the live docs page)'
  },
  {
    id: 'bingbot',
    label: 'Bingbot',
    ua: 'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm) Chrome/116.0.1938.76 Safari/537.36',
    robotsTokens: ['Bingbot'],
    executesJs: true,
    isBaseline: false,
    note: 'Renders JavaScript, but on a tighter budget than Googlebot. Also feeds Copilot.',
    source: 'https://www.bing.com/webmasters/help/which-crawlers-does-bing-use-8c184ec0',
    lastVerified: '2026-07-29'
  },
  {
    id: 'gptbot',
    label: 'GPTBot',
    ua: 'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; GPTBot/1.4; +https://openai.com/gptbot',
    robotsTokens: ['GPTBot'],
    executesJs: false,
    isBaseline: false,
    note: 'OpenAI. Raw HTML only — no JavaScript execution. What you see here is all it ever gets.',
    source: 'https://platform.openai.com/docs/bots',
    lastVerified: '2026-07-29 (checked against the live docs page)'
  },
  {
    id: 'perplexitybot',
    label: 'PerplexityBot',
    ua: 'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; PerplexityBot/1.0; +https://perplexity.ai/perplexitybot)',
    robotsTokens: ['PerplexityBot'],
    executesJs: false,
    isBaseline: false,
    note: 'Perplexity. Raw HTML only — no JavaScript execution.',
    source: 'https://docs.perplexity.ai/guides/bots',
    lastVerified: '2026-07-29 (checked against the live docs page)'
  },
  {
    id: 'claudebot',
    label: 'ClaudeBot',
    ua: 'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; ClaudeBot/1.0; +claudebot@anthropic.com)',
    // Both tokens are in live use for Anthropic's crawlers; the stricter verdict wins.
    robotsTokens: ['ClaudeBot', 'anthropic-ai'],
    executesJs: false,
    isBaseline: false,
    note: 'Anthropic. Raw HTML only — no JavaScript execution.',
    source: 'https://support.anthropic.com/en/articles/8896518-does-anthropic-crawl-data-from-the-web',
    lastVerified: '2026-07-29'
  },
  {
    id: 'generic',
    label: 'Generic non-JS bot',
    // Deliberately a plain browser UA with no bot token: the control case.
    ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    robotsTokens: ['*'],
    executesJs: false,
    isBaseline: true,
    note: 'Baseline control. Any crawler that does not special-case known bot names sees this.',
    source: 'Plain evergreen Chrome UA — intentionally carries no crawler identifier.',
    lastVerified: '2026-07-29'
  }
];

/**
 * robots.txt tokens that are evaluated but never fetched.
 *
 * Google-Extended is NOT a crawler and has no User-Agent string at all — it is a
 * control token that governs whether Google may use already-crawled content for
 * Gemini and Vertex AI grounding. Allowing Googlebot while disallowing
 * Google-Extended is a completely valid configuration and it surprises almost
 * everyone, which is why it gets its own row.
 *
 * CCBot is Common Crawl, which feeds a number of LLM training and retrieval
 * pipelines downstream.
 *
 * @type {{id: string, label: string, robotsTokens: string[], note: string}[]}
 */
export const ROBOTS_ONLY_TOKENS = [
  {
    id: 'google-extended',
    label: 'Google-Extended',
    robotsTokens: ['Google-Extended'],
    note: 'Not a crawler. Controls whether Google may use your content for Gemini / Vertex AI grounding. Separate from Googlebot — allowing one does not allow the other.'
  },
  {
    id: 'ccbot',
    label: 'CCBot (Common Crawl)',
    robotsTokens: ['CCBot'],
    note: 'Common Crawl. Feeds a number of downstream LLM training and retrieval datasets.'
  }
];

/** Convenience lookup: bot id -> definition. */
export const BOT_BY_ID = Object.fromEntries(BOTS.map((b) => [b.id, b]));

/** The cloaking-comparison control. */
export const BASELINE_BOT_ID = 'generic';
