# Taking it live

Everything the Chrome Web Store asks for now exists in this repo. What follows is the
submission runbook.

There is exactly **one** thing that cannot be done from a commit, and it is a repo
setting: turning on GitHub Pages, so the privacy policy has a public URL.

---

## Step 1 — Turn on Pages (2 minutes, once)

**Settings → Pages → Source: Deploy from a branch → `main` / `/docs` → Save.**

That publishes the site already generated in `docs/`:

| URL | What it is |
|---|---|
| `https://bobadesiddesh1-cmyk.github.io/ai-crawlability-checker/` | Homepage — the listing's **Website** field |
| `.../privacy.html` | **Privacy policy** — the field that blocks submission |
| `.../ui-demo.html` | Interactive UI walkthrough, if you want a demo link |

Give it a minute, then load `/privacy.html` and confirm it renders — the Store validates
that the URL actually resolves.

`docs/privacy.html` is **generated from `PRIVACY.md`** by `node tools/build-pages.js`, so
the public policy and the repo policy cannot drift apart. Edit the markdown, rebuild,
commit. `docs/.nojekyll` stops GitHub reprocessing any of it.

## Step 2 — Build the package

```bash
node tools/package.js          # -> dist/ai-crawlability-lens-1.0.0.zip
```

30 files, ~95 KB, manifest at the archive root. It **refuses to build** a package that
would be rejected: manifest pointing at a missing file, description over the
132-character cap, static `host_permissions` reappearing, or anything resembling remote
code. Those are all rejections, and they are far cheaper to catch here than after a week
in a queue.

## Step 3 — Fill the listing

Paste-ready in
[`ai-crawlability-lens/README.md`](ai-crawlability-lens/README.md#chrome-web-store-listing-draft).

| Field | Value |
|---|---|
| Name | AI Crawlability Lens |
| Category | Developer Tools |
| Short description | pre-filled from `manifest.json` on upload — 126 chars, under the cap |
| Detailed description | in the README |
| Screenshots | `docs/store/*.png` — three, 1280×800 |
| Icon | `ai-crawlability-lens/icons/icon128.png` |
| Website | the Pages homepage from step 1 |
| Privacy policy URL | the Pages `/privacy.html` from step 1 |
| Single purpose | in the README |

**Data usage:** tick nothing in the collection list, then tick all three certification
boxes — no sale of data, no use unrelated to the single purpose, no creditworthiness
determination. All three are true here, and an unticked box stalls the submission without
explaining why.

## Step 4 — Permission justifications

The dashboard asks per permission, and this is where review actually stalls. All five are
in the README verbatim. The one reviewers stop on:

> `declarativeNetRequest` sets the `User-Agent` header on the extension's own fetches,
> which `fetch()` cannot do. The rule is scoped with `initiatorDomains: [extension id]`
> and `resourceTypes: ['xmlhttprequest']`, so it can only match requests this extension
> itself makes — never the user's browsing, another tab, or another extension. Nothing is
> blocked, redirected or upgraded.

Lead with the **scope**, not the purpose. "I set the User-Agent header" reads as spoofing
right up until the sentence that says what it can and cannot touch.

For host access, say the mitigation out loud rather than leaving a reviewer to infer it:
`optional_host_permissions: <all_urls>` draws scrutiny even though it is optional, and the
answer is that access is requested **per origin at click time**, never at install.

---

## Where it can still snag

- **Unverified UA strings.** `ClaudeBot` and `Bingbot` come from observed traffic, not a
  quotable vendor page — noted in `data/bot-user-agents.js`. Not a review risk in itself,
  but do not write "every User-Agent is vendor-confirmed" in the listing, because two are
  not.
- **Review time** is the real cost: days to about three weeks, and an extension that
  touches request headers and asks for broad host access lands on the slower path. Nothing
  in the package changes that.

## Route B — skip the Store entirely

If this is for your team and your clients rather than the public, the Store buys you a
review queue and little else.

- **Unpacked:** clone, `chrome://extensions` → Developer mode → Load unpacked. Updates are
  a `git pull`.
- **Managed install:** host the zip and push it via Chrome Enterprise policy
  (`ExtensionInstallForcelist`). Needs managed Chrome.

This costs nothing and works today. **It is also the better first move regardless** — run
it on real client sites for a week before spending a review cycle.

## Before either route

**Run it against your own sites.** It has been field-tested against Wikipedia, react.dev
and github.com through a relay, which found and fixed a real bug — but a relay cannot
reproduce a CDN, a consent wall, or a bot-management rule. Those are exactly what this
tool exists to look at. Three or four real client sites will teach you more than any
further work in this repo.

## Version bumps

`manifest.json` `version` is the only source of truth; `tools/package.js` reads it and
names the zip from it. Bump it before every upload — the Store rejects a version it has
already seen.
