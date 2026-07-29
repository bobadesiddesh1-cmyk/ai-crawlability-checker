# Taking it live

The code is done and merged. What remains is distribution, and most of it needs an
account only you can open.

There are two honest routes. Pick one.

---

## Route A — Chrome Web Store (public listing)

The real distribution path. Budget **1–3 weeks**, most of it waiting on review.

### Ready in this repo

| Artefact | Where | Status |
|---|---|---|
| Upload package | `node tools/package.js` → `dist/ai-crawlability-lens-1.0.0.zip` | ✅ 30 files, 95 KB, verified to load |
| Screenshots (1280×800) | `docs/store/*.png` | ✅ three, composed from the real UI |
| Icon (128×128) | `ai-crawlability-lens/icons/icon128.png` | ✅ |
| Privacy policy | [`PRIVACY.md`](PRIVACY.md) | ✅ written, **needs a public URL** |
| Listing copy | [`ai-crawlability-lens/README.md`](ai-crawlability-lens/README.md#chrome-web-store-listing-draft) | ✅ description, single purpose, permission justifications |

`tools/package.js` refuses to build if the manifest points at a missing file, the
description exceeds the Store's 132-character cap, static `host_permissions` have crept
back in, or anything looks like remote code — all of which are review rejections that are
cheaper to catch here than in a queue.

### What only you can do

1. **Register** at the [developer dashboard](https://chrome.google.com/webstore/devconsole).
   One-time **$5** fee, and identity verification.
2. **Host the privacy policy.** The Store demands a public URL, not a repo file. Simplest:
   enable **GitHub Pages** on this repo (Settings → Pages → deploy from `main`), then use
   `https://bobadesiddesh1-cmyk.github.io/ai-crawlability-checker/PRIVACY`.
3. **Upload** the zip, paste the listing copy, attach the three screenshots.
4. **Fill in the permission justifications** — the dashboard asks per permission. The
   README has the text. The one reviewers actually stop on:

   > `declarativeNetRequest` sets the `User-Agent` header on the extension's own fetches,
   > which `fetch()` cannot do. The rule is scoped with `initiatorDomains: [extension id]`
   > and `resourceTypes: ['xmlhttprequest']`, so it can only match requests this extension
   > itself makes — never the user's browsing, another tab, or another extension. Nothing
   > is blocked, redirected or upgraded.

5. **Submit** and wait.

### Where review is likely to snag

- **`optional_host_permissions: <all_urls>`** still draws scrutiny even though it is
  optional. The mitigation is already built: access is requested **per origin at click
  time**, never at install. Say so plainly in the justification field.
- **User-Agent modification** looks like spoofing until someone reads the scope. Lead with
  `initiatorDomains`.
- **Unverified UA strings.** `ClaudeBot` and `Bingbot` are from observed traffic, not a
  quotable vendor page — noted in `data/bot-user-agents.js`. Not a review risk, but do not
  claim in the listing that every string is vendor-confirmed, because two are not.

---

## Route B — internal / agency use (skip the Store)

If this is for your team and your clients rather than the public, the Store buys you
nothing but a review queue.

- **Unpacked:** clone, `chrome://extensions` → Developer mode → Load unpacked. Zero
  friction, and updates are a `git pull`.
- **Managed install:** for a whole team, host the zip and push it via Chrome Enterprise
  policy (`ExtensionInstallForcelist`). Needs managed Chrome.

Route B costs nothing and can happen today. **It is also the better first move regardless**
— use it on real client sites for a week, and let that decide whether Route A is worth the
queue.

---

## Before either route

**Run it against your own sites.** It has been field-tested against Wikipedia, react.dev
and github.com through a relay, which found and fixed a real bug — but a relay cannot
reproduce a CDN, a consent wall, or a bot-management rule. Those are exactly what this
tool is looking at. Three or four real client sites will teach you more than any further
work in this repo.

## Version bumps

`manifest.json` `version` is the only source of truth; `tools/package.js` reads it and
names the zip from it. Bump it before every upload — the Store rejects a version it has
already seen.
