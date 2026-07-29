# tools

Asset generators. None of this is part of the extension — `ai-crawlability-lens/`
loads unpacked without any of it, and there is no build step.

## The shipped icon

The mark is **dissolve**: a solid vermilion mass whose right edge comes apart into
discrete squares that thin out and stop before the far edge. Coherent matter, serrated
edge, scatter, void.

Regenerate it in place:

```bash
node tools/icon-concepts/dissolve.js ai-crawlability-lens/icons
```

That writes `icon16/32/48/128.png`, which is exactly what `manifest.json` points at.

The popup renders `../icons/icon128.png` directly rather than reproducing the mark in
CSS, so changing the icon changes the popup header too — there is no second copy to
keep in sync.

### Why it is that colour

Not taste. The luminance band that clears 3:1 contrast against **both** Chrome toolbar
greys — `#f1f3f4` light and `#292a2d` dark — is only about Y 0.17–0.28. Every tone in
the mark is pinned near Y=0.213, so the hue travels from vermilion `#E93E12` to burnt
orange `#D26516` while the contrast does not move: 3.36–3.65:1 on light, 3.53–3.84:1 on
dark.

This is also why all four second-round concepts came back warm. It was the constraint
choosing, not the designers.

## Files

| Path | What it is |
|---|---|
| `icon-concepts/dissolve.js` | **Canonical.** Generates the shipped icon. |
| `icon-concepts/*.js` | The other candidates, kept as a record. Each is self-contained. |
| `build-icon-sheet.js` | Builds the comparison sheet. `--only=a,b,c` and `--no-current` select a subset. |
| `make-icons.js` | Superseded — draws the original lens mark. Kept as the clearest copy of the PNG encoder. |
| `package.js` | Builds the Web Store upload zip, and refuses to build one that would fail review. |
| `make-store-shots.js` | Composes the 1280×800 Store screenshots from the real captured UI. Needs Playwright. |
| `build-pages.js` | Builds the GitHub Pages site — homepage and the public privacy policy. Dependency-free. |

Every generator is dependency-free: a manual PNG encoder built on `zlib` with
hand-written chunks and CRCs, drawing at 4× and box-downsampling. There is no canvas
library available, and adding one for four icons was not a trade worth making.

## Packaging for the Store

```bash
node tools/package.js          # -> dist/ai-crawlability-lens-<version>.zip
node tools/make-store-shots.js # -> docs/store/*.png at 1280x800
node tools/build-pages.js      # -> docs/index.html, docs/privacy.html
```

The Store wants a privacy policy at a public URL rather than a repo file, and that URL has
to keep saying the same thing as `PRIVACY.md` indefinitely. So `build-pages.js` generates
`docs/privacy.html` *from* `PRIVACY.md` — one source, no second copy to keep in sync, the
same reason the popup renders `icon128.png` instead of redrawing the mark in CSS. The
markdown subset it implements covers exactly what `PRIVACY.md` uses and nothing more.

`package.js` zips the extension directory contents only — tests, docs and generators are
development artefacts, and every extra file is another thing a reviewer has to account
for. It aborts if the manifest points at a missing file, the description exceeds the
Store's 132-character cap, static `host_permissions` have reappeared, or anything looks
like remote code. Those are all rejections, and they are far cheaper to catch here than
after a week in the review queue.

See [`../SHIPPING.md`](../SHIPPING.md) for the rest.

## Verifying an icon

Do not judge one at 128px. Rebuild the sheet and look at the toolbar strips:

```bash
node tools/build-icon-sheet.js docs/icon-sheet.html
```

A Chrome action icon lives at 16px on a toolbar whose background you do not control.
Grid-align every edge to 1/16 of the canvas so 16px lands on whole pixels — `dissolve`
has zero partially-covered pixels at 16px, which is why it stays crisp.
