# DECISIONS.md — AI Crawlability Lens

Every non-obvious choice made while building this extension, and why. Where the
brief left something genuinely unspecified, the default chosen is recorded here.

---

## 1. Scope and positioning

**Decision:** This is *not* a CSR/SSR detector. No performance tab, no TTFB/FCP/LCP,
no framework fingerprint database, no PDF export of a "CSR percentage".

**Why:** That space is already served by SEO Render Insight Tool, CSR vs SSR Detector
and chrome-ssr-csr. The differentiator here is three things nothing else does:
per-AI-bot **raw fetch** visibility, **robots.txt bot-blocking** detection, and
**cloaking** detection between bot user-agents. Every feature traces back to one of
those three. Framework detection exists only to pick a recommendation bucket — it is
deliberately ~15 signals, not a fingerprint DB.

---

## 2. Permission model

**Decision:** `permissions: ["storage", "activeTab", "scripting", "declarativeNetRequest"]`,
`optional_host_permissions: ["<all_urls>"]`, and **no** static `host_permissions`.
Host access for the current tab's origin only is requested at click time via
`chrome.permissions.request({ origins: ["https://example.com/*"] })`.

**Why:** A statically declared `<all_urls>` gets a Web Store review flag and a scary
install-time warning ("Read and change all your data on all websites") for a tool that
only ever touches one origin at a time, on demand. Requesting per-origin at click time
means a user who checks `example.com` grants access to `example.com` and nothing else.

**Decision:** `chrome.permissions.request()` is called from **popup.js**, not the
service worker.

**Why:** Chrome requires a user gesture for `permissions.request()`. Service workers
have no gesture context; the popup's click handler does. The worker then does the
privileged fetching once the grant exists.

**Decision:** Permission is requested as `<origin>/*` and never revoked automatically.

**Why:** Re-prompting on every check would be hostile. The user can revoke per-site
access from `chrome://extensions` at any time; the popup shows a "Revoke access for
this site" control so it is one click away without leaving the extension.

**Decision:** `declarativeNetRequest` (not `declarativeNetRequestWithHostAccess`).

**Why:** `modifyHeaders` rules require host permission for the request URL under either
permission. `declarativeNetRequest` is the plain form and is what we need; the host
access comes from the optional per-origin grant. We never block or redirect anything,
only set a request header on our own requests.

---

## 3. The User-Agent spoofing mechanism

**Decision:** `chrome.declarativeNetRequest` dynamic rules with
`initiatorDomains: [chrome.runtime.id]`, `resourceTypes: ['xmlhttprequest']`, and
`urlFilter` anchored to the target origin.

**Why:** `User-Agent` is a forbidden header name for `fetch()` — the browser silently
drops it. DNR `modifyHeaders` operates below that layer. Scoping by `initiatorDomains`
to this extension's own ID means the rule can only ever touch requests this extension
itself makes. It cannot affect the user's normal browsing, other tabs, or other
extensions. This is the single most important safety property of the build.

**Decision:** Bot fetches are strictly **sequential**, one at a time, and the rule is
only swapped after the response body has been fully read.

**Why:** There is exactly one rule ID in play (`DNR_RULE_ID = 1`). Parallel fetches
would race on the rule swap and silently attribute the wrong UA to a response — the
worst possible failure mode for this tool, because the output would look correct.
Sequential costs a few seconds; correctness is non-negotiable here.

**Decision:** `urlFilter` is `|<origin>/` (left-anchored to the origin), not the exact
full URL.

**Why:** Left-anchoring to the origin covers same-origin redirects (trailing slash
normalisation, locale prefixes) which are extremely common. Cross-origin redirects will
*not* carry the spoofed UA — noted as a known limitation in the README rather than
papered over.

**Decision:** 8s `AbortController` timeout, `credentials: 'omit'`, `cache: 'no-store'`,
`redirect: 'follow'`.

**Why:** `credentials: 'omit'` means we fetch as a logged-out crawler does — otherwise
a logged-in session cookie would show content no bot could ever see, inverting the
result. `cache: 'no-store'` avoids scoring a stale cached body.

---

## 3a. Request pacing, and why a 429 is not a block

**Decision:** the pace is **derived from the origin**, not guessed. 400 ms is only the
floor when the site says nothing. HTTP 429 gets its own `throttled` status — it is **not**
in `BLOCKING_STATUSES` — and one retry is made, honouring `Retry-After` up to 10 s.

**There is no rate that is universally safe, and it is worth being clear about why.**
Thresholds are per-site and mostly undocumented, and modern bot management does not work
on rate at all — Cloudflare and Akamai fingerprint the TLS handshake and header ordering
and challenge on identity, not frequency. Nine requests carrying nine different crawler
User-Agents from one residential IP is itself an odd pattern, and no delay makes it look
normal. So rather than pick a number and hope, the pacer reads the three places a site
states its own limit:

| Signal | Where it comes from | Why it beats a constant |
|---|---|---|
| `Crawl-delay` | robots.txt, per user-agent | The site literally declaring the rate it tolerates. Resolved through the *same* group selection as the Allow/Disallow rules, so a bot with its own group does not inherit the `*` delay it does not obey. |
| `RateLimit-Remaining` / `-Reset` | response headers (also `X-RateLimit-*`) | A published budget. When little is left, the remainder of the run is spread across the window the origin says it will reset in. |
| Response latency | measured | Scrapy's AutoThrottle heuristic: a host taking 2 s to answer is loaded and deserves more room than one answering in 40 ms. |

Everything only ever raises the floor. Whichever signal asks for the most space wins.

**Why `Crawl-delay` is capped at 3 s:** sites declare 10 s, 30 s, occasionally 120 s. Nine
crawlers at 30 s is a four-minute run inside a popup that has to stay open — nobody sits
through that, they close it and conclude the tool is broken. Above the cap the run says so
in the UI rather than either silently ignoring the site's stated rate or silently hanging.
A tool that reports on crawler behaviour has no business hiding that about itself.

**Why the pacing:** the tool asks for the same URL once per crawler. With nine crawlers
that is nine requests in well under a second, which is precisely the burst signature rate
limiters exist to catch. The failure mode was not "the check errors" — it was worse than
that. The limiter would let the early bots through and start refusing the later ones, and
because 429 was originally classified as blocking, the report would state that the site's
firewall turns away whichever crawlers happened to be at the end of the sequence. A
confident, specific, entirely fabricated finding, pointing the user at a bot-management
console to hunt for a rule that never existed. The tool would have manufactured the exact
class of error it exists to prevent.

400 ms costs about three seconds across a run and takes the burst below the documented
default of every limiter we could check. Sites stricter than that announce it with a 429,
and the pacing adapts.

**Why the pacer only ever slows down:** a site that limited the third bot has not stopped
limiting by the sixth. Speeding back up after one success just rediscovers the limit, and
the cost lands on a later bot whose result then looks like a block.

**Why 503 is treated differently from 429:** a 503 *with* `Retry-After` is a rate limit; a
503 *without* one is an outage. Calling an outage "throttling" sends the user to the wrong
dashboard, so only the former is retried and reported as throttled.

**What a throttled bot reports:** no score (`null`, not `0`), no cloaking comparison, and a
page-level verdict that leads with **Incomplete** rather than claiming every crawler is
fine. A bot that was never measured must not be counted as readable or unreadable — either
would turn a hole in the data into a finding about the page.

---

## 4. Where each stage runs

| Stage | Runs in | Why |
|---|---|---|
| robots.txt fetch + parse | service worker | Pure string work, no DOM needed. |
| Per-bot raw fetches | service worker | Needs DNR rule swapping; only the worker should hold that. |
| Raw-HTML block extraction | content script | **MV3 service workers have no `DOMParser`.** |
| Diff + scoring | content script | Needs the raw-extracted blocks and the rendered blocks in one place. |
| Cloaking comparison | content script | Same — operates on already-extracted block sets. |
| Framework detection | page MAIN world | `window.__NEXT_DATA__` / `__NUXT__` do not exist in the isolated world. |
| Orchestration | popup | Owns the user gesture, `chrome.scripting`, and the UI. |

**Decision:** Raw HTML strings are passed worker → popup → content script rather than
extracting in the worker.

**Why:** No `DOMParser` in an MV3 service worker. The alternatives were a regex-based
HTML extractor (fragile, wrong on real-world markup) or an offscreen document (an extra
moving part and an extra permission). Passing the string to a context that already has
a real HTML parser is the simplest correct option.

**Decision:** `DOMParser.parseFromString(html, 'text/html')` for raw HTML.

**Why:** It produces an inert document — scripts never execute, subresources never load.
That is *exactly* the semantics we want: it is a faithful model of what a non-JS crawler
sees, and it is safe to run on arbitrary fetched markup.

**Decision:** Engine files (`html-extractor`, `diff`, `cloaking`) are classic scripts
attaching to a `self.AICL` namespace; `robots-parser` is an ES module.

**Why:** The first three are injected with `chrome.scripting.executeScript({files})`,
which loads classic scripts. `robots-parser` is only ever imported by the module-type
service worker. Mixed, but each file uses the one form its single consumer needs, with
no build step to reconcile them — which was a hard requirement.

**Decision:** Popup closing aborts an in-flight check.

**Why:** The popup is the orchestrator. Moving orchestration into the worker to survive
popup closure would need a state machine and message replay for a run that takes ~10s.
The popup shows live progress and warns "keep this popup open" instead.

---

## 5. robots.txt parsing

**Decision:** Full RFC 9309-style parser, not a regex.

Specifics:
- Consecutive `User-agent:` lines form one group header; the first rule line closes it.
- Groups with the same agent token are **merged** (RFC 9309 §2.2.1).
- Agent matching: case-insensitive, the crawler's product token must *start with* the
  record's token; the **longest** matching token wins; `*` is the fallback group and is
  only used when no specific group matches at all.
- Path matching supports `*` (any sequence) and `$` (end anchor).
- Precedence: the **longest matching pattern** wins; on a tie, **`Allow` beats
  `Disallow`**.
- An empty `Disallow:` value means "allow everything" and is skipped as a rule.
- No `robots.txt`, or a 4xx on it, means **allowed** (standard behaviour). A 5xx is
  reported as `unknown` rather than guessed at.

**Why:** The precedence rules are the part everyone gets wrong, and getting them wrong
here produces a false CRITICAL banner — the single most damaging possible error in this
tool. Worth writing properly.

**Decision:** `Google-Extended` and `CCBot` are checked in robots.txt but are **not**
fetched as bots.

**Why:** `Google-Extended` is not a crawler at all — it is a control token for Gemini
and Vertex AI grounding. It has no UA string, so there is nothing to fetch with. It is
surfaced with an explicit note because "we allow Googlebot so we're fine" is the single
most common misconception this tool exists to correct. `CCBot` (Common Crawl) is checked
because Common Crawl feeds several LLM training and retrieval pipelines.

**Decision:** `ClaudeBot` checks both `ClaudeBot` and `anthropic-ai` tokens; the
stricter of the two verdicts wins.

**Why:** Both tokens are in live use in real robots.txt files for Anthropic's crawlers.
Reporting "allowed" when one of the two is disallowed would be misleading.

---

## 6. Block extraction and the diff

**Decision:** Blocks are headings (`h1`–`h6`), `p`, `li`, `td`/`th`, and `blockquote`.

**Why:** These are what an extractive answer engine actually quotes. Divs and spans are
excluded because their text is almost always already covered by a child block, which
would double-count.

**Decision:** Container selection walks an ordered candidate list — `main`,
`[role=main]`, `article`, then a short list of conventional ids and classes
(`#content`, `.entry-content`, …) — taking the densest match at the first selector
that matches anything, and falling back to `<body>`. Independently of that,
`nav`, `header`, `footer`, `aside`, `script`, `style`, `noscript`, `template`,
`[aria-hidden="true"]` and `[hidden]` are excluded by ancestor check. Hidden
elements (`display:none`, `visibility:hidden`, `opacity:0`, zero-size) are excluded
from the rendered capture.

**Why:** Boilerplate is usually server-rendered even on SPAs, so including it inflates
every score toward "fine" and buries the actual finding.

**Decision:** Raw-HTML extraction uses the **same container-selection heuristic** as
the rendered capture, but if the raw document has no meaningful container it falls back
to the whole `<body>`.

**Why:** A CSR shell often has an empty `<div id="root">` and no `<main>` at all.
Falling back to `<body>` makes sure we credit any content that *is* there (e.g. a
`<noscript>` fallback is deliberately excluded, but a server-rendered header is not).

**Decision:** Blocks shorter than 3 characters after normalisation are dropped.

**Why:** Bullets, single digits and stray punctuation match everything and destroy the
signal.

**Decision:** Normalisation = Unicode NFKC → non-breaking/zero-width space removal →
whitespace collapse → trim → lowercase (for the matching key only; the original cased
text is kept for display).

**Why:** Entity encoding (`&nbsp;`, `&#39;`), smart quotes and template whitespace
differ constantly between raw markup and the rendered DOM without any real content
difference. NFKC folds most of that; lowercase folds CSS `text-transform` differences.

**Decision:** Match = exact substring of the joined raw text, else ≥80% token overlap
against any single raw block.

**Why:** Substring alone is too brittle (one injected `<span>` boundary and a genuinely
visible paragraph reads as invisible). Token overlap alone is too loose. Substring first,
overlap as a tolerance band, is the combination that behaves on real pages. Blocks with
fewer than 4 tokens require an exact substring match — at 3 tokens, 80% overlap is
2 of 3 words, which matches unrelated text constantly.

**Decision:** Visibility Score weights headings ×2, everything else ×1.

**Why:** Answer engines lean disproportionately on headings for passage selection and
attribution. A page whose body copy is server-rendered but whose `h2`s are injected by
JS is materially worse off than the unweighted count suggests. Documented in the README
so nobody has to reverse-engineer the number.

**Decision:** Score is `visibleWeight / totalWeight × 100`, rounded to the nearest
integer. A page with zero rendered blocks scores `null`, displayed as `n/a`, not `0`.

**Why:** `0` on an empty page reads as a catastrophic finding when it is actually "no
content to measure".

---

## 6a. The verdict engine — *why*, not just *what*

**Decision:** A separate pure module, `engine/verdict.js`, turns the per-bot
measurements into a plain-English answer to "why can this crawler read my page,
or why can't it?" — evaluated as an ordered **gate chain**, not a score.

**Why a chain and not a number:** crawlability is a sequence of gates a request
has to pass, and **only the first failure is the cause**. A page can be both
disallowed in robots.txt *and* entirely client-rendered. Reporting those as two
equal findings sends someone off to rewrite their frontend when the actual fix is
one line of `robots.txt`. So the gates are evaluated in the order a real request
meets them:

| # | Gate | Failing here means |
|---|---|---|
| 1 | Allowed by robots.txt | The bot never sends a request. Rendering is irrelevant. |
| 2 | Server responds | The bot was refused. A firewall/WAF problem, not a rendering one. |
| 3 | Response is HTML | A warning — crawlers may not extract text from it. |
| 4 | Content present without JavaScript | The content is not in the server's response. |
| 5 | Runs JavaScript | Modifier, not a blocker (see below). |

Gates after the first failure are marked `skip`, not `fail` — they were never
reached, and marking them failed would invent evidence.

**Decision:** Gate 5 is a modifier rather than a gate that can fail the verdict.

**Why:** it is the whole thesis of the tool. The *same* page with the *same*
score is `partial` / warning for Googlebot ("will probably catch up, on a budget
it does not publish") and `not-crawlable` / critical for ClaudeBot ("missing
permanently"). One measurement, two verdicts, because the crawlers differ. A
single severity for both would erase the distinction the product exists to draw.

**Decision:** The "user-agent-specific" claim in a server-block verdict is only
made when the plain-UA baseline got a 200.

**Why:** if the baseline was also refused, the site is down or blocking
everything, and saying "this refusal is specific to GPTBot" would be a fabricated
finding. The verdict function takes the baseline outcome as explicit context
rather than guessing.

**Decision:** Every verdict carries a `fix`, except the `crawlable` case, which
carries `null`.

**Why:** a finding without a next action is a complaint. And a page that is fine
should not be handed busywork — an empty fix field is the honest output there.

**Decision:** The page-level verdict is styled as a neutral card with a
severity-coloured edge, *not* as another red banner.

**Why:** it is the summary, and the CRITICAL banners beneath it are the evidence.
When both were red blocks the popup was a wall of red with no hierarchy and the
answer was indistinguishable from its own supporting detail.

**Decision:** Once the verdict card existed, the older "No score is shown
because…" hint and the overlay panel's duplicate warning were removed.

**Why:** they said the same thing less well. Two explanations of one fact read as
two facts.

---

## 7. Cloaking detection

**Decision:** Compare each bot's raw block set against the **Generic non-JS bot**
baseline using Jaccard distance on normalised block text, threshold **>15%**.
Only compared when both responses are HTTP 200.

**Why:** The Generic baseline is a plain browser UA with no bot token, so it is the
control: any bot-specific divergence from it is by definition user-agent-dependent
serving. Jaccard on a set (rather than a positional diff) tolerates reordering, which
is common with A/B frameworks and is not cloaking.

**Decision:** The finding is phrased as "Possible user-agent-based cloaking detected —
this site may serve different content to different bots", never as an accusation, and
the report repeats that framing.

**Why:** Legitimate causes are common: geo/locale routing, edge A/B tests, bot-specific
caching layers, prerender services (which are in fact the *recommended* fix elsewhere in
this tool). Reporting it as fraud would be wrong and would make the tool untrustworthy.

**Decision:** When all bots agree, say so explicitly: "No cloaking detected — all bots
receive the same raw HTML."

**Why:** A silent absence of a warning is indistinguishable from a check that did not run.

---

## 7a. The visual system, derived from the mark

**Decision:** The icon is *dissolve* — a solid mass decaying into scattered squares —
and the UI is built from that idea rather than merely painted in its colours.

**Decision:** Neutrals carry a warm bias (`#1a1512` ink, `#6b615a` muted, `#e8e1db`
rules; `#14100e` ground in dark).

**Why:** the accent is vermilion. A blue-grey neutral beside it reads as two unrelated
products sharing a window. Nothing else changed but the temperature, and the whole thing
stopped looking assembled.

**Decision:** `--brand` (`#e93e12`) means exactly one thing: **content the machine cannot
see.** It is the mark's colour, the overlay highlight colour, and the critical colour,
because in this product those are the same fact. Controls — the Check button, a selected
tab — use `--accent`, which is ink.

**Why:** if the alarm colour is also the button colour, it is furniture, and it stops
meaning anything. The most valuable property of a warning colour is that it is rare.

**Decision:** `--amber` is pushed toward ochre (`#8a5a00`) rather than a conventional
amber.

**Why:** a normal amber sits close enough to vermilion to read as a weaker version of it,
which would blur the line between "at risk of not being rendered" and "cannot be seen at
all" — the single distinction the verdict engine exists to draw.

**Decision: the block strip.** One square per content block, in document order: solid ink
where the block reached the crawler, a shrunken vermilion square where it did not.

**Why this is not decoration:** it is the icon's metaphor rendered from real data, and it
carries information the score cannot. Document order shows *where* a page comes apart. A
page that is solid and then decays looks like the mark and is a lazy-loaded tail; a page
speckled with gaps throughout is a hydration problem. Both can score 24.

**Decision:** invisible blocks are drawn **shrunken, not faded**.

**Why:** at 9px, opacity is indistinguishable from antialiasing — it reads as a rendering
artefact. A smaller solid square reads as loss.

**Decision:** the popup header renders `../icons/icon128.png` rather than reproducing the
mark in CSS.

**Why:** the header previously drew its own copy of the old icon in gradients. Changing
the icon would have left the header showing the previous mark with nothing failing. A
second copy of a logo is a bug waiting for a redesign.

---

## 8. Overlay

**Decision:** A single `position: fixed` host element with `pointer-events: none` and a
closed-ish Shadow DOM (`mode: 'open'`, but all styling scoped inside), holding absolutely
positioned boxes drawn over each block's `getBoundingClientRect()`.

**Why:** The hard requirement is that the page is byte-identical when the overlay is
dismissed. Adding classes or outlines to real elements can trigger `MutationObserver`s,
CSS transitions, layout shifts and framework re-renders. Drawing *over* the page touches
nothing. Removing the host element restores the page exactly.

**Decision:** Positions are recomputed on `scroll` and `resize`, rAF-throttled, plus a
`ResizeObserver` on `document.documentElement`.

**Why:** Fixed-position boxes over a scrolling page need re-projection every frame the
page moves. rAF throttling keeps it from being a jank source.

**Decision:** The on-page panel is draggable and lives in the same shadow root, with
`pointer-events: auto` re-enabled only on the panel itself.

**Why:** The panel must be clickable while the highlight layer must never intercept
clicks meant for the page.

---

## 9. Bot list

**Decision:** Nine fetched bots. `Google-Extended` and `CCBot` are robots.txt-only.

**The rule for earning a row:** a crawler is only worth fetching if it can produce a
*different answer* from the Generic baseline. Absent cloaking every non-JS crawler
receives byte-identical HTML, so rendering alone never justifies a row. Two things do —
a distinct `robots.txt` product token, and a distinct User-Agent a server may treat
differently.

That is why `OAI-SearchBot`, `ChatGPT-User` and `Perplexity-User` were added after the
first release. **GPTBot is training-data crawling; OAI-SearchBot builds the index behind
ChatGPT search.** Disallowing one while allowing the other is common and reasonable, and
doing it by accident is common too. Checking only GPTBot answers the wrong question — the
same mistake as checking only Googlebot and missing Google-Extended.

**Why:** These are what the brief specified and they cover the meaningfully distinct
behaviours: one JS-executing crawler (Googlebot), one JS-executing crawler with a
different budget (Bingbot), three raw-HTML-only AI crawlers, and a control. Adding more
bot names would add rows without adding information, since the raw-HTML result is
identical for every non-JS crawler absent cloaking — and the Generic baseline already
represents all of them.

**Decision:** UA strings are stored in `data/bot-user-agents.js` with a
`lastVerified` date and a source URL per entry.

**Why:** UA strings drift. Keeping them in one annotated file with provenance makes the
maintenance job obvious instead of archaeological.

---

## 10. Unspecified items — defaults chosen

| Item | Default chosen | Rationale |
|---|---|---|
| Extension version | `1.0.0` | First shippable build. |
| `minimum_chrome_version` | `116` | Floor for `world: 'MAIN'` in `executeScript` plus stable dynamic-DNR header rules. |
| History size | 20 entries, `chrome.storage.local` | Brief said "last 20". Local, not sync — audit history is not something to replicate across a user's devices silently. |
| History entry contents | URL, title, timestamp, lowest bot score, count of robots-blocked bots, cloaking flag | Enough to re-recognise a check without storing page content. **No page text is ever persisted.** |
| Export filename | `ai-crawlability-<hostname>-<YYYY-MM-DD>.html` | Sortable, obvious in a Downloads folder. |
| Export mechanism | `Blob` + object URL + synthetic `<a>` click | Avoids needing the `downloads` permission. |
| Invisible-block excerpts in report | First 30 blocks per bot, 300 chars each | A full dump of a large page produces an unusable multi-megabyte report. Truncation is stated in the report itself, never silent. |
| Score colour bands | red `<40`, amber `40–75`, green `>75` | As specified in the brief. Exactly 75 is amber; exactly 40 is amber. |
| Dark mode | `prefers-color-scheme` in both popup and overlay | Brief required dark-mode awareness; following the OS is the least surprising behaviour. |
| Non-HTTP(S) pages | Button disabled with an explanation | `chrome://`, `file://`, the Web Store and PDF viewers cannot be scripted or fetched. Better to say so than to fail opaquely. |
| Popup opened without `activeTab` (e.g. as a tab) | Button disabled, explains to use the toolbar icon | Chrome withholds `tab.url` until the extension has access to that tab. Clicking the action grants `activeTab`, which is the normal path; anything else needs saying out loud rather than reading as "no tab". |
| Fetch of a non-200 page | Still diffed if a body came back | A soft-404 or a 500 with a rendered body is a real finding, not a reason to bail. |
| Concurrency | Strictly sequential | See §3. |

---

## 11. Privacy

**Decision:** Zero telemetry, zero analytics, zero external endpoints. The only network
requests are: `<page URL>` (once per bot) and `<origin>/robots.txt` (once) — all to the
site the user is already on, all triggered by an explicit click.

**Decision:** Nothing but the history metadata in §10 is written to storage. Page text,
raw HTML and diff results live in memory for the life of the popup and are then gone.

**Why:** The user is pointing this at client sites and staging environments under NDA.
Anything else would be indefensible.

---

## 12. Verification

The build was verified against real Chromium, not just reasoned about. See the
README's "Acceptance tests" section for what was run and what it proved. The three
findings worth recording here:

1. **The DNR User-Agent swap genuinely works.** This was the riskiest assumption in
   the design — `fetch()` silently drops a `User-Agent` header, so if the DNR rule had
   not applied, every bot row would have been identical and *plausible*. It was tested
   by pointing the extension at a local HTTP server that echoes the received
   `User-Agent` back into the page body: all six bots received distinct, correct UA
   strings, and the requests arrived strictly in order.

2. **Chrome withholds `tab.url` without a grant.** Discovered during testing: opening
   the popup without the `activeTab` grant leaves `tab.url` undefined, which the first
   implementation reported as "No active tab to check." — technically true, actively
   misleading. Now handled with its own message. See §10.

3. **A block can be invisible for a legitimate reason.** The test fixture echoed the
   requesting User-Agent into the page, so that one paragraph correctly showed up as
   invisible to every bot — the rendered page carried the browser's UA, each raw fetch
   carried the bot's. Not a bug: exactly the UA-dependent content the tool is built to
   surface, caught at block level rather than only at the cloaking-summary level.
