# Tests

Not part of the extension package — `ai-crawlability-lens/` loads unpacked without any
of this. These exist so the engine logic and the browser-level behaviour can be
re-verified after a change.

## Running

```bash
node tests/engines.test.mjs    # no dependencies
node tests/browser.test.mjs    # needs Playwright
node tests/report.test.mjs     # needs Playwright
```

Playwright is a dev-only dependency:

```bash
npm i -g playwright
```

The browser suites resolve it from `playwright` or from a global install path, and use
Chromium's full channel (`channel: 'chromium'`) — the default headless shell cannot load
extensions.

## What each suite covers

### `engines.test.mjs` — 78 assertions, no browser

The pure engines, in Node:

- **robots.txt parser** — group merging, consecutive `User-agent` lines, longest-prefix
  product-token selection, `*` fallback (and that it is *not* merged with a specific
  group), longest-pattern precedence, `Allow` winning an equal-length tie, empty
  `Disallow`, `*` and trailing-`$` wildcards, mid-pattern `$` as a literal, trailing
  comments, `Crawl-delay` not closing a group header, and multi-token bots taking the
  strictest verdict.
- **diff engine** — exact and near matching, the 4-token floor for near matches, a match
  not being allowed to straddle two raw blocks, heading double-weighting, `null` (not
  `0`) for an empty page, and the colour bands.
- **cloaking engine** — identical content, genuinely divergent content, reordering not
  being flagged, the 15% threshold boundary, and a 403 being excluded from the
  comparison but reported as skipped.
- **verdict engine** — gate ordering (a robots.txt block outranks a low score, and
  points the fix at robots.txt), gates after the first failure reading `skip` rather
  than `fail`, the same score producing a *warning* for a JS-rendering crawler and a
  *critical* for one that does not render, the "user-agent-specific refusal" claim only
  being made when the baseline got a 200, band boundaries, and the page-level summary
  naming the most urgent cause first.

### `browser.test.mjs` — 85 assertions, real Chromium

Loads the shipped extension unpacked, then runs a full end-to-end check against a local
HTTP server that echoes the received `User-Agent` back into the page body.

The load-bearing one is **test 3**: it proves the `declarativeNetRequest` User-Agent swap
actually reaches the server. `fetch()` drops a `User-Agent` header *silently*, so if the
rule had not applied, every bot row would have been identical and completely plausible.

Also covers: the permission model on a fresh install, sequential (never parallel)
fetches, rule teardown, a `Disallow: /` for GPTBot producing a CRITICAL finding with no
score, `Google-Extended` evaluated separately from `Googlebot`, a 403 reading as
"blocked" rather than as a low score, cloaking flagged when one bot is served different
HTML, `DOMParser` provably not executing page scripts, and the overlay leaving
`document.body.outerHTML` byte-identical before, during and after.

### `report.test.mjs` — 21 assertions, real Chromium

Builds the export report from a real analysis result, opens it from `file://`, and
asserts it renders with zero errors, makes **zero network requests**, contains no
scripts and no external references, and includes every required section.

## Note on the pre-granted test origin

`browser.test.mjs` and `report.test.mjs` copy the extension and add
`host_permissions` for the local test origin. Chrome's optional-permission bubble cannot
be accepted from automation, and that grant is the only difference — `background.js`, the
DNR rule swap, the sequential loop and the robots parser are all the shipped code.

The shipped manifest's permission model is asserted separately, on the unmodified
extension, in suite A of `browser.test.mjs`.
