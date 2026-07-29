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

Every generator is dependency-free: a manual PNG encoder built on `zlib` with
hand-written chunks and CRCs, drawing at 4× and box-downsampling. There is no canvas
library available, and adding one for four icons was not a trade worth making.

## Verifying an icon

Do not judge one at 128px. Rebuild the sheet and look at the toolbar strips:

```bash
node tools/build-icon-sheet.js docs/icon-sheet.html
```

A Chrome action icon lives at 16px on a toolbar whose background you do not control.
Grid-align every edge to 1/16 of the canvas so 16px lands on whole pixels — `dissolve`
has zero partially-covered pixels at 16px, which is why it stays crisp.
