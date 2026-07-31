/**
 * engine/diff.js
 *
 * The core IP: given the blocks a human sees (rendered DOM) and the blocks a
 * bot received (raw HTML), decide which rendered blocks are INVISIBLE to that
 * bot, and score the page for it.
 *
 * Classic script, attaches to `self.AICL.diff`. Every function here is PURE:
 * plain data in, plain data out, no DOM, no network, no globals touched.
 *
 * ---------------------------------------------------------------------------
 * THE MATCHING RULE
 * ---------------------------------------------------------------------------
 * A rendered block counts as VISIBLE to a bot when either:
 *
 *   (a) EXACT — its normalised text appears as a substring anywhere in that
 *       bot's raw block text, or
 *
 *   (b) NEAR — it shares >= 80% of its tokens with some single raw block, or
 *
 *   (c) ENVELOPE — some raw block is >= 90% contained within it, and still
 *       accounts for >= 60% of it. That is JavaScript having DECORATED a
 *       server-rendered block rather than created it: the text is in the HTML,
 *       it just gained "(opens in a new tab)" at runtime.
 *
 * Neither (a) nor (b) alone behaves on real pages. Substring alone is too brittle:
 * one injected `<span>` at a word boundary turns a genuinely server-rendered
 * paragraph into a false "invisible" finding. Token overlap alone is too loose
 * and starts matching unrelated boilerplate. Substring first with overlap as a
 * tolerance band is the combination that holds up.
 *
 * Blocks with fewer than 4 tokens require an EXACT match. At 3 tokens, "80%
 * overlap" is 2 words out of 3, which matches unrelated text constantly.
 */

(function () {
  'use strict';

  const AICL = (self.AICL = self.AICL || {});

  /** Token-overlap threshold for a NEAR match. */
  const NEAR_MATCH_THRESHOLD = 0.8;

  /** Below this token count, only an EXACT match counts. */
  const MIN_TOKENS_FOR_NEAR_MATCH = 4;

  /**
   * The "JavaScript decorated a server-rendered block" case.
   *
   * A raw block whose tokens are almost entirely present in the rendered block
   * IS in the HTML — JavaScript only added to it. The commonest cause is an
   * accessibility affordance: a link labelled "Apply for a Personal Loan" that
   * gains "(opens in a new tab)" at runtime. Five injected tokens push a short
   * CTA below the 80% threshold and it gets reported as invisible, which is a
   * false alarm about content the crawler can read perfectly well.
   *
   * Measured the other way round: how much of the RAW block survived into the
   * rendered one.
   */
  const ENVELOPE_RAW_COVERAGE = 0.9;

  /**
   * ...guarded by how much of the rendered block is still the raw block's text.
   *
   * Without this, a genuinely client-rendered paragraph that happens to contain
   * a short server-rendered fragment ("Apply now" followed by 200 JS-rendered
   * words) would count as visible — hiding exactly the failure this tool
   * exists to find. The guard is deliberately the conservative half of the
   * rule: a false "visible" hides a real problem, which is worse than a false
   * "invisible" that merely annoys.
   */
  const ENVELOPE_MIN_RENDERED = 0.6;

  /**
   * Split normalised text into comparison tokens.
   * Punctuation is dropped so `"pricing."` and `"pricing"` are the same token.
   *
   * @param {string} normalized  Already lowercased + whitespace-collapsed.
   * @returns {string[]}
   */
  function tokenize(normalized) {
    if (!normalized) return [];
    return normalized
      .replace(/[^\p{L}\p{N}\s]+/gu, ' ')
      .split(/\s+/)
      .filter(Boolean);
  }

  /**
   * Build a multiset (token -> count) from a token list.
   *
   * @param {string[]} tokens
   * @returns {Map<string, number>}
   */
  function toMultiset(tokens) {
    const m = new Map();
    for (const t of tokens) m.set(t, (m.get(t) || 0) + 1);
    return m;
  }

  /**
   * Fraction of the NEEDLE's tokens that also appear in the haystack block,
   * counted as a multiset so repeated words do not over-credit.
   *
   * Denominator is the needle length: we are asking "how much of this rendered
   * block made it into the raw HTML", not "how similar are these two strings".
   *
   * @param {Map<string, number>} needleSet
   * @param {number} needleTotal
   * @param {Map<string, number>} haystackSet
   * @returns {number} 0..1
   */
  function overlapRatio(needleSet, needleTotal, haystackSet) {
    if (needleTotal === 0) return 0;
    let shared = 0;
    for (const [token, count] of needleSet) {
      const available = haystackSet.get(token);
      if (available) shared += Math.min(count, available);
    }
    return shared / needleTotal;
  }

  /**
   * Precompute the searchable form of a bot's raw blocks.
   *
   * @param {{match: string}[]} rawBlocks
   * @returns {{ haystack: string, indexed: {set: Map<string, number>, total: number}[] }}
   */
  function indexRawBlocks(rawBlocks) {
    const parts = [];
    const indexed = [];

    for (const b of rawBlocks) {
      parts.push(b.match);
      const tokens = tokenize(b.match);
      indexed.push({ set: toMultiset(tokens), total: tokens.length });
    }

    return {
      // Joined with a newline so a substring cannot straddle two unrelated
      // blocks and produce a bogus match.
      haystack: parts.join('\n'),
      indexed
    };
  }

  /**
   * Diff one bot's raw blocks against the rendered blocks.
   *
   * @param {{tag: string, text: string, match: string, index: number, weight: number}[]} renderedBlocks
   * @param {{tag: string, text: string, match: string, index: number, weight: number}[]} rawBlocks
   * @returns {{
   *   results: {index: number, tag: string, text: string, visible: boolean, method: 'exact'|'near'|'envelope'|'none'}[],
   *   invisibleIndices: number[],
   *   visibleIndices: number[],
   *   visibleCount: number,
   *   invisibleCount: number,
   *   totalBlocks: number,
   *   visibleWeight: number,
   *   totalWeight: number,
   *   score: number|null,
   *   invisibleHeadings: number,
   *   totalHeadings: number
   * }}
   */
  function diffBlocks(renderedBlocks, rawBlocks) {
    const rendered = Array.isArray(renderedBlocks) ? renderedBlocks : [];
    const raw = Array.isArray(rawBlocks) ? rawBlocks : [];

    const { haystack, indexed } = indexRawBlocks(raw);

    const results = [];
    const invisibleIndices = [];
    const visibleIndices = [];

    let visibleWeight = 0;
    let totalWeight = 0;
    let totalHeadings = 0;
    let invisibleHeadings = 0;

    for (const block of rendered) {
      const isHeading = block.weight === 2;
      totalWeight += block.weight;
      if (isHeading) totalHeadings += 1;

      /** @type {'exact'|'near'|'envelope'|'none'} */
      let method = 'none';

      if (block.match && haystack.includes(block.match)) {
        method = 'exact';
      } else {
        const tokens = tokenize(block.match);
        if (tokens.length >= MIN_TOKENS_FOR_NEAR_MATCH) {
          const needleSet = toMultiset(tokens);
          const needleTotal = tokens.length;
          // A raw block too small to satisfy EITHER rule can never match, so
          // skip it. The envelope rule has the lower floor, so it sets the
          // prune — pruning at 0.8 would discard the very block the envelope
          // rule exists to catch.
          const minRawTokens = Math.ceil(
            needleTotal * Math.min(NEAR_MATCH_THRESHOLD, ENVELOPE_MIN_RENDERED)
          );

          for (const candidate of indexed) {
            if (candidate.total < minRawTokens) continue;

            const renderedCovered = overlapRatio(needleSet, needleTotal, candidate.set);
            if (renderedCovered >= NEAR_MATCH_THRESHOLD) {
              method = 'near';
              break;
            }

            // The rendered block is the raw block plus JS-added decoration.
            if (renderedCovered >= ENVELOPE_MIN_RENDERED) {
              const rawCovered = overlapRatio(candidate.set, candidate.total, needleSet);
              if (rawCovered >= ENVELOPE_RAW_COVERAGE) {
                method = 'envelope';
                break;
              }
            }
          }
        }
      }

      const visible = method !== 'none';
      if (visible) {
        visibleWeight += block.weight;
        visibleIndices.push(block.index);
      } else {
        invisibleIndices.push(block.index);
        if (isHeading) invisibleHeadings += 1;
      }

      results.push({
        index: block.index,
        tag: block.tag,
        text: block.text,
        visible,
        method
      });
    }

    return {
      results,
      invisibleIndices,
      visibleIndices,
      visibleCount: visibleIndices.length,
      invisibleCount: invisibleIndices.length,
      totalBlocks: rendered.length,
      visibleWeight,
      totalWeight,
      // A page with nothing to measure scores null (shown as "n/a"), never 0 —
      // 0 reads as a catastrophic finding when it is actually "no content here".
      score: totalWeight === 0 ? null : Math.round((visibleWeight / totalWeight) * 100),
      invisibleHeadings,
      totalHeadings
    };
  }

  /**
   * Colour band for a score. Exactly 40 and exactly 75 are both amber.
   *
   * @param {number|null} score
   * @returns {'red'|'amber'|'green'|'none'}
   */
  function scoreBand(score) {
    if (score === null || score === undefined) return 'none';
    if (score < 40) return 'red';
    if (score <= 75) return 'amber';
    return 'green';
  }

  AICL.diff = {
    NEAR_MATCH_THRESHOLD,
    MIN_TOKENS_FOR_NEAR_MATCH,
    tokenize,
    toMultiset,
    overlapRatio,
    indexRawBlocks,
    diffBlocks,
    scoreBand
  };
})();
