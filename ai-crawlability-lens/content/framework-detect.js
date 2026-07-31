/**
 * content/framework-detect.js
 *
 * Lightweight frontend framework detection — roughly 15 signals.
 *
 * ---------------------------------------------------------------------------
 * SCOPE, ON PURPOSE
 * ---------------------------------------------------------------------------
 * This is NOT a fingerprint database and is not trying to be. It only has to be
 * accurate enough to pick one recommendation bucket out of `data/framework-fixes.js`.
 * If it guesses wrong, the user gets a slightly generic paragraph — the VERDICT
 * still comes from the diff engine, which does not care what framework you use.
 * Competing tools ship 300-entry fingerprint databases; that is their product,
 * not ours.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS RUNS IN THE MAIN WORLD
 * ---------------------------------------------------------------------------
 * `window.__NEXT_DATA__`, `window.__NUXT__`, `window.Shopify` and friends live
 * on the PAGE's window object. Content scripts run in an isolated world with a
 * separate `window`, so from there these are all `undefined` and every SSR
 * framework would look like an unknown SPA. Injected with
 * `chrome.scripting.executeScript({world: 'MAIN'})`.
 *
 * The file's completion value is the result object, which is what
 * `executeScript` returns. It must therefore stay JSON-serialisable — no
 * Elements, no functions, no cyclic references.
 */

(function () {
  'use strict';

  /** @type {string[]} */
  const signals = [];

  /** @param {string} s */
  const note = (s) => {
    if (!signals.includes(s)) signals.push(s);
  };

  /** @param {string} sel */
  const has = (sel) => {
    try {
      return document.querySelector(sel) !== null;
    } catch {
      return false;
    }
  };

  /** Lowercased `content` of the meta generator tag, or ''. */
  function generatorMeta() {
    const el = document.querySelector('meta[name="generator" i]');
    return el ? String(el.getAttribute('content') || '').toLowerCase() : '';
  }

  /** All script `src` values, lowercased. */
  function scriptSrcs() {
    const out = [];
    for (const s of document.querySelectorAll('script[src]')) {
      const src = s.getAttribute('src');
      if (src) out.push(src.toLowerCase());
    }
    return out;
  }

  /** @param {string[]} srcs @param {string} needle */
  const srcHas = (srcs, needle) => srcs.some((s) => s.includes(needle));

  /**
   * React roots do not announce themselves on `window`. They do leave an
   * internal property on the container element whose name starts with
   * `__reactContainer$` (React 18+) or is `_reactRootContainer` (React 17).
   */
  function hasReactRoot() {
    const candidates = document.querySelectorAll(
      '#root, #app, #__next, [data-reactroot], body > div'
    );
    for (const el of candidates) {
      for (const key of Object.keys(el)) {
        if (key.startsWith('__reactContainer$') || key === '_reactRootContainer') return true;
      }
    }
    return false;
  }

  /** Vue 3 mounts leave `__vue_app__` on the host element; Vue 2 leaves `__vue__`. */
  function hasVueRoot() {
    const candidates = document.querySelectorAll('#app, #root, body > div');
    for (const el of candidates) {
      if (el.__vue_app__ || el.__vue__) return true;
    }
    return false;
  }

  /**
   * A shell page: almost no rendered text, an empty-ish mount point, and a pile
   * of scripts. The classic client-rendered SPA signature.
   */
  function looksLikeEmptyShell() {
    const bodyText = (document.body ? document.body.innerText || '' : '').trim();
    const scriptCount = document.querySelectorAll('script').length;
    return bodyText.length < 200 && scriptCount >= 1;
  }

  try {
    const gen = generatorMeta();
    const srcs = scriptSrcs();

    /** @type {string|null} */
    let id = null;

    /* --- 1-2. Next.js -------------------------------------------------- */
    // The App Router streams RSC payloads into `self.__next_f` and does NOT
    // emit `__NEXT_DATA__`. The Pages Router always emits `__NEXT_DATA__`.
    const nextAppSignals =
      typeof window.__next_f !== 'undefined' ||
      srcHas(srcs, '/_next/static/chunks/app/') ||
      has('script[src*="/_next/"][src*="/app/"]');
    const nextPagesSignals =
      typeof window.__NEXT_DATA__ !== 'undefined' || has('script#__NEXT_DATA__');

    if (nextPagesSignals && !nextAppSignals) {
      id = 'next-pages';
      note('window.__NEXT_DATA__ present (Pages Router)');
    } else if (nextAppSignals) {
      id = 'next-app';
      note('App Router RSC payload (self.__next_f / /_next/static/chunks/app/)');
      if (nextPagesSignals) note('__NEXT_DATA__ also present — mixed routers');
    } else if (srcHas(srcs, '/_next/')) {
      id = 'next-pages';
      note('/_next/ bundle path, no router-specific marker');
    }

    /* --- 3. Nuxt ------------------------------------------------------- */
    if (!id && (typeof window.__NUXT__ !== 'undefined' || typeof window.__NUXT_DATA__ !== 'undefined' || has('script#__NUXT_DATA__') || srcHas(srcs, '/_nuxt/'))) {
      id = 'nuxt';
      note('window.__NUXT__ / /_nuxt/ bundle path');
    }

    /* --- 4. Gatsby ----------------------------------------------------- */
    if (!id && (typeof window.___gatsby !== 'undefined' || has('#___gatsby') || srcHas(srcs, '/page-data/') || gen.includes('gatsby'))) {
      id = 'gatsby';
      note('#___gatsby root / page-data bundles / generator meta');
    }

    /* --- 5. Remix ------------------------------------------------------ */
    if (!id && (typeof window.__remixContext !== 'undefined' || typeof window.__remixManifest !== 'undefined')) {
      id = 'remix';
      note('window.__remixContext present');
    }

    /* --- 6. SvelteKit -------------------------------------------------- */
    if (!id && (typeof window.__sveltekit_dev !== 'undefined' || has('[data-sveltekit-preload-data]') || srcHas(srcs, '/_app/immutable/') || Object.keys(window).some((k) => k.startsWith('__sveltekit_')))) {
      id = 'sveltekit';
      note('SvelteKit markers (__sveltekit_* / /_app/immutable/)');
    }

    /* --- 7. Astro ------------------------------------------------------ */
    if (!id && (gen.includes('astro') || has('astro-island') || has('[data-astro-cid]'))) {
      id = 'astro';
      note('Astro generator meta / <astro-island>');
    }

    /* --- 8. Angular ---------------------------------------------------- */
    if (!id && (has('[ng-version]') || typeof window.ng !== 'undefined' || has('app-root'))) {
      id = 'angular';
      note('[ng-version] attribute / window.ng / <app-root>');
    }

    /* --- 9. Hugo / Jekyll (static generators) -------------------------- */
    if (!id && gen.includes('hugo')) {
      id = 'hugo';
      note('generator meta: Hugo');
    }
    if (!id && gen.includes('jekyll')) {
      id = 'jekyll';
      note('generator meta: Jekyll');
    }

    /* --- 10. Shopify --------------------------------------------------- */
    if (!id && (typeof window.Shopify !== 'undefined' || srcHas(srcs, 'cdn.shopify.com'))) {
      id = 'shopify';
      note('window.Shopify / cdn.shopify.com assets');
    }

    /* --- 10a. Adobe Experience Manager --------------------------------- */
    // The dominant enterprise CMS in banking, insurance and telco, and it was
    // falling through to "Not identified" — the generic bucket is least useful
    // exactly where the stack is most complicated. `/etc.clientlibs/` is the
    // AEM client-library proxy path and `aem-Grid` is the layout container;
    // both appear in delivered markup and neither has another plausible source.
    if (
      !id &&
      (srcHas(srcs, '/etc.clientlibs/') ||
        has('link[href*="/etc.clientlibs/"]') ||
        has('.aem-Grid, .aem-GridColumn') ||
        has('[data-cmp-is]') ||
        typeof window.Granite !== 'undefined' ||
        typeof window.CQURLInfo !== 'undefined' ||
        typeof window.CQ_Analytics !== 'undefined')
    ) {
      id = 'aem';
      note('AEM markers (/etc.clientlibs, aem-Grid, Granite/CQURLInfo)');
    }

    /* --- 11. WordPress ------------------------------------------------- */
    if (!id && (gen.includes('wordpress') || srcHas(srcs, '/wp-content/') || srcHas(srcs, '/wp-includes/'))) {
      id = 'wordpress';
      note('generator meta / wp-content assets');
    }

    /* --- 12. Create React App / Vite React ----------------------------- */
    if (!id && (srcHas(srcs, '/static/js/main.') || srcHas(srcs, '/static/js/bundle.js'))) {
      id = 'react';
      note('CRA bundle naming (/static/js/main.*.js)');
    }

    /* --- 13-14. Bare React / Vue --------------------------------------- */
    if (!id && (hasReactRoot() || typeof window.React !== 'undefined' || has('[data-reactroot]'))) {
      id = 'react';
      note('React root container detected, no meta-framework markers');
    }
    if (!id && (hasVueRoot() || typeof window.__VUE__ !== 'undefined' || has('[data-v-app]'))) {
      id = 'vue';
      note('Vue app root detected, no Nuxt markers');
    }

    /* --- 15. Empty-shell fallback -------------------------------------- */
    if (!id && looksLikeEmptyShell()) {
      id = 'spa';
      note('Near-empty initial body with scripts — client-rendered shell');
    }

    if (!id) {
      id = 'unknown';
      note('No recognised framework markers');
    }

    return {
      id,
      generator: gen || null,
      signals,
      // Two or more independent signals is a solid call; one is a guess worth
      // showing but not worth over-selling in the UI.
      confidence: signals.length >= 2 ? 'high' : id === 'unknown' ? 'none' : 'low',
      scriptCount: document.querySelectorAll('script').length,
      detectedAt: 'main-world'
    };
  } catch (err) {
    return {
      id: 'unknown',
      generator: null,
      signals: ['Detection failed: ' + String((err && err.message) || err)],
      confidence: 'none',
      scriptCount: 0,
      detectedAt: 'main-world'
    };
  }
})();
