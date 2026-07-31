/**
 * content/main.js
 *
 * The orchestrator inside the page.
 *
 * Classic script, isolated world. Injected last, after html-extractor.js,
 * diff.js, cloaking.js, capture-blocks.js and overlay.js.
 *
 * Flow for one check:
 *
 *   popup  --AICL_RUN-->  main.js
 *   main.js --AICL_RUN_FETCHES--> background (robots.txt + 6 sequential bot fetches)
 *   main.js captures the rendered DOM, extracts blocks from each raw HTML body,
 *           diffs, scores, runs the cloaking comparison
 *   main.js --analysis--> popup
 *
 * The raw HTML bodies travel background -> content and stop there. They are
 * never forwarded to the popup, never stored, and are released as soon as this
 * function returns. Only counts, scores and short text excerpts leave the page.
 */

(function () {
  'use strict';

  const AICL = (self.AICL = self.AICL || {});
  AICL.state = AICL.state || {};

  // `executeScript` is called on every check, so this file can be evaluated
  // more than once in the same page. Registering the listener twice would make
  // every message handled twice and the second `sendResponse` would throw.
  if (AICL.__wired) return;
  AICL.__wired = true;

  /** How many invisible-block excerpts are handed back per bot. */
  const MAX_EXCERPTS_PER_BOT = 100;

  /** Character cap on each excerpt. */
  const MAX_EXCERPT_CHARS = 300;

  /* ----------------------------------------------------------------------- */
  /* Messaging                                                                */
  /* ----------------------------------------------------------------------- */

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!message || typeof message.type !== 'string') return false;

    switch (message.type) {
      case 'AICL_RUN':
        runCheck(message.url)
          .then((result) => sendResponse({ ok: true, result }))
          .catch((err) => sendResponse({ ok: false, error: String((err && err.message) || err) }));
        return true; // async

      case 'AICL_OVERLAY_SHOW': {
        const data = AICL.state.overlayData;
        if (!data) {
          sendResponse({ ok: false, error: 'Run a check before showing the overlay.' });
          return false;
        }
        const botId = message.botId && data.perBot[message.botId] ? message.botId : data.defaultBotId;
        sendResponse(AICL.overlay.show({ botId, order: data.order, perBot: data.perBot }));
        return false;
      }

      case 'AICL_OVERLAY_HIDE':
        sendResponse(AICL.overlay.hide());
        return false;

      case 'AICL_OVERLAY_STATE':
        sendResponse({ ok: true, visible: AICL.overlay.isVisible() });
        return false;

      case 'AICL_CONTENT_PING':
        sendResponse({ ok: true, ready: true });
        return false;

      default:
        return false;
    }
  });

  /* ----------------------------------------------------------------------- */
  /* The check                                                                */
  /* ----------------------------------------------------------------------- */

  /**
   * @param {string} url
   * @returns {Promise<Object>}
   */
  async function runCheck(url) {
    // A live overlay holds Element references from the PREVIOUS capture. Those
    // are about to be replaced, so dismiss it before re-capturing rather than
    // leaving stale boxes over the page.
    if (AICL.overlay && AICL.overlay.isVisible()) AICL.overlay.hide();

    // 1. Ground truth: what a human sees, right now, after JavaScript.
    const rendered = AICL.capture.captureRendered();
    const pageMeta = AICL.capture.capturePageMeta();

    // 2. Ask the privileged half for robots.txt and the six raw fetches.
    const response = await chrome.runtime.sendMessage({ type: 'AICL_RUN_FETCHES', url });
    if (!response || !response.ok) {
      const err = (response && response.error) || 'The background fetch failed.';
      throw new Error(err);
    }
    const fetched = response.result;

    // 3. Extract, diff and score, one bot at a time.
    const perBot = {};
    const rawForCloaking = {};
    const botLabels = {};
    const order = [];

    for (const bot of fetched.bots) {
      order.push(bot.id);
      botLabels[bot.id] = bot.label;

      const f = fetched.perBot[bot.id];
      const robotsVerdict = fetched.robots.botVerdicts[bot.id] || null;
      const robotsBlocked = !!robotsVerdict && robotsVerdict.allowed === false;

      const raw = AICL.extractor.extractBlocksFromHtml(f.html || '');
      rawForCloaking[bot.id] = {
        status: f.status,
        httpStatus: f.httpStatus,
        rawBlocks: raw.blocks
      };

      const d = AICL.diff.diffBlocks(rendered.blocks, raw.blocks);

      // A score only means something when the bot actually received the page.
      // A 403 scores 0 for the trivial reason that there was no body — that is
      // a BLOCKING finding, not a rendering finding, and conflating the two is
      // exactly what this tool exists to stop people doing.
      const scoreMeaningful = f.status === 'ok' && !robotsBlocked;

      perBot[bot.id] = {
        botId: bot.id,
        label: bot.label,
        executesJs: bot.executesJs,
        isBaseline: bot.isBaseline,
        note: bot.note,
        ua: bot.ua,

        status: f.status,
        httpStatus: f.httpStatus,
        error: f.error,
        elapsedMs: f.elapsedMs,
        byteLength: f.byteLength,
        truncated: f.truncated,
        redirectedCrossOrigin: f.redirectedCrossOrigin,
        finalUrl: f.finalUrl,
        contentType: f.contentType,

        robotsAllowed: robotsVerdict ? robotsVerdict.allowed : true,
        robotsBlocked,
        robotsRule: robotsVerdict ? robotsVerdict.matchedRule : null,
        robotsGroup: robotsVerdict ? robotsVerdict.matchedGroup : null,
        robotsReason: robotsVerdict ? robotsVerdict.reason : null,

        rawBlockCount: raw.blocks.length,
        rawParseError: raw.parseError,
        rawContainer: raw.containerSelector,

        score: scoreMeaningful ? d.score : null,
        rawScore: d.score,
        scoreMeaningful,
        band: scoreMeaningful ? AICL.diff.scoreBand(d.score) : 'none',
        visibleCount: d.visibleCount,
        invisibleCount: d.invisibleCount,
        totalBlocks: d.totalBlocks,
        invisibleHeadings: d.invisibleHeadings,
        totalHeadings: d.totalHeadings,
        visibleWeight: d.visibleWeight,
        totalWeight: d.totalWeight,

        invisibleIndices: d.invisibleIndices,
        visibleIndices: d.visibleIndices,
        invisibleBlocks: d.results
          .filter((r) => !r.visible)
          .slice(0, MAX_EXCERPTS_PER_BOT)
          .map((r) => ({
            tag: r.tag,
            index: r.index,
            text: r.text.length > MAX_EXCERPT_CHARS ? r.text.slice(0, MAX_EXCERPT_CHARS) + '…' : r.text
          })),
        invisibleTruncated: d.invisibleCount > MAX_EXCERPTS_PER_BOT,

        statusLabel: statusLabel(f, robotsBlocked),
        statusDetail: statusDetail(f, robotsBlocked, robotsVerdict)
      };
    }

    // 4. Why can each bot read this page, or why can't it? The gate chain has
    //    to run after every bot is measured, because "the server refused you
    //    specifically" is only knowable once the plain-UA baseline is in.
    const baseline = perBot[fetched.baselineBotId];
    const verdictContext = {
      baselineOk: !!baseline && baseline.status === 'ok',
      baselineLabel: baseline ? baseline.label : 'the baseline'
    };
    for (const id of order) {
      perBot[id].verdict = AICL.verdict.buildVerdict(perBot[id], verdictContext);
    }

    // Pure, and therefore unit-testable — see engine/verdict.js for why the
    // pattern matters.
    const serverBlocking = AICL.verdict.summariseServerBlocking(
      order.map((id) => perBot[id]),
      fetched.baselineBotId
    );
    const pageVerdict = AICL.verdict.summarisePage(order.map((id) => perBot[id]));

    // 5. Cloaking, against the plain-UA baseline.
    const cloaking = AICL.cloaking.detectCloaking(rawForCloaking, fetched.baselineBotId, botLabels);

    // 6. Stash what the overlay needs. Elements cannot be serialised, so the
    //    overlay reads them from AICL.state, not from a message.
    AICL.state.overlayData = {
      order,
      defaultBotId: pickDefaultOverlayBot(perBot, order),
      perBot: Object.fromEntries(
        order.map((id) => {
          const b = perBot[id];
          return [
            id,
            {
              label: b.label,
              score: b.score,
              band: b.band,
              invisibleIndices: b.invisibleIndices,
              visibleIndices: b.visibleIndices,
              totalBlocks: b.totalBlocks,
              invisibleHeadings: b.invisibleHeadings,
              totalHeadings: b.totalHeadings,
              status: b.status,
              statusLabel: b.statusLabel,
              statusDetail: b.statusDetail,
              robotsBlocked: b.robotsBlocked,
              verdictHeadline: b.verdict.headline,
              verdictSummary: b.verdict.summary,
              verdictSeverity: b.verdict.severity
            }
          ];
        })
      )
    };

    return {
      url: fetched.url,
      origin: fetched.origin,
      path: fetched.path,
      checkedAt: fetched.checkedAt,
      pageMeta,
      rendered: {
        totalBlocks: rendered.blocks.length,
        headingCount: rendered.headingCount,
        totalChars: rendered.totalChars,
        containerSelector: rendered.containerSelector
      },
      robots: fetched.robots,
      throttling: fetched.throttling,
      serverBlocking,
      order,
      perBot,
      pageVerdict,
      cloaking,
      baselineBotId: fetched.baselineBotId,
      defaultBotId: AICL.state.overlayData.defaultBotId
    };
  }

  /* ----------------------------------------------------------------------- */
  /* Helpers                                                                  */
  /* ----------------------------------------------------------------------- */

  /**
   * The bot the overlay opens on: the worst genuinely-scored AI crawler, since
   * that is the finding the user is here for. Falls back to the first bot.
   *
   * @param {Record<string, any>} perBot
   * @param {string[]} order
   * @returns {string}
   */
  function pickDefaultOverlayBot(perBot, order) {
    let best = null;
    for (const id of order) {
      const b = perBot[id];
      if (!b || !b.scoreMeaningful || b.executesJs) continue;
      if (best === null || b.score < perBot[best].score) best = id;
    }
    if (best) return best;

    for (const id of order) {
      if (perBot[id] && perBot[id].scoreMeaningful) return id;
    }
    return order[0];
  }

  /**
   * @param {any} f
   * @param {boolean} robotsBlocked
   * @returns {string}
   */
  function statusLabel(f, robotsBlocked) {
    if (robotsBlocked) return 'Disallowed in robots.txt';
    if (f.status === 'ok') return `OK (${f.httpStatus})`;
    if (f.status === 'blocked') return `Blocked (${f.httpStatus})`;
    if (f.status === 'throttled') return `Rate-limited (${f.httpStatus})`;
    if (f.httpStatus) return `Error (${f.httpStatus})`;
    return 'Error';
  }

  /**
   * @param {any} f
   * @param {boolean} robotsBlocked
   * @param {any} robotsVerdict
   * @returns {string}
   */
  function statusDetail(f, robotsBlocked, robotsVerdict) {
    const parts = [];

    if (robotsBlocked && robotsVerdict && robotsVerdict.matchedRule) {
      parts.push(
        `robots.txt blocks this bot with "${robotsVerdict.matchedRule}" in the ` +
          `"${robotsVerdict.matchedGroup}" group. It will never request this page.`
      );
    }

    if (f.status === 'blocked') {
      parts.push(
        `The server returned HTTP ${f.httpStatus} to this bot's User-Agent. ` +
          'If the plain-UA baseline got a 200, the block is user-agent-specific.'
      );
    } else if (f.status === 'throttled') {
      parts.push(
        `The server returned HTTP ${f.httpStatus} — rate limiting, not bot blocking. ` +
          (f.attempts > 1 ? 'The check waited and retried once, and was limited again. ' : '') +
          'This bot was never measured, so it has no score. Re-check to fill the gap.'
      );
    } else if (f.status === 'error') {
      parts.push(f.error || `The server returned HTTP ${f.httpStatus}.`);
    }

    if (f.redirectedCrossOrigin) {
      parts.push(
        `Redirected off-origin to ${f.finalUrl} — the spoofed User-Agent is not carried across origins, ` +
          'so this row reflects the redirect target fetched as a normal browser.'
      );
    }

    if (f.truncated) {
      parts.push('Response body was very large and was truncated before analysis.');
    }

    if (f.contentType && !/text\/html|application\/xhtml/i.test(f.contentType)) {
      parts.push(`Content-Type was "${f.contentType}", not HTML.`);
    }

    return parts.join(' ');
  }
})();
