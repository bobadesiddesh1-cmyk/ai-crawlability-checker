# AI Crawlability Lens

Googlebot renders your JavaScript. GPTBot, PerplexityBot and ClaudeBot don't.

A Chrome extension that fetches your page exactly as each AI crawler sees it — raw and
unrendered — and shows you what content is invisible to AI search engines, whether
you're blocked in `robots.txt`, and whether your site serves different content to
different bots. 100% local; no account, no server, no data leaves the browser.

**→ [`ai-crawlability-lens/`](ai-crawlability-lens) — the extension. Install and full
documentation in [its README](ai-crawlability-lens/README.md).**

Load it unpacked at `chrome://extensions`. No build step, no dependencies.

## Repository layout

| Path | What it is |
|---|---|
| [`ai-crawlability-lens/`](ai-crawlability-lens) | The extension. This folder is what you load unpacked. |
| [`ai-crawlability-lens/DECISIONS.md`](ai-crawlability-lens/DECISIONS.md) | Every non-obvious design choice and why it was made. |
| [`tests/`](tests) | Verification suites — 184 assertions, including a real-Chromium end-to-end run. Not part of the extension package. |
| [`tools/make-icons.js`](tools/make-icons.js) | One-off generator for the icon PNGs. |
| [`docs/screenshots/`](docs/screenshots) | UI screenshots, captured from the real extension against a demo fixture site. |

![Popup results](docs/screenshots/popup-results.png)
