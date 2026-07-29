/**
 * tools/build-pages.js
 *
 * Builds the GitHub Pages site in docs/ — the public homepage and the public
 * privacy policy.
 *
 *     node tools/build-pages.js
 *
 * The Chrome Web Store wants a privacy policy at a public URL, not a repo file.
 * That URL has to say the same thing as PRIVACY.md forever, so PRIVACY.md is the
 * single source and docs/privacy.html is generated from it. There is no second
 * copy to keep in sync — the same reason the popup renders icon128.png rather
 * than redrawing the mark in CSS.
 *
 * Dependency-free. The markdown subset below covers exactly what PRIVACY.md
 * uses; it is not a general-purpose renderer and does not pretend to be.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const DOCS = path.join(ROOT, 'docs');

const REPO = 'https://github.com/bobadesiddesh1-cmyk/ai-crawlability-checker';

/* ------------------------------------------------------------------ */
/* Markdown                                                            */
/* ------------------------------------------------------------------ */

const esc = (s) => s
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;');

/** Inline spans, applied to already-escaped text. */
function inline(text) {
  return esc(text)
    .replace(/`([^`]+)`/g, (_, c) => `<code>${c}</code>`)
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2">$1</a>')
    // Autolinks arrive here as &lt;https://…&gt;.
    .replace(/&lt;(https?:\/\/[^&\s]+)&gt;/g, '<a href="$1">$1</a>');
}

const isTableRule = (line) => /^\|[\s:|-]+\|$/.test(line.trim());
const cells = (line) => line.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());

/**
 * Renders the subset of markdown PRIVACY.md actually uses: ATX headings,
 * paragraphs, `-` and `1.` lists, and pipe tables. Wrapped lines continue the
 * block they started; a blank line ends it.
 */
function renderMarkdown(md) {
  const lines = md.replace(/\r\n/g, '\n').split('\n');
  const out = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    if (!line.trim()) { i++; continue; }

    const heading = /^(#{1,4})\s+(.*)$/.exec(line);
    if (heading) {
      const level = heading[1].length;
      out.push(`<h${level}>${inline(heading[2])}</h${level}>`);
      i++;
      continue;
    }

    // Table: a pipe row followed by a |---|---| rule.
    if (line.trim().startsWith('|') && isTableRule(lines[i + 1] || '')) {
      const head = cells(line);
      i += 2;
      const body = [];
      while (i < lines.length && lines[i].trim().startsWith('|')) {
        body.push(cells(lines[i]));
        i++;
      }
      out.push(
        '<div class="scroll"><table><thead><tr>' +
        head.map((c) => `<th>${inline(c)}</th>`).join('') +
        '</tr></thead><tbody>' +
        body.map((r) => '<tr>' + r.map((c) => `<td>${inline(c)}</td>`).join('') + '</tr>').join('') +
        '</tbody></table></div>'
      );
      continue;
    }

    // Lists. Wrapped continuation lines are indented; they join the open item.
    const bullet = /^(\s*)([-*]|\d+\.)\s+(.*)$/.exec(line);
    if (bullet) {
      const ordered = /\d/.test(bullet[2]);
      const items = [];
      while (i < lines.length) {
        const m = /^(\s*)([-*]|\d+\.)\s+(.*)$/.exec(lines[i]);
        if (m && /\d/.test(m[2]) === ordered) {
          items.push(m[3]);
          i++;
        } else if (lines[i].trim() && /^\s+/.test(lines[i]) && items.length) {
          items[items.length - 1] += ' ' + lines[i].trim();
          i++;
        } else {
          break;
        }
      }
      const tag = ordered ? 'ol' : 'ul';
      out.push(`<${tag}>` + items.map((t) => `<li>${inline(t)}</li>`).join('') + `</${tag}>`);
      continue;
    }

    // Paragraph, wrapped until a blank line or the start of another block.
    const para = [];
    while (i < lines.length && lines[i].trim() &&
           !/^#{1,4}\s/.test(lines[i]) &&
           !/^(\s*)([-*]|\d+\.)\s/.test(lines[i]) &&
           !lines[i].trim().startsWith('|')) {
      para.push(lines[i].trim());
      i++;
    }
    if (para.length) out.push(`<p>${inline(para.join(' '))}</p>`);
  }

  return out.join('\n');
}

/* ------------------------------------------------------------------ */
/* Shell                                                               */
/* ------------------------------------------------------------------ */

/**
 * The palette is the extension's, carried over deliberately: someone arriving
 * from the Store listing should recognise the page as the same thing.
 */
const CSS = `
*{box-sizing:border-box;margin:0;padding:0}
:root{
  --bg:#f6f2ef; --card:#fff; --ink:#1a1512; --muted:#6b615a;
  --brand:#d3390f; --line:#e6ded7; --code:#efe8e2;
}
@media (prefers-color-scheme:dark){
  :root{ --bg:#17130f; --card:#1f1a16; --ink:#f2ece7; --muted:#a1958c;
         --brand:#ff7a4d; --line:#332b25; --code:#282019; }
}
html{-webkit-text-size-adjust:100%}
body{background:var(--bg);color:var(--ink);line-height:1.6;
  font-family:ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;
  font-size:17px;padding:0 24px}
.wrap{max-width:760px;margin:0 auto;padding:56px 0 96px}
.wide{max-width:1000px}
a{color:var(--brand);text-underline-offset:2px}
h1{font-size:clamp(30px,5vw,42px);line-height:1.14;letter-spacing:-.028em;font-weight:680;
  margin-bottom:20px;text-wrap:balance}
h2{font-size:22px;letter-spacing:-.016em;font-weight:660;margin:44px 0 12px}
h3{font-size:17px;font-weight:660;margin:28px 0 8px}
p{margin-bottom:16px}
ul,ol{margin:0 0 16px 22px}
li{margin-bottom:7px}
code{background:var(--code);border-radius:4px;padding:1px 5px;font-size:.87em;
  font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
.scroll{overflow-x:auto;margin-bottom:20px}
table{border-collapse:collapse;width:100%;font-size:15px;min-width:460px}
th,td{text-align:left;vertical-align:top;padding:10px 14px;border-bottom:1px solid var(--line)}
th{font-weight:640;white-space:nowrap}
.masthead{display:flex;align-items:center;gap:12px;margin-bottom:36px}
.masthead img{width:34px;height:34px}
.masthead b{font-size:16px;font-weight:640;letter-spacing:-.01em}
.masthead a{color:inherit;text-decoration:none;display:flex;align-items:center;gap:12px}
.lede{font-size:20px;line-height:1.5;color:var(--muted);margin-bottom:28px;text-wrap:pretty}
.kicker{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;
  letter-spacing:.14em;text-transform:uppercase;color:var(--brand);margin-bottom:16px}
.foot{margin-top:64px;padding-top:24px;border-top:1px solid var(--line);
  font-size:14px;color:var(--muted)}
.shots{display:grid;gap:20px;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));margin:28px 0 8px}
.shots figure{background:var(--card);border:1px solid var(--line);border-radius:12px;overflow:hidden}
.shots img{display:block;width:100%;height:250px;object-fit:cover;object-position:50% 0}
/* popup-results.png is 420x3098. Cropping from the top shows the header and the
   idle button, not the result the caption is talking about — bias down. */
.shots .popup img{object-position:50% 13%}
.shots figcaption{padding:12px 14px;font-size:14px;color:var(--muted)}
.btn{display:inline-block;background:var(--brand);color:#fff;text-decoration:none;
  font-weight:620;padding:11px 20px;border-radius:9px;font-size:16px}
.pill{display:inline-block;border:1px solid var(--line);border-radius:999px;
  padding:5px 13px;font-size:14px;color:var(--muted);margin:0 7px 8px 0}
pre{background:var(--code);border-radius:10px;padding:16px 18px;overflow-x:auto;
  font-size:14px;line-height:1.55;margin-bottom:16px;
  font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
`;

function page({ title, description, body, wide = false, canonical }) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}">
<meta name="color-scheme" content="light dark">
${canonical ? `<link rel="canonical" href="${canonical}">\n` : ''}<link rel="icon" href="icon.png">
<style>${CSS}</style>
</head>
<body>
<div class="wrap${wide ? ' wide' : ''}">
<div class="masthead">
  <a href="./"><img src="icon.png" alt=""><b>AI Crawlability Lens</b></a>
</div>
${body}
<div class="foot">
  100% local — no account, no server, no telemetry.
  &nbsp;·&nbsp; <a href="./">Home</a>
  &nbsp;·&nbsp; <a href="privacy.html">Privacy</a>
  &nbsp;·&nbsp; <a href="${REPO}">Source</a>
</div>
</div>
</body>
</html>
`;
}

/* ------------------------------------------------------------------ */
/* Pages                                                               */
/* ------------------------------------------------------------------ */

function homeBody() {
  return `
<div class="kicker">Chrome extension</div>
<h1>Googlebot renders your JavaScript. GPTBot, PerplexityBot and ClaudeBot don’t.</h1>
<p class="lede">
  Your page can rank in Google, pass every SEO audit, and still be invisible to ChatGPT,
  Perplexity and Claude — because those crawlers only read raw HTML. This fetches your
  page as each one and shows you exactly what never reaches them.
</p>
<p><a class="btn" href="${REPO}">Get it on GitHub</a></p>

<div class="shots">
  <figure class="popup">
    <img src="screenshots/popup-results.png" alt="Per-bot results in the extension popup">
    <figcaption>A verdict per crawler, and the gate chain behind it.</figcaption>
  </figure>
  <figure>
    <img src="screenshots/overlay.png" alt="Invisible blocks highlighted on the page">
    <figcaption>Red is missing from the raw HTML. Drawn over the page, never modifying it.</figcaption>
  </figure>
</div>

<h2>What it checks</h2>
<ul>
  <li><strong>Per-crawler visibility</strong> — the page fetched with each crawler’s real
      User-Agent and a plain-UA baseline, diffed against what you actually see.</li>
  <li><strong>robots.txt blocking</strong> — including <code>Google-Extended</code>, the
      AI-usage token that is separate from Googlebot and that almost nobody knows about.</li>
  <li><strong>Server-level bot blocking</strong> — a 403 to GPTBot specifically is reported
      distinctly from a low score.</li>
  <li><strong>Cloaking</strong> — whether your infrastructure serves different HTML to
      different crawlers.</li>
  <li><strong>Framework-specific fixes</strong> — Next.js Pages vs App Router, Nuxt, Gatsby,
      SvelteKit, Remix, Astro, Angular and plain SPAs.</li>
</ul>

<h2>Why it isn’t another CSR/SSR detector</h2>
<p>
  “Is this server-rendered?” is a crowded question with a dozen answers. “Can GPTBot read
  this specific page, is it blocked in robots.txt, and does my CDN serve it something
  different?” is a different question, and it is the one that decides whether an AI answer
  engine can cite you.
</p>
<p>
  There are no performance metrics here on purpose — no TTFB, no LCP. Every other tool
  already does that.
</p>

<h2>Install</h2>
<p>No build step and no dependencies. Clone it and load it unpacked:</p>
<pre>git clone ${REPO}.git
# chrome://extensions → Developer mode → Load unpacked
# → select the ai-crawlability-lens/ folder</pre>
<p><a href="ui-demo.html">Walk through the interface</a> without installing anything.</p>

<h2>Privacy</h2>
<p>
  Nothing is collected, nothing is transmitted, and there is no server. The only requests
  made are to the page you are on and its <code>robots.txt</code>, and only when you click
  Check. Site access is requested per-site at the moment you click — never for all sites
  at install. <a href="privacy.html">Full policy</a>.
</p>

<p>
  <span class="pill">Manifest V3</span>
  <span class="pill">No build step</span>
  <span class="pill">No telemetry</span>
  <span class="pill">MIT</span>
</p>
`;
}

/* ------------------------------------------------------------------ */

function main() {
  fs.mkdirSync(DOCS, { recursive: true });

  // Jekyll would otherwise ignore anything it considers a special path and
  // reprocess the rest. Nothing here needs a static-site generator.
  fs.writeFileSync(path.join(DOCS, '.nojekyll'), '');

  fs.copyFileSync(
    path.join(ROOT, 'ai-crawlability-lens', 'icons', 'icon128.png'),
    path.join(DOCS, 'icon.png')
  );

  const md = fs.readFileSync(path.join(ROOT, 'PRIVACY.md'), 'utf8');
  // The <h1> is supplied by the markdown itself; the masthead is separate.
  fs.writeFileSync(path.join(DOCS, 'privacy.html'), page({
    title: 'Privacy Policy — AI Crawlability Lens',
    description: 'AI Crawlability Lens collects nothing, transmits nothing, and has no server.',
    canonical: 'https://bobadesiddesh1-cmyk.github.io/ai-crawlability-checker/privacy.html',
    body: renderMarkdown(md)
  }));

  fs.writeFileSync(path.join(DOCS, 'index.html'), page({
    title: 'AI Crawlability Lens — see your page as AI crawlers see it',
    description: 'A Chrome extension that fetches your page as GPTBot, PerplexityBot and ClaudeBot see it — raw and unrendered.',
    canonical: 'https://bobadesiddesh1-cmyk.github.io/ai-crawlability-checker/',
    wide: true,
    body: homeBody()
  }));

  for (const f of ['index.html', 'privacy.html', 'icon.png', '.nojekyll']) {
    const bytes = fs.statSync(path.join(DOCS, f)).size;
    console.log(`  docs/${f.padEnd(14)} ${(bytes / 1024).toFixed(1)} KB`);
  }
  console.log('\nEnable Pages: Settings → Pages → deploy from main, /docs');
  console.log('Policy URL:   https://bobadesiddesh1-cmyk.github.io/ai-crawlability-checker/privacy.html');
}

main();
