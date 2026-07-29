/**
 * shared/report.js
 *
 * Builds a standalone, self-contained HTML report from an analysis result and
 * hands it to the user as a download.
 *
 * ES module, imported by popup/popup.js.
 *
 * The output has no external references at all — no CDN stylesheet, no font
 * request, no script. It opens correctly from a local file, from an email
 * attachment, and inside a client's locked-down environment, and it phones
 * nobody when opened. Same privacy stance as the extension itself.
 *
 * Download is a Blob + object URL + synthetic anchor click, which avoids
 * needing the `downloads` permission.
 */

import { getFrameworkFix } from '../data/framework-fixes.js';

/** Invisible-block excerpts printed per bot. A full dump is unusable. */
const MAX_BLOCKS_IN_REPORT = 30;

/**
 * Escape a string for interpolation into HTML text or an attribute value.
 * @param {unknown} value
 * @returns {string}
 */
function esc(value) {
  return String(value === null || value === undefined ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * @param {number|null} score
 * @returns {'red'|'amber'|'green'|'none'}
 */
function band(score) {
  if (score === null || score === undefined) return 'none';
  if (score < 40) return 'red';
  if (score <= 75) return 'amber';
  return 'green';
}

/**
 * @param {string} iso
 * @returns {string}
 */
function humanDate(iso) {
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

/**
 * Build the complete report document.
 *
 * @param {Object} result     Analysis object from content/main.js.
 * @param {Object|null} framework  Result of content/framework-detect.js.
 * @returns {string} A complete HTML document.
 */
export function buildReportHtml(result, framework) {
  const fix = getFrameworkFix(framework && framework.id);
  const bots = (result.order || []).map((id) => result.perBot[id]).filter(Boolean);

  const blockedBots = bots.filter((b) => b.robotsBlocked);
  const blockedTokens = Object.values((result.robots && result.robots.tokenVerdicts) || {}).filter(
    (v) => v && !v.allowed
  );
  const serverBlocked = bots.filter((b) => b.status === 'blocked');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>AI Crawlability report — ${esc(hostOf(result.url))}</title>
<style>
  :root {
    --bg: #ffffff; --fg: #111827; --muted: #6b7280; --line: #e5e7eb;
    --card: #f9fafb; --red: #b91c1c; --redbg: #fee2e2;
    --amber: #92400e; --amberbg: #fef3c7; --green: #166534; --greenbg: #dcfce7;
    --info: #1e40af; --infobg: #dbeafe;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #0b1120; --fg: #e5e7eb; --muted: #9ca3af; --line: #1f2937;
      --card: #111827; --red: #fecaca; --redbg: #7f1d1d;
      --amber: #fde68a; --amberbg: #78350f; --green: #bbf7d0; --greenbg: #14532d;
      --info: #bfdbfe; --infobg: #1e3a8a;
    }
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; padding: 32px 20px 64px; background: var(--bg); color: var(--fg);
    font: 15px/1.6 ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  }
  .wrap { max-width: 940px; margin: 0 auto; }
  h1 { font-size: 24px; margin: 0 0 4px; letter-spacing: -0.01em; }
  h2 { font-size: 17px; margin: 36px 0 10px; padding-bottom: 6px; border-bottom: 1px solid var(--line); }
  h3 { font-size: 14px; margin: 20px 0 6px; }
  p  { margin: 0 0 10px; }
  a  { color: inherit; }
  code, .mono { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 12.5px; }
  .sub { color: var(--muted); font-size: 13px; margin-bottom: 20px; word-break: break-all; }
  .banner { border-radius: 8px; padding: 12px 14px; margin: 14px 0; font-size: 14px; }
  .banner.critical { background: var(--redbg); color: var(--red); }
  .banner.info { background: var(--infobg); color: var(--info); }
  .banner.good { background: var(--greenbg); color: var(--green); }
  .banner strong { display: block; margin-bottom: 4px; }
  table { width: 100%; border-collapse: collapse; font-size: 13.5px; }
  th, td { text-align: left; padding: 8px 10px; border-bottom: 1px solid var(--line); vertical-align: top; }
  th { font-size: 12px; text-transform: uppercase; letter-spacing: .04em; color: var(--muted); font-weight: 600; }
  .scroll { overflow-x: auto; }
  .pill { display: inline-block; padding: 1px 8px; border-radius: 999px; font-size: 12px; font-weight: 650; }
  .pill.red { background: var(--redbg); color: var(--red); }
  .pill.amber { background: var(--amberbg); color: var(--amber); }
  .pill.green { background: var(--greenbg); color: var(--green); }
  .pill.none { background: var(--card); color: var(--muted); }
  .card { background: var(--card); border: 1px solid var(--line); border-radius: 8px; padding: 14px 16px; margin: 12px 0; }
  .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 10px; margin: 14px 0; }
  .kpi { background: var(--card); border: 1px solid var(--line); border-radius: 8px; padding: 10px 12px; }
  .kpi b { display: block; font-size: 22px; line-height: 1.2; }
  .kpi span { color: var(--muted); font-size: 12px; }
  ul.blocks { margin: 6px 0 0; padding-left: 18px; }
  ul.blocks li { margin-bottom: 5px; font-size: 13px; }
  ul.blocks .tag { color: var(--muted); font-size: 11px; text-transform: uppercase; margin-right: 6px; }
  .muted { color: var(--muted); font-size: 12.5px; }
  footer { margin-top: 44px; padding-top: 14px; border-top: 1px solid var(--line); color: var(--muted); font-size: 12.5px; }
  pre { background: var(--card); border: 1px solid var(--line); border-radius: 8px; padding: 12px; overflow: auto; font-size: 12px; max-height: 340px; }
</style>
</head>
<body>
<div class="wrap">

  <h1>AI Crawlability report</h1>
  <div class="sub">
    <a href="${esc(result.url)}">${esc(result.url)}</a><br>
    Checked ${esc(humanDate(result.checkedAt))} — generated locally by AI Crawlability Lens. No data left the browser.
  </div>

  ${renderKpis(result, bots)}
  ${renderCriticalBanner(blockedBots, blockedTokens, serverBlocked)}
  ${renderCloakingBanner(result.cloaking)}

  <h2>Per-bot results</h2>
  <div class="scroll">
  <table>
    <thead>
      <tr>
        <th>Bot</th><th>robots.txt</th><th>Fetch</th><th>Visibility</th>
        <th>Blocks visible</th><th>Headings visible</th><th>Runs JS?</th>
      </tr>
    </thead>
    <tbody>
      ${bots.map(renderBotRow).join('\n')}
    </tbody>
  </table>
  </div>
  <p class="muted">
    Visibility Score = share of rendered content blocks present in the raw HTML that bot received,
    with headings weighted double. Bots that were blocked in robots.txt or refused by the server show
    no score, because there is no rendering question to answer for them.
  </p>

  ${renderRobotsSection(result)}
  ${renderFrameworkSection(framework, fix)}
  ${renderInvisibleSection(bots)}
  ${renderCloakingDetail(result.cloaking)}
  ${renderPageMeta(result)}

  <footer>
    <p><strong>Methodology.</strong> Each bot's User-Agent was set with a scoped
    <code>declarativeNetRequest</code> rule and the page was fetched raw, with no cookies and no cache.
    That raw HTML was parsed <em>without executing any JavaScript</em> — the same view a non-JS crawler
    gets — and its content blocks were compared against the blocks visible in the live rendered page.
    A block counts as visible when its text appears in the raw HTML exactly, or shares at least 80% of
    its tokens with a raw block.</p>
    <p><strong>Why this matters.</strong> Googlebot executes JavaScript on a delayed render budget.
    GPTBot, PerplexityBot and ClaudeBot do not execute JavaScript at all. Content that only exists after
    hydration can rank in traditional search and still be completely uncitable by AI answer engines.</p>
    <p><strong>Privacy.</strong> This report was generated entirely in the browser. Nothing was uploaded,
    and it contains no external references — it makes no network requests when opened.</p>
  </footer>
</div>
</body>
</html>`;
}

/* -------------------------------------------------------------------------- */
/* Sections                                                                    */
/* -------------------------------------------------------------------------- */

function renderKpis(result, bots) {
  const scored = bots.filter((b) => b.scoreMeaningful && typeof b.score === 'number');
  const aiScored = scored.filter((b) => !b.executesJs);
  const lowest = scored.length ? Math.min(...scored.map((b) => b.score)) : null;
  const aiLowest = aiScored.length ? Math.min(...aiScored.map((b) => b.score)) : null;
  const blocked = bots.filter((b) => b.robotsBlocked).length;

  return `<div class="grid">
    <div class="kpi"><b>${esc(result.rendered.totalBlocks)}</b><span>Rendered content blocks</span></div>
    <div class="kpi"><b>${lowest === null ? 'n/a' : lowest}</b><span>Lowest Visibility Score</span></div>
    <div class="kpi"><b>${aiLowest === null ? 'n/a' : aiLowest}</b><span>Lowest AI-crawler score</span></div>
    <div class="kpi"><b>${blocked}</b><span>Bots blocked in robots.txt</span></div>
  </div>`;
}

function renderCriticalBanner(blockedBots, blockedTokens, serverBlocked) {
  const parts = [];

  if (blockedBots.length) {
    parts.push(`<div class="banner critical">
      <strong>CRITICAL — blocked in robots.txt</strong>
      ${esc(blockedBots.map((b) => b.label).join(', '))} ${blockedBots.length === 1 ? 'is' : 'are'}
      disallowed from this page. ${blockedBots.length === 1 ? 'It' : 'They'} will never request it,
      so rendering is irrelevant for ${blockedBots.length === 1 ? 'this bot' : 'these bots'}.
      <ul class="blocks">
        ${blockedBots.map((b) => `<li><b>${esc(b.label)}</b> — <code>${esc(b.robotsRule || 'disallowed')}</code> in group <code>${esc(b.robotsGroup || '*')}</code></li>`).join('')}
      </ul>
    </div>`);
  }

  if (blockedTokens.length) {
    parts.push(`<div class="banner critical">
      <strong>CRITICAL — AI-specific tokens disallowed</strong>
      <ul class="blocks">
        ${blockedTokens.map((t) => `<li><b>${esc(t.label)}</b> — <code>${esc(t.matchedRule || 'disallowed')}</code>${t.id === 'google-extended' ? ' — this is Google\'s AI-usage token, separate from Googlebot. Allowing Googlebot does <em>not</em> allow it.' : ''}</li>`).join('')}
      </ul>
    </div>`);
  }

  if (serverBlocked.length) {
    parts.push(`<div class="banner critical">
      <strong>Server-level bot blocking</strong>
      The server returned a refusal status to ${esc(serverBlocked.map((b) => `${b.label} (HTTP ${b.httpStatus})`).join(', '))}.
      This is separate from a low Visibility Score: these bots did not receive the page at all.
    </div>`);
  }

  return parts.join('\n');
}

function renderCloakingBanner(cloaking) {
  if (!cloaking) return '';
  const cls = cloaking.detected ? 'info' : 'good';
  return `<div class="banner ${cls}">
    <strong>${esc(cloaking.headline)}</strong>
    ${esc(cloaking.detail)}
  </div>`;
}

function renderBotRow(b) {
  const robots = b.robotsBlocked
    ? `<span class="pill red">Disallowed</span>`
    : `<span class="pill green">Allowed</span>`;

  let fetchPill;
  if (b.status === 'ok') fetchPill = `<span class="pill green">OK ${esc(b.httpStatus)}</span>`;
  else if (b.status === 'blocked') fetchPill = `<span class="pill red">Blocked ${esc(b.httpStatus)}</span>`;
  else fetchPill = `<span class="pill amber">Error${b.httpStatus ? ' ' + esc(b.httpStatus) : ''}</span>`;

  const scoreCell =
    b.scoreMeaningful && typeof b.score === 'number'
      ? `<span class="pill ${band(b.score)}">${b.score}</span>`
      : `<span class="pill none">n/a</span>`;

  return `<tr>
    <td><b>${esc(b.label)}</b>${b.isBaseline ? '<br><span class="muted">baseline / control</span>' : ''}</td>
    <td>${robots}${b.robotsRule ? `<br><span class="muted mono">${esc(b.robotsRule)}</span>` : ''}</td>
    <td>${fetchPill}${b.statusDetail ? `<br><span class="muted">${esc(b.statusDetail)}</span>` : ''}</td>
    <td>${scoreCell}</td>
    <td>${esc(b.visibleCount)} / ${esc(b.totalBlocks)}</td>
    <td>${esc(b.totalHeadings - b.invisibleHeadings)} / ${esc(b.totalHeadings)}</td>
    <td>${b.executesJs ? 'Yes' : '<b>No</b>'}</td>
  </tr>`;
}

function renderRobotsSection(result) {
  const r = result.robots;
  if (!r) return '';

  const stateText = {
    ok: `Parsed ${r.groupCount} group(s).`,
    empty: 'The file exists but declares no User-agent groups — nothing is restricted.',
    absent: `No robots.txt (HTTP ${r.httpStatus}) — by the standard, everything is allowed.`,
    unknown: `robots.txt returned HTTP ${r.httpStatus}. A 5xx is ambiguous: conservative crawlers treat it as disallow-all.`,
    unreachable: `robots.txt could not be fetched: ${r.fetchError || 'unknown error'}.`
  }[r.state] || '';

  const tokenRows = Object.values(r.tokenVerdicts || {})
    .map(
      (t) => `<tr>
        <td><b>${esc(t.label)}</b></td>
        <td>${t.allowed ? '<span class="pill green">Allowed</span>' : '<span class="pill red">Disallowed</span>'}</td>
        <td><span class="muted mono">${esc(t.matchedRule || '—')}</span></td>
        <td class="muted">${esc(t.reason)}</td>
      </tr>`
    )
    .join('\n');

  return `<h2>robots.txt</h2>
    <p><a href="${esc(r.url)}">${esc(r.url)}</a> — ${esc(stateText)}</p>
    ${r.sitemaps && r.sitemaps.length ? `<p class="muted">Sitemaps declared: ${r.sitemaps.map((s) => `<code>${esc(s)}</code>`).join(', ')}</p>` : ''}

    <h3>AI-specific tokens</h3>
    <div class="scroll"><table>
      <thead><tr><th>Token</th><th>Verdict</th><th>Matched rule</th><th>Why</th></tr></thead>
      <tbody>${tokenRows}</tbody>
    </table></div>
    <p class="muted"><strong>Google-Extended is not Googlebot.</strong> It is a control token governing
    whether Google may use already-crawled content for Gemini and Vertex AI grounding. Allowing Googlebot
    while disallowing Google-Extended is a valid, and easy to overlook, configuration.</p>

    ${r.source ? `<h3>Source</h3><pre>${esc(r.source)}${r.truncatedSource ? '\n… (truncated)' : ''}</pre>` : ''}`;
}

function renderFrameworkSection(framework, fix) {
  const signals = (framework && framework.signals) || [];
  return `<h2>Framework and recommendation</h2>
    <div class="card">
      <h3 style="margin-top:0">${esc(fix.label)}${framework && framework.confidence ? ` <span class="muted">(${esc(framework.confidence)} confidence)</span>` : ''}</h3>
      <p><strong>${esc(fix.fix)}</strong></p>
      ${fix.detail ? `<p class="muted">${esc(fix.detail)}</p>` : ''}
      ${signals.length ? `<p class="muted">Detection signals: ${signals.map((s) => `<code>${esc(s)}</code>`).join(', ')}</p>` : ''}
    </div>`;
}

function renderInvisibleSection(bots) {
  const withInvisible = bots.filter((b) => b.scoreMeaningful && b.invisibleBlocks.length > 0);
  if (!withInvisible.length) {
    return `<h2>Content invisible to bots</h2>
      <p>No rendered content block was missing from any successfully fetched bot's raw HTML. Every bot that
      reached this page can see all of its content without executing JavaScript.</p>`;
  }

  return `<h2>Content invisible to bots</h2>
    <p class="muted">Blocks present in the rendered page but absent from the raw HTML that bot received.
    These can never be quoted or cited by a crawler that does not execute JavaScript.</p>
    ${withInvisible
      .map((b) => {
        const shown = b.invisibleBlocks.slice(0, MAX_BLOCKS_IN_REPORT);
        const hidden = b.invisibleCount - shown.length;
        return `<h3>${esc(b.label)} — ${esc(b.invisibleCount)} invisible block(s)</h3>
          <ul class="blocks">
            ${shown.map((x) => `<li><span class="tag">${esc(x.tag)}</span>${esc(x.text)}</li>`).join('')}
          </ul>
          ${hidden > 0 ? `<p class="muted">… and ${hidden} more, not listed to keep this report readable.</p>` : ''}`;
      })
      .join('\n')}`;
}

function renderCloakingDetail(cloaking) {
  if (!cloaking || !cloaking.comparable || !cloaking.comparisons.length) return '';
  return `<h2>Cloaking comparison</h2>
    <p class="muted">Each bot's raw HTML compared against the ${esc(cloaking.baselineLabel)} baseline,
    measured as the share of content blocks that differ.</p>
    <div class="scroll"><table>
      <thead><tr><th>Bot</th><th>Difference vs baseline</th><th>Blocks only this bot saw</th><th>Blocks only the baseline saw</th></tr></thead>
      <tbody>
        ${cloaking.comparisons
          .map(
            (c) => `<tr>
              <td>${esc(c.label)}</td>
              <td>${c.diverges ? `<span class="pill amber">${esc(c.distancePct)}%</span>` : `<span class="pill green">${esc(c.distancePct)}%</span>`}</td>
              <td>${esc(c.uniqueToBot)}</td>
              <td>${esc(c.uniqueToBaseline)}</td>
            </tr>`
          )
          .join('')}
      </tbody>
    </table></div>
    ${cloaking.skipped && cloaking.skipped.length ? `<p class="muted">Not compared: ${cloaking.skipped.map((s) => `${esc(s.label)} (${esc(s.reason)})`).join('; ')}</p>` : ''}`;
}

function renderPageMeta(result) {
  const m = result.pageMeta || {};
  return `<h2>Page metadata</h2>
    <div class="scroll"><table>
      <tbody>
        <tr><th>Title</th><td>${esc(m.title || '—')}</td></tr>
        <tr><th>Meta description</th><td>${esc(m.metaDescription || '—')}</td></tr>
        <tr><th>Canonical</th><td>${esc(m.canonical || '—')}</td></tr>
        <tr><th>Language</th><td>${esc(m.lang || '—')}</td></tr>
        <tr><th>Content container</th><td><code>${esc(result.rendered.containerSelector)}</code></td></tr>
        <tr><th>Rendered blocks</th><td>${esc(result.rendered.totalBlocks)} (${esc(result.rendered.headingCount)} headings)</td></tr>
      </tbody>
    </table></div>
    <p class="muted">Title and meta description are usually server-rendered even on a full client-side app —
    which is precisely how a page passes a traditional SEO check while being invisible to AI crawlers.</p>`;
}

/* -------------------------------------------------------------------------- */
/* Download                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * @param {string} url
 * @returns {string}
 */
function hostOf(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

/**
 * Build the report and trigger a download.
 *
 * @param {Object} result
 * @param {Object|null} framework
 * @returns {string} The filename used.
 */
export function downloadReport(result, framework) {
  const html = buildReportHtml(result, framework);
  const date = (result.checkedAt || new Date().toISOString()).slice(0, 10);
  const filename = `ai-crawlability-${hostOf(result.url).replace(/[^a-z0-9.-]/gi, '-')}-${date}.html`;

  const blob = new Blob([html], { type: 'text/html;charset=utf-8' });
  const objectUrl = URL.createObjectURL(blob);

  const a = document.createElement('a');
  a.href = objectUrl;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();

  // Revoke on the next tick — revoking synchronously can cancel the download
  // in some Chrome builds before it has read the blob.
  setTimeout(() => URL.revokeObjectURL(objectUrl), 10000);

  return filename;
}
