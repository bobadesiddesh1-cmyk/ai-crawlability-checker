/**
 * engine/verdict.js
 *
 * Turns per-bot measurements into a plain-English answer to the only question
 * the user actually has: **why can this crawler read my page — or why can't it?**
 *
 * Classic script, attaches to `self.AICL.verdict`. Pure: plain data in, plain
 * data out, no DOM, no network.
 *
 * ---------------------------------------------------------------------------
 * WHY A GATE CHAIN AND NOT A SCORE
 * ---------------------------------------------------------------------------
 * Crawlability is not one number, it is a sequence of gates a request has to
 * pass, and only the FIRST failure is the cause. A page can be blocked in
 * robots.txt and also be 100% client-rendered — reporting both as equal
 * findings sends someone to rewrite their frontend when the real fix is one
 * line of robots.txt.
 *
 * So the gates are evaluated in the order a real request meets them:
 *
 *   1. ALLOWED    — does robots.txt permit this bot to request the URL at all?
 *   2. SERVED     — did the server actually hand it a response?
 *   3. HTML       — was that response HTML?
 *   4. IN SOURCE  — is the content there without running JavaScript?
 *   5. RENDERS JS — if not, does this bot run JavaScript to recover it?
 *
 * The first gate that fails is the cause; everything after it is `skip`,
 * because it was never reached. Gate 5 is a modifier rather than a blocker: it
 * is what separates "Googlebot will probably catch up later" from "GPTBot never
 * will".
 */

(function () {
  'use strict';

  const AICL = (self.AICL = self.AICL || {});

  /** Score at or above which the raw HTML is considered substantially complete. */
  const GOOD_SCORE = 75;

  /** Score below which the raw HTML is considered substantially missing. */
  const POOR_SCORE = 40;

  /**
   * @typedef {Object} Gate
   * @property {string} id
   * @property {string} label     Short name for the gate.
   * @property {'pass'|'fail'|'warn'|'skip'} state
   * @property {string} detail    One sentence explaining this gate's outcome.
   */

  /**
   * @typedef {Object} Verdict
   * @property {'crawlable'|'partial'|'not-crawlable'|'blocked-robots'|'blocked-server'|'error'} state
   * @property {'good'|'warn'|'critical'} severity
   * @property {string} summary    Two or three words for a pill: "Fully readable".
   * @property {string} headline   One sentence: the answer.
   * @property {string} because    The decisive reason, in plain English.
   * @property {string|null} fix   What to do about it, or null when nothing is wrong.
   * @property {Gate[]} gates
   */

  /**
   * @param {Object} bot        A per-bot entry from content/main.js.
   * @param {Object} [context]  { baselineOk: boolean, baselineLabel: string }
   * @returns {Verdict}
   */
  function buildVerdict(bot, context) {
    const ctx = context || {};
    const label = bot.label;
    const pct = typeof bot.score === 'number' ? bot.score : null;

    /* --- Gate 1: does robots.txt let it ask? ------------------------------ */
    if (bot.robotsBlocked) {
      return {
        state: 'blocked-robots',
        severity: 'critical',
        summary: 'Blocked before it asks',
        headline: `${label} is not allowed to crawl this page.`,
        because:
          `robots.txt blocks it with ` +
          (bot.robotsRule ? `"${bot.robotsRule}"` : 'a disallow rule') +
          (bot.robotsGroup ? ` in the "${bot.robotsGroup}" group` : '') +
          '. It never sends a request, so how the page renders is irrelevant for this bot.',
        fix:
          `If you want ${label} to be able to cite this page, remove or narrow that rule. ` +
          'Nothing else on this page needs to change for it.',
        gates: [
          gate('robots', 'Allowed by robots.txt', 'fail',
            bot.robotsRule ? `Disallowed by "${bot.robotsRule}".` : 'Disallowed.'),
          gate('served', 'Server responds', 'skip', 'Never reached — the bot does not send the request.'),
          gate('html', 'Response is HTML', 'skip', 'Never reached.'),
          gate('source', 'Content present without JavaScript', 'skip', 'Never reached.'),
          gate('js', 'Runs JavaScript', 'skip', 'Not relevant while the bot is disallowed.')
        ]
      };
    }

    const robotsGate = gate('robots', 'Allowed by robots.txt', 'pass',
      bot.robotsRule
        ? `Permitted by "${bot.robotsRule}"${bot.robotsGroup ? ` in the "${bot.robotsGroup}" group` : ''}.`
        : 'No rule in robots.txt restricts this bot.');

    /* --- Gate 2: did the server actually answer? -------------------------- */
    if (bot.status === 'blocked') {
      const uaSpecific = ctx.baselineOk
        ? ` A plain browser User-Agent got a normal response from the same URL, so the refusal is specific to this bot's User-Agent.`
        : '';
      return {
        state: 'blocked-server',
        severity: 'critical',
        summary: 'Turned away by the server',
        headline: `${label} is being turned away by your server.`,
        because:
          `The server answered HTTP ${bot.httpStatus} to this bot's User-Agent, so it received no content at all.` +
          uaSpecific,
        fix:
          'This is a firewall, CDN or WAF rule, not a rendering problem. Check your bot-management ' +
          `settings for a rule matching "${label}" and allow it if you want this page cited. ` +
          'Confirm it in your server logs first: this check sends the right User-Agent but comes ' +
          `from your IP, not ${label}'s published address range, so a rule that filters on IP will ` +
          'refuse this check and the real crawler differently.',
        gates: [
          robotsGate,
          gate('served', 'Server responds', 'fail', `HTTP ${bot.httpStatus} — the request was refused.`),
          gate('html', 'Response is HTML', 'skip', 'Never reached — no page was served.'),
          gate('source', 'Content present without JavaScript', 'skip', 'Never reached — no page was served.'),
          gate('js', 'Runs JavaScript', bot.executesJs ? 'pass' : 'fail',
            bot.executesJs
              ? 'Runs JavaScript, but that cannot help when no page is served.'
              : 'Does not run JavaScript — moot while the request is refused.')
        ]
      };
    }

    /* --- Gate 2a: rate limited, which is not an answer about this bot ----- */
    if (bot.status === 'throttled') {
      return {
        state: 'throttled',
        severity: 'warn',
        summary: 'Rate-limited — not measured',
        headline: `Your server rate-limited the check before ${label} could be measured.`,
        because:
          `The server answered HTTP ${bot.httpStatus} — "too many requests" — because this check ` +
          'asks for the same page once per crawler in quick succession. That is a limit on ' +
          `request rate, not a rule about ${label}. This result says nothing about whether ` +
          `${label} can read the page.`,
        fix:
          'Re-run the check — it now paces requests and backs off further after a 429, so a ' +
          'second run usually completes. If it keeps happening, the origin has an aggressive ' +
          'rate limit and the page is best checked on its own.',
        gates: [
          robotsGate,
          gate('served', 'Server responds', 'warn',
            `HTTP ${bot.httpStatus} — rate-limited, so the page was never returned to measure.`),
          gate('html', 'Response is HTML', 'skip', 'Never reached — the request was rate-limited.'),
          gate('source', 'Content present without JavaScript', 'skip', 'Never reached — the request was rate-limited.'),
          gate('js', 'Runs JavaScript', 'skip', 'Not relevant — nothing was measured.')
        ]
      };
    }

    if (bot.status === 'error') {
      return {
        state: 'error',
        severity: 'warn',
        summary: 'Could not be measured',
        headline: `The check could not reach this page as ${label}.`,
        because: bot.error || `The server returned HTTP ${bot.httpStatus}.`,
        fix: 'Re-run the check. If it keeps failing, the page may be intermittently unavailable to crawlers too.',
        gates: [
          robotsGate,
          gate('served', 'Server responds', 'fail', bot.error || `HTTP ${bot.httpStatus}.`),
          gate('html', 'Response is HTML', 'skip', 'Never reached.'),
          gate('source', 'Content present without JavaScript', 'skip', 'Never reached.'),
          gate('js', 'Runs JavaScript', 'skip', 'Not reached.')
        ]
      };
    }

    const servedGate = gate('served', 'Server responds', 'pass',
      `HTTP ${bot.httpStatus} — the page was served to this bot's User-Agent.`);

    /* --- Gate 3: was it HTML? --------------------------------------------- */
    const isHtml = !bot.contentType || /text\/html|application\/xhtml/i.test(bot.contentType);
    const htmlGate = isHtml
      ? gate('html', 'Response is HTML', 'pass', 'The response was HTML, which is what a crawler parses.')
      : gate('html', 'Response is HTML', 'warn',
          `Content-Type was "${bot.contentType}", not HTML. Crawlers may not extract text from it.`);

    /* --- Gates 4 and 5: is the content actually in there? ----------------- */
    const missing = bot.invisibleCount;
    const total = bot.totalBlocks;
    const missingHeadings = bot.invisibleHeadings;

    const sourceState = pct === null ? 'warn' : pct >= GOOD_SCORE ? 'pass' : pct >= POOR_SCORE ? 'warn' : 'fail';
    const sourceGate = gate('source', 'Content present without JavaScript', sourceState,
      total === 0
        ? 'This page has no measurable content blocks.'
        : `${missing} of ${total} content blocks are missing from the raw HTML` +
          (missingHeadings > 0 ? `, including ${missingHeadings} heading${missingHeadings === 1 ? '' : 's'}` : '') +
          '. They only exist after JavaScript runs.');

    const jsGate = bot.executesJs
      ? gate('js', 'Runs JavaScript', 'pass',
          'This crawler executes JavaScript on a delayed render pass, so missing content may still be picked up later.')
      : gate('js', 'Runs JavaScript', 'fail',
          'This crawler does not execute JavaScript. Whatever is missing from the raw HTML is missing permanently.');

    const gates = [robotsGate, servedGate, htmlGate, sourceGate, jsGate];

    /* --- The verdict ------------------------------------------------------ */
    if (pct === null) {
      return {
        state: 'partial', severity: 'warn', summary: 'Nothing to measure',
        headline: `${label} reaches this page, but there is no content to measure.`,
        because: 'No content blocks were found in the rendered page, so there is nothing to compare against.',
        fix: 'Check that the page finished loading before running the check.',
        gates
      };
    }

    if (pct >= GOOD_SCORE) {
      return {
        state: 'crawlable',
        severity: 'good',
        summary: 'Fully readable',
        headline: `${label} can read this page.`,
        because:
          `robots.txt allows it, your server served it, and ${pct}% of the page's content is already in ` +
          'the HTML the server returned — no JavaScript required.' +
          (missing > 0
            ? ` ${missing} of ${total} blocks are still JavaScript-only, but not enough to affect what can be cited.`
            : ' Every content block is present.'),
        fix: null,
        gates
      };
    }

    if (bot.executesJs) {
      return {
        state: 'partial',
        severity: 'warn',
        summary: 'At the mercy of rendering',
        headline: `${label} can reach this page, but most of it only appears after JavaScript runs.`,
        because:
          `Only ${pct}% of the content is in the raw HTML — ${missing} of ${total} blocks` +
          (missingHeadings > 0 ? `, including ${missingHeadings} of ${bot.totalHeadings} headings,` : '') +
          ' arrive later. This crawler does render JavaScript, so it will probably catch up, but on a ' +
          'delayed budget it does not publish and does not guarantee.',
        fix:
          'Server-render this content so it does not depend on a render pass that may be deferred, ' +
          'truncated, or skipped on a slow crawl.',
        gates
      };
    }

    if (pct >= POOR_SCORE) {
      return {
        state: 'partial',
        severity: 'warn',
        summary: 'Partly readable',
        headline: `${label} can reach this page but only reads part of it.`,
        because:
          `${pct}% of the content is in the raw HTML. The other ${missing} of ${total} blocks` +
          (missingHeadings > 0 ? `, including ${missingHeadings} heading${missingHeadings === 1 ? '' : 's'},` : '') +
          ' only exist after JavaScript runs — and this crawler never runs it. That content cannot be quoted or cited.',
        fix: 'Move the missing blocks into the initial server response.',
        gates
      };
    }

    return {
      state: 'not-crawlable',
      severity: 'critical',
      summary: 'Reaches it, cannot read it',
      headline: `${label} can reach this page but cannot read most of it.`,
      because:
        `Nothing is blocking the request — robots.txt allows it and the server returned HTTP ${bot.httpStatus}. ` +
        `The problem is that only ${pct}% of the content exists in that response. The other ${missing} of ` +
        `${total} blocks` +
        (missingHeadings > 0 ? `, including ${missingHeadings} of ${bot.totalHeadings} headings,` : '') +
        ' are written by JavaScript after load, and this crawler does not run JavaScript. To it, this page ' +
        'is close to empty.',
      fix:
        'Move this content into the initial server response. Until then it cannot be quoted or cited by ' +
        'this crawler no matter how well the page ranks in traditional search.',
      gates
    };
  }

  /**
   * @param {string} id
   * @param {string} label
   * @param {'pass'|'fail'|'warn'|'skip'} state
   * @param {string} detail
   * @returns {Gate}
   */
  function gate(id, label, state, detail) {
    return { id, label, state, detail };
  }

  /**
   * A single sentence covering the whole page, for the top of the report.
   *
   * Written from the AI-crawler point of view, because that is the question
   * this tool exists to answer — a page that only Googlebot can read is the
   * exact failure mode being surfaced.
   *
   * @param {Object[]} bots  Per-bot entries, each with `.verdict`.
   * @returns {{severity: 'good'|'warn'|'critical', headline: string, detail: string}}
   */
  function summarisePage(bots) {
    const ai = bots.filter((b) => !b.executesJs && !b.isBaseline);
    const blockedRobots = bots.filter((b) => b.verdict.state === 'blocked-robots');
    const blockedServer = bots.filter((b) => b.verdict.state === 'blocked-server');
    const unreadable = ai.filter((b) => b.verdict.state === 'not-crawlable');
    const readable = ai.filter((b) => b.verdict.state === 'crawlable');

    if (blockedRobots.length || blockedServer.length) {
      const names = [...blockedRobots, ...blockedServer].map((b) => b.label).join(', ');
      return {
        severity: 'critical',
        headline: `${names} cannot reach this page at all.`,
        detail:
          (blockedRobots.length ? `${blockedRobots.map((b) => b.label).join(', ')} ${blockedRobots.length === 1 ? 'is' : 'are'} disallowed in robots.txt. ` : '') +
          (blockedServer.length ? `${blockedServer.map((b) => b.label).join(', ')} ${blockedServer.length === 1 ? 'was' : 'were'} refused by the server. ` : '') +
          'Fix access first — rendering changes do nothing for a bot that never sends a request.'
      };
    }

    if (unreadable.length) {
      return {
        severity: 'critical',
        headline: `${unreadable.map((b) => b.label).join(', ')} can reach this page but cannot read it.`,
        detail:
          'Nothing is blocking these crawlers. The content simply is not in the HTML your server returns — ' +
          'it is written by JavaScript after load, and they do not run JavaScript.'
      };
    }

    // Before any "all clear" or "partly readable" claim. A throttled bot was
    // never measured, so counting it as anything other than unmeasured turns a
    // gap in the data into a finding about the page.
    const throttled = bots.filter((b) => b.verdict.state === 'throttled');
    if (throttled.length) {
      return {
        severity: 'warn',
        headline: `Incomplete — your server rate-limited ${throttled.length} of ${bots.length} crawler checks.`,
        detail:
          `${throttled.map((b) => b.label).join(', ')} ${throttled.length === 1 ? 'was' : 'were'} ` +
          'answered with "too many requests", so nothing was measured for ' +
          `${throttled.length === 1 ? 'it' : 'them'}. That is a limit on how fast this check asks, ` +
          'not a rule about those crawlers. Re-run to complete the picture.'
      };
    }

    if (readable.length === ai.length && ai.length > 0) {
      return {
        severity: 'good',
        headline: 'Every AI crawler checked can reach and read this page.',
        detail: 'robots.txt allows them, the server serves them, and the content is in the initial HTML response.'
      };
    }

    // Nothing was measured. Reaching the sentence below with no readable and
    // no unreadable crawler means every one of them errored or was never run,
    // and "they can reach it but only read part of it" would be a confident
    // description of a page nobody looked at. Same failure as a green cloaking
    // banner with nothing to compare: assert only what was observed.
    if (readable.length === 0 && unreadable.length === 0) {
      return {
        severity: 'warn',
        headline: 'No AI crawler could be measured on this page.',
        detail:
          ai.length === 0
            ? 'No AI crawler results were produced, so there is nothing to report yet.'
            : 'Every AI crawler check failed to complete, so nothing is known about what they can ' +
              'read here. Re-run the check — if it keeps failing, the page may be intermittently ' +
              'unavailable to crawlers too.'
      };
    }

    return {
      severity: 'warn',
      headline: 'AI crawlers can reach this page but only read part of it.',
      detail: 'Some content arrives only after JavaScript runs, and these crawlers never run it.'
    };
  }

  /**
   * Is the refusal pattern verified-bot allow-listing rather than a decision
   * to block crawlers?
   *
   * Every named crawler refused while a plain browser User-Agent is served is
   * the signature of a rule that admits crawlers only from their own published
   * IP ranges and refuses anything merely CLAIMING their User-Agent. That is a
   * correct, widely recommended posture, and this check — right UA, ordinary
   * IP — is indistinguishable from the spoofers it exists to stop.
   *
   * Googlebot appearing among the refused is the tell: a site genuinely 403ing
   * Googlebot would have fallen out of Google, so the likelier reading is that
   * the real crawler, arriving from its own addresses, is let through.
   *
   * @param {Array} bots  per-bot entries, in display order
   * @param {string} baselineBotId
   * @returns {{blockedIds: string[], baselineOk: boolean, looksLikeUaAllowlisting: boolean}}
   */
  function summariseServerBlocking(bots, baselineBotId) {
    const list = Array.isArray(bots) ? bots : [];
    const baseline = list.find((b) => b && b.botId === baselineBotId);
    const baselineOk = !!baseline && baseline.status === 'ok';

    const named = list.filter((b) => b && b.botId !== baselineBotId);
    const blocked = named.filter((b) => b.status === 'blocked');

    return {
      blockedIds: blocked.map((b) => b.botId),
      baselineOk,
      // More than one, or a single 403 on one crawler — a genuine per-bot
      // rule, which is the finding as stated — would be misread as a
      // site-wide allow-list.
      looksLikeUaAllowlisting:
        baselineOk && named.length > 1 && blocked.length === named.length
    };
  }

  AICL.verdict = { GOOD_SCORE, POOR_SCORE, buildVerdict, summarisePage, summariseServerBlocking };
})();
