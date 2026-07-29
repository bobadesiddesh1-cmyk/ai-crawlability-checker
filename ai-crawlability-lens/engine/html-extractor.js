/**
 * engine/html-extractor.js
 *
 * Block extraction, shared by both sides of the diff:
 *   - the RENDERED DOM (what a human sees, after JavaScript)
 *   - the RAW HTML string each bot received (what a non-JS crawler sees)
 *
 * Classic script. Injected into the page's isolated world with
 * `chrome.scripting.executeScript({files: [...]})`, so it attaches to a
 * `self.AICL` namespace rather than using ES module syntax. Every function here
 * is pure with respect to the document it is handed — nothing is mutated on the
 * live page.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS RUNS IN THE PAGE AND NOT THE SERVICE WORKER
 * ---------------------------------------------------------------------------
 * MV3 service workers have no `DOMParser`. The alternatives were a regex HTML
 * extractor (wrong on real markup) or an offscreen document (extra moving part,
 * extra permission). Passing the raw HTML string into a context that already
 * has a real HTML parser is the simplest correct option.
 *
 * `DOMParser.parseFromString(html, 'text/html')` produces an INERT document:
 * scripts never execute, subresources never load, no network happens. That is
 * exactly the semantics we want — it is a faithful model of a non-JS crawler,
 * and it is safe to run against arbitrary fetched markup.
 */

(function () {
  'use strict';

  const AICL = (self.AICL = self.AICL || {});

  /**
   * The block types an extractive answer engine actually quotes.
   *
   * `div` and `span` are excluded on purpose: their text is almost always
   * already covered by a child block, so including them double-counts and
   * skews every score.
   */
  const BLOCK_SELECTOR = 'h1, h2, h3, h4, h5, h6, p, li, td, th, blockquote';

  /** Tags that are stripped outright before extraction. */
  const STRIP_TAGS = ['script', 'style', 'noscript', 'template', 'svg', 'iframe'];

  /**
   * Boilerplate containers. A block inside any of these is skipped regardless
   * of which container was selected, because boilerplate is usually
   * server-rendered even on SPAs — counting it inflates every score toward
   * "fine" and buries the actual finding.
   */
  const BOILERPLATE_SELECTOR =
    'nav, header, footer, aside, [role="navigation"], [role="banner"], ' +
    '[role="contentinfo"], [role="complementary"], [aria-hidden="true"], [hidden]';

  /** Candidate main-content containers, best first. */
  const CONTAINER_CANDIDATES = [
    'main',
    '[role="main"]',
    'article',
    '#main',
    '#content',
    '#main-content',
    '.main-content',
    '.entry-content',
    '.post-content',
    '.article-body'
  ];

  /** Headings count double in the visibility score. See README > Methodology. */
  const HEADING_TAGS = new Set(['h1', 'h2', 'h3', 'h4', 'h5', 'h6']);

  /** Below this length a block is noise (bullets, digits, stray punctuation). */
  const MIN_BLOCK_CHARS = 3;

  /**
   * Normalise text for comparison.
   *
   * Raw markup and the rendered DOM differ constantly in ways that carry no
   * content difference at all: `&nbsp;` vs a space, `&#39;` vs `'`, smart
   * quotes, zero-width joiners, template indentation, CSS `text-transform`.
   * Folding all of that is what makes the diff report real findings instead of
   * encoding trivia.
   *
   *   NFKC  — folds ligatures, full-width forms, and compatibility characters.
   *   Then  — non-breaking / zero-width spaces become ordinary spaces.
   *   Then  — whitespace runs collapse, ends trim.
   *   Then  — lowercase, for the MATCHING KEY ONLY. The original cased text is
   *           kept separately for display.
   *
   * @param {string} input
   * @returns {string}
   */
  function normalizeText(input) {
    if (typeof input !== 'string') return '';
    let s = input;
    try {
      s = s.normalize('NFKC');
    } catch {
      /* Older engines without full NFKC data — the rest still applies. */
    }
    s = s
      // Non-breaking, ogham, en/em/thin/hair, narrow-nbsp, medium-math, ideographic spaces.
      .replace(/[\u00A0\u1680\u2000-\u200A\u202F\u205F\u3000]/g, ' ')
      // Zero-width space / non-joiner / joiner, BOM, soft hyphen.
      .replace(/[\u200B-\u200D\uFEFF\u00AD]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    return s;
  }

  /**
   * The display form: same folding, but case preserved.
   * @param {string} input
   * @returns {string}
   */
  function normalizeForDisplay(input) {
    return normalizeText(input);
  }

  /**
   * The comparison key: normalised and lowercased.
   * @param {string} input
   * @returns {string}
   */
  function normalizeForMatch(input) {
    return normalizeText(input).toLowerCase();
  }

  /**
   * Remove tags whose text content is never page content.
   * Only ever called on a document WE created (a DOMParser result), never on
   * the live page.
   *
   * @param {Document} doc
   */
  function stripNonContentTags(doc) {
    for (const tag of STRIP_TAGS) {
      const nodes = doc.querySelectorAll(tag);
      for (const node of nodes) node.remove();
    }
  }

  /**
   * Rough measure of how much block text sits inside an element.
   * Used only to break ties between multiple candidate containers.
   *
   * @param {Element} el
   * @returns {number}
   */
  function blockTextLength(el) {
    let total = 0;
    const nodes = el.querySelectorAll(BLOCK_SELECTOR);
    for (const n of nodes) total += (n.textContent || '').length;
    return total;
  }

  /**
   * Choose the container to extract from.
   *
   * `main` / `[role=main]` first, then the largest `article`, then a short list
   * of conventional ids and classes, then `body`. Because boilerplate is
   * excluded by ancestor check anyway (see BOILERPLATE_SELECTOR), falling all
   * the way back to `body` is a safe outcome rather than a bad one — which
   * matters for CSR shells that have no `main` element at all.
   *
   * @param {Document} doc
   * @returns {{ container: Element, selector: string }}
   */
  function pickContentContainer(doc) {
    for (const sel of CONTAINER_CANDIDATES) {
      const matches = doc.querySelectorAll(sel);
      if (matches.length === 0) continue;

      let best = null;
      let bestLen = -1;
      for (const el of matches) {
        const len = blockTextLength(el);
        if (len > bestLen) {
          best = el;
          bestLen = len;
        }
      }
      if (best && bestLen > 0) return { container: best, selector: sel };
    }

    return {
      container: doc.body || doc.documentElement,
      selector: 'body'
    };
  }

  /**
   * True if this element sits inside boilerplate, or is itself boilerplate.
   *
   * @param {Element} el
   * @param {Element} stopAt  Do not walk above this ancestor.
   * @returns {boolean}
   */
  function isInsideBoilerplate(el, stopAt) {
    let node = el;
    while (node && node !== stopAt.parentElement) {
      if (node.matches && node.matches(BOILERPLATE_SELECTOR)) return true;
      node = node.parentElement;
    }
    return false;
  }

  /**
   * True if this block contains another block. We keep only the innermost
   * block so `<li><p>text</p></li>` contributes one block, not two.
   *
   * @param {Element} el
   * @returns {boolean}
   */
  function containsNestedBlock(el) {
    return el.querySelector(BLOCK_SELECTOR) !== null;
  }

  /**
   * True if a LIVE element is not visible to the user. Never called on a
   * DOMParser document (which has no layout and no computed styles).
   *
   * @param {Element} el
   * @returns {boolean}
   */
  function isVisuallyHidden(el) {
    // offsetParent is null for display:none and for position:fixed elements;
    // the rect check below covers the fixed case correctly.
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) return true;

    const view = el.ownerDocument && el.ownerDocument.defaultView;
    if (!view) return false;
    const cs = view.getComputedStyle(el);
    if (!cs) return false;
    if (cs.display === 'none' || cs.visibility === 'hidden' || cs.visibility === 'collapse') {
      return true;
    }
    if (cs.opacity === '0') return true;
    return false;
  }

  /**
   * Extract ordered content blocks from a document.
   *
   * @param {Document} doc
   * @param {{ live?: boolean, collectElements?: boolean }} [options]
   *        live            — apply visibility filtering (only valid for the real page).
   *        collectElements — also return the Element for each block, for the overlay.
   * @returns {{
   *   blocks: {tag: string, text: string, match: string, index: number, weight: number}[],
   *   elements: Element[]|null,
   *   containerSelector: string
   * }}
   */
  function extractBlocksFromDocument(doc, options) {
    const opts = options || {};
    const live = opts.live === true;
    const collectElements = opts.collectElements === true;

    if (!doc || !doc.body) {
      return { blocks: [], elements: collectElements ? [] : null, containerSelector: 'none' };
    }

    const { container, selector } = pickContentContainer(doc);

    const blocks = [];
    const elements = collectElements ? [] : null;

    const candidates = container.querySelectorAll(BLOCK_SELECTOR);
    let index = 0;

    for (const el of candidates) {
      if (containsNestedBlock(el)) continue;
      if (isInsideBoilerplate(el, container)) continue;
      if (live && isVisuallyHidden(el)) continue;

      // textContent (not innerText) on BOTH sides of the diff. innerText does
      // not exist on a DOMParser document, and using different accessors for
      // the two sides would introduce differences that are not real.
      const display = normalizeForDisplay(el.textContent || '');
      if (display.length < MIN_BLOCK_CHARS) continue;

      const tag = el.tagName.toLowerCase();
      blocks.push({
        tag,
        text: display,
        match: display.toLowerCase(),
        index,
        weight: HEADING_TAGS.has(tag) ? 2 : 1
      });
      if (elements) elements.push(el);
      index += 1;
    }

    return { blocks, elements, containerSelector: selector };
  }

  /**
   * Extract content blocks from a raw HTML STRING — the crawler's-eye view.
   *
   * `<script>`, `<style>` and `<noscript>` are stripped before extraction, per
   * the methodology: we are measuring prose a crawler can attribute, and a
   * `<noscript>` fallback is not what gets cited.
   *
   * No script in the supplied HTML executes. DOMParser guarantees that.
   *
   * @param {string} html
   * @returns {{
   *   blocks: {tag: string, text: string, match: string, index: number, weight: number}[],
   *   containerSelector: string,
   *   byteLength: number,
   *   parseError: string|null
   * }}
   */
  function extractBlocksFromHtml(html) {
    if (typeof html !== 'string' || html.length === 0) {
      return { blocks: [], containerSelector: 'none', byteLength: 0, parseError: 'Empty response body.' };
    }

    let doc;
    try {
      doc = new DOMParser().parseFromString(html, 'text/html');
    } catch (err) {
      return {
        blocks: [],
        containerSelector: 'none',
        byteLength: html.length,
        parseError: String((err && err.message) || err)
      };
    }

    stripNonContentTags(doc);
    const { blocks, containerSelector } = extractBlocksFromDocument(doc, { live: false });

    return { blocks, containerSelector, byteLength: html.length, parseError: null };
  }

  AICL.extractor = {
    BLOCK_SELECTOR,
    BOILERPLATE_SELECTOR,
    HEADING_TAGS,
    MIN_BLOCK_CHARS,
    normalizeText,
    normalizeForDisplay,
    normalizeForMatch,
    extractBlocksFromDocument,
    extractBlocksFromHtml,
    pickContentContainer
  };
})();
