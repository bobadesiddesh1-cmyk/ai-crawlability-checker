/**
 * engine/cloaking.js
 *
 * Pairwise comparison of the RAW HTML each bot received, to detect
 * user-agent-dependent content serving.
 *
 * Classic script, attaches to `self.AICL.cloaking`. Pure: plain data in, plain
 * data out.
 *
 * ---------------------------------------------------------------------------
 * THE METHOD
 * ---------------------------------------------------------------------------
 * The "Generic non-JS bot" is a plain browser UA carrying no crawler token, so
 * it is the CONTROL. Any divergence between a named bot's raw HTML and the
 * control's raw HTML is by definition user-agent-dependent serving.
 *
 * Difference is measured as JACCARD DISTANCE over the SET of normalised block
 * texts:
 *
 *     distance = 1 - |A ∩ B| / |A ∪ B|
 *
 * A set rather than a positional diff, deliberately: reordering blocks is not
 * cloaking, and a positional diff would scream about it. Threshold is >15%,
 * and both responses must be HTTP 200 — comparing a 200 against a 403 is a
 * blocking finding, which is reported separately, not a cloaking finding.
 *
 * ---------------------------------------------------------------------------
 * WHY THE WORDING MATTERS
 * ---------------------------------------------------------------------------
 * Legitimate causes are common: geo and locale routing, edge A/B tests,
 * bot-specific caching layers, and prerender services — which this very tool
 * recommends elsewhere as a fix. So this is reported as a neutral technical
 * observation ("may serve different content"), never as an accusation. And when
 * nothing is found, that is stated explicitly, because a silent absence of a
 * warning is indistinguishable from a check that never ran.
 */

(function () {
  'use strict';

  const AICL = (self.AICL = self.AICL || {});

  /** Divergence above this fraction is reported. */
  const CLOAKING_THRESHOLD = 0.15;

  /**
   * Jaccard distance between two sets of strings.
   *
   * @param {Set<string>} a
   * @param {Set<string>} b
   * @returns {number} 0 (identical) .. 1 (nothing in common)
   */
  function jaccardDistance(a, b) {
    if (a.size === 0 && b.size === 0) return 0;
    let intersection = 0;
    // Iterate the smaller set for the lookups.
    const [small, large] = a.size <= b.size ? [a, b] : [b, a];
    for (const v of small) if (large.has(v)) intersection += 1;
    const union = a.size + b.size - intersection;
    if (union === 0) return 0;
    return 1 - intersection / union;
  }

  /**
   * @param {{match: string}[]} blocks
   * @returns {Set<string>}
   */
  function toBlockSet(blocks) {
    const s = new Set();
    for (const b of blocks || []) if (b && b.match) s.add(b.match);
    return s;
  }

  /**
   * Compare every fetched bot's raw blocks against the baseline bot's.
   *
   * @param {Record<string, {
   *   status: 'ok'|'blocked'|'error',
   *   httpStatus: number|null,
   *   rawBlocks: {match: string}[]
   * }>} perBotRaw   Keyed by bot id.
   * @param {string} baselineBotId
   * @param {Record<string, string>} botLabels  bot id -> display label.
   * @returns {{
   *   comparable: boolean,
   *   baselineBotId: string,
   *   baselineLabel: string,
   *   detected: boolean,
   *   comparisons: {botId: string, label: string, distancePct: number, diverges: boolean, uniqueToBot: number, uniqueToBaseline: number}[],
   *   skipped: {botId: string, label: string, reason: string}[],
   *   headline: string,
   *   detail: string
   * }}
   */
  function detectCloaking(perBotRaw, baselineBotId, botLabels) {
    const labels = botLabels || {};
    const baselineLabel = labels[baselineBotId] || baselineBotId;
    const baseline = perBotRaw ? perBotRaw[baselineBotId] : null;

    const comparisons = [];
    const skipped = [];

    const baselineUsable = !!baseline && baseline.status === 'ok' && baseline.httpStatus === 200;

    if (!baselineUsable) {
      return {
        comparable: false,
        baselineBotId,
        baselineLabel,
        detected: false,
        comparisons: [],
        skipped: [],
        headline: 'Cloaking check not possible',
        detail:
          `The ${baselineLabel} baseline fetch did not return HTTP 200, so there is nothing to ` +
          'compare the other bots against. Re-run the check once the page responds normally.'
      };
    }

    const baselineSet = toBlockSet(baseline.rawBlocks);

    for (const botId of Object.keys(perBotRaw)) {
      if (botId === baselineBotId) continue;
      const entry = perBotRaw[botId];
      const label = labels[botId] || botId;

      if (!entry || entry.status !== 'ok' || entry.httpStatus !== 200) {
        skipped.push({
          botId,
          label,
          reason:
            entry && entry.httpStatus
              ? `HTTP ${entry.httpStatus} — reported as a blocking finding instead.`
              : 'No successful response to compare.'
        });
        continue;
      }

      const botSet = toBlockSet(entry.rawBlocks);
      const distance = jaccardDistance(botSet, baselineSet);

      let uniqueToBot = 0;
      for (const v of botSet) if (!baselineSet.has(v)) uniqueToBot += 1;
      let uniqueToBaseline = 0;
      for (const v of baselineSet) if (!botSet.has(v)) uniqueToBaseline += 1;

      comparisons.push({
        botId,
        label,
        distancePct: Math.round(distance * 1000) / 10,
        diverges: distance > CLOAKING_THRESHOLD,
        uniqueToBot,
        uniqueToBaseline
      });
    }

    const diverging = comparisons.filter((c) => c.diverges);
    const detected = diverging.length > 0;

    if (detected) {
      const names = diverging.map((c) => `${c.label} (${c.distancePct}% different)`).join(', ');
      return {
        comparable: true,
        baselineBotId,
        baselineLabel,
        detected: true,
        comparisons,
        skipped,
        headline: 'Possible user-agent-based cloaking detected — this site may serve different content to different bots.',
        detail:
          `Compared against the ${baselineLabel} baseline, the raw HTML differed by more than ` +
          `${Math.round(CLOAKING_THRESHOLD * 100)}% of content blocks for: ${names}. ` +
          'This is a neutral technical observation, not an accusation. Common legitimate causes ' +
          'include geo or locale routing, edge A/B tests, bot-specific caching layers, and ' +
          'prerender services (which are themselves a recommended fix for AI crawlability). ' +
          'It is worth confirming the difference is intentional.'
      };
    }

    return {
      comparable: true,
      baselineBotId,
      baselineLabel,
      detected: false,
      comparisons,
      skipped,
      headline: 'No cloaking detected — all bots receive the same raw HTML.',
      detail:
        comparisons.length > 0
          ? `Every comparable bot's raw HTML matched the ${baselineLabel} baseline to within ` +
            `${Math.round(CLOAKING_THRESHOLD * 100)}% of content blocks.`
          : 'Only the baseline fetch succeeded, so there was nothing to compare — but no divergence was observed.'
    };
  }

  AICL.cloaking = {
    CLOAKING_THRESHOLD,
    jaccardDistance,
    toBlockSet,
    detectCloaking
  };
})();
