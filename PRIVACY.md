# Privacy Policy — AI Crawlability Lens

**Last updated:** 29 July 2026

## The short version

AI Crawlability Lens collects nothing, transmits nothing, and has no server.

There is no account, no analytics, no telemetry, no crash reporting, no advertising
identifier, and no third-party SDK of any kind. The extension has no backend to send data
to, because none was built.

## What data the extension handles

When you click **Check AI bot visibility on this page**, the extension:

1. Reads the content of the page you are currently viewing, in your browser.
2. Fetches that same page URL several times — once per crawler — and fetches the site's
   `/robots.txt`.
3. Compares the two locally and displays the result.

All of this happens inside your browser. The page content, the fetched HTML, and the
comparison exist only in memory for the life of the popup and are discarded when it
closes.

## What is stored on your device

One thing: a history of your last 20 checks, in `chrome.storage.local`. Each entry
contains:

- the URL checked
- the page title
- a timestamp
- the lowest Visibility Score and which crawler it belonged to
- how many crawlers were blocked in `robots.txt`
- whether a cloaking difference was flagged

**No page text, no excerpts, and no fetched HTML are ever stored.** The history never
leaves your device — `chrome.storage.local`, not `chrome.storage.sync`, specifically so
it is not replicated across your devices. You can erase it at any time with **Clear all**
in the popup.

## Network requests

The extension makes requests to exactly two things, and only after you click Check:

- the page you are currently viewing
- that site's `/robots.txt`

Nothing else. No request is ever made to any server operated by the developer, because
there isn't one. Requests are sent with `credentials: 'omit'`, so your cookies and
session are never included.

## Permissions, and why each exists

| Permission | Why |
|---|---|
| `storage` | The 20-entry local history described above. |
| `activeTab` | To read the current tab's URL when you click the extension. |
| `scripting` | To run the analysis inside the page being checked. |
| `declarativeNetRequest` | To set the `User-Agent` header on the extension's own fetches. `User-Agent` cannot be set through `fetch()`. The rule is scoped with `initiatorDomains: [extension id]` and can only affect requests this extension itself makes — never your browsing, never another tab, never another extension. |
| Host access | Requested **per site, at the moment you click Check** — never at install time, and never for all sites. Checking `example.com` grants access to `example.com` and nothing else. Revoke it from the popup footer or `chrome://extensions` at any time. |

## The exported report

**Export HTML report** writes a file to your Downloads folder. It is generated entirely
in your browser and is fully self-contained — no external stylesheets, fonts, scripts or
images. Opening it makes zero network requests. It is yours; nothing is uploaded.

## Children

The extension is a developer tool. It is not directed at children and collects no data
from anyone, of any age.

## Changes

Any change to this policy will be committed to this repository, so the full history is
public and diffable.

## Contact

Open an issue at
<https://github.com/bobadesiddesh1-cmyk/ai-crawlability-checker/issues>.
