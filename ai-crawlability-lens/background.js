/**
 * background.js — MV3 module service worker.
 *
 * The privileged half of the tool. It owns two things and nothing else:
 *
 *   1. The robots.txt fetch and evaluation.
 *   2. The per-bot raw fetches, each performed under a swapped
 *      `declarativeNetRequest` User-Agent rule.
 *
 * It deliberately does NOT parse HTML, diff, or score — MV3 service workers
 * have no `DOMParser`, so all extraction happens in the page context. See
 * DECISIONS.md §4.
 *
 * ---------------------------------------------------------------------------
 * WHY declarativeNetRequest AND NOT fetch HEADERS
 * ---------------------------------------------------------------------------
 * `User-Agent` is a forbidden header name for `fetch()`. Setting it in the
 * `headers` option does not error — the browser silently drops it, which would
 * make every bot row in this tool identical and wrong. DNR `modifyHeaders`
 * operates below that layer and actually works.
 *
 * ---------------------------------------------------------------------------
 * THE SAFETY PROPERTY THAT MATTERS MOST
 * ---------------------------------------------------------------------------
 * Every rule is scoped with `initiatorDomains: [chrome.runtime.id]` and
 * `resourceTypes: ['xmlhttprequest']`. That means the rule can only ever match
 * a request THIS EXTENSION ITSELF made. It cannot touch the user's browsing, a
 * page's own requests, other tabs, or other extensions. We never block,
 * redirect, or upgrade anything — the only action is setting one request header
 * on our own fetches.
 *
 * ---------------------------------------------------------------------------
 * WHY SEQUENTIAL
 * ---------------------------------------------------------------------------
 * There is exactly one rule ID in play. Running bot fetches in parallel would
 * race on the rule swap and attribute a response to the wrong User-Agent —
 * the worst possible failure mode, because the output would still look
 * plausible. The rule is only swapped after the response body has been fully
 * read. A few extra seconds is a cheap price for a result you can trust.
 */

import { BOTS, ROBOTS_ONLY_TOKENS, BASELINE_BOT_ID } from './data/bot-user-agents.js';
import { parseRobotsTxt, evaluateBots, normalizePathForMatching } from './engine/robots-parser.js';

/** The single dynamic rule ID this extension ever uses. */
const DNR_RULE_ID = 1;

/** Hard timeout for every network request this extension makes. */
const FETCH_TIMEOUT_MS = 8000;

/**
 * Response bodies above this are truncated before being handed on.
 * Six multi-megabyte strings crossing a message boundary is a real hang risk,
 * and no page has 3M characters of content worth diffing. Truncation is
 * flagged in the result, never silent.
 */
const MAX_HTML_CHARS = 3000000;

/** HTTP statuses that mean "this bot was actively turned away", not "broken". */
const BLOCKING_STATUSES = new Set([401, 403, 406, 429, 451]);

/* ------------------------------------------------------------------------- */
/* Lifecycle                                                                  */
/* ------------------------------------------------------------------------- */

// A dynamic rule survives a worker restart. If a previous run was interrupted
// mid-check (popup closed, browser quit), a stale UA rule could linger. Clear
// it on every worker start so we never carry state we did not just create.
clearDynamicRule().catch(() => {});

chrome.runtime.onInstalled.addListener(() => {
  clearDynamicRule().catch(() => {});
});

/* ------------------------------------------------------------------------- */
/* Messaging                                                                  */
/* ------------------------------------------------------------------------- */

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || typeof message.type !== 'string') return false;

  if (message.type === 'AICL_RUN_FETCHES') {
    runFetchPipeline(message.url)
      .then((result) => sendResponse({ ok: true, result }))
      .catch((err) => sendResponse({ ok: false, error: describeError(err) }))
      // Whatever happened, never leave a UA rule installed.
      .finally(() => clearDynamicRule().catch(() => {}));
    return true; // async response
  }

  if (message.type === 'AICL_PING') {
    sendResponse({ ok: true, extensionId: chrome.runtime.id });
    return false;
  }

  return false;
});

/* ------------------------------------------------------------------------- */
/* Pipeline                                                                   */
/* ------------------------------------------------------------------------- */

/**
 * Run robots.txt evaluation followed by the sequential per-bot fetches.
 *
 * @param {string} pageUrl
 * @returns {Promise<Object>}
 */
async function runFetchPipeline(pageUrl) {
  const url = new URL(pageUrl);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`Only http(s) pages can be checked (got ${url.protocol}).`);
  }

  const origin = url.origin;

  emitProgress('robots', 'Fetching robots.txt…', 0, BOTS.length + 1);

  // Confirm the per-origin grant is actually in place before doing anything.
  // The popup requests it, but a user can revoke access between the grant and
  // the run, and a silent CORS-style failure here would look like a site issue.
  const hasAccess = await chrome.permissions.contains({ origins: [`${origin}/*`] });
  if (!hasAccess) {
    throw new Error('PERMISSION_MISSING');
  }

  const robots = await checkRobots(origin, url);
  const perBot = {};

  // Strictly one bot at a time. See the header comment.
  let done = 1;
  for (const bot of BOTS) {
    emitProgress('fetch', `Fetching as ${bot.label}…`, done, BOTS.length + 1);
    perBot[bot.id] = await fetchAsBot(bot, url.href, origin);
    done += 1;
  }

  emitProgress('done', 'Comparing against the rendered page…', done, BOTS.length + 1);

  return {
    url: url.href,
    origin,
    path: normalizePathForMatching(url.pathname + url.search),
    checkedAt: new Date().toISOString(),
    robots,
    perBot,
    baselineBotId: BASELINE_BOT_ID,
    bots: BOTS.map((b) => ({
      id: b.id,
      label: b.label,
      executesJs: b.executesJs,
      isBaseline: b.isBaseline,
      note: b.note,
      ua: b.ua
    }))
  };
}

/* ------------------------------------------------------------------------- */
/* robots.txt                                                                 */
/* ------------------------------------------------------------------------- */

/**
 * Fetch and evaluate `<origin>/robots.txt`.
 *
 * Done first because it is one cheap request and it can override everything
 * else: a bot disallowed here never even attempts the page in reality, so its
 * Visibility Score is academic.
 *
 * No UA spoofing is used — robots.txt is served identically regardless, and
 * spoofing would only add a rule swap for no benefit.
 *
 * @param {string} origin
 * @param {URL} url
 */
async function checkRobots(origin, url) {
  const robotsUrl = `${origin}/robots.txt`;
  const path = normalizePathForMatching(url.pathname + url.search);

  let httpStatus = null;
  let body = '';
  let fetchError = null;

  try {
    const res = await timedFetch(robotsUrl, {
      credentials: 'omit',
      cache: 'no-store',
      redirect: 'follow'
    });
    httpStatus = res.status;
    // Read the body even on a non-200: some servers return the file with an
    // odd status, and a 404 body is harmless to parse (it yields no groups).
    body = await res.text();
  } catch (err) {
    fetchError = describeError(err);
  }

  // Standard behaviour: a missing or 4xx robots.txt means everything is
  // allowed. A 5xx is genuinely ambiguous (conservative crawlers treat it as
  // disallow-all) so we report it as unknown rather than guessing.
  const missing = httpStatus !== null && httpStatus >= 400 && httpStatus < 500;
  const serverError = httpStatus !== null && httpStatus >= 500;
  const unreachable = fetchError !== null;

  const usable = httpStatus !== null && httpStatus >= 200 && httpStatus < 300;
  const parsed = parseRobotsTxt(usable ? body : '');

  const botVerdicts = evaluateBots(parsed, BOTS, path);
  const tokenVerdicts = evaluateBots(parsed, ROBOTS_ONLY_TOKENS, path);

  /** @type {string} */
  let state;
  if (unreachable) state = 'unreachable';
  else if (missing) state = 'absent';
  else if (serverError) state = 'unknown';
  else if (usable) state = parsed.empty ? 'empty' : 'ok';
  else state = 'unknown';

  const blockedBots = Object.values(botVerdicts).filter((v) => v && !v.allowed);
  const blockedTokens = Object.values(tokenVerdicts).filter((v) => v && !v.allowed);

  return {
    url: robotsUrl,
    httpStatus,
    state,
    fetchError,
    sitemaps: parsed.sitemaps,
    groupCount: parsed.groups.length,
    // Kept so the report can show exactly what was parsed. Capped: a
    // pathological robots.txt should not blow up the report.
    source: usable ? body.slice(0, 20000) : '',
    truncatedSource: usable && body.length > 20000,
    botVerdicts,
    tokenVerdicts,
    blockedBotIds: blockedBots.map((v) => v.id),
    blockedTokenIds: blockedTokens.map((v) => v.id),
    anyBlocked: blockedBots.length > 0 || blockedTokens.length > 0
  };
}

/* ------------------------------------------------------------------------- */
/* Per-bot fetch                                                              */
/* ------------------------------------------------------------------------- */

/**
 * Install the UA rule for one bot, fetch the page, read the body fully, then
 * tear the rule down.
 *
 * @param {{id: string, label: string, ua: string}} bot
 * @param {string} pageUrl
 * @param {string} origin
 */
async function fetchAsBot(bot, pageUrl, origin) {
  const started = Date.now();

  /** @type {'ok'|'blocked'|'error'} */
  let status = 'error';
  let httpStatus = null;
  let html = '';
  let finalUrl = null;
  let error = null;
  let contentType = null;
  let ruleInstalled = false;
  let truncated = false;
  let fullByteLength = 0;

  try {
    await installUaRule(bot.ua, origin);
    ruleInstalled = true;

    const res = await timedFetch(pageUrl, {
      credentials: 'omit', // fetch as a logged-out crawler; a session cookie
      cache: 'no-store', // would show content no bot could ever see
      redirect: 'follow'
    });

    httpStatus = res.status;
    finalUrl = res.url || pageUrl;
    contentType = res.headers.get('content-type');

    // Read the body to completion BEFORE the rule is swapped. This is the
    // ordering that makes the sequential design actually race-free.
    const fullText = await res.text();
    truncated = fullText.length > MAX_HTML_CHARS;
    html = truncated ? fullText.slice(0, MAX_HTML_CHARS) : fullText;
    fullByteLength = fullText.length;

    if (res.ok) {
      status = 'ok';
    } else if (BLOCKING_STATUSES.has(res.status)) {
      status = 'blocked';
    } else {
      status = 'error';
    }
  } catch (err) {
    error = describeError(err);
    status = 'error';
  } finally {
    if (ruleInstalled) {
      try {
        await clearDynamicRule();
      } catch {
        /* Cleared again in the message handler's finally block. */
      }
    }
  }

  return {
    botId: bot.id,
    label: bot.label,
    ua: bot.ua,
    status,
    httpStatus,
    finalUrl,
    contentType,
    error,
    html,
    byteLength: fullByteLength || html.length,
    truncated,
    // A same-origin redirect keeps the spoofed UA; a cross-origin one does not
    // (the rule is anchored to the original origin). Surfaced rather than hidden.
    redirectedCrossOrigin: finalUrl ? !finalUrl.startsWith(origin) : false,
    elapsedMs: Date.now() - started
  };
}

/* ------------------------------------------------------------------------- */
/* declarativeNetRequest rule management                                      */
/* ------------------------------------------------------------------------- */

/**
 * Install (replacing any previous) the single dynamic header rule.
 *
 * @param {string} userAgent
 * @param {string} origin  e.g. "https://example.com"
 */
async function installUaRule(userAgent, origin) {
  await chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds: [DNR_RULE_ID],
    addRules: [
      {
        id: DNR_RULE_ID,
        priority: 1,
        action: {
          type: 'modifyHeaders',
          requestHeaders: [
            { header: 'User-Agent', operation: 'set', value: userAgent }
          ]
        },
        condition: {
          // `|` anchors at the start of the URL, so this matches every URL on
          // the target origin — which covers same-origin redirects (trailing
          // slash normalisation, locale prefixes) without widening scope to
          // any other site.
          urlFilter: `|${origin.toLowerCase()}/`,
          // THE safety scope: only requests this extension itself initiates.
          initiatorDomains: [chrome.runtime.id],
          resourceTypes: ['xmlhttprequest']
        }
      }
    ]
  });
}

/** Remove the dynamic rule. Safe to call when no rule is installed. */
async function clearDynamicRule() {
  await chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds: [DNR_RULE_ID],
    addRules: []
  });
}

/* ------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* ------------------------------------------------------------------------- */

/**
 * Broadcast a progress update.
 *
 * The popup is the only listener. If it has been closed there is no receiver,
 * which rejects the promise — caught and ignored, because progress reporting
 * must never be able to fail the run it is reporting on.
 *
 * @param {string} stage
 * @param {string} label
 * @param {number} completed
 * @param {number} total
 */
function emitProgress(stage, label, completed, total) {
  try {
    const p = chrome.runtime.sendMessage({
      type: 'AICL_PROGRESS',
      stage,
      label,
      completed,
      total
    });
    if (p && typeof p.catch === 'function') p.catch(() => {});
  } catch {
    /* No receiver. Not a problem. */
  }
}

/**
 * `fetch` with a hard AbortController timeout.
 *
 * @param {string} url
 * @param {RequestInit} init
 * @returns {Promise<Response>}
 */
async function timedFetch(url, init) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Turn an exception into something a user can act on.
 *
 * @param {unknown} err
 * @returns {string}
 */
function describeError(err) {
  if (!err) return 'Unknown error.';
  if (err.name === 'AbortError') {
    return `Timed out after ${FETCH_TIMEOUT_MS / 1000}s.`;
  }
  const msg = err.message || String(err);
  if (msg === 'PERMISSION_MISSING') return msg;
  if (/Failed to fetch/i.test(msg)) {
    return 'Network error — the request did not complete (DNS, TLS, connection refused, or blocked by the server).';
  }
  return msg;
}
