/**
 * tools/build-icon-sheet.js
 *
 * Builds a self-contained comparison sheet for the icon concepts in
 * docs/icon-concepts/. Every PNG is inlined as a data URI so the page has no
 * external references and can be published or emailed as one file.
 *
 * Usage:  node tools/build-icon-sheet.js <output.html>
 *
 * Each concept is shown at all four shipped sizes, and — the part that actually
 * decides it — pinned in mock light and dark browser toolbars at true 16px,
 * which is where a Chrome action icon really lives.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const CONCEPTS_DIR = path.join(ROOT, 'docs', 'icon-concepts');
const SHIPPED_DIR = path.join(ROOT, 'ai-crawlability-lens', 'icons');
const args = process.argv.slice(2);
const OUT = args.find((a) => !a.startsWith('--')) || path.join(ROOT, 'docs', 'icon-sheet.html');

/**
 * `--only=a,b,c` restricts the sheet to those concept slugs, in that order.
 * Without it every directory is shown. Once a round has been rejected there is
 * no value in re-showing it alongside its replacement — it just makes the
 * comparison harder.
 */
const onlyArg = args.find((a) => a.startsWith('--only='));
const ONLY = onlyArg ? onlyArg.slice('--only='.length).split(',').map((s) => s.trim()).filter(Boolean) : null;

/** `--no-current` drops the shipped icon from the sheet. */
const SHOW_CURRENT = !args.includes('--no-current');

/** Every size the manifest ships. */
const SIZES = [16, 32, 48, 128];

/**
 * Sizes shown in the sample row. 128 is excluded because it is already the
 * hero — repeating it there both duplicates information and overflows the row,
 * since a 128px image cannot sit in a row sized for a 48px one.
 */
const ROW_SIZES = [16, 32, 48];

/** @param {string} file @returns {string|null} */
function dataUri(file) {
  if (!fs.existsSync(file)) return null;
  return 'data:image/png;base64,' + fs.readFileSync(file).toString('base64');
}

/** Human-readable name from a directory slug. */
function titleFor(slug) {
  return slug.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

function collect() {
  const out = [];

  // The icon currently in the manifest, as the incumbent to beat.
  const shipped = {};
  let shippedOk = true;
  for (const s of SIZES) {
    const uri = dataUri(path.join(SHIPPED_DIR, `icon${s}.png`));
    if (!uri) shippedOk = false;
    shipped[s] = uri;
  }
  if (shippedOk && SHOW_CURRENT) {
    out.push({ slug: 'current', title: 'Current (shipped)', incumbent: true, icons: shipped });
  }

  if (!fs.existsSync(CONCEPTS_DIR)) return out;

  const slugs = ONLY || fs.readdirSync(CONCEPTS_DIR).sort();

  for (const slug of slugs) {
    const dir = path.join(CONCEPTS_DIR, slug);
    if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) continue;

    const icons = {};
    let ok = true;
    for (const s of SIZES) {
      const uri = dataUri(path.join(dir, `icon${s}.png`));
      if (!uri) ok = false;
      icons[s] = uri;
    }
    if (!ok) {
      console.warn(`skipping ${slug} — missing one or more sizes`);
      continue;
    }
    out.push({ slug, title: titleFor(slug), incumbent: false, icons });
  }

  return out;
}

/** @param {string} s */
const esc = (s) =>
  String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function build(concepts, notes) {
  const cards = concepts
    .map((c) => {
      const note = notes[c.slug];
      return `
    <article class="concept" id="${esc(c.slug)}">
      <header class="concept-head">
        <h2>${esc(c.title)}${c.incumbent ? '<span class="tag">in the manifest today</span>' : ''}</h2>
      </header>

      <div class="showcase">
        <figure class="hero-fig">
          <img class="hero" src="${c.icons[128]}" alt="${esc(c.title)} at 128 pixels" width="128" height="128">
          <figcaption>128px</figcaption>
        </figure>
        <div class="sizes">
          ${ROW_SIZES.map(
            (s) => `<figure>
              <div class="cell"><img src="${c.icons[s]}" alt="${esc(c.title)} at ${s} pixels" width="${s}" height="${s}"></div>
              <figcaption>${s}px</figcaption>
            </figure>`
          ).join('')}
        </div>
      </div>

      <div class="toolbars">
        <div class="toolbar light">
          <span class="tb-dots"><i></i><i></i><i></i></span>
          <span class="tb-omni">northwind.example/blog</span>
          <img src="${c.icons[16]}" alt="" width="16" height="16">
          <span class="tb-label">light</span>
        </div>
        <div class="toolbar dark">
          <span class="tb-dots"><i></i><i></i><i></i></span>
          <span class="tb-omni">northwind.example/blog</span>
          <img src="${c.icons[16]}" alt="" width="16" height="16">
          <span class="tb-label">dark</span>
        </div>
      </div>

      ${note ? `<div class="note">${note}</div>` : ''}
    </article>`;
    })
    .join('\n');

  return `<title>AI Crawlability Lens — icon concepts</title>
<style>
  :root {
    --bg:#f2f4f7; --surface:#fff; --surface-2:#f7f8fa; --ink:#10131a; --muted:#5b6472;
    --line:#dee2e9; --accent:#4f46e5;
    --sans: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
    --mono: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  }
  @media (prefers-color-scheme: dark) {
    :root { --bg:#0a0c10; --surface:#12151c; --surface-2:#171b23; --ink:#e7eaf0;
            --muted:#8c96a6; --line:#242b36; --accent:#8b85ff; }
  }
  :root[data-theme="light"] { --bg:#f2f4f7; --surface:#fff; --surface-2:#f7f8fa; --ink:#10131a;
                              --muted:#5b6472; --line:#dee2e9; --accent:#4f46e5; }
  :root[data-theme="dark"] { --bg:#0a0c10; --surface:#12151c; --surface-2:#171b23; --ink:#e7eaf0;
                             --muted:#8c96a6; --line:#242b36; --accent:#8b85ff; }

  * { box-sizing: border-box; }
  body { margin:0; background:var(--bg); color:var(--ink); font-family:var(--sans);
         font-size:15px; line-height:1.6; -webkit-font-smoothing:antialiased; }
  .shell { max-width:1180px; margin:0 auto; padding:34px 22px 72px; }

  .eyebrow { font-family:var(--mono); font-size:11.5px; letter-spacing:.14em;
             text-transform:uppercase; color:var(--accent); margin:0 0 12px; }
  h1 { font-size:clamp(26px,3.6vw,38px); line-height:1.12; letter-spacing:-.028em;
       font-weight:680; margin:0 0 14px; text-wrap:balance; max-width:22ch; }
  .lede { font-size:16.5px; color:var(--muted); max-width:64ch; margin:0 0 8px; }
  .lede strong { color:var(--ink); font-weight:620; }
  header.page-head { padding-bottom:26px; margin-bottom:30px; border-bottom:1px solid var(--line); }

  .grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(330px,1fr)); gap:20px; }

  .concept { background:var(--surface); border:1px solid var(--line); border-radius:12px;
             padding:18px 20px 20px; }
  .concept-head h2 { font-size:16px; letter-spacing:-.015em; margin:0 0 16px;
                     display:flex; align-items:center; gap:9px; flex-wrap:wrap; }
  .tag { font-family:var(--mono); font-size:9.5px; letter-spacing:.07em; text-transform:uppercase;
         font-weight:600; color:var(--muted); border:1px solid var(--line);
         border-radius:999px; padding:2px 8px; }

  .showcase { display:flex; gap:22px; align-items:flex-end; flex-wrap:wrap; }
  .hero-fig { margin:0; text-align:center; flex:none; }
  .hero { border-radius:14px; display:block; image-rendering:auto; }
  .hero-fig figcaption { font-family:var(--mono); font-size:9.5px; color:var(--muted);
                         letter-spacing:.06em; margin-top:5px; }
  .sizes { display:flex; gap:14px; align-items:flex-end; flex-wrap:wrap; }
  .sizes figure { margin:0; text-align:center; }
  .sizes .cell { height:52px; display:grid; place-items:center; }
  .sizes img { image-rendering:auto; }
  .sizes figcaption { font-family:var(--mono); font-size:9.5px; color:var(--muted);
                      letter-spacing:.06em; margin-top:5px; }

  .toolbars { display:flex; flex-direction:column; gap:7px; margin-top:18px; }
  .toolbar { display:flex; align-items:center; gap:9px; padding:6px 9px; border-radius:8px;
             border:1px solid var(--line); font-size:11px; }
  .toolbar.light { background:#f1f3f4; color:#5f6368; border-color:#dadce0; }
  .toolbar.dark  { background:#292a2d; color:#9aa0a6; border-color:#3c4043; }
  .tb-dots { display:flex; gap:3px; }
  .tb-dots i { width:6px; height:6px; border-radius:50%; background:currentColor;
               opacity:.45; display:block; }
  .tb-omni { flex:1; min-width:0; font-family:var(--mono); font-size:10px;
             background:rgba(128,128,128,.16); border-radius:999px; padding:2px 9px;
             white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  .tb-label { font-family:var(--mono); font-size:9px; letter-spacing:.08em;
              text-transform:uppercase; opacity:.7; }

  .note { margin-top:16px; padding-top:14px; border-top:1px solid var(--line);
          font-size:13.5px; color:var(--muted); }
  .note b { color:var(--ink); font-weight:620; }
  .note p { margin:0 0 8px; }
  .note p:last-child { margin-bottom:0; }

  footer.page-foot { margin-top:38px; padding-top:18px; border-top:1px solid var(--line);
                     color:var(--muted); font-size:12.5px; }
  footer.page-foot b { color:var(--ink); }
  footer code { font-family:var(--mono); font-size:.92em; }
</style>

<div class="shell">
  <header class="page-head">
    <p class="eyebrow">AI Crawlability Lens · icon concepts</p>
    <h1>Round two: no tile, no gradient, no stock glyph</h1>
    <p class="lede">
      The first round came back as one icon with four different stickers — a rounded square,
      a blue-to-purple gradient, a stock glyph in the middle. So this round bans the container,
      the gradient, and the four glyphs that caused it. Every mark below is full-bleed and
      single-ink.
    </p>
    <p class="lede">
      Each is a real generated PNG set, not a sketch. <strong>Judge them in the toolbar
      strips</strong>, not by the 128px hero: a Chrome action icon lives at 16px, and that is
      where icon ideas quietly fall apart.
    </p>
  </header>

  <div class="grid">
${cards}
  </div>

  <footer class="page-foot">
    <b>To adopt one:</b> copy its four PNGs over <code>ai-crawlability-lens/icons/</code>.
    The manifest already points at <code>icon16/32/48/128.png</code>, so nothing else changes.
    Generators live in <code>tools/icon-concepts/</code> and are dependency-free — re-run one to
    tweak a colour or proportion.
  </footer>
</div>
`;
}

/* -------------------------------------------------------------------------- */

const NOTES_FILE = path.join(CONCEPTS_DIR, 'notes.json');
const notes = fs.existsSync(NOTES_FILE) ? JSON.parse(fs.readFileSync(NOTES_FILE, 'utf8')) : {};

const concepts = collect();
if (!concepts.length) {
  console.error('No icon concepts found in ' + CONCEPTS_DIR);
  process.exit(1);
}

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, build(concepts, notes));
console.log(`${concepts.length} concept(s) -> ${OUT}`);
for (const c of concepts) console.log('  ' + c.slug);
