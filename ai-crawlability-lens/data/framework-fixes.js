/**
 * data/framework-fixes.js
 *
 * Detected framework -> specific, actionable fix text.
 *
 * ES module. Imported by popup/popup.js and shared/report.js.
 *
 * This is deliberately a recommendation-bucket map, NOT a fingerprint database.
 * Detection (content/framework-detect.js) only needs to be accurate enough to
 * choose one of these buckets. Being wrong costs the user a slightly generic
 * paragraph, not a wrong verdict — the verdict comes from the diff engine.
 */

/**
 * @typedef {Object} FrameworkFix
 * @property {string} label       Display name of the framework.
 * @property {string} fix         The actionable recommendation.
 * @property {string} [detail]    Optional extra context shown under the fix.
 * @property {boolean} ssrCapable Whether the framework can server-render at all.
 */

/** @type {Record<string, FrameworkFix>} */
export const FRAMEWORK_FIXES = {
  'next-pages': {
    label: 'Next.js (Pages Router)',
    ssrCapable: true,
    fix: 'Convert this route to use `getServerSideProps` or `getStaticProps` instead of client-side data fetching.',
    detail:
      'Any content fetched in `useEffect` and rendered afterwards never reaches a non-JS crawler. Move that fetch into `getServerSideProps` (per-request) or `getStaticProps` (build time / ISR) so the content ships inside the initial HTML payload.'
  },
  'next-app': {
    label: 'Next.js (App Router)',
    ssrCapable: true,
    fix: "Ensure this content renders in a Server Component, not a Client Component (`'use client'`) — move data fetching to the server.",
    detail:
      "A `'use client'` boundary high in the tree pushes everything below it to the browser. Fetch in an async Server Component and pass the resulting data down as props, keeping `'use client'` for leaf-level interactivity only."
  },
  nuxt: {
    label: 'Nuxt',
    ssrCapable: true,
    fix: 'Use `asyncData` / `useAsyncData` with server-side rendering enabled, not a client-only `fetch` in `onMounted`.',
    detail:
      'Check that `ssr: true` is set in `nuxt.config` and that the route is not excluded from server rendering. Data fetched in `onMounted` runs only in the browser and is invisible to every non-JS crawler.'
  },
  gatsby: {
    label: 'Gatsby',
    ssrCapable: true,
    fix: 'Content should already be SSG at build time — check whether this specific block is being hydrated client-side unnecessarily.',
    detail:
      'Gatsby emits static HTML by default, so invisible blocks here usually mean the data is coming from a runtime `fetch` or a client-only component rather than from the GraphQL layer at build time. Move it into a page query.'
  },
  sveltekit: {
    label: 'SvelteKit',
    ssrCapable: true,
    fix: 'Load this data in a `+page.server.js` / `+page.js` `load` function rather than in `onMount`.',
    detail:
      'Confirm the route has not opted out with `export const ssr = false`. A `load` function runs on the server for the initial request, which is what puts the content into the HTML a crawler receives.'
  },
  remix: {
    label: 'Remix / React Router (framework mode)',
    ssrCapable: true,
    fix: 'Return this data from the route `loader` instead of fetching it in a `useEffect`.',
    detail:
      'Remix server-renders loader data into the initial response by design. Content that only appears after a client-side fetch bypasses that and never reaches a non-JS crawler.'
  },
  astro: {
    label: 'Astro',
    ssrCapable: true,
    fix: 'Render this content in the Astro component frontmatter rather than inside a client-hydrated island.',
    detail:
      'Islands marked `client:only` produce no server HTML at all. Use `client:load` (which still server-renders) or move the content out of the island entirely if it does not need interactivity.'
  },
  angular: {
    label: 'Angular',
    ssrCapable: true,
    fix: 'Enable Angular SSR (Angular Universal / `@angular/ssr`) so routes are server-rendered.',
    detail:
      'A default Angular CLI build ships an empty `<app-root>` shell. Without SSR or prerendering, every non-JS crawler sees that empty shell and nothing else.'
  },
  vue: {
    label: 'Vue (client-side)',
    ssrCapable: false,
    fix: 'This is a client-rendered Vue app with no SSR layer. Adopt Nuxt for server rendering, or implement dynamic rendering (prerender.io, Rendertron) for bot user-agents.',
    detail:
      'Vue mounted client-side produces an empty mount point in the initial HTML. Nuxt is the direct upgrade path; dynamic rendering is the lower-effort stopgap.'
  },
  react: {
    label: 'React SPA (Create React App / Vite / no meta-framework)',
    ssrCapable: false,
    fix: 'This is a client-rendered SPA with no SSR layer. Consider migrating to Next.js or Remix, or implement dynamic rendering (prerender.io, Rendertron) specifically for bot user-agents.',
    detail:
      'A CRA/Vite React build serves `<div id="root"></div>` and a bundle. Googlebot will eventually render it; GPTBot, PerplexityBot and ClaudeBot will not, ever. Migration gives you real SSR; dynamic rendering is the stopgap if migration is out of scope this quarter.'
  },
  spa: {
    label: 'Client-rendered SPA (framework not identified)',
    ssrCapable: false,
    fix: 'This is a client-rendered SPA with no SSR layer. Consider migrating to a server-rendering framework, or implement dynamic rendering (prerender.io, Rendertron) specifically for bot user-agents.',
    detail:
      'The initial HTML is an near-empty shell that the browser fills in with JavaScript. Whatever the framework, the fix shape is the same: get the content into the first server response.'
  },
  wordpress: {
    label: 'WordPress',
    ssrCapable: true,
    fix: 'WordPress server-renders by default — invisible blocks usually come from a block/plugin that loads its content over AJAX after page load.',
    detail:
      'Look for lazy-loaded post grids, tabbed/accordion widgets that fetch on open, and any block whose markup only appears after an XHR. Those are the pieces AI crawlers cannot see.'
  },
  shopify: {
    label: 'Shopify (Liquid)',
    ssrCapable: true,
    fix: 'Liquid renders server-side — invisible blocks usually come from an app embed or a section that populates over the Storefront API after load.',
    detail:
      'Review-widget apps, "recommended products" sections and metafield-driven content are the usual culprits. Render them in Liquid where you can.'
  },
  hugo: {
    label: 'Hugo',
    ssrCapable: true,
    fix: 'Hugo emits fully static HTML — invisible blocks mean this content is being injected by client-side JavaScript rather than by a template.',
    detail: 'Move the content into a partial or shortcode so it is present at build time.'
  },
  jekyll: {
    label: 'Jekyll',
    ssrCapable: true,
    fix: 'Jekyll emits fully static HTML — invisible blocks mean this content is being injected by client-side JavaScript rather than by a template.',
    detail: 'Move the content into a layout or include so it is present at build time.'
  },
  unknown: {
    label: 'Not identified',
    ssrCapable: true,
    fix: 'Move critical content into the initial server response rather than fetching or rendering it after page load.',
    detail:
      'Whatever the stack, the rule is the same: if content only exists after JavaScript runs, GPTBot, PerplexityBot and ClaudeBot will never see it. Test by viewing source (not DevTools Elements) and searching for the text — if it is not there, it is not crawlable by AI answer engines.'
  }
};

/**
 * @param {string|null|undefined} id
 * @returns {FrameworkFix}
 */
export function getFrameworkFix(id) {
  return FRAMEWORK_FIXES[id] || FRAMEWORK_FIXES.unknown;
}
