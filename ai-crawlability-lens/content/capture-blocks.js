/**
 * content/capture-blocks.js
 *
 * Captures the GROUND TRUTH: the ordered content blocks a human actually sees
 * on the live, fully-rendered page. Everything else in this tool is measured
 * against this.
 *
 * Classic script, isolated world. Attaches to `self.AICL.capture`.
 *
 * Reads the DOM. Never writes to it.
 */

(function () {
  'use strict';

  const AICL = (self.AICL = self.AICL || {});

  /**
   * Capture the rendered content blocks.
   *
   * The Element for each block is kept in a module-level array (Elements are
   * not structured-cloneable, so they can never cross a message boundary) and
   * is what the overlay later measures with `getBoundingClientRect()`. The
   * serialisable half is what goes back to the popup.
   *
   * @returns {{
   *   blocks: {tag: string, text: string, match: string, index: number, weight: number}[],
   *   containerSelector: string,
   *   headingCount: number,
   *   totalChars: number
   * }}
   */
  function captureRendered() {
    const extractor = AICL.extractor;
    if (!extractor) {
      throw new Error('html-extractor.js must be injected before capture-blocks.js.');
    }

    const { blocks, elements, containerSelector } = extractor.extractBlocksFromDocument(document, {
      live: true,
      collectElements: true
    });

    // Held for the overlay. Deliberately module-level state, cleared whenever a
    // new capture runs, so a stale element list can never be highlighted.
    AICL.state = AICL.state || {};
    AICL.state.elements = elements || [];
    AICL.state.renderedBlocks = blocks;

    let headingCount = 0;
    let totalChars = 0;
    for (const b of blocks) {
      if (b.weight === 2) headingCount += 1;
      totalChars += b.text.length;
    }

    return {
      blocks,
      containerSelector,
      headingCount,
      totalChars
    };
  }

  /**
   * Page-level metadata worth reporting alongside the block diff.
   *
   * `<title>` and the meta description are almost always server-rendered even
   * on a full SPA, which is exactly why a page can pass a traditional SEO check
   * while being invisible to AI crawlers. Showing them makes that contrast
   * concrete.
   *
   * @returns {{title: string, metaDescription: string|null, lang: string|null, canonical: string|null, hasNoscript: boolean}}
   */
  function capturePageMeta() {
    const desc = document.querySelector('meta[name="description" i]');
    const canonical = document.querySelector('link[rel="canonical" i]');
    return {
      title: (document.title || '').trim(),
      metaDescription: desc ? (desc.getAttribute('content') || '').trim() : null,
      lang: document.documentElement.getAttribute('lang'),
      canonical: canonical ? canonical.getAttribute('href') : null,
      hasNoscript: document.querySelector('noscript') !== null
    };
  }

  AICL.capture = { captureRendered, capturePageMeta };
})();
